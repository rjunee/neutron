/**
 * onboarding-opening-fix (2026-06-19) — BUG 1 regression test, PROD PATH.
 *
 * The live go-live blocker: signup double-asked the user's name. A bare
 * typed name ("Ryan") never advanced off signup.
 *
 * Why the existing suites missed it:
 *   - `signup-asks-name.test.ts` wires `promptDriver: makeFallbackDriver()`
 *     and NO `llmRouter`/`phaseSpecResolver`. That exercises the
 *     `consumeChoice` name-guard path — the OPPOSITE of production, which
 *     wires `phaseSpecResolver` + `llmRouter` (its `decideNextPhase` is
 *     prod-dead).
 *   - `engine-router-integration.test.ts` hits the router path but STUBS
 *     the decision (`stubRouter([{action:'advance', ...}])`), so it never
 *     tests that a bare name CLASSIFIES correctly, nor that a non-`advance`
 *     classification still advances signup.
 *
 * This suite wires the PROD path: a REAL `LlmRouter` (built via
 * `buildLlmRouter`) backed by an in-memory `FixtureAnthropicClient`, plus
 * the real `PACK_SIGNUP` knowledge (the engine reads it from
 * `PHASE_KNOWLEDGE` via `getKnowledgeForPhase`). The router runs its REAL
 * classify → `parseEnvelope` path on the fixture-supplied LLM output — no
 * stubbed `RouterDecision`. We then assert signup ADVANCES (name captured,
 * not re-asked) even when the router classifies a bare name as `amend` or a
 * low-confidence `answer` — the exact prod failure this PR fixes.
 *
 * Pre-fix: these advance assertions FAIL (the generic amend/answer tail in
 * `dispatchRouterDecision` persisted the name but re-emitted + stayed on
 * signup → the double-ask). Post-fix: the signup auto-advance guard routes
 * a name-bearing reply through `consumeChoice` and the phase progresses.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import { InterviewEngine } from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import { buildLlmRouter, type LlmRouter } from '../llm-router.ts'
import { FixtureAnthropicClient, type Fixture } from '../fixture-anthropic-client.ts'
import { PHASE_KNOWLEDGE } from '../phase-spec-resolver.ts'
import type { PlatformAdapter, PlatformInstanceInfo } from '../../../runtime/platform-adapter.ts'
import type { OnboardingPhase } from '../phase.ts'
import { stubPlatform as sharedStubPlatform } from '@neutronai/onboarding/interview/__tests__/interview-testkit.ts'

const OWNER = 't1'
const TOPIC = 'topic-1'
const USER = 'u-1'
const SELF: PlatformInstanceInfo = {
  internal_handle: 'h1',
  url_slug: OWNER,
  owner_home: '/tmp/x',
  agent_name: null,
  tier: 'open',
  kind: 'user',
}

function stubPlatform(conversational: 'all' | ReadonlyArray<OnboardingPhase>): PlatformAdapter {
  return sharedStubPlatform(conversational, SELF)
}

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

const NOW_MS = Date.now()

/**
 * Build a REAL `LlmRouter` whose only LLM seam is a fixture client that
 * returns `rawEnvelope` for any call whose user-prompt contains
 * `matchUserText`. The router's classify/parse path is genuine — only the
 * model output is canned. `clarify_threshold: 0` keeps a deliberately
 * low-confidence envelope from triggering a (fixture-less) Sonnet
 * escalation in tests that exercise the low-confidence path.
 */
function realRouter(matchUserText: string, rawEnvelope: string): LlmRouter {
  const fixture: Fixture = {
    call_id: `signup-${matchUserText}`,
    match: { user_contains: [matchUserText] },
    response: { content: [{ text: rawEnvelope }] },
  }
  const anthropicClient = new FixtureAnthropicClient({
    fixturesDir: '<in-memory>',
    fixtures: [fixture],
  })
  return buildLlmRouter({
    anthropicClient,
    options: { clarify_threshold: 0 },
  })
}

function buildEngine(router: LlmRouter): InterviewEngine {
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    llmRouter: router,
    platform: stubPlatform('all'),
  })
}

async function reachSignup(engine: InterviewEngine): Promise<string> {
  await stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase: 'signup',
    phase_state_patch: { topic_id: TOPIC, user_id: USER, signup_via: 'web' },
    advanced_at: NOW_MS,
  })
  await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    observed_at: NOW_MS,
  })
  const next = await stateStore.get(OWNER, USER)
  expect(next?.phase).toBe('signup')
  const ap = next?.phase_state['active_prompt_id']
  expect(typeof ap).toBe('string')
  sentPrompts.length = 0
  return ap as string
}

