## 2026-10-10 — Measured CI test-cost profile for shard partitioning (#1447)

Work state: GitHub issue #1447, under the autonomy and efficiency requirements
of #545 and #1196. The normative contract is
`docs/spec-items/host-test-suite-efficiency.md`, sections "Measured CI partition
(#1447)" and "Measured partition acceptance", which this change adds and which
reopen that item until the acceptance criteria are reconciled after merge.

### What this slice delivers

Two dependent tasks. The first (this section through "Validation evidence")
delivered the measured timing input and its collector without touching the
runner. The second ("Runner consumption" onward) replaced the runner's shard
split — special lanes dealt round-robin, only the general lane weighted by the
`BASE_COST_MS`/`MIG_COST_MS` estimate — with one measured all-lane computation
that reads the profile, and added the profile, its validator and the planner to
the portable runner closure.

- `scripts/lib/test-cost-profile.ts` — the contract. A pure module (no imports,
  no side effects) exporting `SCHEMA` (`neutron-test-cost-profile/v1`), `LANES`,
  `parseTestCostProfile`, `validateTestCostProfile`, `serializeTestCostProfile`
  and `isDiscoveredTestPath`. Every object is closed; every number must be a
  non-negative safe integer; jobs must be exactly shards `1..n`; paths must be
  unique across the measured and unmeasured sets, strictly ascending, `./`-
  relative, confined (no empty, `.`, `..`, dot-leading or `node_modules`
  segment), restricted to printable ASCII without space, quote or backslash (so
  JavaScript order equals `LC_ALL=C sort` order), bounded, and carry a suffix
  `scripts/lib/discover-test-files.sh` accepts. Per-job measured/unmeasured
  counts and cost sums must equal the records. Any violation throws
  `TestCostProfileError` for the whole input; no partial profile is returned.
  Serialization re-validates and writes fixed key order, two-space JSON and a
  trailing newline, so a canonical file round-trips byte for byte.
- `scripts/ci/collect-test-cost-profile.ts` — the collector. A pure
  `collectTestCostProfile` plus a CLI with `--out` (validate, re-parse, then
  write through a temporary file and rename) or `--check` (exit nonzero on any
  byte difference). It performs no network access.
- `scripts/lib/test-cost-profile.json` — the committed evidence. One discovered
  test path in it is named for retired vocabulary, so
  `scripts/ci/leak-gate-allowlist.txt` exempts this exact file from the
  `workspace-retired` rule only; the PII, hosted-domain and secret rules still
  scan it.

### Unit and aggregation

Unit: integer microseconds. Aggregation
(`sum-of-bun-reported-case-durations-per-file-per-execution-section`): for each
file, the exact sum of the case durations Bun printed for it inside one runner
execution section of one job. `[<d>.<dd>ms]` text is converted by string
arithmetic; more than three fractional millisecond digits, or any unit other
than `ms` (the only unit observed on case lines), is refused rather than
rounded or guessed. Bun prints no duration for very fast cases; such a case
counts toward `cases` but not `timedCases`.

### Log shapes the collector relies on

Each rule was confirmed against the four retained job logs and is pinned by a
fixture in `scripts/ci/collect-test-cost-profile.test.ts`:

- Every line carries GitHub's `<ISO-8601>Z ` prefix. A UTF-8 BOM starts each
  stored log block, so a BOM can also appear before a mid-log line; BOMs, a
  trailing CR and ANSI escapes are stripped.
- Only lines between a runner section marker (`==== chunk k/n: `,
  `==== PGLite quarantine lane: `, `==== device-harness isolation lane: `,
  `==== real-HTTP isolation lane batch k/n: `) and the next marker or
  `---- run-tests coverage audit ----` count. The pre-runner
  `bun test --isolate app/__tests__/` step (shard 4) and any other step print
  the same file headers outside a section and are ignored.
- In GitHub Actions Bun prints a file header as `##[group]<path>:` and closes
  it with `##[endgroup]`. Case lines are attributed only inside an open group.
- The process-isolation preload (`tests/support/process-test-isolation-preload.ts`)
  replays each Bun invocation inside a PID namespace. Every one of the 28
  sections therefore begins with Bun's banner and the first file header from
  the outer process, then the banner and the same header again from the replayed
  process. The outer prelude has no case line and is discarded; a second Bun
  banner after any case output is refused.
- Bun's end-of-run summary repeats skipped (or failed/todo) case lines after the
  last `##[endgroup]`, under `<N> tests skipped:`; they are not attributed to the
  last file. Each section's retained header count must equal its
  `Ran <T> tests across <M> files` count.
- A PGLite retry re-prints the lane under a new marker, so its headers repeat
  and the collector refuses the logs (headers must be unique across all jobs).
- Each job's `run-tests: SHARD k/n` must match its declared shard and shard
  count, and every job's coverage-audit `declared files: N` must equal the
  number of unique files collected across all jobs.

### Provenance and reproduction

Source: CI workflow `ci`, run 38001520250 on head
`b44be1e7dc1fd6b9cca1af5f52dd1ca020549f5f`, four shards. The profile stores
each job's id and the SHA-256 of its exact retained log bytes, never the log
text, a case name, a host path or a credential. To reproduce (logs go to a
scratch directory outside the repository and are never committed):

```
gh api --allow-escape-sequences repos/<owner>/<repo>/actions/jobs/<job-id>/logs > <scratch>/shard<k>.log   # for each job
bun scripts/ci/collect-test-cost-profile.ts --run-id 38001520250 \
  --head-sha b44be1e7dc1fd6b9cca1af5f52dd1ca020549f5f --shard-count 4 \
  --job 1=114060452722=<scratch>/shard1.log --job 2=114060452839=<scratch>/shard2.log \
  --job 3=114060452686=<scratch>/shard3.log --job 4=114060452847=<scratch>/shard4.log \
  --check scripts/lib/test-cost-profile.json
```

`--allow-escape-sequences` is required: without it `gh` refuses to print logs
that contain terminal escapes and writes nothing. `--check` on the retrieved
logs reported the committed profile reproduced byte for byte.

### Reproduced figures (measured case-time cost estimates)

These are sums of Bun-reported case durations. They exclude process start,
imports, setup outside a case and overlap, so they are planning weights, not
wall times.

| shard | job | measured files | unmeasured files | case-time sum |
|---|---|---|---|---|
| 1 | 114060452722 | 450 | 2 | 486.16441 s |
| 2 | 114060452839 | 452 | 0 | 328.01853 s |
| 3 | 114060452686 | 452 | 1 | 282.80142 s |
| 4 | 114060452847 | 449 | 3 | 260.58978 s |

1,809 unique files: 1,803 measured and 6 unmeasured.
`./open/__tests__/project-build-e2e.test.ts` is recorded in the `http` lane on
shard 1 with 628 cases, all timed, summing to 294.58432 s.

The observed CI job wall times of the same run were 536, 377, 329 and 355
seconds. Those include setup, the shard-4 app step, discovery and contention,
and are a different quantity from the case-time sums above. The simulated
makespan of the new assignment is reported under "Simulated makespan" below.

### The six unmeasured files

Six files ran but printed no timed case (every case was below Bun's duration
threshold, or skipped): two general-lane, one PGLite and three real-HTTP files.
They are recorded in `unmeasured` with their lane, shard and case count — as
**unknown** cost, never as zero. The partition rule in the spec gives such a
file, like a new or renamed one, the conservative fallback weight.

### Validation evidence

- `bun test scripts/__tests__/test-cost-profile.test.ts scripts/ci/collect-test-cost-profile.test.ts scripts/__tests__/spec-items-index.test.ts`:
  74 pass, 0 fail (18 validator, 18 collector, 38 index).
- Semantic mutations, each applied to the production module and restored:
  counting headers outside runner sections (17 collector cases fail); recording
  untimed files as zero-cost measured records (6 fail); dropping the per-job
  cost-sum check (1 fail, the totals refusal); accepting a duplicate header
  (2 fail, the cross-job and PGLite-retry refusals). Restored: all pass.
- Worker Stage 1: every test file in `scripts/__tests__/`, `scripts/ci/` and
  `scripts/ci/__tests__/` (33 files, 672 pass, 0 fail), plus the three leak-gate
  test files after the allowlist entry (81 pass, 0 fail). The full suite is run
  by the host on the terminal task.
- `bash scripts/ci/lint.sh` passes. `bash scripts/ci/typecheck-all.sh` passes
  the root `tsconfig.json` (which includes `scripts/`); its only failure is in
  `app/tsconfig.json` (`app/__tests__/support/mount.tsx`, an unused
  `@ts-expect-error` on the `react-dom/client` import), which this change does
  not touch.

### Runner consumption

- `scripts/lib/shard-partition.ts` is the one planner. Imports: only
  `./test-cost-profile.ts` and `node:fs`; no side effects on import; the CLI runs
  under `import.meta.main`. It exports `BASE_COST_MS` (150) and `MIG_COST_MS`
  (137), moved here from the runner, `MIGRATION_CALL`, `estimateMicros`,
  `lanePercentile90`, `planShards`, `formatSeconds` and the CLI body `runCli`.
  Weight: the measured `costMicros` when the exact path has a `files` record;
  otherwise `max((BASE_COST_MS + MIG_COST_MS × migration calls) × 1000, P90)`,
  where P90 is the nearest-rank 90th percentile (index `ceil(0.9·N) − 1`
  ascending) of measured costs in the file's current lane, or of all measured
  costs when that lane has none. Only fallback files are read; an unreadable one
  is fatal. Order: weight descending, path ascending, input index; each file goes
  to the shard with the lowest (weight sum, file count, index), which leaves no
  shard empty while files ≥ shards, even at weight 0. Integer microseconds
  throughout, with a safe-integer check on every sum. Input validation refuses an
  empty list, an unknown lane, an empty path or one with a tab or line break, a
  duplicate path, and a shard count outside 1..64. Records for paths no longer
  discovered are counted as stale and never execute.
- CLI: `--profile <file> --validate`, or `--shard <i>/<n>` with `<lane>\t<path>`
  lines on stdin. It computes everything before printing; a failure writes only
  `run-tests: FATAL — test cost profile invalid: …` or
  `run-tests: FATAL — shard planner: …` to stderr, with empty stdout and a
  nonzero exit.
- `scripts/run-tests.sh`, replaced in place with no flag and no second scheduler.
  `BASE_COST_MS`, `MIG_COST_MS`, `SHARD_WEIGHT_LOG`, `_slice`, the round-robin
  cursor and `_weigh_and_pack` are gone, with the comment premises that justified
  them. Inside the existing shard-spec validation, before discovery, the socket
  preflight and the Bun discovery probe, a sharded run executes
  `bun --no-env-file scripts/lib/shard-partition.ts --profile … --validate`
  (plain `bun`, never the selftests' fake) and exits 1 on failure. Unsharded runs
  never reach it. The lane split now records each file's lane, and §2c writes a
  manifest of every discovered file with its lane, runs the planner into files
  (not a process substitution, so its status is observable), and fails closed on
  a nonzero exit, a planned input or assignment total that is not the discovered
  total, a table whose row count is not `n` or whose file sum is not the total,
  an assignment count that differs from this shard's row, an empty shard while
  files ≥ shards, or any assigned path that is not a discovered file in that same
  lane. The lane arrays are rebuilt by filtering the discovery-ordered manifest,
  so each file keeps its lane and order; section 3 (lane runners, timeouts,
  retries, the audit) is unchanged. Every shard prints the whole table and
  `run-tests: shard plan simulated makespan <s>s (sum of measured case-time
  weights + fallbacks, not CI wall time); profile run <id>: <used> records used,
  <stale> stale`.

### Simulated makespan

The real planner's tables, from `NEUTRON_TEST_PLAN_ONLY=1` runs of the runner on
this branch's tree (1,812 discovered files: the profile's 1,809 plus three new
test files) with the committed profile. All 1,803 measured records are used and
none is stale; 9 files take the fallback (the 6 recorded as unmeasured and the 3
new files).

| plan | per-shard weight (s) | files per shard | fallback per shard | simulated makespan |
|---|---|---|---|---|
| 1 shard | 1398.652870 | 1812 | 9 | 1398.652870 s |
| 2 shards | 699.326440 / 699.326430 | 901 / 911 | 5 / 4 | 699.326440 s |
| 4 shards | 349.663230 / 349.663220 / 349.663210 / 349.663210 | 420 / 464 / 464 / 464 | 0 / 3 / 4 / 2 | 349.663230 s |

At four shards the largest measured per-shard sum of what the planner actually
dispatches is 349.66323 s, 71.9% of the baseline assignment's 486.16441 s (the
acceptance bound is 80%). The 1,357.57414 s of measured cost plus 41.07873 s of
fallback weight gives a mean of 349.66 s per shard, against a heaviest single
file of 294.58432 s, so the plan is at the lower bound. The Open build E2E file
sits on shard 1 with 55.08 s of other measured weight; the other three shards
carry about 349.66 s each. These are simulated sums of case-time weights, not a
prediction of job time.

