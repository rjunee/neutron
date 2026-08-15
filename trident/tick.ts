/**
 * @neutronai/trident — fire-time loop.
 *
 * Modelled on `reminders/tick.ts`: a `setInterval` that, each tick, loads
 * every non-terminal run via `TridentRunStore.listNonTerminal` and calls
 * `advanceTridentRun` for each. This replaces the legacy harness's out-of-process
 * ScheduleWakeup driver — where the legacy harness's `/trident check` re-entered the
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
 * Default interval is 90 s — matches the skill's ScheduleWakeup cadence. A
 * second, much cheaper internal loop ('trident-watch', 2 s) polls one
 * `changeSignature()` query and `wake()`s the sweep only when a run actually
 * advanced, so an out-of-process checkpoint is picked up in seconds; the 90 s
 * interval stays armed unchanged as the backstop.
 */

import { SupervisedLoop, type LoopDescriptor } from '@neutronai/loop'

import { advanceTridentRun, isTerminalPhase, type AdvanceDeps, type AdvanceOutcome } from './state-machine.ts'
import { changeSignatureEntries, type TridentRun, type TridentRunStore } from './store.ts'
import { STALLED_WARN_MS } from './run-progress.ts'
import { createLogger } from '@neutronai/logger'

const log = createLogger('trident-tick')

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

/**
 * Did anything move between two `changeSignature()` samples that the sweep did NOT
 * write itself?
 *
 * `own` is the sweep's own ledger: run id → the `last_advanced_at` its commit left
 * on that row (or `null` when the row could not be re-read). A difference is the
 * sweep's own iff the run is in that ledger AND the row still carries exactly the
 * stamp the sweep wrote — a run re-stamped AGAIN after the sweep committed it is an
 * out-of-process writer, not us, and must still wake the next sweep.
 *
 * Both directions are checked: a row that appeared or was re-stamped (`after`), and
 * a row that LEFT the active set (`swept`) — a terminal transition someone else won
 * is change the rail needs a sweep for. Removals of rows the sweep itself committed
 * are ours (that is what a terminal transition by this sweep looks like).
 *
 * THE RESIDUALS, stated so they are not rediscovered. Both are bounded by the 90 s
 * backstop and both need a monotonic row version to close, which the schema does not
 * have:
 *
 *   1. an external write that lands on a run this sweep committed, inside the SAME
 *      MILLISECOND as the sweep's own write, leaves the identical stamp and reads as
 *      ours. That is the column's resolution, not the rule — and a strictly smaller
 *      window than the one this replaced (which absorbed EVERY external write, on any
 *      run, for the whole duration of an advancing sweep — seconds of git/gh work);
 *   2. a run the sweep wrote that ALSO left the active set is assumed to have left on
 *      the sweep's own terminal transition (the `!own.has(id)` in the removal loop).
 *      An out-of-process force-terminate that races a sweep-advanced run therefore
 *      does not wake the next sweep. Same class and same bound as (1): the only
 *      evidence that would separate the two is a version the row does not carry.
 */
