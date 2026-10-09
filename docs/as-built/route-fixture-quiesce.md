## 2026-10-09 — Route-slot fixture teardown awaits the realmode cleanup drain

Refs #1389 (left open: this is one bounded slice, and no claim is made about
which fixture first emitted the historical closed-database CI error).

`open/__tests__/route-slot-coverage.test.ts` boots the real Open composer and
`composeProductionGraph`. Its `probeComposedSurfaces` `finally` block called
every `composition.realmode_cleanups` entry without awaiting it, then awaited
`graph.shutdown()` and closed SQLite. An async cleanup, such as the upload
sweeper's quiescing `stop()` waiting on an in-flight tick, could still be
writing when the database closed.

What changed:

- New helper `open/__tests__/route-slot-fixture-teardown.ts` exports
  `teardownComposedFixture({ cleanups, graph, db })`. It awaits the existing,
  already-exported production drain `drainRealmodeCleanups` from
  `gateway/index.ts`, then `graph.shutdown()`, then `db.close()`. No second
  drain was written and `gateway/index.ts` is unchanged (no export edit was
  needed), so forward order and continue-after-throw-or-rejection come from the
  production code.
- The fixture's `finally` block is now one `await teardownComposedFixture(...)`
  call plus its import. No other line of the fixture changed.
- New regression `tests/integration/route-fixture-quiesce.open.test.ts`. It
  lives beside the other consumers of the shared root harness because a
  workspace test may not import root `tests/support/` code by relative path
  (the cross-package import lint), and it imports the fixture helper by its
  `@neutronai/open` specifier.

The held-tick cases reuse the shared harness
`tests/support/held-sweeper-teardown.ts` (added by #1465 for the claim and
import integration fixtures; its own self-test sits beside it) rather than a
second copy. `bootCapturingSweeperLoop` captures the `chunked-upload-sweeper`
loop the Open upload wiring really starts, `runHeldSweeperTeardown` seeds an
expired `uploading` row, drives one real tick through that loop, parks it
inside the real `markExpired` write and runs this fixture's own teardown
(`teardownComposedFixture`) against it, and `expectQuiescedTeardown` asserts
the report. The harness resolves the patched classes from the consumers' own
directories, so the regression no longer imports `SupervisedLoop` itself, and
it always releases the barrier and awaits both the tick and the teardown, so a
failing assertion cannot leave teardown running after the test. The fixture's
booted stack is assigned inside the boot and closed by `afterEach` through a
memoized `close()`, so a failed precondition never leaks it.

The regression's cases:

- Held tick, with a trailing cleanup appended: while the tick is held the
  teardown has reached the sweeper's `stop()` but has not shut the graph down,
  closed the DB or entered any later cleanup, and is still pending; the row
  still reads `uploading` from the open DB. After release the real write lands
  (`expired`), then graph shutdown, then exactly one DB close; every cleanup
  ran once and the loop is inactive.
- Held tick behind an earlier rejecting and synchronously throwing cleanup:
  the same contract holds, and both injected cleanups are drained before the
  sweeper's `stop()` is entered.
- Settled control: no tick in flight, a pre-handled rejecting and a throwing
  cleanup first and a trailing cleanup last (which sees the DB still open).
  Teardown traces `graph:shutdown, db:close, teardown:settled` and every
  cleanup ran once.
- Empty cleanups still shut down and close.
- Source guard on the fixture (requires the helper call, forbids a
  `for (... of composition.realmode_cleanups` loop) with a positive control
  that the regex matches the old loop.

Measured evidence (focused local runs of the regression file):

- Green with the drain: 6 pass, 0 fail.
- Reversal, helper reverted to the synchronous loop: both held-tick cases
  fail (0 pass, 2 fail under `-t "held upload-sweeper tick"`) on the
  while-held ordering assertion, which reports graph shutdown and later
  cleanups entered while the tick was held; the settled control stays green
  (1 pass). Restored, green.
- Duplicate drain call in the helper: the exact-once counts fail in both
  held-tick cases and the settled control (3 pass, 3 fail). Restored, green.
- The source guard pair is unchanged from the first round, where inlining the
  old loop back into the fixture `finally` failed it.

Together, `route-slot-coverage.test.ts` and the regression ran green. The full
host suite is run separately by host review and is not claimed here.
