# Subsystem map: onboarding-interview (`onboarding/interview/`)

Audit date: 2026-07-02. All paths relative to `/Users/ryan/repos/neutron-open` unless absolute.

## 1. Purpose & responsibilities

The interview subsystem is the onboarding state machine for a fresh Neutron install: it walks the owner from `signup` through history-import, personality/name capture, project proposal, persona synthesis, credential setup (`max_oauth_offered`), the "wow moment," and final handoff to steady-state chat. It owns:

- the phase enum + legal-transition table (`phase.ts`)
- the turn driver (`engine.ts:InterviewEngine` — emit prompt, consume tap/freeform, walk transition)
- durable per-owner state (`state-store.ts` / `sqlite-state-store.ts`, `onboarding_state` table, `phase_state` JSON column)
- two LLM subsystems: a freeform-intent **router** (`llm-router.ts`, advance/answer/amend) and a phase-prompt **copy generator** (`phase-spec-resolver.ts`)
- the newer "Path 1" live-session onboarding pieces (`onboarding-preamble.ts`, `post-turn-extractor.ts`, `button-backed-answer.ts`) where the live Claude Code chat session conducts the interview and the phase machine is bypassed for conversation
- cron sweeps (`resume-cron.ts`, `import-running-cron.ts`) and the append-only transcript (`transcript.ts`)

## 2. Module inventory (wc -l)

| file | lines | role |
|---|---|---|
| engine.ts | 10,078 | god-class `InterviewEngine` (~102 methods, 48 private) + module helpers |
| engine-internals.ts | 2,329 | deps/hook interfaces, timeout constants, `EngineInternals` friend-interface (line 2027) |
| phase-prompts.ts | 2,267 | `PhasePromptSpec` type, `STATIC_PHASE_SPECS` fallback table (line 122), dynamic per-phase spec builders |
| engine-import-routing.ts | 2,234 | 18 import-flow methods extracted as free functions taking `self: EngineInternals` |
| phase-spec-resolver.ts | 2,099 | LLM prompt-copy generator: `PHASE_INTENTS`, `PHASE_KNOWLEDGE`, `buildLlmPhaseSpecResolver` |
| llm-router.test.ts | 1,766 | colocated router tests |
| llm-router.ts | 1,428 | freeform-intent router (advance/answer/amend, Haiku→Sonnet fallback) |
| engine-persona.ts | 1,155 | 8 persona methods extracted as free functions |
| engine-slug.ts | 1,086 | 11 slug/suggestion methods extracted as free functions |
| post-turn-extractor.ts | 652 | Path-1 fire-and-forget field scribe |
| interaction-mode.ts | 621 | buttons-only/mixed/freeform pre-router classifier |
| personality-character-suggester.ts | 602 | background Opus suggester (memoized) |
| agent-name-suggester.ts | 579 | background Opus suggester (memoized) |
| resume-cron.ts | 389 | 24h resume-on-reconnect sweep |
| onboarding-preamble.ts | 350 | Path-1 first-turn system-prompt fragment + step guard |
| final-handoff-prompts.ts | 328 | post-completion handoff prompt builders |
| fixture-anthropic-client.ts | 312 | deterministic LLM fixture for tests |
| sqlite-state-store.ts | 303 | SQLite `onboarding_state` store (composite PK, shallow-merge JSON patch) |
| state-store.ts | 298 | store interface + in-memory impl |
| import-running-cron.ts | 296 | 15s import-completion poll |
| others (extract-agent-name, llm-timeouts, phase, required-fields-audit, extracted-fields, button-backed-answer, final-handoff-config, transcript) | ~1,350 | leaf helpers |

Total ~30.5k source lines + 27.4k lines in `__tests__/` (83 test files).

## 3. Public seams / contracts consumed elsewhere

