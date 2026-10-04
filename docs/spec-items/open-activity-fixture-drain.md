---
title: Quiesce the served activity fixture before DB close
group: platform
status: open
priority: P1
cutover: false
legacy_ref: "#1389"
---

## Problem and scope

At investigation base `63afe3be3a83d08125999c3e95130c67cfc9ce08`,
`open/__tests__/activity-inspector-served.test.ts:117-158` builds a real Open
composition and serves its activity handler. Its `finally` calls cleanups at
line 151 without awaiting their promises, then closes SQLite at line 156.
The existing production `drainRealmodeCleanups` at `gateway/index.ts:264-273`
already awaits callbacks in registration order and continues after rejection.
The positive real-composer cleanup control is
`open/__tests__/reflect-loop-arming.test.ts:120-137`.

Own only this activity fixture and its local regression tests. The integration,
route-slot, and durable-chatlog fixture cards are independent. Use the existing
drain; preserve the served activity behavior. Production shutdown changes and
shared support changes used by another card are outside this slice.

## Acceptance

- [ ] `withComposition` awaits the existing production drain in `finally`
      before closing its DB, on both a successful body and a throwing body.
      The original body failure remains observable after cleanup.
- [ ] A regression drives this actual fixture and holds a real composed
      DB-using loop tick behind an explicit barrier. Assert the loop was active
      and the tick entered. While held, teardown is pending and the DB is
      usable; after release its DB operation completes before close, teardown
      settles, and the loop is inactive. Observe teardown progress and ordered
      events instead of fixed microtask flushing; assert the real DB write
      succeeds, since a loop can catch its write failure. A standalone synthetic loop or an
      appended deferred callback alone cannot establish this criterion.
- [ ] A rejecting cleanup preceding a later held cleanup does not skip the
      latter or close early; preserve forward order and avoid unhandled
      rejections. The no-cleanup control completes normally. Test failure
      paths release the tick and dispose the composition.
- [ ] Removing the consumer's drain await and independently moving DB close
      ahead of the drain each fail a specific teardown-order assertion.
      Restore each mutation and re-run green; syntax/import failures and
      unrelated timeouts do not count as mutation evidence.
- [ ] `bun test open/__tests__/activity-inspector-served.test.ts` passes,
      retaining its served activity assertions. Record any separate focused
      regression command and both mutation results in the implementation's
      own as-built shard.

## Saved execution plan

This entire spec is the full saved card plan. Add it through
`work_board_add.spec` in the active Neutron Open project's adopted chat, then
start the returned card ID. Implement the fixture drain and its consuming
barrier controls as one bounded change. Keep test support local to this fixture
so it can run concurrently with the durable-chatlog card without sharing edits.
Run the focused suite, demonstrate both semantic mutations, and record the
actual results. Follow the normal Trident review, mutation, CI, and merge
gates. Do not merge the implementation PR manually or claim that this fixture
alone resolves every source of #1389's historical CI noise.
