/**
 * @neutronai/trident — "is this run still DRIVING its work item?"
 *
 * A run bound to a Work Board item (`work_board_items.linked_run_id`) is meant to
 * be that item's wakeup driver: the trident tick advances it, so a second
 * scheduler poking the same item would double-drive one piece of work. Every
 * consumer that wants to STAND DOWN in favour of a run needs an answer to one
 * question, and it is not the question `isTerminalPhase` answers.
 *
 * PHASE IS NOT PROGRESS. In the Phase-2a EXEC model the outer `phase` stays
 * `forge-init` for the WHOLE inner Forge→Argus→fix workflow — only a terminal
 * transition moves it (`run-progress.ts:11-13`, `orchestrator.ts:2392`). So
 * "non-terminal" is true of a run that is building hard AND of a run that stopped
 * moving hours ago, and a guard keyed on it defers to both. That is a guard that
 * fails CLOSED on a peer which is not doing its job.
 *
 * THE SIGNAL IS `last_advanced_at`, and it demonstrably holds what its name says:
 * `TridentRunStore.update` re-stamps it on every outer transition
 * (`TridentRunStore.update`, `trident/store.ts`) and `trident/checkpoint.sh:196` re-stamps it on every inner
 * workflow phase boundary. It is the same field the hang watchdog
 * (`orchestrator.ts` no-advance reap, ~:2659) and the board's stall display (`run-progress.ts:186`)
 * already key on.
 *
 * ── THE TIMER SITS ABOVE THE REAPER, AND THAT IS THE WHOLE SAFETY ARGUMENT ────
 *
 * The obvious threshold is the reaper's own `NO_ADVANCE_HANG_MS`, and the first
 * cut of this module used it. A review was right to refuse it: at exactly that
 * number a HEALTHY build whose Forge step legitimately runs long — `last_advanced_at`
 * is stale by construction during a phase (`liveness.ts:46-59`) — flips to "not
 * driving" while it is demonstrably working, and the wakeup double-drives it.
 * The timer cannot tell that case from a wedge, so it must not be the mechanism
 * that decides it.
 *
 * {@link WAKEUP_STAND_DOWN_MS} buys the reaper the first word. The reaper fires
 * at `NO_ADVANCE_HANG_MS` for every run it can reach — `subagent_run_id !== null`
 * (`orchestrator.ts` no-advance reap, ~:2659) — on a sweep whose nominal cadence is 90 s
 * (`tick.ts:344`). Standing down a further margin past that means that in the
 * ordinary case the run has already been flipped terminal by the time this timer
 * is consulted, so the answer comes from `terminal` — a FACT about the row —
 * rather than from a stale clock, and the timer is left deciding the runs the
 * reaper cannot reach. That is precisely the reported incident: runs parked at
 * `forge-init` carrying no dispatch id at all.
 *
 * WHAT THE MARGIN DOES NOT BUY, because an earlier draft of this comment claimed
 * it did and a cross-model review disproved it: it is NOT true that "the reaper
 * always answers first". 90 s is a cadence, not a bound on reap latency. The
 * sweep is single-flight (`loop/index.ts:258-262`) and steps runs sequentially
 * (`tick.ts:719-721`), so one run wedged inside `step` — an unsettled launch,
 * whose post-cancel drain is unbounded (`inner-loop.ts` post-cancel drain, ~:789-794) — stalls the
 * whole sweep, and a second run's reap check is never reached however long it
 * waits. In that state this timer CAN release a run that is genuinely building.
 *
 * Two things bound that residue, and neither is this constant. A live inner
 * workflow re-stamps `last_advanced_at` ITSELF, out of process and independent of
 * the tick (`checkpoint.sh:196`), so a working build stays "advancing" across a
 * wedged sweep as long as it reaches checkpoints at all. What remains is a build
 * that checkpoints less often than the threshold — the known mid-phase heartbeat
 * gap, ISSUES #534 — which is the same false positive the reaper already has.
 * This module narrows that window; it does not close it, and nothing here should
 * be read as mutual exclusion.
 *
 * ── WHY THERE IS NO `never-launched` FAST PATH ────────────────────────────────
 *
 * An earlier cut read null `subagent_run_id` + null `subagent_status` past
 * `DEFAULT_SETTLE_TIMEOUT_MS` as proof no workflow exists, to decide the incident's
 * runs in minutes rather than hours. IT RACED THE LAUNCH IT WAS TRYING TO OUTLIVE.
 * Those columns are written only AFTER the fire settles
 * (`orchestrator.ts` post-settle write, ~:2137), and while the settle TIMER is 3 min
 * (`liveness.ts:115`) the cancellation that timer triggers is unbounded — the fire
 * keeps draining `handle.events` after `cancel()` (`inner-loop.ts` post-cancel drain, ~:789-794). So a
 * launch still genuinely in flight presents exactly the null/null row the rule
 * read as "never launched", and the wakeup would invite a second dispatch onto a
 * run whose launch is live. No finite bound on that window exists to read off the
 * row, so the row cannot prove the negative and the rule is gone. Such a run now
 * falls to the same conservative timer as everything else — which means a launch
 * that stays unsettled past the stand-down threshold is itself eventually released.
 * That is a deliberate trade and not an oversight: a finite bound is wrong in one
 * direction or the other, and releasing after 100 minutes of a launch that never
 * settled is the direction whose failure is visible and recoverable.
 *
 * ── THE MID-PHASE HEARTBEAT NOW EXISTS, AND THIS MODULE READS IT ─────────────
 *
 * An earlier version of this header said the remaining gap needed "the real
 * mid-phase heartbeat tracked in ISSUES #534". That heartbeat shipped: the build
 * and review wrappers now stamp `codex-exec-alive` / `codex-review-alive` into
 * `code_trident_stage_events` every 5 minutes, and the hang watchdog stands down
 * on an event newer than its own threshold (`orchestrator.ts` section 1b-i).
 *
 * THAT MADE READING IT HERE MANDATORY, NOT OPTIONAL. The stand-down and this
 * timer key on the SAME work. Before the heartbeat, a reaper-reachable run that
 * stopped stamping was flipped `failed` at 90 min, so by the time this timer was
 * consulted at 100 min the answer came from `terminal` — a fact — and waking the
 * item was correct because nothing was running. With the heartbeat, a HEALTHY
 * long build is spared at 90 min and stays non-terminal; if this module still
 * decided it on `last_advanced_at` alone it would report `no-advance` from 100
 * min and the wakeup would drive an item whose build is alive and building — up
 * to four wakeup turns across the 100→120 min window, the exact double-drive
 * `work-wakeup-selection.ts` exists to prevent. The fix's stated trade ("up to 30
 * extra minutes before a wedge is reaped") silently bought that second window;
 * reading the same evidence source closes it.
 *
 * IT CANNOT BECOME A PERMANENT DEFERRAL. Two independent bounds, both self-
 * clearing and neither needing a human: the ticker is killed by the wrapper on
 * every exit path (three guards, pinned in `codex-build.test.ts`), and — even if
 * one leaked — the reprieve here is refused outright once `since_advance_ms`
 * passes `DEFAULT_MAX_INFLIGHT_MS`, mirroring the orchestrator's "the ceiling
 * outranks every reprieve" rule on the same clock. An endlessly-heartbeating
 * corpse is released by this module at 2 h whatever the ledger says.
 *
 * WHAT IS DELIBERATELY *NOT* READ HERE: the launcher liveness probe. It answers
 * about a launcher GENERATION that several runs can share (`tick.ts:561-563`), so
 * a long-lived shared REPL would answer 'alive' for a run that is doing nothing
 * and defer its item indefinitely. The stage ledger is per-RUN and stops on its
 * own; that is the difference that makes one safe to stand down on here and the
 * other not.
 *
 * ── WHAT THIS STILL DOES NOT SOLVE ───────────────────────────────────────────
 *
 * A run the reaper cannot reach, whose build is alive but which emits no stage
 * events at all (nothing has stamped since `wrapper-start`), is still decided by
 * the timer, late but still by a clock.
 */

