## 2026-09-24 — Preserve a migration retry after startup contention

For #1263 and the concurrent-append acceptance in
`docs/plans/2026-07-02-world-class-refactor-plan.md:1861`, Nexus initialization
now keeps independent, monotonic startup and migration retry counters
(`gateway/nexus/nexus-store.ts:619`). Each permits ten retries, for at most
twenty asynchronous jitter waits plus SQLite's busy waits. Successful progress
does not reset either counter. The migration runner and SQL files are unchanged;
the body and provenance-bearing ledger INSERT remain in one transaction
(`migrations/runner.ts:1944`).

The reproduced defect is exhaustion of the shared counter before the first
migration collision. The regression fixture schedules ten real SQLite startup
BUSYs with a second connection holding an exclusive lock, then runs a separate
Nexus writer process after the losing runner's ledger read and before BEGIN
(`gateway/nexus/__tests__/fixtures/init-contention.ts:29`). The losing ledger
INSERT actually raises `_migrations.name` UNIQUE; the fixture observes that
driver error rather than fabricating it. Recovery preserves both appended events
and every field of the winner's ledger row, including timestamp, exact content
hash, distinct build commit and tree provenance
(`gateway/nexus/__tests__/init-contention.test.ts:37`).

This proves the bounded-retry defect under the constructed schedule. It does
not establish that the historical CI failure exhausted its counter in this
sequence: that run's per-attempt trace is unavailable. Historical attribution
remains unresolved; this change must not be described as reconstructing that
schedule or guaranteeing success under arbitrarily long contention.

Negative controls exercise real mid-body SQL and UNIQUE failures and a
persistent ledger UNIQUE, asserting rollback, no event, and no successful ledger
witness (`gateway/nexus/__tests__/init-contention.test.ts:65`). The latter is
retried to the existing bounded migration ceiling and then refused. Separate
tests cover startup/migration exhaustion, alternating failures, closure during a
retry, and three independent first-writer processes. The alternating and
migration-exhaustion controls explicitly inject BUSY to test the retry ceilings;
they are not reproductions of a particular SQLite scheduling history.

Validation on base `9c421a27a` plus this change, Bun 1.3.13:

- `bun test migrations/ gateway/nexus/`: 320 passed, zero failed across 31 files
  in 45.92 seconds, after restoring all temporary mutations.
- `bunx tsc --noEmit -p gateway/tsconfig.json` and the same command for
  `migrations/tsconfig.json`: passed. ESLint on all four changed TypeScript files
  and `git diff --check`: passed.
- Restoring a shared retry ceiling makes the scheduled valid race fail with the
  real ledger UNIQUE. Temporarily swallowing migration-body errors makes both
  the body-UNIQUE and missing-table refusal tests fail. Both mutations were
  restored before the final successful suite.
- The full local leak scan returned 456 findings, including linked-worktree
  metadata and matches in existing files against the local denylist. This is
  not a clean full-tree leak receipt; the gate and allowlist were not changed.
  Repository-wide tests, all-project typechecking and hosted CI were not run.

The validated source blob IDs are `0c67d45b5c389b86d72346fafb0f74d17c3b27c9`
(store), `7b0e0d0c33324bca65307b83e5c3d659776c2dec` (test),
`e433b3610aa425903bb9df1535473fb50fa325e0` (contention fixture), and
`d6f22ad1588ff71ddbf4b495e6bd6e1f7055a7a3` (writer fixture). This record does not
transfer those measurements to later source changes or claim publication.
