# Subsystem map: onboarding-flows (`onboarding/` excluding `interview/`)

Audit date: 2026-07-02. Repo: /Users/ryan/repos/neutron-open @ main (d30280c).
All paths repo-relative unless noted. Line refs verified against working tree.

---

## 1. Purpose & responsibilities

Everything onboarding-adjacent that is NOT the interview state machine:

1. **History import** (`history-import/`) — parse a ChatGPT/Claude ZIP export (or, nominally, Gmail/Calendar OAuth), analyze it with LLM calls, and produce an `ImportResult` (proposed projects/tasks/entities/voice signals) the interview engine presents. TWO complete pipelines coexist (see § 6.2).
2. **Synthesis** (`synthesis/`) — the CURRENT live import architecture: deterministic no-LLM pre-pass over the whole export → ONE accumulating warm-`claude` session (never `/clear`) that builds a user model + per-project seeds → seed files written under `<owner_home>/Projects/<slug>/`.
3. **Wow-moment** (`wow-moment/`) — post-onboarding "first week" action dispatch (7 action modules, LLM-picked middle) + the **project materializer** (turn a confirmed project into a real git repo with the standard doc set) — which has quietly become the whole product's project-creation engine.
4. **Overnight** (`overnight/`) — autonomous overnight work: SQLite queue → each item dispatched as a Trident run → morning brief. Cron-driven (`overnight_handler`).
5. **Profile-pic** (`profile-pic/`) — Gemini portrait pipeline with a durable pending-call store + restart-resume boot hook.
6. **Persona-gen / archetypes** — SOUL.md/USER.md/priority-map generation, archetype library + blend, cringe-check.
7. **Telemetry** (`telemetry/`) — typed onboarding event emitter (`gateway_events` + stdout), bridge/composition helpers, Sean-Ellis week-4 cron.
8. **Feedback** (`feedback/`) — M2 week-4 qualitative collector (append-only markdown).
9. **API handlers** (`api/`) — thin start-onboarding / persona-edit handlers + the **invite-link JWT mint** (ed25519, jose) — consumed by Connect federation and the app project-invite route, i.e. not really onboarding.
10. **optional-keys.ts** — up-front optional credential offers (OpenAI key paste, Codex login guidance), persisting via the shared `ApiKeyStore` seam.

## 2. Module inventory (source lines, tests excluded)

| Module | Files | Notable sizes |
|---|---|---|
| history-import/ | 17 src + 21 test files | **job-runner.ts 2,104**, substrate-callers.ts 695, types.ts 541, pass2-synthesis.ts 501, entity-populator.ts 509, chatgpt-export.ts 276, chunker.ts 206, pass1-triage.ts 189, oauth-gmail 186, oauth-calendar 120, oauth-drive/notion/slack 13/9/9 (stubs) |
| synthesis/ | 7 | **synthesis-session.ts 980**, prepass.ts 247, seed-writer.ts 210, types.ts 163, raw-store.ts 117, informed-interview.ts 102 |
| wow-moment/ | 10 + 7 actions | **project-materializer.ts 853**, dispatcher.ts 693, llm-selector.ts 349, project-identity.ts 335, action-runner.ts 265, telemetry.ts 243; actions 90–484 each |
| overnight/ | 5 src (+4 co-located tests) | dispatcher.ts 471, status-md-sync.ts 380, register.ts 325, queue-store.ts 296, morning-brief.ts 205 |
| profile-pic/ | 9 | storage.ts 784, pipeline.ts 614, pending-call-store.ts 355, restart-resume.ts 177 |
| telemetry/ | 4 + SQL view | event-emitter.ts 686, composition.ts 620, sean-ellis-trigger.ts 516 |
| persona-gen/ | 6 | summarize.ts 407, compose.ts 386, soul.ts 211 |
| api/ | 3 | invite-link-generate.ts 325, persona-edit.ts 50, start-onboarding.ts 52 |
| archetypes/ | 3 | library.ts 326, compose.ts 199 |
| feedback/ | 1 | m2-week-4-collector.ts 321 |
| root | index.ts 397 (barrel), optional-keys.ts 324, AGENTS.md, package.json |

Total non-interview onboarding TS ≈ 39k lines incl. tests; test files outside interview/: 66 files, ~16.7k lines.

## 3. Public seams / contracts consumed by other subsystems

Verified by grep over gateway/, landing/, runtime/, channels/, cron/, connect/, open/:

