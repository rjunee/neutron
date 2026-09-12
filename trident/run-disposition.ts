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
 *                          is deliberately not resumable. `ralph-task-built` is the
 *                          latter and is the honest majority of that bucket on the
 *                          live table: a ralph iteration builds ONE task and hands
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
 *   reviewed-rejected      a reviewer looked and said no.
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
import { carriedRalphCap, carryableRalphRound } from './ralph-budget.ts'
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
 * more than the name is `forge-done` in ralph mode, and that belongs to the
 * prediction rather than the taxonomy: `builtButNeverReviewedSeed` takes `ralph`
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
 * unchanged — `/^[0-9a-f]{40}$/` rejects anything either trim would disagree
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

/**
 * THE CARD'S RALPH BUDGET, as the row that re-dispatches it must inherit it — the
 * spend AND the bound it is measured against, or nothing.
 *
 * WHY IT IS CARRIED AT ALL (#519). `ralph_round` is not decoration.
 * `refireNextRalphTask` (orchestrator.ts) bounds the Ralph loop on
 * `nextRalphRound > run.max_ralph_rounds`, and `buildWorkflowArgs` (inner-loop.ts)
 * threads the counter to the inner workflow as `ralphRound`, where the
 * plan-refresh cadence reads `ralphRound % PLAN_REFRESH_EVERY`. A re-dispatch that
 * writes 0 hands a mid-budget run a fresh count and restarts its cadence, so the
 * periodic full re-plan lands on the wrong iteration of the SAME piece of work.
 *
 * WHAT THIS DOES *NOT* FIX, measured (cross-model adversarial review, P1). It does
 * NOT make `max_ralph_rounds` a bound on the CARD, and the earlier revision of this
 * file claimed it did. A run that EXHAUSTS the loop takes
 * `refireNextRalphTask`'s cap branch, which builds its terminal row through
 * `failedRun` and therefore leaves `inner_checkpoint` at whatever the last re-fire
 * wrote — `ralph-task-built`. That name is not review-capable
 * ({@link reviewCapableCheckpoint}), so the exhausted row classifies
 * `died-before-build`, `builtButNeverReviewedSeed` declines it, and the next
 * dispatch is a fresh build. Pressing ▶ again therefore still buys another full
 * budget; it just costs one exhaustion cycle per press instead of none. The row is
 * recreated by every dispatch, so ANY per-row counter is one reset away by
 * construction — the durable fix is to hold the spend on the CARD, or to refuse the
 * dispatch when the card's budget is spent, and that is a different change.
 *
 * SO THE HONEST SCOPE IS THE MID-BUDGET CASE: a governed run that died at
 * `fix-round-N` or `outer-published:*` with rounds left keeps its count and its
 * cadence when its card is re-dispatched. That is what this function delivers.
 *
 * THE PAIR IS INDIVISIBLE. Returning a round without its cap is not a bound: a
 * prior at `5 / 5` re-dispatched under the ambient default became `5 / 20`, and
 * `5 + 1 > 20` authorises fifteen more iterations. So either both travel or
 * neither does, and the cap is `min(prior, dispatch)` — a re-dispatch may TIGHTEN
 * the budget, never loosen it (see `carriedRalphCap`).
 *
 * BOTH RUNS MUST BE GOVERNED. `opts.ralph` is the mode the NEW row is born in
 * (resolved at dispatch by `detectRalphMode`); `run.ralph` is the mode the count
 * was produced in. A count of Ralph iterations means nothing on a row that will not
 * run a Ralph loop, and a non-Ralph prior has no iterations to count.
 *
 * IT IS DELIBERATELY *NOT* GATED ON THE COMMIT SEED, and that is the fix for the
 * measured slug-truncation defect (adversarial review, P2). `slugifyTask` truncates
 * at 35 characters and the ▶ task text is the card's design-doc BODY, so an owner
 * clarifying that doc between two presses keeps the same slug and the same branch
 * while the full text differs. `builtButNeverReviewedSeed`'s caller refuses the
 * COMMIT on a text mismatch, and must keep doing so — adopting the wrong card's
 * unreviewed commit sends code to review under another card's title. But the BUDGET
 * has no such hazard, because the carry is monotone: `min` can only tighten a bound,
 * never authorise work. Under-authorising is the safe direction, so the weak proxy
 * (task text) does not get to veto the strong identity (`linked_run_id`, which
 * `attachRun` alone writes) for a value that cannot authorise anything.
 *
 * FAIL-CLOSED ON ANY SHAPE IT CANNOT READ: `null` (carry nothing) rather than a
 * guess. See `carryableRalphRound` / `carriedRalphCap`.
 */
