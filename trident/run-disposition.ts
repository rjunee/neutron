/**
 * @neutronai/trident — what a TERMINAL run row actually says happened.
 *
 * The 30-day measurement behind this module: 97 of 160 `REQUEST_CHANGES` rows
 * carried NO findings, and 33 of those had already reached `forge-done` — the
 * build succeeded and was then recorded as a rejection, so the next dispatch of
 * the same card rebuilt it from scratch. The verdict-honesty half of that card
 * already landed (the store refuses a findings-free `REQUEST_CHANGES` write and
 * `REVIEW_NOT_RUN` is the no-review terminal). This module is the READING half:
 * a single pure classifier that says which of the three states a terminal row is
 * in, computed FROM THE EXISTING COLUMNS ALONE — no new column, no backfill, and
 * no rewriting of historical rows (they are the measurement evidence).
 *
 *   died-before-build      no review ran and this dispatch has NO BUILD IT MAY
 *                          RESUME — either nothing was built (checkpoint null,
 *                          `inner-error`, `awaiting-trailer`, …) or what was built
 *                          is deliberately not resumable. `task-built` is the
 *                          latter and is the honest majority of that bucket on the
 *                          live table: a task-sequence iteration builds ONE task and hands
 *                          back, so the next iteration must plan and build the NEXT
 *                          task — the workflow rebuilds it by design
 *                          (`resumeOnUnchangedHead` → `unknown-checkpoint`), and a
 *                          seed that promised review would be a lie about what
 *                          happens next. The bucket name says what this module
 *                          decides (no build to hand forward), not that the disk is
 *                          empty.
 *   built-never-reviewed   a COMMIT EXISTS and no verdict was ever recorded
 *                          against it (`forge-done`, `fix-round-N`,
 *                          `outer-published:*`). This is the salvageable state.
 *                          `fix-round-N` belongs here even though a review
 *                          rejected round N-1: the disposition is about the
 *                          commit the row now HOLDS, and the fix built on top of
 *                          that rejection has been judged by nobody. Handing it
 *                          to a review is the correct next step, which is exactly
 *                          what `resumeOnUnchangedHead` does with the name.
 *   reviewed-rejected      review ran and the host's terminal gate refused.
 *                          A panel approval can still meet an arithmetic STOP;
 *                          its own decision remains in the typed result and
 *                          canonical reviewer checkpoint, separately from this
 *                          final host disposition.
 *
 * That distinguishability is the point: a trustworthy count of REAL rejections is
 * `disposition === 'reviewed-rejected'`, and everything else stops being counted
 * as a review outcome it never was.
 *
 * THAT COUNT IS TRUSTWORTHY GOING FORWARD, NOT BACKWARD, and the difference is the
 * whole measurement above (Argus r4, minor, with an executed repro). This
 * classifier reads `inner_verdict` and does not second-guess it, because after the
 * write-site precondition landed a `REQUEST_CHANGES` cannot exist without findings —
 * the write refuses it and records `REVIEW_NOT_RUN` instead. The 97 rows that
 * PREDATE it still carry a bare `REQUEST_CHANGES`, so over the 30-day base this
 * function answers `reviewed-rejected` 160 times, not 63. For a count over
 * historical rows the authoritative statement is the first SQL in
 * this card's as-built record (§ run dispositions), which applies the findings predicate to
 * the stored column rather than trusting the verdict; this module is the reading
 * for rows the fixed write site produced.
 *
 * Leaf module on purpose — it imports nothing but the run type and the terminal
 * phase set, so the dispatch chokepoint, the delivery classifier and any query
 * tool can share ONE taxonomy instead of three prose-matching copies of it.
 */

import type { TridentRun } from './store.ts'
import { carriedTaskCap, isTaskCap, isTaskIteration } from './task-budget.ts'
import { TERMINAL_PHASES } from './state-machine.ts'
import { trimAsciiWs } from './ascii-trim.ts'
import { OUTER_PUBLISHED_CHECKPOINT } from './checkpoint-round.ts'

export type TerminalRunDisposition =
  | 'approved'
  | 'reviewed-rejected'
  | 'built-never-reviewed'
  | 'died-before-build'
  | 'not-terminal'

