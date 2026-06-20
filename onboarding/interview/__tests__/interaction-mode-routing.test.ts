/**
 * Integration tests — `InterviewEngine` interaction-mode routing
 * (sprint 2026-06-03 onboarding-buttons-only-tweak-later).
 *
 * Proves the brief § 3 routing change:
 *   - buttons-only phases: freeform text → canned nudge, NO advance, AND
 *     the LLM router is NEVER consulted (`calls.length === 0`) even though
 *     the platform adapter says "router on for all phases".
 *   - mixed phases: a VALID text-input field advances via consumeChoice
 *     (still NO router); an INVALID input → canned nudge + no advance.
 *
 * The engine is built WITH a stub router + a platform adapter that
 * enables the router for ALL phases, so any router consultation would be
 * recorded. The whole point of the sprint is that buttons-only and mixed
 * phases bypass it.
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
import type { LlmRouter, RouterDecision } from '../llm-router.ts'
import type { PlatformAdapter, PlatformInstanceInfo } from '../../../runtime/platform-adapter.ts'
import type { OnboardingPhase } from '../phase.ts'
import {
  BUTTONS_ONLY_NUDGE_TEXT,
  NO_BUTTONS_FALLBACK_NUDGE_TEXT,
} from '../interaction-mode.ts'
import { STATIC_PHASE_SPECS } from '../phase-prompts.ts'
import {
  stubRouter as sharedStubRouter,
  stubPlatform as sharedStubPlatform,
  type RouterCall,
} from '@neutronai/onboarding/interview/__tests__/interview-testkit.ts'

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

function stubRouter(answers: Iterable<RouterDecision>): {
  router: LlmRouter
  calls: RouterCall[]
} {
  return sharedStubRouter(answers)
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

function buildEngine(opts: { router?: LlmRouter; platform?: PlatformAdapter }): InterviewEngine {
  const deps: ConstructorParameters<typeof InterviewEngine>[0] = {
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
  }
  if (opts.router !== undefined) deps.llmRouter = opts.router
  if (opts.platform !== undefined) deps.platform = opts.platform
  return new InterviewEngine(deps)
}

const NOW_MS = Date.now()

async function startAndReachPhase(
  engine: InterviewEngine,
  phase: OnboardingPhase,
  phase_state_patch: Record<string, unknown> = {},
): Promise<string> {
  await stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase,
    phase_state_patch: {
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
      ...phase_state_patch,
    },
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
  expect(next?.phase).toBe(phase)
  const ap = next?.phase_state['active_prompt_id']
  expect(typeof ap).toBe('string')
  sentPrompts.length = 0
  return ap as string
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-interaction-mode-'))
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

// Representative buttons-only phases whose (static-fallback) prompt emits
// cleanly with minimal phase_state. The per-phase classification itself is
// asserted exhaustively in interaction-mode.test.ts; here we assert the
// engine BEHAVIOR on a representative set.
const BUTTONS_ONLY_REPRESENTATIVES: OnboardingPhase[] = [
  'ai_substrate_offered',
  'max_oauth_offered',
  'persona_reviewed',
]

describe('buttons-only enforcement — freeform never advances, never routes', () => {
  for (const phase of BUTTONS_ONLY_REPRESENTATIVES) {
    test(`${phase}: freeform → canned nudge, no advance, router not called`, async () => {
      const { router, calls } = stubRouter([])
      const engine = buildEngine({ router, platform: stubPlatform('all') })
      await startAndReachPhase(engine, phase)

      const out = await engine.advance({
        project_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app-socket',
        freeform_text: 'actually can you rename my projects and change personality',
        observed_at: NOW_MS + 1_000,
      })

      // (a) phase did NOT advance
      const state = await stateStore.get(OWNER, USER)
      expect(state?.phase).toBe(phase)
      expect(out.outcome).toBe('reemitted_current')
      // (b) the canned nudge copy MATCHES the rendered button state
      //     (BUG 2 contract, onboarding-opening-fix). A buttons-only phase
      //     whose resolved spec carries options gets the
      //     "tap one of the buttons above" copy; one that resolves
      //     option-less (here persona_reviewed, whose dynamic builder needs
      //     a wired personaComposer and so falls back to its option-less
      //     static spec) gets the button-FREE fallback — never the phantom
      //     "tap the buttons" line with no buttons rendered.
      const resolvedHasButtons =
        (STATIC_PHASE_SPECS[phase]?.options.length ?? 0) > 0
      const expectedNudge = resolvedHasButtons
        ? BUTTONS_ONLY_NUDGE_TEXT
        : NO_BUTTONS_FALLBACK_NUDGE_TEXT
      const nudges = sentPrompts.filter((p) => p.prompt.body === expectedNudge)
      expect(nudges.length).toBe(1)
      // The phantom-button line must NEVER ship when no buttons rendered.
      if (!resolvedHasButtons) {
        expect(
          sentPrompts.some((p) => p.prompt.body === BUTTONS_ONLY_NUDGE_TEXT),
        ).toBe(false)
      }
      // (c) the LLM router was NEVER consulted
      expect(calls.length).toBe(0)
    })
  }
})

describe('mixed phase — agent_name_chosen', () => {
  test('valid custom name advances via consumeChoice, router not called', async () => {
    const { router, calls } = stubRouter([])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    await startAndReachPhase(engine, 'agent_name_chosen')

    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'Sherlock',
      observed_at: NOW_MS + 1_000,
    })

    const state = await stateStore.get(OWNER, USER)
    // Advanced off agent_name_chosen (captured the name + moved on).
    expect(state?.phase).not.toBe('agent_name_chosen')
    // No canned nudge emitted for valid input.
    expect(sentPrompts.some((p) => p.prompt.body === BUTTONS_ONLY_NUDGE_TEXT)).toBe(false)
    // Router never consulted for a mixed phase.
    expect(calls.length).toBe(0)
  })

  // Argus r5 BLOCKER (2026-06-03): on an INVALID name the engine surfaces
  // the CANONICAL validator reason — NOT the generic buttons-only nudge.
  // agent_name_chosen emits `options:[]`, so "Tap one of the buttons
  // above" would be a hard stall (no buttons exist). The canonical reason
  // tells the user how to recover via another typed name.
  test('invalid input (special chars) → canonical error, NOT the generic nudge', async () => {
    const { router, calls } = stubRouter([])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    await startAndReachPhase(engine, 'agent_name_chosen')

    const out = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'name@home',
      observed_at: NOW_MS + 1_000,
    })

    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('agent_name_chosen')
    expect(out.outcome).toBe('reemitted_current')
    // The generic nudge MUST NOT be the surfaced message on agent_name_chosen.
    expect(sentPrompts.some((p) => p.prompt.body === BUTTONS_ONLY_NUDGE_TEXT)).toBe(false)
    // The canonical charset reason IS surfaced.
    expect(
      sentPrompts.some(
        (p) =>
          p.prompt.body ===
          'Names can use letters, numbers, spaces, hyphens and apostrophes only — try another?',
      ),
    ).toBe(true)
    expect(calls.length).toBe(0)
  })

  // Argus r5 BLOCKER (2026-06-03): the exact stranded cases — an
  // apostrophe name and a 31-32 char name — now validate + advance via
  // consumeChoice instead of hitting the (buttonless) nudge.
  test("apostrophe name (O'Neill) validates + advances, router not called", async () => {
    const { router, calls } = stubRouter([])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    await startAndReachPhase(engine, 'agent_name_chosen')

    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: "O'Neill",
      observed_at: NOW_MS + 1_000,
    })

    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase).not.toBe('agent_name_chosen')
    expect(sentPrompts.some((p) => p.prompt.body === BUTTONS_ONLY_NUDGE_TEXT)).toBe(false)
    expect(calls.length).toBe(0)
  })

  test('32-char name validates + advances (canonical cap is 32)', async () => {
    const { router, calls } = stubRouter([])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    await startAndReachPhase(engine, 'agent_name_chosen')

    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'A'.repeat(32),
      observed_at: NOW_MS + 1_000,
    })

    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase).not.toBe('agent_name_chosen')
    expect(sentPrompts.some((p) => p.prompt.body === BUTTONS_ONLY_NUDGE_TEXT)).toBe(false)
    expect(calls.length).toBe(0)
  })
})

describe('mixed phase — personality_offered', () => {
  test('valid free-text description advances, router not called', async () => {
    const { router, calls } = stubRouter([])
    const engine = buildEngine({ router, platform: stubPlatform('all') })
    await startAndReachPhase(engine, 'personality_offered')

    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: 'Warm but direct, dry wit, never sycophantic.',
      observed_at: NOW_MS + 1_000,
    })

    const state = await stateStore.get(OWNER, USER)
    expect(state?.phase).not.toBe('personality_offered')
    expect(sentPrompts.some((p) => p.prompt.body === BUTTONS_ONLY_NUDGE_TEXT)).toBe(false)
    expect(calls.length).toBe(0)
  })
})
