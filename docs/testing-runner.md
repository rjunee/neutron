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

## The migrated-DB template — migrate once per process, clone per test

`tests/support/migrated-db.ts`. Do **not** write `ProjectDb.open(...)` +
`applyMigrations(db.raw())` in a `beforeEach` — `applyMigrations` executes the
whole migration tree (~350 KB of SQL) and measured ~137 ms of CPU per call.

```ts
import { openMigratedDbAt } from '../tests/support/migrated-db.ts'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-<suite>-'))
  db = openMigratedDbAt(join(tmp, 'project.db'))   // ~7 ms, real file, real path
})
```

| Helper | Shape | Cost | Use when |
|---|---|---|---|
| `openMigratedDb()` | in-memory `ProjectDb` | ~1.4 ms | the test only needs a handle |
| `openMigratedDatabase()` | in-memory `bun:sqlite` `Database` | ~1.4 ms | the fixture holds a raw handle |
| `openMigratedDbAt(path)` | file-backed `ProjectDb` | ~7 ms | the code under test reads `db.path`, or the test asserts about the file |
| `openMigratedDatabaseAt(path)` | file-backed `Database` | ~7 ms | same, raw handle |

The template is built lazily on first use by the **real** `applyMigrations`, so
the schema is identical by construction — `tests/support/migrated-db.test.ts`
pins that against a freshly-migrated database, ledger included. Scope is the
**process**, so with this runner it is built once per chunk, not once per run.

**Tests that are ABOUT migration behaviour must keep calling `applyMigrations`
directly** — the ledger, provenance, the scope rekey, ordinal identity, repairs,
untracked-file refusals. Exercising the real path is their coverage; template-ise
them and you delete it.

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
