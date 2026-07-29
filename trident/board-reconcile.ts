/**
 * @neutronai/trident — terminal board reconcile (Work Board Phase 2b).
 *
 * The flip side of `dispatchBoardBoundBuild`: when a board-bound trident run
 * reaches a terminal phase, reconcile its Plan item. This is wired as a
 * terminal OBSERVER on the durable `TridentTickLoop` (`build-core-modules`
 * composes it alongside delivery via `withTerminalObserver`), so it fires
 * exactly once per run as the loop transitions it terminal.
 *
 * Reconcile sets the lane from the outcome: a `done` run CLEARS the run binding
 * (the fork `⑂` icon goes dark) and COMPLETES the item (datestamped history); a
 * `failed`/`stopped` run marks the item FAILED and KEEPS its run binding (#340)
 * so the client shows the red dot + "Failed" tag + the run's `failure_reason`
 * one-liner and the ▶/↻ retry re-dispatches against the same card. Keyed off
 * `linked_run_id` via the store's `detachRun`, so it is idempotent and a NO-OP
 * for an unbound run.
 */

import type { TridentRun } from './store.ts'

/** The minimal store surface the reconcile needs (`WorkBoardStore.detachRun`). */
export interface TridentBoardReconciler {
  detachRun(project_slug: string, run_id: string, outcome: 'done' | 'failed'): Promise<unknown>
}

/**
 * Build the terminal observer that reconciles a terminal run's board item.
 * Returns null when no board store is wired (LLM-less / board-less boots), so
 * the caller can skip composing it.
 */
export function buildBoardReconcileObserver(
  board: TridentBoardReconciler | undefined,
): ((run: TridentRun) => Promise<void>) | null {
  if (board === undefined) return null
  return async (run: TridentRun): Promise<void> => {
    const outcome = run.phase === 'done' ? 'done' : 'failed'
    await board.detachRun(run.project_slug, run.id, outcome)
  }
}