- **`ImportJobRunnerHook`** — the engine⇄import contract (`start/status/cancel/synthesizeOnDemand`). Defined in `onboarding/interview/engine-internals.ts` (inside the excluded engine!), implemented twice: `history-import/job-runner.ts:393` (`ImportJobRunner`) and `gateway/realmode-composer/build-synthesis-import-runner.ts:115`.
- **`history-import/types.ts`** — the de-facto type hub (`ImportResult`, `ImportJob`, `ImportSource`, `ChunkerInput`, `VoiceSignals`…): 10 external import sites (gateway chat-bridge status enum at `gateway/http/chat-bridge.ts:643-644` mirrors `ImportJobStatus` literally).
- **`wow-moment/project-materializer.ts`** — 7 gateway composer files (`project-create.ts`, `build-wow-dispatcher.ts`, `build-project-kickoff.ts`, `build-project-doc-composer.ts`, `build-project-page-indexer.ts`, `build-onboarding-finalize.ts`). This is the product-wide "make a project real on disk" primitive.
- **`wow-moment/project-identity.ts:slugifyProjectId`** — 5 gateway consumers; contractually "MUST stay identical to `defaultProjectIdSlugifier` in `gateway/realmode-composer/build-onboarding-handoff.ts`" (project-identity.ts:41-44, drift-guard test exists).
- **`synthesis/index.ts`** — `buildSynthesisSession` / `buildSynthesisImportJobRunner` composers in gateway.
- **`overnight/register.ts:OVERNIGHT_HANDLER_NAME` + `registerOvernightCronHandler`** — wired in `gateway/composition/build-core-modules.ts`.
- **`telemetry/index.ts`** — `OnboardingTelemetry` + `composeOnboardingTelemetrySinks` (build-core-modules.ts, build-pass2-fallback-telemetry-hook.ts, build-llm-router.ts).
- **`api/invite-link-generate.ts`** — `issueInviteToken`/verify consumed by `connect/trusted-accept-handler.ts:54` (dormant federation) and `gateway/http/app-connect-invite.ts:39`, `app-project-invite.ts:38`.
- **`optional-keys.ts`** — `gateway/realmode-composer/resolve-onboarding-openai-key.ts`.
- **`persona-gen/compose.ts` + `cringe-check.ts`, `archetypes/library.ts`** — build-landing-stack / build-onboarding-finalize.
- Cron registrations: `registerSeanEllisCron` (telemetry) at build-core-modules.ts:551-558; interview's resume/import-running crons at :582-620.

**The curated barrel `onboarding/index.ts` is bypassed by every consumer** — 100% of external imports are deep paths (`../../onboarding/<module>/<file>.ts`); zero production imports of `onboarding/index.ts` found.

## 4. Workspace dependencies

**Declared** (`onboarding/package.json`): `@neutronai/channels`, `@neutronai/persistence`, `jose`.

**Actual** (relative-path imports out of non-interview onboarding, verified):
- `persistence/` (16), `runtime/` (13 — substrate.ts, events.ts, models.ts, model-pricing.ts, credential-pool.ts, entity-writer.ts, entity-slug.ts), `cron/` (7 — handlers/jobs/state), `channels/` (4 — button-primitive), **`trident/`** (overnight/register.ts → trident/store.ts, trident/git-mode.ts), **`reminders/store.ts`** + **`tasks/store.ts`** (wow-moment action-types/dispatcher), `migrations/` (overnight co-located tests).

So the true dependency surface is ~4× the declared one; `runtime`, `cron`, `trident`, `reminders`, `tasks` are all undeclared. Raw-TS relative imports make package.json advisory-only across the repo, but overnight→trident is a genuine layering surprise: an "onboarding" package depends on the autonomous-build subsystem.

**Inbound**: gateway (composition + realmode-composer + http/upload), landing (via interview), connect, open/composer (via gateway).

## 5. Internal layering (as-built)

```
types hubs:        history-import/types.ts  ← everything (incl. synthesis, wow, gateway)
                   synthesis/types.ts       ← synthesis/*
pipelines:         parsers (chatgpt/claude/zip/oauth) → chunker → pass1/pass2 (+ substrate-callers)   [legacy]
                   parsers → prepass → synthesis-session → seed-writer                                 [live]
post-onboarding:   wow-moment catalogue/selector/dispatcher/runner → actions → project-materializer
                   overnight queue-store → dispatcher → trident seam → morning-brief → register
side pillars:      profile-pic (pipeline + pending-store + restart-resume), persona-gen, archetypes,
                   telemetry (emitter → bridges → sinks), feedback, api, optional-keys
```

