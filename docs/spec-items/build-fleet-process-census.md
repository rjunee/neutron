---
title: Count the local build fleet from live processes
status: done
group: trident
priority: P1
cutover: false
---

Issue #615. `/code fleet` reports the local same-user build lanes represented by
lane claims or unclaimed Codex build wrappers. It lists confirmed processes,
process start times, working directories and the PR when a matching run exists.
A lane is one claim, with all surviving processes listed beneath it; subprocesses
sharing a claim do not each consume another build slot. A dead owner does not
hide its surviving children. Run rows enrich the census but never establish life.
Cost remains explicitly unavailable pending #554.

## Acceptance

- [x] Four live lanes report four; after their processes exit, the same census
  reports zero. Verify: `python3 -B trident/lane-processes-test.py Census`.
- [x] Unreadable process evidence reports unknown, including a partially readable
  fleet, and never becomes zero. Verify: the same Python tests and
  `bun test trident/active-runs.test.ts`.
- [x] Recorded build phases cannot inflate the count. Every launch probes again;
  unknown uses the existing planned-fan-out fallback. Verify:
  `bun test trident/active-runs.test.ts gateway/__tests__/trident-active-runs-wiring.test.ts`.
- [x] `/code fleet` reports PIDs, start times, PR metadata and unavailable cost;
  metadata failures remain distinct from process failures. Verify:
  `bun test trident/active-runs.test.ts trident/code-command.test.ts`.

Scope excludes remote machines, other users and arbitrary unmarked agent sessions.
This is an observation at request time, not a reservation or a guarantee that a
process will survive after the response. The kernel supplies the evidence even
when the build or its launcher has failed.