### Portable closure

`PORTABLE_RUNNER_FILES` in `open/wiring/project-build-dependencies.ts` is now
exported and adds `scripts/lib/shard-partition.ts`,
`scripts/lib/test-cost-profile.ts` and `scripts/lib/test-cost-profile.json`. No
other identity logic changed: every listed file is byte-compared against the host
and digested into the runner identity, so changed bytes or a missing file refuse
portable reuse. A sharded run was already never portable (`NEUTRON_TEST_SHARD`
is outside the admitted tuning variables); the planner files are declared because
they are runner inputs. The runner-copying fixtures in
`open/__tests__/project-suite-identity.test.ts` and
`open/__tests__/project-build-e2e.test.ts` iterate the exported list. A closure
guard derives the closure from the sources (every non-comment
`${SCRIPT_DIR}/<rel>` in shell files, static `import`/`from`/`import()` in
TypeScript with only `node:` or relative specifiers allowed, JSON as leaves) and
requires set equality with the list; in-memory controls show a dropped entry and
an added relative import both mismatch, and a package import is refused.

### Mutation evidence

Each was applied to production code, run, and restored (restoration verified by
content comparison):

1. Planner ignores the profile (measured weight replaced by the content
   estimate): the 4-shard census benchmark fails, 560.7489 s against the
   388.931528 s bound; 3 of 14 shard tests fail.
