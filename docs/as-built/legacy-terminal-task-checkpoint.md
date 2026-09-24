## 2026-09-24 — Resume migrated terminal task checkpoints without inventing a plan

Issue #1252. Governing contract:
`docs/spec-items/planner-selected-execution-strategy.md:45-50,70-74` preserves
migrated checkpoint meaning and continued execution;
`docs/spec-items/a-retry-must-resume-from-the-checkpoint.md:20-32,65-69`
preserves completed work across retries.
`docs/spec-items/same-run-task-sequence-crash-handoff.md` now states the same
narrow legacy terminal exception in its contract and acceptance criteria;
modern missing-plan refusal and intermediate count/ledger agreement still bind.
This preserves the migration decision in `SPEC.md` (2026-09-23) and the locked
pivot's gates and served/live verification requirement.

A deployed retry carried a host-authenticated completed-build checkpoint with
`remainingTasks: 0`, an unchanged full commit identity, and a migrated
`task_sequence` selection. The old host recorded the validated planner remainder,
but had no persisted strategy-plan column. Retry admission accepted the terminal
checkpoint; the build driver then refused it because the new plan field was
absent. Every re-dispatch repeated the same failure before review.

`trident/build-run.ts` now recognizes that explicit terminal remainder only when
the selection source is `legacy` and no accepted plan exists. This runs inside
the existing unchanged-head and regenerated-diff checks. Positive or missing
remainders still refuse, as do conflicting persisted plans. No plan is invented,
no task handoff advances, and review, suite proof, publication and merge still
run on the measured head.

Verification: the build-driver suite passes 362 tests. New consuming tests in
`open/__tests__/project-build-e2e.test.ts` dispatch a retry through the real host
and reach unattended merge in both PR and local modes, with fresh review and no
planner or builder replay. Both root and Trident TypeScript checks pass. The
semantic mutation suite proves three changes go red: forbidding the legitimate
migrated terminal checkpoint, permitting a positive remainder, and ignoring a
conflicting persisted plan. Each mutation fails a named behavioral assertion;
the unchanged control passes.

This record establishes the repair and local evidence. The issue remains open
until deployment and a fresh live retry confirm the resumed workflow.
