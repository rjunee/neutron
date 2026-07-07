# Data-layer critic report — Neutron Open persistence architecture

Critic: data-layer (SQLite/persistence touchpoints, schema ownership, transaction discipline, JSON-in-columns, in-memory durable-worthy state).
Repo: /Users/ryan/repos/neutron-open @ main (2026-07-02). All paths repo-relative. Every claim below was verified in code this session (the repo contains files with embedded NUL bytes — e.g. `doc-search/store.ts` — so plain `grep` silently misses matches; all censuses were re-run with `rg -a` and spot-verified with Read).

---

## 0. The lay of the land (verified census)

**One instance DB, ~68 tables.** `migrations/expected-schema.txt` contains 68 `CREATE TABLE` statements produced by 90 forward-only SQL files (`migrations/*.sql`) + a 3-file comments sidecar tree. Boot order: `ProjectDb.open` → `applyMigrations(db.raw())` → composer (`gateway/index.ts:181-182`). The byte-identical schema snapshot test (`migrations/snapshot.test.ts:21,44` vs `expected-schema.txt`, regen via `regen-snapshot.ts`) is the layer's best refactor guardrail.

**Hand-rolled store modules: ~60.**
- **44 files define classes over `ProjectDb`** (census: files containing both `ProjectDb` and `export class`, minus non-stores): `auth/{api-key,secrets}-store`, `channels/button-store`, 4× `connect/*-store`, `cores/runtime/{installations-store,secret-audit}`, `cron/{scheduler,state}`, `gateway/{comments/comment-store, cores/oauth-pending-store, proactive/state-store, projects/sqlite-store, push/store, upload/upload-session-store}`, `onboarding/{interview/sqlite-state-store, overnight/queue-store, profile-pic/{pending-call-store,pipeline}, telemetry/{event-emitter,sean-ellis-trigger}, wow-moment/telemetry, api/invite-link-generate, feedback/m2-week-4-collector, history-import/job-runner}`, `persistence/app-chat-{store,receipts,reactions,edits}`, `project-credentials/store`, `reminders/store`, `skill-forge/proposals-store`, `tasks/store`, `tools/approval`, `trident/store`, `watchdog/alert-store`, `work-board/store`, plus 3 cores backends.
- **10 raw `bun:sqlite` sidecar DBs** (own `new Database(...)`): `doc-search/store.ts:175`, `gateway/comments/comment-store.ts:885`, `gateway/storage/binary-store.ts:726`, `cores/runtime/data-namespace.ts`, `cores/free/research/src/store-resolver.ts:209`, `cores/free/calendar/src/{cache.ts:165, pre-meeting-brief-queue-store.ts:324}`, `cores/free/email/src/cache.ts:334`, `cores/free/code-gen/src/sidecar/store.ts:414`, plus the client-side `app/lib/chat-core/sqlite-store.ts` (op-sqlite, out of scope).
- **File-state stores**: reflection diary/corrections (markdown), `scribe/scribe-budget.ts` (JSON), `gbrain-memory/gbrain-doctor` state (JSON), entity pages on disk (`runtime/entity-writer.ts`).

**Transaction usage**: 26 files call `db.transaction(...)`; ~20 use async callbacks (event-loop yields inside an open BEGIN — see §2).

**JSON-in-columns**: 61 `*_json` column references across `migrations/*.sql`; 16 store files hand-roll `JSON.parse` with divergent failure semantics.

---

## 1. [P0] The live import pipeline is not restart-durable: results in a RAM Map, orphaned status rows, RAM watcher timers