- **`InterviewEngine`** (engine.ts:540) — constructed once in `gateway/realmode-composer/build-landing-stack.ts:1200`; driven by `gateway/http/chat-bridge.ts` (`engine.start` :1334, `engine.advance` :1942/:1996 for freeform + button_choice), `gateway/upload/import-upload-handler.ts` (`notifyImportUpload`), the two crons, and `gateway/http/app-ws-surface.ts`. 25 files import `@neutronai/onboarding/interview/engine.ts`.
- **`OnboardingStateStore` / `OnboardingState`** (state-store.ts) — read/written directly by `open/composer.ts` (Path-1 seam), gateway upload handlers, nudge engine, `cores/free/agent-settings/src/backend.ts`. `phase_state` (untyped `Record<string, unknown>`) is a de-facto cross-subsystem contract.
- **`phase.ts`** — `OnboardingPhase`, `LEGAL_TRANSITIONS`, `OPEN_MODE_EXTRA_TRANSITIONS`, `isLegalTransition`; consumed by gateway composer, `runtime/onboarding-conversational-flag.ts`, app-ws envelope.
- **`PhasePromptSpec`** (phase-prompts.ts) — the on-wire prompt shape channels/app clients render; `channels/adapters/app-ws/envelope.ts` imports it.
- **`LlmRouter` / `RouterDecision`** (llm-router.ts:349) — built by `gateway/realmode-composer/build-llm-router.ts`.
- **`PhaseSpecResolver`** (phase-spec-resolver.ts:1310) — built by `build-phase-spec-resolver.ts`; also exports the flag plumbing (`resolveEnabledPhases`).
- **Path-1 trio** — `buildPostTurnExtractor`, `captureButtonBackedRequiredField`, preamble builders: consumed only by `open/composer.ts` (:60, :62, :68).
- **Hook DI surface** (engine-internals.ts:836 `InterviewEngineDeps`) — ~20 optional hooks (slugPicker, profilePic, personaComposer, wowDispatcher, importJobRunner, maxOauth, secrets, onboardingHandoff, mintTelegramBindToken, …) implemented by gateway `realmode-composer/build-*.ts` modules. This is the real integration seam and it is wide but explicit.
- **`__tests__/interview-testkit.ts`** — imported by 13 files outside the package (integration tests); a test fixture acting as a cross-workspace contract.

## 4. Workspace dependencies

**Declared** (onboarding/package.json): `@neutronai/channels`, `@neutronai/persistence`, `jose`.

**Actual imports out of `onboarding/interview/`** (relative paths, bypassing declaration):
- `../../channels/button-primitive.ts`, `button-store.ts` (declared) — 9 imports
- `../../persistence/index.ts` (declared) — 3
- `../../runtime/{models,platform-adapter,slug-picker-types,slug-grammar,env-flag-tokens}.ts` — 11 imports, **undeclared** (`@neutronai/runtime`)
- `../../cron/{jobs,handlers}.ts` — 4 imports, **undeclared**
- intra-package: `../persona-gen/`, `../archetypes/`, `../history-import/`, `../wow-moment/`, `../optional-keys.ts`

**Inbound**: gateway (composer, chat-bridge, upload handlers, nudge-engine, oauth sweep), open/composer.ts, landing/server.ts, runtime (flag parser, doc-links), channels app-ws envelope, cores/free/agent-settings, app/lib/doc-links.ts, tasks/prioritize-llm.ts, 32 integration-test files.

## 5. Internal layering (as-built)

```
phase.ts, llm-timeouts.ts, extracted-fields.ts, transcript.ts, state-store.ts   (leaves)
      ↑
phase-prompts.ts, interaction-mode.ts, required-fields-audit.ts, final-handoff-*
      ↑
llm-router.ts        phase-spec-resolver.ts        suggesters (character/agent-name)
      ↑
engine-internals.ts (deps + constants + EngineInternals friend interface)
      ↑
engine-import-routing.ts / engine-persona.ts / engine-slug.ts  (free functions over `self`)
      ↑
engine.ts (class + delegators + everything not yet extracted)
      ‖  (parallel architecture, same state store)
onboarding-preamble.ts + post-turn-extractor.ts + button-backed-answer.ts  (Path 1)
```

