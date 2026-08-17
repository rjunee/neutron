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
 * (`orchestrator.ts:2530`) and the board's stall display (`run-progress.ts:186`)
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
 * {@link WAKEUP_STAND_DOWN_MS} makes it not decide it. The reaper fires at
 * `NO_ADVANCE_HANG_MS` for every run it can reach — `subagent_run_id !== null`
 * (`orchestrator.ts:2530`) — on a sweep that runs every 90 s (`tick.ts:344`).
 * Standing down for a further margin past that means: by the time this timer is
 * even consulted, any run the reaper can reach has ALREADY been flipped terminal,
 * and this function answers `terminal` — a FACT about the row — instead of
 * guessing from a stale clock. The timer therefore only ever decides the runs the
 * reaper cannot reach, which is precisely the reported incident: runs parked at
 * `forge-init` carrying no dispatch id at all.
 *
 * The one world where the timer does decide a run with a dispatch id is a world
 * where the trident tick is not running — and in that world there is no second
 * driver to collide with, because the tick IS the other driver. Double-driving
 * requires a live peer; a live peer reaps first. That is why the margin, not a
 * cleverer signal, closes the hole.
 *
 * ── WHY THERE IS NO `never-launched` FAST PATH ────────────────────────────────
 *
 * An earlier cut read null `subagent_run_id` + null `subagent_status` past
 * `DEFAULT_SETTLE_TIMEOUT_MS` as proof no workflow exists, to decide the incident's
 * runs in minutes rather than hours. IT RACED THE LAUNCH IT WAS TRYING TO OUTLIVE.
 * Those columns are written only AFTER the fire settles
 * (`orchestrator.ts:2064-2073`), and while the settle TIMER is 3 min
 * (`liveness.ts:115`) the cancellation that timer triggers is unbounded — the fire
 * keeps draining `handle.events` after `cancel()` (`inner-loop.ts:772-786`). So a
 * launch still genuinely in flight presents exactly the null/null row the rule
 * read as "never launched", and the wakeup would invite a second dispatch onto a
 * run whose launch is live. No finite bound on that window exists to read off the
 * row, so the row cannot prove the negative and the rule is gone. Such a run now
 * falls to the same conservative timer as everything else.
 *
 * ── WHAT THIS STILL DOES NOT SOLVE ───────────────────────────────────────────
 *
 * A run the reaper cannot reach and whose build is nevertheless alive is decided
 * by the timer, late but still by a clock. Closing that needs the real mid-phase
 * heartbeat tracked in ISSUES #534 — the liveness probe (`tick.ts:113-125`) is
 * the right eventual signal because its answer is BINARY and no amount of slowness
 * can make it say "dead", but it is async, per-generation, and only defined for a
 * run that HAS a recorded generation, which the runs decided here do not.
 */

import { NO_ADVANCE_HANG_MS } from './liveness.ts'
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
 * GREATER than the reaper's `NO_ADVANCE_HANG_MS`, so the reaper always answers
 * first for every run it can reach. See this module's header for why that
 * ordering is the safety property rather than a tuning preference.
 */
export const WAKEUP_STAND_DOWN_MS = NO_ADVANCE_HANG_MS + WAKEUP_REAP_MARGIN_MS

/** Why a run is (or is not) still its item's driver — one greppable token. */
export type RunDrivingReason =
  /** Non-terminal and it moved recently enough to still be trusted. */
  | 'advancing'
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

  if (since_advance_ms > no_advance_hang_ms) {
    return { driving: false, reason: 'no-advance', since_advance_ms }
  }
  return { driving: true, reason: 'advancing', since_advance_ms }
}
