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
 * (viii) exited child → skipped 'dead'; (ix) onScopeReset under the mutex; (x)
 * rotation-robust baseline; (xi) actuation throw → reset_failed detail; (xii)
 * re-anchor baseline down after an external auto-compact; (xiii) absent transcript
 * → 'no_transcript', not 'failed'.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pool } from '../pool-state.ts'
import { ReplSession } from '../repl-session.ts'
import { createPooledContextResetSweep, resetPooledSessionContext } from '../context-reset.ts'
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
 *  raw PTY write; `acquireCount` proves whether the mutex was ever contended;
 *  `releaseCount` proves whether the turn mutex has been released yet (used to
 *  assert the rehydration un-mark fires BEFORE release). `onClear` fires when the
 *  `/clear` command is written — used to simulate a transcript rotation (delete
 *  the JSONL) or a PTY-write throw. */
function makeFakeSession(opts: {
  sessionId: string
  project: string
  credential?: string
  turnsServed: number
  exited?: boolean
  onClear?: () => void
}): {
  session: ReplSession
  writes: string[]
  acquireCount: () => number
  releaseCount: () => number
  key: string
} {
  const writes: string[] = []
  let exited = opts.exited ?? false
  const child: PtyChild = {
    pid: 4242,
    write(data: string | Uint8Array): void {
      const s = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
      writes.push(s)
      if (s === '/clear\r') opts.onClear?.()
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
  // Count acquireTurn contention to prove the busy pre-check never hits the mutex,
  // and wrap the release fn so a test can observe when the mutex is released.
  let acquires = 0
  let releases = 0
  const realAcquire = session.acquireTurn.bind(session)
  session.acquireTurn = async (): Promise<() => void> => {
    acquires += 1
    const rel = await realAcquire()
    return () => {
      releases += 1
      rel()
    }
  }
  return { session, writes, acquireCount: () => acquires, releaseCount: () => releases, key }
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

function newSweep(onScopeReset?: (scope: string) => void) {
  return createPooledContextResetSweep({
    ...SWEEP_ARGS,
    projects_dir: tmpProjectsDir,
    ...(onScopeReset !== undefined ? { onScopeReset } : {}),
  })
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

  it('(ix) onScopeReset fires per reset scope UNDER the mutex — after /clear, BEFORE release (Argus r1 blocker)', async () => {
    freshProjectsDir()
    const a = makeFakeSession({ sessionId: 'sid-ix-a', project: 'proj-A', turnsServed: 1 })
    const b = makeFakeSession({ sessionId: 'sid-ix-b', project: 'proj-B', turnsServed: 1 })
    const under = makeFakeSession({ sessionId: 'sid-ix-u', project: 'proj-U', turnsServed: 1 })
    insert(a)
    insert(b)
    insert(under)
    writeJsonl('sid-ix-a', 2000) // over threshold → reset
    writeJsonl('sid-ix-b', 2000) // over threshold → reset
    writeJsonl('sid-ix-u', 500) // under threshold → NO reset, NO un-mark

    // Record, at each un-mark, whether that scope's session had already written
    // `/clear` (proves the un-mark is AFTER the clear) and whether its turn mutex
    // was still held (releaseCount 0 → BEFORE release — "before releasing control").
    const sessByScope: Record<string, ReturnType<typeof makeFakeSession>> = {
      'proj-A': a,
      'proj-B': b,
    }
    const unmarks: Array<{ scope: string; clearsAtCall: number; releasesAtCall: number }> = []
    const sweep = newSweep((scope) => {
      const s = sessByScope[scope]!
      unmarks.push({ scope, clearsAtCall: CLEARS(s.writes), releasesAtCall: s.releaseCount() })
    })

    const r = await sweep.sweep({ substrate_instance_id: INSTANCE, user_id: USER })

    // Un-marked EXACTLY the two reset scopes (never the under-threshold one).
    expect(unmarks.map((u) => u.scope).sort()).toEqual(['proj-A', 'proj-B'])
    for (const u of unmarks) {
      expect(u.clearsAtCall).toBe(1) // the `/clear` for this session already landed
      expect(u.releasesAtCall).toBe(0) // the turn mutex is STILL held (before release)
    }
    // The under-threshold session was never cleared and never un-marked.
    expect(CLEARS(under.writes)).toBe(0)
    expect(unmarks.some((u) => u.scope === 'proj-U')).toBe(false)
    expect(r.reset.map((x) => x.project_scope).sort()).toEqual(['proj-A', 'proj-B'])
  })

  it('(x) rotation-robust baseline — a null re-measure after /clear stamps baseline 0, not the stale pre-clear size (Argus r1 major)', async () => {
    freshProjectsDir()
    const path = sessionJsonlPath('sid-rot', CWD, tmpProjectsDir)
    // `/clear` "rotates" the transcript away → the re-measure reads null.
    const s = makeFakeSession({
      sessionId: 'sid-rot',
      project: 'proj-A',
      turnsServed: 1,
      onClear: () => rmSync(path, { force: true }),
    })
    insert(s)
    writeJsonl('sid-rot', 2000) // over the 1000-byte threshold

    const sweep = newSweep()
    const r1 = await sweep.sweep({ substrate_instance_id: INSTANCE, user_id: USER })
    expect(r1.reset).toEqual([{ project_scope: 'proj-A', bytes_live: 2000 }])
    expect(CLEARS(s.writes)).toBe(1)

    // A new turn runs; a NEW, SMALLER transcript (1500 B) appears — over the
    // threshold but UNDER the pre-clear 2000. With the rotation-robust baseline 0
    // this fires again (1500 ≥ 1000). With the buggy `?? measured` (2000) baseline
    // it would be stuck under threshold (max(0, 1500 - 2000) = 0) and Layer B would
    // be silently disabled until the new file re-grew past 3000.
    s.session.nextTurnId() // a real turn ran since the reset
    writeJsonl('sid-rot', 1500)
    const r2 = await sweep.sweep({ substrate_instance_id: INSTANCE, user_id: USER })
    expect(r2.reset).toEqual([{ project_scope: 'proj-A', bytes_live: 1500 }])
    expect(r2.skipped).toEqual([])
    expect(CLEARS(s.writes)).toBe(2)
  })

  it('(xi) actuation throw → resetPooledSessionContext reports reset_failed WITH the error detail (Argus r1 minor)', async () => {
    freshProjectsDir()
    // The PTY write throws when `/clear` is issued → the actuation catches it and
    // surfaces the message so `/reset` renders the real cause, not "unknown error".
    const s = makeFakeSession({
      sessionId: 'sid-xi',
      project: 'proj-A',
      turnsServed: 1,
      onClear: () => {
        throw new Error('pty write EPIPE')
      },
    })
    insert(s)

    const out = await resetPooledSessionContext({
      substrate_instance_id: INSTANCE,
      user_id: USER,
      project_scope: 'proj-A',
      idle_quiet_ms: 0,
      idle_max_ms: 50,
    })
    expect(out).toEqual({ ok: false, reason: 'reset_failed', detail: 'pty write EPIPE' })
  })

  it('(xii) re-anchor baseline DOWN after an external auto-compact — later growth past the compacted floor RE-FIRES (Argus r2 major)', async () => {
    freshProjectsDir()
    const s = makeFakeSession({ sessionId: 'sid-comp', project: 'proj-A', turnsServed: 1 })
    insert(s)
    writeJsonl('sid-comp', 2000) // over the 1000-byte threshold

    const sweep = newSweep()
    const r1 = await sweep.sweep({ substrate_instance_id: INSTANCE, user_id: USER })
    expect(r1.reset).toEqual([{ project_scope: 'proj-A', bytes_live: 2000 }])
    // File is un-rotated → the post-clear re-measure stamps baseline.bytes = 2000.

    // An external CC AUTO-compact shrinks the live transcript well below the stored
    // baseline. A real turn ran (so no_new_turns doesn't gate), but the file is now
    // SMALLER than baseline — the sweep must re-anchor its baseline DOWN to 500.
    s.session.nextTurnId()
    writeJsonl('sid-comp', 500)
    const r2 = await sweep.sweep({ substrate_instance_id: INSTANCE, user_id: USER })
    // This tick itself doesn't reset (500 - 500 = 0) but it re-anchored the baseline.
    expect(r2.reset).toEqual([])
    expect(r2.skipped).toEqual([{ project_scope: 'proj-A', reason: 'under_threshold' }])
    expect(CLEARS(s.writes)).toBe(1)

    // Growth of 1100 SINCE the compacted floor (500 → 1600) must RE-FIRE. WITHOUT the
    // re-anchor the baseline would still be 2000 and max(0, 1600-2000)=0 would leave
    // Layer B silently disabled until the file re-grew past 3000 (into the 5 MB warn
    // band in production).
    s.session.nextTurnId()
    writeJsonl('sid-comp', 1600)
    const r3 = await sweep.sweep({ substrate_instance_id: INSTANCE, user_id: USER })
    expect(r3.reset).toEqual([{ project_scope: 'proj-A', bytes_live: 1100 }])
    expect(CLEARS(s.writes)).toBe(2)
  })

  it('(xiii) freshly-spawned warm session with NO transcript on disk → skipped no_transcript, not failed (Argus r2 minor)', async () => {
    freshProjectsDir()
    const s = makeFakeSession({ sessionId: 'sid-fresh', project: 'proj-A', turnsServed: 1 })
    insert(s)
    // Deliberately NO fixture: the session's `<sessionId>.jsonl` has not been written
    // yet (a just-spawned warm session). This is a benign no-op skip, NOT a failure.
    const r = await newSweep().sweep({ substrate_instance_id: INSTANCE, user_id: USER })
    expect(CLEARS(s.writes)).toBe(0)
    expect(r.reset).toEqual([])
    expect(r.skipped).toEqual([{ project_scope: 'proj-A', reason: 'no_transcript' }])
  })
})