### The actual state machine
`phase.ts` is a clean 18-phase table with managed/open dual mode: `LEGAL_TRANSITIONS` (line 73) plus `OPEN_MODE_EXTRA_TRANSITIONS` (line 129) that cut `identity_oauth`/`instance_provisioned`/`slug_chosen` in open mode. `engine.nextPhaseForMode` (engine.ts:593) rewrites the two managed edges. But the *real* state machine is bigger than the enum: nearly every phase has stringly-typed sub-steps in `phase_state` (e.g. `ImportRunningSubStep`, `PersonaReviewSubStep`, `import_pending_source`, `clarify_name_reprompt`, `pending_regen_hint`), driven by `deriveActiveSubStep` (interaction-mode.ts) and ad-hoc reads via `readString`/`readNumber` helpers.

### Responsibility clusters inside engine.ts (line-span map)
| span | cluster | ~lines |
|---|---|---|
| 1–539 | imports, re-export shim for moved API (245–299), router amend whitelist, module constants | 539 |
| 540–687 | class head, ctor, `nextPhaseForMode`, `recordInboundReceived` | 148 |
| 688–1460 | `start()` — lazy slug rekey, wow/import crash-resume, reconnect re-emit gate, first-emit | 772 |
| 1461–1720 | `reuseActivePrompt` / `recoverResolvedAnswer` idempotency recovery | 260 |
| 1721–1988 | `acceptChoice` — S1 skeleton path (**no production caller**) | 268 |
| 1989–2325 | `advance`, `emitCurrentPhasePrompt`, `tick`, `pollImportRunningTick` (cron seams) | 337 |
| 2326–2679 | `notifyImportUpload(+Locked)` + upload serialization + `walkAutoSkip` | 354 |
| 2680–3086 | `normalAdvance` — the per-turn driver | 407 |
| 3087–3305 | router gating: `shouldConsultRouter`, `whitelistRouterStateDelta`, signup router advance | 219 |
| 3306–3792 | `dispatchRouterDecision` | 487 |
| 3793–4084 | nudges, `reEmitCurrentPhasePromptFresh`, `sendAgentText`, `reEmitKeyboard` | 292 |
| 4085–4971 | `consumeChoice` — central per-phase if/else dispatcher | 887 |
| 4972–5599 | **wow cluster** (dispatch, signals, fallback prompt/choice) — unextracted | 628 |
| 5600–6093 | **final-handoff cluster** — unextracted | 494 |
| 6094–6650 | personality/name delegators + **projects_proposed cluster** — unextracted | 557 |
| 6651–6946, 7292–7361 | import one-line delegators (bodies live in engine-import-routing.ts) | ~370 |
| 6947–7291 | **gap-fill cluster** (consume, merge fields, router best-effort extraction) — unextracted | 345 |
| 7362–7788 | `emitPhasePrompt` + **resume cluster** (emit/reemit/handleResumeChoice) — unextracted | 427 |
| 7789–8564 | **LLM spec resolution** (`resolvePhasePromptSpecUncached` alone is 615 lines: 7808–8423) + cache | 776 |
| 8565–8851 | suggestion memoization helpers + slug delegators | 287 |
| 8852–9444 | **max-oauth / credentials cluster** (OAuth handoff, BYO key, setup token) — unextracted | 593 |
| 9445–9590 | persona delegators | 146 |
| 9591–10078 | module-level free helpers (funnel logging, list parsing, coercions) | 488 |

## 6. Architectural debt

