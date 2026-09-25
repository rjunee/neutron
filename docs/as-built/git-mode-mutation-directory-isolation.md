## 2026-09-25 — Isolate git-mode mutation fixtures across suite chunks

The host suite runs multiple Bun chunks at once. The git-mode mutation test
deleted the shared `.trident-mutants` directory during setup and cleanup,
while other mutation tests kept private JUnit reports beneath it. That could
remove a sibling's `report.xml` and make the sibling fail with `ENOENT` before
its guard and control assertions were evaluated.

The git-mode harness now creates one `git-mode-*` child under that parent and
removes only its own child. Its existing unmutated positive control and named
red mutants still run against the copied source. A cross-process regression
keeps a sibling report in place while the git-mode harness runs from setup
through cleanup, then checks that the sibling report remains readable.

The regression passed with the scoped cleanup, failed with `ENOENT` when the
broad parent deletion was restored, and passed again after restoration. In
separate concurrent Bun processes, the git-mode harness and isolation check
passed 13 tests, while the task-ledger, task-sequence, task-budget, and
project-driver mutation suites passed four tests. The full suite was not run
for this change. Both TypeScript projects (`tsconfig.json` and
`trident/tsconfig.json`) passed `tsc --noEmit`.
