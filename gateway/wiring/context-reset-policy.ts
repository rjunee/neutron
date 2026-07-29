/**
 * context-reset-policy.ts — Layer B periodic orchestrator context-reset policy
 * (SPEC WAVE 3.5). A pure DI tick loop that drives the runtime's context-reset
 * SWEEP on a cadence and, per scope that was reset, stamps a per-scope cooldown.
 *
 * The rehydration UN-MARK does NOT live here — it fires INSIDE the sweep, under
 * each session's turn mutex the instant its `/clear` lands (the sweep's
 * `onScopeReset`), so a turn that acquires a just-cleared session next re-composes
 * COLD before it can run. Firing it here, in a post-sweep loop, left a whole
 * multi-session-sweep window in which a warm bare turn could run on an already-
 * cleared REPL (Argus r1 blocker). This policy therefore owns only cadence +
 * cooldown; the sweep owns the reset actuation AND its synchronous un-mark.
 *
 * Pure DI — this module imports NOTHING from the runtime adapter (the sweep + the
 * scope-reset signal arrive as injected functions), so the gateway→runtime
 * type-only edge stays clean (only the composer touches the runtime module, an
 * already-allowed edge). The lifecycle (unref'd interval, idempotent `stop()`,
 * exposed `tick()` for tests, `onError` default stderr, overlapping-tick guard)
 * is cloned from `startSessionSizeWatchdog` (session-size-watchdog.ts).
 * (`fireAndForget` is the shared logger helper, not a runtime import.)
 *
 * WHY a policy tick and not the size watchdog: the size watchdog is the WEDGE
 * BACKSTOP — it fires only at the 5 MB warn / 10 MB critical bands, right before
 * `--resume` is at risk. Layer B keeps the orchestrator in the GOOD ZONE with a
 * frequent, small, 2 MB-delta reset + a lossless rehydrate, so the orchestrator's
 * live window stays small during ordinary multi-turn work.
 */

import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

/** Default cadence: sweep every 5 min. The sweep is a bounded fs read per warm
 *  session + an idle-gated `/clear`, so it stays well off the hot path. */
export const DEFAULT_CONTEXT_RESET_TICK_MS = 5 * 60 * 1000
/** Default per-scope cooldown: a scope that was just reset is not reset again for
 *  45 min, so a busy project can't be `/clear`-ed on every tick. */
export const DEFAULT_CONTEXT_RESET_COOLDOWN_MS = 45 * 60 * 1000

export interface ContextResetPolicyDeps {
  /**
   * Run one sweep over the warm orchestrator pool. Receives a `should_reset`
   * predicate the loop composes from the per-scope cooldown; returns the scopes
   * that were actually reset (the `reset` half of the runtime `SweepReport` — the
   * loop only needs `project_scope`, so it is typed structurally here to keep this
   * module free of a runtime import).
   */
  sweep: (
    should_reset: (project_scope: string) => boolean,
  ) => Promise<{ reset: Array<{ project_scope: string }> }>
  /** Cadence in ms. Default {@link DEFAULT_CONTEXT_RESET_TICK_MS} (5 min). */
  intervalMs?: number
  /** Per-scope cooldown in ms. Default {@link DEFAULT_CONTEXT_RESET_COOLDOWN_MS}
   *  (45 min). */
  cooldownMs?: number
  /** DI: monotonic-ish clock (ms). Default Date.now. */
  now?: () => number
  /** DI: setInterval shim (tests advance the clock manually). */
  setIntervalFn?: (cb: () => void, ms: number) => unknown
  /** DI: clearInterval shim; accepts whatever setIntervalFn returned. */
  clearIntervalFn?: (handle: unknown) => void
  /** Called if a tick body throws (a throwing sweep must NOT kill the loop).
   *  Default logs to stderr. */
  onError?: (err: unknown) => void
}

export interface ContextResetPolicy {
  /** Stop the cadence tick. Idempotent. */
  stop(): void
  /** Run one tick (test/introspection — the cadence calls this). */
  tick(): Promise<void>
}

/**
 * Start the periodic context-reset policy. Every `intervalMs` it sweeps the warm
 * orchestrator pool with a cooldown-derived predicate, then for each scope that
 * was reset stamps the cooldown clock (the sweep already un-marked the scope for
 * rehydration under the mutex). A throwing sweep is caught → `onError`, and the
 * loop keeps ticking.
 * Overlapping ticks are guarded (a slow sweep that outruns the cadence skips the
 * next tick rather than running two sweeps concurrently).
 */
export function startContextResetPolicy(deps: ContextResetPolicyDeps): ContextResetPolicy {
  const intervalMs = deps.intervalMs ?? DEFAULT_CONTEXT_RESET_TICK_MS
  const cooldownMs = deps.cooldownMs ?? DEFAULT_CONTEXT_RESET_COOLDOWN_MS
  const now = deps.now ?? Date.now
  const setIntervalFn =
    deps.setIntervalFn ?? ((cb: () => void, ms: number) => globalThis.setInterval(cb, ms))
  const clearIntervalFn =
    deps.clearIntervalFn ??
    ((h: unknown) => globalThis.clearInterval(h as Parameters<typeof globalThis.clearInterval>[0]))
  const onError =
    deps.onError ??
    ((err: unknown) =>
      process.stderr.write(
        `[context-reset-policy] tick error: ${err instanceof Error ? err.message : String(err)}\n`,
      ))

  /** Per-scope last-reset timestamp — the cooldown anchor. */
  const lastResetAt = new Map<string, number>()
  /** Overlapping-tick guard: true while a sweep is in flight. */
  let ticking = false

  const tick = async (): Promise<void> => {
    if (ticking) return // a prior sweep is still running — skip this tick.
    ticking = true
    try {
      const predicate = (scope: string): boolean =>
        now() - (lastResetAt.get(scope) ?? -Infinity) >= cooldownMs
      const report = await deps.sweep(predicate)
      // Stamp the per-scope cooldown clock for every scope the sweep reset. The
      // rehydration un-mark already fired inside the sweep, under the session
      // mutex (see the module header) — the policy does NOT re-fire it here.
      for (const { project_scope } of report.reset) {
        lastResetAt.set(project_scope, now())
      }
    } catch (err) {
      onError(err)
    } finally {
      ticking = false
    }
  }

  const handle = setIntervalFn(() => {
    // `tick()` never rejects (it try/catches into `onError`), but the gate wants
    // every floating promise named — the overlapping-tick guard already prevents
    // a pile-up.
    fireAndForget('context-reset-policy.tick', tick())
  }, intervalMs)
  // Don't let the cadence timer keep the Bun event loop alive on its own — the
  // owner's live-agent wiring owns its lifetime; `stop()` (teardown) is the
  // authoritative clear. Mirrors the size-watchdog / supervision timers.
  ;(handle as { unref?: () => void })?.unref?.()

  let stopped = false
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      clearIntervalFn(handle)
    },
    tick,
  }
}
