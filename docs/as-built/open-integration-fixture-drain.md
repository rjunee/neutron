## 2026-10-09 — Quiesce claim and import integration fixtures before DB close

The claim-redirect and import-watch integration fixtures called each composed
`realmode_cleanups` entry in a synchronous `try { c() }` loop and never awaited
it, then shut the graph down and closed SQLite. A loop tick still in flight at
teardown could therefore write to a closed database. Both fixtures now await the
existing production drain, `drainRealmodeCleanups` from `gateway/index.ts`. It was
already exported, so this change does not touch production code. The listener
stop and the graph shutdown still run in their original positions.

- `tests/integration/claim-redirect-once.open.test.ts`: `Boot.close` stops the
  server, awaits the drain and then shuts the graph down. It is memoized so the
  restart test's explicit close and the later afterEach close drain only once.
  The DB close moves out of afterEach into `closeFixture()`, which closes every
  booted stack and then closes the DB exactly once. afterEach calls it.
- `tests/integration/import-watch-rearm-on-reconnect.open.test.ts`:
  `Harness.close` stops the server, awaits the drain, shuts the graph down and
  then closes the DB. It is memoized too.
- Both fixtures now expose `composition` and `graph`. The existing tests are
  unchanged.

### Harness

`tests/support/held-sweeper-teardown.ts` boots the real Open composer and
captures the actual `chunked-upload-sweeper` `SupervisedLoop`. It does this by
patching `start` while the boot runs and keying the patch on the loop's name; the
composer registers and starts that loop in `open/wiring/uploads.ts`. The harness
seeds an expired row that is still in `uploading` and asserts that row before the
tick runs. It holds `SqliteUploadSessionStore.markExpired` for that row at a
barrier before the real SQL runs, and then drives one tick through the captured
loop's `runOnce()`. Once the tick reaches the barrier, the fixture's real teardown
starts. While the tick is held, the harness records:

- whether the teardown reached the loop's `stop`;
- whether the graph shut down, the DB closed or a later cleanup started;
- whether the teardown had already settled;
- the result of a real read of the seeded row.

After release it records:

- the result of the real write and the row's status after the write. The sweeper
  swallows DB errors, so a completed tick alone does not prove the write landed;
- the ordered event trace;
- how many times each cleanup callback was called;
- whether the loop is still active, whether the DB closed, and any unhandled
  rejections.

Every patch is restored and the barrier released in `finally`.

The harness resolves `SupervisedLoop` from the sweeper module's own directory and
the store from the composer's upload wiring, not from a bare specifier in the
test file. In a checkout with a partial install, a bare `@neutronai/loop` import
resolved to a different copy, and the start patch captured nothing.

### Commands and results

- `bun test tests/support/held-sweeper-teardown.test.ts`: 3 pass, 0 fail. This
  self-test uses the real composer and graph. It reports the awaited drain → graph
  shutdown → DB close order as clean. It detects a graph shutdown and a
  later-cleanup entry while the tick is held for the old unawaited loop. It detects
  a DB close while the tick is held, plus the failed write, when the close comes
  before the drain.
- `bun test tests/integration/claim-redirect-once.open.test.ts tests/integration/import-watch-rearm-on-reconnect.open.test.ts`:
  15 pass, 0 fail. These are the 9 existing claim-once, restart, reconnect and
  boot tests plus 3 new tests per file:
  - a held tick;
  - an earlier rejecting cleanup and an earlier throwing cleanup;
  - an empty cleanup list.
- `bash scripts/ci/lint.sh`: passed. For the typecheck result see "Fix round"
  below.

### Mutations

Each mutation was applied to one consumer, run with `bun test <that file>`, and
reverted. The restored files gave the 15-pass result above.

| Consumer | Mutation | Failing tests | Failing assertion |
| --- | --- | --- | --- |
| claim | Pre-change unawaited sync loop | held, rejection | `whileHeldViolations` contains `graph:shutdown while the tick was held` |
| claim | `await` removed from the drain in `Boot.close` | held, rejection | same |
| claim | `db.close()` moved before the server loop in `closeFixture` | held, rejection, empty | `db:close while the tick was held`; empty-list trace order |
| claim | Drain line duplicated | held, rejection | per-callback counts are 2, not 1 |
| import | Pre-change unawaited sync loop | held, rejection | `graph:shutdown while the tick was held` |
| import | `await` removed from the drain | held, rejection | same |
| import | `db.close()` moved before the drain | held, rejection, empty | `db:close while the tick was held`; empty-list trace order |
| import | Drain line duplicated | held, rejection | per-callback counts are 2, not 1 |

Under every mutation all of the existing behaviour tests still passed: 3 in
the claim file and 6 in the import file. The empty-list test also passed except
where the table lists it. No failure came from a timeout, an import error or a
syntax error.

This record covers only these two fixtures. The route-slot, activity-inspector
and durable-chatlog fixtures belong to separate cards. #1389 stays open.

Revalidation, 2026-10-09. The original change (`60b7d2d8`) was merged, with
history kept, onto main `d01f0945`. The merge applied cleanly and changed only
the five files listed above. On the merged tree:
`bun test tests/integration/claim-redirect-once.open.test.ts tests/integration/import-watch-rearm-on-reconnect.open.test.ts`
gave 15 pass, 0 fail. `bun test tests/support/held-sweeper-teardown.test.ts`
gave 3 pass, 0 fail. `bash scripts/ci/lint.sh` passed and
`git diff --check` was clean. For the typecheck result see "Fix round".

