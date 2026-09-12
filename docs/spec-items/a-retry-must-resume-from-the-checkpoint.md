---
title: Carry a dead run's checkpoint and ralph round into its retry
group: trident
status: open
priority: P0
cutover: true
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**A retry must resume from the checkpoint, not merely from the PR.** A re-dispatch creates a NEW run
row with `inner_checkpoint = null` and `ralph_round = 0`; only the fire-time `detectExistingPr` probe
(`trident/orchestrator.ts` `launch`) recovers continuity, by setting `pr` and so making the inner
workflow's `resuming` true. That is enough to preserve the *code* (Forge re-enters the branch, the
planner is told to read the committed work) but the governed plan is regenerated from scratch and the
review rounds restart — planning and review tokens are re-spent every crash. Acceptance: a retry carries
the dead run's `inner_checkpoint` and `ralph_round` forward, or states plainly on the card that it will
not. A resume that depends on a GitHub PR probe also silently degrades to zero in `local` merge-mode.

## Acceptance

**None of the three is met. All three were ticked at one point in #628 and all three
ticks were wrong**; the measurements below are why. The item stays `open`.

- [ ] A retry carries the dead run's `inner_checkpoint` and `ralph_round` forward, OR states
      plainly on the card that it will not. Silence fails; a new run row with
      `inner_checkpoint = null` and `ralph_round = 0` and no card text is the defect.
      **PARTIAL.** The carrying branch holds only for a MID-BUDGET run (below); the
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
`.trident/as-built/fix/519-retry-resumes-checkpoint.md`).

**The honest scope is the MID-BUDGET case.** A governed run that died at `fix-round-N`
or `outer-published:*` with iterations left keeps its count and its plan-refresh
cadence. Measured improvement beyond that: because the spend is gated on the board
link rather than on the commit seed, it also survives a moved tip, an unreadable ref,
an unresumable prior — including the `ralph-task-built` row the Ralph loop's own
exhaustion path parks on — and a spec-doc edit past the slug's 35th character.

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
one.** The spend rides `linked_run_id`, so any dispatch without one starts at zero:
`onboarding/overnight/register.ts` creates governed runs with no card, and an owner who
re-cuts a card gets a new slug and no prior. The row is recreated by every dispatch, so
a per-row counter is one reset away by construction. The durable fix is to hold the
spend on the card, or to refuse/announce the dispatch when the card's budget is spent.
Tracked as **rjunee/neutron#629**, with the measurement.
