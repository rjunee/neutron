/**
 * @neutronai/work-board — ▶ START / job-dispatch ROUTING by task type (#379).
 *
 * THE DEFECT this fixes
 * ---------------------
 * The ▶ play button (and the agent-native dispatch) stamped 'building' / a
 * Trident run on EVERY card, because the board's mental model was "a card is a
 * build". The locked SPEC decision (2026-07-20 "Work Board: 'trackable work' ≠
 * 'a Trident build run'") makes a card trackable work of EITHER kind, so the
 * dispatch must route BY WHAT THE WORK IS:
 *
 *   - 'research' → the background ATLAS specialist (agent-dispatch, kind
 *                  'research'); investigation / analysis / writing.
 *   - 'build'    → the autonomous Trident Forge→Argus→merge loop.
 *
 * This module is the ONE pure decision point + a tiny generic router so the
 * routing is unit-testable in isolation and the composer wires the two real
 * dispatchers into it (no branching logic duplicated at the call site).
 */

import type { WorkBoardTaskType } from './store.ts'

/** Which dispatcher a card's ▶ / job-dispatch routes to. */
export type StartDispatchTarget = 'atlas' | 'trident'

/**
 * The pure routing decision: a 'research' card goes to ATLAS, everything else
 * (incl. the 'build' default) goes to the Trident loop. Total over
 * {@link WorkBoardTaskType} so a new task kind is a compile error here.
 */
export function startDispatchTargetForTaskType(task_type: WorkBoardTaskType): StartDispatchTarget {
  return task_type === 'research' ? 'atlas' : 'trident'
}

/**
 * Route a card's ▶ start to the right dispatcher by its `task_type` and return
 * that dispatcher's result. The composer supplies the two real closures
 * (`research` → agent-dispatch ATLAS, `build` → `dispatchBoardBoundBuild`); the
 * branching lives HERE (tested once) instead of inline at the call site.
 */
export function routeBoardStart<T>(
  item: { task_type: WorkBoardTaskType },
  dispatchers: {
    research: () => Promise<T>
    build: () => Promise<T>
  },
): Promise<T> {
  return startDispatchTargetForTaskType(item.task_type) === 'atlas'
    ? dispatchers.research()
    : dispatchers.build()
}
