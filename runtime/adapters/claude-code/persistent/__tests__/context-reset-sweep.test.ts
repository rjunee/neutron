/**
 * context-reset-sweep.test.ts — Layer B periodic sweep (`createPooledContextResetSweep`).
 *
 * REAL state, not `toHaveBeenCalled` mocks: a recording fake PtyChild captures
 * every raw PTY `write()`, and each session's post-compact size is measured off a
 * REAL JSONL fixture on disk at `sessionJsonlPath(sessionId, cwd, tmpProjectsDir)`.
 * Every case asserts the literal `'/clear\r'` write landed (or did NOT) and the
 * honest per-scope report reason.
 *
 * Fake pool entries (direct `pool.set`) rather than a spawned substrate, so the
 * sessionId + cwd + JSONL fixture are all under test control — the sweep resolves
 * `Promise<ReplSession>` out of `pool` exactly as production does.
 *
 * Cases: (i) oversized idle → one /clear, report.reset; (ii) IMMEDIATE re-sweep →
 * no write, 'no_new_turns' (the no-loop invariant); (iii) under-threshold → no
 * write; (iv) activeTurn → 'busy', mutex never acquired; (v) should_reset false →
 * 'cooldown', not even measured; (vi) mid-file compact marker → only tail bytes
 * count; (vii) 2-dim prefix matches TWO scopes, a legacy 2-dim key does not;
 * (viii) exited child → skipped 'dead'.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pool } from '../pool-state.ts'
import { ReplSession } from '../repl-session.ts'
import { createPooledContextResetSweep } from '../context-reset.ts'
import { sessionJsonlPath } from '../session-size-watchdog.ts'
import { SESSION_KEY_SEP } from '../signatures.ts'
import type { PtyChild } from '../pty-host.ts'

const CWD = '/tmp/neutron-sweep-agent'
const INSTANCE = 'cc-agent-acme'
const USER = 'u-1'

let tmpProjectsDir: string
const addedKeys: string[] = []

afterEach(() => {
  for (const k of addedKeys) pool.delete(k)
  addedKeys.length = 0
  if (tmpProjectsDir !== undefined) rmSync(tmpProjectsDir, { recursive: true, force: true })
})

function freshProjectsDir(): string {
  tmpProjectsDir = mkdtempSync(join(tmpdir(), 'neutron-sweep-proj-'))
  return tmpProjectsDir
}

/** A fake warm session inserted directly into the pool. `writes` captures every
 *  raw PTY write; `acquireCount` proves whether the mutex was ever contended. */
function makeFakeSession(opts: {
  sessionId: string
  project: string
  credential?: string
  turnsServed: number
  exited?: boolean
}): { session: ReplSession; writes: string[]; acquireCount: () => number; key: string } {
  const writes: string[] = []
  let exited = opts.exited ?? false
  const child: PtyChild = {
    pid: 4242,
    write(data: string | Uint8Array): void {
      writes.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
    },
    resize(): void {},
    kill(): void {
      exited = true
    },
    exited: Promise.resolve(null),
    hasExited: () => exited,
  }
  const key = [INSTANCE, USER, opts.project, opts.credential ?? 'cred-1'].join(SESSION_KEY_SEP)
  const session = new ReplSession(key, opts.sessionId, 'chan', CWD)
  session.attachChild(child)
  // Ancient lastDataAt so `waitForReplIdle(quiet=0)` returns immediately.
  session.lastDataAt = 0
  for (let i = 0; i < opts.turnsServed; i++) session.nextTurnId()
  // Count acquireTurn contention to prove the busy pre-check never hits the mutex.
  let acquires = 0
  const realAcquire = session.acquireTurn.bind(session)
  session.acquireTurn = async (): Promise<() => void> => {
    acquires += 1
    return realAcquire()
  }
  return { session, writes, acquireCount: () => acquires, key }
}

function insert(entry: { session: ReplSession; key: string }): void {
  pool.set(entry.key, Promise.resolve(entry.session))
  addedKeys.push(entry.key)
}