/**
 * The phases a run is FINISHED in; every other phase is still in flight.
 *
 * IMPORTED, not redeclared. `state-machine.ts` already exports this set and is
 * equally leaf (it imports nothing but the run types), so a private fourth copy
 * would buy nothing and cost the one thing that matters: a future fourth terminal
 * phase would leave this module silently answering `not-terminal` for rows every
 * other reader calls finished. `TERMINAL_PHASES` is an ARRAY there — `.includes`
 * over three elements is not worth a Set.
 */
const isTerminal = (phase: string): boolean =>
  (TERMINAL_PHASES as readonly string[]).includes(phase)

/**
 * Checkpoints that mean "a commit exists and NOTHING has judged it yet".
 *
 * EXPORTED BECAUSE THE WRITE SITE ENFORCES IT TOO (Argus r23, major). The
 * predicate used to be reachable only through `builtButNeverReviewedSeed`, i.e.
 * only in the CALLER, while `TridentRunStore.create` persisted any
 * `inner_checkpoint` string it was handed — so a seed row spelling
 * `argus-approved` would resume as an already-approved run and write a terminal
 * APPROVE with no review, from a column nothing checked. That is the exact shape
 * this card forbids ("do NOT put the check only in the caller"), so `create` now
 * refuses a seed this function declines. One predicate, both places.
 *
 * A SUBSET of the names `resumeOnUnchangedHead` (inner-workflow.mjs) routes to a
 * review on an unchanged head, and the subset is the point: that function also
 * routes `argus-request-changes[-round-N]` forward, but those names record that a
 * reviewer ALREADY SPOKE, so they are not "nothing has judged it yet" and this
 * module must not call them salvageable-because-unreviewed. Every name listed HERE
 * must still be one the workflow really will review, or a row this module calls
 * salvageable would seed a resume the workflow then rebuilds anyway — inclusion is
 * the load-bearing direction, not equality.
 *
 * This is the NAME half of that agreement and is deliberately mode-blind — a
 * commit exists under every one of these names whatever mode built it, which is
 * what the DISPOSITION states. The one place the workflow's answer depends on
 * more than the name is `forge-done` in execution_strategy mode, and that belongs to the
 * prediction rather than the taxonomy: `builtButNeverReviewedSeed` takes `execution_strategy`
 * and refuses there. Putting it here instead would make an offline COUNT of the
 * historical table depend on a flag no historical row's classification should
 * turn on.
 *
 * THE PUBLISHED SHAPE ITSELF IS IMPORTED, NOT SPELLED AGAIN (rebase onto the
 * one-copy rule). `checkpoint-round.ts` OWNS that pattern — its docblock calls
 * itself "THE ONE COPY" and `fire-evidence.ts` re-exports it rather than keeping a
 * second — and it is a leaf that imports only `ascii-trim.ts`, which this module
 * already imports, so taking it adds no dependency this file did not already have.
 * A private spelling would buy nothing and cost the one thing the owner's docblock
 * was written to prevent: two patterns for one name, drifting a digit at a time.
 * Group 1 is the OID there, which is the capture this module reads.
 */

/**
 * THE ROUND FIELD IS AT MOST NINE DIGITS, matching `checkpointRound`
 * (checkpoint-round.ts) and its bash mirror `round_for_checkpoint`
 * (checkpoint.sh) character for character — now by construction rather than by
 * agreement, since it is literally the same regex object. A copy that accepted a
 * wider domain than the parsers would classify `fix-round-<2^63>` as salvageable
 * and seed a resume whose round neither parser can read. Outside nine digits every
 * copy answers "not one of these shapes"; no real checkpoint is anywhere near the
 * bound, which is bounded by `max_rounds`.
 *
 * THE WORKFLOW'S OWN COPY IS WIDER, DELIBERATELY (Argus r5). `resumeOnUnchangedHead`
 * (inner-workflow.mjs) matches an UNBOUNDED round in both shapes, so a ten-digit name
 * is `died-before-build` here while the workflow would still route it to a review.
 * That is the SAFE direction and the one this docblock demands two paragraphs above:
 * inclusion here must imply the workflow reviews it, not the converse. The cost of the
 * divergence is at most one card rebuilt that could have been resumed, for a round
 * number no writer can produce; narrowing the workflow instead would put a THIRD
 * bound on the resume path with nothing to gain.
 */