function envelope(partial: {
  action: 'advance' | 'answer' | 'amend'
  confidence: number
  response?: string | null
  state_delta?: Record<string, unknown> | null
}): string {
  return JSON.stringify({
    action: partial.action,
    confidence: partial.confidence,
    choice_value: null,
    freeform_text: null,
    response: partial.response ?? null,
    state_delta: partial.state_delta ?? null,
    reasoning: 'prod-path fixture',
    candidate_alternatives: [],
  })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-signup-prod-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('BUG 1 — signup advances on a bare name via the REAL router (prod path)', () => {
  test('REAL router classifies "Ryan" as amend(user_first_name) → signup ADVANCES, name captured, NOT re-asked', async () => {
    // The realistic prod classification of a volunteered bare name with the
    // (pre-fix) empty advance_examples: an `amend` that records the name.
    const engine = buildEngine(
      realRouter(
        'Ryan',
        envelope({
          action: 'amend',
          confidence: 0.9,
          response: null,
          state_delta: { user_first_name: 'Ryan' },
        }),
      ),
    )
    await reachSignup(engine)
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS + 1_000,
      freeform_text: 'Ryan',
    })
    // CRITICAL — advanced OFF signup (the double-ask is gone).
    expect(out.state?.phase).not.toBe('signup')
    // The name was captured to the v2-canonical key.
    expect(out.state?.phase_state['user_first_name']).toBe('Ryan')
  })

  test('REAL router amend records a DIFFERENT field (ai_substrate) → name from freeform still advances signup', async () => {
    // PACK_SIGNUP's own expected_tangent: "I'm Sam and I use ChatGPT every
    // day" → amend BOTH fields, advance signup. Here the whitelisted
    // state_delta carries ai_substrate (no user_first_name), so the signup
    // guard's freeform-extraction precedence (extractAgentNameFromFreeform →
    // sanitizeUserFirstName) is what supplies the name and advances.
    const engine = buildEngine(
      realRouter(
        'Ryan',
        envelope({
          action: 'amend',
          confidence: 0.9,
          response: null,
          state_delta: { ai_substrate_used: 'chatgpt' },
        }),
      ),
    )
    await reachSignup(engine)
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS + 1_000,
      freeform_text: "I'm Ryan and I use ChatGPT every day",
    })
    expect(out.state?.phase).not.toBe('signup')
    expect(out.state?.phase_state['user_first_name']).toBe('Ryan')
  })

  test('REAL router classifies a name reply as a high-confidence answer → signup STILL advances', async () => {
    // The other prod mis-classification: a low-/mis-routed `answer`. With a
    // name present, the signup guard advances regardless of the action label.
    const engine = buildEngine(
      realRouter(
        'Ryan',
        envelope({ action: 'answer', confidence: 0.9, response: 'Nice to meet you!', state_delta: null }),
      ),
    )
    await reachSignup(engine)
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS + 1_000,
      freeform_text: 'Ryan',
    })
    expect(out.state?.phase).not.toBe('signup')
    expect(out.state?.phase_state['user_first_name']).toBe('Ryan')
  })

  test('GUARD SCOPING — a genuine tangent (no name) via the REAL router does NOT advance', async () => {
    // The signup guard must only fire on a real name signal. A FAQ-style
    // tangent ("why do you need my name?") classifies as `answer` with no
    // name → the guard returns null → the normal answer branch deflects and
    // STAYS on signup. (Passes pre- and post-fix; it pins correct scoping so
    // the BUG 1 fix can't over-advance on every typed question.)
    const engine = buildEngine(
      realRouter(
        'why do you need my name',
        envelope({
          action: 'answer',
          confidence: 0.9,
          response: "It's just so the agent knows what to call you.",
          state_delta: null,
        }),
      ),
    )
    const activeId = await reachSignup(engine)
    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS + 1_000,
      freeform_text: 'why do you need my name?',
    })
    expect(out.state?.phase).toBe('signup')
    expect(out.state?.phase_state['user_first_name']).toBeUndefined()
    // The FAQ deflection body was sent (answer branch ran, not the guard).
    expect(
      sentPrompts.some((p) => p.prompt.body.includes('what to call you')),
    ).toBe(true)
    // active_prompt_id still anchored (re-emitted, not advanced away).
    expect(typeof out.state?.phase_state['active_prompt_id']).toBe('string')
    void activeId
  })
})

describe('BUG 1 defense-in-depth — PACK_SIGNUP.advance_examples teaches the classifier', () => {
  test('PACK_SIGNUP now carries bare-name advance exemplars (was empty [])', () => {
    const pack = PHASE_KNOWLEDGE['signup']
    expect(pack).not.toBeNull()
    expect(pack!.advance_examples.length).toBeGreaterThan(0)
    // A bare first name must be one of the taught advance exemplars.
    expect(
      pack!.advance_examples.some((ex) => ex.user_text_example === 'Ryan'),
    ).toBe(true)
  })
})
