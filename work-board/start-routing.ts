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

/** The terminal outcome of a ▶-dispatched research (ATLAS) run — just the fields
 *  the board reconcile needs. Structural so it accepts an agent-dispatch
 *  `DispatchOutcome` without coupling this module to that package. */
export interface ResearchRunOutcome {
  status: string
  run_id: string
}

/** The board writes the research-terminal reconcile needs. Injected so the
 *  decision is unit-testable without a real store. */
export interface ResearchTerminalBoard {
  /** Success — datestamped done (pane auto-closes off `active`). */
  complete: (slug: string, item_id: string) => Promise<unknown>
  /** Non-success — clear the (agent-dispatch) link + mark failed so the failure
   *  surfaces and ▶ retries, instead of stranding the card in_progress. */
  failUnlinkedRun: (slug: string, item_id: string, run_id: string) => Promise<void>
}

/**
 * #379 BLOCKER — apply a ▶-research run's TERMINAL outcome to its Work Board
 * card. The ONE decision point (mirrors {@link routeBoardStart}) so both the
 * success AND the crashed/cancelled/timed-out paths are unit-tested, not just
 * proven by inspection in the composer closure:
 *
 *   - `finished` → `complete` (done; the pane auto-closes once no work is active);
 *   - ANYTHING else (`crashed` / `cancelled` / timed-out) → `failUnlinkedRun`,
 *     because an agent-dispatch run has NO `run_progress` to derive a failed dot
 *     from and the still-set link would keep the card "running" forever. This is
 *     the exact asymmetry that stranded the card before #379.
 */
export async function applyResearchOutcome(
  board: ResearchTerminalBoard,
  slug: string,
  item_id: string,
  outcome: ResearchRunOutcome,
): Promise<void> {
  if (outcome.status === 'finished') {
    await board.complete(slug, item_id)
  } else {
    await board.failUnlinkedRun(slug, item_id, outcome.run_id)
  }
}
