# K11 Execution Plan — K11a (extractions + test re-anchoring) → K11b (deletion)

**Generated:** 2026-07-05 (Fable principal-engineer synthesis; planning only, no code touched).
**Baseline verified against:** `main` @ `fd814d9` (post K1–K5/K7–K9; K6 #225 parked). Every file:line below was re-grepped at this HEAD.
**Inputs:** `docs/research/fable-refactor-audit-2026-07-05.md` (§1.B, §2) + `docs/plans/2026-07-02-world-class-refactor-plan.md` §K11.

**Ground rules (binding on every sub-unit):**

1. **Anchor re-grep is a per-unit MANDATORY gate** (audit §3.5): the dispatch prompt for each unit must re-grep every cited symbol/line and park-and-flag on mismatch. Line numbers here are correct at `fd814d9` and will drift as K11a units land.
2. **Delete by symbol, not by line range.** The engine.ts "clusters" are interleaved with live methods (e.g. `notifyImportUploadLocked` sits between `advance` and `normalAdvance` — the LATE_UPLOAD notice at `engine.ts:2246` is INSIDE the old "advance 1721–2411" range). Range-based deletion will destroy live code.
3. **K11a PRs merged + green BEFORE any K11b PR opens.** Test re-anchoring (K11a6) is merged-first, never same-PR with the deletion (audit §2 gate).
4. **Served-by-path checks in every delete unit** (memory: grep-zero-importers misses URL/route-served files). For K11 that concretely means: upload POST routes → `engine.notifyImportUpload` (`gateway/upload/import-upload-handler.ts`, `chunked-upload-handler.ts`, `channels/topic-id.ts:18`), cron registration → `pollImportRunningTick` (`gateway/composition/build-core-modules.ts:621`), and `on_session_open` → import-watch re-arm (`open/composer.ts:3488-3540`).
5. **Cross-package consumer gate** (memory: W8 lesson): every unit runs BOTH root `tsc` and leaf tsconfigs, plus the consumer tests of every package whose imports were repointed (gateway/, open/, reminders/, onboarding/), not just the package edited.

---

## 0. Sub-unit graph

| Unit | Title | Lane | Model | Size | Depends on | PR grouping |
|------|-------|------|-------|------|-----------|-------------|
| K11a1 | chat-bridge sender-registry + turn-runner type extraction | transport | sonnet | S | — | own PR |
| K11a2 | Anthropic-client extraction out of llm-router/build-llm-router | gateway | sonnet | M | — | own PR |
| K11a3 | interaction-mode import-copy extraction | engine | sonnet | S | — | own PR |
| K11a4 | personality static-fallback extraction (+ RETAIN correction) | engine | sonnet | S | — | own PR |
| K11a5 | engine-slug SPLIT (live open half out; managed remainder stays) | engine | opus | M | — | own PR |
| K11a6 | import/engine integration-test triage + re-anchoring | engine | opus | L | a3 (detector test split); ideally last of the a-wave | 1–2 PRs |
| K11b1 | conversational-drive deletion (engine + chat-bridge drive + llm-router + interaction-mode + resume-cron + flags + dead suites) | engine | opus | L | ALL K11a merged+green | own PR (largest) |
| K11b2 | NEUTRON_DEPLOYMENT_MODE alias migration | gateway | sonnet | S | — (independent) | own PR |
| K11b3 | legacy `web:` registry delivery cleanup + WowChannelAdapter rewire | gateway | opus | S–M | K11a1 | own PR |

Parallelism: K11a1–a5 are mutually independent (disjoint files except trivial engine.ts import-block touches in a3/a4/a5 — sequence merges, don't co-edit). K11b2 can run any time. K11b3 needs only a1. K11b1 is the convergence point.

**Deferred out of K11 entirely:** engine-slug managed `slug_chosen` remainder deletion → K4b, gated on D-5 (audit §2.5). Audit §1.A items 1–3 (K8 `/code` sub-verb drift, K3 import-resilience test port, rate-limit ceiling) are separate act-now fix units, not folded here — but K11a6 must coordinate with the K3 port (same test surface).

---

## 1. K11a1 — chat-bridge: sender-registry + turn-runner type extraction

**Why:** resolves the K11↔D3 circular ordering (audit §2.1 — pulling this slice forward is the plan's own named fallback) and unblocks K11b3.

**Symbols to move** (all in `gateway/http/chat-bridge.ts`):

- `WebChatSenderRegistry` interface — chat-bridge.ts:149
- `InMemoryWebChatSenderRegistry` class — chat-bridge.ts:172
- `LiveAgentTurnRequest` interface (incl. `seed_turn` JSDoc) — chat-bridge.ts:~240–307 (re-grep; ends just above :309)
- `LiveAgentTurnRunner` type — chat-bridge.ts:309

**Target home:** new `gateway/http/chat-sender-registry.ts` (proposed name; a sibling leaf in the same directory). **Depcruise check:** all current importers are in `gateway/` (composition band) or `reminders/` (services band). `reminders/outbound.ts:25` already type-imports from `gateway/http/chat-bridge.ts` — moving to a sibling module in the SAME directory changes no band edge, so the ratchet stays neutral. Do NOT home this under `landing/` or a new top-level `contracts/` in this unit — L2 (wave 2) owns promoting `WebChatSenderRegistry` to the contracts leaf and will repoint once more; fighting L2's staging here buys nothing.

**Transition shim:** `export { … } from './chat-sender-registry.ts'` re-exports stay in chat-bridge.ts for one PR (L1/L2 pattern), then importers are repointed in the same PR (small enough to do both at once; the shim is belt-and-braces for Managed vendoring).

**Live importers to repoint** (10 sites, 6 files):

| File | Lines |
|---|---|
| `gateway/http/recovered-reply-store.ts` | :53 (type import) |
| `gateway/proactive/button-store-sink.ts` | :37 |
| `gateway/realmode-composer/build-landing-stack.ts` | :38–43 (value + type import), :176 + :840 (inline `import('../http/chat-bridge.ts')` type refs), :648 (inline `LiveAgentTurnRunner` ref) |
| `gateway/realmode-composer/build-phase-spec-resolver.ts` | :53 |
| `gateway/realmode-composer/build-wow-dispatcher.ts` | :89 |
| `reminders/outbound.ts` | :25 |

(`open/composer.ts:1954` `appWsAgentPushRegistry` is shape-only — comment references, no import to repoint. `channels/adapters/app-ws/session-registry.ts:5` is comment-only.)

**Stays in chat-bridge.ts (live, untouched):** `webTopicId` (already its own module `gateway/http/web-topic-id.ts:20` — no action), `renderButtonPromptForWeb` (:408), `buildRoutedSendImportProgress` (:622), `buildRoutedSendButtonPrompt` (:652), `buildOwnerRegistryLookupFromRegistry` (:502), `buildSlugHistoryShimFromRegistry` (:779), `buildWebChatBridge` (:1010), the AppSocket routers + `WebChatSessionProjectRegistry`.

**Tests:** no test migrates (the registry has no dedicated unit file); the six `gateway/http/__tests__/chat-bridge-*.test.ts` suites plus `reminders/` tests must stay green as consumers.

**Accept:** root+leaf tsc green; `bun test gateway/ reminders/ open/__tests__` green; `git grep "from './chat-bridge.ts'" | grep -i "SenderRegistry\|LiveAgentTurn"` returns only the transition shim; depcruise ratchet unchanged.

---

## 2. K11a2 — Anthropic-client extraction (llm-router / build-llm-router live halves)

**Why:** `buildGatewayAnthropicMessagesClient` is THE production LLM client (audit §1.B.6); both host files are otherwise K11b delete targets.

### 2a. Types → `onboarding/interview/anthropic-client.ts` (new leaf, product band)

- `AnthropicMessageResponse` — `onboarding/interview/llm-router.ts:222`
- `AnthropicMessagesClient` — llm-router.ts:226–234

Product-band home is required because live consumers span onboarding/ (product) and gateway/ (composition); composition may import product but not vice versa, so the type must live at or below product. A leaf with zero imports — depcruise-clean.

**Live importers to repoint (5 non-test + 3 test):**

| File | Line |
|---|---|
| `gateway/realmode-composer/build-project-doc-composer.ts` | :29 |
| `gateway/realmode-composer/build-project-kickoff-composer.ts` | :25 |
| `gateway/realmode-composer/build-project-opening-message.ts` | :50 |
| `onboarding/interview/fixture-anthropic-client.ts` | :56–58 |
| `gateway/realmode-composer/build-llm-router.ts` | :37–38 (until K11b1 deletes it) |
| tests | `build-project-doc-composer.test.ts:10`, `build-project-opening-message.test.ts:21`, `interview-testkit.ts:28` (re-grep what it pulls; repoint only the client types) |

Do NOT consolidate the three structural duplicates (`agent-name-suggester.ts:172-183`, `personality-character-suggester.ts:235-246`, `persona-gen/summarize.ts:44-55`) in this unit — they compile standalone and two of the three hosts are RETAIN modules; consolidation is later-wave polish, not a K11 dependency.

### 2b. Also move `PhaseKnowledgePack` (live type stranded in the delete target)

`PhaseKnowledgePack` is defined at `llm-router.ts:115` but its only live consumer is the RETAINED `phase-spec-resolver.ts:47` (packs at :309/:377/:446/:529; `validatePhaseKnowledgePack` already lives at phase-spec-resolver.ts:1157). **Move the interface into `phase-spec-resolver.ts` itself** (its natural home) and repoint `phase-knowledge.test.ts:30`. The test's `buildSystemPrompt` import (:31) pins router-internal sanitisation — split the test: pack-content/validation assertions stay, `buildSystemPrompt`/`sanitisedKnowledgeBlock` assertions are marked for deletion with K11b1. (The audit did not name this move; without it K11b1 cannot compile. Verified: `git grep PhaseKnowledgePack` — no other live consumer.)

### 2c. Factory → `gateway/realmode-composer/build-anthropic-messages-client.ts` (new, composition band)

- `BuildGatewayAnthropicMessagesClientInput` — `build-llm-router.ts:262`
- `buildGatewayAnthropicMessagesClient` — build-llm-router.ts:280–321 (file ends at 321; take the whole tail block verbatim, JSDoc included)

Its dependencies are all same-band or lower (verified from build-llm-router.ts imports): `Substrate`/`AgentSpec` (runtime/substrate), `getBestModel` (runtime/models), `collectTokensToString`/`renderMessagesArray` (./build-llm-call-substrate.ts). No depcruise change.

**Live importers to repoint:**

- `open/composer.ts:94` (import) + :1108 (call — the ONE warm-substrate client fan-out)
- `gateway/realmode-composer/build-landing-stack.ts:82` (import) + :952 (import-synthesis call)

**Test migration (BLOCKER pin):** `gateway/realmode-composer/__tests__/build-llm-router-cc-substrate.test.ts` (imports the factory at :18; pins the Argus BLOCKER caller-model-override) → rename to `build-anthropic-messages-client.test.ts`, repoint, keep every assertion.

**Explicitly NOT in this unit:** unwiring dead `buildGatewayLlmRouter` (`open/composer.ts:95,1127-1133,1300`; `build-landing-stack.ts:605-610`) — that is K11b1. K11a2 leaves `build-llm-router.ts` as a compiling husk (router factory + fixture-env shim only).

**Accept:** root+leaf tsc; `bun test gateway/realmode-composer open/__tests__ onboarding/interview/__tests__/phase-knowledge*`; the renamed cc-substrate test green with the model-override assertion intact; `git grep buildGatewayAnthropicMessagesClient` shows only the new module + 2 call sites.

---

## 3. K11a3 — interaction-mode: import-copy extraction

**Why:** `interaction-mode.ts` is servedByPath=TRUE (audit §1.B.5) — three exports are load-bearing for the KEPT import subsystem; the other ~500 lines are conversational and die in K11b1.

**Symbols to move** (from `onboarding/interview/interaction-mode.ts`) → new **`onboarding/interview/import-source-copy.ts`** (import-subsystem leaf, zero imports):

- `IMPORT_SOURCE_SWITCH_ACK` — :276
- `LATE_UPLOAD_SOURCE_MISMATCH_NOTICE` — :294
- `detectImportSourceMention` — :423 (plus its private negation helper documented at :448 — take the whole detector block verbatim)

**Live importers to repoint (3 files):**

| File | Line | Symbols |
|---|---|---|
| `onboarding/interview/engine-import-routing.ts` | :34–35 | `IMPORT_SOURCE_SWITCH_ACK` (used :116) |
| `onboarding/interview/engine-internals.ts` | :63 | `detectImportSourceMention` (used :1531) |
| `onboarding/interview/engine.ts` | :146–153 (import block) | repoint ONLY the three moved names; the rest of that block (`INTERACTION_MODE_BY_PHASE` etc.) stays pointed at interaction-mode.ts and dies with K11b1 |

**Test migration:** `onboarding/interview/__tests__/source-switch-late-upload-race.test.ts` — the only coverage of a live prod race (ISSUES #98). Split it:
- the `detectImportSourceMention` describe block (:182–~240) → new `import-source-copy.test.ts` beside the new module;
- the race-integration half (which imports `LlmRouter`/`RouterDecision` at :40 and drives the engine) is K11a6 territory: re-anchor the race pin on `notifyImportUpload` + stateStore, so the live race stays pinned after K11b1. Do not let this half silently die with the conversational suites.

**Accept:** root+leaf tsc; `bun test onboarding/interview` green; **exercised upload-route check**: a test drives the upload POST path (`engine.notifyImportUpload`, mismatch branch → `LATE_UPLOAD_SOURCE_MISMATCH_NOTICE` at `engine.ts:2246` via `notifyImportUploadLocked`) and asserts the notice text — if no existing test covers that exact seam, add it here (it is the acceptance instrument for K11b1's claim that the notice survived).

---

## 4. K11a4 — personality: static-fallback extraction + RETAIN correction

**⚠️ Plan correction (stronger than the audit's wording):** `personality-character-suggester.ts` is NOT a delete-with-extraction target. Verified live at fd814d9:

- `open/composer.ts:127` imports `buildPersonalityCharacterSuggester` and wires it at :1111–1115 into the engine deps (:1293–1295) — the live "ONE warm cc-llm path" wiring.
- `engine-slug.ts:23` imports `buildDiverseCharacterFallback` + `CharacterSuggesterResult`; the LIVE open-mode suggestion getter `getOrStartCharacterSuggestions` (engine-slug.ts:~330, fallback call ~:375) depends on it, on the live prompt-render path (`engine.ts:7915-7960` machinery — audit §1.B.4's same flow).
- `build-landing-stack.ts:668` carries the `PersonalityCharacterSuggester` dep type.

So K11b **RETAINS the module**; this unit only extracts the fallback so `onboarding-preamble.ts` stops importing the suggester module (and so a future D9/engine shrink can reshape the suggester without touching preamble).

**Symbols to move** → new **`onboarding/interview/personality-characters.ts`** (leaf; both preamble and suggester import it — cleaner than the audit's "home: onboarding-preamble.ts", which would invert suggester→preamble):

- `STATIC_PERSONALITY_CHARACTER_FALLBACK` — `personality-character-suggester.ts:215`
- `PersonalityCharacterSuggestions` (:57) + the per-character shape type(s) it references (re-grep exact names at dispatch)

**Importers to repoint:**

- `onboarding/interview/onboarding-preamble.ts:22` (uses `.personalized`/`.wild` at :40–41)
- `personality-character-suggester.ts` itself (fallback path documented at :20, :494)
- tests: `personality-character-suggester.test.ts:15,221,230`; `personality-offered-suggester-wiring.test.ts:36`

**Must stay green (audit-named pins):** `onboarding/interview/__tests__/onboarding-preamble.test.ts`, `button-backed-answer.test.ts`, `personality-offered-character-buttons.test.ts` (all confirmed present), plus `suggester-diverse-fallback.test.ts` and `option-numbered-pick.test.ts` (import from the suggester at :16/:35 — verify they still resolve).

**Accept:** root+leaf tsc; the six tests above green; `onboarding-preamble.ts` no longer imports `personality-character-suggester.ts`.

---

## 5. K11a5 — engine-slug SPLIT (live open-mode half out)

**Why:** plan claim "dead in both repos" is WRONG (audit §1.B.4) — `agent_name_chosen` is a live open-mode phase (`phase.ts:82` legal table, `OPEN_MODE_EXTRA_TRANSITIONS` :129–134 `agent_name_chosen → projects_proposed`), and the suggestion machinery renders on the live prompt path.

**New module `onboarding/interview/engine-agent-name.ts`** — move the live open half (current engine-slug.ts anchors):

| Symbol | engine-slug.ts line |
|---|---|
| `consumeAgentNameChosenChoice` (WHOLE function, incl. its managed `slug_chosen` branch at :267–303 — pruning that branch is K4b/D-5, not K11) | :54 |
| `getOrStartCharacterSuggestions` | :~330 |
| `getOrStartAgentNameSuggestions` | :~404 |
| `maybeAutoAdvancePastMaxOauthOffered` (`max_oauth_offered` IS live in open mode) | :1011 |
| `suggestionFingerprint` | :1067 |
| `suggestionKeyPrefix` | just below :1067 (re-grep) |

**Stays in `engine-slug.ts` (managed `slug_chosen` remainder, ~500–600 lines, K4b/D-5 owns its fate):** `computeSlugSuggestionsForPhase` (:~473), `consumeSlugChosenChoice` (:~529), `advanceFromSlugChosen` (:778), `persistRejectionAndReEmit` (:~887), `reEmitSlugChosen` (:~915).

**Importers to repoint:** `engine.ts:335–346` (the 11-name aliased import block — split it into two blocks, one per module). `engine-slug.ts:23` (`buildDiverseCharacterFallback`) moves with the getters; `engine-slug.ts:31` (`STATIC_PHASE_SPECS`) stays (used by `advanceFromSlugChosen` at :842). Cross-refs in `engine-internals.ts:1550,2187` and `engine.ts:9810` comments — update to name both modules.

**Tests (must stay green, unmodified):** `onboarding/interview/__tests__/open-mode-phase-walk.test.ts` (pins NO-slug-in-open + the open advance branch) and `engine-agent-name-suggestion-wiring.test.ts` (pins the suggestion wiring). Both harness `InterviewEngine` directly — they exercise the moved code through the unchanged engine surface, so a pure move keeps them green with zero edits. If either needs an edit, the split leaked behavior — stop and re-check.

**Accept:** root+leaf tsc; both pinned tests green byte-unmodified; `git diff --stat` shows pure move + import edits (no logic diff — verify with `git diff --color-moved`).

---

## 6. K11a6 — integration-test triage + re-anchoring (THE gate for K11b1)

> ⚠️ **SCOPE CORRECTION (Fable adjudication addendum 2026-07-06, verified @ `b8ce7d8`).** The triage below covers only `tests/integration/` (17 files). The REAL engine-driving surface is **54 files** (39 `onboarding/interview/__tests__/` + 15 `tests/integration/`) — every file calling `engine.start`/`engine.advance`, which K11b1 deletes WHOLESALE. Resolution of the crux question:
> - **Open-mode onboarding runs through the CC session in PROD, not the engine** (`on_session_open`/`on_button_choice` → `appWsChatTurn` + `LiveAgentOnboardingSeam` + `captureRequiredAnswer` + post-turn extractor; `open/composer.ts:2750/3487/3632`). The engine phase-walk (`start`/`advance`/`consumeChoice`) is **dead-in-prod in both Open and Managed** (Managed provisions Open boxes, never drives the engine). So the wholesale deletion is correct.
> - **Disposition of the 54:** ~38 DIE-with-K11b1 (dead conversational/open-mode/persona drive — left in place, co-deleted INSIDE the K11b1 PR per the K8 lesson), ~13 RE-ANCHOR onto retained seams (import cron/upload, ButtonStore, `stateStore`, composer reconnect), ~3–5 dispatch-judgment.
> - **K11a5's two "byte-unmodified" pinned tests (`open-mode-phase-walk`, `engine-agent-name-suggestion-wiring`) BOTH DIE** — that pin was an as-built move-integrity check for the pre-K11b1 tree, never a forward-compat guarantee across K11b1. Not a broken invariant.
> - **`engine-agent-name.ts` (the K11a5 extraction) is retained-but-DEAD post-K11b1** — its "live open half" liveness held only within the dead phase machine. **Decision (owner, 2026-07-06): leave it + the open-mode suggestion branches + `consumeImportAnalysisPresentedChoice` as retained-but-dead in K11b1; confine K11b1 edits to the doomed methods; prune them in a follow-up dead-code unit K11d.** (Bundling would push surgery into retained `emitPhasePrompt`/`resolveLlmSpec` bodies — risk for no prod benefit.)
> - **Two-PR sequence:** **K11a6-remainder PR** (re-anchor the ~13 retained-behavior tests, merged green) → THEN **K11b1** (deletes the drive + the ~38 DIE tests in the same PR). D-K11-4 rider lands AFTER K11b1; D-K11-7 → K11c; K11d = the retained-but-dead prune.
> - **⚠️ RE-ANCHOR RULE (learned the hard way — Codex REQUEST_CHANGES on 2 of 3 K11a6-rem PRs, #236/#238):** re-anchoring must be **ADDITIVE, never subtractive**. A test that pins BOTH retained behavior AND still-live-but-dying engine drive must be SPLIT: the retained half re-anchors onto its seam (0 `engine.start/advance`, survives); the dying half is **preserved byte-intact in a `*.die.test.ts` file** (still drives `engine.start/advance`, header `// DIES WITH K11b1 …`) that co-deletes in K11b1. **NEVER drop a live-code assertion on the premise "the drive is deleted" — it isn't deleted until K11b1 runs.** Dropping it un-pins live code for the whole interim window (the K8 lesson). This applies symbol-for-symbol inside K11b1 too.

**Why:** the live import subsystem's coverage currently harnesses through `engine.start`/`engine.advance`. Deleting the drive with the tests still pointed at it either breaks CI or (worse) tempts same-PR test deletion that erases live-behavior pins (the K8 lesson, audit §1.A.1).

**Full triage list** — every `tests/integration/*.test.ts` that calls `.start({`/`.advance({` at fd814d9 (17 files), classified:

**(A) RE-ANCHOR on `notifyImportUpload` / `pollImportRunningTick` (or `buildImportRunningHandler`) / stateStore-seeding / `on_session_open` — merged + green BEFORE K11b1:**

1. `import-analysis-presented.test.ts` (also strip its `RouterDecision` type import :65)
2. `import-resume-button.test.ts`
3. `import-running-cron-scheduler-boot.test.ts`
4. `import-failed-routes-to-analysis-presented.test.ts`
5. `import-paused-auto-resume.test.ts` — **OR delete with the unreachable `rate_limit_paused` machinery per audit §1.A.3 / D9 brief (owner call D-K11-4 below)**

Pattern to re-anchor on (already proven in-tree): `import-hard-timeout-resilience.test.ts`, `import-running-cron-tick.test.ts`, `import-running-progress-envelope-bug1.test.ts`, `import-watch-rearm-on-reconnect.open.test.ts`, `import-finalize-after-fields-complete.open.test.ts` need NO rework (verified: no `.start(`/`.advance(` calls).

**(B) KEEP AS-IS if they pin retained machinery via retained entry points — verify at dispatch, re-anchor if not:** `persona-v2-flow.test.ts`, `persona-reviewed-advance.test.ts`, `profile-pic-pipeline.test.ts`, `personality-offered-single-handler.test.ts`, `personality-name-slug-projects-flow.open.test.ts`, `button-idempotency.test.ts`, `button-primitive-cross-channel.test.ts`, `engine-blank-chat-on-reconnect-bug1.test.ts`, `engine-reemit-pending-inbound-race-bug2.test.ts`, `adapter-equivalence.test.ts`. Rule: if the pinned behavior (persona synthesis, profile-pic, button re-emit) survives K11b via a non-conversational entry point, the test must be re-anchored on that entry point; if the pinned behavior IS the conversational drive, it moves to list (C). Do NOT bulk-classify — one judgment per file, recorded in the PR description.
**(C) DIE WITH K11b1 (conversational-drive pins, delete in the same PR as the code):** `conversational-onboarding-end-to-end.test.ts`, `m2-mira-v3-conversational-fixture.test.ts`, `m2-mira-v3-tangent-coverage.test.ts`, `m2-soren-v2-fixture.open.test.ts`, `onboarding-resume-on-reconnect.test.ts` + `onboarding-resume-cron.test.ts` (resume-cron pins), plus the in-package conversational suites (see K11b1 list).

**Also in this unit:**
- Re-anchor the race half of `source-switch-late-upload-race.test.ts` (from K11a3).
- **Restart-recovery pin (K11 spec requirement):** verify `import-watch-rearm-on-reconnect.open.test.ts` fully pins the composer-side replacements for `engine.start()`'s crash-resume watermarks (`on_session_open` re-arm at `open/composer.ts:3514-3540` + `finalizeImportOnboardingIfReady` at :3509-3513). It pins the re-arm; if the finalize-recovery branch or the seed path is unpinned, extend here.
- `phase-state-contract.test.ts:47` (K4a's fresh pin) imports `RouterDecision` — narrow the pin: keep the phase_state key-contract assertions, remove/replace router-`state_delta` assertions whose guard (`engine.ts:368-384` + `dispatchRouterDecision`) K11b1 deletes. Flag in PR if any contract key is ONLY enforced by the router guard (owner call D-K11-6).

**Accept:** all (A)+(B) tests green with zero imports of `engine.start`/`advance`/llm-router types; `git grep -l "\.start({\|\.advance({" tests/integration/` returns only list-(C) files; merged to main before K11b1 dispatch.

---

## 7. K11b1 — the deletion (conversational drive + router + flags)

**Precondition:** K11a1–a6 merged + green on main. Expected net: −8–10k LOC.

### 7.1 chat-bridge.ts — excise the drive, keep the grammar

- `startSession` (:1182): remove the `engine.start` invocation block (:1284–~1360, log tags `engine-start-invoking`/`engine-start-failed`) and its jti-race unwind that exists only for the engine call; KEEP claim-first atomicity, reconnect/pending-redirect replay, `reEmitActiveSeedPromptIfAny`, recovered-reply drain, registry register/unregister (the JSDoc at :874, :1006 is the spec — update it, don't delete it).
- `handleInbound` (:1502): remove the `engine.advance` dispatches (:1900, :1954) + the typing-bracket engine coupling (:369-370 header claim); KEEP the live-agent turn routing, command filter, and outbound grammar.
- Fix stale headers claiming engine drive (:22–28, :878, :926).
- **Dispatch-time verification (served-by-path):** re-confirm no live route mounts a bridge whose inbound reaches the engine: `buildWebChatBridge` is constructed at `build-landing-stack.ts:1317`; trace what mounts the stack's `bridge` (K11 spec: `landing/server.ts:714-721` "nothing reads it anymore"; `landing/boot.ts:116-122` is the no-op). If ANY live mount is found → STOP, park, flag (K1/connect-accept failure class).

### 7.2 engine.ts — delete by method (retain-aware)

Delete (current anchors; re-grep): `start` (:686), `advance` (:1721), `normalAdvance` (:2412), `dispatchRouterDecision` (:3038), `consumeChoice` (:3817) — **zero non-test external callers verified for `consumeChoice`; `start` has TWO (chat-bridge §7.1 and `onboarding/api/start-onboarding.ts:36` — see D-K11-1)** — plus `shouldConsultRouter` (:2819), the router `state_delta` allow-key guard (:368–384), the resume/gap-fill conversational drive and personality conversational branches, and every private helper orphaned by these (find via tsc unused + `bun run` dead-code sweep, NOT by range).

**RETAIN (verified live at fd814d9):**

- `notifyImportUpload`/`notifyImportUploadLocked` (upload POST routes; LATE_UPLOAD notice at :2246), `pollImportRunningTick` (cron :621 build-core-modules), the import-watch surface.
- `consumeImportAnalysisPresentedChoice` delegator (`engine.ts:313` import; impl lives in retained `engine-import-routing.ts:1630`).
- `work_interview_gap_fill` phase enum + legal transitions (80 non-test refs) — `phase.ts` untouched.
- Hook-type re-export blocks `engine.ts:245–298` (8 live importers per audit).
- `emitCurrentPhasePrompt`/`resolvePhasePromptSpec` prompt-render path + suggestion machinery (:7915–7960) + the `STATIC_PHASE_SPECS` static fallback (:8142) — the LLM-less/failure path. The flag collapse (7.5) removes env gates, NEVER a copy source.
- `engine-agent-name.ts` (K11a5), `engine-import-routing.ts`, `engine-internals.ts` (minus orphaned drive fields — e.g. `deps.llmRouter`, engine-internals.ts:64), `engine-persona.ts`, `agent-name-suggester.ts` (Managed ABI, incl. `buildDiverseAgentNameFallback`), `personality-character-suggester.ts` (see K11a4 correction), `phase-spec-resolver.ts` + `phase-prompts.ts`, `runtime/env-flag-tokens.ts`.

### 7.3 llm-router stack

Delete: `onboarding/interview/llm-router.ts` (1,428) + `llm-router.test.ts` (1,766); `gateway/realmode-composer/build-llm-router.ts` husk (`buildGatewayLlmRouter` :120 + `maybeBuildFixtureClientFromEnv` shim); `onboarding/interview/fixture-anthropic-client.ts` (312) + `fixture-anthropic-client.test.ts` (post-K11b its only importers are dead: build-llm-router.ts:43 + two dying suites — verified). Paired unwiring: `open/composer.ts:95-96` imports + `llmRouter` construction :1124–1133 + deps spread :1300; `build-landing-stack.ts:605-610` `llmRouter` dep + stale flag comments :593/:1189/:1240. Router timeout envs die inside llm-router.ts (`NEUTRON_ROUTER_HAIKU_TIMEOUT_MS` :363, `_SONNET_` :369, `_FIRST_TURN_` :377). `router_decision` telemetry: delete the emit site (build-llm-router.ts:136) + `RouterTelemetryEvent` surface + `onboarding/telemetry/__tests__/router-decision-events.test.ts`; keep the rest of `event-emitter.ts` (fix its :325-326 cross-refs).

### 7.4 interaction-mode remainder + conversational suites

Delete `onboarding/interview/interaction-mode.ts` (remaining ~500 lines post-K11a3) + `interaction-mode.test.ts`. In-package dying suites: `engine-router-integration`, `interaction-mode-routing`, `interaction-mode-substep-router-bypass`, `buttons-only-safety-net`, `signup-router-prod-path`, `work-interview-projects-extraction-real-path`, `gap1-additive-confirm-merge`, `gap1-live-import-analysis-merge`, `projects-proposed-ignore-removal`, `projects-proposed-prod-union-merge`, `v2-phase-walk`, `llm-router-decision`, `phase-knowledge` router-half (per K11a2b), `gateway/__tests__/llm-router-persona-wiring`, `gateway/realmode-composer/__tests__/llm-router-composer` + list-(C) integration suites from K11a6. **Each file needs one dispatch-time judgment** — a suite that ALSO pins retained behavior gets its retained assertions ported first (K8 lesson). `signup-asks-name.test.ts` and `interview-testkit.ts` in particular: triage, don't bulk-delete.

### 7.5 Flag purge

- `runtime/onboarding-conversational-flag.ts` + adapter accessors: `platform-adapter-local.ts:64` import + :253-264 hard-pin block; `platform-adapter.ts:588-…` accessor contract. The adapter surface loses the method; repoint the one consumer noted in L2 (`runtime/onboarding-conversational-flag.ts:24` imports `OnboardingPhase` — dies with the file, removing an L2 work item; note it in the L2 brief).
- Phase-flag pair: delete `NEUTRON_LLM_ONBOARDING_PHASES`/`_DEFAULT` env reads in `build-phase-spec-resolver.ts` **preserving current default-behavior** (the resolver keeps working for import prompt copy; only the env gate collapses). Update `build-phase-spec-resolver.test.ts` rows (:140–298) and the escalation tests that set the env (`chat-bridge-escalation-routing.test.ts:265`, `agent-watcher-escalation-routing.test.ts:198`, `admin-personality-persona-wiring.test.ts:123`).
  - > ⚠️ **CORRECTION (Fable sweep §3 N3):** the same env pair is ALSO read in the **retained** `onboarding/interview/phase-spec-resolver.ts:2007-2067` (the parse/precedence functions), not only `build-phase-spec-resolver.ts`. Deleting just the build-side gate leaves live env reads and violates the "zero feature-flag branches" acceptance. Purge BOTH sites (preserving default behavior in each), or the acceptance grep will fail.
- KEEP `runtime/env-flag-tokens.ts` (shared parser, audit retain list).

### 7.6 resume-cron (safe-to-delete, paired edits verified)

Delete `onboarding/interview/resume-cron.ts` (389). Paired edits: `gateway/composition/build-core-modules.ts` import :42–45 + registration block :585–615; `gateway/composition/input/onboarding-input.ts:55-82` `onboarding_resume_cron` config member; `onboarding/index.ts:99–107` re-export block; tests `onboarding-resume-cron.test.ts` + `onboarding-resume-on-reconnect.test.ts`. Verified: NO live composer passes `onboarding_resume_cron` (only the type + reader exist) — the wiring is already dead-configured. `import-running-cron.ts` (:25 comment mirrors it) is LIVE — untouched; fix its comment.

### 7.7 Stale-comment truth pass (same PR)

`open/composer.ts:1450-1459` (engine.start claims on the auth-gate path), `gateway/http/app-ws-surface.ts:158-165` (`on_session_open` "calls engine.start" — it drives `appWsChatTurn`, verified `open/composer.ts:3488-3560`), chat-bridge headers (§7.1), `import-running-cron.ts:25`.

**Gates for K11b1:** root+leaf tsc (incl. `tsc -p trident/tsconfig.json` per repo memory); full `scripts/run-tests.sh`; cross-package consumer tests (gateway/realmode-composer, open/, onboarding/, reminders/); exercised upload-route check (K11a3's acceptance test still green); depcruise ratchet must IMPROVE (record delta); leak-gate on clean checkout; fresh-install boot smoke; **Managed vendored-tenant boot — requires M0 (see D-K11-3)**.

---

## 8. K11b2 — NEUTRON_DEPLOYMENT_MODE alias: DELETE (owner-approved) ✅

> ✅ **DONE — owner-approved DELETE (Ryan, 2026-07-08).** Ryan explicitly delegated the call: *"if you can't find it anywhere in neutron-open or neutron-managed then it's probably safe to delete — make the call."* The orchestrator re-verified exhaustively across BOTH repos: every `NEUTRON_DEPLOYMENT_MODE` occurrence is a **test fixture** or a vendored copy of the tests; the Managed provisioner surfaces (`neutron-managed/scripts/provision-hetzner.sh`, `vendor/neutron/{neutron-service,install}.sh`, `.env.example`) set **neither** `NEUTRON_ROLE` **nor** the alias; no `NEUTRON_ROLE` set-site anywhere in neutron-managed. So the alias branch was never taken on any tracked box → removal is behavior-preserving. **⚠️ The earlier "load-bearing / 2-step ops migration" framing is superseded** by this owner decision. Mode resolves **purely from env** (`NEUTRON_ROLE` > default `'open'`); the identity signing key only warns/narrows, it doesn't set mode.
>
> **Residual + accepted trade-off (owner-approved, stated plainly — no false guard).** Mode gates managed-only credential isolation (`resolve-llm-credentials.ts` refuses the shared env key unless `mode !== 'open'`). So a box that set ONLY the retired alias (and no `NEUTRON_ROLE`) now resolves to `'open'` and could use that shared key — a real boundary change, but only for a box that does NOT exist in either repo (verified). Codex r1 correctly flagged that a warn-that-still-returns-`open` is worse than an honest delete (it claims a protection it doesn't provide), and there is NO implemented boot tripwire despite the header's aspirational note — so the deletion is a **clean removal**, documented, not a theatrical guard. The sole residual is an untracked hand-set env on the live Managed VPS; owner explicitly accepted it. Fix if ever hit: set `NEUTRON_ROLE=managed` there.

**Done in the K11b2 PR:** `gateway/deployment-mode.ts` — removed the `DEPLOYMENT_MODE_ENV` const + the `fromAlias` resolver branch; `NEUTRON_ROLE` is the sole key; honest JSDoc on the accepted trade-off. `deployment-mode.test.ts` — alias rows converted to `NEUTRON_ROLE`; new pins for the alias-inert contract (`{NEUTRON_DEPLOYMENT_MODE:'managed'} → open`, mixed-invalid → open, canonical wins over stray alias). `resolve-llm-credentials.test.ts` — managed-mode shared-key **security pin** kept on `NEUTRON_ROLE`; added an explicit boundary characterization test documenting the accepted change (alias-only → open → shared key usable) so it's greppable, not hidden. `build-landing-stack.ts` — stale alias comment dropped. **Accept met:** tsc + matrix + test files green; `git grep NEUTRON_DEPLOYMENT_MODE` in prod `.ts` = 0 (only tests document the retired behavior).

## 8b. K11c ✅ DONE + K11d ✅ DONE + K11e (new follow-up)

- **✅ K11c — dead OAuth import sources purged (#247, merged 2026-07-07, main green).** The 5 `-oauth` `ImportSource` members (`gmail`/`calendar`/`drive`/`notion`/`slack`) + their `oauth-*.ts` fetchers/stubs deleted; `ImportSource` narrowed to `chatgpt-zip | claude-zip`. Verified DEAD via a served-by-path audit (no UI offer, no choice→source map, no payload resolver arm; the one consumer `build-synthesis-import-runner.ts` imported the clients as TYPES only + wired throwing clients). +32/−765. **This resolves D-K11-7 → (a) delete-as-sub-unit.** Codex r1 caught a real boundary gap (parser lost its `default` arm while migration 0040's CHECK still permits legacy `-oauth` strings) → hardened 3 boundaries (parser throws typed `ImportError`, resume endpoint 409s `unsupported_source`, readiness probe returns false) + replacement boundary tests.
- **✅ K11d — dead wow-push/final-handoff/max_oauth cluster deleted (#248, merged 2026-07-07, main green).** ~12.7k LOC. Verified DEAD **3 ways** (K11d liveness audit + Fable adversarial adjudication + direct grep): the whole cluster was orphaned when #243 deleted the `advance()/start()/consumeChoice()` phase-walk driver — `emitCurrentPhasePrompt` has ZERO production callers (only the 2 #243 survivor tests, deleted here). **Corrects the #243 "live-reachable" mislabel** (the retained seam was orphaned by the same PR). Surgical KEEP-list honored (`build-onboarding-handoff.ts` 3 live builders kept; `wow-moment/{project-materializer,project-identity,action-types}` kept). Codex r1 flagged incomplete-deletion contract residue (dead deps on `BuildLandingStackInput`/`InterviewEngineDeps`) → removed in 2 follow-up commits. Codex also flagged the `max_oauth_offered`/`wow_fired` **phase-prompts** as a "dead CTA / active lie" — **declined as pre-existing dead phase-data** (K11d doesn't touch `phase-prompts.ts`; the phases are unreachable on main + branch; the CTA handler was already caller-less on main). Fable confirmed K11d is **behavior-preserving**. See PR #248 comment for the full trace.
- **🆕 K11e — prune the orphaned onboarding phase DEFINITIONS (follow-up, own PR).** The `max_oauth_offered` + `wow_fired` (and likely `persona_reviewed`, `final_handoff`, `agent_name_chosen`, `import_analysis_presented` if confirmed dead) phase entries in `onboarding/interview/phase-prompts.ts` (:367-394 + dynamic builder ~:1847-1990), the enum values in `phase.ts` (:42-43), `LEGAL_TRANSITIONS` rows (:88-96), `ALL_PHASES` (:176-177), and the `phase-spec-resolver.ts` packs (:258/:269/:1158/:1165) are now-orphaned dead data (unreachable since #243). **⚠️ NOT data-only — needs a legacy-row compat decision:** `POST_MAX_OAUTH_PHASES` (`gateway/realmode-composer/resolve-onboarding-phase.ts:47-48`) is LIVE creds-gate logic; legacy sqlite `onboarding_state` rows persisted at these phase strings (from pre-#243 deployments) must keep classifying as post-max for the gate. Removing the enum values requires either a migration/backfill of those rows or a retained string-compat set. Run a dedicated liveness pass (served-by-path trap) before deleting. `persona_reviewed.next_phase_on_default: 'max_oauth_offered'` (phase-prompts.ts:344) also needs a retarget. Owner-adjacent (Managed onboarding) — verify no live render.

## 9. K11b3 — legacy `web:` registry delivery cleanup

> ⚠️ **UPDATE (2026-07-07, post-K11d):** the WowChannelAdapter bullet below is now **MOOT** — K11d (#248) deleted `gateway/realmode-composer/build-wow-dispatcher.ts` (which held `WowChannelAdapter`) entirely. K11b3 is now purely the composer comment-truth pass on the stale `landing.registry` comments. Re-grep before running.


After K11a1. Narrow scope (the registry TYPE, `InMemoryWebChatSenderRegistry`, and the buildLandingStack instance all remain — import-progress emission, reminders routing, and Managed still touch them):

- > ⚠️ **CORRECTION (Fable deletion sweep 2026-07-06 §3 N1 — the cited line range is WRONG and points at LIVE code).** `landing.registry` appears in `open/composer.ts` **only inside comments** (:1940, :2031). Lines **1926-2060 are the LIVE reminders + morning-brief delivery wiring** — `appWsAgentPushRegistry` (:1963-1971), `reminder_dispatcher` (:2003+), `proactiveSink` (:2036+). **DO NOT delete that range.** There are no `web:`-registry fallback code branches in Open's composer to remove; the only remaining `web:`-legacy code is the routed-sender branches in chat-bridge (:622/:652), which this unit already says to KEEP. **Rescope K11b3's composer step to a comment-truth pass only** (fix the stale `landing.registry` comments), plus the WowChannelAdapter rewire below. The real dead `registry.register(` sites all live in the already-dead bridge (`chat-bridge.ts:1203,1438,1561,1610`), removed with the bridge, not here.
- ~~Remove Open's dead legacy `web:`-delivery branches now superseded by `appWsAgentPushRegistry` (`open/composer.ts:1926-2060` ...)~~ — superseded by the correction above.
- `WowChannelAdapter` (`build-wow-dispatcher.ts:98,253,361-376`): rewire its registry-backed sends to the app-ws push (or co-delete if the wow dispatcher's web delivery is proven dead) — one dispatch-time judgment.
- **DO NOT touch** `webTopicId` (`gateway/http/web-topic-id.ts`), chat-history/topics surfaces (`open/composer.ts` `chat_history_surface`, topics) — live grammar.
- **Dispatch-time verification:** enumerate every `registry.register(` reachable in the Open composition; expected: only the /ws/chat bridge path (dead per §7.1 trace). If a live registration exists, shrink this unit to the warn-log + comment pass and flag.

**Accept:** tsc; open/__tests__ + gateway tests green; reminders fire-time delivery test (app-ws push) green; no behavior change for app-ws clients.

---

## 10. Owner decision flags

| # | Decision | Blocking |
|---|---|---|
| **D-K11-1** | `onboarding/api/start-onboarding.ts:36` (`handleStartOnboarding`, barrel-exported at `onboarding/index.ts:189-194`) calls `engine.start` — the audit's §2 lists did not name it. Grep the **Managed repo** for `handleStartOnboarding` before K11b1: co-delete if dead, else K11b1 must keep a start-shaped seam (or Managed absorbs the break at vendor-bump). | K11b1 |
| **D-K11-2** | `personality-character-suggester.ts` RETAIN correction (§4) — confirm the audit's "PARTIAL" is read as extract-only, not delete-mostly. Evidence: live wiring `open/composer.ts:127/1111/1293` + engine-slug live half. | K11a4 sign-off |
| **D-K11-3** | K11b1's Managed vendored-tenant boot acceptance **requires M0** (audit §3.1 pins M0 → K11 acceptance run). Either merge M0 first or accept a manual Managed boot check for this window. | K11b1 acceptance |
| **D-K11-4 ✅ RESOLVED→KEEP (2026-07-07)** | Machinery is LIVE (auto-resume a rate-limit-paused import, reached via the retained `pollImportRunningTick` cron; 6 live status enumerators). `import-paused-auto-resume.test.ts` survived K11b1 anchored on the retained `buildImportRunningHandler` cron seam (3/3 green) — already re-anchored, NO code change. Delete-together was the wrong branch (would kill live behavior). ORIG: `import-paused-auto-resume.test.ts` + `rate_limit_paused` machinery (`engine-import-routing.ts:866-931,1410-1476`): re-anchor (K11a6) or delete-together (audit §1.A.3 / D9 brief). **⚠️ If delete-together: same-PR paired-edit sweep of the `rate_limit_paused` status token (Fable sweep §3 N2), which a LIVE resume route + several envelopes still enumerate: `gateway/upload/import-resume-handler.ts:55` (`RESUMABLE_STATUSES`), `landing/server.ts:487`, `chat-bridge.ts:604`, `channels/adapters/app-ws/envelope.ts:554`, `history-import/types.ts:43`, `phase-prompts.ts:2042`. Removing the machinery without pruning these leaves a dangling status.** | K11a6 |
| **D-K11-5** | engine-slug managed remainder (~500-600 lines slug_chosen) stays until D-5/K4b — confirm K4b sequencing owns it and K11b1 must NOT touch it. | none (recorded) |
| **D-K11-6** | `phase-state-contract.test.ts` (K4a pin): deleting `dispatchRouterDecision` removes the router `state_delta` allow-key guard (`engine.ts:368-384`). If any phase_state key is protected ONLY by that guard, decide whether a retained chokepoint (stateStore upsert) should inherit the filter. | K11a6/K11b1 |
| **D-K11-7** | **⚠️ NEW (Fable sweep §3 N5): the main plan's "dead OAuth import sources" purge (gmail/calendar/drive/notion/slack-oauth) is owned by NO K11 sub-unit** — it was silently dropped from this exec plan. They are plausibly dead (type members + switch arms, no live payload-resolver: `import-payload-resolvers.ts` has 0 `oauth` hits, no UI/prompt offers them) but must be either (a) re-added as a sub-unit with paired edits at `engine-internals.ts:1627-1631`, `engine-import-routing.ts:1191`, `history-import/types.ts:16-20`, `oauth-calendar.ts`, or (b) explicitly deferred out of K11. Decide before K11b1 closes. | K11b1 |
| **K11-F1** | **NEW follow-up unit (Fable adjudication 2026-07-06, filed at K11b0 merge). Wire Connect engagement mode into the live app-ws dispatch — OR retire the setting.** The `tag_gated` gate (persist-inert on a non-mention post, no agent turn) is enforced ONLY in the dead bridge (`chat-bridge.ts:2152-2206`, sole caller of `resolveEngagement`); the live app-ws ingress (`app-ws-surface.ts:611-617` WS, `:797-804` HTTP) dispatches unconditionally and reads no engagement mode. **This is a PRE-EXISTING gap on main (independent of K11b0), and it is user-reachable today:** a user can set `tag_gated` via the agent's `set_engagement_mode` tool (`cores/free/agent-settings/src/tools.ts:292-309`) or raw PATCH (`app-projects-surface.ts:498-499`) and the agent still replies to every message. Fix = at the app-ws inbound seam (project_id known, before `dispatchInbound`): read `agent_engagement_mode` (the SELECT the excised `build-landing-stack.ts:1376-1389` used, migration 0088) → `resolveEngagement` (`connect/agent-engagement.ts:170`) → on `!engage` persist via `buttonStore.persistInertUserTurn` (`channels/button-store.ts:314`) + ack without a turn; port the deleted `chat-bridge-engagement-mode.test.ts` assertions onto `createAppWsSurface`. **Bundle the vestigial `runWithActiveProject` cleanup:** post-K11b1 that ambient frame has ZERO production binders (sole binder was dead `chat-bridge.ts:1606`); either bind it around `chat_command_filter.match`+`dispatchInbound` on both app-ws paths, or delete `active-project-context.ts` and thread `projectId` explicitly. **NOT a live security gap** — `CoreCredentialResolver` falls back to global scope on an empty frame (`core-credential-resolver.ts:100-118`), and every chat-command-reachable service (cal/email/reminders/research) is global-scoped or resolver-less; only the `google_workspace` MCP core is project-scoped and it is not a chat command. | none (post-K11b1, non-blocking) |

## 11. STATUS/plan bookkeeping on completion

Tick §K11 in `docs/plans/2026-07-02-world-class-refactor-plan.md` as K11a1-a6/K11b1-b3; record in `refactor-orchestration-STATUS.md` that K11's merge unblocks the audit-pinned chain **K11 → L1 → L2 → L3 → C1** (audit §3.2) and shrinks D9a-d's engine.ts ranges (all D9 anchors must be re-grepped post-K11b1, audit §3.5).
