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
 * "genuinely driving"; see that module for why the answer is `last_advanced_at`
 * against the reaper's own `NO_ADVANCE_HANG_MS` and not `phase` alone.
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
 * 'crashed')` (`orchestrator.ts:2427`, `:2529`, `:2573`). A run that never
 * obtained a dispatch id is reachable by neither, and a reaper fix would in any
 * case run on the very loop whose stall this is compensating for. A backstop must
 * not depend on the liveness of the thing it backs up.
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
  /** Test seam; production uses `NO_ADVANCE_HANG_MS` (see `run-driving.ts`). */
  no_advance_hang_ms?: number
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
    const run =
      item.linked_run_id === null ? null : input.lookupRun(item.linked_run_id) ?? null
    if (run !== null) {
      const verdict = runDrivingVerdict(run, input.now_ms, input.no_advance_hang_ms)
      if (verdict.driving) {
        ensure(item.project_slug).deferred.push({
          title: item.title,
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
