/**
 * @neutronai/trident — terminal board reconcile (Work Board Phase 2b).
 *
 * The flip side of `dispatchBoardBoundBuild`: when a board-bound trident run
 * reaches a terminal phase, reconcile its Plan item. This is wired as a
 * terminal OBSERVER on the durable `TridentTickLoop` (`build-core-modules`
 * composes it alongside delivery via `withTerminalObserver`), so it fires
 * exactly once per run as the loop transitions it terminal.
 *
 * Reconcile sets the lane from the outcome and KEEPS the terminal run binding on
 * both: a `done` run completes the item (datestamped history) while retaining any
 * recovered alert, and a `failed`/`stopped` run marks the item FAILED so the client
 * shows the red dot + `failure_reason` and the retry re-dispatches against the same
 * card. Moving a terminal card back to an active lane clears the stale link.
 * Reconcile is keyed off `linked_run_id` via the store's `detachRun`, so it is
 * idempotent and a NO-OP for an unbound run.
 *
 * This is ALSO the only place the card's PR number can be made durable: the terminal
 * run is the last carrier of `run.pr`, so the reconcile hands `{pr, pr_url}` down to
 * be written in the same UPDATE as the terminal status. `pr_url` is composed from the
 * RUN'S OWN `repo_path` remote (`repo-web-url.ts`), never a hardcoded repo; if it
 * cannot be resolved the number still lands and the client renders it as plain text.
 *
 * REBASE NOTE — this branch justified the durable write by saying the `done` branch of
 * `detachRun` NULLs the binding that the live PR number is derived from. That premise
 * is STALE: main now keeps the binding on `done` too (`work-board/store.ts`, "keep the
 * terminal binding so completed history can still derive durable run evidence"). The
 * write is still worth having — a binding is a pointer to a row that ages out, while
 * `pr`/`pr_url` on the card are the fact itself — but it is no longer the only way the
 * number survives, and the docblock should not claim a mechanism that changed.
 */

import { deriveEscalationBlock } from './escalation-block.ts'
import { makeRepoWebUrlResolver } from './repo-web-url.ts'
import type { TridentRun } from './store.ts'

/**
 * The minimal store surface the reconcile needs (`WorkBoardStore.detachRun`).
 *
 * `detachRun` AND NOTHING ELSE, and that narrowness is a GUARANTEE, not an accident of
 * what happened to be needed. The RUN REPORTS; the ORCHESTRATOR DECIDES: a build must
 * never mutate the board beyond setting its OWN card's terminal lane. `reorder`,
 * `update`, `create` and `delete` are all absent from this interface, so the reconcile
 * — the only board writer any build can reach — CANNOT reach them, whatever a run's
 * escalation payload says. An autonomous run that could reorder the queue would
 * re-prioritise the owner's work with no judgement in between, and the escalation
 * payload is model-adjacent text: the one shape that must never become an instruction.
 */
export interface TridentBoardReconciler {
  detachRun(
    project_slug: string,
    run_id: string,
    outcome: 'done' | 'failed' | 'blocked',
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
    // BLOCKED IS NOT FAILED. A run that STOPPED ON PURPOSE — a reviewer proved the
    // plan wrong, the card needs work outside it, or the same finding survived a fix
    // round — lands on its own lane, so the card does not read as a broken build and
    // does not sit in `upcoming` looking startable for the next dispatch to pick up and
    // re-learn the same block.
    //
    // DERIVED THROUGH THE ONE DERIVER (`deriveEscalationBlock`), never by re-reading
    // `inner_result` here: its gate is what makes a stale result from an earlier
    // iteration unable to relabel this ending, and a second copy of that gate would
    // drift from the one the chat message is composed with — the card and the message
    // would then disagree about whether the owner is looking at something blocked or
    // something broken.
    //
    // THE LANE IS ALL IT DERIVES. Nothing about the escalation reaches a position, an
    // order or another card: the escalation names what is missing, and SEQUENCING is
    // the orchestrator's call to make and report.
    const outcome: 'done' | 'failed' | 'blocked' =
      run.phase === 'done' ? 'done' : deriveEscalationBlock(run) !== null ? 'blocked' : 'failed'
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