function changedOutsideSweepWrites(
  sweptSig: string,
  afterSig: string,
  own: Map<string, string | null>,
): boolean {
  if (sweptSig === afterSig) return false
  const before = changeSignatureEntries(sweptSig)
  const after = changeSignatureEntries(afterSig)
  for (const [id, at] of after) {
    if (own.has(id)) {
      if (own.get(id) !== at) return true
      continue
    }
    if (before.get(id) !== at) return true
  }
  for (const id of before.keys()) {
    if (!after.has(id) && !own.has(id)) return true
  }
  return false
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
  /**
   * Wake-on-change watcher cadence (Part 2 of the wall-clock card). Every
   * `watch_interval_ms` the loop runs ONE cheap store query
   * (`changeSignature()`) and fires `wake()` on the main loop ONLY when the
   * signature differs from the last observation — so an out-of-process
   * checkpoint (checkpoint.sh stamping `last_advanced_at`) triggers a full
   * tick within seconds instead of waiting out the 90 s interval. The 90 s
   * interval stays armed unchanged as the backstop: if the watcher fails or
   * is disabled, behaviour is exactly today's. `<= 0` — or any non-finite
   * value — disables the watcher. Default 2_000.
   */
  watch_interval_ms?: number
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
  /** null when disabled (`watch_interval_ms <= 0`). */
  private readonly watchLoop: SupervisedLoop | null
  /** Last observed change signature; null = nothing observed yet (first observation records, never wakes). */
  private lastChangeSig: string | null = null
  /**
   * A SWEEP IS STILL OWED for change already folded into `lastChangeSig`.
   *
   * The watcher records what it sampled the moment it wakes, so the wake and the
   * baseline move together — which is right when the sweep then runs, and wrong when
   * that sweep dies on its row read (locked DB, closed handle): the change is marked
   * observed, nothing observed it, and the handoff waits out the 90 s backstop
   * (Argus r3). This flag remembers the debt, so the next cadence re-fires even
   * though the signature has not moved again. Cleared by the first sweep that
   * actually reads its rows.
   */
  private sweepOwed = false
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
    const watchIntervalMs = options.watch_interval_ms ?? 2_000
    // `Number.isFinite` FIRST, because `NaN <= 0` is false: a NaN cadence would slip
    // past a bare `<= 0` disable check and `setInterval(fn, NaN)` clamps to ~1 ms —
    // a ~500 Hz signature query where the caller asked for "no watcher".
    this.watchLoop =
      !Number.isFinite(watchIntervalMs) || watchIntervalMs <= 0
        ? null
        : new SupervisedLoop({
            name: 'trident-watch',
            intervalMs: watchIntervalMs,
            tick: async () => this.watchBody(),
            onError: (name, err) => {
              log.error('watch_failed', {
                loop: name,
                error: err instanceof Error ? (err.stack ?? err.message) : String(err),
              })
            },
          })
  }

  /** Start the loop. Idempotent — a second `start` is a no-op. */
  start(): void {
    this.loop.start()
    this.watchLoop?.start()
  }

  /**
   * Fire one full tick now instead of waiting out the 90 s interval — the
   * wake-on-change accelerator (the interval stays armed as the backstop).
   * Delegates to {@link SupervisedLoop.wake}: not-lost when a tick is in
   * flight, and a no-op unless the loop is started.
   *
   * WHICH GUARANTEE ACTUALLY CARRIES THE MID-FLIGHT CASE HERE (Argus r3). `wake()`'s
   * own `pendingWake` re-fire is what a caller waking DURING a sweep relies on — but
   * this class's only production caller is {@link watchBody}, which returns early
   * while a tick is running and therefore (outside a narrow interval race) never
   * wakes mid-flight at all. What keeps an out-of-process checkpoint that lands
   * mid-sweep from being lost is {@link settleChangeBaseline}: it refuses to adopt a
   * post-sweep sample containing change the sweep did not write, so the difference is
   * still there on the next 2 s cadence. `pendingWake` remains correct and covered
   * (`loop/index.test.ts`) for any other caller — belt to that braces.
   */
  wake(): void {
    this.loop.wake()
  }

  /** §F2 — live LoopRegistry descriptor (name `trident`, cadence
   *  `tick_interval_ms`). Call after `start()`. */
  describe(): LoopDescriptor {
    return this.loop.describe()
  }

  /**
   * §F2 — EVERY timer this object owns, for the LoopRegistry inventory.
   *
   * `describe()` returns only the 90 s sweep, which is what the composer used to
   * register — so the 2 s 'trident-watch' loop was a live, self-restarting timer
   * that the loop inventory could not see at all. A persistently failing watcher
   * then showed up only as `watch_failed` log lines while the inventory reported
   * one healthy loop: the accelerator can be dead for hours and every handoff back
   * on the 90 s path, with nothing in the inventory saying so. Both descriptors are
   * LIVE (the `SupervisedLoop` getters read current state), so registering them
   * before `start()` is still correct. Single-loop callers keep `describe()`.
   */
  describeAll(): LoopDescriptor[] {
    if (this.watchLoop === null) return [this.loop.describe()]
    return [this.loop.describe(), this.watchLoop.describe()]
  }

  /** Stop + quiesce: awaits the in-flight tick so the composer can
   *  `await loop.stop()` (then `drain()`) before `db.close()`. */
  async stop(): Promise<void> {
    if (this.watchLoop !== null) await this.watchLoop.stop()
    await this.loop.stop()
    // DROP THE OBSERVED SIGNATURE WITH THE TIMERS. It is a comparison against a
    // moment that ended at shutdown: a `stop()` → `start()` re-arm that kept it
    // would compare the new process's first sample against pre-shutdown state and
    // fire a wake for change some other lifetime already swept. Null re-arms the
    // "first observation records, never wakes" rule, which is the right boot
    // behaviour — the interval's own first pass covers whatever moved meanwhile.
    this.lastChangeSig = null
    // …and the debt dies with it, for the same reason: a re-armed loop's first
    // interval pass sweeps whatever the failed tick never read.
    this.sweepOwed = false
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
   * The change-watcher tick: ONE store query, compare, maybe wake. It never
   * calls `step`, never touches git/gh/network — it is a cheap detector
   * gating the expensive sweep, not a faster sweep. The FIRST observation
   * only records the signature (no wake): waking on boot would duplicate the
   * interval's own first pass for no information. A throw (locked DB, closed
   * handle) is contained by the watcher SupervisedLoop's guardedFire and
   * routed to `watch_failed`; the 90 s backstop is untouched either way.
   */
  private async watchBody(): Promise<void> {
    // A SAMPLE TAKEN MID-SWEEP MEANS NOTHING, so do not take one.
    //
    // The sweep's own `saveIfActive` re-stamps `last_advanced_at` on every run it
    // advances, so a mid-sweep sample is a half-applied mixture of the tick's own
    // writes and whatever else arrived — and `settleChangeBaseline` overwrites the
    // baseline at the tick's tail anyway. Skipping here costs nothing: the settle
    // records EXACTLY the rows the sweep wrote, so an out-of-process checkpoint
    // that landed while the sweep was blind is still a difference on the very next
    // cadence (see `changedOutsideSweepWrites`). The baseline is only ever moved at
    // a point where it means something: here (no tick running) or at the settled
    // end of `tickBody`.
    if (this.loop.stats().running) return
    const sig = this.store.changeSignature()
    // A DEBT IS AS GOOD A REASON TO WAKE AS A DIFFERENCE. Recording `sig` below is
    // what consumes the change, so a sweep that died before reading a single row
    // (`sweepOwed`) must re-fire on an UNCHANGED signature — otherwise the wake is
    // spent on a tick that saw nothing and the handoff waits for the 90 s backstop.
    if ((this.lastChangeSig !== null && sig !== this.lastChangeSig) || this.sweepOwed) {
      this.loop.wake()
    }
    this.lastChangeSig = sig
  }

  /**
   * Adopt the signature a SETTLED tick leaves behind, so the tick's own writes are
   * never mistaken for change the tick has not yet seen — and, just as important,
   * so change that is NOT the tick's own writes survives the settle. Called from the
   * tail of every tick body that GOT ITS ROW LIST — interval-fired, wake-fired, or
   * manually driven; a sweep that threw before reading anything settles nothing (see
   * `sweepOwed`). Never allowed to fail a tick either: a throwing `changeSignature()`
   * (closed handle, locked DB) leaves the baseline where it was, which at worst costs
   * one extra sweep, and is routed to the 90 s backstop like any other watcher
   * outage.
   *
   * `sweptSig` is the signature sampled BEFORE the sweep read its rows; `own` is
   * every row the sweep COMMITTED, mapped to the `last_advanced_at` its own write
   * left behind. The rule is per-run, not aggregate:
   *
   *   • the sweep wrote nothing → `sweptSig` is still the truth, keep it;
   *   • every difference between `sweptSig` and the post-sweep sample is explained
   *     by `own` → adopt the post-sweep sample (the tick has seen all of it, so no
   *     wake is owed);
   *   • ANY difference outside `own` — a run the sweep never wrote carrying a new
   *     stamp (the out-of-process checkpoint), a run that appeared, a run that left
   *     the set on someone else's write, or a run the sweep wrote that was
   *     re-stamped again afterwards — → keep `sweptSig`, so the very next watcher
   *     cadence sees the difference and wakes the sweep.
   *
   * THE MIDDLE CASE IS THE ARGUS r2 FINDING. The previous version re-sampled the
   * aggregate whenever the tick had written anything, which absorbed every external
   * checkpoint that landed after `sweptSig` — precisely the handoff this card
   * exists to accelerate, sent back to the 90 s backstop under exactly the
   * multi-lane workload it targets.
   */
  private settleChangeBaseline(sweptSig: string | null, own: Map<string, string | null>): void {
    if (this.watchLoop === null) return
    try {
      if (own.size === 0) {
        // An unreadable signature is not a baseline — never overwrite a good one with
        // `null`, which would silently re-arm the "first observation never wakes" rule.
        if (sweptSig !== null) this.lastChangeSig = sweptSig
        return
      }
      // Nothing to compare against: leave the baseline alone rather than adopt a
      // sample whose provenance we cannot check.
      if (sweptSig === null) return
      const after = this.store.changeSignature()
      this.lastChangeSig = changedOutsideSweepWrites(sweptSig, after, own) ? sweptSig : after
    } catch {
      /* a signature we cannot read is not a baseline; the backstop still ticks */
    }
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
    // The change signature AS OF THIS SWEEP'S OWN OBSERVATION POINT — sampled here,
    // before a single row is read, and handed to `settleChangeBaseline` at the tail.
    // Its only job is to keep the watcher's baseline honest across a tick (see
    // `watchBody`). Read defensively: the watcher is an accelerator and must never
    // be the reason a tick fails.
    let sweptSig: string | null = null
    if (this.watchLoop !== null) {
      try {
        sweptSig = this.store.changeSignature()
      } catch {
        sweptSig = null
      }
    }
    // THE SWEEP'S OWN LEDGER: every row this tick committed → the stamp its write
    // left there. `settleChangeBaseline` subtracts exactly these from the post-sweep
    // sample, so the tick absorbs its own writes and NOTHING else. Populated only
    // when the watcher exists (it is the only reader) and only from rows that
    // actually committed.
    const ownWrites = new Map<string, string | null>()
    // DID THIS SWEEP ACTUALLY READ THE ROWS? Only a sweep that got its row list may
    // move the watcher's baseline (Argus r3). `listNonTerminal` is the one statement
    // outside the per-run try/catch, so a throw here means the tick saw NOTHING —
    // and settling `sweptSig` in that case would adopt the very change the wake was
    // fired for, silently: `sweptSig` is sampled AFTER that change landed, so the
    // watcher's next sample matches it and the wake is lost until the 90 s backstop.
    // Leaving the baseline untouched instead keeps the difference visible, so the
    // next watcher cadence re-fires the tick. Each failed attempt is cheap (it dies
    // on the same failing read, before any git/gh work) and the retry stops the
    // moment the read succeeds.
    let swept = false
    // Scoped block: the body below is lifted verbatim from the old `runOnce`
    // (its `try` block); the brace keeps it byte-identical for review. The
    // `finally` is the only addition — it settles the watcher's baseline for every
    // sweep that read its rows, whether the rest of the body completed or threw, so
    // a failed tick cannot leave the detector comparing against a signature nothing
    // will ever match again.
    try {
      const runs = this.store.listNonTerminal(this.per_tick_limit)
      swept = true
      for (const run of runs) {
        try {
          const outcome = await this.step(run)
          if (outcome.changed) {
            // CONDITIONAL commit (§F6a race guard): while `step` was in flight an
            // out-of-band `terminate()` (board X-cancel/delete) may have won the
            // terminal transition and fired its observers. Terminal is a SINK
            // state — if this run is no longer active we must NOT overwrite that
            // result nor fire our own terminal delivery (a double-notify). Drop
            // the live-progress signature and move on; the winner already handled
            // save + observers.
            const committed = await this.store.saveIfActive(outcome.run)
            if (!committed) {
              this.lastSig.delete(run.id)
              continue
            }
            advanced++
            // Record the stamp OUR write left, read back from the row (`saveIfActive`
            // stamps the store's clock, so the in-memory `outcome.run` does not carry
            // it). Only the watcher reads this, so it costs nothing when disabled; a
            // row we cannot re-read records `null`, which no real stamp equals — the
            // conservative direction (one extra sweep, never a lost wake).
            if (this.watchLoop !== null) {
              ownWrites.set(run.id, this.store.get(run.id)?.last_advanced_at ?? null)
            }
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
            // Fan the COMMITTED row, not the in-flight `outcome.run`. Between our
            // `saveIfActive` and this fan, an out-of-band `terminate()` (board
            // DELETE) can atomically flip the row terminal + fan it; fanning our
            // stale non-terminal snapshot would then RESTORE the just-cancelled run
            // in `live_runs` (Codex r9). Reloading makes the fan reflect the current
            // persisted state — terminal if a cancel won — so it converges with the
            // terminator's fan instead of fighting it. Falls back to `outcome.run`
            // only if the row vanished (a hard delete), where there's nothing to fan.
            const nextRun = this.store.get(run.id) ?? outcome.run
            const sig = progressSignature(nextRun, this.now())
            if (this.lastSig.get(nextRun.id) !== sig) {
              this.lastSig.set(nextRun.id, sig)
              try {
                await this.on_transition.onTransition(nextRun)
                this.transitionCount++
              } catch (err) {
                log.error('transition_fan_failed', {
                  run: run.id,
                  slug: run.slug,
                  error: err instanceof Error ? (err.stack ?? err.message) : String(err),
                })
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
                log.error('terminal_delivery_failed', {
                  run: run.id,
                  slug: run.slug,
                  error: err instanceof Error ? (err.stack ?? err.message) : String(err),
                })
              }
            }
          }
        } catch (err) {
          // A single run's failure to advance must not abort the tick —
          // mirror the reminder loop's per-row try/catch.
          log.error('advance_failed', {
            run: run.id,
            slug: run.slug,
            error: err instanceof Error ? (err.stack ?? err.message) : String(err),
          })
        }
      }
      this.advancedCount += advanced
    } finally {
      // A sweep that read its rows settles the baseline and clears the debt; one that
      // did not leaves the baseline alone and OWES the watcher a re-fire.
      if (swept) this.settleChangeBaseline(sweptSig, ownWrites)
      this.sweepOwed = !swept
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
