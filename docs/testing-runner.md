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

## Exit codes

- `0` — every discovered file ran and passed.
- `1` — one or more lanes had failing tests, **or** a fatal coverage/discovery
  drift (the no-silent-truncation guarantee).
