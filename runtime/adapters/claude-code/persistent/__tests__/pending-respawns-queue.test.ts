/**
 * pending-respawns-queue.test.ts — ported from Nova `zombie-respawn-queue.test.ts`
 * + `disk-recovery.test.ts` Scenario 6 (persistence round-trip, corrupt-JSON
 * resilience, partial-drain). The restart-idempotent deferred-respawn queue
 * (S2 § 2 row #11).
 */

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearPendingRespawns,
  loadPendingRespawns,
  parsePendingRespawnsContents,
  planZombieRespawns,
  removeEntryBySessionKey,
  savePendingRespawns,
  serializePendingRespawns,
  type PendingRespawnEntry,
} from '../pending-respawns-queue.ts'

function entry(key: string): PendingRespawnEntry {
  return { sessionKey: key, sessionId: `uuid-${key}`, cwd: '/home/x', droppedInbound: `msg-${key}` }
}

function tmpQueue(): string {
  return join(mkdtempSync(join(tmpdir(), 'neutron-pq-')), '.pending-respawns.json')
}

describe('pending-respawns — pure (de)serialization', () => {
  it('round-trips entries', () => {
    const entries = [entry('a'), entry('b')]
    const parsed = parsePendingRespawnsContents(serializePendingRespawns(entries))
    expect(parsed.kind).toBe('loaded')
    if (parsed.kind === 'loaded') expect(parsed.entries).toEqual(entries)
  })

  it('flags non-JSON as corrupt', () => {
    expect(parsePendingRespawnsContents('nope').kind).toBe('corrupt')
  })

  it('flags a non-array as corrupt', () => {
    expect(parsePendingRespawnsContents('{}').kind).toBe('corrupt')
  })

  it('drops malformed rows, keeps valid ones', () => {
    const raw = JSON.stringify([entry('good'), { sessionKey: 'bad' }])
    const parsed = parsePendingRespawnsContents(raw)
    if (parsed.kind === 'loaded') {
      expect(parsed.entries.map((e) => e.sessionKey)).toEqual(['good'])
    }
  })

  it('removeEntryBySessionKey filters in place (partial-drain)', () => {
    const left = removeEntryBySessionKey([entry('a'), entry('b'), entry('c')], 'b')
    expect(left.map((e) => e.sessionKey)).toEqual(['a', 'c'])
  })

  it('planZombieRespawns staggers delays 500·(i+1)', () => {
    const plan = planZombieRespawns([entry('a'), entry('b'), entry('c')])
    expect(plan.map((p) => p.delayMs)).toEqual([500, 1000, 1500])
  })
})

describe('pending-respawns — disk (restart idempotence)', () => {
  it('absent file → kind:absent', () => {
    expect(loadPendingRespawns(join(tmpdir(), 'no-such-pq.json')).kind).toBe('absent')
  })

  it('save → load round-trips on disk', () => {
    const path = tmpQueue()
    savePendingRespawns(path, [entry('a'), entry('b')])
    const loaded = loadPendingRespawns(path)
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind === 'loaded') expect(loaded.entries.length).toBe(2)
  })

  it('saving an empty array deletes the file (steady state)', () => {
    const path = tmpQueue()
    savePendingRespawns(path, [entry('a')])
    expect(existsSync(path)).toBe(true)
    savePendingRespawns(path, [])
    expect(existsSync(path)).toBe(false)
  })

  it('corrupt file → kind:corrupt (caller can clear + continue)', () => {
    const path = tmpQueue()
    writeFileSync(path, 'garbage{')
    expect(loadPendingRespawns(path).kind).toBe('corrupt')
  })

  it('clearPendingRespawns is idempotent', () => {
    const path = tmpQueue()
    savePendingRespawns(path, [entry('a')])
    clearPendingRespawns(path)
    clearPendingRespawns(path)
    expect(existsSync(path)).toBe(false)
  })
})
