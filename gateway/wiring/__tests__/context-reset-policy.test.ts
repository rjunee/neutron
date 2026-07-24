/**
 * context-reset-policy.test.ts — Layer B policy tick loop (`startContextResetPolicy`).
 *
 * DI timers + clock: `setIntervalFn` captures the cadence callback so the test
 * drives ticks manually, and `now()` is a mutable clock so the per-scope cooldown
 * is exercised deterministically. Real state assertions: the sweep predicate's
 * truth value per scope, `onScopeReset` firing once per reset scope, error
 * survival, the overlapping-tick guard, and `stop()` clearing the interval.
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
  const resetScopes: string[] = []
  const errors: unknown[] = []
  const policy = startContextResetPolicy({
    sweep: overrides.sweep,
    onScopeReset: (scope) => resetScopes.push(scope),
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
    resetScopes,
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

    // Tick 1: proj-A never reset → predicate true → sweep resets it → onScopeReset.
    await h.policy.tick()
    expect(predicateResults[0]).toEqual({ scope: 'proj-A', allowed: true })
    expect(h.resetScopes).toEqual(['proj-A'])

    // Tick 2 within cooldown: predicate must now be FALSE for proj-A.
    clock += cooldownMs - 1
    await h.policy.tick()
    expect(predicateResults[1]).toEqual({ scope: 'proj-A', allowed: false })
    // No new reset scope fired.
    expect(h.resetScopes).toEqual(['proj-A'])

    // Tick 3 past cooldown: predicate true again.
    clock += 2
    await h.policy.tick()
    expect(predicateResults[2]).toEqual({ scope: 'proj-A', allowed: true })
  })

  test('onScopeReset fires once per reset scope', async () => {
    const sweep: SweepFn = async () => ({
      reset: [{ project_scope: 'proj-A' }, { project_scope: 'proj-B' }],
    })
    const h = harness({ sweep, now: () => 0 })
    await h.policy.tick()
    expect(h.resetScopes.sort()).toEqual(['proj-A', 'proj-B'])
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
    expect(h.resetScopes).toEqual([])

    await h.policy.tick() // loop survived → still runs
    expect(h.resetScopes).toEqual(['proj-A'])
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
    const sweep: SweepFn = async () => ({ reset: [{ project_scope: 'proj-A' }] })
    const h = harness({ sweep, now: () => 0 })
    h.fireCadence() // simulate the interval firing
    // The cadence schedules tick() as a floating promise; give it a microtask beat.
    await new Promise((r) => setTimeout(r, 5))
    expect(h.resetScopes).toEqual(['proj-A'])
  })
})
