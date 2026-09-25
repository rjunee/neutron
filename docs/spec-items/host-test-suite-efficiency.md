---
title: Diagnose early and remove measured host test-suite waste
group: trident
status: open
priority: P0
cutover: true
sections: 4
criteria: 5
contract_items: 0
---

# Host test-suite efficiency

Work state: GitHub issue #1298. This item specifies the host suite work prompted
by the 2026-09-25 audit recorded on that issue. The audit is evidence of a
starting point, not evidence that any optimization has shipped.

## Governing contract

The locked pivot keeps the gates (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:271-279`).
The Trident efficiency item explicitly retains the full suite, mutation proof,
leak preflight and pinned merge, with forbidden and legitimate sibling mutations
for touched guards (`docs/spec-items/trident-build-efficiency.md:190-201`).
G063 requires a host-observed zero exit to prove that the merge-gating full
suite passed; an eligible, evidenced `failed-preexisting` result instead becomes
an advisory for independent panel verification, while host-selected subset
rounds do not require a full-suite receipt. Worker claims cannot select the
scope or replace a required host receipt (`docs/trident-gates-inventory.md:148-150`).
This item changes neither that requirement nor the suite's discovered-file and
executed-file coverage audit (`scripts/run-tests.sh:19-25`, `:805-816`).

## Audit and current path

The audit's green host run reported 1,673 discovered and executed test files
across 18 bounded-memory lanes. Its 19 Bun process summaries sum to 1,827.00
seconds of process duration; that sum is not elapsed wall time. The general
chunk containing `open/__tests__/project-build-e2e.test.ts` took 496.69 seconds;
the file contributed 422.05 seconds across 309 cases. The PGLite lane took
120.47 seconds. These are observations from one run, not forecasts of savings.
See the audit comment on #1298 for the measurement and run identity.

On the current path, the runner checks dependencies before discovery
(`scripts/run-tests.sh:191-198`), then loads every discovered test file in the
Bun discovery probe (`:262-310`). A host unable to bind a local listener can
therefore spend the discovery cost before learning that real-listener tests
cannot run. The real-HTTP lane already keeps listener-opening files serial and
within the ordinary per-test timeout (`:71-87`, `:697-751`).

Each Open build E2E fixture creates a temporary origin and working repository,
initializes Git, commits and pushes a seed, then creates its migrated database
(`open/__tests__/project-build-e2e.test.ts:815-842`, `:905-921`). The real
Git, database and transport interactions are part of this test's value; their
individual cost has not yet been measured.

The PGLite lane is serial and has two extra attempts by default, but its current
loop retries *every* nonzero exit (`scripts/run-tests.sh:645-668`). That can pay
for another full lane after a deterministic assertion failure. The retry must
be earned by a positively recognized transient WASM initialization or boot
failure, not by lane membership or a generic nonzero exit.

## Required change

1. Before expensive Bun discovery in a normal real host run, make a bounded
   local socket capability preflight using a real ephemeral loopback listener.
   A failed bind produces an explicit infrastructure refusal before any test
   process starts. A successful probe closes its listener and lets the existing
   discovery, lane partition, coverage audit and normal test path proceed. Keep
   synthetic runner selftests able to test their fixture roots and fake Bun;
   these are not evidence that the real host can bind.
2. Instrument the Open build E2E fixture to measure each setup phase, including
   temporary paths, Git origin/worktree initialization and seed operations,
   database creation, and transport/host setup. Record multiple representative
   runs with the same command and environment before selecting a change. If an
   immutable Git seed materially reduces the measured cost, it may replace the
   repeated invariant setup. Every case must still get independent mutable Git
   refs, repository state, database and transport state; variations in fixture
   options must remain real. If the timings do not justify a shared seed, retain
   the independent setup and record the result. Report before/after file and
   suite-lane durations separately; do not add overlapping durations or claim
   savings from a single unpaired run.
3. Retry the PGLite lane only when its failed attempt has positive, narrow
   evidence of a transient WASM initialization or boot failure and no independent
   deterministic test failure. Preserve the configured retry ceiling, serial
   execution, per-test timeout, full attempt diagnostics, and final coverage
   accounting. Unknown failures and mixed transient/deterministic failures end
   red after one attempt.

No test deletion, file exclusion, lowered assertion, changed G063 receipt
semantics, suite skip, or guard weakening earns acceptance under this item.

## Acceptance

- [ ] A real loopback bind denial stops the normal host runner before Bun
      discovery or a test lane starts, reports the actionable bind error, and
      exits nonzero. A bindable host closes the probe listener and runs the
      existing discovery and assigned tests; a later test failure still fails
      normally. The two directions are exercised with an actual listener on
      the allowed path and a deterministic denial seam for the forbidden path.
      Verify: `bun test scripts/run-tests-selftest.test.ts scripts/__tests__/run-tests-http-lane.test.ts`.
- [ ] Open E2E timing identifies the cost of Git, database and transport setup
      per fixture across repeated runs. A chosen shared seed demonstrably
      improves the measured path while two sibling fixtures can mutate their
      own branches, refs and files without changing one another, and option
      variants still exercise their real Git and migrated database behavior.
      If no shared seed is justified, the measured result explicitly records
      that decision and no speedup is claimed. Verify: focused repeated
      `bun test open/__tests__/project-build-e2e.test.ts`, with per-phase
      measurements and before/after evidence in the implementation as-built.
- [ ] A deterministic PGLite assertion failure invokes Bun once and leaves the
      lane and runner red, even if unrelated log text mentions WASM. A recognized
      transient boot failure retries within the existing budget and a succeeding
      attempt leaves the lane green. Repeated recognized transient failures stop
      at the exact ceiling and leave the runner red; a mixed failure does not
      retry. Verify attempt counts, final exit and retained diagnostics with
      `bun test scripts/run-tests-selftest.test.ts`.
- [ ] On a host-selected full-suite round, a completed host receipt with exit
      zero proves the suite passed. An early socket refusal, exhausted PGLite
      retry, missing or unreadable receipt, or incomplete coverage cannot be
      reported as a pass. A qualifying `failed-preexisting` claim with the
      applicable failure identity and base-comparison evidence required by
      G065 remains an advisory for independent panel verification; missing
      evidence, an ineligible claim, or a newly red suite remains blocking.
      Panel vetoes remain binding. A host-selected subset round retains its existing
      no-full-suite-receipt semantics. Verify positive and negative siblings in
      `bun test trident/gates/review-suite.test.ts trident/suite-failure.test.ts open/__tests__/project-build-e2e.test.ts`
      and semantic mutations in both directions in the implementation record.
- [ ] The implementation PR's required full `bash scripts/run-tests.sh` run
      completes with discovered and executed files matching, all assigned
      shards/lanes accounted for, and CI green. The as-built record distinguishes
      the audit baseline, measured implementation result, and any unproved
      efficiency hypothesis.
