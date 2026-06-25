/**
 * cwd-drift-watchdog.test.ts — the pure cwd-drift cores + the injectable tick
 * (Vajra port row #12). Covers the four §TESTS scenarios from the brief
 * hermetically (no live substrate, no real lsof):
 *
 *   1. Live cwd == canonical (modulo trailing slash / descendant) → no respawn.
 *   2. Live cwd drifted to an unrelated dir → respawn pinned to canonical cwd.
 *   3. Canonical cwd missing on disk → NO respawn, alert fired.
 *   4. Throttle: a second drift within 1h does not re-respawn.
 *
 * Plus the invariants: trailing-slash normalize + descendant tolerance; the
 * async/batched lsof cap (≤5 concurrent); stamp-before-await throttle.
 */

import { describe, it, expect } from 'bun:test'
import {
  DEFAULT_CWD_DRIFT_THROTTLE_MS,
  buildCwdDriftMissingCanonicalAlert,
  decideCwdDriftAction,
  isCwdDrifted,
  mapWithConcurrency,
  normalizeCwd,
  runCwdDriftTick,
  type CwdDriftSupervisedEntry,
} from '../cwd-drift-watchdog.ts'

describe('normalizeCwd', () => {
  it('strips trailing slashes but preserves root', () => {
    expect(normalizeCwd('/a/b/')).toBe('/a/b')
    expect(normalizeCwd('/a/b///')).toBe('/a/b')
    expect(normalizeCwd('/')).toBe('/')
    expect(normalizeCwd('/a/b')).toBe('/a/b')
  })
  it('trims whitespace and strips an lsof " (deleted)" marker', () => {
    expect(normalizeCwd('  /a/b  ')).toBe('/a/b')
    expect(normalizeCwd('/a/b (deleted)')).toBe('/a/b')
  })
  it('maps empty / non-string to ""', () => {
    expect(normalizeCwd('')).toBe('')
    expect(normalizeCwd('   ')).toBe('')
    expect(normalizeCwd(null)).toBe('')
    expect(normalizeCwd(undefined)).toBe('')
  })
})

describe('isCwdDrifted', () => {
  it('equal (modulo trailing slash) is NOT drift', () => {
    expect(isCwdDrifted('/p/proj', '/p/proj')).toBe(false)
    expect(isCwdDrifted('/p/proj/', '/p/proj')).toBe(false)
    expect(isCwdDrifted('/p/proj', '/p/proj/')).toBe(false)
  })
  it('a descendant of canonical is tolerated (NOT drift)', () => {
    expect(isCwdDrifted('/p/proj/src', '/p/proj')).toBe(false)
    expect(isCwdDrifted('/p/proj/a/b/c', '/p/proj')).toBe(false)
  })
  it('an unrelated dir IS drift', () => {
    expect(isCwdDrifted('/p/other', '/p/proj')).toBe(true)
    // a sibling that shares a prefix string but not a path boundary is drift
    expect(isCwdDrifted('/p/proj-merged', '/p/proj')).toBe(true)
  })
  it('an ANCESTOR of canonical is drift (not a descendant)', () => {
    expect(isCwdDrifted('/p', '/p/proj')).toBe(true)
  })
  it('unknown ("") live or canonical is never drift', () => {
    expect(isCwdDrifted('', '/p/proj')).toBe(false)
    expect(isCwdDrifted('/p/other', '')).toBe(false)
  })
  it('root canonical can never drift', () => {
    expect(isCwdDrifted('/anywhere/at/all', '/')).toBe(false)
  })
})

describe('decideCwdDriftAction', () => {
  const base = {
    canonicalCwd: '/p/proj',
    canonicalExists: true,
    lastDriftRespawnAt: undefined,
    now: 1_000_000,
  }
  it('null live cwd → ignore(no-live-cwd)', () => {
    expect(decideCwdDriftAction({ ...base, liveCwd: null })).toEqual({
      kind: 'ignore',
      reason: 'no-live-cwd',
    })
  })
  it('equal / descendant → ignore(not-drifted)', () => {
    expect(decideCwdDriftAction({ ...base, liveCwd: '/p/proj/' }).kind).toBe('ignore')
    expect(decideCwdDriftAction({ ...base, liveCwd: '/p/proj/src' }).kind).toBe('ignore')
  })
  it('drift + canonical missing → alert-missing-canonical, NEVER respawn', () => {
    const a = decideCwdDriftAction({ ...base, liveCwd: '/p/dead-worktree', canonicalExists: false })
    expect(a.kind).toBe('alert-missing-canonical')
  })
  it('drift + canonical present + no prior respawn → respawn', () => {
    const a = decideCwdDriftAction({ ...base, liveCwd: '/p/dead-worktree' })
    expect(a).toMatchObject({ kind: 'respawn', live: '/p/dead-worktree', canonical: '/p/proj' })
  })
  it('drift within the 1h throttle → throttled', () => {
    const a = decideCwdDriftAction({
      ...base,
      liveCwd: '/p/dead-worktree',
      lastDriftRespawnAt: base.now - (DEFAULT_CWD_DRIFT_THROTTLE_MS - 1),
    })
    expect(a.kind).toBe('throttled')
  })
  it('drift after the throttle elapses → respawn again', () => {
    const a = decideCwdDriftAction({
      ...base,
      liveCwd: '/p/dead-worktree',
      lastDriftRespawnAt: base.now - (DEFAULT_CWD_DRIFT_THROTTLE_MS + 1),
    })
    expect(a.kind).toBe('respawn')
  })
})

