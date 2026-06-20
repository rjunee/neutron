/**
 * Integration test for the engine's `promptDriver` dep wiring.
 *
 * Codex r1 P1 (2026-05-10) flagged that the original PR routed enabled
 * phases through the legacy `phaseSpecResolver` instead of the new
 * conversational driver. This test pins the new contract:
 *
 *   - When `promptDriver` is wired, the engine calls IT to resolve the
 *     prompt spec for `signup`.
 *   - The `extracted_fields` returned by the driver land on
 *     `phase_state` via `persistExtractedFields`.
 *   - When the driver returns `is_fallback=true`, the engine falls
 *     through to `phaseSpecResolver` (if wired) or the static fallback.
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
import { STATIC_PHASE_SPECS } from '../phase-prompts.ts'
import type {
  DrivenPhasePromptSpec,
  GeneratePromptInput,
} from '../llm-prompt-driver.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

function makeEngine(
  promptDriver?: (input: GeneratePromptInput) => Promise<DrivenPhasePromptSpec>,
): InterviewEngine {
  const deps: ConstructorParameters<typeof InterviewEngine>[0] = {
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
  }
  if (promptDriver !== undefined) deps.promptDriver = promptDriver
  return new InterviewEngine(deps)
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-engine-driver-'))
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

describe('InterviewEngine — promptDriver dep wiring', () => {
  test('start() calls the driver for signup and emits its body', async () => {
    let driverCalled = 0
    const engine = makeEngine(async () => {
      driverCalled++
      return {
        phase: 'signup',
        body: 'driver-driven body',
        options: [],
        allow_freeform: true,
        next_phase_on_default: 'agent_name_chosen',
        is_fallback: false,
      }
    })
    await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    expect(driverCalled).toBe(1)
    expect(sentPrompts.length).toBe(1)
    expect(sentPrompts[0]?.prompt.body).toBe('driver-driven body')
  })

  test('falls back to static spec when driver returns is_fallback=true', async () => {
    const engine = makeEngine(async () => {
      return {
        phase: 'signup',
        body: 'should not be used',
        options: [],
        allow_freeform: true,
        next_phase_on_default: 'agent_name_chosen',
        is_fallback: true,
      }
    })
    await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    expect(sentPrompts[0]?.prompt.body).toBe(STATIC_PHASE_SPECS['signup']!.body)
  })

  test('persists extracted_fields to phase_state', async () => {
    const engine = makeEngine(async () => {
      return {
        phase: 'signup',
        body: 'Got it — Sam. Anything else?',
        options: [],
        allow_freeform: true,
        next_phase_on_default: 'agent_name_chosen',
        is_fallback: false,
        extracted_fields: {
          agent_name: 'Sam',
          archetypes: ['sherlock-but-warmer'],
        },
      }
    })
    await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    const state = await stateStore.get('t1', 'u-1')
    expect(state).not.toBeNull()
    expect(state!.phase_state['agent_name']).toBe('Sam')
    expect(state!.phase_state['archetype_hint']).toBe('sherlock-but-warmer')
  })

  test('driver receives the user transcript via transcript_so_far', async () => {
    // First call seeds a user transcript line.
    let capturedInput: GeneratePromptInput | null = null
    const engine = makeEngine(async (input) => {
      capturedInput = input
      return {
        phase: 'signup',
        body: 'pre-seeded turn',
        options: [],
        allow_freeform: true,
        next_phase_on_default: 'agent_name_chosen',
        is_fallback: false,
      }
    })
    transcript.append({ role: 'agent', body: 'who?', phase: 'signup' })
    transcript.append({ role: 'user', body: 'sherlock-but-warmer', phase: 'signup' })
    await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    expect(capturedInput).not.toBeNull()
    expect(capturedInput!.transcript_so_far.length).toBeGreaterThanOrEqual(2)
    const lastUserTurn = capturedInput!.transcript_so_far.find((t) => t.role === 'user')
    expect(lastUserTurn?.body).toBe('sherlock-but-warmer')
  })

  test('driver throw falls through to static fallback (engine does not crash)', async () => {
    const engine = makeEngine(async () => {
      throw new Error('driver bug')
    })
    await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    expect(sentPrompts[0]?.prompt.body).toBe(STATIC_PHASE_SPECS['signup']!.body)
  })

  test('when neither driver nor resolver is wired, static fallback fires', async () => {
    const engine = makeEngine()
    await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    expect(sentPrompts[0]?.prompt.body).toBe(STATIC_PHASE_SPECS['signup']!.body)
  })
})
