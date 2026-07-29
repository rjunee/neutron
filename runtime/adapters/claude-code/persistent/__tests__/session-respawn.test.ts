/**
 * session-respawn.test.ts — ported from Nova `gateway/topic-respawn.test.ts`.
 * planRespawn refusals (esp. no-session-to-resume), executeRespawn order-of-ops,
 * the RESUME INVARIANT ("preserves session_id — never clears it", S2 § 6
 * acceptance #4), and notice gating. Drives executeRespawn with recorded deps —
 * no real PtyHost / pool / disk.
 */

import { describe, it, expect } from 'bun:test'
import {
  buildRespawnNoticeText,
  executeRespawn,
  planRespawn,
  shouldPostRespawnNotice,
  type RespawnDeps,
} from '../session-respawn.ts'
import type { ReplRegistryRecord } from '../repl-registry.ts'

function record(over: Partial<ReplRegistryRecord> = {}): ReplRegistryRecord {
  return {
    sessionKey: 'instance-a /home/a',
    sessionId: 'uuid-1234-5678',
    cwd: '/home/a',
    channelName: 'neutron-abcd',
    has_session: true,
    ...over,
  }
}

function recordingDeps(over: Partial<RespawnDeps> = {}): {
  deps: RespawnDeps
  calls: string[]
} {
  const calls: string[] = []
  const deps: RespawnDeps = {
    killChild: (k) => calls.push(`kill:${k}`),
    evictPool: (k) => calls.push(`evict:${k}`),
    spawnResume: (r) => {
      calls.push(`spawn:${r.sessionId}`)
      return { ok: true }
    },
    saveRecord: () => calls.push('save'),
    clearForwardGate: (s) => calls.push(`clearfwd:${s}`),
    now: () => 1_700_000_000_000,
    log: () => {},
    ...over,
  }
  return { deps, calls }
}

describe('planRespawn — refusals (always-resume contract)', () => {
  it('invalid-session-key for empty input', () => {
    expect(planRespawn({}, '')).toEqual({ ok: false, reason: 'invalid-session-key' })
  })

  it('session-not-found when no registry row', () => {
    expect(planRespawn({}, 'missing')).toEqual({ ok: false, reason: 'session-not-found' })
  })

  it('no-session-to-resume when the row is not resumable (has_session=false)', () => {
    const reg = { k: record({ sessionKey: 'k', has_session: false }) }
    expect(planRespawn(reg, 'k')).toEqual({ ok: false, reason: 'no-session-to-resume', sessionKey: 'k' })
  })

  it('ok with the captured sessionId when resumable', () => {
    const reg = { k: record({ sessionKey: 'k' }) }
    expect(planRespawn(reg, 'k')).toEqual({ ok: true, sessionId: 'uuid-1234-5678', sessionKey: 'k' })
  })
})

describe('executeRespawn — order of operations', () => {
  it('kill → evict → clearForwardGate → save → spawn, in that order', () => {
    const rec = record({ sessionKey: 'k' })
    const plan = planRespawn({ k: rec }, 'k')
    const { deps, calls } = recordingDeps()
    const out = executeRespawn(rec, plan, 'wedge-watchdog', 'pid-dead', deps)
    expect(out.ok).toBe(true)
    expect(calls).toEqual([
      'kill:k',
      'evict:k',
      'clearfwd:uuid-1234-5678',
      'save',
      'spawn:uuid-1234-5678',
    ])
  })

  it('RESUME INVARIANT: never clears sessionId or has_session; KEEPS the dead pid as the failed-respawn liveness anchor', () => {
    const rec = record({ sessionKey: 'k', pid: 4242 })
    const plan = planRespawn({ k: rec }, 'k')
    const { deps } = recordingDeps()
    executeRespawn(rec, plan, 'crash-watchdog', 'crash', deps)
    expect(rec.sessionId).toBe('uuid-1234-5678')
    expect(rec.has_session).toBe(true)
    // pid is PRESERVED (Codex P1): the just-killed child's pid stays so that if the
    // async resume spawn fails, the next watchdog tick reads pid-dead → retry,
    // instead of {no-child,no-pid,ccReady} → not-wedged → permanent stranding. On
    // a successful spawn, spawnSession overwrites the record with the fresh pid.
    expect(rec.pid).toBe(4242)
    expect(rec.last_respawn_at).toBe(1_700_000_000_000)
    expect(rec.recent_respawns).toEqual([1_700_000_000_000])
  })

  it('persists BEFORE spawn (crash-safe ordering)', () => {
    const rec = record({ sessionKey: 'k' })
    const plan = planRespawn({ k: rec }, 'k')
    const { deps, calls } = recordingDeps()
    executeRespawn(rec, plan, 'admin-endpoint', 'manual', deps)
    expect(calls.indexOf('save')).toBeLessThan(calls.indexOf('spawn:uuid-1234-5678'))
  })

  it('propagates a spawnResume refusal as spawn-cwd-invalid / spawn-failed', () => {
    const rec = record({ sessionKey: 'k' })
    const plan = planRespawn({ k: rec }, 'k')
    const { deps } = recordingDeps({ spawnResume: () => ({ ok: false, reason: 'invalid-cwd' }) })
    const out = executeRespawn(rec, plan, 'wedge-watchdog', 'x', deps)
    expect(out).toMatchObject({ ok: false, reason: 'spawn-cwd-invalid', sessionKey: 'k' })
  })

  it('refuses to execute a refused plan (no side effects)', () => {
    const rec = record({ sessionKey: 'k', has_session: false })
    const plan = planRespawn({ k: rec }, 'k') // no-session-to-resume
    const { deps, calls } = recordingDeps()
    const out = executeRespawn(rec, plan, 'wedge-watchdog', 'x', deps)
    expect(out.ok).toBe(false)
    expect(calls).toEqual([])
  })

  it('returns spawn-failed if spawnResume throws', () => {
    const rec = record({ sessionKey: 'k' })
    const plan = planRespawn({ k: rec }, 'k')
    const { deps } = recordingDeps({
      spawnResume: () => {
        throw new Error('boom')
      },
    })
    const out = executeRespawn(rec, plan, 'wedge-watchdog', 'x', deps)
    expect(out).toMatchObject({ ok: false, reason: 'spawn-failed' })
  })
})

describe('notice gating', () => {
  it('stuck-turn recovery is silent; every other trigger posts', () => {
    expect(shouldPostRespawnNotice('stuck-turn-watchdog')).toBe(false)
    expect(shouldPostRespawnNotice('admin-endpoint')).toBe(true)
    expect(shouldPostRespawnNotice('wedge-watchdog')).toBe(true)
    expect(shouldPostRespawnNotice('crash-watchdog')).toBe(true)
  })

  it('notice text names the session + states context preserved', () => {
    const text = buildRespawnNoticeText({
      sessionKey: 'k',
      sessionId: 'uuid-1234-5678',
      trigger: 'crash-watchdog',
      reason: 'process exited',
    })
    expect(text).toContain('uuid-123') // first 8 of the id
    expect(text).toContain('context preserved')
  })

  it('fires postNotice on success (fire-and-forget)', async () => {
    const rec = record({ sessionKey: 'k' })
    const plan = planRespawn({ k: rec }, 'k')
    let noticed = false
    const { deps } = recordingDeps({ postNotice: () => { noticed = true } })
    executeRespawn(rec, plan, 'admin-endpoint', 'manual', deps)
    await Promise.resolve()
    await Promise.resolve()
    expect(noticed).toBe(true)
  })
})