/** Write a JSONL fixture of `bytes` total bytes (no compact marker). */
function writeJsonl(sessionId: string, bytes: number): void {
  const p = sessionJsonlPath(sessionId, CWD, tmpProjectsDir)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, 'x'.repeat(bytes))
}

/** Write a JSONL fixture whose LAST compact-summary marker leaves `tailBytes`
 *  after it, preceded by `preBytes` of pre-marker content. */
function writeJsonlWithMarker(sessionId: string, preBytes: number, tailBytes: number): void {
  const p = sessionJsonlPath(sessionId, CWD, tmpProjectsDir)
  mkdirSync(dirname(p), { recursive: true })
  const pre = 'p'.repeat(preBytes)
  const markerLine = `{"isCompactSummary":true}\n`
  const tail = 't'.repeat(tailBytes)
  writeFileSync(p, `${pre}\n${markerLine}${tail}`)
}

const CLEARS = (writes: string[]): number => writes.filter((w) => w === '/clear\r').length
const THRESHOLD = 1000
const SWEEP_ARGS = { threshold_bytes: THRESHOLD, idle_quiet_ms: 0, idle_max_ms: 50 } as const

function newSweep() {
  return createPooledContextResetSweep({ ...SWEEP_ARGS, projects_dir: tmpProjectsDir })
}

