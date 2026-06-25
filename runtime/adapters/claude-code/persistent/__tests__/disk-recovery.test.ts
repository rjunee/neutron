/**
 * disk-recovery.test.ts — JSONL-resumability classifier for the boot-drain
 * (Vajra mechanism #20, "disk JSONL is the source of truth"). Proves a
 * failed-probe / scheduled-but-lost entry with a live transcript is classified
 * RESUMABLE from disk, and that a pending entry persisted to disk is recovered
 * on a simulated boot even with NO surviving timer.
 */

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  classifyResumable,
  classifyEntryResumable,
  readSessionJsonlMeta,
  isRealTurnRecord,
  sessionJsonlPath,
  type DiskRecoveryDeps,
  type JsonlMeta,
} from '../disk-recovery.ts'
import {
  drainPendingRespawns,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import { enqueuePendingRespawn } from '../pending-respawns-queue.ts'

const NOW = 1_750_000_000_000 // fixed clock

function meta(over: Partial<JsonlMeta> = {}): JsonlMeta {
  return { exists: true, sizeBytes: 100, mtimeMs: NOW, realTurnCount: 1, ...over }
}

/** Build an in-memory fs seam holding one transcript at the given session path. */
function fakeDeps(contents: string, mtimeMs = NOW): DiskRecoveryDeps {
  return {
    existsSync: () => true,
    readFileSync: () => contents,
    statMtimeMs: () => mtimeMs,
    statSizeBytes: () => Buffer.byteLength(contents),
  }
}

const userTurn = (ts: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: ts })
const asstTurn = (ts: string) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'yo' }, timestamp: ts })

describe('disk-recovery — isRealTurnRecord', () => {
  it('accepts user/assistant message lines', () => {
    expect(isRealTurnRecord({ type: 'user', message: {} })).toBe(true)
    expect(isRealTurnRecord({ type: 'assistant', message: {} })).toBe(true)
  })
  it('rejects summary/system/meta and message-less lines', () => {
    expect(isRealTurnRecord({ type: 'summary', summary: 'x' })).toBe(false)
    expect(isRealTurnRecord({ type: 'system', content: 'x' })).toBe(false)
    expect(isRealTurnRecord({ type: 'user' })).toBe(false) // no message body
    expect(isRealTurnRecord(null)).toBe(false)
    expect(isRealTurnRecord('nope')).toBe(false)
  })
})

describe('disk-recovery — classifyResumable (pure)', () => {
  it('no file on disk → not resumable (no-jsonl)', () => {
    const r = classifyResumable(meta({ exists: false, sizeBytes: 0, mtimeMs: 0, realTurnCount: 0 }), NOW)
    expect(r).toEqual({ resumable: false, reason: 'no-jsonl' })
  })
  it('empty file → not resumable (empty ghost session)', () => {
    const r = classifyResumable(meta({ sizeBytes: 0, realTurnCount: 0 }), NOW)
    expect(r.resumable).toBe(false)
    expect(r.reason).toBe('empty')
  })
  it('present but only summary/system lines → not resumable (no-real-turn)', () => {
    const r = classifyResumable(meta({ realTurnCount: 0 }), NOW)
    expect(r.resumable).toBe(false)
    expect(r.reason).toBe('no-real-turn')
  })
  it('a live JSONL with a real turn → RESUMABLE', () => {
    const r = classifyResumable(
      meta({ realTurnCount: 3, lastRealTurnAtMs: NOW - 1000, mtimeMs: NOW - 1000 }),
      NOW,
    )
    expect(r.resumable).toBe(true)
    expect(r.reason).toBe('live')
    expect(r.ageMs).toBe(1000)
  })
  it('disk is source of truth: an OLD transcript stays resumable with no maxAge cutoff', () => {
    const r = classifyResumable(meta({ realTurnCount: 1, lastRealTurnAtMs: NOW - 86_400_000 }), NOW)
    expect(r.resumable).toBe(true)
    expect(r.reason).toBe('live')
  })
  it('opt-in maxAgeMs flags a long-cold transcript stale', () => {
    const r = classifyResumable(
      meta({ realTurnCount: 1, lastRealTurnAtMs: NOW - 3_600_000, mtimeMs: NOW - 3_600_000 }),
      NOW,
      { maxAgeMs: 600_000 },
    )
    expect(r.resumable).toBe(false)
    expect(r.reason).toBe('stale')
    expect(r.ageMs).toBe(3_600_000)
  })
})

