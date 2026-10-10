---
title: Carry a dead run's checkpoint and task iteration into its retry
group: trident
status: done
priority: P0
cutover: true
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

> **Current terminology.** This completed item predates planner-selected
> execution strategy. Its current contract is that a retry preserves the
> persisted `single` or `task_sequence` selection and card-owned
> `task_iteration` / `max_task_iterations` spend. Historical storage maps
> `ralph = 1` → `task_sequence`, `ralph = 0` → `single`, `ralph_round` →
> `task_iteration`, `max_ralph_rounds` → `max_task_iterations`, and the
> checkpoints `ralph-task-built[-deviated]` →
> `task-built[-deviated]`. The older column, checkpoint, migration, test, and
> function names below are retained as historical evidence.

**A retry must resume from the checkpoint, not merely from the PR.** A re-dispatch creates a NEW run
row, and what that row inherits now depends on the card's `linked_run_id`.

**What carries.** When a card names its own prior run, `dispatchBoardBoundBuild` loads that run
by id and the new row preserves its selected strategy and task-iteration spend —
`task_iteration` together with the cap it is measured against,
`min(prior, this dispatch)` — and, when the prior's checkpoint is review-capable
(`fix-round-N`, `outer-published:*`) and the live branch tip still holds its recorded head, with that
checkpoint, its head, its findings and its base pin. The review `round` comes from the checkpoint name,
so review rounds are not restarted for such a resume. A `task_sequence` prior that handed back a finished
iteration (`task-built`) is resumed the same way when the LOCAL branch ref still holds its recorded
head, and the new row is born at the iteration that handoff advanced to. Whatever the dispatch decides,
it writes one sentence saying so onto the row, and the card shows it.

**What used to not carry, and how each gap closed.** Three gaps kept this item open; all
three are closed, and `## Closed` below records where.

