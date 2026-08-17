/**
 * @neutronai/gateway/proactive — WHICH work the wakeup tick may act on.
 *
 * This was an inline closure in `open/composer.ts` (`listOutstanding`). It is a
 * module because it encodes a policy with two opposing failure modes and no test
 * could reach it where it lived.
 *
 * THE POLICY. Every `in_progress` Work Board item is eligible EXCEPT one bound to
 * a trident run that is genuinely driving it — the trident tick is already that
 * item's wakeup driver, and waking it here too would double-drive one piece of
 * work from two schedulers. `runDrivingVerdict` (`trident/run-driving.ts`) answers
 * "genuinely driving": a terminal phase and an unusable `last_advanced_at` are
 * decided from the ROW, and everything else falls to a no-advance timer pitched
 * DELIBERATELY ABOVE the reaper's own threshold (`WAKEUP_STAND_DOWN_MS`) so the
 * reaper always answers first for any run it can reach. `phase` alone is never the
 * answer; that was the bug.
 *
 * WHY THE OLD `!isTerminalPhase(run.phase)` TEST WAS THE BUG, measured on the
 * owner's instance the night the wakeup shipped: three `in_progress` items were
 * each bound to a run parked at `forge-init`, non-terminal and not moving. The
 * wakeup deferred to all three, so after ONE firing it had nothing left to do and
 * autonomous progress stopped — silently, because a skip wrote no line anywhere.
 *
 * AND THE PEER COULD NOT RESCUE THEM, which is why the fix belongs on this side.
 * Both trident reap paths — the 90-min hang watchdog and the 2-h inflight ceiling
 * — sit inside `if (run.subagent_run_id !== null || run.subagent_status ===
 * 'crashed')` (`orchestrator.ts:2470`, `:2570`, `:2614`). A run that never
 * obtained a dispatch id is reachable by neither, and a reaper fix would in any
 * case run on the very loop whose stall this is compensating for. A backstop must
 * not depend on the liveness of the thing it backs up. Those unreachable runs are
 * exactly what the timer above the reaper's threshold is left deciding.
 *
 * THE SKIP IS REPORTED, NOT SWALLOWED. Deferred items are returned on the project
 * entry (`WakeupProjectWork.deferred`) so `runWorkWakeupSweep` can log one line
 * per deferral naming the run and its phase. A project with ONLY deferred items
 * still yields an entry for exactly that reason — the sweep skips it for work and
 * still says why. The owner's complaint was "I can't tell if it's actually
 * autonomously progressing work"; a silent skip is the reason he could not.
 */

import { runDrivingVerdict } from '@neutronai/trident/run-driving.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'
import { workBoardProjectIdForKey, type WorkBoardItem } from '@neutronai/work-board/store.ts'

import type { WakeupProjectWork } from './work-wakeup.ts'

export interface WakeupSelectionInput {
  /** The board's non-done items (`WorkBoardStore.listAllActive()`). */
  items: readonly WorkBoardItem[]
  /** `TridentRunStore.get` — a vanished row reads as null (the item is eligible). */
  lookupRun(run_id: string): TridentRun | null | undefined
  /** The instance owner's slug — General's board key (`workBoardProjectIdForKey`). */
  owner_slug: string
  now_ms: number
}

/**
 * Group the board's outstanding work by project, splitting each `in_progress`
 * item into WAKEABLE (`items`) or DEFERRED-TO-A-LIVE-RUN (`deferred`). Pure.
 */
export function selectWakeupWork(input: WakeupSelectionInput): WakeupProjectWork[] {
  const grouped = new Map<string, WakeupProjectWork>()
  const ensure = (key: string): WakeupProjectWork => {
    const existing = grouped.get(key)
    if (existing !== undefined) return existing
    const project_id = workBoardProjectIdForKey(input.owner_slug, key)
    const entry: WakeupProjectWork = {
      project_key: key,
      // The live-chat session scope: 'general' for the General board, the project
      // id verbatim otherwise (`turn.project_id ?? 'general'`,
      // `gateway/wiring/build-live-agent-turn.ts`).
      chat_scope: project_id ?? 'general',
      label: project_id === undefined ? 'your General workspace' : `project "${project_id}"`,
      items: [],
      deferred: [],
    }
    grouped.set(key, entry)
    return entry
  }

  for (const item of input.items) {
    if (item.status !== 'in_progress') continue
    const linked =
      item.linked_run_id === null ? null : input.lookupRun(item.linked_run_id) ?? null
    // SCOPE THE LOOKUP, exactly as `runProgressForItem` does
    // (`trident/run-progress.ts:219`): `TridentRunStore.get` is keyed on the
    // run id ALONE, so a stale or mis-copied `linked_run_id` naming another
    // project's run would be read as this item's driver — and if that unrelated
    // run keeps advancing, the item is suppressed for as long as it lives. A
    // foreign run drives nothing here, so it is ignored and the item stays
    // wakeable.
    const run = linked !== null && linked.project_slug === item.project_slug ? linked : null
    if (run !== null) {
      // No threshold override: the stand-down number is a SAFETY ORDERING, not a
      // tuning knob. `runDrivingVerdict` defaults to `WAKEUP_STAND_DOWN_MS`, which
      // is the reaper's `NO_ADVANCE_HANG_MS` plus a deliberate margin so the reaper
      // answers first for every run it can reach (`run-driving.ts` header). An
      // earlier cut exposed a `no_advance_hang_ms` seam here that no caller — test
      // or production — ever set, and whose docstring named the bare reaper
      // constant: the exact number a review had already refused as the threshold.
      // A parameter nothing exercises cannot be right; the ordering is pinned by a
      // test instead (`run-driving.test.ts`, "the stand-down threshold is STRICTLY
      // above the reaper, by more than a sweep").
      const verdict = runDrivingVerdict(run, input.now_ms)
      if (verdict.driving) {
        ensure(item.project_slug).deferred.push({
          title: item.title,
          item_id: item.id,
          run_id: run.id,
          phase: run.phase,
          since_advance_ms: verdict.since_advance_ms,
        })
        continue
      }
    }
    ensure(item.project_slug).items.push({ title: item.title })
  }
  return [...grouped.values()]
}
