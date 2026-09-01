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

## Hermeticity — the env a test run sees

`bunfig.toml`'s `[test].preload` runs two scrubs before **every** `bun test`
process, in this order:

1. `tests/support/scrub-substrate-env.ts` — the substrate credentials bun
   auto-loads from `.env`. A developer's live Claude Max token must never reach
   the suite.
2. `tests/support/scrub-instance-env.ts` — the live-**instance** env.

The second one exists because `bun test` inherits the invoking shell's
environment. On a box that runs a live Neutron instance, that environment
carries the instance's own configuration: `NEUTRON_DB_PATH` (an absolute host
filesystem path to the live `project.db` — and it wins **verbatim** over
`NEUTRON_HOME` in `resolveOpenDbPath`, `migrations/db-path.ts`), `OWNER_HOME`,
`NEUTRON_IDENTITY_*`, `NEUTRON_CORES_GOOGLE_*`, and the onboarding flags. Any
boot-path test that did not arrange its own home therefore resolved the LIVE
data home, and the migration ownership guard (`migrations/runner.ts`) refused
the non-owner runner checkout:

```
error: Migration ownership refusal: the recorded owning checkout is not this runner checkout.
  database  <data-home>/project.db   owner  <deployed-checkout>/migrations
```

Measured 2026-08-31: **10 of 16 lanes / 50 files red locally on main while CI
was green on the same commit.** Say it plainly — the guard was RIGHT, and it is
untouched. The bug was that tests reached the live home at all. The preload
deletes `OWNER_HOME` and every `NEUTRON_*` var **except** `NEUTRON_TEST_*`, and
points `NEUTRON_HOME` at a fresh per-process scratch dir, so a test that boots
without its own home can only ever reach a scratch database.

The `NEUTRON_TEST_*` carve-out is deliberate: those are the runner's own knobs,
threaded into test processes by `scripts/run-tests.sh` — CI sets
`NEUTRON_TEST_SHARD` that way. Scrubbing them would *create* a local/CI
divergence instead of closing one.

**The boundary: a preload cannot reach CHILD processes.** A default-env spawn
hands the child the environ the process **started** with — measured on bun
1.3.13, neither a set nor a delete in `process.env` propagates; only an explicit
`env:{…}` at the spawn site decides what a child reads. The measurement table is
the comment block at the top of `tests/support/scrub-instance-env.ts` — read it
before "fixing" a spawned-child env assertion by extending the delete list.

### CI parity

CI executes **every** file. `.github/workflows/ci.yml` runs the *same*
`bash scripts/run-tests.sh` under an 8-way `NEUTRON_TEST_SHARD` matrix with bun
pinned `1.3.9`, and the same coverage audit (`declared == bun-discovered ==
executed`, drift fatal) gates both. There is no hidden skip list. "CI is green"
and "the local suite passes" now mean the same thing, up to toolchain version.

### A skip is not a pass, and an empty check is not a clean check

The parity above is about *files*: every discovered file runs in both places. It is not
automatically true of *assertions*, and two shapes have produced a green reading over a check that
never ran.

- **Environment-gated guards.** Some checks only do their work when the CI event environment is
  present. `scripts/ci/as-built-write-guard.sh:59-80` resolves its base/head shas from
  `GITHUB_EVENT_NAME` + `GITHUB_EVENT_PATH`; with neither set it prints
  `… is not a branch proposal … Nothing to guard` and exits **0**. That exit is correct for a bare
  local invocation and wrong to read as a pass. Drive such a guard the way its own tests do — set
  `GUARD_BASE_SHA` / `GUARD_HEAD_SHA`, or the event env — before quoting it as green, and read what
  a run SKIPPED before quoting its summary line.
- **A check whose extraction matched nothing.** At the exit code, a gate that parsed no input and
  reported clean is indistinguishable from a gate that parsed everything and found nothing wrong.
  A check that could not run has to say so: the leak gate exits **3** with
  `LEAK GATE: INCOMPLETE` when its PII rule has no denylist, and that behaviour is pinned by a
  control that must fail — `scripts/ci/leak-gate-selftest.test.ts:451`, "a local run with NO
  denylist is INCOMPLETE (exit 3), never green".

**So: a new gate ships with a must-fail control in the same commit** — an input it MUST reject —
and a zero-match extraction fails loudly rather than passing quietly. This is
`docs/INVARIANTS.md` #119 ("an EMPTY check must never read as a PASSING check") applied to the test
and CI surface. A gate with no failing case is an empty check wearing a green tick.

### The toolchain-skew gotcha

That last clause is load-bearing: CI pins bun `1.3.9`, and a newer local bun can
differ. Measured on `1.3.13`:

- `stat.mtimeMs` carries sub-ms precision (1.3.9 hands back integer ms) — which
  is why `gateway/wiring/__tests__/persona-loader.test.ts` pins whole-second
  mtime stamps that round-trip exactly through `utimes` + `stat`;
- `Bun.build` races under general-lane concurrency with `EBADF` /
  `Unexpected reading file` (the landing chat-react files — green file-scoped);
- a `require()` of an already-ESM-imported module reds with
  `Requested module is already fetched` in the single-process device lane.

Rule of thumb: **green file-scoped + green CI + red only in the local aggregate
is usually toolchain skew, not suite rot.**

### What a preload can NOT make hermetic

Two residual non-hermeticities remain, and each needs its own card:

- **the box's filesystem** — a live deployment installs real `gbrain` / `codex`
  binaries, which the tests that assert their *absence* then find;
- **the real environ spawned children inherit** — e.g. the owner's `GH_TOKEN`,
  per the child-process boundary above.

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

## Exit codes

- `0` — every discovered file ran and passed.
- `1` — one or more lanes had failing tests, **or** a fatal coverage/discovery
  drift (the no-silent-truncation guarantee).