### D1 (P0) — Two parallel onboarding architectures are simultaneously live
"Path 1" (2026-06-27, per headers in `post-turn-extractor.ts:1-20`, `onboarding-preamble.ts:1-15`) moved conversational onboarding onto the live CC session: `open/composer.ts:2954` — "onboarding conversational turns no longer go through `engine.advance` … The engine is retained ONLY for the import subsystem"; :3099 "Path 1: ONE path. Every typed turn — onboarding OR steady-state — runs [on the live session]"; :3362 same for button taps. Yet the legacy phase-machine path is still fully wired and reachable: `gateway/http/chat-bridge.ts:1942/:1996` drive `engine.advance` for `web:` topics, `chat-bridge.ts:1334` drives `engine.start`, and `open/composer.ts` serves `chat.html` for returning visits (:1435–1685). So which architecture an owner gets depends on which client surface delivers the turn (`app:` registry → Path 1; `web:` WS → phase machine). The 10k-line engine's conversational core (router dispatch, per-phase consume cascade, spec resolver rephrasing, resume prompts) is legacy on the primary Open path but load-bearing on the web path and for the whole import pipeline (`notifyImportUpload`, import cron, crash-resume). Any refactor must first decide this fork's fate; until then every onboarding bug has two possible engines to blame. Evidence: open/composer.ts:2954-2971, :3222 (Path-1 auto-start), chat-bridge.ts:1900-2000, post-turn-extractor.ts header.

### D2 (P0) — engine.ts god-file with a half-finished "friend interface" decomposition
10,078 lines, ~102 methods. A prior pass (R5 / audit P2-4, per engine-import-routing.ts:1-12) extracted 37 methods (18 import, 8 persona, 11 slug) as free functions taking `self: EngineInternals` — an explicit "PURE MOVE … `this.` rewritten to `self.`". Consequences:
- `EngineInternals` (engine-internals.ts:2027-2329) is a ~300-line structural interface re-declaring 40+ method signatures so extracted functions can cross-call each other through `self`. Every signature change now needs three coordinated edits (free function, one-line delegator in engine.ts, interface member) with no compiler assistance that the delegator forwards correctly.
- Class privacy was abandoned: "visibility relaxed from `private` to public" (engine.ts:541-546); extracted modules have full access to everything, so no real boundary was created — the god-class became a god-object-with-satellites.
- Seven large clusters were never extracted (see span map): wow (628), final-handoff (494), projects_proposed (~430), gap-fill (345), resume (~300), spec resolution (776, incl. one 615-line method), max-oauth/credentials (593), plus `start()` at 772 lines and `consumeChoice` at 887.
Severity P0 for maintainability: the file is the repo's largest, its churn is real (7 commits since April incl. 3 P0-class fixes), and the extraction pattern chosen makes further change *harder*, not easier.

### D3 (P1) — `phase_state` is an unschema'd JSON grab-bag shared across subsystems
Dozens of keys (`active_prompt_id`, `import_job_id`, `wow_report`, `wow_dispatch_error`, `uploads_received`, `clarify_name_reprompt`, `personality_character_suggestions`, `resume_active_prompt_id`, `last_inbound_received_at`, `import_failed`, `ai_substrate_used`, `user_supplied_corrections`, …) are read via `readString`/`readNumber`/`readStringArray` (engine-internals.ts) at hundreds of sites, and written via shallow-merge patches (sqlite-state-store.ts:10-14). External modules read it raw (`open/composer.ts:2975` `st?.phase_state?.['import_failed']`). LLM output can write into it, guarded only by the hand-maintained `ROUTER_AMEND_ALLOWED_KEYS` whitelist (engine.ts:372-392) — the doc comment itself notes the TS type on `state_delta` "is compile-time only." No single file enumerates the keys; the wow-signals builder (engine.ts:5269) and crash-resume watermarks depend on exact key presence/absence semantics.

