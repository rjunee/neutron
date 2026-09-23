## 2026-09-23 — Explicit task totals and review rounds on the Work Board (#516)

The former `10.1` label hid both the task/review distinction and the size of the
remaining plan. Phone and web now show `Task 10/15 · Round 1` for Ralph progress,
`Task 10/? · Round 1` while the total is unknown, and `Round 1` for non-Ralph
builds. Terminal rows hide the counter. Metadata wraps on narrow rows.

Migration 0154 adds nullable, positive safe-integer `ralph_task_total` columns
to runs and cards. `trident/orchestrator.ts:2216` derives the total from the
completed task number plus the harvested remaining count; the refire update
records that total atomically with advancing the iteration and consuming the
old result. Later plans may increase or decrease the estimate. Stale full-row
saves cannot overwrite it. Retry creation and terminal card reconciliation
preserve the latest known estimate across database reopen and cleared links.

`trident/run-progress.ts:242` publishes the one-based `task_number` and nullable
`task_total`; the status route and both board clients consume that shape.
`app/lib/work-board-helpers.ts:351` and
`landing/chat-react/WorkBoardTab.tsx:329` render the explicit label. A total
below the current task is unknown rather than a misleading fraction.

The bounded implementation intentionally learns totals at intermediate task
harvest. It does not backfill old runs, read a live plan file during display, or
invent the first task's total from the iteration allowance. This is the latest
plan estimate in existing task-iteration numbering, not an immutable count of
original task identities. Older gateway frames without task identity show only
the review round. Escalation policy and heartbeat behavior are unchanged.

Validation: 982 focused tests passed across persistence, refire/retry,
reconciliation, progress, status/HTTP, both clients, migration snapshot and
spec-index suites. The real phone row passed 7 tests and the web row passed 44.
The explicit `open/__tests__/project-build-e2e.test.ts` run passed all 117 tests
with local fixture listeners permitted; the initial sandbox run's nine failures
were `EPERM` opening Unix sockets. Root, Trident, phone and web typechecks passed.
The full typecheck matrix passed all 51 configurations, and dependency layering
reported no new violations. The migration runner, snapshot and historical-ledger
suite passed 30 tests after updating the three explicit migration inventories.
A real refire integration additionally asserts task 10, total 15 and review
round 1 from the persisted row, derived progress and board HTTP response. A
gateway consuming test makes one persisted run row agree with `codegen_status`,
fetch and board HTTP. The web render test asserts the exact
`Task 10/15 · Round 1` text.

The rebased final-source full runner executed all 1,630 discovered files across
18 bounded-memory lanes and exited 0 with zero failed lanes: 15 general chunks,
22 PGLite files (477 tests), 42 device files (409 tests), and 162 real-HTTP
files (630 tests). The coverage audit reported 1,630 declared, discovered,
assigned and executed files.

Mutation controls were executed and restored: substituting the iteration cap
produced 80 instead of the measured total 6 and failed the atomic refire test;
restoring decimal formatting failed phone (`10.1`) and web (`2.2`) assertions.
The revised-plan test persists totals 6 → 3 → 9 and verifies each on reopen.

The local full-tree leak gate is not green: clean tracked archives of both the
unchanged base and proposed tree reported the same 453 inherited denylist
findings (165 substring and 288 word matches). No gate or allowlist was changed.
The migration ordinal guard passed against a freshly fetched base branch.
