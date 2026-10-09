## 2026-10-09 — Quiesce the durable chatlog fixture before DB close

The durable chatlog fixture (`open/__tests__/open-app-ws-durable-chatlog.test.ts`)
boots the real Open composer, the production graph and the app WebSocket
server. Its harness close called each composed `realmode_cleanups` entry in a
synchronous `try { cleanup() }` loop without awaiting it, then awaited the graph
shutdown and closed SQLite. Graph shutdown does not prove every cleanup promise
settled, so a loop tick still in flight at teardown could write to a closed
database.

The harness close now stops the listener, awaits the existing production drain
`drainRealmodeCleanups` from `gateway/index.ts` (forward order, awaited,
continues after a rejection), then shuts the graph down and closes the DB in a
`finally`. The close is memoized, so the afterEach call after a test's own close
returns the same promise and cannot drain twice. The harness now exposes
`composition` and `graph`. afterEach still awaits the close before it restores
the environment. No production code changed.

### Local instrumentation

The barrier instrumentation lives in this test file. It is modelled on the
integration fixtures' `tests/support/held-sweeper-teardown.ts` but does not
import it: that support is owned by the integration card, and the duplication
keeps the two cards independent. The file resolves `SupervisedLoop` from the
upload sweeper's own directory and `SqliteUploadSessionStore` from the
composer's upload wiring directory, so the prototype patches hit the same module
records the composer used.

The driver:

- captures the composer's started `chunked-upload-sweeper` loop by patching
  `start` during the boot only;
- seeds an expired row still in `uploading` and asserts that before the tick;
- asserts the loop is active in the loop registry;
- holds `markExpired` for that row at a barrier before the real SQL runs, then
  drives one tick through the captured loop's `runOnce()` and waits for it to
  enter the held write;
- starts the harness's real `close()` and waits on events (the close reaching
  the held loop's `stop`, or settling), never on time;
- while held, records a graph shutdown, a DB close or a later cleanup entry,
  whether the close had settled, and a real read of the seeded row;
- after release, records the real write's result (the sweeper swallows write
  errors, so tick completion proves nothing), the ordered trace, per-cleanup
  call counts, the loop's active state, whether the DB closed, and unhandled
  rejections.

Every patch is restored and the barrier released in `finally`.

### Regressions

- `harness close quiesces a held composed sweeper tick before DB close`.
- `an earlier rejecting cleanup does not skip the later held cleanup or close
  the DB early`: an async rejection and a sync throw are registered ahead of
  every composed cleanup. Both are called once, reject in registration order
  before the sweeper stop, and cause no unhandled rejection.
- `an empty cleanup list still closes normally (control)`: the composed loops
  are drained outside the close under test; the close then runs graph shutdown
  and a single DB close and settles.

### Commands and results

- `bun test open/__tests__/open-app-ws-durable-chatlog.test.ts`: 13 pass, 0 fail
  (the 10 existing durable replay, WebSocket, native model and typing tests plus
  the 3 regressions).
- `bash scripts/ci/typecheck-all.sh`: every tsconfig passes except
  `app/tsconfig.json`, which fails with the same unused `@ts-expect-error` in
  `app/__tests__/support/mount.tsx` on the base without this change.
- `bash scripts/ci/lint.sh`: passed. `git diff --check`: clean.

### Mutations

Each mutation was applied to the harness close alone, run with the focused
command above, and reverted. The restored file gave the 13-pass result above.

| Mutation | Failing tests | Failing assertion |
| --- | --- | --- |
| `await` on the drain replaced by `void` | held, rejection | while-held violations contain `graph:shutdown while the tick was held` |
| `db.close()` moved before the drain | held, rejection, empty control | `db:close while the tick was held`; the control's trace puts `db:close` before `graph:shutdown` |
| drain line duplicated | held, rejection | per-cleanup counts are `2`, not exactly `1` |
| original unawaited sync loop | held, rejection | `graph:shutdown` and later `cleanup:N:enter` while the tick was held |

None failed by timeout, syntax or import error.

The route-slot, activity-inspector and integration fixtures are separate cards.
This change does not by itself close #1389.
