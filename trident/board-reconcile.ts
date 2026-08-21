/**
 * @neutronai/trident — terminal board reconcile (Work Board Phase 2b).
 *
 * The flip side of `dispatchBoardBoundBuild`: when a board-bound trident run
 * reaches a terminal phase, reconcile its Plan item. This is wired as a
 * terminal OBSERVER on the durable `TridentTickLoop` (`build-core-modules`
 * composes it alongside delivery via `withTerminalObserver`), so it fires
 * exactly once per run as the loop transitions it terminal.
 *
 * Reconcile sets the lane from the outcome and KEEPS the terminal run binding
 * on both: a `done` run completes the item (datestamped history) while retaining
 * any recovered alert, and a `failed`/`stopped` run marks the item FAILED so the
 * client shows the red dot + `failure_reason` and can retry. Moving a terminal
 * card back to an active lane clears the stale link. Reconcile is keyed off
 * `linked_run_id`, so it is idempotent and a NO-OP for an unbound run.
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
