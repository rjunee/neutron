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
 * and that identity is the design rather than a coincidence. It makes any
 * stand-down guard built on this a STRICT BACKSTOP: while the run is young enough
 * that the reaper still trusts it, this says `driving` and the caller stands down;
 * the moment it is old enough that the reaper would declare it hung, this says so
 * too. There is no window in which the two mechanisms disagree, so nothing new can
 * double-drive a healthy build. In the ordinary case the reaper wins the race
 * anyway — it flips the run terminal, and `terminal` is a stronger not-driving
 * answer than `no-advance`. This only bites where the reaper structurally cannot
 * act, which is exactly the case worth covering (see `work-wakeup-selection.ts`).
 *
 * AN UNPARSEABLE `last_advanced_at` COUNTS AS "JUST ADVANCED" (`since_advance_ms`
 * 0), matching `orchestrator.ts:2380-2388` and `run-progress.ts:140-141` — every
 * consumer of this column already reads a corrupt value that way, and disagreeing
 * here would mean the reaper and the backstop draw opposite conclusions from one
 * broken row. The verdict carries `since_advance_ms` so a caller can log the raw
 * reading instead of silently swallowing it.
 */

import { NO_ADVANCE_HANG_MS } from './liveness.ts'
import { isTerminalPhase } from './state-machine.ts'
import type { TridentRun } from './store.ts'

/** Why a run is (or is not) still its item's driver — one greppable token. */
export type RunDrivingReason =
  /** Non-terminal and it moved recently enough to still be trusted. */
  | 'advancing'
  /** `done`/`failed`/`stopped` — it is finished and drives nothing. */
  | 'terminal'
  /** Non-terminal, but `last_advanced_at` has not moved past the hang threshold. */
  | 'no-advance'

export interface RunDrivingVerdict {
  /** True while a peer scheduler should stand down in favour of this run. */
  driving: boolean
  reason: RunDrivingReason
  /** ms since `last_advanced_at` (0 when the stamp is unparseable — see above). */
  since_advance_ms: number
}

/**
 * Decide whether `run` is still driving the item it is bound to. Pure +
 * clock-injected, so every caller computes an identical verdict.
 */
export function runDrivingVerdict(
  run: TridentRun,
  now_ms: number,
  no_advance_hang_ms: number = NO_ADVANCE_HANG_MS,
): RunDrivingVerdict {
  const advancedMs = Date.parse(run.last_advanced_at)
  const since_advance_ms = Number.isFinite(advancedMs) ? Math.max(0, now_ms - advancedMs) : 0
  if (isTerminalPhase(run.phase)) return { driving: false, reason: 'terminal', since_advance_ms }
  if (since_advance_ms > no_advance_hang_ms) {
    return { driving: false, reason: 'no-advance', since_advance_ms }
  }
  return { driving: true, reason: 'advancing', since_advance_ms }
}
