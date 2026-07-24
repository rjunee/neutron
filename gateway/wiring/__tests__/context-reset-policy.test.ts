/**
 * context-reset-policy.test.ts — Layer B policy tick loop (`startContextResetPolicy`).
 *
 * DI timers + clock: `setIntervalFn` captures the cadence callback so the test
 * drives ticks manually, and `now()` is a mutable clock so the per-scope cooldown
 * is exercised deterministically. Real state assertions: the sweep predicate's
 * truth value per scope (proving the cooldown clock is stamped for every reset
 * scope), the sweep-call count, error survival, the overlapping-tick guard, and
 * `stop()` clearing the interval.
 *
 * The rehydration UN-MARK is NOT the policy's job — it fires inside the sweep under
 * the session mutex (Argus r1 blocker fix), so it is asserted in the runtime sweep
 * suite (`context-reset-sweep.test.ts`), not here. This suite proves only the
 * policy's two responsibilities: cadence and per-scope cooldown.
 */
import { describe, expect, test } from 'bun:test'
import { startContextResetPolicy } from '../context-reset-policy.ts'

type SweepFn = (should_reset: (scope: string) => boolean) => Promise<{ reset: Array<{ project_scope: string }> }>

function harness(overrides: {
  sweep: SweepFn
  cooldownMs?: number
  now: () => number
}) {
  let captured: (() => void) | undefined
  let cleared = false
  const errors: unknown[] = []
  const policy = startContextResetPolicy({
    sweep: overrides.sweep,
    ...(overrides.cooldownMs !== undefined ? { cooldownMs: overrides.cooldownMs } : {}),
    now: overrides.now,
    setIntervalFn: (cb) => {
      captured = cb
      return 1
    },
    clearIntervalFn: () => {
      cleared = true
    },
    onError: (e) => errors.push(e),
  })
  return {
    policy,
    errors,
    isCleared: () => cleared,
    fireCadence: () => captured?.(),
  }
}

describe('startContextResetPolicy', () => {
  test('tick sweeps with a predicate true for a never-reset scope; cooldown flips it false then true', async () => {
    let clock = 1_000_000
    const cooldownMs = 45 * 60 * 1000
    const predicateResults: Array<{ scope: string; allowed: boolean }> = []
    const sweep: SweepFn = async (should_reset) => {
      // Record the predicate's verdict for a never-reset scope + the just-reset one.
      predicateResults.push({ scope: 'proj-A', allowed: should_reset('proj-A') })
      // Reset proj-A on the FIRST tick only.
      return { reset: predicateResults.length === 1 ? [{ project_scope: 'proj-A' }] : [] }
    }
    const h = harness({ sweep, cooldownMs, now: () => clock })

    // Tick 1: proj-A never reset → predicate true → sweep resets it → cooldown stamped.
    await h.policy.tick()
    expect(predicateResults[0]).toEqual({ scope: 'proj-A', allowed: true })

    // Tick 2 within cooldown: predicate must now be FALSE for proj-A — proving the
    // reset stamped the cooldown clock.
    clock += cooldownMs - 1
    await h.policy.tick()
    expect(predicateResults[1]).toEqual({ scope: 'proj-A', allowed: false })

    // Tick 3 past cooldown: predicate true again.
    clock += 2
    await h.policy.tick()
    expect(predicateResults[2]).toEqual({ scope: 'proj-A', allowed: true })
  })

  test('cooldown is stamped for EVERY scope the sweep reset (multi-scope)', async () => {
    let clock = 0
    const cooldownMs = 1000
    const predicateResults: Array<Record<string, boolean>> = []
    const sweep: SweepFn = async (should_reset) => {
      predicateResults.push({ A: should_reset('proj-A'), B: should_reset('proj-B') })
      // Reset BOTH scopes on the first tick only.
      return {
        reset: predicateResults.length === 1
          ? [{ project_scope: 'proj-A' }, { project_scope: 'proj-B' }]
          : [],
      }
    }
    const h = harness({ sweep, cooldownMs, now: () => clock })

    await h.policy.tick() // both never reset → both allowed → both reset
    expect(predicateResults[0]).toEqual({ A: true, B: true })

    // Still inside cooldown for BOTH — each was stamped.
    clock += cooldownMs - 1
    await h.policy.tick()
    expect(predicateResults[1]).toEqual({ A: false, B: false })
  })

  test('a throwing sweep goes to onError and the next tick still runs', async () => {
    let calls = 0
    const sweep: SweepFn = async () => {
      calls += 1
      if (calls === 1) throw new Error('sweep exploded')
      return { reset: [{ project_scope: 'proj-A' }] }
    }
    const h = harness({ sweep, now: () => 0 })

    await h.policy.tick() // throws → caught
    expect(h.errors).toHaveLength(1)
    expect(calls).toBe(1)

    await h.policy.tick() // loop survived → still runs
    expect(calls).toBe(2)
  })

  test('overlapping ticks are guarded — a second tick while the first is in flight is a no-op', async () => {
    let sweepStarts = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const sweep: SweepFn = async () => {
      sweepStarts += 1
      await gate // hold the first sweep in flight
      return { reset: [] }
    }
    const h = harness({ sweep, now: () => 0 })

    const first = h.policy.tick() // starts + parks on the gate
    await Promise.resolve()
    const second = h.policy.tick() // guard → returns immediately without sweeping
    await second
    expect(sweepStarts).toBe(1) // the second tick did NOT start a concurrent sweep

    release?.()
    await first
    // After the first drains, a fresh tick sweeps again.
    await h.policy.tick()
    expect(sweepStarts).toBe(2)
  })

  test('stop() clears the interval and is idempotent', () => {
    const h = harness({ sweep: async () => ({ reset: [] }), now: () => 0 })
    expect(h.isCleared()).toBe(false)
    h.policy.stop()
    expect(h.isCleared()).toBe(true)
    // Idempotent — a second stop is a no-op (no throw).
    h.policy.stop()
  })

  test('the cadence callback drives tick() (setIntervalFn wiring)', async () => {
    let sweeps = 0
    const sweep: SweepFn = async () => {
      sweeps += 1
      return { reset: [{ project_scope: 'proj-A' }] }
    }
    const h = harness({ sweep, now: () => 0 })
    h.fireCadence() // simulate the interval firing
    // The cadence schedules tick() as a floating promise; give it a microtask beat.
    await new Promise((r) => setTimeout(r, 5))
    expect(sweeps).toBe(1)
  })
})