### D4 (P1) — Dead / legacy surfaces inside the engine
- `acceptChoice` (engine.ts:1721-1988) — the documented "S1 skeleton" path; zero production callers (chat-bridge uses `advance` for button_choice; direct grep for `.acceptChoice(` outside tests finds nothing). ~270 lines of dead public API plus its `AcceptChoiceInput/Result` types kept alive by tests only.
- Managed-only machinery in an Open-only repo: `deploymentMode` defaults to `'managed'` (engine.ts:573), the slug-picker/`slug_chosen` flow, `identity_oauth`/`instance_provisioned` phases, `mintFinalHandoffTelegramBindToken`, and the whole slug suggestion pipeline (engine-slug.ts, 1,086 lines) are never entered in open mode (`nextPhaseForMode` cuts them, phase.ts:117-134). They remain compiled-in, tested, and imported. This is the same "Connect/managed entanglement" debt already declared repo-wide, localized here.
- Stale v1 phase names live on in comments (e.g. engine.ts:6672 "advances to archetype_picked" — a phase deleted in the v2 rename, phase.ts:12-19), and deploy-window recovery branches for the removed 'both'-source flow (engine.ts:4167-4180) that are now unreachable except for rows written before 2026-06-06.

### D5 (P2) — Undeclared workspace dependencies
`onboarding/package.json` declares only `@neutronai/channels`, `@neutronai/persistence`, `jose`, but interview modules import `@neutronai/runtime` files 11× (`runtime/models.ts` from llm-router.ts:77, phase-spec-resolver.ts:48, both suggesters; `runtime/platform-adapter.ts` from engine.ts:103; `runtime/slug-picker-types.ts` engine.ts:100; `runtime/env-flag-tokens.ts`) and `cron/jobs.ts`+`cron/handlers.ts` from both cron modules — all via `../../` relative paths that bypass the workspace boundary. Works under Bun raw-TS, but the package graph lies, and a future package split would break silently.

### D6 (P2) — Duplicated LLM-call scaffolding across three subsystems
`llm-router.ts` and `phase-spec-resolver.ts` each export their own `buildSystemPrompt`/`buildUserPrompt` (llm-router.ts:744/:815 vs phase-spec-resolver.ts:1628/:1656), their own JSON-parse-and-validate (`parseRouterDecision` :950 vs `parseLlmSpec` :1751), their own timeout wrappers (`withTimeout`/`TimeoutError` live in phase-spec-resolver.ts:1970-1996 but are consumed by others), and the two suggesters repeat the memoize-in-phase_state + pending-promise-map + fingerprint pattern (`engine.ts:8565-8727`, duplicated for characters vs names). `post-turn-extractor.ts` is a third, independent extraction pipeline over the same `ExtractedFields`/required-fields vocabulary. Same-name exports across sibling modules also make grep/IDE navigation error-prone.

### D7 (P2) — `consumeChoice` and `dispatchRouterDecision` are hand-rolled phase dispatchers
`consumeChoice` (engine.ts:4085-4971) is an ~890-line if/else chain over `state.phase` with embedded incident-fix branches (e.g. the stale-'both' skip recovery at :4167). `dispatchRouterDecision` (:3306-3792) repeats a parallel per-phase routing for router `advance` decisions. Adding a phase means editing both, plus `PHASE_INTENTS`, `PHASE_KNOWLEDGE`, `STATIC_PHASE_SPECS`, `interaction-mode.ts`'s mode table, and `LEGAL_TRANSITIONS` — six parallel per-phase tables with no completeness check tying them together (`validatePhaseKnowledgePack` covers only one).

### D8 (P2) — "tenant" vocabulary
`internal_handle` appears 32× across interview files (engine.ts ×17, engine-internals.ts ×12, others ×3), threading the multi-tenant-era identifier through a single-owner product (used for the lazy slug-rekey scoping, engine.ts:697-725). Part of the declared repo-wide rename.

### D9 (P3) — Header comments as changelog
Nearly every function carries dated incident archaeology ("Codex r3 P1", "Argus r2 [BLOCKING #2]", "Sam 2026-06-03 verbatim…"). Valuable history, but it doubles file length and buries current contracts; e.g. engine.ts's file header (1-26) still describes the S1/S2 2026-05 architecture, not Path 1.

