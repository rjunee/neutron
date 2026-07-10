/**
 * @neutronai/loop — the `SupervisedLoop` primitive (world-class refactor §F1).
 *
 * ONE driver for every long-lived in-process tick loop. Before F1 all five
 * hand-rolled loops (trident/tick.ts, reminders/tick.ts, the project-backup
 * scheduler, the chunked-upload sweeper, and cron's interval jobs) fired
 * `void this.runOnce()` on a bare `setInterval`. That shape had two latent
 * bugs the audit called out:
 *
 *   1. A store-level throw inside a tick escaped as a promise rejection with
 *      NO `unhandledRejection` handler installed anywhere — so a single bad
 *      DB read could take the process down (or, worse, be silently dropped).
 *   2. `stop()` cleared the interval but did NOT await the in-flight tick, so
 *      a shutdown path could `db.close()` while a tick was mid-write.
 *
 * `SupervisedLoop` fixes both in one place and adds the supervision the audit
 * asked for:
 *
 *   • single-flight — a tick still running when the interval fires is SKIPPED
 *     (counted), never stacked. No two loop-driven ticks ever overlap.
 *   • per-tick catch-all — a throw from the tick body is CAUGHT, routed to
 *     `onError` (default: `console.error`), and counted. It can never become
 *     an unhandledRejection nor abort the loop.
 *   • consecutive-failure counter + escalation hook — every `escalateThreshold`
 *     consecutive failures fires `onEscalate` once, so a wedged loop is
 *     observable instead of silently spinning on errors. A single success
 *     resets the streak.
 *   • stats() — `{ ticks, failures, consecutiveFailures, skipped, running }`.
 *   • stop(): Promise<void> — clears the timer, THEN awaits the in-flight tick
 *     so a caller can `await loop.stop()` before `db.close()` (quiesce).
 *
 * The primitive owns ONLY the loop scaffolding (interval, single-flight, error
 * handling, quiescing stop). Each adopting loop keeps its OWN tick body and its
 * OWN domain invariants — trident's `listNonTerminal`-only sweep + save-before-
 * hook, reminders' claim-before-dispatch + compare-and-swap revert, the backup
 * scheduler's per-project jitter timers, cron's calendar re-arm + per-job
 * skip-recording. Cron does not become a `SupervisedLoop` (it keeps its N
 * per-job timers + calendar logic); it delegates only its FIRE PATH to
 * {@link guardedFire}, the same catch-all this loop runs its tick behind.
 */

/** Payload handed to {@link SupervisedLoopOptions.onEscalate}. */
export interface SupervisedLoopEscalation {
  /** The loop's {@link SupervisedLoopOptions.name}. */
  readonly name: string
  /** Number of consecutive tick failures at the moment of escalation. */
  readonly consecutiveFailures: number
  /** The error thrown by the most recent failing tick. */
  readonly error: unknown
}

/** Snapshot returned by {@link SupervisedLoop.stats}. */
export interface SupervisedLoopStats {
  /** Ticks that ran to completion without throwing. */
  readonly ticks: number
  /** Ticks that threw (caught by the catch-all). */
  readonly failures: number
  /** Current consecutive-failure streak (0 after any success). */
  readonly consecutiveFailures: number
  /** Ticks skipped because a previous tick was still in flight (single-flight). */
  readonly skipped: number
  /** Whether a tick is executing right now. */
  readonly running: boolean
}

/** Result of a single {@link SupervisedLoop.runOnce}. */
export interface SupervisedLoopTickResult {
  /** True when the tick body ran AND returned without throwing. */
  readonly ran: boolean
  /** True when the tick was skipped because one was already in flight. */
  readonly skipped: boolean
}

export interface SupervisedLoopOptions {
  /** Stable identifier used in default log lines + escalation payloads. */
  name: string
  /** Interval between ticks (ms). */
  intervalMs: number
  /**
   * The domain tick body. Runs behind the single-flight guard + catch-all.
   * A throw is caught + counted; a return resets the failure streak.
   */
  tick: () => Promise<void>
  /**
   * Fire one immediate tick right after `start()` (fire-and-forget, still
   * single-flighted + supervised). The backup scheduler's boot-backfill relies
   * on this; the other loops leave it `false` and wait one interval. Default
   * `false`.
   */
  immediate?: boolean
  /**
   * Consecutive tick failures before `onEscalate` fires (and again every
   * `escalateThreshold` failures beyond it). Default 5. Must be >= 1.
   */
  escalateThreshold?: number
  /** Fired when the consecutive-failure streak hits a multiple of the threshold. */
  onEscalate?: (info: SupervisedLoopEscalation) => void
  /** Per-tick error sink. Default logs `[supervised-loop] tick '<name>' threw:`. */
  onError?: (name: string, error: unknown) => void
  /** `setInterval` seam (tests). Default global `setInterval`. */
  setTimer?: (fn: () => void, ms: number) => unknown
  /** `clearInterval` seam (tests). Default global `clearInterval`. */
  clearTimer?: (handle: unknown) => void
}

