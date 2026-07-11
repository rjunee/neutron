/**
 * repl-registry.test.ts — the persisted REPL registry (S2 § 2 row #12 / § 6
 * acceptance #3 persistence half). Covers parse/serialize, disk round-trip,
 * corrupt-JSON resilience, the lock-guarded RMW TOCTOU-safety (a row another
 * tick wrote between our read + write is preserved), upsert merge, and removal.
 */

import { describe, it, expect } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/** Permission-based fault injection is a no-op under root (bypasses all
 *  permission bits) — guard those tests so they don't false-pass/false-fail
 *  under a root-run CI container. */
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

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

  it('a caller-supplied onCorrupt is ADDITIVE — it cannot silently disable the mandatory default log + sidecar', () => {
    const path = tmpRegistry()
    upsertRecord(path, rec({ sessionKey: 'k' }))
    writeFileSync(path, 'not even json')

    const originalConsoleError = console.error
    const logs: unknown[][] = []
    console.error = (...args: unknown[]) => logs.push(args)
    let customFired: { reason: string; hadRawContents: boolean } | undefined
    try {
      // A caller passing its OWN onCorrupt (e.g. project-specific alerting, or
      // — as here — a test wanting to also observe the event) must NOT be a
      // way to opt out of the built-in safety net. Note this handler does
      // NOT itself sidecar or log — if the default were skipped, there would
      // be zero recovery trail.
      patchRecord(path, 'k', { pid: 1 }, {
        onCorrupt: (reason, rawContents) => {
          customFired = { reason, hadRawContents: rawContents !== undefined }
        },
      })
    } finally {
      console.error = originalConsoleError
    }

    // The custom callback DID fire...
    expect(customFired?.reason).toContain('json-parse-error')
    expect(customFired?.hadRawContents).toBe(true)
    // ...but so did the mandatory default: loud log AND a sidecar file exist,
    // exactly as if no custom onCorrupt had been supplied at all.
    expect(logs.some((l) => String(l[0]).includes('CORRUPT registry'))).toBe(true)
    const sidecars = sidecarsFor(path)
    expect(sidecars.length).toBe(1)
    expect(readFileSync(join(dirname(path), sidecars[0] as string), 'utf8')).toBe('not even json')
  })

  it('a caller-supplied onDropRow is ADDITIVE — it cannot silently disable the mandatory default log + sidecar', () => {
    const path = tmpRegistry()
    const raw = JSON.stringify({
      good: rec({ sessionKey: 'good' }),
      stale: { sessionKey: 'stale' }, // missing required fields
    })
    writeFileSync(path, raw)

    const originalConsoleError = console.error
    const logs: unknown[][] = []
    console.error = (...args: unknown[]) => logs.push(args)
    const customCalls: string[] = []
    try {
      patchRecord(path, 'good', { pid: 1 }, {
        onDropRow: (key) => customCalls.push(key),
      })
    } finally {
      console.error = originalConsoleError
    }

    expect(customCalls).toEqual(['stale'])
    expect(logs.some((l) => String(l[0]).includes('dropping row sessionKey=stale'))).toBe(true)
    const sidecars = sidecarsFor(path)
    expect(sidecars.length).toBe(1)
    expect(readFileSync(join(dirname(path), sidecars[0] as string), 'utf8')).toBe(raw)
  })

  it('a THROWING caller-supplied onCorrupt cannot abort the mutation — the default still runs and the caller still gets its result (Codex r5)', () => {
    const path = tmpRegistry()
    upsertRecord(path, rec({ sessionKey: 'k' }))
    writeFileSync(path, 'not even json')

    const originalConsoleError = console.error
    const logs: unknown[][] = []
    console.error = (...args: unknown[]) => logs.push(args)
    let threw = false
    try {
      // A hostile/buggy caller callback must be isolated — it must NEVER be
      // able to prevent the mandatory sidecar+log, and must never propagate
      // out and abort the mutation ("corruption never aborts the mutation"
      // is the whole point of this module).
      patchRecord(path, 'k', { pid: 1 }, {
        onCorrupt: () => {
          throw new Error('a badly-written alerting hook exploded')
        },
      })
    } catch {
      threw = true
    } finally {
      console.error = originalConsoleError
    }

    expect(threw).toBe(false)
    // The mandatory default still fired: loud log + sidecar, unaffected by
    // the custom callback's failure.
    expect(logs.some((l) => String(l[0]).includes('CORRUPT registry'))).toBe(true)
    expect(logs.some((l) => String(l[0]).includes('onCorrupt callback threw'))).toBe(true)
    expect(sidecarsFor(path).length).toBe(1)
  })

  it('a THROWING caller-supplied onDropRow cannot abort the mutation — the default still runs and valid rows still save', () => {
    const path = tmpRegistry()
    const raw = JSON.stringify({
      good: rec({ sessionKey: 'good' }),
      stale: { sessionKey: 'stale' }, // missing required fields
    })
    writeFileSync(path, raw)

    const originalConsoleError = console.error
    const logs: unknown[][] = []
    console.error = (...args: unknown[]) => logs.push(args)
    let threw = false
    try {
      patchRecord(path, 'good', { pid: 5 }, {
        onDropRow: () => {
          throw new Error('a badly-written alerting hook exploded')
        },
      })
    } catch {
      threw = true
    } finally {
      console.error = originalConsoleError
    }

    expect(threw).toBe(false)
    expect(logs.some((l) => String(l[0]).includes('dropping row sessionKey=stale'))).toBe(true)
    expect(logs.some((l) => String(l[0]).includes('onDropRow callback threw'))).toBe(true)
    expect(sidecarsFor(path).length).toBe(1)
    // The mutation still completed normally: the valid row's patch landed.
    expect(getRecord(path, 'good')?.pid).toBe(5)
  })

  it('a single malformed row (schema skew, not whole-file corruption) is ALSO sidecar-preserved before it is dropped for good', () => {
    const path = tmpRegistry()
    // Two good rows + one row an older/newer build wrote with a missing field
    // (the exact rolling-restart schema-skew scenario the bug report calls
    // out) — the file as a whole still parses fine, so `onCorrupt` never
    // fires; only `onDropRow` does. It must be just as recoverable.
    const raw = JSON.stringify({
      alice: rec({ sessionKey: 'alice', sessionId: 'uuid-alice' }),
      bob: rec({ sessionKey: 'bob', sessionId: 'uuid-bob' }),
      stale: { sessionKey: 'stale', sessionId: 'uuid-stale', cwd: '/home/x' }, // missing channelName/has_session
    })
    writeFileSync(path, raw)

    const originalConsoleError = console.error
    const logs: unknown[][] = []
    console.error = (...args: unknown[]) => logs.push(args)
    try {
      patchRecord(path, 'alice', { pid: 7 }) // no options → default handlers
    } finally {
      console.error = originalConsoleError
    }

    // Loud, and mentions the dropped row's key.
    expect(logs.some((l) => String(l[0]).includes('dropping row sessionKey=stale'))).toBe(true)
    // Recoverable: a sidecar holding the pre-drop bytes (including `stale`)
    // exists, even though the live save below drops it.
    const sidecars = sidecarsFor(path)
    expect(sidecars.length).toBeGreaterThan(0)
    const sidecarContents = readFileSync(join(dirname(path), sidecars[0] as string), 'utf8')
    expect(sidecarContents).toBe(raw)
    expect(sidecarContents).toContain('uuid-stale')
    // The valid rows survive the save normally; only the malformed one is gone
    // from the LIVE file (by design — a half-shaped record isn't usable).
    expect(getRecord(path, 'alice')?.pid).toBe(7)
    expect(getRecord(path, 'bob')).toBeDefined()
    expect(getRecord(path, 'stale')).toBeUndefined()
  })

  it('sidecar filenames never collide across rapid-fire corruptions in the same process (no silent overwrite of an earlier recovery copy)', () => {
    const path = tmpRegistry()
    upsertRecord(path, rec({ sessionKey: 'k' }))
    const N = 8
    const seenContents: string[] = []
    for (let i = 0; i < N; i++) {
      const marker = `MARKER-${i}`
      writeFileSync(path, `{not json ${marker}`) // re-corrupt with a UNIQUE payload each time
      seenContents.push(readFileSync(path, 'utf8'))
      patchRecord(path, 'k', { pid: i }) // fires the default onCorrupt each time, back-to-back
    }
    // Every corruption event must have left its OWN sidecar — none silently
    // clobbered by a same-millisecond successor.
    const sidecars = sidecarsFor(path)
    expect(new Set(sidecars).size).toBe(sidecars.length) // filenames are unique
    expect(sidecars.length).toBe(N)
    const sidecarBodies = sidecars.map((f) => readFileSync(join(dirname(path), f), 'utf8'))
    for (const original of seenContents) {
      expect(sidecarBodies).toContain(original) // every payload is recoverable, not just the last
    }
  })

  it('wrong-shape JSON (a top-level array, not an object) is treated as corrupt and sidecar-preserved, same as a syntax error', () => {
    const path = tmpRegistry()
    upsertRecord(path, rec({ sessionKey: 'k' }))
    writeFileSync(path, '["not", "a", "registry", "object"]')

    const originalConsoleError = console.error
    const logs: unknown[][] = []
    console.error = (...args: unknown[]) => logs.push(args)
    try {
      patchRecord(path, 'k', { pid: 1 })
    } finally {
      console.error = originalConsoleError
    }

    expect(logs.some((l) => String(l[0]).includes('not-an-object'))).toBe(true)
    const sidecars = sidecarsFor(path)
    expect(sidecars.length).toBe(1)
    expect(readFileSync(join(dirname(path), sidecars[0] as string), 'utf8')).toBe(
      '["not", "a", "registry", "object"]',
    )
  })

  it('multiple malformed rows dropped in ONE load produce exactly ONE sidecar (not one per row)', () => {
    const path = tmpRegistry()
    const raw = JSON.stringify({
      good: rec({ sessionKey: 'good' }),
      bad1: { sessionKey: 'bad1' }, // missing required fields
      bad2: { sessionKey: 'bad2' }, // missing required fields
      bad3: { sessionKey: 'bad3', cwd: '/x' }, // still missing fields
    })
    writeFileSync(path, raw)

    const originalConsoleError = console.error
    const logs: unknown[][] = []
    console.error = (...args: unknown[]) => logs.push(args)
    try {
      patchRecord(path, 'good', { pid: 1 })
    } finally {
      console.error = originalConsoleError
    }

    // All three drops are individually logged...
    expect(logs.filter((l) => String(l[0]).includes('dropping row sessionKey=')).length).toBe(3)
    // ...but only ONE sidecar file backs all of them (the whole pre-drop file
    // is in that one copy — no need for N identical-content sidecars).
    const sidecars = sidecarsFor(path)
    expect(sidecars.length).toBe(1)
    const body = readFileSync(join(dirname(path), sidecars[0] as string), 'utf8')
    expect(body).toBe(raw)
    expect(body).toContain('bad1')
    expect(body).toContain('bad2')
    expect(body).toContain('bad3')
  })

  it.skipIf(isRoot)(
    'a read-error (e.g. permission denied) is loud-but-alive AND leaves the file untouched — the save is skipped, not just the sidecar (Codex r4)',
    () => {
      const path = tmpRegistry()
      // A VALID, multi-row registry is on disk — the read error is about to
      // be entirely transient (permissions flap), not actual corruption.
      upsertRecord(path, rec({ sessionKey: 'alice', sessionId: 'uuid-alice', pid: 111 }))
      upsertRecord(path, rec({ sessionKey: 'bob', sessionId: 'uuid-bob', pid: 222 }))
      const beforeBytes = readFileSync(path, 'utf8')
      chmodSync(path, 0o000)

      const originalConsoleError = console.error
      const logs: unknown[][] = []
      console.error = (...args: unknown[]) => logs.push(args)
      try {
        // The mutation still runs end-to-end (the caller always gets a
        // result) — it just must not COMMIT anything built on the `{}` it
        // was forced to fall back to, since we have no idea whether the
        // real on-disk data was fine.
        expect(() => patchRecord(path, 'alice', { pid: 999 })).not.toThrow()
      } finally {
        chmodSync(path, 0o600) // restore readability
        console.error = originalConsoleError
      }

      expect(logs.some((l) => String(l[0]).includes('read-error'))).toBe(true)
      // Nothing was readable, so there is genuinely nothing to sidecar.
      expect(sidecarsFor(path)).toEqual([])
      // The critical assertion: the save was SKIPPED, not just un-sidecarred.
      // The file on disk is byte-for-byte what it was before the attempted
      // mutation — alice's `pid` patch did NOT silently commit over a
      // rebuilt-from-`{}` registry, and bob's row was never at risk.
      expect(readFileSync(path, 'utf8')).toBe(beforeBytes)
      expect(getRecord(path, 'alice')?.pid).toBe(111) // unchanged, not 999
      expect(getRecord(path, 'bob')?.pid).toBe(222)
    },
  )

  it.skipIf(isRoot)(
    'a sidecar-write failure is logged honestly — it never silently reports success',
    () => {
      const path = tmpRegistry()
      const dir = dirname(path)
      upsertRecord(path, rec({ sessionKey: 'k' }))
      writeFileSync(path, 'garbage{')

      const originalConsoleError = console.error
      const logs: unknown[][] = []
      console.error = (...args: unknown[]) => logs.push(args)
      chmodSync(dir, 0o500) // read+execute only — no new file can be created here,
      // so BOTH the sidecar write and the mutation's own save will fail. The
      // save failing too (and this call throwing) is expected in a
      // can't-write-anything scenario; what matters is the sidecar failure is
      // still reported honestly rather than silently claiming success.
      try {
        expect(() => patchRecord(path, 'k', { pid: 1 })).toThrow()
      } finally {
        chmodSync(dir, 0o700) // restore so the tmpdir can be cleaned up
        console.error = originalConsoleError
      }

      expect(
        logs.some(
          (l) => String(l[0]).includes('CORRUPT registry') && String(l[0]).includes('Sidecar preservation FAILED'),
        ),
      ).toBe(true)
    },
  )
})
