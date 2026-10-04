---
title: Quiesce claim and import integration fixtures before DB close
group: platform
status: open
priority: P1
cutover: false
legacy_ref: "#1389"
---

## Problem and scope

At investigation base `63afe3be3a83d08125999c3e95130c67cfc9ce08`,
`tests/integration/claim-redirect-once.open.test.ts:95-103` calls composed
cleanups without awaiting them; its outer teardown closes SQLite at line 158.
`tests/integration/import-watch-rearm-on-reconnect.open.test.ts:220-224`
has the same ordering gap. The observed CI noise in #1389 has not been
attributed to a particular fixture; these are independently observed defects.

Use the existing `drainRealmodeCleanups` (`gateway/index.ts:264-273`): it
awaits callbacks in registration order and continues after throws/rejections.
`SupervisedLoop.stop()` already awaits an external caller's in-flight tick
(`loop/index.ts:353-373`). The real-composer positive control is
`open/__tests__/reflect-loop-arming.test.ts:120-137`; the following test at
line 141 exercises a separately constructed loop, so neither alone measures
these two consumers' DB-close boundary.

Limit implementation to these two integration fixtures and a dedicated test
support/regression harness. The route-slot, activity-inspector, and durable
chatlog fixture changes belong to separate cards. Preserve production drain
semantics; no runtime shutdown redesign, timing sleeps, log suppression, or
new cleanup implementation is needed.

A feasible seam is the composed upload sweeper: registration/start and awaited
stop are at `open/wiring/uploads.ts:186-201`; its tick awaits
`markExpired` at `gateway/upload/chunked-upload-sweeper.ts:164`. Hold that
store operation before its real SQL update
(`gateway/upload/upload-session-store.ts:156-170`). Restore any instrumentation.

## Acceptance

- [ ] A deterministic harness boots the real Open composer and holds an actual
      registered loop's DB-using tick at an explicit barrier. It proves the
      tick entered and the loop was active before teardown; it does not merely
      append an unrelated deferred cleanup or construct a standalone loop.
- [ ] Both fixture teardown paths await the existing drain before their DB
      close. Through each actual consuming teardown path, the DB stays usable
      and teardown remains pending while the tick is held. After release the
      tick completes its DB operation, teardown settles, the loop is inactive,
      and the DB closes. Observe teardown progress and an ordered event trace,
      not a fixed microtask flush. Assert the real DB write succeeds: the
      sweeper catches DB errors, so tick completion alone is insufficient.
      Release barriers and drain resources in failure paths.
- [ ] Registration order and continue-after-rejection remain observable through
      the fixture path: an earlier rejecting cleanup cannot skip a later held
      cleanup or permit DB close before it settles. All promises settle without
      an unhandled rejection. An empty cleanup list still closes normally.
- [ ] Each consumer is independently mutation-sensitive: removing its await
      fails the ordering assertion; moving its DB close before the drain also
      fails. Restore each mutation and demonstrate green. A timeout, unrelated
      assertion, or syntax/import failure is not the nominated failure.
- [ ] Existing claim-once/restart and import reconnect/boot controls still pass:
      `bun test tests/integration/claim-redirect-once.open.test.ts
      tests/integration/import-watch-rearm-on-reconnect.open.test.ts`.
      Run the new focused regression file too if it is separate, and record
      its exact command and mutation outcomes in this change's as-built shard.

## Saved execution plan

This entire spec is the full saved card plan; pass its complete contents to
`work_board_add.spec`, not a title or this section alone. Build in the active
Neutron Open project through its adopted project chat.

Three dependent tasks have separate evidence-bearing outputs:

1. Build the controlled real-composer tick harness and prove it distinguishes
   awaited drain from early DB close. Establish the real tick/DB barrier before
   touching the two consumers; place reusable support under `tests/support/`.
2. Make both integration fixtures consume the production drain, retaining
   their listener and graph shutdown behavior. Connect the step-1 harness to
   their actual close functions, including claim's outer DB-close owner.
3. Complete consumer-specific rejection/empty and mutation controls using the
   wired fixtures; run their existing behavior suites and write the as-built
   evidence. This depends on the harness and both consumer migrations.

The planner decides the genuine execution mode from these dependencies. Do not
force, relabel, or fabricate `task_sequence` evidence. Use the normal Trident
review, mutation, CI, and merge path; an operator merge cannot establish the
autonomous completion criterion in
`the-orchestrator-owns-the-build-loop.md:101-103`. This card fixes only its two
fixtures and does not close the broader #1389 investigation by itself.
