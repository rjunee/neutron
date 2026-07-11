/**
 * repl-registry.test.ts — the persisted REPL registry (S2 § 2 row #12 / § 6
 * acceptance #3 persistence half). Covers parse/serialize, disk round-trip,
 * corrupt-JSON resilience, the lock-guarded RMW TOCTOU-safety (a row another
 * tick wrote between our read + write is preserved), upsert merge, and removal.
 */

import { describe, it, expect } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getRecord,
  loadRegistry,
  parseRegistryContents,
  patchRecord,
  removeRecord,
  saveRegistry,
  serializeRegistry,
  upsertRecord,
  withRegistry,
  type ReplRegistry,
  type ReplRegistryRecord,
} from '../repl-registry.ts'

function rec(over: Partial<ReplRegistryRecord> & { sessionKey: string }): ReplRegistryRecord {
  return {
    sessionId: `uuid-${over.sessionKey}`,
    cwd: '/home/x',
    channelName: 'neutron-x',
    has_session: true,
    ...over,
  }
}

function tmpRegistry(): string {
  return join(mkdtempSync(join(tmpdir(), 'neutron-reg-')), 'repl-registry.json')
}

describe('repl-registry — pure (de)serialization', () => {
  it('round-trips a registry through serialize → parse', () => {
    const reg: ReplRegistry = { a: rec({ sessionKey: 'a' }), b: rec({ sessionKey: 'b' }) }
    const parsed = parseRegistryContents(serializeRegistry(reg))
    expect(parsed.kind).toBe('loaded')
    if (parsed.kind === 'loaded') expect(parsed.registry).toEqual(reg)
  })

  it('flags non-JSON as corrupt', () => {
    expect(parseRegistryContents('{not json').kind).toBe('corrupt')
  })

  it('flags an array (wrong shape) as corrupt', () => {
    expect(parseRegistryContents('[]').kind).toBe('corrupt')
  })

  it('drops a single malformed row but keeps the valid ones', () => {
    const raw = JSON.stringify({
      good: rec({ sessionKey: 'good' }),
      bad: { sessionKey: 'bad' }, // missing required fields
    })
    const parsed = parseRegistryContents(raw)
    expect(parsed.kind).toBe('loaded')
    if (parsed.kind === 'loaded') {
      expect(parsed.registry.good).toBeDefined()
      expect(parsed.registry.bad).toBeUndefined()
    }
  })

  it('reports a dropped row via onDropRow instead of dropping it silently', () => {
    const raw = JSON.stringify({
      good: rec({ sessionKey: 'good' }),
      bad: { sessionKey: 'bad' }, // missing required fields
    })
    const dropped: string[] = []
    const parsed = parseRegistryContents(raw, (key) => dropped.push(key))
    expect(parsed.kind).toBe('loaded')
    expect(dropped).toEqual(['bad'])
  })

  it('backfills sessionKey from the map key when the field is absent', () => {
    const raw = JSON.stringify({ k1: { sessionId: 'u', cwd: '/c', channelName: 'n', has_session: true } })
    const parsed = parseRegistryContents(raw)
    if (parsed.kind === 'loaded') expect(parsed.registry.k1?.sessionKey).toBe('k1')
  })
})

describe('repl-registry — disk persistence (survives a gateway restart)', () => {
  it('save → load round-trips on disk', () => {
    const path = tmpRegistry()
    const reg: ReplRegistry = { a: rec({ sessionKey: 'a' }) }
    saveRegistry(path, reg)
    expect(loadRegistry(path)).toEqual(reg)
  })

  it('absent file loads as {}', () => {
    expect(loadRegistry(join(tmpdir(), 'does-not-exist-xyz.json'))).toEqual({})
  })

  it('corrupt file loads as {} and reports via onCorrupt (never throws)', () => {
    const path = tmpRegistry()
    writeFileSync(path, 'garbage{')
    let reason = ''
    expect(loadRegistry(path, (r) => (reason = r))).toEqual({})
    expect(reason).toContain('json-parse-error')
  })
})

describe('repl-registry — lock-guarded mutations', () => {
  it('upsert merges onto an existing row (concurrent fields survive)', () => {
    const path = tmpRegistry()
    upsertRecord(path, rec({ sessionKey: 'k', pid: 100 }))
    upsertRecord(path, rec({ sessionKey: 'k', first_ready_at: 9_999 }))
    const row = getRecord(path, 'k')
    expect(row?.pid).toBe(100)
    expect(row?.first_ready_at).toBe(9_999)
  })

  it('patchRecord no-ops when the row is gone', () => {
    const path = tmpRegistry()
    patchRecord(path, 'ghost', { pid: 1 })
    expect(getRecord(path, 'ghost')).toBeUndefined()
  })

  it('removeRecord is idempotent', () => {
    const path = tmpRegistry()
    upsertRecord(path, rec({ sessionKey: 'k' }))
    removeRecord(path, 'k')
    removeRecord(path, 'k')
    expect(getRecord(path, 'k')).toBeUndefined()
  })

  it('TOCTOU-safe: a row written by another writer between our read + write is preserved', () => {
    const path = tmpRegistry()
    upsertRecord(path, rec({ sessionKey: 'existing' }))
    // Simulate a concurrent writer landing a row DURING our critical section's
    // mutate callback (re-read inside the lock composes — our write must not
    // clobber the existing row, only add ours).
    withRegistry(path, (registry) => {
      registry['mine'] = rec({ sessionKey: 'mine' })
      return { registry, result: undefined }
    })
    expect(getRecord(path, 'existing')).toBeDefined()
    expect(getRecord(path, 'mine')).toBeDefined()
  })

  it('withRegistry returns the critical-section result', () => {
    const path = tmpRegistry()
    upsertRecord(path, rec({ sessionKey: 'k' }))
    const won = withRegistry<boolean>(path, (registry) => {
      const claimed = registry['k']?.respawn_in_flight_at === undefined
      if (claimed && registry['k']) registry['k'].respawn_in_flight_at = 123
      return { registry, result: claimed }
    })
    expect(won).toBe(true)
    expect(getRecord(path, 'k')?.respawn_in_flight_at).toBe(123)
  })
})

