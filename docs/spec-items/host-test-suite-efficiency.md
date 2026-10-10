---
title: Diagnose early and remove measured host test-suite waste
group: trident
status: open
priority: P0
cutover: true
sections: 6
criteria: 6
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

- [x] A real loopback bind denial stops the normal host runner before Bun
      discovery or a test lane starts, reports the actionable bind error, and
      exits nonzero. A bindable host closes the probe listener and runs the
      existing discovery and assigned tests; a later test failure still fails
      normally. The two directions are exercised with an actual listener on
      the allowed path and a deterministic denial seam for the forbidden path.
      Verify: `bun test scripts/run-tests-selftest.test.ts scripts/__tests__/run-tests-http-lane.test.ts`.
- [x] Open E2E timing identifies the cost of Git, database and transport setup
      per fixture across repeated runs. A chosen shared seed demonstrably
      improves the measured path while two sibling fixtures can mutate their
      own branches, refs and files without changing one another, and option
      variants still exercise their real Git and migrated database behavior.
      If no shared seed is justified, the measured result explicitly records
      that decision and no speedup is claimed. Verify: focused repeated
      `bun test open/__tests__/project-build-e2e.test.ts`, with per-phase
      measurements and before/after evidence in the implementation as-built.
- [x] A deterministic PGLite assertion failure invokes Bun once and leaves the
      lane and runner red, even if unrelated log text mentions WASM. A recognized
      transient boot failure retries within the existing budget and a succeeding
      attempt leaves the lane green. Repeated recognized transient failures stop
      at the exact ceiling and leave the runner red; a mixed failure does not
      retry. Verify attempt counts, final exit and retained diagnostics with
      `bun test scripts/run-tests-selftest.test.ts`.
- [x] On a host-selected full-suite round, a completed host receipt with exit
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
- [x] The implementation PR's required full `bash scripts/run-tests.sh` run
      completes with discovered and executed files matching, all assigned
      shards/lanes accounted for, and CI green. The as-built record distinguishes
      the audit baseline, measured implementation result, and any unproved
      efficiency hypothesis.

## Measured CI partition (#1447)

Work state: GitHub issue #1447, under the autonomy and efficiency requirements
of #545 and #1196. This slice changes only how a `NEUTRON_TEST_SHARD=<i>/<n>`
run assigns already-discovered files to shards. Discovery, the Bun cross-check,
content-derived lane membership, each lane's process isolation, serial
execution, timeout and bounded PGLite retry rule, the coverage audit, the CI
matrix width, and unsharded behaviour are unchanged. No test file is split,
skipped, excluded or edited by this slice.

Evidence. The exact-head CI run 38001520250 on
`b44be1e7dc1fd6b9cca1af5f52dd1ca020549f5f` passed on four shard jobs
(114060452722, 114060452839, 114060452686 and 114060452847) whose job elapsed
times were 536, 377, 329 and 355 seconds. Their runner execution sections hold
1,809 file headers that partition uniquely across the jobs; 1,803 of those files
report case durations. Summed by the shard that ran them, the reported case
durations are 486.16441, 328.01853, 282.80142 and 260.58978 seconds.
`open/__tests__/project-build-e2e.test.ts` alone reported 628 cases summing to
294.58432 seconds inside shard 1's serial real-HTTP lane, whose Bun summary
reported 325.48 seconds. The cause is the runner's split: the special lanes are
dealt round-robin by file index, and only the general lane is weighted, by the
`BASE_COST_MS`/`MIG_COST_MS` content estimate. A heavyweight special-lane file
therefore lands on a shard that also receives an ordinary general share.

Three quantities are distinct, and no report may substitute one for another:

- *measured cost estimate*: the per-file sum of Bun-reported case durations in
  the committed profile. It excludes process start, imports, setup outside a
  case and any overlap, so it is a planning weight, not a wall-time forecast;
- *simulated makespan*: the largest per-shard sum of those weights for an
  assignment. It is computed, never observed;
- *observed CI wall time*: a job's elapsed time in a real CI run. Only this is
  what a PR waits for. It also contains setup, discovery, the shard-4 app
  co-residency step and runner contention.

Profile contract:

- The runner reads one committed, reviewed profile,
  `scripts/lib/test-cost-profile.json`, from its own script directory. It never
  performs a network lookup, reads a credential, or reads a CI log.
- Unit: integer microseconds. Aggregation: for each file, the exact sum of the
  case durations Bun printed for it within one runner execution section of one
  job. Decimal millisecond text is converted without floating point. A file with
  no timed case is recorded as unmeasured with its case count, never as zero.
- Provenance: schema version, workflow run id, head SHA and shard count; for
  each job its shard, job id, SHA-256 of the exact retained log bytes, and its
  measured file count, unmeasured file count and cost sum. Each file record
  carries the lane and shard it was observed in. No raw log text, test name,
  host path, host or account name, or credential is stored.
- Only lines inside the runner's execution sections count: the general chunk,
  PGLite, device-harness and real-HTTP batch markers, up to the coverage audit.
  The Bun discovery probe and any step that runs before the runner also print
  file headers; counting them would falsely duplicate files. Buffered log
  timestamps are not file durations and are not used as one.