import { DEFAULT_MAX_INFLIGHT_MS, NO_ADVANCE_HANG_MS } from './liveness.ts'
import { isTerminalPhase } from './state-machine.ts'
import type { TridentRun } from './store.ts'

/**
 * How far in the future a `last_advanced_at` may sit before it stops counting as
 * a reading at all. Writer and reader are the same host (`store.ts` `now()` and
 * `checkpoint.sh`'s `date`), so a genuine stamp is never ahead by more than
 * scheduling jitter; a minute is generous for jitter and far short of the
 * skew/corruption this is meant to catch.
 */
export const FUTURE_STAMP_TOLERANCE_MS = 60_000

/**
 * Margin by which a peer scheduler stands down PAST the reaper's own threshold
 * before it will trust a timer.
 *
 * 10 minutes is not tuned to how long a build takes — tuning to that estimate is
 * what killed a healthy build on 2026-08-11 (`liveness.ts:39-45`). It is sized
 * against the only thing that has to fit inside it: the reaper noticing. That
 * sweep runs every 90 s (`tick.ts:344`), so ten minutes is ~6 sweeps of slack for
 * a mechanism that needs one.
 */
export const WAKEUP_REAP_MARGIN_MS = 10 * 60_000

/**
 * The no-advance threshold a peer scheduler uses — deliberately and strictly
 * GREATER than the reaper's `NO_ADVANCE_HANG_MS`, so that the NO-ADVANCE reap
 * gets the first word on any run it can reach. See this module's header for why
 * that ordering is the safety property rather than a tuning preference.
 *
 * BE PRECISE ABOUT WHICH REAP THIS ORDERS AGAINST — it is the no-advance one and
 * only that one. There is a second, independent ceiling: `DEFAULT_MAX_INFLIGHT_MS`
 * (2h, `trident/liveness.ts`) bounds a run that is still advancing but has simply
 * gone on too long. That threshold is LARGER than this stand-down (2h vs 100m), so
 * for a run whose only applicable reap is the inflight ceiling the wakeup acts
 * FIRST, not second. That is not a defect and the margin below is not a fix for
 * it: the two reaps answer different questions ("has it stopped?" vs "has it run
 * too long?"), and a run that has stopped advancing is precisely the case this
 * stand-down defers on. Stating the invariant as an unqualified "the reaper always
 * answers first" is what makes it wrong — the ordering holds against
 * `NO_ADVANCE_HANG_MS`, and nothing here claims or needs more than that.
 */
