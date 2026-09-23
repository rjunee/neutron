---
title: Carry a dead run's checkpoint and ralph round into its retry
group: trident
status: done
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
so review rounds are not restarted for such a resume. A governed prior that handed back a finished Ralph
iteration (`ralph-task-built`) is resumed the same way when the LOCAL branch ref still holds its recorded
head, and the new row is born at the iteration that handoff advanced to. Whatever the dispatch decides,
it writes one sentence saying so onto the row, and the card shows it.

**What used to not carry, and how each gap closed.** Three gaps kept this item open; all
three are closed, and `## Closed` below records where.

- The spend rode `linked_run_id`, so anything that moved or cleared that link started a fresh
  budget. The card now owns the spend (#722, #728; rjunee/neutron#629 is closed).
- The governed plan was regenerated from scratch on every resume. A retry of a handed-back
  Ralph iteration now resumes `ralph-task-built` and the typed build host plans it with the
  cheap `next` planner over the committed ledger.
- A refusal to carry was a log line only. The dispatch now writes one sentence onto the run
  row (`resume_note`), and the card renders it.

Acceptance: a retry carries the dead run's `inner_checkpoint` and `ralph_round` forward, or states plainly
on the card that it will not. The fire-time `detectExistingPr` probe (`trident/orchestrator.ts` `launch`)
must not be the thing that recovers continuity — it only sets `pr`, and it silently degrades to zero in
`local` merge-mode, where there is no origin to ask.

## Acceptance

All three are met. #628 once ticked all three on evidence that did not hold; the
measurements under `## Closed` are what these ticks rest on, and they name the loop each
one is measured on.

- [x] A retry carries the dead run's `inner_checkpoint` and `ralph_round` forward, OR states
      plainly on the card that it will not. Silence fails; a new run row with
      `inner_checkpoint = null` and `ralph_round = 0` and no card text is the defect.
      verify: `trident/cross-run-retry-checkpoint.test.ts` (every seed reason writes its
      sentence; a first dispatch writes none), `trident/store.test.ts` (write-once
      `resume_note`), `trident/run-progress.test.ts`, `app/__tests__/work-board-helpers.test.ts`,
      `landing/chat-react/__tests__/work-board-tab.test.tsx`.
- [x] Planning and review tokens are not re-spent on a resume that had a checkpoint to
      resume from. Assert the governed plan is NOT regenerated from scratch.
      verify: `open/__tests__/project-build-e2e.test.ts` (the retry's planner choice is
      `next` and the plan it executes is the committed ledger's exact bytes),
      `trident/build-run.test.ts`, `trident/production-host-effects.test.ts`.
- [x] Resume does not depend on the fire-time `detectExistingPr` probe alone. Assert the
      `local` merge-mode case, where a PR probe silently degrades to zero — a test run only
      in `pr` mode passes with the defect present.
      verify: `trident/cross-run-retry-checkpoint.test.ts` and
      `open/__tests__/project-build-e2e.test.ts`, each run for `local` and `pr` with origin
      lagging the recorded head; `trident/retry-resumes-checkpoint.test.ts`.

## Shipped

`builtButNeverReviewedSeed` → `dispatchBoardBoundBuild` → `TridentRunStore.create`
already carried `inner_checkpoint`, its head, its findings, the base pin and the review
`round`. #628 adds the card's Ralph SPEND on a separate gate: `ralph_round` together
with the cap it is measured against, `min(prior, dispatch)`, so a re-dispatch may
tighten the budget and never loosen it. Record:
`docs/as-built/a-retry-must-resume-from-the-checkpoint.md`.

**The scope, and the two halves are different widths.** Calling it "the mid-budget case"
under-claimed — the phrasing this paragraph used to carry, and the same error as the
as-built's, which would leave a reader concluding exhausted runs get a fresh budget.

- **Budget inheritance** covers any governed prior the card NAMES, exhausted included: it
  is gated on the board link rather than on the commit seed, so it survives a moved tip,
  an unreadable ref, an unresumable prior — including the `ralph-task-built` row the
  Ralph loop's own exhaustion path parks on — and a spec-doc edit past the slug's 35th
  character. The spend and its cap travel together and the cap can only tighten.
- **Complete checkpoint resumption** is narrower: a review-capable checkpoint
  (`fix-round-N`, `outer-published:*`) on an unmoved tip, and — since this item closed — a
  handed-back Ralph iteration (`ralph-task-built`, never `ralph-task-built-deviated`, whose
  committed plan no longer matches the code) on an unmoved LOCAL ref. A governed run that
  died there with iterations left keeps its count and its plan-refresh cadence.

## Closed

Measured against main at 7454048a and this change's branch. Record:
`docs/as-built/a-retry-resumes-from-the-checkpoint-and-says-so.md`.

**1. The resume decision is stated on the card.** A retry that declines to resume used to
be a byte-identical fresh dispatch whose only trace was a `dispatch_resume_seed` log line.
Migration `0155_trident_resume_note.sql` adds `code_trident_runs.resume_note`;
`resumeNote()` (`trident/board-dispatch.ts:165-178`) returns null only for
`no_prior_terminal_run` and one sentence for every other seed reason, naming whether the
checkpoint carried and, for a governed run, the Ralph round and cap the row holds. The
store writes it once, at create, with no later writer (`trident/store.ts:909`, `:1972`), `run_progress` carries it
(`trident/run-progress.ts:109-113`), and both front-ends render it in `runNotice`
(`app/lib/work-board-helpers.ts:263`, `landing/chat-react/WorkBoardTab.tsx:252`).

**2. Planning tokens are not re-spent — measured on the typed build host.** The gap as
written named `trident/inner-workflow.mjs`'s `cleanContinuation`. That premise moved: the
launcher a board dispatch reaches is the typed host (`open/wiring/project-build.ts`
`createProjectBuildHost` → `trident/build-run.ts` `buildRun`), and the legacy workflow
substrate is retained but not consumed by the production project launcher
(`open/wiring/substrates.ts:543-544`). On the typed host, G026
(`trident/build-run.ts:349-366`) selects `planner: 'next'` only for a `ralph-task-built`
resume whose committed ledger measures clean, and G029 (`trident/build-run.ts:518-522`)
replaces the planner's claims with the committed bytes. What was missing was the retry
reaching that state: a `ralph-task-built` prior is now a typed retry source
(`trident/build-mode-state.ts:86`, `trident/run-disposition.ts:160`,
`trident/store.ts:700`), and the host commits the ledger at every handoff — never on the
final iteration, whose reviewed head must stay the one the builder's receipts name — so the
next iteration has bytes to read. `open/__tests__/project-build-e2e.test.ts:2046-2102` asserts,
for both merge modes, planner choices `['next']` and committed plans equal to the handoff
ledger. `inner-workflow.mjs`'s gate is untouched (`grep -n cleanContinuation
trident/inner-workflow.mjs` → `:5969`); the criterion is met on the typed host, not there.
Earlier G026 coverage: `docs/as-built/1074-continuation-planner-e2e.md`.

**3. `max_ralph_rounds` bounds the CARD, not a run — closed on main by #722 and #728.**
The history: the spend rode `linked_run_id`, and one status-advance off the `failed` lane
NULLed it, so the same card got a fresh budget (rjunee/neutron#629, closed 2026-09-14).
Migrations `0141_work_board_items_ralph_budget.sql` and `0142_work_board_zero_ralph_cap.sql`
put the spend on the card: reconcile raises `ralph_round` with `MAX` and only tightens the
cap with `MIN` (`work-board/store.ts:1391-1392`), and dispatch refuses an at-cap card with
`ralph_budget_exhausted` from the CARD's columns (`trident/board-dispatch.ts:1045-1050`), so
clearing `linked_run_id` (`work-board/store.ts:1257`) no longer resets the spend. Not
rebuilt here.

**The resume does not ride the PR probe.** The dispatch proves the recorded head against
the LOCAL ref in every merge mode, so a `local` repo with no origin to ask and a `pr` repo
whose origin lags an unpublished handoff both resume
(`trident/cross-run-retry-checkpoint.test.ts:377-400`).
