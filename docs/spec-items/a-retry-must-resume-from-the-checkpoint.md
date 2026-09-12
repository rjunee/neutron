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

- [ ] A retry carries the dead run's `inner_checkpoint` and `ralph_round` forward, OR states
      plainly on the card that it will not. Silence fails; a new run row with
      `inner_checkpoint = null` and `ralph_round = 0` and no card text is the defect.
      **HALF MET — see "Not met" below.** The carrying branch is delivered; the
      *card-text* branch, which is what a REFUSAL to carry needs, is not. It needs a
      board surface that does not exist.
- [x] Planning and review tokens are not re-spent on a resume that had a checkpoint to
      resume from. Assert the governed plan is NOT regenerated from scratch.
- [x] Resume does not depend on the fire-time `detectExistingPr` probe alone. Assert the
      `local` merge-mode case, where a PR probe silently degrades to zero — a test run only
      in `pr` mode passes with the defect present.

## Shipped

The `inner_checkpoint` half landed with the salvage-resume seed (`builtButNeverReviewedSeed`
→ `dispatchBoardBoundBuild` → `TridentRunStore.create`); this item's own change added the
`ralph_round` half. The record is
`docs/as-built/a-retry-must-resume-from-the-checkpoint.md` (staged at
`.trident/as-built/fix/519-retry-resumes-checkpoint.md` until promoted).

**Exhausted stays exhausted.** The round is carried VERBATIM, cap included, so
`max_ralph_rounds` bites on the row that inherits it (`computeTransition`,
`refireNextRalphTask`: fail loudly, naming the cap). An earlier revision refused to carry a
round at or past the cap; that refusal fell back to a fresh row at `ralph_round: 0`, on which
`0 + 1 > max_ralph_rounds` is false — so re-dispatching a card AT its cap restored all twenty
iterations. A refusal to carry has to be a refusal, not a reset.

## Not met

**Criterion 1's card-text branch is NOT delivered, and this item stays `open` for it.**
When the evidence gate refuses to carry — a moved tip, an unreadable ref, a prior with
nothing resumable, a card naming another run — the dispatch writes a fresh row and emits one
`dispatch_resume_seed` line naming the reason. **A server log is not card text.** The
criterion names "no card text" as the defect and a log does not answer it: nobody looking at
the card sees it.

It cannot be met without a new surface. `work_board_items` has no free-text field to carry a
diagnostic — its text columns are `title` (sanitised; rewriting it would destroy the card's
own name) and `design_doc_ref` — and `TridentBoardBinder`, the structural surface the
dispatch chokepoint is allowed to touch, is `get` / `attachRun` / reconcile. Delivering it
means a new column plus a migration, a render in the card UI, and wiring at three
composition roots: a different change from this one, in packages this lane does not own.

Until that exists the honest state is: the retry CARRIES, and when it cannot, only the run
row and the log say so.
