## 2026-09-23 — Recover intermediate task handoffs after a same-run crash

Issue #1219 is reproducible on `f6d4facfb7223e54d7b383f6ec842ac1d0d32f66`:
the consuming project-build fixture stopped immediately after the real host wrote
`built`, `remainingTasks: 1`, and no pending reservation, before committing the
ledger. A reconstructed host reviewed and merged that first task. The regression
failed with expected `continued`, received `merged`.

The same-head resume predicate now distinguishes terminal zero-count builds from
intermediate builds (`trident/build-run.ts:492`). Every count requires the
persisted validated plan to agree with the checkpoint, and positive counts must
agree with the unchecked ledger; missing or contradictory evidence returns
`unknown`. Review found that exempting zero from this consistency check let a
checkpoint contradict its still-incomplete accepted plan. Both PR and local
consuming cases reproduced a merge before that exemption was removed.
A valid intermediate build
uses the ordinary ledger commit and durable task advancement through the shared
`handoffTask` (`trident/build-run.ts:786`), buying no new planner or builder work.
This also handles a crash after the ledger commit was checkpointed: the existing
ledger writer leaves identical committed bytes at the same head.

The consuming regressions (`open/__tests__/project-build-e2e.test.ts:2995`) cover
both crash boundaries in PR and local modes, inspect the durable iteration and
committed ledger, prove there is no intervening worker or publication, and then
build the remaining task to merge. Their honest siblings at line 3062 prove a
terminal task resumes review and merges the original built head without rebuilding.
All eight cases passed with 110 assertions. The interruption uses the real durable
writer and reconstructs the composed host over the same row, worktree, and worker
artifacts; it does not simulate an operating-system kill or a live provider.

Validation: the complete consuming project-build suite passed all 244 tests with
2,808 assertions. The socket-dependent owner fixtures required local socket
access; a sandboxed attempt had nine `EPERM` failures, and the final unrestricted
local test run passed. Another 548 focused tests passed across the driver,
mode-state, production effects, project host, spec index, and semantic mutation
suites. Root, Trident, and Open TypeScript checks and touched-file lint passed.
`trident/task-sequence-crash-mutation.test.ts`
runs an unmutated positive control, then separately restores premature terminal
reuse and refuses legitimate terminal reuse; a third mutation restores the
zero-count exemption. Each mutation fails its named behavioral test. The focused
driver cases also refuse missing count, missing plan, positive/zero count
disagreement, and ledger disagreement.

The local full-tree leak gate is not green: it reports 455 pre-existing findings
on an archive of the exact base, and the worktree scan adds one finding from its
untracked Git metadata pointer. This change does not alter that baseline or its
gate. This is local static evidence; exact merged/served identity and fresh live
acceptance remain unchecked in
`docs/spec-items/same-run-task-sequence-crash-handoff.md`.
