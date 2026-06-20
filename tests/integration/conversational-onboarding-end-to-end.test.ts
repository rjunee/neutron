/**
 * Integration test for the LLM-driven conversational onboarding driver.
 *
 * Replays Alex's verbatim example from 2026-05-10 turn-by-turn, with a
 * stub LLM that returns deterministic JSON envelopes. Asserts:
 *
 *   - The agent emits free-text prompts, no A/B/C buttons in the happy path
 *   - Each agent response acknowledges what the user just said
 *     (persona_acknowledgment is baked into the body)
 *   - extracted_fields land on phase_state when the LLM extracts them
 *
 * The Alex-example transcript IS the test fixture:
 *
 *   Agent: "Hey — I'd like to get to know you before we go further. Who
 *           do you want me to be? What kind of presence — a sharp
 *           strategist, a warm collaborator, a no-nonsense executor? Or
 *           someone specific — Marcus Aurelius, your favorite character?"
 *   User:  "kind of like Sherlock Holmes but warmer. And really good at design."
 *   Agent: "Got it — incisive, observant, but not cold. Design fluency
 *           baked in. What should I call you?"
 *   User:  "Alex"
 *   Agent: "Nice. Want your URL to be alex.example.com, or pick
 *           something different?"
 *   User:  "neutron"
 *   Agent: "neutron it is. One last thing — what are you actually trying
 *           to get done?"
 *
 * The stub LLM returns one JSON envelope per agent turn — same shape
 * the real Haiku 4.5 call would produce.
 */

import { describe, expect, test } from 'bun:test'
import {
  generatePromptForPhase,
  type GeneratePromptInput,
  type GeneratePromptDeps,
} from '@neutronai/onboarding/interview/llm-prompt-driver.ts'
import type { LlmCallFn } from '@neutronai/onboarding/interview/phase-spec-resolver.ts'
import type { OnboardingPhase } from '@neutronai/onboarding/interview/phase.ts'

// ---------------------------------------------------------------------------
// Deterministic stub LLM that returns one of N JSON envelopes per call
// ---------------------------------------------------------------------------

function buildStubLlm(envelopes: ReadonlyArray<string>): {
  llm: LlmCallFn
  callCount: () => number
  capturedUserPrompts: ReadonlyArray<string>
} {
  let idx = 0
  const captured: string[] = []
  const llm: LlmCallFn = async (call) => {
    captured.push(call.user)
    const out = envelopes[idx]
    if (out === undefined) {
      throw new Error(`stub LLM exhausted at call ${idx} (only ${envelopes.length} envelopes wired)`)
    }
    idx++
    return out
  }
  return {
    llm,
    callCount: () => idx,
    capturedUserPrompts: captured,
  }
}

function buildDeps(llm: LlmCallFn): GeneratePromptDeps {
  return {
    llm,
    enabled_phases: new Set(['signup']),
  }
}

// ---------------------------------------------------------------------------
// Alex-example envelopes — one per agent turn
// ---------------------------------------------------------------------------

const ENVELOPE_TURN_1 = JSON.stringify({
  body:
    "Hey — I'd like to get to know you before we go further. Who do you want me to be? What kind of presence — a sharp strategist, a warm collaborator, a no-nonsense executor? Or someone specific — Marcus Aurelius, your favorite character?",
  options: [],
})

// After user says "kind of like Sherlock Holmes but warmer. And really
// good at design." — the LLM extracts archetype_hint + asks for the
// user's name.
const ENVELOPE_TURN_2 = JSON.stringify({
  body:
    "Got it — incisive, observant, but not cold. Design fluency baked in. What should I call you?",
  options: [],
  extracted_fields: {
    archetypes: ['sherlock-but-warmer', 'design-fluent'],
  },
  persona_acknowledgment:
    'Got it — incisive, observant, but not cold. Design fluency baked in.',
})

// After user says "Alex" — LLM extracts agent_name + asks about URL.
const ENVELOPE_TURN_3 = JSON.stringify({
  body: 'Nice. Want your URL to be alex.example.com, or pick something different?',
  options: [],
  extracted_fields: {
    agent_name: 'Alex',
  },
  persona_acknowledgment: 'Nice.',
})

// After user says "neutron" — LLM acknowledges + asks about goal.
const ENVELOPE_TURN_4 = JSON.stringify({
  body:
    "neutron it is. One last thing — what are you actually trying to get done?",
  options: [],
  extracted_fields: {
    slug: 'neutron',
  },
  persona_acknowledgment: 'neutron it is.',
})