describe('disk-recovery — readSessionJsonlMeta (fs seam)', () => {
  it('counts real turns and records the last real turn timestamp', () => {
    const t1 = new Date(NOW - 2000).toISOString()
    const t2 = new Date(NOW - 1000).toISOString()
    const contents =
      JSON.stringify({ type: 'summary', summary: 's' }) + '\n' + userTurn(t1) + '\n' + asstTurn(t2) + '\n'
    const m = readSessionJsonlMeta('sid', '/home/x', undefined, fakeDeps(contents))
    expect(m.exists).toBe(true)
    expect(m.realTurnCount).toBe(2)
    expect(m.lastRealTurnAtMs).toBe(Date.parse(t2))
  })
  it('a partially-flushed tail line is skipped, not fatal', () => {
    const contents = userTurn(new Date(NOW).toISOString()) + '\n' + '{"type":"assist' // truncated
    const m = readSessionJsonlMeta('sid', '/home/x', undefined, fakeDeps(contents))
    expect(m.realTurnCount).toBe(1)
  })
  it('missing session id → absent', () => {
    const m = readSessionJsonlMeta('', '/home/x', undefined, fakeDeps('x'))
    expect(m.exists).toBe(false)
  })
  it('classifyEntryResumable composes read + classify', () => {
    const contents = userTurn(new Date(NOW - 500).toISOString())
    const r = classifyEntryResumable({ sessionId: 'sid', cwd: '/home/x' }, NOW, {}, undefined, fakeDeps(contents))
    expect(r.resumable).toBe(true)
  })
})

describe('disk-recovery — boot-drain recovers a disk-persisted entry with NO surviving timer', () => {
  it('a pending entry whose owner is unregistered is classified resumable from its live JSONL', async () => {
    // Simulate a pre-restart persist: an entry written to the pending queue on disk.
    const home = mkdtempSync(join(tmpdir(), 'neutron-dr-'))
    const stateDir = join(home, '.neutron')
    mkdirSync(stateDir, { recursive: true })
    const pendingPath = join(stateDir, '.pending-respawns.json')
    const projectsDir = join(home, 'projects')

    const cwd = '/work/topic-pristine'
    const sessionId = 'sess-pristine-uuid'
    // The topic's transcript is fully intact on disk (the 2026-05-21 lesson).
    const jsonlPath = sessionJsonlPath(sessionId, cwd, projectsDir)
    mkdirSync(dirname(jsonlPath), { recursive: true })
    writeFileSync(jsonlPath, userTurn(new Date(NOW).toISOString()) + '\n')

    enqueuePendingRespawn(pendingPath, {
      sessionKey: 'unregistered-key',
      sessionId,
      cwd,
      droppedInbound: 'are you still there?',
    })

    // Boot drain — NO timer, NO surviving in-memory registry entry. The owner is
    // unregistered (cross-restart boot before its first turn), so the drain
    // reconstructs resumability FROM DISK rather than silently dropping it.
    const options: PersistentReplSubstrateOptions = {
      substrate_instance_id: 'cc-test',
      pendingRespawnsPath: pendingPath,
      projectsDir,
    }
    const results = await drainPendingRespawns(options, { baseDelayMs: 0, sleep: async () => {} })
    expect(results).toHaveLength(1)
    expect(results[0]!.skipped).toBe('unregistered')
    expect(results[0]!.resumable).toBe(true) // recovered from disk, not dropped
  })
})