## 7. Test posture

- **Unit/fixture**: 83 test files / 27.4k lines in `onboarding/interview/__tests__/`, plus colocated `llm-router.test.ts` (1,766). Deterministic via `fixture-anthropic-client.ts` and `interview-testkit.ts`. Character: heavily regression-pinned — file names encode incidents (`source-switch-late-upload-race`, `engine-blank-chat-on-reconnect-bug1`, `import-timeout-progress-aware`). Both mode tables are pinned (`v2-phase-walk.test.ts`, `open-mode-phase-walk.test.ts`) — good refactor safety net for phase.ts.
- **Integration**: 32 of 56 files in `tests/integration/` import interview modules (full walkthrough fixtures: `m2-mira-v3-*`, `conversational-onboarding-end-to-end`, import round-trips).
- **Gaps**: real LLM behavior is untested by design (fixtures only); the Path-1 ↔ phase-machine *interaction* (same state store written by both) has thin direct coverage; the dead `acceptChoice` path is tested (test suite pins dead code, inflating refactor cost); timing-dependent contracts (5s pending-inbound window, 24h resume gap) are tested with injected clocks — good.
- **Flake risk**: low inside this package (no PGLite here; the known PGLite boot flake is gbrain-side). The Opus/CC-subprocess timeout tiers (`llm-timeouts.ts`) are env-sensitive in live runs but fixtured in CI.

## 8. Load-bearing subtleties a refactor must NOT break

1. **Idempotency barrier ordering**: `buttonStore.resolve()` runs before any state mutation; router `state_delta` merges only when `was_new` (engine.ts:4111-4136) — re-merging on duplicate delivery would replay `user_supplied_corrections` and bump `last_advanced_at`.
2. **Pending-inbound re-emit gate**: `recordInboundReceived` writes `last_inbound_received_at` BEFORE `engine.advance` (chat-bridge.ts:1918-1929); `engine.start` skips prompt re-emit if a recent inbound landed after `delivered_at` within `PENDING_INBOUND_WINDOW_MS` = 5s (engine.ts:512-537). Reordering silently clobbers typed answers on reconnect.
3. **Per-channel re-emit contracts**: `topicHasEphemeralTranscript` (engine.ts:508) — web always re-emits on session-open (blank-chat P0), Telegram only on undelivered/topic-change. New channels default to the conservative gate.
4. **Crash-resume watermarks**: `wow_fired` re-fires dispatch only when BOTH `wow_report` and `wow_dispatch_error` are absent (engine.ts:741-755); `import_running` mirrors it. The watermark writes share the upsert with the phase advance — splitting them creates a stranding window.
5. **`last_advanced_at` dual semantics**: stuck-user re-emits PRESERVE it (stall-watchdog signal); deliberate source-switch re-emits BUMP it (engine.ts:3958-3987 doc). Uniformizing breaks the resume cron.
6. **Non-destructive source-switch re-emit**: re-showing source buttons must never clear `ai_substrate_used`/`uploads_received`; the reset lives only in the tap-consume handler (engine.ts:3967-3979) — the data-loss guarantee is positional.
7. **Router amend whitelist**: `ROUTER_AMEND_ALLOWED_KEYS` + `ROUTER_AMEND_SUBSTRATE_VALUES` (engine.ts:372-405) are the only guards between LLM JSON and `phase_state`; the TS types do not enforce this.
8. **`AMEND_ACK_FALLBACK_TEXT` fresh prompt_id** (engine.ts:407-417): an empty router response must still emit with a NEW prompt_id or the web typing indicator hangs forever (client dedupes unchanged ids).
9. **Final-handoff choice-value membership guard** (engine.ts:437-443): checked BEFORE `buttonStore.resolve()` so a malformed tap can't stamp `resolved_at` and lock the prompt against a legit retap.
10. **Auto-skip invariants**: `walkAutoSkip` chains through `AUTO_SKIP_PHASES`; `resolvePhasePromptSpecUncached` returns null for them as belt-and-braces (engine.ts:7813-7820). Both sides must move together.
11. **Upsert atomicity assumption**: sqlite-state-store relies on one-statement upserts for crash consistency (sqlite-state-store.ts:11-14); introducing multi-statement writes needs a transaction.
12. **Per-user serialization tails**: `importUploadSerial` (engine.ts:557-567) serializes concurrent upload notifications (duplicate-import-job race); post-turn-extractor keeps a mirrored per-user chain.
13. **Open-mode routing is additive**: open edges layer ON TOP of the managed table; `isLegalTransition` defaults to `'managed'` (phase.ts:146-158) so untouched callers/tests see byte-identical behavior. Changing the default flips test matrices.
14. **Path-1 import prompt handling**: the successful `import_analysis_presented` prompt has its accept button STRIPPED and its body persisted via the durable chat_log adapter for seq ordering, while all other import prompts stay ephemeral under engine-owned re-emit (open/composer.ts:2963-3010). One-off, ordering-sensitive.
15. **Background suggester pre-compute**: fires only with `hasSignal`, memoizes into `phase_state`, is fire-and-forget with swallowed failures (engine.ts:7821-7852); `personality_offered` render depends on the memo being readable, not on the promise.
16. **Spec cache lifetime**: `clearResolvedSpecCache()` at the top of `start`/`acceptChoice` — the resolved-spec cache is per-turn; making it longer-lived would serve stale LLM copy across phase changes.