describe('Conversational onboarding — Alex verbatim example', () => {
  test('turn 1 (opening) — agent asks who the user wants the agent to be', async () => {
    const { llm } = buildStubLlm([ENVELOPE_TURN_1])
    const input: GeneratePromptInput = {
      phase: 'signup',
      signup_via: 'web',
      phase_state: {},
      transcript_so_far: [],
    }
    const spec = await generatePromptForPhase(input, buildDeps(llm))
    expect(spec.is_fallback).toBe(false)
    expect(spec.body.toLowerCase()).toContain('who do you want me to be')
    // CRITICAL: no buttons in the happy path
    expect(spec.options).toEqual([])
    expect(spec.allow_freeform).toBe(true)
  })

  test('turn 2 (persona ack + name ask) — extracts archetypes, asks for name', async () => {
    const { llm } = buildStubLlm([ENVELOPE_TURN_2])
    const input: GeneratePromptInput = {
      phase: 'signup',
      signup_via: 'web',
      phase_state: {},
      transcript_so_far: [
        {
          role: 'agent',
          body:
            "Hey — I'd like to get to know you before we go further. Who do you want me to be?",
          phase: 'signup',
        },
        {
          role: 'user',
          body: 'kind of like Sherlock Holmes but warmer. And really good at design.',
          phase: 'signup',
        },
      ],
    }
    const spec = await generatePromptForPhase(input, buildDeps(llm))
    expect(spec.is_fallback).toBe(false)
    expect(spec.body).toContain('incisive, observant')
    expect(spec.body).toContain('What should I call you')
    expect(spec.options).toEqual([])
    expect(spec.extracted_fields).toBeDefined()
    expect(spec.extracted_fields!.archetypes).toEqual([
      'sherlock-but-warmer',
      'design-fluent',
    ])
    expect(spec.persona_acknowledgment).toContain('incisive')
  })

  test('turn 3 (name + slug suggestion) — extracts agent_name, asks about URL', async () => {
    const { llm } = buildStubLlm([ENVELOPE_TURN_3])
    const input: GeneratePromptInput = {
      phase: 'signup',
      signup_via: 'web',
      phase_state: {
        archetype_hint: 'sherlock-but-warmer, design-fluent',
      },
      transcript_so_far: [
        { role: 'agent', body: 'What should I call you?', phase: 'signup' },
        { role: 'user', body: 'Alex', phase: 'signup' },
      ],
    }
    const spec = await generatePromptForPhase(input, buildDeps(llm))
    expect(spec.body).toContain('alex.example.com')
    expect(spec.options).toEqual([])
    expect(spec.extracted_fields!.agent_name).toBe('Alex')
  })

  test('turn 4 (slug + goal ask) — extracts slug, asks about goal', async () => {
    const { llm } = buildStubLlm([ENVELOPE_TURN_4])
    const input: GeneratePromptInput = {
      phase: 'signup',
      signup_via: 'web',
      phase_state: {
        agent_name: 'Alex',
        suggested_slug: 'alex',
      },
      transcript_so_far: [
        {
          role: 'agent',
          body: 'Want your URL to be alex.example.com, or pick something different?',
          phase: 'signup',
        },
        { role: 'user', body: 'neutron', phase: 'signup' },
      ],
    }
    const spec = await generatePromptForPhase(input, buildDeps(llm))
    expect(spec.body).toContain('neutron it is')
    expect(spec.body).toContain('trying to get done')
    expect(spec.options).toEqual([])
    expect(spec.extracted_fields!.slug).toBe('neutron')
  })

  test('NO buttons in the happy path across all 4 turns', async () => {
    const envelopes = [ENVELOPE_TURN_1, ENVELOPE_TURN_2, ENVELOPE_TURN_3, ENVELOPE_TURN_4]
    const { llm } = buildStubLlm(envelopes)
    const turns: ReadonlyArray<GeneratePromptInput> = [
      { phase: 'signup' as OnboardingPhase, signup_via: 'web', phase_state: {}, transcript_so_far: [] },
      {
        phase: 'signup' as OnboardingPhase,
        signup_via: 'web',
        phase_state: {},
        transcript_so_far: [
          { role: 'agent', body: 'who?', phase: 'signup' as OnboardingPhase },
          { role: 'user', body: 'sherlock-but-warmer', phase: 'signup' as OnboardingPhase },
        ],
      },
      {
        phase: 'signup' as OnboardingPhase,
        signup_via: 'web',
        phase_state: {},
        transcript_so_far: [
          { role: 'agent', body: 'name?', phase: 'signup' as OnboardingPhase },
          { role: 'user', body: 'Alex', phase: 'signup' as OnboardingPhase },
        ],
      },
      {
        phase: 'signup' as OnboardingPhase,
        signup_via: 'web',
        phase_state: {},
        transcript_so_far: [
          { role: 'agent', body: 'url?', phase: 'signup' as OnboardingPhase },
          { role: 'user', body: 'neutron', phase: 'signup' as OnboardingPhase },
        ],
      },
    ]
    const deps = buildDeps(llm)
    for (const turn of turns) {
      const spec = await generatePromptForPhase(turn, deps)
      expect(spec.options.length).toBe(0)
      expect(spec.allow_freeform).toBe(true)
    }
  })

  test('feeds the prior user turn into the LLM user prompt as recent_turns', async () => {
    const { llm, capturedUserPrompts } = buildStubLlm([ENVELOPE_TURN_2])
    const input: GeneratePromptInput = {
      phase: 'signup',
      signup_via: 'web',
      phase_state: {},
      transcript_so_far: [
        { role: 'agent', body: 'who?', phase: 'signup' },
        { role: 'user', body: 'sherlock-but-warmer-design-fluent', phase: 'signup' },
      ],
    }
    await generatePromptForPhase(input, buildDeps(llm))
    expect(capturedUserPrompts[0]).toContain('recent_turns')
    expect(capturedUserPrompts[0]).toContain('sherlock-but-warmer-design-fluent')
  })
})
