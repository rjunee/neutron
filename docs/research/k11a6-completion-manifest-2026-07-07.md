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

---

## 1. Per-file judgments (lists A + D — adjudicated in this unit)

(appended as decided)

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

(appended as verified)

## 5. Comment-only grep hits neutralized (survivor files, no behavior change)

(appended as done)
