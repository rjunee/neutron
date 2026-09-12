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
- [ ] Planning and review tokens are not re-spent on a resume that had a checkpoint to
      resume from. Assert the governed plan is NOT regenerated from scratch.
- [ ] Resume does not depend on the fire-time `detectExistingPr` probe alone. Assert the
      `local` merge-mode case, where a PR probe silently degrades to zero — a test run only
      in `pr` mode passes with the defect present.