2. `origin/main`'s `scripts/run-tests.sh` (round-robin special lanes, estimated
   general lane) in place of the new one: the 4-shard census benchmark fails at
   477.41582 s, and the tests that expect the plan table fail; 4 of 14 shard
   tests fail.
3. Table weights reported as 0: the weight accounting assertion fails
   (received 0); 3 of 14 shard tests fail.
4. Planner drops its last output line: the runner refuses with
   `run-tests: FATAL — shard 2 has 463 assignments but its table row says 464.`;
   5 of 14 shard tests fail.
5. Fallback weight 0: 6 of 40 planner tests fail (every fallback case and the
   CLI table).
6. Path tie-break removed (equal weights fall through to input index): the
   permutation-invariance test and the explicit tie test fail.
7. The early profile check run unsharded as well: 3 runner selftests fail,
   including the unsharded corrupt-profile case.
8. A closure entry dropped: removing the profile fails the closure guard and the
   changed-bytes identity test; removing the planner fails all three closure
   tests; removing the profile also fails the package `cost-profile` prepared
   cross-run case.

### Validation counts

Worker Stage 1 (subset evidence; the host runs the required full suite):

- `bun test scripts/__tests__/shard-partition.test.ts scripts/__tests__/run-tests-shard.test.ts scripts/__tests__/run-tests-http-lane.test.ts scripts/run-tests-selftest.test.ts scripts/__tests__/test-cost-profile.test.ts scripts/ci/collect-test-cost-profile.test.ts scripts/__tests__/discover-test-files.test.ts scripts/ci/ci-workflow.test.ts scripts/__tests__/spec-items-index.test.ts`:
  256 pass, 0 fail.