export const WAKEUP_STAND_DOWN_MS = NO_ADVANCE_HANG_MS + WAKEUP_REAP_MARGIN_MS

/** Why a run is (or is not) still its item's driver — one greppable token. */
export type RunDrivingReason =
  /** Non-terminal and it moved recently enough to still be trusted. */
  | 'advancing'
  /**
   * `last_advanced_at` is stale (or unreadable), but a MID-PHASE stage event
   * landed inside the stand-down window — the same positive evidence the hang
   * watchdog spares the run on. Distinct from `advancing` on purpose: the two are
   * different observations and a log that conflates them cannot be audited.
   */
  | 'stage-alive'
  /** `done`/`failed`/`stopped` — it is finished and drives nothing. */
  | 'terminal'
  /** Non-terminal, and `last_advanced_at` has not moved past the stand-down threshold. */
  | 'no-advance'
  /** `last_advanced_at` is unparseable or in the future — no reading at all. */
  | 'unknown-advance'

export interface RunDrivingVerdict {
  /** True while a peer scheduler should stand down in favour of this run. */
  driving: boolean
  reason: RunDrivingReason
  /** ms since `last_advanced_at`; 0 when there is no usable reading. */
  since_advance_ms: number
}

/**
 * Decide whether `run` is still driving the item it is bound to. Pure +
 * clock-injected, so every caller computes an identical verdict.
 *
 * ORDER IS FROM MOST CERTAIN TO LEAST. `terminal` is a FACT about the row and is
 * asked first — which, given the threshold ordering above, is also the answer a
 * reaper-reachable run has by the time the timer would speak. `no-advance` is a
 * timer over a signal the liveness docs themselves call imperfect
 * (`liveness.ts:46-59`), so it is the weakest evidence here and it is asked last.
 */
