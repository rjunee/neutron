## 2026-10-10 — Measured CI test-cost profile for shard partitioning (#1447)

Work state: GitHub issue #1447, under the autonomy and efficiency requirements
of #545 and #1196. The normative contract is
`docs/spec-items/host-test-suite-efficiency.md`, sections "Measured CI partition
(#1447)" and "Measured partition acceptance", which this change adds and which
reopen that item until the acceptance criteria are reconciled after merge.

### What this slice delivers

The first of two dependent tasks: the measured timing input and its collector.
The runner (`scripts/run-tests.sh`) does **not** read the profile yet. Its shard
split is unchanged by this slice: special lanes are still dealt round-robin and
only the general lane is weighted by the `BASE_COST_MS`/`MIG_COST_MS` estimate.
The follow-on task replaces that split with one measured all-lane computation and
adds the profile, its validator and the planner to the portable runner closure.

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
and are a different quantity from the case-time sums above. No simulated
makespan is reported in this slice, because no new assignment exists yet.

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
