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
  the DB early`: an async rejection and a cleanup that throws synchronously
  are registered ahead of every composed cleanup. Both are called once, fail in
  registration order before the sweeper stop, and cause no unhandled rejection.
  The driver's counting wrapper is not `async`, so the second cleanup reaches
  the drain's `await cleanup()` as a real synchronous throw (traced
  `reject-sync`), not as a rejected promise.
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

### Review follow-up (2026-10-09)

This resumes PR #1478. Its approved head `b4763b78` is merged unchanged onto
main, and a follow-up commit adds the two review nits:

- The earlier-rejection regression now checks that `cleanup:1:reject` is present
  (`>= 0`) before its ordering assertion. Without that, a missing event's `-1`
  index would satisfy the `toBeLessThan` assertion vacuously.
- The empty-cleanup control now patches `graph.shutdown` and `db.close` inside
  its `try` and restores both in `finally`. It reassigns the original or deletes
  the own property, the same way the held-close driver does.

The checks were run again on the merged tree:

- `bun test open/__tests__/open-app-ws-durable-chatlog.test.ts`: 13 pass, 0 fail.
- Removing the drain `await` fails the held and rejection tests: while-held
  violations contain `graph:shutdown while the tick was held`.
- Moving `db.close()` before the drain fails the held, rejection and
  empty-control tests with `db:close while the tick was held`. In the control
  trace, `db:close` comes before `graph:shutdown`.
- Duplicating the drain line fails the held and rejection tests: the
  exact-once counts assertion receives `2`, not `1`.
- After each mutation was reverted, the focused run was back to 13 pass.
- `bash scripts/ci/typecheck-all.sh` fails only on `app/tsconfig.json`, the same
  pre-existing unused `@ts-expect-error` in `app/__tests__/support/mount.tsx`.
- `bash scripts/ci/lint.sh` passed and `git diff --check` is clean.

### Second review follow-up (2026-10-09)

Fix round 1 on PR #1478 lands the two synthesis nits in
`open/__tests__/open-app-ws-durable-chatlog.test.ts`:

- The earlier wording said the rejection test registered a "sync throw", but
  the driver wrapped every cleanup in an `async` function, so the drain only
  ever saw a rejected promise. The wrapper is now sync-transparent: it calls the
  original cleanup directly, rethrows a synchronous throw synchronously (traced
  `cleanup:N:reject-sync`) and chains only a returned promise (traced `settle` or
  `reject`). The rejection test asserts `cleanup:1:reject-sync` is present and
  ordered before the sweeper stop, and that cleanup 0 rejected asynchronously
  and cleanup 1 never produced a promise.
- The empty-cleanup control asserts that the sweeper loop is active in the
  registry before the out-of-band drain. After the drain it asserts the loop is
  inactive (`isActive()` is false) and the captured loop is not running, all
  before the close under test.

The checks were run again on this head:

- `bun test open/__tests__/open-app-ws-durable-chatlog.test.ts`: 13 pass, 0 fail.
- `await` on the drain replaced by `void`: the held and rejection tests fail.
  Their while-held violations contain `graph:shutdown while the tick was held`.
- `db.close()` moved before the drain: the held, rejection and empty-control
  tests fail. The first two report `db:close while the tick was held`, and in
  the control's trace `db:close` comes before `graph:shutdown`.
- Drain line duplicated: the held and rejection tests fail on the exact-once
  counts assertion, which receives `2`, not `1`.
- After each mutation was reverted (byte-identical file), the focused run was
  back to 13 pass.
- The host suite's only red, `runtime/adapters/claude-code/persistent/__tests__/tool-bridge.test.ts`
  (`/tool-call dispatches against the registry...`, an ECONNRESET on a localhost
  fetch in the real-HTTP lane), was re-run alone three times on this head. It
  passed 16 out of 16 each time. This diff does not touch that file or its
  subsystem.
- `bash scripts/ci/typecheck-all.sh` fails only on `app/tsconfig.json`, the same
  pre-existing unused `@ts-expect-error` in `app/__tests__/support/mount.tsx`.
