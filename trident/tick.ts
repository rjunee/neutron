/**
 * @neutronai/trident — fire-time loop.
 *
 * Modelled on `reminders/tick.ts`: a `setInterval` that, each tick, loads
 * every non-terminal run via `TridentRunStore.listNonTerminal` and calls
 * `advanceTridentRun` for each. This replaces Vajra's out-of-process
 * ScheduleWakeup driver — where Vajra's `/trident check` re-entered the
 * skill every ~90s per run, Neutron runs ONE in-process loop that sweeps
 * all active runs.
 *
 * Invariants (mirror the reminder loop):
 *   • Single-flight — one tick at a time. A tick that overruns the
 *     interval is skipped (counted), never stacked.
 *   • Idempotent — `advanceTridentRun` only persists when a run actually
 *     transitions; a tick with no due transitions is a no-op read.
 *   • Restart-safe — all state lives in the row, so a fresh process picks
 *     each run up exactly where it left off (the in-flight sub-agent's
 *     id + status are persisted on the row, not in memory).
 *
 * Default interval is 90 s — matches the skill's ScheduleWakeup cadence.
 */

import { advanceTridentRun, type AdvanceDeps, type AdvanceOutcome } from './state-machine.ts'
import type { TridentRun, TridentRunStore } from './store.ts'

/**
 * The per-run advance function the loop applies each tick. PR-2 derives
 * it from `deps` (the pure `advanceTridentRun`); PR-3 passes its own
 * `step` (`orchestrator.ts`) that ALSO spawns the next phase's sub-agent
 * and merges on `done`. Either way the loop only persists when a step
 * reports `changed`.
 */
export interface TridentStepFn {
  (run: TridentRun): Promise<AdvanceOutcome>
}

export interface TridentTickOptions {
  store: TridentRunStore
  /**
   * State-machine deps — the classify seam used to build the default
   * step. PR-2 production wiring passes `stubAdvanceDeps` (always
   * "running"). Ignored when an explicit `step` is supplied. Required
   * unless `step` is provided.
   */
  deps?: AdvanceDeps
  /**
   * PR-3 spawn+poll+merge step. When provided, the loop applies it
   * directly instead of `advanceTridentRun(run, deps)`. Exactly one of
   * `deps` / `step` must be set.
   */
  step?: TridentStepFn
  /** Default 90 s — matches the skill's ScheduleWakeup cadence. */
  tick_interval_ms?: number
  /** Per-tick max runs to advance. Default 50. */
  per_tick_limit?: number
}

export class TridentTickLoop {
  private readonly store: TridentRunStore
  private readonly step: TridentStepFn
  private readonly interval_ms: number
  private readonly per_tick_limit: number
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private skippedTicks = 0
  private advancedCount = 0

  constructor(options: TridentTickOptions) {
    this.store = options.store
    if (options.step !== undefined) {
      this.step = options.step
    } else if (options.deps !== undefined) {
      const deps = options.deps
      this.step = (run) => advanceTridentRun(run, deps)
    } else {
      throw new Error('TridentTickLoop: one of `deps` or `step` is required')
    }
    this.interval_ms = options.tick_interval_ms ?? 90_000
    this.per_tick_limit = options.per_tick_limit ?? 50
  }

  /** Start the loop. Idempotent — a second `start` is a no-op. */
  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.interval_ms)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Run one tick. Exposed for tests + for any caller that wants to drive
   * the loop manually rather than via setInterval. Returns the number of
   * runs that transitioned this tick.
   */
  async runOnce(): Promise<{ advanced: number; skipped_due_to_overlap: boolean }> {
    if (this.running) {
      this.skippedTicks++
      return { advanced: 0, skipped_due_to_overlap: true }
    }
    this.running = true
    let advanced = 0
    try {
      const runs = this.store.listNonTerminal(this.per_tick_limit)
      for (const run of runs) {
        try {
          const outcome = await this.step(run)
          if (outcome.changed) {
            await this.store.save(outcome.run)
            advanced++
          }
        } catch (err) {
          // A single run's failure to advance must not abort the tick —
          // mirror the reminder loop's per-row try/catch.
          console.error(`trident advance failed for run ${run.id} (${run.slug}):`, err)
        }
      }
      this.advancedCount += advanced
    } finally {
      this.running = false
    }
    return { advanced, skipped_due_to_overlap: false }
  }

  stats(): { advanced: number; skipped_ticks: number } {
    return { advanced: this.advancedCount, skipped_ticks: this.skippedTicks }
  }
}