Nominated mutation, run on the merged tree: delete
`if (trace.includes('db:close')) v.push('db:close while the tick was held')`
from `tests/support/held-sweeper-teardown.ts`. Guard:
`bun test tests/support/held-sweeper-teardown.test.ts -t "db close moved before an awaited drain"`.
It went red (0 pass, 1 fail) on its own assertion,
`expect(report.whileHeldViolations).toContain('db:close while the tick was held')`.
Control: `bun test tests/support/held-sweeper-teardown.test.ts -t "awaited production drain"`
stayed green (1 pass). After the file was restored, `git diff` was empty and
the guard was green again (1 pass).

### Fix round, 2026-10-09: root typecheck and a failure-path leak

CI typecheck on head `104f7e98` failed the root `tsconfig.json` with three
errors in `tests/support/held-sweeper-teardown.ts`: TS2307 `Cannot find module
'@neutronai/loop'` at lines 53 and 63, and TS18047 `'tickP' is possibly 'null'`
at line 432. The root package does not depend on `@neutronai/loop`. In this
worktree the bare specifier resolved only through the main checkout's ancestor
`node_modules`, which is why the earlier local typecheck passed. CI has no
ancestor install.

Changes:

- The harness no longer names `@neutronai/loop` as a type. It declares the
  slice of `SupervisedLoop` it drives (`start`, `stop`, `runOnce`, `stats`) as a
  local structural interface. A relative `import('../../loop/index.ts')` type
  query was tried first; `scripts/ci/lint.sh` refused it as a cross-package
  relative type query. The runtime class is still resolved from the sweeper's
  own directory, so the prototype patch is unchanged.
- The tick promise is bound to a `const` before the race, which removes the
  TS18047 narrowing error independently of module resolution.
- `bootCapturingSweeperLoop` throws a `BootCaptureError` that carries the
  booted stack when the capture count is wrong, so a caller can still close
  it. The two import-watch held tests now assign `harness` inside the boot
  callback, so afterEach closes the stack even if the capture throws.

Measured on this round's tree:

- `node_modules/.bin/tsc --noEmit -p tsconfig.json --traceResolution`: exit 0,
  0 errors. The trace shows that the harness resolves only `bun:test`,
  `node:path`, `node:url`, `@neutronai/persistence/index.ts` and
  `@neutronai/gateway/upload/upload-session-store.ts`. It no longer resolves
  `@neutronai/loop`, so the result does not depend on an ancestor install.
- `bash scripts/ci/typecheck-all.sh`: root `tsconfig.json` pass. `app/tsconfig.json`
  fails locally (unused `@ts-expect-error` in `app/__tests__/support/mount.tsx`).
  This change does not touch `app/`, and CI did not report that failure.
- `bash scripts/ci/lint.sh`: exit 0.
- `bun test tests/support/held-sweeper-teardown.test.ts tests/integration/claim-redirect-once.open.test.ts tests/integration/import-watch-rearm-on-reconnect.open.test.ts`:
  18 pass, 0 fail.
- Nominated mutation, re-run on this tree: delete
  `if (trace.includes('db:close')) v.push('db:close while the tick was held')`.
  Guard `-t "db close moved before an awaited drain"`: 0 pass, 1 fail on
  `expect(report.whileHeldViolations).toContain('db:close while the tick was held')`.
  Control `-t "awaited production drain"`: 1 pass. Restored: guard 1 pass.

### Revalidation, 2026-10-09: merged onto main `5195c246`

The PR's current head `5b8c9d4c`, which contains the original build
`60b7d2d8`, was merged onto main `5195c246` with a merge commit, so both stay
in history. The merge applied cleanly and changed only the five files listed
above.

Two review nits were applied on top of the merge:

- In the import fixture's `Harness.close`, `db.close()` now runs in a
  `finally` after `await graph.shutdown()`. The awaited drain still comes
  before both, and the shutdown order is unchanged.
- The stale "root typecheck passed locally" lines earlier in this record were
  removed. "Fix round" holds the true typecheck result.

Measured on the merged tree with the nits applied:

- `bun test tests/integration/claim-redirect-once.open.test.ts tests/integration/import-watch-rearm-on-reconnect.open.test.ts`:
  15 pass, 0 fail.
- `bun test tests/support/held-sweeper-teardown.test.ts`: 3 pass, 0 fail.
- `bash scripts/ci/typecheck-all.sh`: root `tsconfig.json` pass. The only
  failure is `app/tsconfig.json` (the same unused `@ts-expect-error` in
  `app/__tests__/support/mount.tsx`), which this change does not touch.
- `bash scripts/ci/lint.sh`: exit 0. `git diff --check` against `5195c246`:
  clean.
- Nominated mutation in `tests/support/held-sweeper-teardown.ts`: delete
  `if (trace.includes('db:close')) v.push('db:close while the tick was held')`.
  Guard `bun test tests/support/held-sweeper-teardown.test.ts -t "db close moved before an awaited drain"`:
  0 pass, 1 fail on
  `expect(report.whileHeldViolations).toContain('db:close while the tick was held')`
  (received `[]`). Control
  `bun test tests/support/held-sweeper-teardown.test.ts -t "awaited production drain"`:
  1 pass. After restoring the file, `git diff` on it was empty and the guard
  was green again (1 pass).