describe('repl-registry — corruption on the mutation path is loud and recoverable (data-loss regression)', () => {
  /** List sidecar files `<path>.corrupt-<epoch-ms>` written next to `path`. */
  function sidecarsFor(path: string): string[] {
    const dir = dirname(path)
    const base = path.split('/').pop() as string
    return readdirSync(dir).filter((f) => f.startsWith(`${base}.corrupt-`))
  }

  it('patchRecord on a corrupt file does NOT silently vaporize other rows: it sidecars the raw bytes and signals loudly', () => {
    const path = tmpRegistry()
    // Seed N rows the normal way, then corrupt the file on disk (e.g. an
    // operator hand-edit gone wrong, a bad deploy, a disk fault).
    upsertRecord(path, rec({ sessionKey: 'alice', sessionId: 'uuid-alice', pid: 111 }))
    upsertRecord(path, rec({ sessionKey: 'bob', sessionId: 'uuid-bob', pid: 222 }))
    upsertRecord(path, rec({ sessionKey: 'carol', sessionId: 'uuid-carol', pid: 333 }))
    const beforeCorruption = readFileSync(path, 'utf8')
    expect(beforeCorruption).toContain('uuid-bob') // sanity: all 3 rows really are on disk
    writeFileSync(path, `${beforeCorruption}TRAILING-GARBAGE`) // corrupt it

    // Wrap (not replace) the default handler so we observe BOTH the loud
    // signal AND the default's sidecar-preservation side effect — this is
    // the real production shape: a watchdog tick patching ANY one record
    // must not be the thing that destroys everyone else's row with zero log.
    let signaled: { reason: string; hadRawContents: boolean } | undefined
    const originalConsoleError = console.error
    const logs: unknown[][] = []
    console.error = (...args: unknown[]) => logs.push(args)
    try {
      patchRecord(path, 'alice', { pid: 999 }) // no options → default handler
    } finally {
      console.error = originalConsoleError
    }
    signaled = { reason: String(logs[0]?.[0] ?? ''), hadRawContents: sidecarsFor(path).length > 0 }

    expect(logs.some((l) => String(l[0]).includes('CORRUPT registry'))).toBe(true)
    expect(signaled.reason).toContain('json-parse-error')
    expect(signaled.hadRawContents).toBe(true)

    // The corrupt bytes (containing all 3 original rows) must be recoverable
    // from a sidecar file written BEFORE the rebuild.
    const sidecars = sidecarsFor(path)
    expect(sidecars.length).toBeGreaterThan(0)
    const sidecarContents = readFileSync(join(dirname(path), sidecars[0] as string), 'utf8')
    expect(sidecarContents).toBe(beforeCorruption + 'TRAILING-GARBAGE')
    expect(sidecarContents).toContain('uuid-alice')
    expect(sidecarContents).toContain('uuid-bob')
    expect(sidecarContents).toContain('uuid-carol')

    // And the mutation still degrades loud-but-alive (no throw, no crash):
    // the rebuild-from-`{}` means `patchRecord`'s no-op-if-gone guard kicks
    // in for EVERY key (the corrupt registry has no rows to patch), so all
    // three rows are gone from the LIVE file — recoverable only via the
    // sidecar asserted above, never silently.
    expect(getRecord(path, 'alice')).toBeUndefined()
    expect(getRecord(path, 'bob')).toBeUndefined()
    expect(getRecord(path, 'carol')).toBeUndefined()
  })

  it('the default onCorrupt handler (no override) also sidecars + logs — the real production path', () => {
    const path = tmpRegistry()
    upsertRecord(path, rec({ sessionKey: 'alice', sessionId: 'uuid-alice' }))
    upsertRecord(path, rec({ sessionKey: 'bob', sessionId: 'uuid-bob' }))
    writeFileSync(path, 'not even json')

    const originalConsoleError = console.error
    const logs: unknown[][] = []
    console.error = (...args: unknown[]) => logs.push(args)
    try {
      patchRecord(path, 'alice', { pid: 42 }) // no options → default handler
    } finally {
      console.error = originalConsoleError
    }

    expect(logs.some((l) => String(l[0]).includes('CORRUPT registry'))).toBe(true)
    const sidecars = sidecarsFor(path)
    expect(sidecars.length).toBeGreaterThan(0)
    expect(readFileSync(join(dirname(path), sidecars[0] as string), 'utf8')).toBe('not even json')
  })

  it('does not sidecar or falsely signal corruption on an ABSENT file (steady-state cold boot)', () => {
    const path = tmpRegistry() // never written — file is absent
    let signaled = false
    patchRecord(path, 'ghost', { pid: 1 }, { onCorrupt: () => (signaled = true) })
    expect(signaled).toBe(false)
    expect(existsSync(path)).toBe(true) // patchRecord still no-ops + saves cleanly
    expect(sidecarsFor(path)).toEqual([])
  })
})