export function reviewCapableCheckpoint(name: string): boolean {
  return name === 'forge-done' || /^fix-round-\d{1,9}$/.test(name) || OUTER_PUBLISHED_CHECKPOINT.test(name)
}

/**
 * THE TASK CONTINUATION CHECKPOINT — the one name a governed retry may be seeded
 * with that is NOT review-capable (spec item a-retry-must-resume-from-the-checkpoint,
 * gap 2). A Task iteration that built its task and handed back parks here with the
 * committed IMPLEMENTATION_PLAN.md as its plan. A retry seeded with it does not skip a
 * build and does not skip a review: it BUILDS the next task, but opens that iteration
 * with the cheap continuation planner (`build-run.ts`, G026) instead of re-deriving the
 * whole plan. Without the seed every retry of such a card paid the full planning survey.
 *
 * `task-built-deviated` is deliberately NOT this name: a deviated build left a
 * committed plan the code no longer matches, so its retry must re-plan in full.
 */
export const TASK_CONTINUATION_CHECKPOINT = 'task-built'

/**
 * May a NEW row be born carrying `name` as its seeded checkpoint? The taxonomy above is
 * unchanged — `task-built` still classifies `died-before-build`, because no review
 * ran and the offline disposition count must not move. This is the separate question of
 * what a dispatch may hand forward: a review-capable checkpoint on any row, or the Task
 * continuation checkpoint on a GOVERNED row only (a non-Task row has no loop to
 * continue, so the name would mean nothing there).
 */
export function seedableCheckpoint(name: string, execution_strategy: 'single' | 'task_sequence' | null): boolean {
  return reviewCapableCheckpoint(name) || (execution_strategy === 'task_sequence' && name === TASK_CONTINUATION_CHECKPOINT)
}

/**
 * TRIM THE ASCII WHITESPACE SET, NOT JAVASCRIPT'S. `String.prototype.trim` also
 * strips NBSP, the Unicode space separators and the BOM, and this function has TWO
 * mirrors that do not: the trim in `trident/checkpoint.sh` (which names the same
 * six characters explicitly — `[[:space:]]` was locale-dependent there), and
 * the `TRIM(col, ' '||CHAR(9)||CHAR(10)||CHAR(11)||CHAR(12)||CHAR(13))` in the
 * canonical disposition SQL published in this card's as-built record (executed against this
 * classifier, row for row, by `as-built-disposition-sql.test.ts`). Equivalence
 * "except for inputs nobody has written yet" is not equivalence; narrowing THIS
 * copy to the six ASCII whitespace characters all three can express makes the claim
 * total instead of corpus-bounded. No writer emits either kind of padding. The
 * implementation is the shared LINEAR two-pointer scan in `trident/ascii-trim.ts`
 * — the regex it replaced backtracked quadratically on a long interior whitespace
 * run (CodeQL js/polynomial-redos HIGH, Argus r7), over the same six characters.
 *
 * USED FOR THE SHA PINS TOO, not just the checkpoint name (Argus r8). Those were
 * `String.prototype.trim`, so this module named one trim contract in its own
 * docblock and then applied a different one three lines later. Behaviour is
 * unchanged — `/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/` rejects anything either trim would disagree
 * about — but a stated contract with an exception in it is how the next drift
 * starts.
 */
const trimCheckpoint = trimAsciiWs

/**
 * Classify a terminal run row. Pure, and column-only by design: the caller passes
 * the four columns rather than a live store, so the same rule serves a dispatch
 * decision and an offline count of the historical table.
 *
 * `inner_checkpoint_findings` is part of the shape because the taxonomy is stated
 * in terms of it, but a `REQUEST_CHANGES` row classifies as `reviewed-rejected`
 * WHETHER OR NOT it carries findings. Live rows cannot reach the findings-free
 * shape any more (the write site throws), so the only rows that can are the
 * pre-fix historical ones — and those are evidence of a rejection that was
 * recorded, however badly. Calling them anything else would let this module hand
 * a REJECTED card's branch to the resume seed, which is exactly the merge-the-
 * unreviewed hazard the card forbids.
 */
