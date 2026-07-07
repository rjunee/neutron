# Subsystem map: data-memory

Audit of `persistence/`, `migrations/`, `gbrain-memory/`, `scribe/`, `reflection/`, `doc-search/`, `tasks/`, `reminders/`, `tabs/` in `/Users/ryan/repos/neutron-open` (branch `main`, 2026-07-02). All paths repo-relative unless noted.

---

## 1. Purpose & responsibilities

This is Neutron Open's data + memory layer:

- **persistence/** — the canonical SQLite access wrapper (`ProjectDb`: WAL pragmas, per-instance async mutex, jittered busy-retry) plus the four app-chat durable logs (messages / receipts / reactions / edits) backing the `/ws/app/chat` resume protocol.
- **migrations/** — 90 forward-only `.sql` files + a ~200-line runner with per-migration atomicity, PRAGMA-preamble hoisting, a byte-identical schema snapshot test, and a sidecar-tree variant (`migrations/comments/`).
- **gbrain-memory/** — the long-term memory substrate adapter: `MemoryStore`/`McpClient` seams over the external `gbrain` binary (stdio MCP), the `GBrainSyncHook` that fans entity-writer output into GBrain pages + typed edges, idempotent brain init (`ensure-brain-init.ts`), the `gbrain_search` agent tool, and a host-level upgrade/verify doctor.
- **scribe/** — chat-time knowledge extraction: budget-gated LLM extraction of entities/relations from user turns (and Core rows), written through `runtime/entity-writer.ts` → GBrainSyncHook.
- **reflection/** — file-based diary (`<home>/diary/YYYY-MM-DD.md`) + corrections-log (`<home>/corrections/corrections-log.md`) append-only stores plus an LLM correction detector.
- **doc-search/** — SQLite FTS5 BM25 index over project markdown (own sidecar DB at `<owner_home>/cache/doc-search/index.db`), optional embedder blend, `doc_search`/`doc_read` agent tools.
- **tasks/** — canonical instance task table (migration 0032/0037/0085) + focus-score cron, LLM prioritizer, STATUS.md/ACTIONS.md projections, reminder auto-link, history-import seeder, overnight hook.
- **reminders/** — reminder rows + 30s single-flight tick loop + fire-time dispatcher (LLM-composed body with literal fallback) + durable-then-live outbound.
- **tabs/** — a pure tab-descriptor resolver (NOT a workspace package; two files) consumed by `gateway/http/app-tabs-surface.ts` and mirrored by both clients.

## 2. Module inventory (main tree; wc -l)

| Module | Files (non-test) | Notable sizes |
|---|---|---|
| persistence/ | db.ts 242, retry.ts ~110, app-chat-store 222, app-chat-edits 255, app-chat-reactions 244, app-chat-receipts 211, errors.ts, index.ts | 4 near-parallel app-chat stores ≈ 930 LOC |
| migrations/ | 90 SQL files + runner.ts 196, schema-serialize.ts, regen-snapshot.ts, expected-schema.txt (1,501 lines) | comments/ sidecar tree: 0001, 0003, 0004 |
| gbrain-memory/ | gbrain-doctor.ts 670, GBrainSyncHook.ts 495, gbrain-stdio-client.ts 262, ensure-brain-init.ts 227, gbrain-memory-store.ts, memory-store.ts, agent-tool.ts, embedder-config.ts, resolve-gbrain-command.ts, version-notice.ts | |
| scribe/ | write-to-gbrain.ts 546, extract.ts 286, scribe-budget.ts 278, index.ts 275, compose-payload.ts | |
| reflection/ | detector.ts 273, diary-store.ts 191, corrections-store.ts, context.ts, index.ts 197 | |
| doc-search/ | store.ts 432, chunk.ts 223, walk.ts 200, indexer.ts, query.ts, runtime.ts, tool.ts, projects.ts | |
| tasks/ | store.ts 673, prioritize-llm.ts 516, reminder-link.ts 333, projection/{write 259, format 221, parse}, focus-score{,-cron}, history-import-seeder, overnight-task-hook | |
| reminders/ | store.ts 464, dispatcher.ts 282, tick.ts 281, outbound.ts, context.ts, message-shape.ts, prompt.ts | |
| tabs/ | registry.ts 239 (+ __tests__) — **no package.json** | |

No god files inside this subsystem (largest is 673 lines); the god files that *touch* it are outside (open/composer.ts ~3.7k does all the wiring).

## 3. Public seams other subsystems consume

- `ProjectDb` + `open()` / `run()` / `transaction()` / `prepare()` / `raw()` — `persistence/db.ts:53`. Consumed by ~35 store classes across the repo (see §6.3).
- `AppChatMessageLog` (+ receipt/reaction/edit logs) — `persistence/app-chat-store.ts:58`; the app-ws adapter depends on the interface, gateway wires `AppChatStore`.
- `applyMigrations(db, dir?)` / `applyProjectScopedMigrations` — `migrations/runner.ts:64,57`. Called once at boot (`gateway/index.ts:182`) and by the comments sidecar (`gateway/comments/comment-store.ts:52`).
- `MemoryStore` + `McpClient` — `gbrain-memory/memory-store.ts` (substrate-neutral memory contract; admin Memory tab + `gbrain_search` tool ride on it).
- `GBrainSyncHook implements SyncHook` (`runtime/entity-writer.ts:168` contract) — `gbrain-memory/GBrainSyncHook.ts:124`; threaded by `gateway/realmode-composer/build-gbrain-memory.ts` into scribe, history-import populator, project materializer, docs writer (`open/composer.ts:876-886, 1294, 2244, 2343`).
- `createScribe(...)` → `handleUserTurn` / `extractAndWrite` / `extractFromCoresSource` — `scribe/index.ts:159`; fired by chat-bridge after every real user turn (`open/composer.ts:3156, 3397`) and by Calendar/Email Core fire callbacks.
- `createReflection(...)` — `reflection/index.ts`; wired at `open/composer.ts:924`.
- `DocSearchIndex` / `DocSearchRuntime` + `doc_search`/`doc_read` tools — `doc-search/store.ts:164`, `runtime.ts:37`; opened at `open/composer.ts:793-796`.
- `TaskStore` (+ `subscribe` mutation stream), `attachReminderLinkSubscriber`, `seedTasksFromImportResult`, `createOvernightReviewTask`, projection writer — `tasks/`. Single canonical store instance is supposed to flow through `gateway/composition/input/tasks-input.ts:40` (comment: "Without this seam each surface would call `new TaskStore(db)`"), yet `open/composer.ts:2025` still does `new TaskStore(db)` for the app surface (benign today — mutation-stream subscribers hang off the composition instance — but it is exactly the bypass the seam warns about).
- `ReminderStore`, `startReminderTick`, `ReminderDispatcher`, `ReminderOutbound` — `reminders/store.ts`, `tick.ts:21`, `dispatcher.ts:35`.
- `resolveTabs` + `TabDescriptor` — `tabs/registry.ts`; consumed by `gateway/http/app-tabs-surface.ts:42` and shape-mirrored (hand-copied types) in `app/lib/tabs-client.ts:15`.

## 4. Workspace dependencies — declared vs actual

Declared (`package.json`) is close to fiction for this layer:

| Package | Declares | Actually imports (relative-path, undeclared) |
|---|---|---|
| persistence | (none) | — clean leaf ✔ |
| migrations | (none) | `open/owner-identity.ts` (`runner.ts:6`) — migrations → open (!) |
| gbrain-memory | @modelcontextprotocol/sdk | `runtime/auto-link.ts`, `runtime/entity-writer.ts` (`GBrainSyncHook.ts:37-38`), `core-sdk/types.ts`, `tools/registry.ts` (`agent-tool.ts:34-35`) |
| scribe | (dev: gbrain) | `runtime/substrate.ts`, `runtime/entity-writer.ts`, `runtime/entity-slug.ts`, `runtime/atomic-write.ts` (`index.ts:32-34`, `write-to-gbrain.ts:45-46`, `scribe-budget.ts:42`) |
| reflection | @neutronai/runtime ✔ | consistent |
| doc-search | core-sdk, tools ✔ | consistent |
| tasks | @neutronai/persistence | `runtime/atomic-write.ts` (`projection/write.ts:23`), `cron/handlers.ts`+`cron/jobs.ts` (`focus-score-cron.ts:21-27`), `onboarding/history-import/types.ts` (`history-import-seeder.ts:18`), `reminders/store.ts` (`reminder-link.ts:23`) |
| reminders | @neutronai/cron, @neutronai/persistence | **`gateway/realmode-composer/build-llm-call-substrate.ts`** (`dispatcher.ts:28`), `runtime/models.ts`, `runtime/substrate.ts`, `core-sdk/types.ts` (`dispatcher.ts:25-27`), **`landing/server.ts`, `gateway/http/chat-bridge.ts`, `channels/button-store.ts`, `channels/button-primitive.ts`** (`outbound.ts:22-26`) |
| tabs | n/a (not a package) | imported by relative path from gateway + composer |

Deps **in** (who imports this subsystem): gateway (boot + every surface), open/composer.ts (all wiring), channels (app-ws → AppChatStore interface), onboarding (history-import → tasks seeder, entity populator → GBrainSyncHook), cores/free/tasks + cores/free/reminders (backends over the same stores), trident/work-board/skill-forge/watchdog/project-credentials (ProjectDb), app + landing (tabs type mirror over HTTP).

## 5. Internal layering (as-built)

```
migrations (schema)         persistence (ProjectDb)        [file-state: reflection, scribe-budget, diary]
        \                        |
         \             feature stores over ONE instance DB:
          \            tasks, reminders, app-chat-*, plus ~30 stores in other workspaces
           \                     |
            \        sidecar DBs (own schema, own lifecycles):
             \         doc-search index.db, gateway/comments/.comments/comments.db,
              \        gateway/storage/binary-store, cores data-namespace/caches
               \                 |
   memory pipeline: chat turn → scribe (budget→LLM extract) → runtime/entity-writer (md pages on disk)
                                  → GBrainSyncHook → gbrain serve child (MCP stdio) → PGLite brain
   recall: gbrain_search tool + admin Memory tab → GBrainMemoryStore.query
```

Boot order (load-bearing): `ProjectDb.open(dbPath)` → `applyMigrations(db.raw())` → composer (`gateway/index.ts:181-182`). One `ProjectDb` per process; every instance-DB store shares it.

## 6. Architectural debt

### 6.1 [P1] The reminders package is layer-inverted: a "data" workspace imports the composition root and the edge

`reminders/dispatcher.ts:28` imports `collectTokensToString` from `gateway/realmode-composer/build-llm-call-substrate.ts`; `reminders/outbound.ts:23-25` imports `ChatOutbound` from `landing/server.ts` and `WebChatSenderRegistry` from `gateway/http/chat-bridge.ts` (a 3.1k-line god file — so reminders is transitively coupled to the whole chat bridge), plus `channels/button-store.ts`. Declared deps say cron+persistence only. Consequence: you cannot type-check, test, or extract the reminders package without loading gateway+landing+channels; any chat-bridge refactor can break reminder delivery invisibly. **Sketch:** dispatcher already defines the right seams (`ReminderOutbound`, LLM substrate param) — move `outbound.ts` and the `collectTokensToString` dependency up into `gateway/` (composition owns delivery), keep `reminders/` = store + tick + message-shape + prompt, and let gateway inject the outbound. Zero behavior change; pure file/ownership move.

### 6.2 [P1] The package.json dependency graph is fiction — undeclared cross-workspace imports throughout the layer

Evidence table in §4: scribe→runtime, gbrain-memory→runtime/core-sdk/tools, tasks→runtime/cron/onboarding/reminders, migrations→open (`runner.ts:6` pulls `resolveOpenDbPath` from `open/owner-identity.ts` just for the CLI entry). Since everything is raw TS imported by relative path, Bun tolerates it, but: (a) the workspace boundaries carry no information, so nobody can reason about extraction order for the refactor; (b) `tsc -p <leaf>` configs and per-package test isolation silently depend on files outside the package; (c) the migrations→open edge makes the *schema layer* depend on a *product surface*. **Sketch:** declare every actual dep (mechanical, one PR, no runtime change); move `resolveOpenDbPath` into migrations or a tiny shared `paths` leaf; then enforce with a lint rule (no `../<other-workspace>/` imports).

### 6.3 [P1] Four-plus persistence idioms with no decision rule; the ProjectDb serialization invariant is bypassable and bypassed

Idioms in production:
1. **ProjectDb over the one instance DB** — the canonical path; ~35 store classes take `constructor(db: ProjectDb)` (e.g. `gateway/projects/sqlite-store.ts:127`, `tasks/store.ts`, `reminders/store.ts`, `trident/store.ts:210`, `work-board/store.ts:215`, `cron/state.ts:23`).
2. **Raw `bun:sqlite` sidecars with self-owned inline schema** — `doc-search/store.ts:105-181` (own WAL DB, no busy-retry, no mutex), `gateway/storage/binary-store.ts`, `cores/runtime/data-namespace.ts`, `cores/free/{calendar,email}/src/cache.ts`, `cores/free/research/src/*-store.ts`.
3. **Raw sidecar with its own migration tree** — `gateway/comments/comment-store.ts:47-53` + `migrations/comments/` via `applyProjectScopedMigrations`.
4. **JSON file state** — scribe budget at `<owner_home>/.scribe-budget.json` (`scribe/scribe-budget.ts:9-11`), `gbrain-doctor.json` (`gbrain-memory/gbrain-doctor.ts:206`).
5. **Append-only markdown** — reflection diary/corrections (`reflection/diary-store.ts`, `corrections-store.ts`).

Each choice has a written rationale (comment-store's sidecar rationale at `comment-store.ts:11-25` is genuinely good), but there is no shared rule, so every new feature re-decides — and re-implements open/pragma/retry/row-mapping.

The sharper edge: `ProjectDb.raw()` is documented as a migration-runner escape hatch (`persistence/db.ts:85-94`) yet is used at ~15 production sites, including at least one **write**: `gateway/realmode-composer/build-synthesis-import-runner.ts:165` runs `db.raw().run('UPDATE import_jobs …')` from a sync progress callback. `ProjectDb.transaction()` holds the connection open across `await` points (`db.ts:180-207`); a sync raw write landing during one of those yields is captured *inside* the open BEGIN/COMMIT and silently rolled back if the transaction rolls back — exactly the hazard the mutex exists to prevent. Read-only `raw()` uses (e.g. `auth/secrets-store.ts:196`, `auth/api-key-store.ts:145`, `gateway/upload/import-resume-handler.ts:126`) are lower risk but still skip busy-retry. **Sketch:** add `ProjectDb.query()` (mutex-free read) and `ProjectDb.runSync()` (mutex-checked sync write that throws if a transaction is open elsewhere, or enqueues), migrate the 15 `raw()` sites, and shrink `raw()` to the migration runner. Then write the one-page decision rule (instance DB vs sidecar vs file) into `persistence/AGENTS.md`.

### 6.4 [P2] scribe re-implements entity-writer's private on-disk format — duplicated parsers that must never drift

`scribe/write-to-gbrain.ts:525-538` says it outright: "Mirror of entity-writer.ts:extractCompiledTruth (not exported there)". Likewise `parseFrontmatter` (`write-to-gbrain.ts:467-482`) is the hand-written inverse of `entity-writer.ts:renderYamlFrontmatter`, and `KIND_TO_DIR` (`write-to-gbrain.ts:331-338`) triplicates the writer's map, which is *also* duplicated as `DIR_TO_KIND` in `gbrain-memory/GBrainSyncHook.ts:47-54` ("duplicated by design"). The scribe merge path exists to prevent data loss (never overwrite a richer page, never drop populator frontmatter — module header `write-to-gbrain.ts:19-41`); it is precisely the code that must not drift from the writer's emitter, yet it can drift silently today. The slug function was already de-duplicated once for this exact reason (`write-to-gbrain.ts:540-546`, "Open refactor P2-8"). **Sketch:** export `extractCompiledTruth`, `parseFrontmatter`/`renderYamlFrontmatter` round-trip, and `KIND_TO_DIR` from `runtime/entity-writer.ts` (or a `runtime/entity-format.ts` leaf) and delete the mirrors; add a golden round-trip test pinning the format.

### 6.5 [P2] GBrain failure model: fail-soft everywhere, durable nowhere — memory loss is silent by design and the deferred-edge queue is RAM-only

The layer has been hardened *against crashing* (binary-missing latch logged once, `GBrainSyncHook.ts:141-148, 306-313`; init failure → status not throw, `ensure-brain-init.ts:117-193`; empty-result tool degrade, `agent-tool.ts:28-30`), which was the right call after the wow-hang incident. But the consequence is that when gbrain is broken for any *other* reason (bad build, migration failure, PATH gap post-boot), pages keep landing on disk while the GBrain index and typed-edge graph silently diverge, and the only detection is the host-level `neutron doctor` CLI (`bin/neutron:87-95`) — nothing in-product surfaces "memory degraded since <ts>". Additionally the ISSUES #102 deferred-edge retry queue is in-memory only (`GBrainSyncHook.ts:138-139`): edges deferred because their target page hasn't landed are lost on process restart, recoverable only by happening to rewrite the subject page. **Sketch (behavior-preserving core, additive observability):** persist a tiny `gbrain_sync_state` row (last success ts, latch reason) and surface it on the admin Memory tab; optionally journal deferred edges to a table drained at boot. Do not change the fail-soft semantics themselves — they are load-bearing (§8).

### 6.6 [P2] "tenant" vocabulary is baked into this layer's *schema*, not just code

Confirmed here concretely: `tasks/store.ts:116-118` carries both `project_slug` ("project isolation — every read filters by project_slug", `store.ts:16`) and `project_id` — where `project_slug` is actually the **instance/owner slug** (`open/composer.ts:405`: `const internal_handle = project_slug`) and `project_id` is the real project. Same dual on `reminders` (`store.ts:35`), `secrets`/`api_keys` (`auth/secrets-store.ts` queries `WHERE project_slug = ?` binding `input.internal_handle`), `task_reminder_links` (`tasks/reminder-link.ts:41`). In a single-owner product every `project_slug` column is a constant. This is the single most disorienting thing in the layer for a new contributor — a column literally named "project_slug" that must NOT be used to scope by project. **Sketch:** the rename debt is already declared; the data-layer part needs (a) a migration pass renaming columns (`owner_slug` or dropping them where constant), (b) coordinated store/type renames, (c) the snapshot regen. Sequence it *after* store consolidation so it's one sweep, and never renumber existing migrations while doing it (§8).

### 6.7 [P2] ~50 hand-rolled store classes; the four app-chat stores are the clearest fold-up candidate

Repo-wide there are ~50 `*store*.ts` files in the main tree (find in §appendix); each re-implements row-mapping, `now` injection, JSON-column encode/decode, and its own error class. Within this subsystem, `persistence/app-chat-{store,receipts,reactions,edits}.ts` (~930 LOC + 4 test files) are four variations of "append idempotently by (topic_id, key), assign per-topic seq, replay after_seq with limit, aggregate" — same shape, four copies, four `DEFAULT_*_REPLAY_LIMIT`s. **Sketch:** one generic per-topic event-log core parameterized by table + payload codec, with the four current interfaces kept as thin façades (interfaces are consumed by the app-ws adapter, so the seam is already right). Do NOT attempt a generic ORM for the other 45 stores — the class-per-table pattern is fine; just extract the 3-4 genuinely repeated helpers (JSON column codec, row→record mapper, `now` seam).

### 6.8 [P2] Migration numbering has permanent gaps and a stale comment cites a nonexistent migration

Main tree jumps 0058→0060 and 0063→0069 (0059, 0064–0068 absent); `migrations/comments/` has 0001, 0003, 0004 (no 0002). Git history (including `--all`) has no trace of the missing versions — they predate the history squash or died on branches. Meanwhile `runner.ts:117-118` justifies the FK re-assert by citing "0067's projects rebuild" — a file that does not exist in this repo, and `migrations/AGENTS.md` still says "runner is ~80 LOC" (it's 196) and "idempotent (CREATE TABLE IF NOT EXISTS everywhere)" (many later migrations are ALTERs and rebuilds; idempotency actually comes from `_migrations` bookkeeping). Not a correctness bug — the runner tolerates gaps — but it is a trap: a well-meaning "clean up the numbering" would re-apply renumbered files on live installs. **Sketch:** document the gaps as reserved-forever in `migrations/AGENTS.md`, fix the stale runner comment, refresh the AGENTS.md description.

### 6.9 [P3] Dead / vestigial code

- `CHECKPOINT_EVERY_N_WRITES` (`persistence/retry.ts:40`, re-exported `persistence/index.ts:48`) — exported constant with **zero** consumers anywhere; the checkpointing scheme it implies was never built.
- `migrations/index.ts` — the package main exports only `__MODULE__`; every consumer imports `runner.ts` directly.
- `applyProjectScopedMigrations` (`runner.ts:57-62`) — a pure alias of `applyMigrations`; the 20-line comment defending its existence is longer than the function. Harmless, but a naming-as-documentation pattern worth a one-line `@see` instead.
- `tabs/` is not a workspace (absent from root `package.json` workspaces, no package.json) — it's a floating directory imported by relative path; either promote it or fold it into gateway.
- `scribe/scribe-budget.ts` reserves `meeting` trigger ("no meeting Core to ride", `scribe/index.ts:21`) — fine as a union member, flagging for the dead-enum sweep.

### 6.10 [P3] doc-search sidecar duplicates the FTS5 pattern already built in cores/free/research

`doc-search/store.ts:9-10` says it mirrors `cores/free/research/src/vault-search.ts` ("the in-repo precedent for FTS5 + BM25"). Two hand-rolled copies of the external-content-FTS5 + triggers + bm25-normalise pattern (plus `message-search/` outside my scope likely a third). A small shared `fts5-index` helper (schema builder + sanitize + normalise) would collapse them; low urgency.

## 7. Test posture

- **52 test files** across the nine directories; the leaf packages are genuinely well-tested: `migrations/runner.test.ts` (437 lines) + the **schema snapshot test** (`snapshot.test.ts` — applying all migrations must byte-match `expected-schema.txt`, regen via `regen-snapshot.ts`; this is the layer's best guardrail and the refactor's safety net), `reminders/tick.test.ts` (531) incl. claim/revert races, `dispatcher.integration.test.ts`, `tasks/__tests__/` (store 423, prioritize-llm 377, projection 324, reminder-link 200), `persistence/persistence.test.ts` (24 tests: mutex, busy-retry, transaction rollback), `gbrain-memory/__tests__/` (sync-hook 612, doctor 323, agent-tool), scribe round-trip suites against a **real PGLite brain**.
- **Known flake, tamed:** real-PGLite boots are serialized + retried via `gbrain-memory/__tests__/boot-pglite-brain.ts` (process-global mutex + bounded retry for the probe race ISSUES #79 and the WASM-init abort ISSUES #327). Do not weaken; a failing "(unnamed) real GBrain round-trip" in CI is a boot flake, not a regression.
- **Untested:** the `raw()` write-inside-open-transaction hazard (§6.3) has no test; scribe's `parseFrontmatter`/entity-writer emitter round-trip has no shared golden test (each side tests itself); the reminders **outbound** delivery path is tested at unit level but its coupling into chat-bridge types means gateway refactors aren't covered from this side; `tabs` client-side type mirror (`app/lib/tabs-client.ts`) drifts undetected because it is a hand copy, not an import.
- The CI-critical `gbrain init→serve` path was historically untestable (harness boots in-process PGLite — that's how the ND1 "never init'd in prod" bug shipped, `ensure-brain-init.ts:1-14`); `ensure-brain-init` now has unit tests via the runner seam but there is still no end-to-end "spawn the real binary" smoke in CI.

## 8. Load-bearing subtleties a no-behavior-change refactor must preserve

1. **ProjectDb mutex + ALS re-entry** (`db.ts:216-226`): `tx.run`/`tx.exec` inside a `transaction` callback bypass the lock via AsyncLocalStorage — reordering to a naive lock would deadlock. The mutex chain rebuilds with a swallowing `.catch` so one caller's failure doesn't reject queued callers.
2. **`isBusyError` rejects `BusyRetryExhaustedError`** (`retry.ts:49-56`): prevents an outer `transaction` retry loop from replaying a body whose inner `run` already burned 15 retries (15×15 amplification).
3. **Busy-retry is async on purpose** (`retry.ts:20-33`): `Bun.sleep` (not sleepSync) so the systemd watchdog tick keeps firing during contention; converting stores to sync writes would starve WATCHDOG=1 and get healthy gateways killed.
4. **Migration runner mechanics** (`runner.ts:89-126`): PRAGMA preamble hoisted OUT of the per-migration transaction (SQLite forbids journal_mode/foreign_keys inside one); `PRAGMA foreign_keys=ON` re-asserted in a `finally` so a migration that disabled FK (even one that throws) can't leak FK=OFF onto later migrations or the boot connection; per-migration BEGIN/COMMIT atomicity. **Never renumber or backfill gap versions** — live installs' `_migrations` tables make renumbering a re-apply.
5. **GBrainSyncHook ordering**: `remove_link` (predicate-blind) runs BEFORE `add_link` so a surviving predicate on a pair that lost a different predicate gets re-asserted (`GBrainSyncHook.ts:199-256`); the deferred queue drains only when `pageLanded` (`:254-256`); the binary-missing latch logs exactly once and short-circuits forever (`:141-148`).
6. **Scribe append-only merge invariants** (`write-to-gbrain.ts:19-41`): a sparse chat turn must never replace a richer existing page's compiled-truth, and frontmatter must be merged (writer replaces wholesale) or the import populator's `mention_count`/`category` is destroyed — losing `category:'inferred_interest'` reclassifies data. Timeline body is deterministic so (ts,source,body) dedup makes repeat turns no-ops.
7. **Scribe never touches the chat hot path**: `handleUserTurn` is fire-and-forget, watchdog-aborted, budget released in `finally` (`scribe/index.ts:236-241, 258-268`).
8. **Reminders tick**: single-flight (skip, don't stack — `tick.ts:12-15`); claim-then-dispatch with revert (`store.ts:234-293` — `markFired` revert and `advanceRecurrence` undo only-if-unchanged); recurring rows advance INSTEAD of markFired; one row's dispatch failure must not stop the tick; dispatcher degrades to `literalFallback` on ANY LLM failure so a reminder always delivers *something* (`dispatcher.ts:14-18`).
9. **Reminders outbound is persist-before-send** (`outbound.ts:7-18`): durable `button_prompts` row first, live push best-effort with swallowed throws; delivery must target the `app:` registry, not `web:` (timer-fired messages on the landing registry never deliver — PR#105).
10. **Task↔reminder link writes happen in the SAME transaction as the task mutation** (`reminder-link.ts:11-14`).
11. **Projection writer**: 500ms coalesce per (project_slug, project_id); tmp+rename atomic writes; the focus-score **cron deliberately does NOT trigger projection rewrites** (`projection/write.ts:17-19`); STATUS.md is a marked-block rewrite (preserves owner narrative), ACTIONS.md whole-file.
12. **Task list ordering contracts**: `'default'` ordering is bound by the Expo client; `'focus_score'` interleaves unranked-fresh rows into the last LLM ranking by focus score (`store.ts:69-89`) — a "simplification" of that SQL changes visible ordering.
13. **doc-search**: candidates are collapsed to best-chunk-per-file BEFORE the limit (one big file can't crowd out other docs, `store.ts:279-291`); malformed FTS MATCH returns `[]` not a throw (`:318-324`); refresh is mtime-diffed and throttled.
14. **GBrain embeddings key is resolved LAZILY at each `gbrain serve` spawn** (`gbrain-stdio-client.ts:50-60`, `build-gbrain-memory.ts:112-125`): a key pasted after boot must flip embeddings on at the next memory op; eager capture at composition would regress the onboarding promise.
15. **Empty/blank memory query routes to `list_pages`** not `search` (`gbrain-memory-store.ts:42-55`) — GBrain search returns nothing for `''`; the admin tab's recent-listing depends on the fallback.
16. **ensure-brain-init inits the vector column at OpenAI 3072 dims even with no key** (`ensure-brain-init.ts:20-33`) — the upgrade-in-place path; "simplifying" to `--no-embedding` bricks later key activation.
17. **Diary appends are single-`write(2)`-sized lines** (`diary-store.ts:20-23`) — the no-torn-lines guarantee depends on staying under PIPE_BUF.
18. **Boot sequence** `open → applyMigrations → composer` (`gateway/index.ts:181-182`), with the init-failure path closing the DB and shutting down the half-composed graph (`:236-255`).

## 9. What the refactor should do here

Ordered, each independently shippable, none behavior-changing:

1. **Truthify the dependency graph** (§6.2): declare real deps, break migrations→open, add the no-cross-workspace-relative-import lint. This is the prerequisite for every other extraction.
2. **De-invert reminders** (§6.1): move `outbound.ts` + the gateway substrate import up into gateway composition; reminders becomes a clean persistence+tick leaf.
3. **Close the `raw()` hole** (§6.3): typed read/sync-write surfaces on ProjectDb, migrate the 15 sites, restrict `raw()` to the runner; add a regression test for the write-during-open-transaction case. Write the persistence decision rule (instance DB / sidecar / file) in one place.
4. **Single-source the entity page format** (§6.4): export the writer's parse/render primitives, delete scribe's and the sync hook's mirrors, pin with a golden round-trip test.
5. **Fold the four app-chat stores** into one parameterized per-topic event log behind the existing interfaces (§6.7); extract the small shared store helpers (JSON codec, row mapper).
6. **Make memory degradation observable** (§6.5): persist sync-hook latch state + last-success, surface in the admin Memory tab; consider journaling deferred edges. Keep fail-soft semantics byte-identical.
7. **Schema/vocabulary sweep last** (§6.6, §6.8): rename `project_slug`→owner-scoped naming in one coordinated migration+store pass, guarded by the schema snapshot; document the numbering gaps; refresh migrations/AGENTS.md and the stale 0067 comment.

The snapshot test (`migrations/expected-schema.txt`) + the per-package unit suites make steps 1–5 low-risk; step 7 is the only one that touches persisted shapes and should ride the already-declared tenant-rename effort.

---

### Appendix: store census (main tree, non-test)

ProjectDb-consuming stores: auth/api-key-store, auth/secrets-store, channels/button-store, connect/{connected-members,guest-invite,remote-shared-projects,shared-project-mirror}-store, cores/runtime/installations-store, cron/state, gateway/{cores/oauth-pending-store, proactive/state-store, projects/sqlite-store, push/store, upload/upload-session-store}, onboarding/{interview/sqlite-state-store, overnight/queue-store, profile-pic/pending-call-store}, persistence/app-chat-*, project-credentials/store, reminders/store, skill-forge/proposals-store, tasks/store, trident/store, watchdog/alert-store, work-board/store.

Raw-`bun:sqlite` sidecars: doc-search/store, gateway/comments/comment-store, gateway/storage/binary-store, cores/runtime/data-namespace, cores/free/{calendar/src/cache, calendar/src/pre-meeting-brief-queue-store, email/src/cache, code-gen/src/sidecar/store, research/src/{claim-store,research-store,store-resolver}}, cores/free/calendar/migrations/runner (a second sidecar migration runner!).

File-state stores: reflection/{diary,corrections}-store (markdown), scribe/scribe-budget (JSON), gbrain-memory/gbrain-doctor state (JSON).
