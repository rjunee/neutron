---
title: Show durable Claude quota waits on the Work Board
group: trident
status: open
priority: P0
cutover: true
---

When all available Claude accounts are full, an active card shows
`Waiting for Claude quota`, the known reset time or `Reset time unavailable`,
and automatic resumption. It remains in progress and keeps its current run
binding. Quota wait is an optional progress field, not a new run phase.

The current host checkpoint's pending step and the authenticated native child
binding govern the read. Durable `claude-quota-waiting` events carry
`{stepId, childId, retryAtMs}`; matching `claude-quota-resumed` or
`claude-quota-wait-ended` clears the notice. The authenticated producer records
`claude-native-child-bound` before waiting. For nested review and synthesis,
that binding retains `parentStepId` from the original authenticated host
dispatch; it matches the current pending step while quota state still matches
the child's actual `stepId` and `childId`. Missing parent evidence permits only
an exact direct-step match, never inference from step spelling. Unknown reset
time remains null.
Terminal runs, completed checkpoints and subsequent host steps supersede prior
waiting. A replacement binding supersedes only the same actual child step;
resuming a concurrent sibling cannot hide another current child's wait. The
projection selects one still-waiting current child. Foreign runs, steps and
child identities cannot relabel the current card. Queries return at most three
selected rows.

HTTP and push use the same server projection. Web and phone decode the optional
field and render explicit text. Waiting suppresses the start control while
preserving the lane, task/review counters, budget and attempt history. The
existing continuity and dispatch contract remains owned by
[`a-gateway-restart-keeps-the-project-repls`](a-gateway-restart-keeps-the-project-repls.md)
and [`claude-same-agent-continuation`](claude-same-agent-continuation.md).

## Acceptance

- [ ] Current authenticated waits render known and unknown reset times; rejecting
      all waits fails the accepting controls in `trident/run-progress.test.ts`.
      Nested review/synthesis waits require the original authenticated enclosing
      step; ignoring that mapping fails the foreign-step refusing controls.
      Verify `trident/quota-wait-projection.test.ts` and the consuming native
      synthesis case in `open/__tests__/project-build-e2e.test.ts`.
- [ ] Matching resume/end, settlement, terminal outcome and current identity
      changes clear waiting; preserving stale waiting fails refusing controls.
- [ ] HTTP and pushed projection read bounded durable state, survive a store
      restart, and exclude unrelated ledger noise and foreign child events.
      Verify `gateway/http/work-board-surface.test.ts` and the production wiring
      check in `open/__tests__/open-work-board-fan-scoped-topics.test.ts`.
- [ ] Both client parsers retain valid waits, reject malformed fields, and accept
      older frames. Phone and web rendering clears the notice on a new snapshot;
      terminal and foreign-bound frames cannot show it. Verify the existing
      Work Board client, helper and render tests on both surfaces.