describe('createPooledContextResetSweep — Layer B periodic sweep', () => {
  it('(i)+(ii) oversized idle → one /clear + report.reset; immediate re-sweep → no write, no_new_turns (no-loop invariant)', async () => {
    freshProjectsDir()
    const a = makeFakeSession({ sessionId: 'sid-i', project: 'proj-A', turnsServed: 1 })
    insert(a)
    writeJsonl('sid-i', 2000) // over the 1000-byte threshold

    const sweep = newSweep()
    const r1 = await sweep.sweep({ substrate_instance_id: INSTANCE, user_id: USER })
    expect(CLEARS(a.writes)).toBe(1)
    expect(r1.reset).toEqual([{ project_scope: 'proj-A', bytes_live: 2000 }])
    expect(r1.skipped).toEqual([])

    // (ii) IMMEDIATE second sweep — no NEW turn ran, so the transcript cannot have
    // grown from live use: the delta baseline blocks a re-fire. THE load-bearing
    // no-loop invariant. Nothing written the second time.
    const r2 = await sweep.sweep({ substrate_instance_id: INSTANCE, user_id: USER })
    expect(CLEARS(a.writes)).toBe(1) // still exactly ONE clear
    expect(r2.reset).toEqual([])
    expect(r2.skipped).toEqual([{ project_scope: 'proj-A', reason: 'no_new_turns' }])
  })

  it('(iii) under-threshold session → no write, under_threshold', async () => {
    freshProjectsDir()
    const s = makeFakeSession({ sessionId: 'sid-iii', project: 'proj-A', turnsServed: 1 })
    insert(s)
    writeJsonl('sid-iii', 500) // below threshold

    const r = await newSweep().sweep({ substrate_instance_id: INSTANCE, user_id: USER })
    expect(CLEARS(s.writes)).toBe(0)
    expect(r.reset).toEqual([])
    expect(r.skipped).toEqual([{ project_scope: 'proj-A', reason: 'under_threshold' }])
  })

  it('(iv) activeTurn set → busy, nothing written, mutex NEVER acquired', async () => {
    freshProjectsDir()
    const s = makeFakeSession({ sessionId: 'sid-iv', project: 'proj-A', turnsServed: 1 })
    // A live turn is in flight.
    s.session.activeTurn = {} as unknown as NonNullable<ReplSession['activeTurn']>
    insert(s)
    writeJsonl('sid-iv', 5000) // over threshold — but busy must short-circuit first

    const r = await newSweep().sweep({ substrate_instance_id: INSTANCE, user_id: USER })
    expect(CLEARS(s.writes)).toBe(0)
    expect(s.acquireCount()).toBe(0) // the busy pre-check never contends the mutex
    expect(r.reset).toEqual([])
    expect(r.skipped).toEqual([{ project_scope: 'proj-A', reason: 'busy' }])
  })

  it('(v) should_reset=false → cooldown, session not even measured (no fixture, still cooldown not failed)', async () => {
    freshProjectsDir()
    const s = makeFakeSession({ sessionId: 'sid-v', project: 'proj-A', turnsServed: 1 })
    insert(s)
    // Deliberately NO fixture on disk: if the sweep tried to measure, it would
    // read null → 'failed'. Getting 'cooldown' proves measurement was skipped.

    const r = await newSweep().sweep({
      substrate_instance_id: INSTANCE,
      user_id: USER,
      should_reset: () => false,
    })
    expect(CLEARS(s.writes)).toBe(0)
    expect(r.reset).toEqual([])
    expect(r.skipped).toEqual([{ project_scope: 'proj-A', reason: 'cooldown' }])
  })

  it('(vi) post-compact measurement — a mid-file compact marker makes only the tail bytes count', async () => {
    freshProjectsDir()
    const s = makeFakeSession({ sessionId: 'sid-vi', project: 'proj-A', turnsServed: 1 })
    insert(s)
    // 5000 bytes BEFORE the compact marker, 200 bytes AFTER: raw size is huge but
    // post-compact size is 200 < 1000 → under_threshold (only the tail counts).
    writeJsonlWithMarker('sid-vi', 5000, 200)

    const r = await newSweep().sweep({ substrate_instance_id: INSTANCE, user_id: USER })
    expect(CLEARS(s.writes)).toBe(0)
    expect(r.skipped).toEqual([{ project_scope: 'proj-A', reason: 'under_threshold' }])
  })

  it('(vii) 2-dim prefix matches TWO project scopes in one sweep; a legacy 2-dim key is NOT matched', async () => {
    freshProjectsDir()
    const a = makeFakeSession({ sessionId: 'sid-a', project: 'proj-A', turnsServed: 1 })
    const b = makeFakeSession({ sessionId: 'sid-b', project: 'proj-B', turnsServed: 1 })
    insert(a)
    insert(b)
    writeJsonl('sid-a', 2000)
    writeJsonl('sid-b', 3000)

    // A LEGACY 2-dim key (one separator total) — must be unmatchable by the
    // trailing-separator prefix.
    const legacy = makeFakeSession({ sessionId: 'sid-legacy', project: 'ignored', turnsServed: 1 })
    const legacyKey = [INSTANCE, USER].join(SESSION_KEY_SEP)
    pool.set(legacyKey, Promise.resolve(legacy.session))
    addedKeys.push(legacyKey)
    writeJsonl('sid-legacy', 9999)

    const r = await newSweep().sweep({ substrate_instance_id: INSTANCE, user_id: USER })
    expect(CLEARS(a.writes)).toBe(1)
    expect(CLEARS(b.writes)).toBe(1)
    expect(CLEARS(legacy.writes)).toBe(0) // legacy key never matched
    const scopes = r.reset.map((x) => x.project_scope).sort()
    expect(scopes).toEqual(['proj-A', 'proj-B'])
    // The legacy key contributed NOTHING to the report at all.
    expect(r.reset).toHaveLength(2)
    expect(r.skipped).toEqual([])
  })

  it('(viii) exited child → skipped dead, nothing written', async () => {
    freshProjectsDir()
    const s = makeFakeSession({ sessionId: 'sid-viii', project: 'proj-A', turnsServed: 1, exited: true })
    insert(s)
    writeJsonl('sid-viii', 5000)

    const r = await newSweep().sweep({ substrate_instance_id: INSTANCE, user_id: USER })
    expect(CLEARS(s.writes)).toBe(0)
    expect(r.reset).toEqual([])
    expect(r.skipped).toEqual([{ project_scope: 'proj-A', reason: 'dead' }])
  })
})
