## 2026-09-25 — Measure Open build fixtures and copy independent Git seeds

This is the Open fixture part of #1298, governed by
[`host-test-suite-efficiency`](../spec-items/host-test-suite-efficiency.md).
It does not complete that item's host-runner, full-suite or CI requirements.

`open/__tests__/project-build-e2e.test.ts:904` keys an immutable ordinary Git
seed by its fixture options. The first occurrence still initializes real Git
repositories and commits/pushes the option-specific files; it then copies a
private template. Later occurrences physically copy both the bare origin and
working repository, and set their own absolute origin URL. Bun-workspace
fixtures always execute their independent tarball/install/lifecycle setup and
all its original assertions; their Git state and Bun cache are never reused.
The template never becomes a
host workspace and is removed after the file's tests (`:90`). Each fixture still
opens its own migrated database and constructs its own transport (`:1015`,
`:1027`). No suite assertion or production gate changes.

The timing diagnostic records temporary paths, Git initialization, seed-file
creation, commit/push or template copy, database, wiring, prepare calls and
cleanup. Set `OPEN_E2E_FIXTURE_TIMING=1` to emit the JSON receipts. Prepare and
cleanup are nested within case duration; they must not be added to it. Template
cleanup happens after all cases and is included only in process duration.

### Repeated matched fixture measurements

The earlier single-fixture audit saw roughly 258 ms of database setup. That is
largely the first migration-template construction in a fresh process:
`tests/support/migrated-db.ts:93` returns its existing template on later calls,
then seeds an independent file (`:207`). The repeated eight-fixture baseline
instead measured a 288.917 ms cold database median and 7.649 ms warm median.
Database behavior was retained; the corresponding candidate medians were
263.712 ms and 7.850 ms. These measurements do not justify a database speedup.

Before: instrumentation commit `a9801fec35938b380bba9de828418505dbad67fe`.
After: consuming test source Git blob `bdb13d1b9e43d110a613f1802e88ffb93d7db6c9`.
Both used Bun 1.3.13, the same installed dependencies, environment and command:

```sh
OPEN_E2E_FIXTURE_TIMING=1 bun test open/__tests__/project-build-e2e.test.ts -t 'attempt accounting'
```

Three sequential runs per version, eight passing cases per run, 161 assertions
per run. The paired receipt below matches fixture sequence and options across
those runs. Values are per-fixture medians in milliseconds. Git setup includes
seed-file creation and all Git/template phases, including the cold copy cost.

| Fixture / option | Before Git setup | After Git setup | Before DB | After DB |
|---|---:|---:|---:|---:|
| 1: default, cold process/template | 92.437 | 90.789 | 288.917 | 263.712 |
| 2: valid Codex review, warm | 91.195 | 16.099 | 8.833 | 7.620 |
| 3: wrong-run Codex review, warm | 84.072 | 22.927 | 9.784 | 8.089 |
| 4: native usage, warm | 85.671 | 15.125 | 7.649 | 7.522 |
| 5: default, warm | 93.398 | 16.193 | 7.867 | 7.850 |
| 6: default, warm | 81.624 | 13.676 | 6.884 | 7.812 |
| 7: default, warm | 84.640 | 16.753 | 6.900 | 6.855 |
| 8: blocked review plus native usage, warm | 88.230 | 17.246 | 6.581 | 8.329 |

Across all 21 warm observations per version, Git setup median fell from
85.671 ms to 15.653 ms. Median total Git setup per eight-fixture run fell from
713.310 ms to 217.708 ms. The cold first fixture still pays initialization plus
template copying; its measured variation does not establish a cold-path saving.
This supports retaining the shared immutable seed and independent mutable copies.

Focused process durations were 11.22 / 11.56 / 11.35 seconds before and
11.11 / 11.20 / 11.71 seconds after. Their overlap does not establish a reliable
whole-file or suite-lane speedup. The phase saving above is the measured result.
Raw local receipts are `neutron-1298-open-fixture-multicase{1,2,3}.log` and
`neutron-1298-open-fixture-final{1,2,3}.log`.

### Consuming proof and limits

The new consuming fixture test (`open/__tests__/project-build-e2e.test.ts:1188`)
mutates one sibling's files, branch and bare-origin refs, checks another sibling
and a later copy remain unchanged, and checks independent database rows. It
also exercises ledger-free, specification-bearing and failing-suite variants
against their valid default siblings. It passed with 28 assertions.

Both semantic mutation controls failed as intended and were restored: replacing
the copied working repository with a template symlink leaked `sibling mutation`
into the later fixture; refusing the supported ledger-free variant rejected its
legitimate consumer. Neither result was a parser failure.

`bunx tsc --noEmit -p tsconfig.json` and
`bunx tsc --noEmit -p trident/tsconfig.json` both exited zero.

The sandboxed full-file baseline completed 302 pass / 9 fail in 392.14 seconds.
Every failure was a denied Unix-socket bind at
`runtime/adapters/codex-cli/persistent/project-control-broker.ts:284`. It is
diagnostic evidence, not a passing receipt. Brief focused isolation/mutation
controls also overlapped that baseline, so its duration is not an uncontended
performance control.

The complete unsandboxed consuming-file command
`OPEN_E2E_FIXTURE_TIMING=1 bun test open/__tests__/project-build-e2e.test.ts`
exited zero: 312 pass, 0 fail, 3,682 assertions, 380.78 seconds, recorded in
`neutron-1298-open-fixture-final-full.log`. The source blob is identified above.
Typechecks briefly overlapped this run; the sandboxed baseline also has different
outcomes. These two full-file durations do not establish a paired speedup.
Full suite-lane timing, the partitioned host suite, required CI, and deployment
are not established by this isolated fixture work. The original audit's
422.05-second file and 496.69-second lane observations remain separate historical
measurements.

The local full-tree purity check returned 456 findings. Identical commands over
tracked base and candidate archives returned the same 455 findings (167 substring
and 288 word matches, 438 suppressed); worktree metadata accounts for the extra
local finding. Neither full-tree result is a purity pass. Scoped archives of the
changed files plus the required tracked LICENSE passed with zero findings on both
sides, as did the proposed commit-message text. The denylist and allowlist were
unchanged. Required CI must still decide the complete publication tree.