## 9. What the refactor should do here

1. **First, resolve D1**: pick the target architecture. Most likely: Path-1 live-session is the product direction (it is the Open default and matches "the agent IS a Claude Code process"); the phase machine should shrink to what Path-1 actually needs — the **import pipeline** (upload → run → analyze → materialize, incl. crons, timeouts, crash-resume) and required-fields bookkeeping. Quarantine or delete the conversational drive (router dispatch, spec resolver rephrasing, per-phase consume cascade) once the `web:` chat-bridge surface is either retired or moved onto Path-1. This alone eliminates ~half of engine.ts. If both must be kept, document the fork at the composition roots and add an integration test pinning that both write compatible `phase_state`.
2. **Replace the `EngineInternals` friend interface with real modules.** Carve along the existing cluster seams — ImportFlow (already externalized), PersonaFlow, SlugFlow (open-mode dead — candidate for deletion), WowFlow, FinalHandoff, GapFill, Resume, SpecResolution, Credentials(MaxOauth) — each owning its methods and depending on 2-4 narrow capability interfaces (StateAccess, PromptEmitter, TranscriptSink, Clock) instead of the whole engine. The delegator layer and the 300-line interface then disappear.
3. **Type `phase_state`**: one module declaring the key registry (per-phase sub-state types + a validated codec); move `readString`-style access behind it. This is the highest-leverage robustness win and directly protects the router whitelist and crash-resume watermarks.
4. **Collapse the six parallel per-phase tables** into a single per-phase descriptor (prompt spec source, interaction mode, intent pack, knowledge pack, consume handler, legal next phases) with an exhaustiveness check over `ALL_PHASES`.
5. **Delete dead surface with test migration**: `acceptChoice` + its types, the 'both'-flow deploy-window branches (after confirming no live rows), stale v1-name comments; declare `@neutronai/runtime` (and cron) in package.json or lift the shared bits (`models.ts`, timeout tokens) into a leaf package.
6. **Unify LLM-call scaffolding** (prompt build, JSON parse, timeout tiers, telemetry) across router, spec-resolver, suggesters, and post-turn extractor into one helper module; rename the colliding `buildSystemPrompt`/`buildUserPrompt` exports.

All of the above can be staged as pure moves guarded by the existing 83-file unit suite + 32 integration tests; the phase-walk matrices and incident-named regression tests are the behavioral contract to keep green.