describe('buildCwdDriftMissingCanonicalAlert', () => {
  it('names the live + canonical dirs and says it refuses to respawn', () => {
    const t = buildCwdDriftMissingCanonicalAlert({
      sessionKey: 'k1',
      live: '/p/dead',
      canonical: '/p/proj',
    })
    expect(t).toContain('/p/dead')
    expect(t).toContain('/p/proj')
    expect(t.toLowerCase()).toContain('refusing to respawn')
  })
})

describe('mapWithConcurrency', () => {
  it('preserves input order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10)
    expect(out).toEqual([10, 20, 30, 40])
  })
  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const items = Array.from({ length: 20 }, (_, i) => i)
    await mapWithConcurrency(items, 5, async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 2))
      inFlight -= 1
      return null
    })
    expect(maxInFlight).toBeLessThanOrEqual(5)
    expect(maxInFlight).toBeGreaterThan(1) // proves it actually batched
  })
  it('handles the empty list', async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([])
  })
})

// ─── The four §TESTS scenarios via the injectable tick ───────────────────────

const ENTRY: CwdDriftSupervisedEntry = { sessionKey: 'k1', pid: 4242, canonicalCwd: '/p/proj' }

function harness(over: {
  liveCwd: string | null
  canonicalExists?: boolean
  lastDriftRespawnAt?: number
}) {
  const alerts: string[] = []
  const respawned: string[] = []
  const throttle = new Map<string, number>()
  if (over.lastDriftRespawnAt !== undefined) throttle.set(ENTRY.sessionKey, over.lastDriftRespawnAt)
  return {
    alerts,
    respawned,
    throttle,
    run: () =>
      runCwdDriftTick({
        entries: [ENTRY],
        probeCwd: async () => over.liveCwd,
        canonicalExists: () => over.canonicalExists ?? true,
        lastDriftRespawnAt: (k) => throttle.get(k),
        markDriftRespawn: (k, at) => throttle.set(k, at),
        respawn: (e) => {
          respawned.push(e.sessionKey)
          return true
        },
        postAlert: (t) => alerts.push(t),
        now: () => 2_000_000,
      }),
  }
}

describe('runCwdDriftTick — §TESTS scenarios', () => {
  it('#1 live cwd == canonical (descendant) → no respawn, no alert', async () => {
    const h = harness({ liveCwd: '/p/proj/src' })
    const res = await h.run()
    expect(res[0]).toMatchObject({ action: 'not-drifted', respawned: false })
    expect(h.respawned).toEqual([])
    expect(h.alerts).toEqual([])
  })

  it('#2 live cwd drifted to an unrelated dir → respawn (pinned to canonical)', async () => {
    const h = harness({ liveCwd: '/p/since-merged-worktree' })
    const res = await h.run()
    expect(res[0]).toMatchObject({ action: 'respawn', respawned: true })
    expect(h.respawned).toEqual(['k1'])
    expect(h.alerts).toEqual([])
    // throttle stamped so the next tick is gated
    expect(h.throttle.get('k1')).toBe(2_000_000)
  })

  it('#3 canonical cwd missing on disk → NO respawn, alert fired', async () => {
    const h = harness({ liveCwd: '/p/since-merged-worktree', canonicalExists: false })
    const res = await h.run()
    expect(res[0]).toMatchObject({ action: 'alert-missing-canonical', respawned: false })
    expect(h.respawned).toEqual([])
    expect(h.alerts.length).toBe(1)
    expect(h.alerts[0]).toContain('/p/proj')
    // the throttle is NOT stamped — we never attempted a respawn
    expect(h.throttle.has('k1')).toBe(false)
  })

  it('#4 throttle: a second drift within 1h does not re-respawn', async () => {
    const h = harness({
      liveCwd: '/p/since-merged-worktree',
      lastDriftRespawnAt: 2_000_000 - (DEFAULT_CWD_DRIFT_THROTTLE_MS - 1),
    })
    const res = await h.run()
    expect(res[0]).toMatchObject({ action: 'throttled', respawned: false })
    expect(h.respawned).toEqual([])
  })

  it('stamps the throttle BEFORE the respawn await (fire-once even if respawn fails)', async () => {
    const throttle = new Map<string, number>()
    const res = await runCwdDriftTick({
      entries: [ENTRY],
      probeCwd: async () => '/p/elsewhere',
      canonicalExists: () => true,
      lastDriftRespawnAt: (k) => throttle.get(k),
      markDriftRespawn: (k, at) => throttle.set(k, at),
      respawn: () => {
        throw new Error('respawn boom')
      },
      now: () => 5_000,
    })
    expect(res[0]).toMatchObject({ action: 'respawn', respawned: false })
    expect(throttle.get('k1')).toBe(5_000) // stamped despite the throw → no churn
  })

  it('a failed probe (null) for one entry does not block the others', async () => {
    const respawned: string[] = []
    const entries: CwdDriftSupervisedEntry[] = [
      { sessionKey: 'a', pid: 1, canonicalCwd: '/p/proj' },
      { sessionKey: 'b', pid: 2, canonicalCwd: '/p/proj' },
    ]
    const res = await runCwdDriftTick({
      entries,
      probeCwd: async (pid) => (pid === 1 ? null : '/p/drifted'),
      canonicalExists: () => true,
      lastDriftRespawnAt: () => undefined,
      markDriftRespawn: () => {},
      respawn: (e) => {
        respawned.push(e.sessionKey)
        return true
      },
      now: () => 1,
    })
    expect(res[0]).toMatchObject({ sessionKey: 'a', action: 'no-live-cwd' })
    expect(res[1]).toMatchObject({ sessionKey: 'b', action: 'respawn', respawned: true })
    expect(respawned).toEqual(['b'])
  })
})
