---
title: Quiesce the durable chatlog fixture before DB close
group: platform
status: open
priority: P1
cutover: false
legacy_ref: "#1389"
---

## Problem and scope

At investigation base `63afe3be3a83d08125999c3e95130c67cfc9ce08`,
`open/__tests__/open-app-ws-durable-chatlog.test.ts:148-174` boots a real Open
composer, production graph, and app WebSocket server. Its close function calls
cleanups without awaiting at line 170, awaits graph shutdown at line 171,
then closes SQLite at line 172. Graph shutdown is not evidence that every
composed cleanup promise settled. `gateway/index.ts:264-273` provides the
existing forward, awaited, continue-after-rejection drain; the positive
real-composer control is `open/__tests__/reflect-loop-arming.test.ts:120-137`.

Own this durable chatlog fixture and its local regressions. Integration,
route-slot, and activity-inspector fixture changes are separate work. Keep the
existing listener-stop and graph-shutdown lifecycle and chatlog assertions.
Use the production drain, without redesigning runtime shutdown or editing
shared support owned by another card.
Keep barrier instrumentation local to this fixture; the mild duplication with
the activity card is deliberate so neither waits for integration-owned support.

## Acceptance

- [ ] The real harness close awaits the existing cleanup drain before DB
      close; its `afterEach` continues awaiting close before environment
      restoration (`open/__tests__/open-app-ws-durable-chatlog.test.ts:130-137`).
- [ ] A consuming regression boots this harness and holds an actual composed
      DB-using loop tick at an explicit barrier. Assert active-loop and
      entered-tick premises. Close remains pending and the DB usable while
      held; after release the tick's DB operation finishes before DB close,
      the loop is inactive, and close settles. A fabricated loop or an extra
      deferred cleanup alone is insufficient. Observe teardown progress and
      ordered events instead of fixed microtask flushing; assert a successful
      real DB write even when the loop catches write failures. Release barriers
      on failure.
      When using the upload sweeper, seed and assert a known expired row still
      `uploading` before the tick, then assert that row enters the held
      `markExpired` operation (`gateway/upload/chunked-upload-sweeper.ts:141-164`).
- [ ] An earlier cleanup rejection does not skip a later held cleanup or
      close the DB early. Preserve registration order, settle promises without
      unhandled rejection, and keep an empty-cleanup control that closes normally.
- [ ] Count every registered cleanup through the actual consuming teardown:
      each callback runs exactly once per teardown invocation, including a
      rejecting callback. Idempotent stop behavior cannot hide a double drain.
- [ ] Independently remove the await at this consumer and move its DB close
      before draining: each mutation must fail the consuming ordering assertion.
      A duplicate-drain/invocation mutation fails the exact-once count.
      Restore each and demonstrate green. Unrelated timeouts, syntax errors,
      or import failures do not qualify.
- [ ] `bun test open/__tests__/open-app-ws-durable-chatlog.test.ts` passes with
      its existing durable replay and WebSocket behavior checks intact. Record
      any separate regression command and mutation outcomes in the
      implementation's own as-built shard.

## Saved execution plan

This entire spec is the full saved card plan. Add its complete contents through
`work_board_add.spec` in the active Neutron Open project's adopted chat and
start the returned card ID. Implement the close-path drain and consuming
regressions as one bounded change, keeping support local to this test file.
It may run concurrently with the activity fixture card because their source
edits are disjoint. Run the focused suite and semantic mutation controls,
write the evidence record, and use normal Trident review, mutation, CI, and
merge gates. No operator merge qualifies as autonomous completion. This card
does not alone resolve the wider #1389 investigation.
