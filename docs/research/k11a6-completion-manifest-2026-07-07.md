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

## 3. K11a5-pinned survivors (list D) resolved

(appended as decided)

## 4. In-package dying suites (plan §7.4 cohort) — verified drive-harness DIEs

(appended as verified)

## 5. Comment-only grep hits neutralized (survivor files, no behavior change)

(appended as done)