This is the single sharpest data-loss defect in the layer, and it sits directly on the highest-value onboarding path (the paid LLM synthesis of the owner's history).

Evidence (all in `gateway/realmode-composer/build-synthesis-import-runner.ts`):
- `:128-132` — `const results = new Map<string, ImportResult>()` + `const cancelled = new Set<string>()`, with an in-code rationale: *"the result is consumed by the engine in the same process the moment the job completes, so it does not need an `import_results` row for resume"*. That rationale is false the moment the process restarts between completion and consumption.
- `:240-248` — on success the durable row goes `status='completed'` while the actual `ImportResult` payload goes **only** into the Map.
- `:305-308` — `status()` returns a completed job whose `.result` is `undefined` after restart.
- `:327-333` — `synthesizeOnDemand` is `results.get(job_id) ?? null`; post-restart it salvages nothing, and the engine routes to conversational gap-fill — the entire synthesis (dollars spent, seeds computed) is silently discarded as if it never ran.
- `:267-274` — `runJob` is fire-and-forget (`void runJob(...)`); a crash mid-run leaves the `import_jobs` row at `pass1-running` forever. There is **no boot-time sweep** for orphaned `queued`/`pass1-running` rows. The only backstop is the engine's `IMPORT_RUNNING_HARD_TIMEOUT_MS` (15 min, `onboarding/interview/engine-internals.ts:121`) reached via the import-running cron (`onboarding/interview/import-running-cron.ts`, registered at `gateway/composition/build-core-modules.ts:611-620`), so a restart mid-import stalls the owner for up to 15 minutes and then presents an honest failure + retry (paying for the synthesis twice).
- `open/composer.ts:1329-1336` + `:2482-2528` — the Path-1 import-completion watcher (`watchImportCompletion`) is an in-process `setTimeout` chain armed only by `notifyImportUpload`; after a restart nothing re-arms it, so the `import_analysis_presented → work_interview_gap_fill` consumption depends entirely on the cron path.

The repo already contains the exact durable pattern to copy: `onboarding/profile-pic/pending-call-store.ts` (durable pending rows) + `onboarding/profile-pic/restart-resume.ts:1-15` (boot-time sweep with time-window heuristics), and the dead per-chunk pipeline already has a `persistResult` writing `import_results` (`onboarding/history-import/job-runner.ts` — the table exists in schema).

**Proposal**: (a) persist the mapped `ImportResult` to the existing `import_results` table in the same write that flips `status='completed'`; make `status()`/`synthesizeOnDemand` fall back to the row when the Map misses; (b) add a boot sweep flipping orphaned non-terminal `import_jobs` rows to `failed('substrate_error', …)` (or resumable) modeled on profile-pic's restart-resume; (c) optionally re-arm the completion watcher at boot for rows at `import_analysis_presented`.

**Behavior risk**: the persisted result must round-trip the exact `ImportResult` shape the engine consumes (`synthesisResultToImportResult`); the boot sweep must not race the 15-min hard-timeout path (both converge on the same `failed` terminal, so idempotence is natural). The honest-failure gate (`:203-220`) and cancellation semantics must be untouched. Effort: **M**.

---

## 2. [P1] ProjectDb's serialization invariant is a fiction at the call sites: no read API, ~70 `raw()` escapes, unserialized writes, and an API shape that drives its own bypass

`persistence/db.ts` is genuinely well-engineered (WAL pragmas `:15-22`, per-instance async mutex `:216-226`, AsyncLocalStorage re-entry, jittered busy-retry with exhaustion-guard `retry.ts:47-59`, async sleeps to keep the systemd watchdog alive). But the invariant it exists to enforce — *"one operation at a time per connection; a concurrent run must not land inside an open BEGIN/COMMIT"* (`db.ts:41-51`) — is structurally unenforceable because the API pushes callers around it:

1. **There is no read API.** `ProjectDb` exposes `prepare()` (documented "NOT mutex-serialized", `db.ts:112-124`) and `raw()` ("escape hatch… primarily the migration runner", `db.ts:85-94`). Every read in every one of the 44 stores necessarily bypasses the mutex. Since ~20 files run **async** transaction callbacks (`tasks/reminder-link.ts:97`, `work-board/store.ts:262,364,423,519,561`, `channels/button-store.ts:535,979`, `auth/secrets-store.ts:266,311,337`, …), the connection regularly sits in an open BEGIN across event-loop yields — and any concurrent mutex-bypassing read on the same connection observes **uncommitted** state (SQLite has no read isolation within one connection). Example exposure: `open/composer.ts:2358-2366` (`probeInFlightImport`, which gates onboarding finalization) reads `import_jobs` via `db.raw().query(...)`.
2. **`raw()` is not rare.** Census: ~70 `.raw()` call sites across 30 production files (excluding tests, the migration runner, and the PTY ring-buffer `raw()` in the REPL substrate). Most are reads, but at least two are **unserialized, retry-less writes on the shared instance DB**:
   - `gateway/realmode-composer/build-synthesis-import-runner.ts:163-174` — a sync `db.raw().run('UPDATE import_jobs …')` from a progress callback, explicitly to dodge the async API. If it lands during another path's open transaction it is captured into that transaction and silently rolled back with it; it also skips busy-retry.
   - `onboarding/wow-moment/telemetry.ts:178-191` — `UPDATE wow_events … RETURNING id` executed via `.raw().query(...).get(...)`.
3. **The canonical package bypasses its own wrapper.** `persistence/app-chat-store.ts:136` (and receipts `:115`, reactions `:144`, edits `:174`) use `tx.raw().run(...)` inside transaction callbacks — partly to keep callbacks synchronous (which is actually *safer*, shrinking the open-BEGIN window) and because `ProjectDb.run` returns `Promise<void>` with no `changes`/`lastInsertRowid` (needed by e.g. `connect/guest-invite-store.ts:166`, `onboarding/api/invite-link-generate.ts:313-316`). The API's gaps (async-only, void-returning) are the direct cause of the escape-hatch culture.

**Proposal** (behavior-preserving, mechanical): widen `ProjectDb` with (a) typed read methods `get/all` (mutex-free, matching today's semantics but named and greppable), (b) `runSync(sql, params): {changes, lastInsertRowid}` that asserts no foreign transaction is open (or enqueues via the mutex), (c) keep `transaction()` but document/encourage sync callbacks. Migrate the ~70 `raw()` sites (most become `get/all` one-liners), then restrict `raw()` to `migrations/runner.ts` with a lint. Add the missing regression test: a `raw()` write landing inside another caller's open async transaction. Delete the dead `CHECKPOINT_EVERY_N_WRITES` (`persistence/retry.ts:38`, zero consumers).

**Behavior risk**: low if the new methods are byte-compatible wrappers; the one deliberate sync write (synthesis progress) must stay sync — `runSync` covers it. The load-bearing subtleties to preserve verbatim: ALS re-entry (`db.ts:217`), mutex chain rebuilt with swallowing catch (`:221-224`), `isBusyError` rejecting `BusyRetryExhaustedError` (`retry.ts:54`), async sleeps (`retry.ts:20-33` — sync sleeps starve WATCHDOG=1). Effort: **M**.

---

## 3. [P1] No schema ownership: shared tables are addressed by inline SQL from up to 12 modules, with divergent write dialects for the same column

There is no rule that a table has one owning store. Verified census of files issuing SQL (`FROM/INTO/UPDATE/DELETE`) against shared instance tables:

| table | files touching it via inline SQL |
|---|---|
| `projects` | **12** — `gateway/projects/sqlite-store.ts` (nominal owner) plus `gateway/realmode-composer/{project-create.ts:86-92, build-landing-stack.ts, build-onboarding-finalize.ts}`, `onboarding/wow-moment/actions/03-project-shells.ts:304-463` (`INSERT OR IGNORE INTO projects`, `UPDATE projects` — a second project-creation writer), `open/{composer.ts, chat-topics-surface.ts:191, doc-search-live-enumerator.ts, project-persona-resolver.ts}`, `gateway/boot-helpers.ts:425-427`, `connect/invite-preview-handler.ts`, `cores/free/agent-settings/src/backend.ts` |
| `onboarding_state` | **8** — the store (`sqlite-state-store.ts`) plus `onboarding/interview/{resume-cron.ts:189,267, import-running-cron.ts}`, `onboarding/overnight/register.ts:297`, `onboarding/telemetry/event-emitter.ts`, `gateway/realmode-composer/resolve-onboarding-phase.ts:84-86`, `gateway/upload/import-resume-handler.ts:184-186`, `open/composer.ts` |
| `tasks` | 6 — `tasks/store.ts` plus `tasks/{focus-score-cron,prioritize-llm}.ts`, `gateway/tasks/p6/{nudge-engine,staleness-engine}.ts`, `gateway/http/app-focus-current-surface.ts` |
| `app_chat_messages` | 6 — the 4 persistence stores plus `gateway/projects/sqlite-store.ts:302` (sidebar join) and `open/composer.ts` |
| `import_jobs` | 5 — dead runner, live synthesis runner, `gateway/upload/import-resume-handler.ts:126-128`, `open/composer.ts:2358` |

The sharpest consequence: **two write dialects for the same JSON column**. `onboarding_state.phase_state_json` is shallow-merged in JS inside the store's transaction (`sqlite-state-store.ts:98-102`), but `resume-cron.ts:266-276` mutates it directly with SQL `json_remove(...)`, and external modules read it raw. Any change to the merge/codec semantics in the store silently diverges from the SQL-side writer. Similarly, `03-project-shells.ts` re-implements project row creation next to `project-create.ts` (kept aligned only by the shared slugifier convention).

By contrast, `button_prompts` (only `channels/button-store.ts`) and `code_trident_runs` (only `trident/store.ts`, plus the deliberate cross-process Bash writer — see §6) show the intended shape.

**Proposal**: adopt "one owning module per table" as the persistence convention. Mechanically: move the stray SQL into methods on the owning store (resume-cron's `json_remove` becomes a store method; overnight/telemetry readers become store queries; the projects-table writers converge on `gateway/projects/sqlite-store.ts` + `project-create.ts`). Enforce with a cheap conformance test: for each table name in `expected-schema.txt`, assert the set of files containing that table name in SQL matches a committed ownership map (new violations fail CI). Keep SQL byte-identical while moving.

**Behavior risk**: pure code motion if the SQL strings are moved verbatim; the risk is ordering-sensitive callers (e.g. resume-cron's rollback marker must stay best-effort and non-throwing, `resume-cron.ts:277-283`). Effort: **L** (broad but shallow).

---

## 4. [P1] In-memory registries hold restart-durable state (beyond the import runner)

A durability census of long-lived in-memory structures, distinguishing deliberate from accidental:

**Accidental / never-finished (should become durable):**
- **Subagent registry** — `runtime/subagent/registry.ts:1-12` states outright: *"At S3 the registry is in-process only; S4 wires it to a SQLite-backed table so the lifecycle watchdog can survive a gateway restart and reap orphaned children."* S4 never landed (no persistence anywhere in `runtime/subagent/`; `control.ts:118-121` still says "S4 swaps for an event-emitter-driven wait"). Consequence: any dispatched background agent (Atlas/Sentinel/ad-hoc via `/dispatch` or `dispatch_agent`) is orphaned by a gateway restart — the watchdog loses the record, no completion/failure is ever surfaced, and the spawned process (if any) leaks. Trident escaped this exact hole by moving to the DB-backed `code_trident_runs` harvest model; agent-dispatch did not.
- **GBrain deferred-edge queue** — `gbrain-memory/GBrainSyncHook.ts:130-139`: the ISSUES #102 retry queue for typed edges whose target page hasn't landed is a RAM `Map`; restart drops queued edges silently, recoverable only if the subject page happens to be rewritten. Nothing persists the sync latch state or last-success timestamp either, so memory-graph divergence is undetectable in-product (only the host-level `bin/neutron doctor`).

**Documented, deliberate trades (do NOT "fix" silently — but record in one place):**
- **Recovered-reply buffer** — `gateway/http/recovered-reply-store.ts:40-52` documents the accepted residual: a restart in the window after replay-persist but before reconnect loses the proactive re-push (conversation state itself is durable via the disk-backed pending-respawns queue).
- **Trident orchestrator `fired`/`redispatched` sets** — `trident/orchestrator.ts:198-206`: per-process **by design**; losing them on restart *is* the orphan-detection mechanism. A well-meaning "make it durable" refactor would break orphan recovery.
- **ApprovalManager pending map** (`tools/approval.ts:78`) — moot until the HITL system is wired at dispatch (cores-platform critic's P0).

**Proposal**: (a) land the promised subagent-registry persistence (a small table + boot-time reap mirroring profile-pic's restart-resume heuristics), or explicitly renounce it and delete the S4 comments; (b) persist a tiny `gbrain_sync_state` row (latch reason, last-success ts) + optionally journal deferred edges to a table drained at boot — additive observability, keep fail-soft semantics byte-identical; (c) write the durability-tier decision rule (instance table / sidecar / file / RAM-by-design) into `persistence/AGENTS.md`, and annotate the two deliberate RAM stores as such where they're defined. Effort: **M**.

---

## 5. [P1] Five persistence idioms, ~60 hand-rolled modules, and 8 different sidecar pragma cocktails — no shared kernel, no decision rule

Idioms in production (each re-decided per feature):
1. `ProjectDb` store class over the instance DB (44 files) — the canonical path, WAL + mutex + busy-retry.
2. Raw `bun:sqlite` sidecar with **inline schema** (no migration bookkeeping): `doc-search/store.ts:143-179` (`SCHEMA` const), `gateway/storage/binary-store.ts:726-728`, `cores/runtime/data-namespace.ts`.
3. Raw sidecar with its **own migration tree** through the shared runner: `gateway/comments/` + `migrations/comments/`, and cores sidecars via `applyProjectScopedMigrations` (`cores/free/calendar/migrations/runner.ts:19,32` — pattern duplicated per core, "mirrors … byte-for-byte").
4. JSON file state (`scribe/scribe-budget.ts`, `gbrain-doctor.json`).
5. Append-only markdown (reflection diary/corrections; entity pages via two different atomic-write idioms — `runtime/entity-writer.ts:331-343` hand-rolled tmp+rename vs `runtime/atomic-write.ts`).

Verified sidecar connection discipline (each opens `new Database` with a different pragma cocktail, none with busy-retry):

| sidecar | WAL | busy_timeout | FK | retry |
|---|---|---|---|---|
| ProjectDb (reference) | ✔ | ✔ 100ms | ✔ | ✔ jittered ×15 |
| doc-search `store.ts:175-178` | ✔ | ✘ | ✔ | ✘ |
| binary-store `:726-728` | ✔ | ✘ | ✔ | ✘ |
| comments `comment-store.ts:885` | ✘ (none at all) | ✘ | ✘ | ✘ |
| research `store-resolver.ts:210` | ✘ | ✘ | ✔ | ✘ |
| email `cache.ts:335` | ✘ | ✘ | ✔ | ✘ |
| code-gen `sidecar/store.ts:415` | ✘ | ✘ | ✔ | ✘ |
| calendar `cache.ts:167-168` | ✘ | ✔ 100ms | ? | ✘ |
| calendar brief-queue `:326` | ✘ | ✔ 100ms | ✘ | ✘ |
| data-namespace | ✘ | ✘ | ✘ | ✘ |

Sidecars are lower-contention than the instance DB, but several are written from cron/scheduler paths concurrent with tool dispatch (calendar brief queue, email cache), and comment-store is written by both the HTTP surface and the agent-watcher. A `SQLITE_BUSY` here throws straight up with no retry, and non-WAL sidecars block readers during writes.

Within the canonical idiom, the four app-chat stores (`persistence/app-chat-{store,receipts,reactions,edits}.ts`, 932 prod LOC) are four copies of one shape: append-idempotent by `(topic_id, key)` → per-topic `MAX(seq)+1` → replay-after-seq with limit → aggregate. Every store also re-implements JSON column codecs (16 files hand-roll `JSON.parse` with three different corrupt-data semantics: return null / return {} / throw) and `now` injection.

**Proposal**: (a) one `openSidecar(path, opts)` helper in `persistence/` applying the ProjectDb `STARTUP_PRAGMAS` + optional busy-retry wrapper — every sidecar adopts it (a one-line change each; behavior change is limited to added pragmas, which are safe); (b) extract the 3-4 genuinely repeated store helpers (JSON codec with explicit corrupt-policy, row mapper, now seam) — not an ORM; (c) fold the four app-chat stores into one generic per-topic event log behind the existing four interfaces (the app-ws adapter already consumes interfaces, so the seam is right); (d) write the one-page decision rule (instance table vs sidecar vs file) in `persistence/AGENTS.md`. Effort: **M**.

**Behavior risk**: pragma additions change lock behavior (busy_timeout on a previously fail-fast sidecar) — strictly more tolerant, but verify no caller relies on immediate BUSY failure. The app-chat fold must preserve per-store replay-limit defaults and idempotency keys exactly (four small test suites already pin them).

---

## 6. [P2, S-effort] Trident's cross-process DB writes: LLM-executed `sqlite3` CLI with no busy_timeout

The exec-model's harvest signal is written to `code_trident_runs` **from the detached workflow process** by prompting an agent to run a `sqlite3` one-liner:
- `trident/inner-workflow.mjs:403-407` (per-phase checkpoint) and `:443-447` (terminal result): `sqlite3 "${dbPath}" "UPDATE code_trident_runs SET …"`.

The `sqlite3` CLI's default busy timeout is **0** — if the gateway's ProjectDb connection holds the WAL write lock at that instant (chat logs, button prompts, cron state write constantly), the UPDATE fails immediately with `database is locked`. The step prompt says "must NOT fail the build", so a failed checkpoint is swallowed — but a lost `inner_checkpoint='argus-approved'` blocks the provenance-gated merge (`trident/orchestrator.ts:336-380`), and a lost `inner_result` write means the harvest never fires and the run is eventually hang-reaped at 25m. Low-probability per write, but the failure is invisible and expensive. Secondary fragility: `runId`/`forgeBranch` are string-interpolated into SQL inside a double-quoted shell string (currently machine-generated values; still a footgun).

**Proposal**: prepend `PRAGMA busy_timeout = 5000;` to the SQL (or `-cmd '.timeout 5000'`) in both Bash steps — a two-line change preserving idempotence and the no-fail contract. Longer term (with the trident-v2 work): replace "prompt the agent with raw SQL" with a tiny checked-in script (`trident/checkpoint.sh <db> <run> <name> …`) the agent invokes, so the SQL is not LLM-transcribed. Effort: **S**. Behavior risk: none beyond making writes succeed more often; must not add retries to the *terminal* write in a way that could double-fire (it's an idempotent UPDATE, so safe).

---

## 7. [P2] Two divergent durable chat transcripts (data-model view)

The same conversation persists into two tables with different fidelity, via a double-write:
- `gateway/realmode-composer/build-live-agent-turn.ts:986,1472` — agent replies emit into `button_prompts` (options in `options_json`, `[[OPTIONS]]` stripped from body).
- `channels/adapters/app-ws/adapter.ts:174-199` — the same replies append into `app_chat_messages` (seq-ordered, but dropping options/citations/prompt_id on resume replay).
- `channels/button-store.ts:289-368` — `persistInertAgentTurn`/`persistInertUserTurn` store *user messages as empty-body pre-resolved prompts* so the web transcript can be rebuilt from `button_prompts` (schema abuse in the primary transcript store).

HTTP history, WS resume, sidebar rail, reflection reads and message-search each pick one of the two stores, so hydration fidelity depends on the path. The chat-transport critic owns the protocol view; the data-layer resolution is: make `app_chat_messages` the single durable transcript (add nullable metadata columns for options/prompt_id/citations), shrink `button_prompts` back to prompt lifecycle (emit/resolve/expire/idempotency), and add a hydration-parity test before any migration. Effort: **L**. Behavior risk: high without the parity test — ordering tiebreaks (`button-store.ts:736-815` rowid-DESC vs pagination tuple ordering) are documented landmines.

---

## 8. [P2] JSON-in-columns without a codec layer; `phase_state` is the worst case

61 `*_json` column references in migrations; 16 stores hand-parse. Three different corrupt-data policies coexist (e.g. `sqlite-state-store.ts:293-303` returns `{}` on corrupt phase_state — silently resetting onboarding sub-state; others throw). The `phase_state` grab-bag specifically is written through **three mechanisms**: the store's JS shallow-merge (`sqlite-state-store.ts:98-102`), SQL `json_remove`/`json_extract` from resume-cron (`resume-cron.ts:266-276`), and an LLM-writable whitelist merge in the engine (`engine.ts:372-392`, "cast is compile-time only") — with raw external readers (`open/composer.ts:2975`, upload handlers, agent-settings core). The onboarding critic owns the key-registry proposal; from the data layer: give each contract-bearing JSON column a typed codec module (parse + validate + corrupt-policy) and route all writes through the owning store (per §3), so codec changes are single-point. Effort: **M**.

---

## 9. [P2] The schema layer is not a leaf: layering violations in migrations/ and reminders/

- `migrations/runner.ts:6` imports `resolveOpenDbPath` from `open/owner-identity.ts` — the schema layer depends on a product surface, solely for the `import.meta.main` CLI block (`:174-185`). Move the path resolution into migrations or a tiny paths leaf.
- `reminders/dispatcher.ts:25-33` imports `gateway/realmode-composer/build-llm-call-substrate.ts`; `reminders/outbound.ts:22-26` imports `landing/server.ts` + `gateway/http/chat-bridge.ts` + `channels/button-store.ts`, while `reminders/package.json` declares only cron+persistence. The dispatcher already defines the right seams (`ReminderOutbound`, injected substrate) — move `outbound.ts` up into gateway composition; reminders becomes a clean store+tick leaf.
- Undeclared deps throughout the data layer (scribe→runtime, gbrain-memory→runtime/core-sdk/tools, tasks→runtime/cron/onboarding/reminders) make extraction order unplannable; declare them and lint `../<other-workspace>/` imports.

All mechanical, zero behavior change. Effort: **S** (per-package). This is the prerequisite for every other extraction in this report.

---

## 10. [P2] Tenant vocabulary is baked into the schema: `project_slug` columns hold the OWNER slug on ~10 tables

Verified: `tasks/store.ts:114-118` carries both `project_slug` (actually the instance/owner slug — `open/composer.ts:405`: `const internal_handle = project_slug`) and `project_id` (the real project). Same duality on `reminders` (`store.ts:33-36`), `secrets`/`api_keys` (`auth/secrets-store.ts:196` binds `internal_handle` to a `project_slug = ?` predicate — with a documented 2026-05-12 prod defect from passing the wrong slug), `onboarding_state`, `import_jobs`, `wow_events`, `gateway_events`, `task_reminder_links`. In a single-owner product every such column is a constant, and its name actively instructs misuse.

**Proposal** (rides the declared repo-wide tenant rename, sequenced LAST): one coordinated migration renaming `project_slug`→`owner_slug` (or dropping where redundant) + store/type sweep + snapshot regen; in the interim, a branded `InternalHandle` type at the `SecretsStore` boundary (the credential-loss trap). **Never renumber existing migrations** — live `_migrations` tables make renumbering a re-apply. Effort: **L**. Behavior risk: high if rushed (every SQL string touches it); the schema snapshot test is the guard.

---

## 11. [P2] The entity-page on-disk format is triplicated across writer, scribe, and sync hook

The entity-writer's private on-disk format (frontmatter render, compiled-truth slice, kind→dir map) is hand-mirrored twice: `scribe/write-to-gbrain.ts:525` (*"Mirror of entity-writer.ts:extractCompiledTruth (not exported there)"*), `:467-482` (`parseFrontmatter` = hand inverse of `renderYamlFrontmatter`), `:331-338` (`KIND_TO_DIR`), and `gbrain-memory/GBrainSyncHook.ts:45-54` (`DIR_TO_KIND`, "the writer is upstream" comment). This is precisely the code protecting against memory data loss (append-only merge, never-replace-richer-page, frontmatter preservation — `write-to-gbrain.ts:19-41`), and it can drift silently. The slug function was already deduplicated once for this exact reason (`write-to-gbrain.ts:540-546`, "Open refactor P2-8").

**Proposal**: export `extractCompiledTruth`, the frontmatter parse/render pair, and `KIND_TO_DIR` from a `runtime/entity-format.ts` leaf; delete both mirrors; pin with a golden round-trip test (render → parse → byte-equal). Effort: **S**. Behavior risk: near-zero (the mirrors claim byte-compatibility today; the golden test proves it before deletion).

---

## 12. [P3] Migration + persistence hygiene

- Numbering gaps are permanent: 0058→0060 and 0063→0069 in the main tree (verified by ls), 0002 missing in comments/. The runner tolerates gaps; document them as reserved-forever in `migrations/AGENTS.md` (which also stale-claims "~80 LOC runner" vs actual 196 and CREATE-IF-NOT-EXISTS idempotency).
- `migrations/runner.ts:116-118` justifies the FK re-assert by citing "0067's projects rebuild" — no 0067 exists in this repo (history-squash artifact). Fix the comment; keep the `finally` FK re-assert (load-bearing).
- Dead: `CHECKPOINT_EVERY_N_WRITES` (`persistence/retry.ts:38`, zero consumers); `migrations/index.ts` exports only `__MODULE__`; `applyProjectScopedMigrations` is a pure alias (`runner.ts:57-62`) — collapse to `@see`.
- Inline-schema sidecars (doc-search, binary-store, data-namespace) have no `_migrations` bookkeeping — schema evolution there requires hand-written `IF NOT EXISTS`/ALTER guards; when touched, migrate them onto `applyProjectScopedMigrations` like calendar/email/code-gen already do.
- `tabs/` is a floating non-workspace directory; `neutron-backup.sh:94-124` handles WAL checkpointing correctly (`wal_checkpoint(TRUNCATE)` + header sniff) — no finding there.

Effort: **S**.

---

## Load-bearing subtleties a refactor MUST preserve (data layer)

1. `ProjectDb` mutex + ALS re-entry (`db.ts:216-226`); swallowing mutex-chain rebuild; `isBusyError` rejects the exhaustion wrapper (`retry.ts:47-59`); **async** busy-retry sleeps (systemd watchdog starvation otherwise).
2. Migration runner: PRAGMA preamble hoisted out of the per-migration transaction (`runner.ts:89-95`); `PRAGMA foreign_keys=ON` re-asserted in `finally` (`:114-126`); per-migration BEGIN/COMMIT atomicity; never renumber/backfill versions.
3. Schema snapshot test = the refactor's safety net; regen only via `regen-snapshot.ts`.
4. `sqlite-state-store` upsert is a read-merge-write **inside one transaction** (`:82-210`); single-statement crash-atomicity claims in the header depend on it.
5. Trident `fired`/`redispatched` in-memory sets are crash-safe **by design** (`orchestrator.ts:198-206`) — durability here would break orphan recovery.
6. GBrainSyncHook: remove-before-add edge ordering, once-only binary-missing latch, deferred-drain on pageLanded (`GBrainSyncHook.ts:130-148,199-256`) — keep fail-soft byte-identical while adding observability.
7. Reminders: single-flight tick, claim-then-dispatch with only-if-unchanged reverts, persist-before-send outbound to the `app:` registry (`reminders/tick.ts`, `store.ts:234-293`, `outbound.ts:7-18`).
8. Task↔reminder link writes share the task mutation's transaction (`tasks/reminder-link.ts:97`).
9. App-chat: idempotency on `(topic_id, client_msg_id)`, per-topic `MAX(seq)+1` inside the transaction, persist-first-then-fan-out in the adapter (`adapter.ts:174-199`).
10. Import runner: honest-failure gate (`build-synthesis-import-runner.ts:203-220`), fire-and-forget with swallowed escapes → `failed` row, cancel-set checked before result publication (`:191`).
11. `button_prompts` ordering tiebreaks: history pagination (inclusive first page, strict composite later) vs `latestPromptByTopic` rowid-DESC — different on purpose (`button-store.ts:697-714,736-815`).

## Proposed target architecture (summary)

1. **persistence/ becomes the kernel**: ProjectDb (widened API: typed reads, `runSync` with changes/rowid, tx-aware), `openSidecar()` with canonical pragmas, shared JSON-codec + row-mapper helpers, generic per-topic event log. `raw()` restricted to the migration runner by lint.
2. **One owning store per table**, enforced by a table-ownership conformance test keyed off `expected-schema.txt`.
3. **Durability tiers written down** (instance table / sidecar+migrations / file / RAM-by-design) in `persistence/AGENTS.md`; every RAM-by-design store annotated at the definition.
4. **Close the known durability holes**: import results + orphan sweep (P0), subagent registry persistence (or renounce), gbrain sync-state row.
5. **Sequencing**: deps-truthing (§9) → ProjectDb API + raw() migration (§2) → table ownership moves (§3) → app-chat fold + sidecar helper (§5) → durability fixes (§1, §4) → transcript unification (§7, with parity test) → schema vocabulary rename last (§10), guarded by the snapshot test throughout.