export function terminalRunDisposition(
  run: Pick<
    TridentRun,
    'phase' | 'inner_verdict' | 'inner_checkpoint' | 'inner_checkpoint_findings'
  >,
): TerminalRunDisposition {
  if (!isTerminal(run.phase)) return 'not-terminal'
  if (run.inner_verdict === 'APPROVE') return 'approved'
  if (run.inner_verdict === 'REQUEST_CHANGES') return 'reviewed-rejected'
  // `REVIEW_NOT_RUN` and the LEGACY null verdict are the same fact — no reviewer
  // ever spoke. Which of the two no-review states it is comes from the checkpoint.
  const name = typeof run.inner_checkpoint === 'string' ? trimCheckpoint(run.inner_checkpoint) : ''
  return reviewCapableCheckpoint(name) ? 'built-never-reviewed' : 'died-before-build'
}

/** A prior run donates its validated budget under either immutable strategy. */
export type CarriedTaskBudget =
  | { ok: true; budget: { task_iteration: number; max_task_iterations: number } | null }
  | { ok: false; column: 'task_iteration' | 'max_task_iterations'; value: unknown }

export function carriedTaskBudget(
  run: TridentRun,
  opts: { execution_strategy?: 'single' | 'task_sequence' | null; max_task_iterations?: number },
): CarriedTaskBudget {
  // Strategy cannot erase previously spent iterations.
  // THE PRIOR ROW MUST BE READABLE IN BOTH HALVES, AND ABSENCE IS NOT EXCUSED HERE.
  // Both columns are `INTEGER NOT NULL DEFAULT` (migrations 0068/0100), asserted rather
  // than assumed, so a persisted row has no legitimate unset state: anything this
  // predicate rejects is CORRUPT, not legacy. And an unreadable half cannot degrade to
  // "carry nothing" the way an unreadable DISPATCH cap can, because there is no
  // fallback that preserves a spend — carrying nothing restores the whole budget, which
  // is precisely defect four. `unknown` authorises nothing, so the dispatch refuses.
  if (!isTaskIteration(run.task_iteration)) {
    return { ok: false, column: 'task_iteration', value: run.task_iteration }
  }
  if (!isTaskCap(run.max_task_iterations)) {
    return { ok: false, column: 'max_task_iterations', value: run.max_task_iterations }
  }
  const cap = carriedTaskCap(run.max_task_iterations, opts.max_task_iterations)
  // Only reachable when the DISPATCH's cap is present-but-unreadable. That value then
  // reaches `create`, which refuses it BY NAME (`TridentInvalidTaskCapError`), so the
  // dispatch fails loudly rather than silently inheriting nothing — see `carriedTaskCap`.
  if (cap === null) return { ok: true, budget: null }
  return { ok: true, budget: { task_iteration: run.task_iteration, max_task_iterations: cap } }
}

