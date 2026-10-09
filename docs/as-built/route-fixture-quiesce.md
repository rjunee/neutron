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
- New regression `open/__tests__/route-fixture-quiesce.test.ts`.

Why the upload sweeper is the held loop. A synthetic loop or an appended
deferred callback would only show that the helper awaits something. The
chunked-upload sweeper is a loop the Open upload wiring really registers
(`chunked-upload-sweeper` in the loop registry), its `stop()` is the cleanup
the wiring really pushes, and its tick does a real SQL transaction
(`markExpired`) on an expired `uploading` row. The test captures the composed
`SupervisedLoop` by patching `start` during composition, seeds one expired row,
drives one real `runOnce()`, and parks it inside `markExpired` behind a barrier.
Because the sweeper swallows `markExpired` errors, the write's own outcome is
recorded and asserted (`markExpired:true`, never `markExpired:failed`).

The regression's cases:

- Held tick: with a pre-handled rejecting cleanup inserted first and every real
  cleanup wrapped in a counter, teardown starts while the tick is parked. Once
  the sweeper's `stop()` has been reached, graph shutdown and DB close have not
  run, teardown is unsettled, and the row still reads `uploading` from the open
  DB. After release the write succeeds, then graph shutdown, then DB close; the
  sweeper loop is inactive and every cleanup ran exactly once.
- Settled control: no tick in flight, a rejecting and a synchronously throwing
  cleanup first, and a marker cleanup last. Events end
  `after-rejection, graph.shutdown, db.close` and every cleanup ran once.
- Empty cleanups still shut down and close.
- Source guard on the fixture (requires the helper call, forbids a
  `for (... of composition.realmode_cleanups` loop) with a positive control
  that the regex matches the old loop.

Measured evidence (focused local runs of the regression file):

- Red before the fix, helper body copied verbatim from the old synchronous
  loop: 4 pass, 1 fail. The held-tick case failed on
  `not.toContain('graph.shutdown')` with events
  `markExpired:entered, sweeper.stop, graph.shutdown`.
- Green with the drain: 5 pass, 0 fail.
- Reversal, helper reverted to the synchronous loop: 4 pass, 1 fail, the same
  ordering assertion; settled control and guards stayed green. Restored, green.
- Guard reversal, old loop inlined back into the fixture `finally`: the source
  guard failed (1 pass, 1 fail for the guard pair), on the helper-call
  assertion; with the loop added beside the helper call it failed on the loop
  regex instead. Restored, green.
- Duplicate drain call in the helper: the exact-once counts failed in both the
  held-tick case and the settled control (3 pass, 2 fail). Restored, green.

Together, `route-slot-coverage.test.ts` and the regression ran 10 pass,
0 fail. The full host suite is run separately by host review and is not
claimed here.
