/**
 * Integration test for the LLM-driven CONVERSATIONAL onboarding experience.
 *
 * HISTORY (2026-06-21 consolidation): this file previously unit-tested the
 * deleted `generatePromptForPhase` driver — feeding a stub LLM a JSON
 * envelope and asserting the driver parsed it into a `DrivenPhasePromptSpec`
 * (body text, `extracted_fields`, `persona_acknowledgment`, and that the
 * driver's own user-prompt carried `recent_turns`). That whole surface was
 * DRIVER-INTERNAL: `generatePromptForPhase` / `GeneratePromptInput` /
 * `GeneratePromptDeps` no longer exist. The "conversational" experience is
 * now the `phaseSpecResolver` (body copy) + `llmRouter` (routing + field
 * extraction + acknowledgment) PAIR wired into the real `InterviewEngine`.
 *
 * The driver-envelope-shape assertions are therefore deleted (they tested a
 * function that is gone) and REPLACED with the equivalent USER-VISIBLE
 * contract, asserted on the REAL engine driven by a `phaseSpecResolver` +
 * `stubRouter` + `stubPlatform('all')`:
 *
 *   - the agent emits FREE-TEXT prompts (no A/B/C buttons) in the happy path;
 *   - each router decision can carry a natural-language acknowledgment
 *     (`response`) that the engine sends as its own free-text bubble BEFORE
 *     the next prompt (the old `persona_acknowledgment` lived here);
 *   - the router's extracted fields land on `phase_state` (the old
 *     `extracted_fields` contract — now the router `state_delta` seam);
 *   - the engine consults the router with the recent transcript turns (the
 *     old "feeds the prior user turn as recent_turns" contract).
 *
 * Alex's verbatim 2026-05-10 example is preserved as the framing fixture; we
 * walk the real phase machine (signup → ai_substrate_offered →
 * work_interview_gap_fill) rather than the flat per-phase driver calls.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { InterviewEngine } from '@neutronai/onboarding/interview/engine.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'
import type { RouterDecision } from '@neutronai/onboarding/interview/llm-router.ts'
import type {
  PhaseSpecResolver,
  PhaseContextBundle,
} from '@neutronai/onboarding/interview/phase-spec-resolver.ts'
import { STATIC_PHASE_SPECS } from '@neutronai/onboarding/interview/phase-prompts.ts'
import { stubRouter, stubPlatform } from './m2-walkthrough-test-helpers.ts'
import type { RouterCall } from './m2-walkthrough-test-helpers.ts'

const OWNER = 't1'
const TOPIC = 'topic-1'
const USER = 'u-1'

// Alex's verbatim opening copy — the framing fixture. The conversational
// body half is now the phaseSpecResolver; this is the body it returns for
// the signup phase.
const SIGNUP_OPENING =
  "Hey — I'd like to get to know you before we go further. Who do you want " +
  'me to be? What kind of presence — a sharp strategist, a warm collaborator, ' +
  'a no-nonsense executor? Or someone specific?'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'conversational-e2e-'))
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

/**
 * Conversational body-copy resolver — the body half of the conversational
 * pair. Returns Alex's warm opening copy on signup and varies the gap-fill
 * body per turn (so a re-emit gets a fresh prompt_id); every other phase
 * falls through to the static spec (`null`). All bodies stay options-less
 * (`allow_freeform: true`) so the happy path never renders buttons.
 */
function makeConversationalResolver(): PhaseSpecResolver {
  let gapFillEmits = 0
  return {
    async resolve(bundle: PhaseContextBundle) {
      if (bundle.phase === 'signup') {
        const fallback = STATIC_PHASE_SPECS['signup']
        if (fallback === undefined) return null
        return { ...fallback, body: SIGNUP_OPENING }
      }
      if (bundle.phase === 'work_interview_gap_fill') {
        const fallback = STATIC_PHASE_SPECS['work_interview_gap_fill']
        if (fallback === undefined) return null
        gapFillEmits += 1
        return {
          ...fallback,
          body: `One last thing — what are you actually trying to get done? (turn ${gapFillEmits})`,
        }
      }
      return null
    },
  }
}

function makeEngine(decisions: RouterDecision[]): {
  engine: InterviewEngine
  routerCalls: RouterCall[]
} {
  const { router, calls } = stubRouter(decisions)
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push({ prompt: input.prompt })
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    llmRouter: router,
    phaseSpecResolver: makeConversationalResolver(),
    platform: stubPlatform('all'),
  })
  return { engine, routerCalls: calls }
}

function advance(
  freeform_text: string,
  state_delta: RouterDecision['state_delta'] = null,
  response: string | null = null,
): RouterDecision {
  return {
    action: 'advance',
    confidence: 0.97,
    choice_value: null,
    freeform_text,
    response,
    state_delta,
    reasoning: 'test: scripted conversational advance',
  }
}

async function replyFreeform(
  engine: InterviewEngine,
  text: string,
  observed_at: number,
): Promise<void> {
  await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    freeform_text: text,
    observed_at,
  })
}

async function tapButton(
  engine: InterviewEngine,
  choice_value: string,
  observed_at: number,
): Promise<void> {
  const state = await stateStore.get(OWNER, USER)
  const prompt_id = (state!.phase_state as Record<string, unknown>)['active_prompt_id'] as string
  await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    choice: {
      prompt_id,
      choice_value,
      chosen_at: observed_at,
      speaker_user_id: USER,
      channel_kind: 'app-socket',
    },
    observed_at,
  })
}

