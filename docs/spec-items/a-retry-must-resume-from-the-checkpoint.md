---
title: Carry a dead run's checkpoint and ralph round into its retry
group: trident
status: done
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

- [x] A retry carries the dead run's `inner_checkpoint` and `ralph_round` forward, OR states
      plainly on the card that it will not. Silence fails; a new run row with
      `inner_checkpoint = null` and `ralph_round = 0` and no card text is the defect.
- [x] Planning and review tokens are not re-spent on a resume that had a checkpoint to
      resume from. Assert the governed plan is NOT regenerated from scratch.
- [x] Resume does not depend on the fire-time `detectExistingPr` probe alone. Assert the
      `local` merge-mode case, where a PR probe silently degrades to zero — a test run only
      in `pr` mode passes with the defect present.

## Shipped

The `inner_checkpoint` half landed with the salvage-resume seed (`builtButNeverReviewedSeed`
→ `dispatchBoardBoundBuild` → `TridentRunStore.create`); this item's own change added the
`ralph_round` half and the refusal diagnostics. The record is
`docs/as-built/a-retry-must-resume-from-the-checkpoint.md` (staged at
`.trident/as-built/fix/519-retry-resumes-checkpoint.md` until promoted).

**Silence is gone either way.** Every dispatch that had a prior TERMINAL run to ask about
emits one `dispatch_resume_seed` line naming `reason=resumed` with what was carried, or the
proof that failed (`branch_tip_moved`, `branch_tip_unreadable_or_absent`,
`prior_run_has_no_resumable_build`, `card_names_a_different_run`, `card_names_no_run`,
`prior_run_is_a_different_card`). The board itself is not written to: the dispatch
chokepoint's binder surface is `get`/`attachRun`/reconcile and has no free-text channel, so
the honest record is the run row (`inner_checkpoint`, `ralph_round`) plus that line.

**Still not resumed, deliberately:** a run that died at the `ralph-task-built` handoff. That
checkpoint classifies `died-before-build` — the workflow rebuilds it by design
(`resumeOnUnchangedHead` → `unknown-checkpoint`) — so carrying it would need the disposition
taxonomy widened and `reviewCapableCheckpoint` relaxed at the store's write site. It is the
one shape that could reach the cheap `plan:next` continuation planner, and it is a separate
item, not a silent extension of this one.