export function runDrivingVerdict(
  run: TridentRun,
  now_ms: number,
  no_advance_hang_ms: number = WAKEUP_STAND_DOWN_MS,
  latest_stage_event_at: string | null = null,
): RunDrivingVerdict {
  const advancedMs = Date.parse(run.last_advanced_at)
  const delta = Number.isFinite(advancedMs) ? now_ms - advancedMs : null
  const since_advance_ms = delta === null ? 0 : Math.max(0, delta)

  if (isTerminalPhase(run.phase)) return { driving: false, reason: 'terminal', since_advance_ms }

  // POSITIVE MID-PHASE EVIDENCE, read the SAME way the hang watchdog reads it
  // (`orchestrator.ts` 1b-0/1b-i): an event NEWER than the threshold proves the run
  // advanced inside the window a bare `last_advanced_at` would call dead.
  //
  // ABSENCE IS NOT EVIDENCE — a null (not wired / no events) or an unparseable
  // stamp falls straight through to the timer below, byte-identical to the
  // behaviour before this source existed.
  //
  // AND THE CEILING OUTRANKS THE REPRIEVE, checked here for the same reason the
  // orchestrator checks it first: a ticker that somehow outlived its build would
  // otherwise defer its item forever, and this module is a BACKSTOP — a stand-down
  // it can never retract is worse than the double-drive it prevents.
  const stageMs = latest_stage_event_at === null ? NaN : Date.parse(latest_stage_event_at)
  if (
    Number.isFinite(stageMs) &&
    now_ms - stageMs <= no_advance_hang_ms &&
    now_ms - stageMs >= -FUTURE_STAMP_TOLERANCE_MS &&
    since_advance_ms <= DEFAULT_MAX_INFLIGHT_MS
  ) {
    return { driving: true, reason: 'stage-alive', since_advance_ms }
  }

  // NO READING IS NOT A GOOD READING. An unparseable stamp — or one from the
  // future, which is the same thing wearing a valid date — cannot show that this
  // run advanced, and the earlier version of this function called it `advancing`
  // to stay consistent with the reaper's own conservatism
  // (`elapsedSinceAdvance`, `orchestrator.ts` ~:2453-2459). That consistency was wrong, because the two
  // consumers fail in OPPOSITE directions: the reaper's caution protects work
  // from being killed, while the same caution here hides a work item from the
  // only autonomy mechanism, forever, and the reaper (reading the same 0) never
  // recovers it either. A guess that fails invisible is exactly the bug this
  // module exists to remove, so a missing reading now stands the run DOWN and the
  // item becomes wakeable.
  if (delta === null || delta < -FUTURE_STAMP_TOLERANCE_MS) {
    return { driving: false, reason: 'unknown-advance', since_advance_ms: 0 }
  }

  if (since_advance_ms > no_advance_hang_ms) {
    return { driving: false, reason: 'no-advance', since_advance_ms }
  }
  return { driving: true, reason: 'advancing', since_advance_ms }
}

/**
 * "Did this run FINISH?" — the Work Board completion guard's predicate, and
 * deliberately NOT {@link runDrivingVerdict}.
 *
 * IT LIVES NEXT TO THE VERDICT IT MUST DISAGREE WITH, on purpose. A round of this
 * change moved the completion guard onto `runDrivingVerdict` so that items the
 * wakeup newly takes could also be closed; a cross-model review refused it and was
 * right. The two questions fail in OPPOSITE directions. "Is anyone driving this?"
 * may be answered from a stale clock, because guessing wrong costs one duplicated
 * turn. "Did this work ship?" may not, because `complete()` writes the board row
 * and does not stop the build (`work-board/store.ts:598`), so guessing wrong
 * asserts a falsehood about the world. A quiet `last_advanced_at` is weak evidence
 * that nobody is driving and NO evidence that the build ended.
 *
 * It is a FACTORY over an injected lookup rather than a free function on a store,
 * because `work-board/` has no `trident` import in production code and must not
 * grow one — `WorkBoardStore` takes `isRunLive` as a dependency precisely to keep
 * that edge out. The factory is the seam, so the policy is shared by symbol while
 * the layering stays as it was.
 *
 * Sharing it by symbol is also the only way the pin is worth anything: the
 * completion tests previously rebuilt this closure inline, so they would have gone
 * on passing if production had been reverted to the wakeup's verdict — a test
 * asserting its own copy of the rule, which is no assertion at all.
 */
export function isRunLiveForCompletion(
  lookup: (run_id: string) => TridentRun | null | undefined,
): (run_id: string) => boolean {
  return (run_id: string): boolean => {
    const run = lookup(run_id)
    return run !== null && run !== undefined && !isTerminalPhase(run.phase)
  }
}
