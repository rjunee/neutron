## 2026-10-09 — Quiesce the served activity fixture before DB close

**Built.** `withComposition` in `open/__tests__/activity-inspector-served.test.ts` boots the real Open composer for each served case. Its `finally` now awaits the existing production drain, `drainRealmodeCleanups` from `gateway/index.ts`, before `db.close()`. Before this change it called every registered cleanup without awaiting it and closed SQLite at once. The drain runs callbacks in registration order and continues past a rejection. A body failure still propagates after cleanup. The body also receives the fixture's `db` and `composition`. Production code and shared test support are unchanged, and all instrumentation lives in this test file.

**Regressions (4).**
- *Held sweeper tick, body returns* and *held sweeper tick, body throws.* Each seeds a known expired `uploading` row and checks that `listExpiredUploading` returns it. It then drives the real composed `chunked-upload-sweeper` loop's `runOnce()`, capturing the loop by its public `describe().name`. The tick is held at a barrier in front of the real `SqliteUploadSessionStore.markExpired`. While the tick is held, the test asserts that teardown has not settled, that the DB has not closed, and that the row still reads `uploading`. After release, the events must arrive in this order: `markExpired:entered`, `sweeper.stop:start`, `markExpired:wrote:true`, `sweeper.stop:end`, `db:closed`, `teardown:settled`. The test also checks that the loop is inactive, that every registered cleanup ran exactly once, and that the row reads `expired` after the file is reopened. In the throwing variant, the original error must survive.
- *Rejecting cleanup before a held cleanup.* Checks forward order and that neither cleanup is skipped. The DB must stay open while the second cleanup is held, and each cleanup must run exactly once. The rejecting cleanup returns a thenable that records `reject:handled` when a rejection handler is attached. Two controls bound that probe: a rejection nobody consumes records no handler, and a caller that attaches a handler and drops the error records one too. So `handled` proves only that the rejection was consumed. Continuation is proven by event order.
- *Control with no registered cleanups.* The fixture closes once and the sweeper is inactive.

Each wait is resolved by a recorded event and has a labelled 10 s guard deadline. Each test's `finally` restores the probe patches, releases its barrier and awaits disposal. An `afterEach` restores any probe still installed.

**Validation.**
- `bun test open/__tests__/activity-inspector-served.test.ts`: 12 pass, 0 fail, 98 `expect()` calls. That is the 8 original served cases plus the 4 regressions.
- `bunx tsc -p open/tsconfig.json --noEmit`: no errors.
- Mutations were applied one at a time to the fixture's `finally`. After each, the file was restored byte-identical (same SHA-256) and the suite re-run green:
  - **Drain not awaited** (`void drainRealmodeCleanups(...)`): 9 pass, 3 fail. Both held-tick cases and the rejection case failed the while-held assertion with `teardownSettledWhileHeld` and `dbClosedWhileHeld` both `true`.
  - **DB closed before the drain:** 9 pass, 3 fail. The same three cases failed the while-held assertion on `dbClosedWhileHeld: true`.
  - **Drain invoked twice:** 9 pass, 3 fail. The same three cases failed the exact-once assertion because `cleanupRunsPerTeardown` was 2 for every cleanup.
  - Under all three, the no-cleanup control and the 8 served cases passed.

This record covers only this fixture's teardown ordering. It does not claim to resolve every source of #1389's historical CI noise. The integration, route-slot and durable-chatlog fixtures are separate work.