- The spend rode `linked_run_id`, so anything that moved or cleared that link started a fresh
  budget. The card now owns the spend (#722, #728; rjunee/neutron#629 is closed).
- The task-sequence plan was regenerated from scratch on every resume. A retry of a handed-back
  task iteration now resumes `task-built` and the typed build host plans it with the
  cheap `next` planner over the committed ledger.
- A refusal to carry was a log line only. The dispatch now writes one sentence onto the run
  row (`resume_note`), and the card renders it.

Acceptance: a retry carries the dead run's strategy, `inner_checkpoint`, and
`task_iteration` forward, or states plainly
on the card that it will not. The fire-time `detectExistingPr` probe (`trident/orchestrator.ts` `launch`)
must not be the thing that recovers continuity — it only sets `pr`, and it silently degrades to zero in
`local` merge-mode, where there is no origin to ask.

## Acceptance

### Unresolved work cannot become a fresh retry

Under the 2026-10-10 Decisions Log entry for unresolved retries, a same-card,
unchanged-task retry with matching repository, branch, strategy and merge mode
must not fall back to fresh planning when its latest authenticated checkpoint
still reserves a worker. If the existing settlement rules establish a reusable
source, retain that supported continuation. The existing owned-publication
build/fix handoff below may still create a successor to verify its authenticated
settlement at outer launch and preparation, before dispatching any planner. A PR
receipt alone is not settlement; its missing or invalid worker evidence still
refuses there. Every other pending shape refuses before creating a successor or
changing the card's run link. Preserve the original checkpoint,
attempts, artifacts and spent budgets. The refusal names the unresolved phase
and the need to reconcile it; it is not a completed build or a cancellation
acknowledgement.

Exercise failed and stopped predecessors, each pending phase, a null-head
planner, and a pending successor of an earlier reusable source. Pair these
refusals with an eligible settled-review retry that reaches merge without a
plan/build replay, plus the existing changed-task and fresh-card controls.
Preserve the owned-publication handoff's real dispatch-to-merge controls and its
missing/invalid settlement refusals; a published review or planner remains
ineligible for that build/fix-only handoff.
Verify `trident/cross-run-retry-checkpoint.test.ts` and the prepared consuming
path in `open/__tests__/project-build-e2e.test.ts`.

### Settled review infrastructure stops

A required review seat's rate-limit refusal must preserve the completed build
for a later ordinary retry when the host proves the standalone review completed
with a valid result and every enabled panel seat settled with a valid completion
or a rate-limit refusal for the same run, head and round. The stop still refuses
merge. Clear only the pending reservation; retain the checkpoint, review round,
strategy and spend. The next run obtains its own reviews and release evidence.
An active, unknown, missing, malformed, deferred or wrong-scope sibling cannot
authorize clearing the reservation. Historical pending checkpoints without this
host settlement proof remain subject to the existing refusal.

Historical terminal checkpoints may establish settlement from their original
host evidence before retry-source admission. The persisted attempt ledger is the
independent census of admitted work: each review request must have its matching
journal, and every admitted panel seat must have an exact-scope, settled receipt
with a valid completion or a rate-limit refusal. At least one rate-limit refusal
and the original standalone request's armed reservation, intact brief/context and
valid completed result are required. Missing, pending, deferred, malformed,
foreign or changing evidence refuses import, including a ledger seat whose
journal and directory both disappeared. Historical configuration is not inferred
from current settings: this proves settlement of admitted work, never complete
review coverage or approval. The new run executes its full configured panel.
Only the import view drops pending; original events and receipts remain intact.
Revalidate that proof whenever the retry source is consumed, retaining the
completed head, original review round, strategy, iteration spend and baseline.

Verify: `trident/gates/review-panel.test.ts`, `trident/build-run.test.ts`, and
`open/__tests__/project-build-e2e.test.ts` (settled rate-limit cross-run retry).

### Settled pending predecessor of an owned publication

Tracked by #1476. A terminal predecessor whose latest checkpoint still records a
pending build or fix reservation is not a retry source, even when its original
authenticated result establishes that the worker settled. Settlement proves the
writer stopped and names the head it left; it does not authorize reusing the
unfinished checkpoint, its round, findings, approval or suite receipt. When the
card also owns a witnessed publication on that branch, the retry starts fresh
planning on the retained branch at that settled head, keeps the predecessor's
base pin, strategy and card task spend, and obtains its own proof, review and
pinned merge gates. Completed and unfinished or `unknown` attempt accounting are
both covered; neither is rewritten. A newer card attempt that was refused
before its first worker, at outer launch or (in its exact launcher-written
shape) at preparation, is passed over and never becomes the retry source or
ends the card's recovery. When the authority cannot be re-read at preparation
on a row carrying the adopted base pin, or the owned PR head object cannot be
read at outer launch, the retry refuses as UNKNOWN rather than attaching the
branch or reporting a wrong base. The launch and checkout-handoff acceptance
and its controls live in `docs/spec-items/salvage-publication-provenance.md`
(`Owned published retry through outer launch`).

Verify: `trident/build-mode-state.test.ts`,
`trident/published-retry-handoff.test.ts`, and
`open/__tests__/project-build-e2e.test.ts` (owned published retry).

### Existing continuity criteria

All three are met. #628 once ticked all three on evidence that did not hold; the
measurements under `## Closed` are what these ticks rest on, and they name the loop each
one is measured on.

- [x] A retry carries the dead run's strategy, `inner_checkpoint`, and
      `task_iteration` forward, OR states
      plainly on the card that it will not. Silence fails; a new run row with
      `inner_checkpoint = null` and `task_iteration = 0` and no card text is the defect.
      verify: `trident/cross-run-retry-checkpoint.test.ts` (every seed reason writes its
      sentence; a first dispatch writes none), `trident/store.test.ts` (write-once
      `resume_note`), `trident/run-progress.test.ts`, `app/__tests__/work-board-helpers.test.ts`,
      `landing/chat-react/__tests__/work-board-tab.test.tsx`.
- [x] Planning and review tokens are not re-spent on a resume that had a checkpoint to
      resume from. Assert the task-sequence plan is NOT regenerated from scratch.
      verify: `open/__tests__/project-build-e2e.test.ts` (the retry's planner choice is
      `next` and the plan it executes is the committed ledger's exact bytes),
      `trident/build-run.test.ts`, `trident/production-host-effects.test.ts`.
- [x] Resume does not depend on the fire-time `detectExistingPr` probe alone. Assert the
      `local` merge-mode case, where a PR probe silently degrades to zero — a test run only
      in `pr` mode passes with the defect present.
      verify: `trident/cross-run-retry-checkpoint.test.ts` and
      `open/__tests__/project-build-e2e.test.ts`, each run for `local` and `pr` with origin
      lagging the recorded head; `trident/retry-resumes-checkpoint.test.ts`.

## Historical shipped evidence

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
