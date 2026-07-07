# K11a6-completion (PR-A) — DIE MANIFEST + per-file judgments — 2026-07-07

**Unit:** K11a6-completion, the deferred list-(B) integration-test re-anchoring that gates K11b1
(plan `docs/plans/2026-07-05-k11-execution-plan.md` §6 + 2026-07-06 Fable addendum).
**Rule of record:** K8 coverage-loss rule — a DIE classification is legal ONLY with a citation of
where every retained sub-behavior it pins is covered by a surviving test. RE-ANCHOR must be
additive (dying half preserved byte-intact in `*.die.test.ts`, co-deletes in K11b1).

**This document is the authoritative list of test files PR-B (K11b1) co-deletes.**
Acceptance contract: after this PR, every remaining `engine.start(`/`engine.advance(`/
`engine.consumeChoice(` hit in `*.test.ts` is in a file listed in §2/§3/§4 below.

Judgments are appended one commit per file as they are made (session-resumable protocol).

**New survivor tests added by this unit (additive, engine-free, pass at HEAD and post-K11b1):**
- `onboarding/interview/__tests__/validate-agent-name.test.ts` — retained canonical validator direct pin
- `onboarding/interview/__tests__/max-oauth-offered-prompt-spec.test.ts` — retained STATIC copy + builder branches
- `onboarding/interview/__tests__/onboarding-envelope-timezone-rule.test.ts` — live envelope never-ask-timezone rule
- `gateway/realmode-composer/__tests__/wow-channel-adapter-undelivered.test.ts` — retained emitPrompt/sendText undelivered contract

**PR-B (K11b1) operational summary:** delete every file marked DIE in §1/§2/§3/§4 below, plus the
fixture `tests/fixtures/m2/mira-conversational-tangents.json`; do NOT touch
`path1-solicited-upload-starts-job.test.ts` (§4b survivor) or any file in §5. If a §4b coverage
citation names a test that PR-B's final tree also deletes, re-run this manifest's check for that
row (none known at write time — every citation was verified engine-free at HEAD).

---

## 1. Per-file judgments (lists A + D — adjudicated in this unit)

### `tests/integration/button-idempotency.test.ts` — DIE
Pins `engine.start`'s delivery-idempotency contract (`was_new || !was_delivered` send gate +
`markDelivered` + transcript dedup) — engine-start-internal, deleted with the drive. Already
adjudicated DIE by #238 (Codex r2 explicitly REVERTED a ButtonStore re-anchor as a homemade-gate
reimplementation). Retained ButtonStore primitive coverage verified present at HEAD:
`channels/__tests__/button-store.test.ts` — ":51 same key collapses to a single row", ":102
was_delivered false on fresh emit", ":108 was_delivered true after markDelivered + survives
idempotent re-emit", ":186 markDelivered is idempotent". Byte-unchanged; co-deletes in K11b1.