- The other 12 test files in `scripts/` and `scripts/__tests__/`: 200 pass, 0 fail.
- `bun test open/__tests__/project-suite-identity.test.ts open/__tests__/project-suite-identity-mutation.test.ts`:
  51 pass, 0 fail.
- `bun test open/__tests__/project-build-e2e.test.ts -t 'prepared cross-run'`:
  27 pass, 0 fail (bare and package launchers, including the new
  `cost-profile` variant).
- `bash scripts/ci/lint.sh` passes. `bash scripts/ci/typecheck-all.sh` passes the
  root `tsconfig.json`; its only failure is the pre-existing `app/tsconfig.json`
  error in `app/__tests__/support/mount.tsx`, which this change does not touch.

### Limits

- Shard 4 also runs the app co-residency step (`bun test --isolate
  app/__tests__/`) outside the partition, so its job carries work the table does
  not show.
- Case-time weights exclude process start, imports and setup outside a case, and
  lanes run in separate processes with different concurrency, so equal weights
  do not mean equal job times.
- New and renamed files take the fallback until the profile is regenerated from a
  newer run; the profile ages as the suite changes.

### Observed CI wall time

The builder pushes nothing before publication, so it cannot observe this
change's exact-head CI. The observed job wall times come from the published
head's exact-head CI run and are reconciled after merge against the acceptance
criteria in `docs/spec-items/host-test-suite-efficiency.md`. No observed time is
claimed here, the simulated figures above are not a forecast of it, and the
historical five-minute estimate is not promised.