Cross-links that break the tidy picture: `synthesis-session.ts:30` imports `extractJsonObject` from the *superseded* `history-import/substrate-callers.ts`; `synthesis-session.ts:34` imports `interview/llm-timeouts.ts`; wow dispatcher/llm-selector import `interview/phase-spec-resolver.ts` (`LlmCallFn`) (dispatcher.ts:49, llm-selector.ts:29); profile-pic/storage.ts imports hook types from `interview/engine.ts`; wow action 01 imports `../../overnight/queue-store.ts`.

## 6. Architectural debt (evidence + severity)

### 6.1 [P0] Live import jobs are not restart-durable — in-memory results + fire-and-forget run
The live Open path (`open/composer.ts:1288` sets `importUseSynthesis: true`; only production `buildLandingStack` caller is `open/composer.ts:1237`) runs imports through `gateway/realmode-composer/build-synthesis-import-runner.ts`:
- `results = new Map<string, ImportResult>()` and `cancelled = new Set<string>()` are **in-process only** (lines 131-132, with an explicit comment acknowledging it).
- `start()` fires `void runJob(...)` (line 267); on gateway restart mid-import the `import_jobs` row is stranded at `pass1-running` **with no process that will ever advance it** — `status()` (line 278) just reads the row. The user-facing wedge is only broken by the interview engine's hard-timeout machinery, and the salvage path `synthesizeOnDemand` (line 327-333) returns `results.get(job_id) ?? null` → **null after restart**, so nothing is recovered.
- Even a job that COMPLETED before the restart loses its `ImportResult` (`status()` line 305-308 finds no map entry), while the DB row says `completed` — the engine sees a completed job with no result.
Contrast: profile-pic solved this exact class of problem properly — durable `profile_pic_pending` table (pending-call-store.ts:15-30) + boot-time `restart-resume.ts` with expire/auto-retry heuristics. The legacy `ImportJobRunner` is *partially* durable (Pass-1 chunk cache + `rate_limit_paused` resume cron) but its in-flight run promise (`this.inflight`, job-runner.ts:423) is equally lost on restart, stranding `pass1-running` rows.
**Refactor sketch**: persist the synthesis result (the `import_results` table already exists and the legacy runner's `persistResult` shows the shape, job-runner.ts:1959-2018) and add a boot-time sweep that flips orphaned `queued/pass1-running/pass2-running` rows to a resumable/failed state — mirroring profile-pic's restart-resume pattern.

### 6.2 [P1] Two complete import pipelines; the 2,104-line one is dead on every production path in this repo
`job-runner.ts:4-16` says the per-chunk runner is "RETAINED only for (a) the MANAGED hosted import path … and (b) tests". But this repo has **no provisioning/Managed layer** (dir absent; barrel comment index.ts:198-204 says it moved out), and the only production composer always opts into synthesis. So `job-runner.ts` (2,104) + `substrate-callers.ts` (695) + `pass1-triage.ts` (189) + `pass2-synthesis.ts` (501) + `gateway/realmode-composer/build-import-job-runner.ts` (710) + most of the 21 history-import test files (429-retry schedules, credential-kind chunking, parallel worker pool, cooldown phases, Sonnet fallback…) maintain an unreachable pipeline — ~4k src lines + ~10k test lines of drag. Worse, the dead pipeline still **owns the live vocabulary**: `ImportJobStatus` (`pass1-running`, `rate_limit_cooling_off`, …) and the progress columns (`pass1_chunks_done/total`) that the synthesis runner (build-synthesis-import-runner.ts:156-170) and the engine/chat-bridge reuse with reinterpreted meanings (read passes masquerading as "chunks"). Entanglements to untangle before deletion: `synthesis-session.ts:30` (extractJsonObject), `synthesis/types.ts` re-exporting `VoiceSignals` from history-import/types.ts, the shared parsers (chatgpt/claude/zip + default-source-parser) which ARE live, and `entity-populator.ts` (only invoked from the dead runner — the synthesis path writes entities via a different gateway hook).

### 6.3 [P1] `wow-moment/` is the product's project-creation subsystem wearing an onboarding costume
`project-materializer.ts` (853 lines: fs layout + git init/commit + transcript slicing from `import_pass1_chunks.chunk_text` + LLM summary + memory indexing) is imported by 7 gateway composers including plain `project-create.ts` — i.e., every user-created project forever, not a one-time wow. `project-identity.ts:slugifyProjectId` is the canonical slugifier for the sidebar, app-ws topics and seed prompts, held in sync with a gateway re-export by a drift-guard test (project-identity.ts:41-44). Meanwhile `synthesis/seed-writer.ts` is a SECOND project-on-disk writer (STATUS.md + docs/history + transcripts), reconciled with the materializer only by a slug-alignment line in the gateway bridge (`build-synthesis-import-runner.ts:230`) plus mutual create-if-missing discipline. Two writers + one alignment convention = a fragile three-way contract. **Refactor**: extract a `projects-fs` (materializer + seed-writer + slugifier + folder-convention constants) module owned by the projects domain; wow-moment keeps only dispatch.

### 6.4 [P1] Package boundary is fiction: barrel bypassed, deps undeclared, non-onboarding tenants inside
(a) Every consumer deep-imports; the 397-line curated barrel serves no one (§ 3). (b) package.json declares 2 workspace deps; code imports 7 more packages (§ 4). (c) The package hosts permanent product subsystems: overnight autonomous work (depends on trident), invite JWTs (consumed by connect federation + app routes), Sean-Ellis cron, generic telemetry. A refactor that moves `overnight/`, `api/invite-link-generate.ts`, and the materializer out shrinks "onboarding" to what it says.

### 6.5 [P2] Engine coupling runs backwards: the hook contract lives in the 10k-line engine
`ImportJobRunnerHook` and the profile-pic hook types live in `interview/engine.ts` / `engine-internals.ts`; gateway composers import `engine-internals.ts` directly (build-onboarding-finalize.ts, build-synthesis-import-runner.ts:56-58). Non-interview modules import interview internals for incidental types (`LlmCallFn` from phase-spec-resolver — dispatcher.ts:49; `llm-timeouts.ts` — synthesis-session.ts:34). Splitting the engine later requires these contracts to move to a neutral module first.

### 6.6 [P2] Status/progress semantics overloaded on the live path
The synthesis runner reuses the per-chunk status enum + columns with different meanings: read passes → `pass1_chunks_done`, `pass1-running` = "synthesis running" (build-synthesis-import-runner.ts:156-174); `error_message` doubles as a cooling-off UX channel in the legacy runner (persistCoolingOffMessage, job-runner.ts:1446-1468) and as a real error field elsewhere. Deliberate compat (documented at build-synthesis-import-runner.ts:29-33) but any refactor of the import UI or the status enum must treat these as one interlocked contract with `gateway/http/chat-bridge.ts:643` and the engine's poll machinery.

### 6.7 [P2/P3] Smaller items
- **Dead OAuth import sources**: gmail/calendar fetchers (186/120 lines + tests) have no production wiring — the live path injects throwing clients ("zip-only path", build-synthesis-import-runner.ts:402-428); drive/notion/slack are 9-13-line `oauth_scope_missing` stubs. P2 dead code (or honest future work — but currently only reachable from the dead runner).
- **`entity-populator.ts` (509 lines)** — only invoked by the dead per-chunk runner (`runEntityPopulator`, job-runner.ts:1913); verify no synthesis-path caller before deleting (none found).
- **Duplicated 429 detectors**: `is429RetryableError` (job-runner.ts:2072-2083) vs `is429ErrorMessage` (substrate-callers.ts:402-406) — documented as deliberate to avoid a dependency, still drift-prone. P3.
- **Env read at module load**: `DEFAULT_M2_FEEDBACK_PATH` (m2-week-4-collector.ts:41-45), `MAX_SYNTHESIS_PROJECTS` (synthesis-session.ts:63-70), prepass batch constants (prepass.ts:42-59) freeze env at import time — import order sensitivity. P3.
- **"tenant" vocab**: `internal_handle` on `OptionalKeyApiKeyStore` (optional-keys.ts:53-57, 237) and throughout telemetry rows — part of the repo-wide rename debt. P3.
- **`start-onboarding.ts` / `persona-edit.ts`** are 50-line pass-throughs whose "POST route" framing predates the current wiring; genuinely thin, fine, but their doc comments reference Managed signup routers that no longer live here. P3.

## 7. Test posture

- **Volume**: 66 test files / ~16.7k lines outside interview/. history-import alone has 21 files — but the heaviest suites (job-runner-pass1-parallel 778, pass2-retry-on-429 512, synthesize-on-demand-pass2 489, substrate-callers 482, credential-kind-chunking 369) exercise the **superseded** pipeline. The live synthesis path has a strong 914-line `synthesis-session.test.ts` (asserts factory-once + no-`/clear`) plus prepass/seed-writer/raw-store tests; the *gateway bridge* (build-synthesis-import-runner) — where the P0 lives — is tested on the gateway side, not here.
- **Determinism discipline is good**: injected `now`/`sleep`/`uuid` everywhere; ordering-sensitive tests pin `pass1Concurrency: 1` (job-runner.ts:135-138).
- **Real-timer residue**: `awaitClaimedFinalize` polls with a raw `setTimeout` 200ms (job-runner.ts:1890-1903) — not overridable via the injected sleep; steal-race tests pay real wall-clock (30×200ms worst case).
- **Overnight tests boot real migrations** (dispatcher.test.ts:5 imports migrations/runner) — closer to integration, good coverage of window math/reconcile/budget.
- **Untested-ish**: `overnight/register.ts` production seams (fs walkers, trident seam wiring), morning-brief delivery routing beyond pure compose fns, telemetry composition bridges are asserted mostly via the m2 fixture; profile-pic has thorough suites incl. a dedicated completed-after-wait race test.
- **Flake risk**: low in-package; the known PGLite/parallel-chunk flake lives elsewhere.

## 8. Load-bearing subtleties a NO-BEHAVIOR-CHANGE refactor must preserve

1. **Pass-1 cache keyed by `(project_slug, source, chunk_hash)` — never `job_id`.** Resume cycles mint fresh job_ids; salvage must scan the dedup key (job-runner.ts:594-617, ISSUES #91). Re-keying by job would silently discard cached signal.
2. **Deterministic aggregation ordering**: results sorted by `chunk_hash` before `aggregatePass1` because aggregation has order-dependent ties in 5 places (job-runner.ts:1139-1157, also 627-633).
3. **`retryWith429` schedule contract**: first entry MUST be 0 (immediate first attempt); one shared schedule for Pass-1+Pass-2; exhaustion → `rate_limit_paused` (resumable at $0), not `failed` (job-runner.ts:162-176, 1336-1437).
4. **Conditional status flips**: every status write is guarded `NOT IN ('cancelled','completed','failed','rate_limit_paused')` (setStatusIfNotCancelled job-runner.ts:1604-1619; persistCoolingOff/WaitingOnCooldown) — the cancel-race protection.
5. **Cooling-off message lifecycle**: `error_code='rate_limit_cooling_off'` is a UX overlay that MUST be cleared on success and BEFORE handing a non-429 to the caller (clearCoolingOffMessage guard, job-runner.ts:1414-1427, 1511-1519); `cooldown_resume_at` cleared on pause (1546-1560).
6. **`synthesizeOnDemand` deliberately does ONE un-retried Pass-2** (money-burn + the caller already cancelled the job so `retryWith429` would short-circuit to `cancelled` and salvage nothing) and never mutates job lifecycle (job-runner.ts:645-716); `preferDegraded` avoids paying for a second in-flight Pass-2.
7. **Sleep slicing**: backoff sleeps are 500ms-sliced with cancel + `shouldAbort` polls so cancels/pauses land in O(500ms) (job-runner.ts:1581-1597); sibling workers observe a shared `paused` flag mid-retry (Codex r3 note, 983-1004).
8. **Chunk target frozen at job start**; oauth/`ambient` credential kinds → 4096 tokens; mid-job rotation must NOT re-chunk (would invalidate chunk_hash dedup) (job-runner.ts:199-202, 1695-1699).
9. **Analyze-all**: production forces `enable_skip_llm=false` (Ryan-directed) — the skip floor survives only as an explicit test opt-in (job-runner.ts:1700-1719).
10. **Synthesis session invariants**: substrate factory constructed EXACTLY once; NEVER emits `/clear` (`FORBIDDEN_CONTEXT_RESET`, synthesis-session.ts:52; test-asserted); substrate must be non-ephemeral without `reset_context_per_turn`; idle-heartbeat is the primary wedge detector with the absolute ceiling as backstop (synthesis-session.ts:97-113).
11. **Honest-failure gate**: `attempted>0 && succeeded==0 && projects==0` → job `failed` (never a blank "completed" wow) (build-synthesis-import-runner.ts:203-220).
12. **Seed/materializer slug alignment**: seeds are written under `slugifyProjectId(seed.name)` so the later materializer's create-if-missing defers to them (build-synthesis-import-runner.ts:229-238); `slugifyProjectId` must stay byte-identical to gateway's `defaultProjectIdSlugifier` (project-identity.ts:41-44).
13. **Create-if-missing everywhere**: seed-writer, materializer, result docs never clobber user-edited files; existing STATUS.md == "already materialized" no-op (seed-writer.ts:57-80; project-materializer.ts:30-39).
14. **Wow dispatch ordering**: 07-overnight-pass ALWAYS first (cron lands even if the rest fails), 01-first-week-brief ALWAYS last; picker timeout is 20s because the picker is a cold CC-spawn (~4.6s to first token) (dispatcher.ts:1-27, 56-70). Action runner NEVER throws and converts hangs to `{fired:false, reason:'timeout'}` at 60s (action-runner.ts:44-67).
15. **Overnight**: STATUS.md block is a RENDERING of queue rows, never the source of truth (queue-store.ts:5-10); context gate double-enforced at dispatch (dispatcher.ts:346-357); advance tick runs OUTSIDE the window by design; `window_date_local` stamps at dispatch drive the morning brief's selection; the brief NEVER invents results and reports quiet nights as one line (morning-brief.ts:4-16); window spans midnight (currentWindowDate shifts −1 before 07:00, dispatcher.ts:121-126).
16. **Profile-pic restart semantics**: <60s-old pending rows kept; older → one invisible auto-retry then failed; hard 5-min ceiling (restart-resume.ts:14-63).
17. **`drainSubstrateEvents` must NOT break on the completion event** — the iterator must finish so the adapter's finally/teardown runs (substrate-callers.ts:486-494); errors carry `retry_after_ms` cooldown hints that MUST survive rethrows (495-510, extractCooldownResumeAt job-runner.ts:2036-2046).
18. **Model attribution vs dispatch**: legacy completed rows get stamped with the STABLE `BEST_MODEL` seed, never live `getBestModel()` (job-runner.ts:548-556); conversely dispatch pricing resolves per-call for the dynamic default and degrades to $0 telemetry on unpriced watchdog-adopted models, while explicit picks loud-fail at build (substrate-callers.ts:248-262, 573-597).
19. **`extractJsonObject`'s three-stage fallback** (direct parse → fenced → balanced-brace substring) is shared by BOTH pipelines (synthesis imports it) — behavior changes ripple into the live path (substrate-callers.ts:627-660).
20. **optional-keys idempotent re-paste**: duplicate ApiKeyStore label → `outcome:'stored'`, never an error (optional-keys.ts:301-318).
21. **Sean-Ellis / telemetry drift-guards**: every `OnboardingEventName` must appear in `ALL_ONBOARDING_EVENT_NAMES`; the roundtrip test enforces it (event-emitter.ts:20-24).

## 9. What the refactor should do here

1. **Fix restart durability first (P0)**: persist synthesis `ImportResult` to `import_results` (schema already exists) and add a boot sweep for orphaned running `import_jobs` rows, modeled on profile-pic's pending-store/restart-resume pair. This is behavior-preserving for the happy path and closes the declared wedge.
2. **Retire the per-chunk pipeline deliberately**: extract the genuinely shared pieces out of history-import first — types.ts (→ a neutral import-types module), parsers/zip-reader/default-source-parser (live), `extractJsonObject` (→ shared util) — then delete job-runner.ts, pass1/pass2, substrate-callers, entity-populator, gateway/build-import-job-runner and their test suites, or, if Managed reuse is real, move them to the Managed repo that actually uses them. Keep the `ImportJobRunnerHook` contract stable during the move.
3. **Extract a `projects-fs` module** (materializer + seed-writer + slugifier + folder-convention constants) owned by the projects domain; make gateway's `defaultProjectIdSlugifier` an import, not a synced copy.
4. **Move the mis-homed tenants**: `overnight/` → its own package (it is trident-coupled autonomous work, not onboarding); `api/invite-link-generate.ts` → wherever invites/connect land; consider whether `telemetry/` event-emitter is really onboarding-specific.
5. **Neutral-home the hook contracts** (`ImportJobRunnerHook`, profile-pic hooks, `LlmCallFn`, llm-timeouts) so non-interview modules and gateway stop importing engine internals — prerequisite for the engine.ts split.
6. **Make the seam real**: either enforce barrel-only imports (lint rule) and declare the true workspace deps, or drop the barrel; today's half-measure is documentation that lies.