- A repository collector derives the profile byte-for-byte from retained job
  logs supplied locally, plus the run coordinates, and can re-derive and compare
  against the committed profile. The logs are retrieved with the repository's
  authenticated GitHub helper outside the repository and are never committed.
- Validation is all-or-nothing. Malformed JSON; an unknown schema, unit or key;
  a missing field; a non-integer, unsafe, non-finite or negative number; a
  duplicate or unsorted path; a path that is not a confined `./`-relative test
  path of the discovered shape; one path in both the measured and unmeasured
  sets; per-job totals that disagree with the records; or a log section whose
  header count disagrees with Bun's own file count refuses the whole input. The
  collector then writes nothing, and a sharded run exits nonzero before any test
  process starts. A timing-input failure never yields a partial list, skips
  work, or changes a red result.

Partition rule:

- In a sharded run, every discovered file of every lane enters one
  deterministic computation. A file's weight is its measured profile cost. A
  discovered file with no measured record, whether new, renamed or unmeasured,
  receives a conservative fallback: the larger of the existing content estimate
  (`BASE_COST_MS + MIG_COST_MS ×` its migration-replay call count, expressed in
  microseconds) and the nearest-rank 90th percentile of measured costs recorded
  for its current lane, or of all measured costs when that lane has none.
  Profile records for paths that are no longer discovered are counted and
  ignored; they never execute.
- Files are ordered by weight descending, then path in byte order. Each goes to
  the shard with the lowest weight sum, then the lowest file count, then the
  lowest index. Each shard runs its assigned files in their original lanes, in
  discovery order, under the existing lane rules. Every runner computes the
  same assignment from the same discovery, lane split and profile.
- Every shard prints the complete assignment table: each shard's file count,
  measured and fallback counts and weight sum. Imbalance and cross-runner
  agreement are then visible in every job log. The planner's input count must
  equal the discovered total and its assignments must sum to it. Any
  disagreement, unreadable file or helper failure is fatal.
- The profile, its validator and the planner are suite inputs. They belong to
  the measured portable runner closure in
  `open/wiring/project-build-dependencies.ts`. Changed bytes, or a runner
  dependency outside that closure, refuse portable suite reuse.

## Measured partition acceptance

- [ ] The collector reproduces the committed profile byte-for-byte from the
      retained logs of run 38001520250: 1,809 unique files, 1,803 measured and
      6 unmeasured, per-shard sums of 486.16441, 328.01853, 282.80142 and
      260.58978 seconds, and 628 cases totalling 294.58432 seconds for the Open
      build E2E file. Positive and refusal fixtures in real log shapes cover
      discovery-probe and pre-runner headers, timestamp prefixes, every lane
      marker, untimed files, a duplicate header across jobs or retry attempts,
      an orphan case line, an unknown duration unit and a header count that
      disagrees with Bun's. Each refusal writes nothing. Verify:
      `bun test scripts/__tests__/test-cost-profile.test.ts scripts/ci/collect-test-cost-profile.test.ts`.
- [ ] The validator refuses each malformed, non-finite, negative, duplicate,
      unsorted, unknown-key or path-invalid profile. A sharded runner given one
      exits nonzero without invoking a Bun test process. An unsharded run does
      not read the profile and behaves as before. Verify: the validator tests
      and `bun test scripts/run-tests-selftest.test.ts`.
- [ ] With real discovery and the committed profile, the 1/1, 2-shard and
      4-shard plans partition the discovered set exactly once, and every shard
      prints the same table. The production planner module does the same for
      1 through 8 shards on synthetic inputs. A shard is empty only when there
      are fewer files than shards. New and unmeasured files take the fallback,
      and ties resolve deterministically. Lane membership, serial real-HTTP and
      PGLite execution, timeouts and the bounded retry are unchanged. Verify:
      `bun test scripts/__tests__/shard-partition.test.ts scripts/__tests__/run-tests-shard.test.ts scripts/__tests__/run-tests-http-lane.test.ts scripts/run-tests-selftest.test.ts`.
- [ ] For four shards, the simulated makespan of the real planner output is at
      most 80% of the baseline assignment's largest measured shard sum
      (486.16441 seconds). It is also within 10% of the larger of the mean
      shard weight and the heaviest single file. A control that restores the
      previous round-robin and estimate assignment fails that benchmark.
      Dropping a file or reporting zero weight for measured files fails the
      coverage and accounting controls. Verify: the shard tests, with the
      semantic mutations recorded in the as-built.
- [ ] Portable suite identity measures the planner, validator and profile
      bytes. An unchanged closure in another worktree reuses proof. A changed
      profile or helper, or a runner dependency outside the declared closure,
      refuses it. Verify: `bun test open/__tests__/project-suite-identity.test.ts`
      and the affected prepared-build retry cases in
      `open/__tests__/project-build-e2e.test.ts`.
- [ ] The implementation's exact-head CI passes on all four shards, with
      discovered and assigned counts accounted for.
      `docs/as-built/ci-measured-test-partition.md` reports the measured
      profile, the simulated makespan and the observed job wall times
      separately, with their limits. It does not promise the historical
      five-minute estimate or claim a saving the observation does not show.
