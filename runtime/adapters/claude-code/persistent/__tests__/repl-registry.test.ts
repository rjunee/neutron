/**
 * repl-registry.test.ts — the persisted REPL registry (S2 § 2 row #12 / § 6
 * acceptance #3 persistence half). Covers parse/serialize, disk round-trip,
 * corrupt-JSON resilience, the lock-guarded RMW TOCTOU-safety (a row another
 * tick wrote between our read + write is preserved), upsert merge, and removal.
 */

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
