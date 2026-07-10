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

import { SupervisedLoop } from '@neutronai/loop'

import { advanceTridentRun, isTerminalPhase, type AdvanceDeps, type AdvanceOutcome } from './state-machine.ts'
import type { TridentRun, TridentRunStore } from './store.ts'
import { STALLED_WARN_MS } from './run-progress.ts'

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

/**
 * Async result delivery — the seam that posts a run's terminal result
 * back to its originating chat topic (gap-audit P0-1). Mirrors the
 * reminder loop's `on_fired` hook (`reminders/tick.ts`): a failure-safe,
 * fire-after-persist callback the loop invokes ONCE per run that
 * transitions into a terminal phase (`done` / `failed`).
 *
 * The loop never knows HOW a result is delivered — `onTerminal` owns the
 * channel posting. Production wires `buildTridentDelivery(...)`
 * (`trident/delivery.ts`), which reads the run's persisted
 * `chat_id`/`thread_id` and pushes a result message through the
 * `ChannelRouter`. Test/dev paths leave it unset → the loop runs
 * unchanged. The hook is GENERIC: any background-agent run that lands on
 * a terminal phase carrying a `chat_id`/`thread_id` delivers through the
 * same seam, not just `/code`.
 *
 * Why a transition-time hook and not an end-of-run special case: the loop
 * is the single writer that observes each `changed` transition and is the
 * only place that already loads every non-terminal run each tick. Firing
 * here means a result is delivered the instant a run reaches ANY terminal
 * state (done OR failed), restart-safe and without a second sweep.
 */
export interface TridentTerminalHook {
  /**
   * Fired AFTER the terminal-phase row is persisted, with the SAME
   * next-state run the loop just saved. Thrown errors are caught + logged
   * by the loop and never block the tick from advancing other runs (the
   * row is already committed, so a delivery outage cannot un-terminate a
   * finished build).
   */
  onTerminal(run: TridentRun): Promise<void>
}

/**
 * M1 UX REDESIGN — the LIVE-PROGRESS transition seam. Fired ONCE per tick for
 * each run whose observable progress changed since the loop last saw it — i.e.
 * the inner workflow re-stamped a checkpoint (`inner_checkpoint`/`last_advanced_at`
 * moved), the run launched, or it went terminal. This is what lets a bound Work
 * item + the project rail update the INSTANT a build crosses building → reviewing
 * → fixing → merging, instead of waiting on the client's 15 s poll fallback.
 *
 * Why the loop and not the inner workflow: the inner workflow runs DETACHED (a CC
 * Dynamic Workflow whose only reach into the process is a `sqlite3` Bash step), so
 * it can persist a checkpoint but cannot fan an app-ws frame. The tick loop is the
 * single in-process reader that re-loads every non-terminal row each tick, so it
 * OBSERVES the checkpoint advance and fans the frame on the workflow's behalf.
 *
 * The composer wires this to fan `work_board_changed` (the bound item) +
 * `projects_changed` (the rail's activity/live_runs). Failure-safe + best-effort:
 * a throw is caught + logged and never blocks the tick (the row is already
 * committed; a missed fan degrades to the poll fallback).
 */
export interface TridentTransitionHook {
  onTransition(run: TridentRun): Promise<void>
}

/**
 * A compact signature of a run's OBSERVABLE progress. Two ticks that yield the
 * same signature mean nothing the UI cares about advanced, so no fan is due.
 * `last_advanced_at` is the reliable single signal: `checkpoint()` re-stamps it
 * on every inner-workflow phase boundary, and the store re-stamps it on every
 * outer transition. `phase` is included so a terminal transition (which also
 * decrements the rail's live_runs) always fans.
 *
 * The `stalled` BOOLEAN is included (computed off the injected clock vs
 * `STALLED_WARN_MS`) so the ONE moment a live run ages past the display-stall
 * threshold flips the signature and fans a rail refresh — otherwise a hung build
 * would sit `working` forever, since no `last_advanced_at`/checkpoint field
 * changes while it stalls (Codex review [P2]). It flips at most ONCE per stall
 * (false→true), then stays stable, so it does NOT fan every tick; a later
 * checkpoint (which moves `last_advanced_at`) flips it back and fans again.
 * Continuous `elapsed_ms` is DELIBERATELY excluded — it would churn every tick.
 */
function progressSignature(run: TridentRun, nowMs: number): string {
  const advancedMs = Date.parse(run.last_advanced_at)
  const stalled =
    !isTerminalPhase(run.phase) &&
    Number.isFinite(advancedMs) &&
    nowMs - advancedMs > STALLED_WARN_MS
  return `${run.phase}|${run.inner_checkpoint ?? ''}|${run.round}|${run.pr ?? ''}|${run.last_advanced_at}|${stalled ? 'stalled' : ''}`
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
  /**
   * Async result delivery (gap-audit P0-1). When supplied, the loop calls
   * `on_terminal.onTerminal(run)` exactly once for each run that
   * transitions into a terminal phase this tick — AFTER the row is
   * persisted, in a dedicated try/catch so a delivery failure never
   * aborts the tick. Omitted in tests / Open dev that don't post results.
   */
  on_terminal?: TridentTerminalHook
  /**
   * M1 UX REDESIGN — live-progress fan (see {@link TridentTransitionHook}). When
   * supplied, the loop fires `on_transition.onTransition(run)` once per tick for
   * each run whose observable progress changed since the loop last saw it (a
   * checkpoint advance, a launch, or a terminal transition). Omitted in tests /
   * dev that don't fan live frames → the loop runs unchanged.
   */
  on_transition?: TridentTransitionHook
  /**
   * Injectable clock (ms) for the transition fan's stall detection. Defaults to
   * `Date.now`. Tests pass a fixed clock to exercise the stall-crossing fan
   * deterministically.
   */
  now?: () => number
}