/**
 * Run a single piece of async work behind a catch-all so a rejection can never
 * escape as an unhandledRejection. Resolves to `true` when `work()` settled
 * cleanly, `false` when it threw (the error is routed to `onError` first).
 * NEVER rejects — even a SYNCHRONOUS throw from `work()` (it is a thunk invoked
 * inside the try) or a throwing `onError` sink is contained.
 *
 * This is the shared "fire path" discipline: {@link SupervisedLoop} runs its
 * tick behind it, and cron — which keeps its own per-job calendar timers +
 * overlap skip-recording — routes each `fireOnce` through it so a store-level
 * throw in the fire tail is contained and the in-flight fire can be awaited on
 * shutdown.
 */
export async function guardedFire(
  name: string,
  work: () => Promise<unknown>,
  onError?: (name: string, error: unknown) => void,
): Promise<boolean> {
  try {
    await work()
    return true
  } catch (err) {
    if (onError !== undefined) {
      // The error sink must never re-throw out of the catch-all — that would
      // break the "never rejects" contract and could become an unhandled
      // rejection on a fire-and-forget timer path.
      try {
        onError(name, err)
      } catch (sinkErr) {
        console.error(`[supervised-loop] onError sink for '${name}' threw:`, sinkErr)
      }
    } else {
      console.error(`[supervised-loop] tick '${name}' threw:`, err)
    }
    return false
  }
}

export class SupervisedLoop {
  private readonly name: string
  private readonly intervalMs: number
  private readonly tickBody: () => Promise<void>
  private readonly immediate: boolean
  private readonly escalateThreshold: number
  private readonly onEscalate: ((info: SupervisedLoopEscalation) => void) | null
  private readonly onErrorFn: (name: string, error: unknown) => void
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  private timer: unknown | null = null
  private running = false
  private inflight: Promise<void> | null = null
  private lastError: unknown = null
  private tickCount = 0
  private failureCount = 0
  private consecutiveFailures = 0
  private skippedCount = 0

  constructor(opts: SupervisedLoopOptions) {
    this.name = opts.name
    this.intervalMs = opts.intervalMs
    this.tickBody = opts.tick
    this.immediate = opts.immediate ?? false
    this.escalateThreshold = Math.max(1, opts.escalateThreshold ?? 5)
    this.onEscalate = opts.onEscalate ?? null
    this.onErrorFn =
      opts.onError ??
      ((name, error): void => {
        console.error(`[supervised-loop] tick '${name}' threw:`, error)
      })
    this.setTimer = opts.setTimer ?? ((fn, ms): unknown => setInterval(fn, ms))
    this.clearTimer =
      opts.clearTimer ?? ((handle): void => clearInterval(handle as ReturnType<typeof setInterval>))
  }

  /**
   * Start ticking. Idempotent — a second `start()` while already running is a
   * no-op. With `immediate: true` an out-of-band first tick is fired right
   * after the interval is armed (fire-and-forget, still single-flighted).
   */
  start(): void {
    if (this.timer !== null) return
    this.timer = this.setTimer(() => {
      void this.runOnce()
    }, this.intervalMs)
    if (this.immediate) void this.runOnce()
  }

  /**
   * Run exactly one supervised tick. Exposed so callers (and tests) can drive
   * the loop manually. Single-flight: if a tick is already running this returns
   * `{ ran: false, skipped: true }` immediately without invoking the body.
   */
  async runOnce(): Promise<SupervisedLoopTickResult> {
    if (this.running) {
      this.skippedCount++
      return { ran: false, skipped: true }
    }
    this.running = true
    // Route the tick through the shared catch-all AND record the in-flight
    // promise so a concurrent `stop()` can await it (quiesce). `tickBody` is
    // passed as a THUNK so a synchronous throw is caught too (otherwise it would
    // escape here and leave `running` stuck true). `guardedFire` never rejects,
    // so `inflight` never carries a rejection.
    const p = guardedFire(this.name, () => this.tickBody(), (name, err) => {
      this.lastError = err
      this.onErrorFn(name, err)
    })
    const settled = p.then(() => undefined)
    this.inflight = settled
    let ok = false
    try {
      ok = await p
    } finally {
      this.running = false
      this.inflight = null
    }
    if (ok) {
      this.tickCount++
      this.consecutiveFailures = 0
    } else {
      this.failureCount++
      this.consecutiveFailures++
      if (
        this.onEscalate !== null &&
        this.consecutiveFailures % this.escalateThreshold === 0
      ) {
        try {
          this.onEscalate({
            name: this.name,
            consecutiveFailures: this.consecutiveFailures,
            error: this.lastError,
          })
        } catch (escErr) {
          // The escalation hook must never throw back into the loop.
          console.error(`[supervised-loop] escalation hook for '${this.name}' threw:`, escErr)
        }
      }
    }
    return { ran: ok, skipped: false }
  }

  /**
   * Stop ticking and QUIESCE: clear the interval so no new tick fires, then
   * await the in-flight tick (if any) so a caller can safely `db.close()` after
   * `await loop.stop()`. Idempotent + safe to call when never started.
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    const p = this.inflight
    if (p !== null) {
      // `guardedFire` never rejects; the catch is defensive.
      try {
        await p
      } catch {
        /* unreachable — quiesce must never throw */
      }
    }
  }

  stats(): SupervisedLoopStats {
    return {
      ticks: this.tickCount,
      failures: this.failureCount,
      consecutiveFailures: this.consecutiveFailures,
      skipped: this.skippedCount,
      running: this.running,
    }
  }
}
