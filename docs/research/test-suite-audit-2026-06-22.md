# Test-Suite Audit — neutron-open

_Atlas research dispatch · 2026-06-22 · READ-ONLY analysis (no tests run; the dev box OOMs on bare `bun test`). All counts from `git grep` / file reads, not execution._

## TL;DR

The suite is **healthy, not bloated.** A representative read of ~40 files across the 7 biggest clusters found **~87% ESSENTIAL, ~10% heavy-but-necessary, ~0% framework-bookkeeping-only, ~0% redundant, ~2.5% lightly-mocked.** AS-BUILT.md's standing war on "bookkeeping-only / false-green" tests has clearly worked — the suite asserts real product behavior (produced strings, DB state, HTTP/WS responses, phase transitions *with* emitted output).

So the sprint is **not** a deletion sprint. It is a **run-efficiency + authoring-efficiency** sprint. The OOM is an *architecture-of-the-runner* problem, already solved by `scripts/run-tests.sh` — which is **not yet the default**. That one-line fix (Phase 0) is the biggest immediate win and carries near-zero risk.

**Robustness is co-equal with leanness (Ryan's mandate): no test deletion without sign-off, and never trade coverage for a leaner number.**

---

## 0. Ground truth on the numbers

The dispatch brief cited "3063 test files / ~7600 tests / ~88 server-boot / ~108 in-proc DB / 9 PGLite." Verified actuals:

| Metric | Brief | **Verified (git-tracked real source)** | Note |
|---|---|---|---|
| Test files | 3063 | **771 git-tracked / ~859 bun-discovered** | `find` minus node_modules returns 8120 — inflated by `.worktrees/` + `.claude/worktrees/` Forge/trident clones, which bun + the runner correctly exclude |
| Test cases | ~7600 | **~7677** (`test(`/`it(` count) | ✅ matches |
| Server-boot | ~88 | **~90** (real `Bun.serve`); 93 if you include handler-only `fetch` tests | ✅ close |
| In-proc DB | ~108 | **93** (`bun:sqlite` / `new Database` / `drizzle`) | close |
| PGLite-WASM | 9 | **6 git-tracked** | the extra 3 are worktree clones; 6 is the real flake surface |

The "3063 files" figure is an artifact of counting clone trees. **The real suite is ~771 files / ~7677 tests** — which is what `run-tests.sh` partitions and what every estimate below is scaled against.

---

## 1. Inventory — files by area, heavy clusters surfaced

### By subsystem (top dirs, git-tracked `.test.*`)
```
 81  onboarding/interview      53  app/__tests__            22  gateway/http
 81  gateway/__tests__         49  tests/integration        20  onboarding/history-import
 67  cores/free               49  landing/__tests__         20  connect/__tests__
 40  runtime/adapters         39  gateway/realmode-composer 18  channels/adapters
 …  (long tail: trident 16, wow-moment 15, open 12, runtime 11, tasks 9, reminders 6, …)
```

### Heavy cluster A — SERVER-BOOT (~90 files)
Tests that bind a real socket (`Bun.serve({port:0})`) and do real HTTP/WS roundtrips via `fetch()`.
Concentration: **gateway/__tests__ (~58)**, runtime/adapters/claude-code/persistent (9), open/__tests__ (8), gateway/http (6), plus scattered landing/integration/composer.
- **~89/90 have proper `afterEach { server.stop(true) }` teardown** — leak hygiene is excellent (verified: zero leaked servers in sample).
- Cost: full boot + WS + DB ≈ 2–5 s (e.g. `open/__tests__/open-boot-shell.test.ts`); single-surface + DB ≈ 0.2–0.5 s; the memory cost is the live concern — each socket-bound server + its DB/graph sits in the chunk's RSS until teardown.

### Heavy cluster B — IN-PROC DB (~93 files)
- **~88/93 are on-disk temp-file SQLite** (`mkdtempSync` → `new Database` → `applyMigrations` → `ProjectDb.open`), only ~9 use `:memory:`.
- Concentration: connect (12), realmode-composer (10), gateway/__tests__ (9), tests/integration (7), gateway/cores (5), cores/runtime (5), auth (5), cores/free/* (many 3-packs).
- **~91/93 have `afterEach` `db.close()` + `rmSync(tmpdir)`** — strong teardown, no systematic leaks.
- Cost: ~30–50 ms setup per test (mkdtemp + migrate). Cheap individually; ~4–7 s aggregate.

### Heavy cluster C — PGLite-WASM (6 files) — the #79/#327 flake
```
gbrain-memory/__tests__/boot-pglite-brain.test.ts   (classifier only — cheap, no real boot)
gbrain-memory/__tests__/memory-store.test.ts        (~8s boot, shared via beforeAll)
gbrain-memory/__tests__/sync-hook.test.ts           (~8s)
scribe/__tests__/scribe-gbrain-roundtrip.test.ts    (~8s)
scribe/__tests__/scribe-cores-source.test.ts        (~8s)
connect/__tests__/shared-project-memory-mirror.test.ts (~16s — boots TWO brains)
```
Each boots a real WASM Postgres + ~100 migrations (60 s timeouts). All use a single `beforeAll` boot amortized across the file's tests + `afterAll disconnect()`. **Aggregate ≈ 49 s and tens of MB of WASM** — the single most expensive cluster and the root of the #79 (`probe.pages_exists` boot race) / #327 (WASM-init OOM on the contended box) flakes.

---

## 2. Usefulness audit (sample n≈40, ~5% of suite)

| Bucket | Sample | Est. whole-suite % | Confidence |
|---|---|---|---|
| **ESSENTIAL** (real product logic / observable output) | 35/40 | ~85–88% | HIGH |
| **HEAVY-BUT-NECESSARY** (boots server/DB and genuinely needs to) | 4/40 | ~10% | HIGH |
| **REDUNDANT** (overlapping coverage) | 0/40 | <5% (sample found none; ±15pt margin) | MEDIUM |
| **FRAMEWORK-BOOKKEEPING-ONLY** | 0/40 | ~0–2% | MEDIUM-HIGH |
| **OVER-MOCKED** | 1/40 | ~2–3% | MEDIUM |

**Why so clean:** only **20 of 771 files** use `mock()`/`spyOn` at all — the suite leans on real fakes (deterministic stub hooks/LLM clients returning fixed payloads) rather than spy-mocking internals. That is the opposite of the typical over-mocked codebase, and it's why "test the mock" is nearly absent.

**Representative ESSENTIAL examples (verified by read):**
- `onboarding/interview/buttons-only-safety-net.test.ts` — asserts engine re-emits the phase with a *fresh* prompt_id on invalid input (real phase + DB + emitted prompt, not a flag).
- `gateway/__tests__/admin-personality-persona-wiring.test.ts` — PATCH SOUL.md over HTTP, then assert the *next LLM call* contains the new text (loader-invalidation wiring, end-to-end).
- `cores/free/calendar/cache.test.ts` — composite-key upsert, cancelled-row filtering, numeric-instant ordering across TZ offsets (Argus r2 regression).
- `landing/__tests__/chat-bubble-css.test.ts` — pins `overflow-wrap:break-word` / `word-break:normal` / `max-width:min(60ch,80%)` (2026-05-12 regression).
- `tests/integration/gap-fill-iterates-until-required.test.ts` — engine self-loops gap-fill, appends (not overwrites) extracted fields, caps at 5 → `phase=failed` with reason.

**Honest caveats:** the sample is ~5% of files and ~52% of only the *largest* cluster. REDUNDANT and BOOKKEEPING estimates carry a ±15pt margin on the rare buckets. Two cheap repo-wide scans would tighten this in the sprint:
```bash
git grep -nE "expect\(.*active_prompt_id.*\)\.toBe" -- '*.test.ts' | wc -l   # bookkeeping smell
git grep -nE "expect\(.*phase(_state)?.*===|toBe\('?\w+'?\)\).*phase" -- '*.test.ts' | wc -l
```
If those counts are high *relative to* multi-layer assertions in the same files, that's the bookkeeping tail to investigate (not auto-delete).

---

## 3. Efficiency — authoring (write the heavy clusters lighter)

1. **Server-boot → handler-direct (the big one, ~50–60 files).** The non-WS gateway surface tests (`app-*-surface.test.ts`: tasks, docs, admin, launcher, reminders, projects, upload, devices, focus, …) bind a real socket only to `fetch()` one route. They can call the composed handler directly:
   ```ts
   // heavy: bind socket + fetch
   const server = Bun.serve({ port: 0, fetch: composed.fetch })
   const res = await fetch(`http://127.0.0.1:${server.port}/api/app/tasks`)
   await server.stop(true)
   // light: invoke the handler, no socket
   const res = await composed.fetch(new Request('http://x/api/app/tasks', { headers }))
   ```
   Payoff is **lower per-chunk peak RSS** (no live listener/socket buffers held until teardown) → enables bigger chunks / more `NEUTRON_TEST_JOBS` parallelism on the same box. Time savings are modest (~100–200 ms/test); the memory + determinism win is the point.
   **KEEP real boots for:** WS tests (`app-ws-*`, `replay-redelivery`), boot-sequence (`open-boot-shell`, sprint E2E), port-bind race (`deterministic-bind`), and production-graph composition (lighten only the HTTP call, keep the graph boot).

2. **PGLite — keep, but isolate and de-flake; do NOT fake.** All 6 files assert Postgres-specific GBrain semantics that SQLite cannot stand in for: vector search ranking, typed-edge graph (`add_link` FK semantics, predicate-blind `remove_link` ordering bug, deferred-edge retry #102), and dual-brain export/import for shared-project memory (B2). The WASM dependency is **load-bearing, not incidental** — a fake would test nothing. The fix is operational (see §4), plus the existing `withTransientBootRetry` classifier that self-heals #327/#79. Reducing migration count at boot (if a test-only minimal schema is viable) is the only real authoring lever and needs care.

3. **In-proc DB — leave mostly as-is.** Per-test temp-DB setup (~30–50 ms) is cheap and the isolation is worth more than a shared fixture. One narrow win: files with N `describe` blocks each re-mkdtemp+migrate could share a per-file migrated template — but ROI is small vs. the isolation risk. Not a priority.

4. **Teardown is already good** — no leaked-server/DB cleanup sprint needed (verified ~98% hygiene in both clusters). Don't manufacture work here.

---

## 4. Efficiency — running (the actual OOM fix)

`scripts/run-tests.sh` already solves the OOM: it partitions into chunks, runs each in a **fresh short-lived `bun test` process** (peak RSS bounded to one chunk, freed between chunks), and **audits coverage** (find-list cross-checked against bun's own discovery count — drift is FATAL, never silent truncation). It is correct and battle-tested in CI. The gap: **it isn't the default**, so anyone running bare `bun test` (or an editor/agent that does) still loads all ~859 files into one process and OOMs.

Concrete running improvements, ordered:
1. **Make the runner the default** — point `package.json` `"test"` at it (Phase 0). Bare `bun test` for a single file is still fine; the *suite* command stops OOMing.
2. **Isolate PGLite to its own chunk/lane.** A `NEUTRON_TEST_PGLITE_ONLY` style filter (or simply ordering the 6 PGLite files into a dedicated final chunk) keeps their tens-of-MB WASM out of every other chunk's peak and quarantines the #79/#327 flake to a retryable lane.
3. **Tune chunking for the box:** `NEUTRON_TEST_CHUNK_SIZE` (default 100) down to ~50–60 lowers per-chunk peak RSS further on the contended 30 GB deploy box; `NEUTRON_TEST_JOBS` up to 2–4 on a *quiet* dev box trades RSS (JOBS×chunk) for wall-clock. Document the box-specific recipe.
4. `NEUTRON_TEST_CONCURRENCY` (intra-chunk `--max-concurrency`) defaults to physical cores — fine; lower it on the deploy box if a single chunk still spikes.

---

## 5. Proposed sprint plan (phased, PR-sized, ordered by leverage × safety)

**Phase 0 — Make the bounded-memory runner the default. (safest, biggest immediate win)**
- One line: `package.json` `"test": "bash scripts/run-tests.sh"` (keep an escape hatch like `"test:bun": "bun test"` for single-file runs).
- Update CONTRIBUTING/AS-BUILT to say "`bun test <file>` for one file; `bun run test` for the suite."
- Net effect: bare suite runs stop OOMing locally and in any agent/editor that shells `bun run test`. Zero test changes, zero coverage risk.

**Phase 1 — Quarantine PGLite.**
- Route the 6 PGLite files into a dedicated chunk/lane with its own retry budget; keep them out of general chunks' RSS.
- De-flake: confirm `withTransientBootRetry` covers current #327/#79 signatures; add any new ones. No behavior change to the tests' assertions.

**Phase 2 — Server-boot → handler-direct rewrite (non-WS surfaces).**
- Migrate ~50–60 `app-*-surface` tests to call the composed handler via `Request` instead of binding a socket. Same assertions, same DB, no `Bun.serve`.
- PR-sized in batches (e.g. 10–15 files/PR per subsystem). **Coverage-preserving** — assertions are unchanged; only the transport changes. Argus-reviewable as pure refactors.

**Phase 3 — Bookkeeping/redundancy verification scan (NOT auto-delete).**
- Run the two `git grep` scans in §2 over the whole suite; hand-review any hits for bookkeeping-only or true duplication.
- **Any deletion or merge requires Ryan's sign-off and must preserve the asserted behavior elsewhere.** Default verdict on ambiguous "redundant" cases = KEEP (edge-case coverage > leaner count). Output a candidate list with justification, not a PR that deletes.

**Phase 4 (optional) — Chunk/JOBS tuning + box recipes.**
- Document `CHUNK_SIZE`/`JOBS`/`CONCURRENCY` recipes for (a) the 30 GB deploy box and (b) a quiet dev box. Pure config/docs.

**Explicitly out of scope unless Ryan asks:** mass test deletion, faking PGLite, shared-DB fixtures that weaken isolation, teardown "cleanup" (already clean).

---

## Appendix — method & confidence
- Counts: `git ls-files | grep '\.test\.'` + pattern `git grep -l` over that set (excludes node_modules + worktree clones, matching bun's discovery). No tests executed.
- Usefulness: 3 parallel read-only Explore passes — server-boot cluster, DB+PGLite cluster, cross-cluster usefulness sample (~40 files). Verdicts marked verified-by-read vs estimated-from-pattern throughout.
- Highest-confidence claims: cluster sizes, teardown hygiene, PGLite necessity, near-absence of mocking, runner correctness. Lowest-confidence: exact whole-suite % for REDUNDANT/BOOKKEEPING (±15pt; tightened by the Phase-3 scan).