### `tests/integration/engine-blank-chat-on-reconnect-bug1.test.ts` — DIE
Pins `engine.start()`-internal re-emit-gate semantics (ephemeral-channel re-emit on every
session-open, delivered_at set-once, telegram `undelivered || topic_id_changed` gating) —
adjudicated DIE in #238. NOTE (citation refresh): #238 cited the retained
`resumeCookieSession → reEmitActiveSeedPromptIfAny` analog in `gateway/http/__tests__/
chat-bridge.test.ts`; K11b0 (#240) has since deleted that whole bridge surface AS DEAD, so the
analog itself is gone by design. The PROD reconnect re-emit seam is the composer's
`on_session_open` path, pinned by `tests/integration/import-watch-rearm-on-reconnect.open.test.ts`
(re-arm + seed) and `gateway/http/__tests__/replay-redelivery.test.ts` (app-ws redelivery).
Byte-unchanged; co-deletes in K11b1.

### `tests/integration/engine-reemit-pending-inbound-race-bug2.test.ts` — DIE
Pins the `PENDING_INBOUND_WINDOW` / `recordInboundReceived` race gate inside `engine.start()` —
engine-drive-internal with no retained non-engine analog (#238 adjudication; the inbound feeding
path was the ChatBridge `handleInbound`, itself deleted dead in K11b0 #240). Prod app-ws
reconnect delivery covered as per bug1 above. Byte-unchanged; co-deletes in K11b1.

### `tests/integration/persona-v2-flow.test.ts` — DIE
Drives `projects_proposed → persona_synthesizing → persona_reviewed` via `engine.advance` with a
real `PersonaComposer`. The retained pins (phase_state → `buildComposeInput` → compose mapping;
SOUL.md/USER.md/priority-map content + H1 preservation) were ported in #239 to
`onboarding/interview/__tests__/persona-finalize-compose-input.test.ts`, which drives the LIVE
Path-1 finalize wiring (`build-onboarding-finalize.ts:453`) engine-free. The remaining
assertions (phase-machine transit + `stripPersonaFileH1` at the drive's render boundary) are
drive-exclusive. Byte-unchanged; co-deletes in K11b1.

### `tests/integration/persona-reviewed-advance.test.ts` — DIE
Pins the `looks_good` consumeChoice dispatch → `advanceFromPersonaReviewed` →
`max_oauth_offered` routing (+ `persona_files_committed`). `advanceFromPersonaReviewed` lives in
retained-but-dead `engine-persona.ts:1030`, reached ONLY from the deleted consumeChoice dispatch
(engine.ts:9265 wrapper) — owner addendum classifies that half retained-but-dead → K11d.
Retained coverage: the `persona_reviewed → max_oauth_offered` transition legality is pinned
engine-free by `onboarding/interview/__tests__/phase-transition-table.test.ts:66`; the LIVE
persona compose/commit path by `persona-finalize-compose-input.test.ts` +
`gateway/realmode-composer/__tests__/build-onboarding-finalize.test.ts`. Byte-unchanged;
co-deletes in K11b1.

### `tests/integration/personality-offered-single-handler.test.ts` — DIE
Pins verbatim `agent_personality` capture + `personaSync.recordAgentPersonality` mirror via the
drive, plus §7.1 archetype-blend derivation at synthesis. #239 ported the retained §7.1 pins
(free-text `deriveArchetypeBlend` branch + SOUL.md voice shaping) into
`persona-finalize-compose-input.test.ts` (live finalize seam). The capture/mirror turns are
consumeChoice-dispatch behavior (dead). Byte-unchanged; co-deletes in K11b1.

### `tests/integration/personality-name-slug-projects-flow.open.test.ts` — DIE (+ additive survivor)
857-line walk of `personality_offered → agent_name_chosen → slug_chosen → projects_proposed` via
`engine.start`/`advance` — the conversational drive + consumeChoice cascade + engine slug
resolver + `mergeAdvanceProjectsAdditively`, all deleted or retained-but-dead (owner addendum).
Retained-LIVE sub-behaviors and their surviving coverage:
- `validateAgentName` (RETAINED `phase-prompts.ts:1313`) full contract: previously pinned only
  through dying drive tests → **new additive survivor
  `onboarding/interview/__tests__/validate-agent-name.test.ts`** (this unit) pins it directly
  (length floor/cap, Unicode charset + letter-first, punctuation rejection reason, reserved set
  case-insensitivity); the retained consumer filter also pinned by
  `agent-name-chosen-prompt-spec.test.ts`.
- live slug seam (`slugAvailability.check`/`sanitize` on LocalPlatformAdapter over retained
  `runtime/slug-grammar.ts`): pinned by surviving
  `tests/integration/local-platform-adapter-boot.open.test.ts:124-148`. The collision-NNN
  multi-suggestion ALGORITHM asserted here is the engine slug resolver (dead-with-drive).
- projects list rendering builder (`buildProjectsProposedPromptSpec`, retained): builder-level
  coverage in the dying suites only for drive shapes; prod project confirmation runs through the
  composer/import path (post-turn extractor + finalize), pinned by
  `post-turn-extractor*.test.ts` + `build-onboarding-finalize.test.ts`.
Byte-unchanged; co-deletes in K11b1 (drop its `m2-walkthrough-test-helpers.ts` import with it).

### `tests/integration/import-analysis-presented-freeform-routing.test.ts` — DIE (pre-headered)
Already split out by K11-pre (#229) with a `⚠️ DIES WITH K11b1` header: pins
`engine.advance({freeform_text}) → llmRouter.route → dispatchRouterDecision →
consumeImportAnalysisPresentedChoice` corrections routing. The surviving body-shape + themes
assertions were re-anchored into `tests/integration/import-analysis-presented.test.ts`
(pollImportRunningTick seam, #229/#237). `consumeImportAnalysisPresentedChoice` is
retained-but-dead per the owner addendum (K11d prune). Byte-unchanged; co-deletes in K11b1.

## 2. List C — pure-drive DIE, verified + coverage-cited (co-delete in K11b1)

### `tests/integration/conversational-onboarding-end-to-end.test.ts` — DIE
Verified pure-drive: every assertion exercises the `phaseSpecResolver`+`llmRouter` pair through
the REAL engine drive (`engine.start`/`advance` × 7) — free-text prompt emission, router
acknowledgment bubbles, router `state_delta` → `phase_state`, recent-turns consult. All of that
is the conversational drive + router + `dispatchRouterDecision` + the `state_delta` allow-key
guard, ALL deleted by K11b1 (§7.2/§7.3). Retained sub-behaviors covered elsewhere:
- prompt body copy / resolver: `onboarding/interview/__tests__/phase-spec-resolver.test.ts`,
  `phase-prompts-no-leak.test.ts`, `phase-prompts-no-30-seconds.test.ts` (no drive calls).
- the PROD replacement for "LLM-driven conversational onboarding" (composer live-agent turn):
  `open/__tests__/onboarding-warm-conversational.test.ts` (warm cc-llm session + pre-warm) and
  field extraction via `onboarding/interview/__tests__/post-turn-extractor.test.ts` +
  `post-turn-extractor-removed-projects.test.ts` (the retained extraction seam that replaced
  router `state_delta` in prod).

### `tests/integration/m2-mira-v3-conversational-fixture.test.ts` — DIE
Verified pure-drive: boots a real `InterviewEngine` + fixture-fed `LlmRouter`, walks
`tests/fixtures/m2/mira-conversational-tangents.json` via `engine.advance` per phase; asserts
phase advancement, `state_fields_populated`, and router actions — the conversational drive +
router, both deleted (§7.2/§7.3). The headline "brief incident" assertion (router `answer` ≠
`advance` at `import_upload_pending`) IS router behavior — dead. Retained sub-behavior coverage:
- PHASE_KNOWLEDGE pack content (retained via K11a2b move into `phase-spec-resolver.ts`):
  `onboarding/interview/__tests__/phase-knowledge.test.ts` retained (non-router) half.
- import upload/analysis progression in prod: re-anchored `tests/integration/
  import-analysis-presented.test.ts`, `import-resume-button.test.ts` (#237) drive
  `notifyImportUpload`/`pollImportRunningTick`, both RETAINED.
The fixture JSON `tests/fixtures/m2/mira-conversational-tangents.json` co-deletes (PR-B note).

### `tests/integration/m2-mira-v3-tangent-coverage.test.ts` — DIE
Verified pure-drive: auto-generates one test per `PHASE_KNOWLEDGE[phase].expected_tangents`
entry, boots the engine at each phase, stubs the router with the pack's `expected_action`, fires
`engine.advance`, asserts no-phase-advance + router-consulted-once + S2-r2 `state_delta`
whitelist survival. Router consult (`shouldConsultRouter`), `dispatchRouterDecision`, and the
`state_delta` allow-key guard (engine.ts:368-384) are ALL K11b1 deletions — the whole assertion
surface is the dead drive. Retained sub-behavior coverage:
- pack integrity sentinel (`totalTangentTests ≥ 50` guarding PHASE_KNOWLEDGE content): pack
  content is retained via K11a2b in `phase-spec-resolver.ts`; content shape covered by
  `onboarding/interview/__tests__/phase-knowledge.test.ts` retained half. (If PR-B finds the
  pack-emptiness sentinel is ONLY here, port that one module-level sentinel into
  phase-knowledge.test.ts at delete time — it needs no engine.)

### `tests/integration/onboarding-resume-on-reconnect.test.ts` — DIE
Verified pure-drive: 9 `engine.advance` calls; pins the 24h-gap welcome-back resume drive
(`engine.advance` gap detection → resume ButtonPrompt → `[A] Continue` consumeChoice →
personality_offered → agent_name_chosen). The resume/gap-fill conversational drive is deleted
(§7.2) and its cron twin (§7.6) is verified dead-configured in prod (Fable sweep §1: no live
composer passes `onboarding_resume_cron`). Retained sub-behavior coverage:
- transcript JSONL append-only across restart: `TranscriptWriter` pinned by surviving
  `tests/integration/m2-single-source-import.test.ts` + `upload-roundtrip-web.test.ts`.
- PROD reconnect behavior (composer `on_session_open` re-emit/seed, which replaced the engine
  resume): `tests/integration/import-watch-rearm-on-reconnect.open.test.ts` + the re-anchored
  reconnect tests from #238 (`engine-blank-chat-on-reconnect-bug1`, re-anchored this unit).

### `tests/integration/onboarding-resume-cron.test.ts` — DIE
(plan list-C member; acceptance-grep hit is a doc comment `engine.advance(...)` at :9, plus it
constructs the resume cron itself.) Pins `resume-cron.ts` behavior end-to-end: stale-row sweep →
proactive welcome-back emit → `resume_active_prompt_id` idempotency → terminal-phase exclusion,
plus the `last_advanced_at` freshness contract that only the cron reads. `resume-cron.ts` is
deleted whole (§7.6, Fable sweep VERIFIED-DEAD: `onboarding_resume_cron` config passed by
nobody). No retained reader of onboarding `last_advanced_at` staleness survives — nothing to
port. Co-deletes with `resume-cron.ts` in K11b1.

### `tests/integration/button-primitive-phase-walk.die.test.ts` — DIE (already split)
Pre-existing die-half from the #238 SPLIT of `button-primitive-cross-channel.test.ts`; header
already carries the `// DIES WITH K11b1` contract. Retained half (button-primitive / adapter /
router grammar) already re-anchored and surviving in `button-primitive-cross-channel.test.ts`.
Byte-unchanged this unit.

### `tests/integration/m2-walkthrough-test-helpers.ts` — DIE (helper, co-delete)
Not a test; drive-walk helper. Importers at HEAD: `conversational-onboarding-end-to-end`,
`m2-mira-v3-conversational-fixture`, `m2-mira-v3-tangent-coverage`, `m2-soren-v2-fixture.open`
(all DIE, above/§4), `onboarding/interview/__tests__/interview-testkit.ts` (§7.4 triage cohort),
and the two list-A files re-anchored this unit (`import-analysis-presented-freeform-routing`,
`personality-name-slug-projects-flow.open`) whose surviving halves no longer import it. After
PR-B deletes the cohort it has zero importers. No retained behavior of its own.

## 3. K11a5-pinned survivors (list D) resolved

### `onboarding/interview/__tests__/open-mode-phase-walk.test.ts` — DIE
Every assertion is reached through `engine.start`/`engine.advance` walks (open + managed), i.e.
the conversational drive K11b1 deletes. The pinned behaviors and their survivability:
- **Open route topology (cut phases never entered / kept phases entered):** the WALK is the dead
  drive. The retained transition-table + AUTO_SKIP_PHASES invariants are pinned engine-free by
  `onboarding/interview/__tests__/phase-transition-table.test.ts` (#239 split survivor).
- **Open-mode onboarding progression in PROD** runs through the composer (`appWsChatTurn` +
  `on_session_open` + post-turn extractor), NOT this walk — covered by
  `open/__tests__/onboarding-warm-conversational.test.ts`, `post-turn-extractor.test.ts` +
  `post-turn-extractor-removed-projects.test.ts`, and the reconnect/on_session_open suites
  (`tests/integration/import-watch-rearm-on-reconnect.open.test.ts`).
- **max_oauth_offered local setup-token affordance + OpenAI-key rejection + SecretsStore
  persist:** the engine handler (`engine.ts` `persistSetupTokenAndAdvance` :8939, OpenAI guard
  :8954-8968) is a private helper reachable ONLY from the deleted drive → orphaned, dies with
  §7.2. The PROD open setup-token capture is `open/install-token-handoff.ts`
  (`SETUP_TOKEN_RE` :46 rejects non-`sk-ant-oat` pastes) + the landing paste page — pinned by
  `open/__tests__/install-token-handoff.test.ts`,
  `tests/integration/sprint23-paste-token-handoff.open.test.ts`,
  `tests/integration/install-auth-gate.test.ts`.
- **Managed slug derivation (`agent_name_chosen` → `slug_chosen` + `suggested_slug`):** Managed
  provisions Open boxes and never drives the engine in prod (plan §6 addendum) — drive-exclusive.
Owner adjudication of record (plan §6 addendum, 2026-07-06): "K11a5's two 'byte-unmodified'
pinned tests BOTH DIE — that pin was an as-built move-integrity check for the pre-K11b1 tree,
never a forward-compat guarantee across K11b1." Byte-unchanged this unit; co-deletes in K11b1.

### `onboarding/interview/__tests__/engine-agent-name-suggestion-wiring.test.ts` — DIE
All 10 tests harness `engine.advance` (8 call sites) to reach the agent-name suggestion render/
consume machinery. Survivability of the pinned behavior:
- The memoize/source-guard/re-roll wiring lives in RETAINED-BUT-DEAD `engine-agent-name.ts`
  (`getOrStartAgentNameSuggestions` :405, `consumeAgentNameChosenChoice` :54): owner decision
  (plan §6 addendum) — "its 'live open half' liveness held only within the dead phase machine;
  leave it retained-but-dead in K11b1; prune in K11d." It is scheduled dead code, NOT retained
  live behavior; keeping a drive-shaped pin (or re-anchoring one onto it) would obstruct the
  K11d prune while protecting nothing prod-reachable. Deliberately un-pinned per that decision.
- **Genuinely retained-LIVE sub-behaviors are covered engine-free:**
  - `agent-name-suggester.ts` (Managed ABI, retained): `buildDiverseAgentNameFallback`,
    `STATIC_AGENT_NAME_FALLBACK`, generation contract →
    `onboarding/interview/__tests__/agent-name-suggester.test.ts` (zero engine calls).
  - `buildAgentNameChosenPromptSpec` button rendering (name buttons, rationale-tail strip,
    reserved/short-name filtering, freeform-on) →
    `onboarding/interview/__tests__/agent-name-chosen-prompt-spec.test.ts` (zero engine calls).
Byte-unchanged this unit; co-deletes in K11b1.

## 4. In-package dying suites (plan §7.4 cohort) — verified drive-harness DIEs

### 4a. Adjudicated by the plan / prior merged PRs (citation of record per file)

| file | DIE basis + retained-coverage citation |
|---|---|
| `onboarding/interview/__tests__/buttons-only-safety-net.test.ts` | plan §7.4 die list (interaction-mode safety net = drive routing) |
| `onboarding/interview/__tests__/engine-router-integration.test.ts` | plan §7.4 (router↔engine integration = deleted pair) |
| `onboarding/interview/__tests__/interaction-mode-routing.test.ts` | plan §7.4 (interaction-mode.ts remainder deleted §7.4; its 3 live exports were extracted in K11a3) |
| `onboarding/interview/__tests__/interaction-mode-substep-router-bypass.test.ts` | plan §7.4 |
| `onboarding/interview/__tests__/gap1-additive-confirm-merge.test.ts` | plan §7.4 (gap-fill router merge = drive) |
| `onboarding/interview/__tests__/gap1-live-import-analysis-merge.test.ts` | plan §7.4 (same family; drives via post-turn-extractor + engine seams — PR-B dispatch re-check) |
| `onboarding/interview/__tests__/projects-proposed-ignore-removal.test.ts` | plan §7.4 |
| `onboarding/interview/__tests__/projects-proposed-prod-union-merge.test.ts` | plan §7.4 |
| `onboarding/interview/__tests__/signup-router-prod-path.test.ts` | plan §7.4 |
| `onboarding/interview/__tests__/v2-phase-walk.test.ts` | plan §7.4; retained transition-table/AUTO_SKIP invariants ALREADY split out engine-free to `phase-transition-table.test.ts` (#239 Task 2) — remaining content is the pure phase WALK |
| `onboarding/interview/__tests__/work-interview-projects-extraction-real-path.test.ts` | plan §7.4 (router extraction real-path) |
| `gateway/realmode-composer/__tests__/llm-router-composer.test.ts` | plan §7.3/§7.4 (composer llm-router wiring dies with `buildGatewayLlmRouter` husk; THE live client `buildGatewayAnthropicMessagesClient` extracted in K11a2 with its own coverage) |
| `onboarding/interview/__tests__/engine-reconnect-reemit-unresolved.test.ts` | #238 adjudication: pins `engine.start`'s live unresolved-active-prompt reconnect re-send; retained analog (bridge resumeCookieSession) was itself deleted-as-dead in K11b0 #240; prod reconnect = composer `on_session_open` (`import-watch-rearm-on-reconnect.open.test.ts`) |
| `onboarding/interview/__tests__/persona-synthesizing.test.ts` | #239 Task 1: retained pin (test 2, buildComposeInput mapping) ported to `persona-finalize-compose-input.test.ts`; rest is drive transit |
| `onboarding/interview/__tests__/final-handoff-skip-button.test.ts` | #239 Task 3: whole final-handoff family GENUINELY-DEAD (emitFinalHandoffPrompt + buildFinalHandoff* invoked only inside engine.ts); prod finalize handoff covered by `build-onboarding-finalize.test.ts:510-570`. The other 8 final-handoff files + `final-handoff-test-helpers.ts` co-delete too (no drive-grep hits — helper-mediated) |
| `onboarding/interview/__tests__/engine-llm-resolver-start-static-seed.die.test.ts` | pre-split .die file (K11a6): engine.start's static idempotency-seed race — EXCLUSIVE to the deleted start(); header carries the no-retained-equivalent proof |
| `onboarding/interview/__tests__/source-switch-intent-write.die.test.ts` | pre-split .die file (K11a3): intent WRITE/CLEAR via dying advance/normalAdvance; retained arbitration READ half re-anchored in `source-switch-late-upload-race.test.ts` |
| `tests/integration/m2-soren-v2-fixture.open.test.ts` | plan §6 list C (fixture walk; drives the engine via `m2-walkthrough-test-helpers.ts:164` engine.advance — helper-mediated, hence absent from the direct grep) |
| `onboarding/interview/__tests__/interview-testkit.ts` + `tests/integration/m2-walkthrough-test-helpers.ts` | drive-walk helpers; die when their dying importers die (§7.4 "triage, don't bulk-delete" honored: every importer is dispositioned on this manifest) |

Additional §7.3/§7.4 co-deletes that do NOT hit the drive-grep (router/fixture-direct suites, listed for PR-B completeness): `onboarding/interview/llm-router.test.ts`, `onboarding/interview/__tests__/llm-router-decision.test.ts`, `onboarding/interview/__tests__/fixture-anthropic-client.test.ts`, `onboarding/interview/__tests__/interaction-mode.test.ts`, `onboarding/interview/__tests__/phase-knowledge-router-wiring.test.ts` (the router half was ALREADY split out by K11a2 — `phase-knowledge.test.ts` itself is a pure pack-content SURVIVOR, do NOT delete it), `gateway/__tests__/llm-router-persona-wiring.test.ts`, `onboarding/telemetry/__tests__/router-decision-events.test.ts`, `onboarding/interview/__tests__/signup-asks-name.test.ts` (per-§7.4 dispatch triage: signup prompt copy retained via STATIC_PHASE_SPECS/phase-prompts tests), tests named in §7.6 (resume-cron pair, §2 above).

### 4b. Adjudicated this unit (families not covered by plan/PR citations)

**wow family:**
| file | judgment |
|---|---|
| `onboarding/interview/__tests__/wow-fired.test.ts` | DIE — drive-internal `dispatchWowAndAdvance`/`consumeWowFallbackChoice` pins; its engine-free STATIC_PHASE_SPECS['wow_fired'] no-leak test covered by `phase-prompts-no-leak.test.ts:41,58` (loops every spec); legacy-copy guard ported to `max-oauth-offered-prompt-spec.test.ts` (this unit) |
| `onboarding/interview/__tests__/wow-fired-hang-resilience.test.ts` | DIE — ActionRunner per-action timeout (the retained-live half) covered by `onboarding/wow-moment/__tests__/action-runner.test.ts:131,152`; engine best-effort completion policy is drive-internal |
| `gateway/__tests__/wow-fired-push-integration.test.ts` | DIE — all pins are the engine↔push wiring inside `dispatchWowAndAdvance` (engine.ts ~4741-4760) + start() crash-resume; the retained push-emitter contract (raw topic_id → project_id resolution, skip-no-devices, single dispatch, error propagation) fully covered by `gateway/__tests__/wow-push-emitter.test.ts` |
| `gateway/realmode-composer/__tests__/wow-fired-composer.test.ts` | **DIE after SPLIT (this unit)** — serialize-via-probe covered by `wow-fired-serialize.test.ts:97,200,247`; action-07 cron registration by `tests/integration/wow-moment-fires.test.ts:269` + `cron/scheduler.test.ts`; sendText WS-absent by `open/__tests__/wow-brief-history-persist.test.ts:183`. The ONE uncovered retained-live pin — `WowChannelAdapter.emitPrompt` WS-absent peek-BEFORE-persist throw + no-dead-`button_prompts`-row (`build-wow-dispatcher.ts:405-408`, its Test 9) — ported to **new survivor `gateway/realmode-composer/__tests__/wow-channel-adapter-undelivered.test.ts`** (+ mid-send-race + happy-path + sendText parity). PR-B dispatch note: the composer default-builds `wowDispatcher`/resolution-probe assertions (its Test 1 Phase A / Test 8) pin wiring consumed ONLY by the dying `dispatchWowAndAdvance` — if K11b1 orphans `deps.wowDispatcher`, that wiring is K11d material; deliberately not re-pinned |

**max-oauth family** (all three DIE after the SPLIT this unit — the retained-live prompt-spec/builder pins lived engine-free INSIDE the dying files and are ported verbatim to **new survivor `onboarding/interview/__tests__/max-oauth-offered-prompt-spec.test.ts`**: STATIC single-CTA exact body + `Connect Claude Max` option label + no-API-key/skip/free-tier copy, substrate-aware Shape-1 bodies (claude-ack / chatgpt / null), rejection-stitching, `awaiting_byo_paste` Skip escape hatch, wow_fired legacy-copy guard — `phase-spec-resolver.test.ts:105,245,931-968` pins routing metadata but stubs bodies):
| file | judgment |
|---|---|
| `onboarding/interview/__tests__/max-oauth-offered.test.ts` | DIE — routing tests 3-6/8-9/11 are `consumeMaxOauthChoice` (engine.ts:8591) + private helpers, reachable ONLY from deleted `consumeChoice` (dispatch engine.ts:4040); retained copy/builder pins ported (above) |
| `onboarding/interview/__tests__/phase-max-oauth-offered-auto-skip.test.ts` | DIE — copy/builder pins ported (above); the auto-skip describes exercise `maybeAutoAdvancePastMaxOauthOffered` (engine-agent-name.ts:499-544), which is retained-but-DEAD per the owner addendum (K11d prune; its only retained caller is `emitCurrentPhasePrompt` engine.ts:1841, never reached at this phase in prod) — deliberately not re-pinned, same ruling as `engine-agent-name-suggestion-wiring` (§3) |
| `onboarding/interview/__tests__/phase-max-oauth-offered-transition-autoskip.test.ts` | DIE — pins `advanceFromPersonaReviewed`'s transition-time auto-skip call (engine-persona.ts:1073, reached only via consumeChoice → dies) into the same retained-but-dead callee; identity-bridge behavior falls under the K11d ruling above |

**engine-core / signup family:**
| file | judgment |
|---|---|
| `onboarding/interview/__tests__/engine-skeleton.test.ts` | DIE — start/advance idempotency, retry, crash-recovery, race orchestration: all drive-internal; STATIC_PHASE_SPECS consumed tautologically |
| `onboarding/interview/__tests__/engine-multi-turn-signup.test.ts` | DIE — signup walk drive-internal; the retained name-extraction heuristic (also reached by LIVE `post-turn-extractor.ts:368`) covered engine-free by `extract-agent-name.test.ts` + `extracted-fields-sanitize.test.ts` |
| `onboarding/interview/__tests__/engine-advance-choice-parity.test.ts` | DIE — advance→consumeChoice parity port (its own header); per-user isolation exercised only through the drive |
| `onboarding/interview/__tests__/signup-asks-name.test.ts` | DIE (per §7.4 "triage, don't bulk-delete" — triaged here) — capture heuristics covered by `extract-agent-name.test.ts`/`extracted-fields-sanitize.test.ts`; llmRouter backfill dies with the router; `recordUserFirstName` hook has no non-engine caller (dead) |
| `onboarding/interview/__tests__/option-numbered-pick.test.ts` | DIE — `parseBareOptionNumber` (engine-internals.ts:1553) callers are engine-agent-name.ts:104 (retained-but-dead) + engine-persona.ts:193 (consumeChoice route, dies) → function is dead post-K11b1, no coverage owed |
| `onboarding/interview/__tests__/timezone-autoskip.test.ts` | **DIE after SPLIT (this unit)** — `engine.start` `?tz=` capture + `sanitizeBrowserTimezone` (engine-internals.ts:1500, sole caller engine.ts:1353 = start) die; the LIVE timezone mechanism is `instance_metadata.timezone` (covered by `app-focus-current-surface-timezone.test.ts`, unrelated path). Its SOLE retained-live pin — the live envelope's never-ask-timezone rule (`skills/_envelope.md`, loaded by `gateway/http/app-ws-surface.ts` + `landing/chat-react/controller.ts`) — ported verbatim to **new survivor `onboarding/interview/__tests__/onboarding-envelope-timezone-rule.test.ts`** |
| `onboarding/interview/__tests__/onboarding-to-general-handoff.test.ts` | DIE — engine handoff orchestration drive-internal; retained `buildOnboardingHandoffHook`/`defaultProjectIdSlugifier` (live: `build-landing-stack.ts:1038`, `build-onboarding-finalize.ts:76`) covered engine-free by `build-onboarding-handoff.test.ts` + `onboarding-handoff-content-aware-seeds.test.ts`; live completion analog by `build-onboarding-finalize.test.ts:510-562` |
| `onboarding/interview/__tests__/engine-slug-history-fallback.test.ts` | DIE — lazy-rekey-on-`start` is engine.start-internal; part of the retained-but-dead engine-slug open half (no coverage owed) |
| `onboarding/interview/__tests__/slug-chosen.test.ts` | DIE — consumeChoice slug-rename branch + start auto-confirm guards (engine-slug open half, retained-but-dead); retained slug prompt spec covered engine-free by `slug-chosen-prompt-spec.test.ts`; live rename runtime is `runtime/slug-picker-*` (own tests) |
| `onboarding/interview/__tests__/shells-created-no-filter.test.ts` | DIE — `buildWowSignalsFromState` is a PRIVATE engine method (engine.ts:5008, sole call engine.ts:4771 in the dying wow-fire path); the LIVE shell-creation contract (freeform-added kept, declined honored, confirmed-wins, import union/cap) covered by `build-onboarding-finalize.test.ts:309-508` |

**import/personality leftovers:**
| file | judgment |
|---|---|
| `onboarding/interview/__tests__/path1-solicited-upload-starts-job.test.ts` | **SURVIVOR — NOT a co-delete.** Drives ONLY retained `notifyImportUpload` (zero drive calls; the grep hit was a doc comment, reworded this unit). It IS the finest-grained retained coverage of the solicited-upload job-start gate (`importAffordanceOffered`, #130 seed-then-start, managed/affordance-off no-ops, concurrency guards). PR-B must NOT delete it |
| `onboarding/interview/__tests__/projects-proposed-share-freeform-cache-bust.test.ts` | DIE — share-freeform cache-invalidation ordering (engine.ts:5095-5099) + `splitFreeformProjectList` (engine.ts:9648) are drive-private; retained projects_proposed builder covered by sibling `projects-proposed-zero-state`/`single-cta` builder tests |
| `onboarding/interview/__tests__/personality-offered-legacy-buttons.test.ts` | DIE — legacy no-suggester branch of `consumePersonalityOfferedChoice` (drive); live suggester flow covered engine-free by `personality-character-suggester.test.ts` + `personality-offered-character-buttons.test.ts` |
| `onboarding/interview/__tests__/personality-offered-suggester-wiring.test.ts` | DIE — engine-side memoize wiring lives in retained-but-dead `getOrStartCharacterSuggestions` (engine.ts:8378 → engine-agent-name.ts:330; K11d); the LIVE character suggester (wired `open/composer.ts:1113` + preamble) covered engine-free by `personality-character-suggester.test.ts` (incl. memo readers) + `personality-offered-character-buttons.test.ts` (render + index parse + byte cap) + `onboarding-preamble.test.ts` |
| `onboarding/interview/__tests__/phase-state-router-whitelist.test.ts` | DIE — `ROUTER_AMEND_ALLOWED_KEYS`/`whitelistRouterStateDelta` are co-deleted WITH `dispatchRouterDecision` (behavior removed wholesale, D-K11-6; its own header says so) — no coverage owed |
| `onboarding/interview/__tests__/interaction-mode-substep-routing.test.ts` | DIE — `resolveInteractionMode` sub_step awareness + `BUTTONS_ONLY_NUDGE_TEXT` live in the deleted interaction-mode.ts remainder; the one retained-live behavior it touches (import-running status re-poll `pollImportRunningAndAdvance`) covered by `import-running-cron-tick.test.ts` via the retained cron |

## 5. Comment-only grep hits neutralized (survivor files, no behavior change)

Four SURVIVOR files carried doc-comment references matching the acceptance pattern
(`engine.start(`/`engine.advance(` inside historical NOTEs). Comments reworded (no code change,
tests re-run green) so the acceptance grep returns only DIE-manifest files:
- `tests/integration/import-analysis-presented.test.ts` (:23, :35)
- `tests/integration/import-failed-routes-to-analysis-presented.test.ts` (:198)
- `tests/integration/import-resume-button.test.ts` (:250)
- `tests/integration/nd2-real-export-path1-import-runs.test.ts` (:131)
- `onboarding/interview/__tests__/path1-solicited-upload-starts-job.test.ts` (:177 — SURVIVOR, see §4b)

Also verified done (no action needed):
- `onboarding/interview/__tests__/source-switch-late-upload-race.test.ts` — K11a3 race-half
  re-anchor complete (seeded state + `notifyImportUpload` arbitration; intent WRITE path
  preserved in `source-switch-intent-write.die.test.ts`). Zero drive calls.
- `onboarding/interview/__tests__/phase-state-contract.test.ts` — K4a RouterDecision narrowing
  complete (#236): router `state_delta`-guard assertions removed (header :26-27 documents it),
  key-contract assertions retained, zero drive calls / no llm-router import.
