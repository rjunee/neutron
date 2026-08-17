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
 * transition moves it (`run-progress.ts:12-16`, `orchestrator.ts:2392`). So
 * "non-terminal" is true of a run that is building hard AND of a run that stopped
 * moving hours ago, and a guard keyed on it defers to both. That is a guard that
 * fails CLOSED on a peer which is not doing its job.
 *
 * THE SIGNAL IS `last_advanced_at`, and it demonstrably holds what its name says:
 * `TridentRunStore.update` re-stamps it on every outer transition
 * (`store.ts:650`) and `trident/checkpoint.sh:196` re-stamps it on every inner
 * workflow phase boundary. It is the same field the hang watchdog
 * (`orchestrator.ts:2529`) and the board's stall display (`run-progress.ts:186`)
 * already key on.
 *
 * THE THRESHOLD IS `NO_ADVANCE_HANG_MS`, DELIBERATELY THE REAPER'S OWN NUMBER,
 * and that identity is the design rather than a coincidence: the two mechanisms
 * never disagree about WHEN a run has stopped looking alive, so this adds no new
 * moment at which a build can be declared dead. Where the reaper applies, it
 * usually acts first and flips the run terminal — a stronger not-driving answer
 * than `no-advance` — so in practice this decides the runs the reaper cannot
 * reach (see `work-wakeup-selection.ts`).
 *
 * IT IS NOT MUTUAL EXCLUSION, and saying so would be the same over-claim this
 * module was written to correct. The reaper only applies to a run with a dispatch
 * id (`orchestrator.ts:2529`), reaping only writes a `failed` ROW and does not
 * terminate the detached workflow (`orchestrator.ts:1817`), and the two loops
 * tick independently. Agreement on the threshold is what this buys; atomicity is
 * not, and nothing here should be read as providing it.
 *
 * THE TIMER IS THE LAST QUESTION ASKED, NOT THE FIRST. `NO_ADVANCE_HANG_MS` is a
 * threshold over a signal whose own docblock says it does not measure liveness
 * (`liveness.ts:39-59`), so it is the weakest evidence available here and it only
 * decides the cases the stronger, non-timed answers leave open — a terminal
 * phase, a run with no recorded dispatch, and a `last_advanced_at` that is not a
 * reading at all. See {@link runDrivingVerdict} for each.
 *
 * WHAT THIS DOES NOT SOLVE, so nobody reads more into it than it earns: a HEALTHY
 * build whose Forge step legitimately runs past the hang threshold with no
 * checkpoint still becomes wakeable, because `last_advanced_at` cannot tell that
 * case apart from a wedge. That is the same false positive the reaper already
 * has, bounded by the same number, and closing it needs the real mid-phase
 * heartbeat tracked in ISSUES #534 — not a different constant. Reusing the
 * reaper's threshold at least guarantees the two never disagree about it.
 */

import { DEFAULT_SETTLE_TIMEOUT_MS, NO_ADVANCE_HANG_MS } from './liveness.ts'
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

/** Why a run is (or is not) still its item's driver — one greppable token. */
export type RunDrivingReason =
  /** Non-terminal and it moved recently enough to still be trusted. */
  | 'advancing'
  /** `done`/`failed`/`stopped` — it is finished and drives nothing. */
  | 'terminal'
  /** Non-terminal, but `last_advanced_at` has not moved past the hang threshold. */
  | 'no-advance'
  /** No dispatch was ever recorded for it, past the launch settle budget. */
  | 'never-launched'
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
 * ORDER MATTERS AND IS FROM MOST CERTAIN TO LEAST. `terminal` and
 * `never-launched` are FACTS about the row; `no-advance` is a timer, and a timer
 * over a signal this file's own liveness docs call imperfect
 * (`liveness.ts:39-59`) is the weakest evidence here. The strongest answers are
 * therefore asked first, which is also what keeps the timer off the common case.
 */
export function runDrivingVerdict(
  run: TridentRun,
  now_ms: number,
  no_advance_hang_ms: number = NO_ADVANCE_HANG_MS,
): RunDrivingVerdict {
  const advancedMs = Date.parse(run.last_advanced_at)
  const delta = Number.isFinite(advancedMs) ? now_ms - advancedMs : null
  const since_advance_ms = delta === null ? 0 : Math.max(0, delta)

  if (isTerminalPhase(run.phase)) return { driving: false, reason: 'terminal', since_advance_ms }

  // NO READING IS NOT A GOOD READING. An unparseable stamp — or one from the
  // future, which is the same thing wearing a valid date — cannot show that this
  // run advanced, and the earlier version of this function called it `advancing`
  // to stay consistent with the reaper's own conservatism
  // (`orchestrator.ts:2380-2388`). That consistency was wrong, because the two
  // consumers fail in OPPOSITE directions: the reaper's caution protects work
  // from being killed, while the same caution here hides a work item from the
  // only autonomy mechanism, forever, and the reaper (reading the same 0) never
  // recovers it either. A guess that fails invisible is exactly the bug this
  // module exists to remove, so a missing reading now stands the run DOWN and the
  // item becomes wakeable.
  if (delta === null || delta < -FUTURE_STAMP_TOLERANCE_MS) {
    return { driving: false, reason: 'unknown-advance', since_advance_ms: 0 }
  }

  // NEVER LAUNCHED IS A FACT, NOT A TIMEOUT. A clean fire writes
  // `subagent_run_id` AND `subagent_status:'running'` in one row update
  // (`orchestrator.ts:2064-2073`); a fire that does not settle fails the run
  // outright (`:2053-2062`). So a non-terminal run carrying NEITHER has no
  // recorded workflow, and there is nothing for a wakeup to collide with. The
  // only ambiguity is the launching turn itself, which the codebase already
  // bounds at `DEFAULT_SETTLE_TIMEOUT_MS` (`liveness.ts:108-115`) — past that
  // window with the columns still empty, no dispatch was ever recorded.
  //
  // `subagent_status === 'crashed'` is deliberately EXCLUDED even though it can
  // carry a null id: a crashed launcher does not imply a dead build — the build
  // runs detached and survives (`orchestrator.ts:2419-2426`) — so those keep the
  // conservative timer path below.
  if (
    run.subagent_run_id === null &&
    run.subagent_status === null &&
    since_advance_ms > DEFAULT_SETTLE_TIMEOUT_MS
  ) {
    return { driving: false, reason: 'never-launched', since_advance_ms }
  }

  if (since_advance_ms > no_advance_hang_ms) {
    return { driving: false, reason: 'no-advance', since_advance_ms }
  }
  return { driving: true, reason: 'advancing', since_advance_ms }
}