describe('Conversational onboarding — Alex verbatim example (real engine)', () => {
  test('opening — the agent asks who the user wants it to be, as free text (no buttons)', async () => {
    const { engine } = makeEngine([])
    await engine.start({ project_slug: OWNER, topic_id: TOPIC, user_id: USER, signup_via: 'web' })

    const last = sentPrompts[sentPrompts.length - 1]!.prompt
    expect(last.body.toLowerCase()).toContain('who do you want me to be')
    // CRITICAL: no buttons in the happy path.
    expect(last.options).toEqual([])
    expect(last.allow_freeform).toBe(true)
  })

  test('name turn — the router extracts the name + acknowledges, and the engine advances off signup', async () => {
    // "Alex" answers the signup name question; the router classifies it as an
    // advance carrying a warm acknowledgment (the old persona_acknowledgment).
    const { engine } = makeEngine([advance('Alex', null, 'Nice to meet you, Alex.')])
    await engine.start({ project_slug: OWNER, topic_id: TOPIC, user_id: USER, signup_via: 'web' })

    await replyFreeform(engine, 'Alex', 1_700_000_001_000)
    const state = await stateStore.get(OWNER, USER)
    // The name landed on phase_state and the engine advanced off signup.
    expect(state!.phase_state['user_first_name']).toBe('Alex')
    expect(state!.phase).toBe('ai_substrate_offered')
    // The router's acknowledgment was sent as its own free-text bubble.
    const ackBodies = sentPrompts.map((s) => s.prompt.body)
    expect(ackBodies.some((b) => b.includes('Nice to meet you, Alex.'))).toBe(true)
  })

  test('gap-fill turn — the router-extracted projects + interests land on phase_state', async () => {
    // Walk to the gap-fill phase, then the user describes their work in one
    // free-text turn; the router carries the extracted fields in state_delta
    // (the seam that replaced the driver's extracted_fields).
    const { engine } = makeEngine([
      advance('Alex'),
      advance(
        'Building a fragrance brand, a hotel group, and a CC course; outside work I do yoga and family time.',
        {
          primary_projects: ['fragrance brand', 'hotel group', 'CC course'],
          non_work_interests: [{ name: 'yoga' }, { name: 'family time' }],
        },
        "Got it — that's a full plate.",
      ),
    ])
    await engine.start({ project_slug: OWNER, topic_id: TOPIC, user_id: USER, signup_via: 'web' })
    await replyFreeform(engine, 'Alex', 1_700_000_001_000)
    // neither → no-import fork lands on work_interview_gap_fill.
    await tapButton(engine, 'neither', 1_700_000_002_000)
    let state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('work_interview_gap_fill')

    await replyFreeform(engine, 'fragrance brand, hotel group, CC course; yoga + family', 1_700_000_003_000)
    state = await stateStore.get(OWNER, USER)
    expect(state!.phase_state['primary_projects']).toEqual([
      'fragrance brand',
      'hotel group',
      'CC course',
    ])
    expect(state!.phase_state['non_work_interests']).toEqual([
      { name: 'yoga' },
      { name: 'family time' },
    ])
    // The audit cleared (3 projects + 1+ interest) → advanced to personality.
    expect(state!.phase).toBe('personality_offered')
  })

  test('NO buttons across the conversational happy path', async () => {
    const { engine } = makeEngine([
      advance('Alex'),
      advance('fragrance brand, hotel group, CC course; yoga', {
        primary_projects: ['fragrance brand', 'hotel group', 'CC course'],
        non_work_interests: [{ name: 'yoga' }],
      }),
    ])
    await engine.start({ project_slug: OWNER, topic_id: TOPIC, user_id: USER, signup_via: 'web' })
    await replyFreeform(engine, 'Alex', 1_700_000_001_000)
    await tapButton(engine, 'neither', 1_700_000_002_000)
    await replyFreeform(engine, 'fragrance, hotel, CC; yoga', 1_700_000_003_000)

    // The conversational happy-path prompts — the signup opening and the
    // gap-fill question — are pure free text with NO buttons. (The one
    // buttoned prompt in the walk is the ai_substrate_offered source picker,
    // which is the deliberate 3-option import fork, not the happy-path
    // free-text flow.)
    const happyPath = sentPrompts.filter(
      (s) =>
        s.prompt.body.toLowerCase().includes('who do you want me to be') ||
        s.prompt.body.toLowerCase().includes('what are you actually trying to get done'),
    )
    expect(happyPath.length).toBeGreaterThanOrEqual(2)
    for (const s of happyPath) {
      expect(s.prompt.options).toEqual([])
      expect(s.prompt.allow_freeform).toBe(true)
    }
  })

  test('the engine consults the router with the recent transcript turns', async () => {
    // The old test asserted the DRIVER folded the prior user turn into its LLM
    // user-prompt as `recent_turns`. The engine now hands the router a
    // `recent_turns` array directly; assert it carries the user's reply.
    const { engine, routerCalls } = makeEngine([advance('Alex')])
    await engine.start({ project_slug: OWNER, topic_id: TOPIC, user_id: USER, signup_via: 'web' })
    await replyFreeform(engine, 'sherlock-but-warmer-design-fluent', 1_700_000_001_000)

    expect(routerCalls.length).toBeGreaterThanOrEqual(1)
    const firstCall = routerCalls[0]!
    expect(firstCall.input.phase).toBe('signup')
    expect(firstCall.input.user_text).toBe('sherlock-but-warmer-design-fluent')
    // The engine passes a recent_turns window to the router for grounding.
    expect(Array.isArray(firstCall.input.recent_turns)).toBe(true)
  })
})
