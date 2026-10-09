---
title: Quiesce the route-slot coverage fixture before DB close
group: platform
status: open
priority: P2
cutover: false
legacy_ref: "#1389"
---

## Problem and scope

`open/__tests__/route-slot-coverage.test.ts` boots the real Open composer and
runs `composeProductionGraph`. Its `probeComposedSurfaces` `finally` block
calls each `composition.realmode_cleanups` entry without awaiting it, then
awaits `graph.shutdown()` and closes SQLite. An async cleanup, such as a
quiescing loop `stop()` parked on an in-flight tick, can still be running
when the database closes.

The production drain `drainRealmodeCleanups` (`gateway/index.ts`) already
awaits each cleanup in registration order, logs and continues after a throw
or rejection, and always resolves. This slice makes this one fixture consume
that drain. It does not write a second drain, change gateway shutdown
semantics, or touch the activity-inspector, durable-chatlog, integration or
sequence fixtures. It refs #1389 and does not close it: no claim is made
about which fixture first emitted the historical CI error.

## Acceptance

- [x] The fixture teardown awaits the existing `drainRealmodeCleanups`
      before `graph.shutdown()` and `db.close()`, through a small shared
      teardown helper the fixture calls. No cleanup loop is reimplemented.
- [x] A regression boots the real Open composer and holds an actually
      registered DB-using loop tick (the composed chunked-upload sweeper,
      held inside `markExpired` on a seeded expired `uploading` row) behind an
      explicit barrier. While held, teardown is pending, graph shutdown and DB
      close have not run, and the DB is usable. After release the real DB
      write succeeds before close, teardown settles, and the loop is inactive.
      Progress is observed through ordered events, not timing.
- [x] Over-refusal control: with every cleanup already settled, and an
      earlier rejecting cleanup, teardown still completes promptly, runs every
      later cleanup exactly once in forward order, then shuts the graph down
      and closes the DB, without an unhandled rejection.
- [x] Before the fix (the current synchronous loop) the held-tick regression
      fails on its ordering assertion; reverting the helper to the synchronous
      loop fails it again. Inlining the old loop back into the fixture fails
      the fixture source guard. Each mutation is restored and re-run green; a
      syntax, import or timeout failure does not count as mutation evidence.
- [x] `bun test open/__tests__/route-slot-coverage.test.ts` keeps all its
      existing assertions green, and the new regression file passes.