/**
 * The evidence a built-but-never-reviewed terminal run can hand to the NEXT
 * dispatch of the same card, or null when there is nothing safe to hand over.
 *
 * Null for every disposition but `built-never-reviewed`, null when no 40- or 64-hex head
 * was recorded (without a head the resume classifier would rebuild anyway, and a
 * seeded checkpoint with no head would only strip the launcher's leftover-branch
 * guard off a run that still needs it), and null when the prior row carries no
 * 40- or 64-hex `base_sha` (a seeded row never re-pins one, so it would be born with the
 * publish-time cut-from-origin refusal permanently disarmed).
 *
 * For an `outer-published:<oid>:<remaining>:<round>` checkpoint (round LAST — the
 * publisher builds `outer-published:${head}:${remaining_tasks}:${round}`) the OID
 * EMBEDDED IN THE NAME is authoritative — the same precedence the orchestrator's
 * resume site and the workflow both apply — because the publish stamped the name
 * against the commit it actually pushed.
 *
 * TASK IS AN INPUT, because the seed is a PREDICTION about what the workflow will
 * do and `resumeOnUnchangedHead` is the thing that decides it. That function
 * answers `{ mode: 'rebuild', reason: 'execution_strategy-progress-unknown' }` for a bare
 * `forge-done` when `input.execution_strategy === 'task_sequence'` — a task-sequence iteration's build says
 * nothing about whether the PLAN is finished, so the next iteration must re-plan.
 * Seeding that row would strip the launcher's leftover-branch guard and its
 * base_sha pin off a run the workflow then rebuilds anyway: all of the cost of
 * resuming, none of the saving. `fix-round-N` and `outer-published:*` route to
 * review in BOTH modes, so execution_strategy does not touch them.
 *
 * A `stopped` PRIOR SEEDS NOTHING, and it is the one place this function departs
 * from the taxonomy above on purpose. `stopped` is written by exactly two callers
 * — `/code stop` and the board's X-cancel/delete (`trident/terminate.ts`) — so it
 * is never a crash, a reap or a budget death: it is an operator saying "discard
 * this". A stopped run parked at `forge-done` still CLASSIFIES `built-never-
 * reviewed`, because the offline count is about what happened and that is what
 * happened; but adopting its commit into the next dispatch would silently re-enter
 * work the owner explicitly stopped — and would do it through the one path that
 * carries the prior run's base pin, which is exactly what makes the leftover-branch
 * refusal EXEMPT the adopted tip (`ownCrashLeftover`). The guard is not stripped
 * for a seeded row (it runs for `freshLaunch || seeded_resume`); it simply has
 * nothing to object to. Salvage is for work nobody decided to throw away.
 */
export function builtButNeverReviewedSeed(
  run: TridentRun,
  opts: { execution_strategy?: 'single' | 'task_sequence' | null } = {},
): { checkpoint: string; head: string; findings: string | null; base_sha: string } | null {
  if (terminalRunDisposition(run) !== 'built-never-reviewed') return null
  if (run.phase === 'stopped') return null
  const checkpoint = typeof run.inner_checkpoint === 'string' ? trimCheckpoint(run.inner_checkpoint) : ''
  if (checkpoint.length === 0) return null
  if (opts.execution_strategy === 'task_sequence' && checkpoint === 'forge-done') return null
  const published = checkpoint.match(OUTER_PUBLISHED_CHECKPOINT)
  const head = trimCheckpoint(published?.[1] ?? run.inner_checkpoint_head ?? '').toLowerCase()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) return null
  // NO BASE PIN, NO SEED. `launch()` re-pins a base only on a FRESH build
  // (`inner_checkpoint === null && base_sha === null`), and a seeded checkpoint
  // makes that false — so a seed carrying a null pin would create a row that can
  // NEVER acquire one, and the publish-time "branch does not contain the
  // recorded launch base" refusal (gated on `base_sha !== null`)
  // would be permanently inert for it and for every re-seed chained off it. A
  // legacy/unpinned prior row therefore seeds NOTHING: it falls through to the
  // fresh dispatch that pins a base, which is exactly today's behaviour for it.
  if (typeof run.base_sha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(trimCheckpoint(run.base_sha).toLowerCase()))
    return null
  return {
    checkpoint,
    head,
    // Verbatim: a `forge-done` row can carry the full-suite findings the workflow
    // reads back on resume, and re-encoding them here would change what it reads.
    findings: run.inner_checkpoint_findings,
    // THE BASE PIN TRAVELS WITH THE HEAD, or seeding would silently disarm a gate
    // (see the null-base refusal above). The prior run's pin is the RIGHT value to
    // carry precisely because the caller has proven the branch still holds that
    // run's own recorded head: same commit, same base it was cut from.
    base_sha: trimCheckpoint(run.base_sha).toLowerCase(),
    // `pr` is deliberately NOT carried. `launch()` resolves it with
    // `run.pr ?? await detectExistingPr(run)`, and a seeded number SHORT-CIRCUITS
    // that probe — including when the prior run's PR has since been CLOSED,
    // which would attach this run to a dead PR. detectExistingPr lists the OPEN
    // PRs on the branch, which is the question actually being asked.
  }
}
