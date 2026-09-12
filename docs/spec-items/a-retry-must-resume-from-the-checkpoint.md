---
title: Carry a dead run's checkpoint and ralph round into its retry
group: trident
status: open
priority: P0
cutover: true
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**A retry must resume from the checkpoint, not merely from the PR.** A re-dispatch creates a NEW run
row, and what that row inherits now depends on the card's `linked_run_id`.

**What carries.** When a card names its own governed prior run, `dispatchBoardBoundBuild` loads that run
by id and the new row is born with the prior's Ralph spend — `ralph_round` together with the cap it is
measured against, `min(prior, this dispatch)` — and, when the prior's checkpoint is review-capable
(`fix-round-N`, `outer-published:*`) and the live branch tip still holds its recorded head, with that
checkpoint, its head, its findings and its base pin. The review `round` comes from the checkpoint name,
so review rounds are not restarted for such a resume.

**What still does not carry, which is what this item remains open for.**

- The spend rides `linked_run_id`, so anything that moves or clears that link starts a fresh budget: one
  ordinary status-dot advance off the `failed` lane NULLs it, an intervening non-governed run becomes
  what it names, and `onboarding/overnight/register.ts` dispatches with no card at all. `max_ralph_rounds`
  therefore still bounds a RUN and not a CARD (`#629`).
- The governed plan is still regenerated from scratch. The inner workflow's cheap continuation planner is
  gated on `resumeCheckpoint === 'ralph-task-built'`, which is `died-before-build` and never resumed, so
  every shape that IS resumed pays the full survey.
- A refusal to carry is not stated on the card. There is no board surface to write it to; the dispatch
  emits a log line instead, and a server log is not card text.

Acceptance: a retry carries the dead run's `inner_checkpoint` and `ralph_round` forward, or states plainly
on the card that it will not. The fire-time `detectExistingPr` probe (`trident/orchestrator.ts` `launch`)
must not be the thing that recovers continuity — it only sets `pr`, and it silently degrades to zero in
`local` merge-mode, where there is no origin to ask.

## Acceptance

**None of the three is met. All three were ticked at one point in #628 and all three
ticks were wrong**; the measurements below are why. The item stays `open`.

- [ ] A retry carries the dead run's `inner_checkpoint` and `ralph_round` forward, OR states
      plainly on the card that it will not. Silence fails; a new run row with
      `inner_checkpoint = null` and `ralph_round = 0` and no card text is the defect.
      **PARTIAL.** The carrying branch is delivered — the BUDGET half for any governed
      prior the card names, exhausted included, and the CHECKPOINT half for a
      review-capable checkpoint on an unmoved tip (see "The scope" below). The
      *card-text* branch, which is what a refusal needs, is not delivered at all —
      there is no board surface to write it to.
- [ ] Planning and review tokens are not re-spent on a resume that had a checkpoint to
      resume from. Assert the governed plan is NOT regenerated from scratch.
      **NOT MET.** `inner-workflow.mjs`'s `cleanContinuation` needs
      `resumeCheckpoint === 'ralph-task-built'` AND `ralphRound >= 1` AND
      `% PLAN_REFRESH_EVERY !== 0`. This change never resumes `ralph-task-built` (it
      classifies `died-before-build`), so for every shape it *does* resume the full
      `plan:fable` survey runs exactly as before. #628 ticked this on a test asserting
      `buildWorkflowArgs`' `ralphRound === 4` — an input to a gate no test drives.
- [ ] Resume does not depend on the fire-time `detectExistingPr` probe alone. Assert the
      `local` merge-mode case, where a PR probe silently degrades to zero — a test run only
      in `pr` mode passes with the defect present.
      **PARTIAL.** The dispatch-level half is now real: `trident/retry-resumes-checkpoint.test.ts`
      drives the default branch-tip reader against a git repo on disk with no origin and
      a recording `gh` shim, for a present and an absent ref. The criterion's own subject
      — that the RESUME does not degrade — is not asserted end-to-end.

## Shipped

`builtButNeverReviewedSeed` → `dispatchBoardBoundBuild` → `TridentRunStore.create`
already carried `inner_checkpoint`, its head, its findings, the base pin and the review
`round`. #628 adds the card's Ralph SPEND on a separate gate: `ralph_round` together
with the cap it is measured against, `min(prior, dispatch)`, so a re-dispatch may
tighten the budget and never loosen it. Record:
`docs/as-built/a-retry-must-resume-from-the-checkpoint.md` (staged at
`docs/as-built/a-retry-must-resume-from-the-checkpoint.md`).

**The scope, and the two halves are different widths.** Calling it "the mid-budget case"
under-claimed — the phrasing this paragraph used to carry, and the same error as the
as-built's, which would leave a reader concluding exhausted runs get a fresh budget.

- **Budget inheritance** covers any governed prior the card NAMES, exhausted included: it
  is gated on the board link rather than on the commit seed, so it survives a moved tip,
  an unreadable ref, an unresumable prior — including the `ralph-task-built` row the
  Ralph loop's own exhaustion path parks on — and a spec-doc edit past the slug's 35th
  character. The spend and its cap travel together and the cap can only tighten.
- **Complete checkpoint resumption** is narrower and unchanged: a review-capable
  checkpoint (`fix-round-N`, `outer-published:*`) on an unmoved tip, which is the branch
  the criteria above name. A governed run that died there with iterations left keeps its
  count and its plan-refresh cadence.

## Not met

**1. The refusal is not stated on the card.** When the evidence gate refuses the
commit, the dispatch emits one `dispatch_resume_seed` line. **A server log is not card
text**; nobody looking at the card sees it. It cannot be met without a new surface:
`work_board_items` has no free-text column (its text is `title`, sanitised, and
`design_doc_ref`) and `TridentBoardBinder` is `get` / `attachRun` / reconcile.
Delivering it means a column plus a migration, a render in the card UI, and wiring at
three composition roots.

**2. Planning tokens are still re-spent.** See the criterion above. The carried round
only changes the cadence of a resumed run's LATER iterations, whose behaviour
`trident/inner-workflow-plan-next.test.ts` already pins at rounds 1-4 versus 5 and 10.

**3. `max_ralph_rounds` is still not a bound on the CARD, and this is the structural
one.** The spend rides `linked_run_id`, and **the cheapest way to clear that is one
click**: `work-board/store.ts` NULLs `linked_run_id` when a card leaves the `failed`
lane (`nextStatus('failed') → 'upcoming'`, the ordinary status-dot advance) and again on
`done → upcoming`. Measured: link cleared → `card_names_no_run` → a full fresh budget,
same card, same slug, same title, same branch, nothing re-cut. Two other doors need the
slug lost (`onboarding/overnight/register.ts` creates governed runs with no card; a
re-cut card gets a new slug), and an **intervening non-governed run** launders the spend
outright: every successful dispatch rebinds the card to its new run
(`board-dispatch.ts:1574`), so one ralph-off dispatch makes that row what `linked_run_id`
names, and `carriedRalphBudget` then answers null on `run.ralph !== true`
(`run-disposition.ts:298`). That row is present and readable — just not governed — so it
is not a "gap in the chain"; the spend is lost because the card points somewhere else. Earlier drafts of this
paragraph named only the two slug-losing doors, which made the limit sound far narrower
than it is.

The row is recreated by every dispatch and the link is one click from gone, so a per-row
counter is one reset away by construction. The durable fix is to hold the spend on the
card, or to refuse/announce the dispatch when the card's budget is spent. Tracked as
**rjunee/neutron#629**, with the measurement.