export function carriedRalphBudget(
  run: TridentRun,
  opts: { ralph?: boolean; max_ralph_rounds?: number },
): { ralph_round: number; max_ralph_rounds: number } | null {
  if (opts.ralph !== true || run.ralph !== true) return null
  const cap = carriedRalphCap(run.max_ralph_rounds, opts.max_ralph_rounds)
  if (cap === null) return null
  return { ralph_round: carryableRalphRound(run.ralph_round), max_ralph_rounds: cap }
}

/**
 * The evidence a built-but-never-reviewed terminal run can hand to the NEXT
 * dispatch of the same card, or null when there is nothing safe to hand over.
 *
 * Null for every disposition but `built-never-reviewed`, null when no 40-hex head
 * was recorded (without a head the resume classifier would rebuild anyway, and a
 * seeded checkpoint with no head would only strip the launcher's leftover-branch
 * guard off a run that still needs it), and null when the prior row carries no
 * 40-hex `base_sha` (a seeded row never re-pins one, so it would be born with the
 * publish-time cut-from-origin refusal permanently disarmed).
 *
 * For an `outer-published:<oid>:<remaining>:<round>` checkpoint (round LAST — the
 * publisher builds `outer-published:${head}:${remaining_tasks}:${round}`) the OID
 * EMBEDDED IN THE NAME is authoritative — the same precedence the orchestrator's
 * resume site and the workflow both apply — because the publish stamped the name
 * against the commit it actually pushed.
 *
 * RALPH IS AN INPUT, because the seed is a PREDICTION about what the workflow will
 * do and `resumeOnUnchangedHead` is the thing that decides it. That function
 * answers `{ mode: 'rebuild', reason: 'ralph-progress-unknown' }` for a bare
 * `forge-done` when `input.ralph === true` — a ralph iteration's build says
 * nothing about whether the PLAN is finished, so the next iteration must re-plan.
 * Seeding that row would strip the launcher's leftover-branch guard and its
 * base_sha pin off a run the workflow then rebuilds anyway: all of the cost of
 * resuming, none of the saving. `fix-round-N` and `outer-published:*` route to
 * review in BOTH modes, so ralph does not touch them.
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
  opts: { ralph?: boolean } = {},
): { checkpoint: string; head: string; findings: string | null; base_sha: string } | null {
  if (terminalRunDisposition(run) !== 'built-never-reviewed') return null
  if (run.phase === 'stopped') return null
  const checkpoint = typeof run.inner_checkpoint === 'string' ? trimCheckpoint(run.inner_checkpoint) : ''
  if (checkpoint.length === 0) return null
  if (opts.ralph === true && checkpoint === 'forge-done') return null
  const published = checkpoint.match(OUTER_PUBLISHED_CHECKPOINT)
  const head = trimCheckpoint(published?.[1] ?? run.inner_checkpoint_head ?? '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(head)) return null
  // NO BASE PIN, NO SEED. `launch()` re-pins a base only on a FRESH build
  // (`inner_checkpoint === null && base_sha === null`), and a seeded checkpoint
  // makes that false — so a seed carrying a null pin would create a row that can
  // NEVER acquire one, and the publish-time "branch does not contain the
  // origin/<base> tip pinned at launch" refusal (gated on `base_sha !== null`)
  // would be permanently inert for it and for every re-seed chained off it. A
  // legacy/unpinned prior row therefore seeds NOTHING: it falls through to the
  // fresh dispatch that pins a base, which is exactly today's behaviour for it.
  if (typeof run.base_sha !== 'string' || !/^[0-9a-f]{40}$/.test(trimCheckpoint(run.base_sha).toLowerCase()))
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