export class TridentTickLoop {
  private readonly store: TridentRunStore
  private readonly step: TridentStepFn
  private readonly interval_ms: number
  private readonly per_tick_limit: number
  private readonly on_terminal: TridentTerminalHook | null
  private readonly on_transition: TridentTransitionHook | null
  private readonly now: () => number
  /** Last observed progress signature per run id — drives the transition fan. */
  private readonly lastSig = new Map<string, string>()
  /** Loop scaffolding — single-flight, per-tick catch-all, quiescing stop (§F1). */
  private readonly loop: SupervisedLoop
  private advancedCount = 0
  private deliveredCount = 0
  private transitionCount = 0

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
    this.on_terminal = options.on_terminal ?? null
    this.on_transition = options.on_transition ?? null
    this.now = options.now ?? (() => Date.now())
    this.loop = new SupervisedLoop({
      name: 'trident',
      intervalMs: this.interval_ms,
      tick: () => this.tickBody(),
    })
  }

  /** Start the loop. Idempotent — a second `start` is a no-op. */
  start(): void {
    this.loop.start()
  }

  /** Stop + quiesce: awaits the in-flight tick so the composer can
   *  `await loop.stop()` (then `drain()`) before `db.close()`. */
  async stop(): Promise<void> {
    await this.loop.stop()
  }

  /**
   * Run one tick. Exposed for tests + for any caller that wants to drive
   * the loop manually rather than via the interval. Returns the number of
   * runs that transitioned this tick. Single-flight (overlap → skipped) + the
   * per-tick catch-all now live in the {@link SupervisedLoop} driving
   * {@link tickBody}; the per-tick `advanced` count is recovered from
   * `advancedCount`'s delta (safe because single-flight guarantees only one
   * tick body runs at a time).
   */
  async runOnce(): Promise<{ advanced: number; skipped_due_to_overlap: boolean }> {
    const before = this.advancedCount
    const { skipped } = await this.loop.runOnce()
    if (skipped) return { advanced: 0, skipped_due_to_overlap: true }
    return { advanced: this.advancedCount - before, skipped_due_to_overlap: false }
  }

  /**
   * The domain tick body. Everything below — the `listNonTerminal`-only sweep,
   * the save-before-hook ordering (P0-1 exactly-once terminal delivery), the
   * transition fan, and the per-run try/catch — is UNCHANGED from the original
   * hand-rolled loop and must not move. Only the loop scaffolding (single-flight
   * guard, error catch-all, quiescing stop) was lifted into {@link SupervisedLoop}.
   */
  private async tickBody(): Promise<void> {
    let advanced = 0
    // Scoped block: the body below is lifted verbatim from the old `runOnce`
    // (its `try` block); the brace keeps it byte-identical for review.
    {
      const runs = this.store.listNonTerminal(this.per_tick_limit)
      for (const run of runs) {
        try {
          const outcome = await this.step(run)
          if (outcome.changed) {
            await this.store.save(outcome.run)
            advanced++
          }
          // M1 UX REDESIGN — live-progress fan. `outcome.run` always carries the
          // latest observable state: the transitioned row when the step changed
          // it, or the freshly-loaded row (with the inner workflow's newest
          // checkpoint) when the step is still waiting in-flight. Fan whenever
          // that signature differs from what we last saw for this run — a
          // checkpoint advance (building→reviewing→fixing→merging), a launch, OR a
          // terminal transition (which the rail needs to drop live_runs). Runs in
          // its own try/catch so a fan outage never aborts the tick.
          if (this.on_transition !== null) {
            const nextRun = outcome.run
            const sig = progressSignature(nextRun, this.now())
            if (this.lastSig.get(nextRun.id) !== sig) {
              this.lastSig.set(nextRun.id, sig)
              try {
                await this.on_transition.onTransition(nextRun)
                this.transitionCount++
              } catch (err) {
                console.error(
                  `trident transition fan failed for run ${run.id} (${run.slug}):`,
                  err,
                )
              }
              // A terminal run won't be returned by `listNonTerminal` again —
              // drop its signature so the map can't grow unbounded across runs.
              if (isTerminalPhase(nextRun.phase)) this.lastSig.delete(nextRun.id)
            }
          }
          if (outcome.changed) {
            // Async result delivery (gap-audit P0-1). `listNonTerminal`
            // only ever returns non-terminal rows, so a `changed` outcome
            // whose next phase is terminal is, by construction, a FRESH
            // terminal transition this tick — fire the delivery hook
            // exactly once. The hook runs in its own try/catch (below) so
            // a posting failure can't undo the save we just committed nor
            // stop the next run from advancing — same isolation the
            // reminder loop gives its `on_fired` push hook.
            if (this.on_terminal !== null && isTerminalPhase(outcome.run.phase)) {
              try {
                await this.on_terminal.onTerminal(outcome.run)
                this.deliveredCount++
              } catch (err) {
                console.error(
                  `trident terminal delivery failed for run ${run.id} (${run.slug}):`,
                  err,
                )
              }
            }
          }
        } catch (err) {
          // A single run's failure to advance must not abort the tick —
          // mirror the reminder loop's per-row try/catch.
          console.error(`trident advance failed for run ${run.id} (${run.slug}):`, err)
        }
      }
      this.advancedCount += advanced
    }
  }

  stats(): { advanced: number; skipped_ticks: number; delivered: number; transitions: number } {
    return {
      advanced: this.advancedCount,
      skipped_ticks: this.loop.stats().skipped,
      delivered: this.deliveredCount,
      transitions: this.transitionCount,
    }
  }
}
