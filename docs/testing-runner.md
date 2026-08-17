# Testing — the bounded-memory partitioned runner

`scripts/run-tests.sh` is the one documented command that runs the **entire**
real-source test suite to completion with **bounded memory**. Use it for the
suite; use bare `bun test <file>` for a single file.

```bash
bash scripts/run-tests.sh          # whole suite, bounded memory
bun test gateway/__tests__/app-tasks-surface.test.ts   # one file (fine, cheap)
```

## Why it exists

`bun test` loads **all** discovered files into **one** long-lived process —
file parallelism is intra-process (`--max-concurrency`), not separate OS
processes. The suite has grown into the hundreds of files (run
`bash scripts/run-tests.sh` and read its own startup line for today's live
count — don't trust a number written here, it will rot), and that single
process's peak RSS climbs past ~1.2 GB and OOMs the contended 30 GB deploy box
(ISSUES #78). The runner **partitions**
the suite into chunks and runs each chunk in its **own fresh, short-lived** `bun
test` process, so peak RSS is bounded to one chunk's working set and freed
between chunks. 100% coverage is preserved and **audited**: every discovered
file runs exactly once, cross-checked against bun's own discovery count — drift
is a fatal error, never silent truncation.

## The PGLite-WASM quarantine lane (ISSUES #79 / #327)

A few test files boot a **real** Postgres-in-WASM (`@electric-sql/pglite`) + ~100
migrations. That first big WASM compile is the suite's single most expensive and
flakiest step — under load it intermittently fails `PGLite failed to initialize
its WASM runtime` (#327) or races the boot probe (#79). Mixed into a general
chunk it inflates that chunk's peak RSS and randomly reds an otherwise-green run.

So those files run in their **own dedicated lane**, **after** the general chunks,
with:

- **serial intra-lane execution** (`--max-concurrency=1`) so two brains never
  compile WASM at the same instant (the #79 boot race), and
- a **bounded retry budget** — a transient lane failure re-runs the *whole* lane
  a few times before the run is declared failed. (The `withTransientBootRetry`
  classifier inside `gbrain-memory/__tests__/boot-pglite-brain.ts` already
  self-heals most individual boots; this lane retry is the belt-and-braces.)

Lane membership is **content-derived** — any test file that mentions `pglite` is
quarantined automatically, so a new PGLite test needs no allowlist edit. Coverage
is unchanged: lane files are still counted in the audit (`RAN_TOTAL`).

## The device-harness isolation lane

The mobile device harness (`app/__tests__/support/native-harness.ts`) registers a
happy-dom DOM and aliases `react-native` for the whole **process**. That cannot
share a process with the rest of the suite, and none of the reasons are fixable
from the harness side:

- `landing`'s happy-dom tests call `GlobalRegistrator.register()` unconditionally,
  and it **throws** when a DOM is already registered — so whichever runs second
  fails;
- several app tests own the `react-native` specifier with process-global
  `mock.module` fakes;
- a DOM the harness registered cannot be unregistered again without breaking the
  harness files still queued in that same process.

Mixed into a general chunk this produced **68 failures across three CI shards**, all
in unrelated packages. So harness files get their own process, exactly like the
PGLite lane. Membership is content-derived (any file mentioning
`installNativeHarness`), so a new harness suite is isolated automatically, and lane
files still count toward the coverage audit.

No retry budget: unlike the WASM lane these are deterministic, not flaky.

### What it looks like when you bypass the lane

Running a whole directory that spans both lanes — `bun test app/__tests__` is
the one people reach for — puts the harness back in a shared process and
reproduces the collision. Measured on `bun test v1.3.9`, 2026-07-31: **1295
pass / 12 fail across 102 files**, and each of the three affected files passes
on its own. The three shapes, all the same root cause:

| File | Fails | Mechanism |
| --- | --- | --- |
| `app/__tests__/upload-client.test.ts` | 3 | the harness's happy-dom registration (`support/native-harness.ts:207`) leaves `window` + `XMLHttpRequest` defined, so `lib/upload-client.ts:177`'s `isWeb` probe flips and the XHR transport is chosen over the injected `fetch_impl` — the test then makes a real socket call |
| `app/__tests__/authed-attachment-file-open.test.tsx` | 5 | the harness's source rewrite (`support/native-harness.ts:149`) redirects `app/components/*`'s `react-native` imports to `support/stubs/react-native.ts`, so the component reads that stub's `Platform.OS` (`'web'` unless `__HARNESS_OS__` is set) instead of the `platform` object the test mutates — every native-path assertion fails |
| `app/__tests__/chat-prompt-spent-after-remount.test.tsx` | 4 | the reverse direction: `docs-panes-render.test.ts:44` registers a process-global `mock.module('../lib/markdown-render')` whose `RenderMarkdown` renders `null`, so the harness's real `ChatSyncSurface` draws every bubble without its body |

Both lanes are individually clean in a single process (verified same day: 1226
pass / 0 fail across the 92 general files; 81 pass / 0 fail across the 10
harness files), so this is a process-boundary artifact, not a rotting suite.
Run the lanes, not the directory:

```bash
bun test $(grep -LE 'installNativeHarness' app/__tests__/*.test.ts app/__tests__/*.test.tsx)
bun test $(grep -lE 'installNativeHarness' app/__tests__/*.test.ts app/__tests__/*.test.tsx)
```

## Knobs

| Env | Default | What it does |
|---|---|---|
| `NEUTRON_TEST_CHUNK_SIZE` | `100` | files per general `bun test` process |
| `NEUTRON_TEST_CONCURRENCY` | physical cores | `--max-concurrency` per process |
| `NEUTRON_TEST_TIMEOUT` | `15000` | per-test timeout (ms) for general chunks |
| `NEUTRON_TEST_JOBS` | `1` | general chunks run **concurrently** (1 = sequential) |
| `NEUTRON_BUN_BIN` | `bun` | bun binary |
| `NEUTRON_TEST_PGLITE_RETRIES` | `2` | lane re-runs on transient failure |
| `NEUTRON_TEST_PGLITE_CONCURRENCY` | `1` | `--max-concurrency` for the lane |
| `NEUTRON_TEST_PGLITE_TIMEOUT` | `90000` | per-test timeout (ms) for the lane (real-WASM boots use 60s internally) |
| `NEUTRON_TEST_NO_PGLITE_LANE` | `0` | set `=1` to fold PGLite files back into general chunks |
| `NEUTRON_TEST_NO_DEVICE_LANE` | `0` | set `=1` to fold the mobile-harness files back into general chunks (expect DOM / module-registry collisions) |
| `NEUTRON_TEST_SHARD` | unset | `<i>/<n>` — run only this shard's slice (cross-runner; see below) |
| `NEUTRON_TEST_TIMINGS` | `scripts/test-timings.json` | the duration manifest the shard partition balances on |
| `NEUTRON_TEST_TIMINGS_OUT` | unset | write a fresh manifest from THIS run (see "Regenerating the manifest") |
| `NEUTRON_TEST_DEFAULT_FILE_SECONDS` | `2` | cost charged to a file the manifest does not name |

Rough model: **peak RSS ≈ `JOBS` × `CHUNK_SIZE` × per-file working set.**
Lower `CHUNK_SIZE` and `JOBS` to bound memory; raise `JOBS` to trade memory for
wall-clock.

## Tuning recipes

### Contended 30 GB deploy box / CI — bounded memory is the priority
```bash
NEUTRON_TEST_CHUNK_SIZE=60 NEUTRON_TEST_JOBS=1 bash scripts/run-tests.sh
```
Smaller chunks ⇒ lower per-chunk peak RSS; sequential ⇒ only one chunk's RSS live
at a time. The safest profile, and the CI default intent.

### Quiet dev box / lots of free RAM — wall-clock is the priority
```bash
NEUTRON_TEST_JOBS=4 NEUTRON_TEST_CHUNK_SIZE=100 bash scripts/run-tests.sh
```
Runs 4 chunks at once — roughly Nx faster, but holds ~4 chunks' RSS concurrently.
Only do this with headroom; drop `JOBS` first if the box starts swapping.

> **Trident builds now set `JOBS` and `CONCURRENCY` for themselves.** The build prompts
> derive them from a shared-box budget:
> `jobs = min(cores ÷ max(FANOUT, live building runs), mem_available × 0.8 ÷ (CHUNK_SIZE
> × 24 MiB))`, floor 1, and `concurrency = cores ÷ jobs` — so the divisor is a CONSTANT
> (`DEFAULT_BUILD_FANOUT = 4`), not a launch-time snapshot that goes stale the moment the
> next build starts, and `jobs × concurrency` is one box's worth of work per build rather
> than `cores²`. On this 8-core box that ships `JOBS=2 CONCURRENCY=4` per build, and four
> concurrent builds total 8 chunk processes. `jobs × concurrency` is one box's worth of
> work PER BUILD, which is also exactly what this runner's own defaults produce per build
> (`JOBS=1 CONCURRENCY=cores`): the budget re-splits that load across processes rather
> than adding to it, and it never puts more test files in flight than an untouched
> invocation would. See `trident/test-strategy.ts`. Measured
> 2026-08-15 on the real box: 22.0 min sequential → 11.2 min at `JOBS=8` (an idle-box
> ceiling) → see `docs/AS_BUILT.md` for the shipped `JOBS=2` figure; the
> `files executed: 1273` audit is unchanged and the PGLite/device lanes stay serial in
> every case. A project whose runner exposes no such knobs is run unchanged. Manual
> invocations of this script are unaffected and still default to `JOBS=1` (sequential).

### A single chunk still spikes RSS
```bash
NEUTRON_TEST_CONCURRENCY=2 bash scripts/run-tests.sh
```
Lowers intra-chunk parallelism (fewer tests in flight inside one process).

### The PGLite lane is the bottleneck (rare local debugging)
```bash
NEUTRON_TEST_NO_PGLITE_LANE=1 bash scripts/run-tests.sh   # fold back into general
NEUTRON_TEST_PGLITE_RETRIES=4 bash scripts/run-tests.sh   # more patience on a hot box
```

### Running a device-harness file on its own
```bash
bun test app/__tests__/mobile-chat-send-on-device.test.tsx
```
A bare single-file `bun test` is always safe — the collisions only happen when a
harness file shares a process with the rest of the suite. Do NOT set
`NEUTRON_TEST_NO_DEVICE_LANE=1` expecting green.

## Discovery is PRUNED, not filtered

`scripts/lib/discover-test-files.sh` is the single answer to "what is the suite?".
It prunes `node_modules` and dot-directories from the walk rather than filtering
them out of the results — a `-path` test discards matches `find` has already
visited, so the old form walked every file in `node_modules` and every
`.claude/worktrees/` clone on **every** invocation. Measured 2026-08-17 on the
main checkout: **2 m 59 s filtered, 0.69 s pruned, byte-for-byte identical
output** (1273 files; 20258 with the exclusions dropped entirely, so they are
load-bearing). The runner pays discovery once per invocation, so all four CI
shards paid it.

The prune is restricted to `-type d` deliberately, and `.?*` rather than `.*`
because `.*` matches `.` — the starting directory — which prunes the whole walk
and prints nothing with exit 0. `scripts/__tests__/discover-test-files.test.ts`
pins both, and each of those two mutations plus dropping the `node_modules` prune
was verified to fail exactly the test that names it.

## Sharding across CI runners — balanced by DURATION, not by file count

`NEUTRON_TEST_SHARD=<i>/<n>` runs one runner's slice of the suite. CI uses four.

The slice is **not** a round-robin over the file list. It was, and equal file
counts over a suite where a handful of files dominate produced very unequal
runners — measured 2026-08-17 across the four CI shards: **204 s / 304 s / 412 s**.
Wall-clock is set by the worst shard, so about a third of it was imbalance rather
than work.

So each file is charged an observed cost from `scripts/test-timings.json` and the
files are handed out **longest-first to whichever shard is currently lightest**.
Every shard computes the same assignment from the same three inputs (the
discovered file list, the manifest, `n`), independently and without talking to
each other — which is what keeps the slices a partition.

**The manifest is an optimisation and never an authority.** It is consulted for a
COST and never for membership, so every way it can rot degrades balance only:

| Manifest state | What happens |
|---|---|
| names a file that no longer exists | the entry is never looked up |
| missing a file that does exist | that file costs `NEUTRON_TEST_DEFAULT_FILE_SECONDS` and is assigned normally |
| empty, corrupt, or absent entirely | every cost is equal, which degenerates to the old round-robin |

In all of those, every discovered file still lands in exactly one shard.
`scripts/__tests__/run-tests-shard.test.ts` asserts that for each case.

Each shard prints what it predicts every bucket will cost, which is the fastest
way to see imbalance without waiting for CI (real output, 2026-08-17):

```
run-tests: SHARD 2/4 — executing 329 general + 2 PGLite + 7 device of 1351 discovered
run-tests: predicted shard seconds (from scripts/test-timings.json): 1:2333s 2:2333s 3:2335s 4:2335s
```

Against the same manifest, the round-robin this replaced predicted
`2553s / 2142s / 2496s / 2144s` — a 411 s spread and a 2553 s long pole, versus a
2 s spread and a 2335 s long pole. Note the shard FILE counts are now deliberately
uneven (329 general on this shard, and one shard owns the 393 s
`leak-gate-selftest.test.ts` almost by itself); that is the change working, not a
bug. Absolute numbers here were measured on a loaded laptop and are inflated —
what the partition needs is the relative weights, which is why a stale manifest
costs balance and not correctness.

### Regenerating the manifest

Any full run can produce one — it adds a JUnit reporter per lane and merges the
per-file test times:

```bash
NEUTRON_TEST_TIMINGS_OUT=scripts/test-timings.json bash scripts/run-tests.sh
```

The value stored per file is `NEUTRON_TEST_DEFAULT_FILE_SECONDS + Σ(its testcase
times)`. Both halves earn their place: the Σ term is what makes the dominant
files dominant, and the constant is the per-file floor bun pays whatever the
tests do (process start + module graph — measured at ~1.35 s for a file with
0.02 s of test bodies), which is what stops a shard being handed four hundred
nominally-free files. Regenerate it when the balance visibly drifts; a stale
manifest costs wall-clock, never correctness.

It must be an **unsharded** run. A shard measured a quarter of the suite, and
writing that over the manifest would delete three quarters of the costs — after
which every deleted file falls back to the default and the partition quietly
returns to balancing by count. The runner refuses rather than warns, because
nothing about the result would look wrong.

## Running only what you changed (build lanes)

A build lane in a worktree should NOT run this whole suite. Several lanes on one
machine saturate it, and a saturated machine does not merely run slowly — it
manufactures failures: on 2026-08-17 six tests failed under lane contention, every
one of them sitting exactly on a 5 s timeout boundary, and an A/B of a single file
across two worktrees came out with the CONTROL slower than the changed tree.

```bash
bash scripts/select-tests-for-changes.sh main 40 | xargs bun test
```

It prints the test files covering the working tree's changes: the changed test
files themselves, then the tests beside each changed module (its own directory and
its adjacent `__tests__/`), then tests that name a changed module — capped, and
dropping a whole tier rather than trimming one. CI still runs everything on every
push, so nothing is verified less before merge.

## Exit codes

- `0` — every discovered file ran and passed.
- `1` — one or more lanes had failing tests, **or** a fatal coverage/discovery
  drift (the no-silent-truncation guarantee).
