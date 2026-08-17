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
 *
 * This is ALSO the only place the card's PR number can be made durable. The
 * terminal run is the last carrier of `run.pr`, and the `done` branch of
 * `detachRun` NULLs the binding that `run_progress` (and therefore the live PR
 * number) is derived from — so the reconcile hands `{pr, pr_url}` down to be
 * written in the same UPDATE as the terminal status. `pr_url` is composed from
 * the RUN'S OWN `repo_path` remote (`repo-web-url.ts`), never a hardcoded repo;
 * if it cannot be resolved the number still lands and the client renders it as
 * plain text.
 */

import { makeRepoWebUrlResolver } from './repo-web-url.ts'
import type { TridentRun } from './store.ts'

/** The minimal store surface the reconcile needs (`WorkBoardStore.detachRun`). */
export interface TridentBoardReconciler {
  detachRun(
    project_slug: string,
    run_id: string,
    outcome: 'done' | 'failed',
    pr_info?: { pr: number | null; pr_url: string | null },
  ): Promise<unknown>
}

export interface BoardReconcileObserverOptions {
  /** Injectable repo → GitHub web url resolver (tests supply a stub). Defaults
   *  to the process-wide cached `makeRepoWebUrlResolver()`. */
  resolveRepoWebUrl?: (repo_path: string) => Promise<string | null>
}

/** Process-wide default resolver, created on first use so a board-less boot (and
 *  every test that injects its own) never builds a shell-backed cache. */
let defaultResolver: ((repo_path: string) => Promise<string | null>) | null = null
function sharedResolver(): (repo_path: string) => Promise<string | null> {
  if (defaultResolver === null) defaultResolver = makeRepoWebUrlResolver()
  return defaultResolver
}

/**
 * Build the terminal observer that reconciles a terminal run's board item.
 * Returns null when no board store is wired (LLM-less / board-less boots), so
 * the caller can skip composing it.
 */
export function buildBoardReconcileObserver(
  board: TridentBoardReconciler | undefined,
  opts: BoardReconcileObserverOptions = {},
): ((run: TridentRun) => Promise<void>) | null {
  if (board === undefined) return null
  const resolve = opts.resolveRepoWebUrl ?? sharedResolver()
  return async (run: TridentRun): Promise<void> => {
    const outcome = run.phase === 'done' ? 'done' : 'failed'
    // `?? null` so a run row that predates the PR column (or a partial fixture)
    // is treated as PR-less rather than binding `undefined` into the UPDATE.
    const pr = run.pr ?? null
    let pr_url: string | null = null
    if (pr !== null) {
      // Best-effort ONLY: a slow/broken/non-GitHub remote must never keep the
      // board out of sync. Worst case the number lands without a link.
      try {
        const web = await resolve(run.repo_path)
        pr_url = web !== null ? `${web}/pull/${pr}` : null
      } catch {
        pr_url = null
      }
    }
    await board.detachRun(run.project_slug, run.id, outcome, { pr, pr_url })
  }
}
