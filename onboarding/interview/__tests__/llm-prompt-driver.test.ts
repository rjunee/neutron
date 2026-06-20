/**
 * Unit tests for `llm-prompt-driver.ts`.
 *
 * Per task brief 2026-05-10: covers happy path + each error mode
 * (timeout, malformed JSON, schema fail) falling back to the static
 * fallback. Also asserts the extracted_fields + persona_acknowledgment
 * extension layer.
 */

import { describe, expect, test } from 'bun:test'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import {
  generatePromptForPhase,
  PHASE_GOALS,
  STATIC_PHASE_SPECS,
  type ExtractedFields,
  type GeneratePromptDeps,
  type GeneratePromptInput,
} from '../llm-prompt-driver.ts'

function baseInput(overrides: Partial<GeneratePromptInput> = {}): GeneratePromptInput {
  return {
    phase: 'signup',
    signup_via: 'web',
    phase_state: {},
    transcript_so_far: [],
    ...overrides,
  }
}

describe('generatePromptForPhase — fallback contract', () => {
  test('returns the static fallback when no LLM is wired', async () => {
    const spec = await generatePromptForPhase(baseInput(), {})
    expect(spec.body).toBe(STATIC_PHASE_SPECS['signup']!.body)
    expect(spec.options).toEqual([])
    expect(spec.is_fallback).toBe(true)
    // 2026-05-14 — T9: signup's spec'd default route is `instance_provisioned`
    // (auto-skipped to import_offered). Pre-T9 the shortcut to name_chosen
    // bypassed import_offered + archetype_picked.
    expect(spec.next_phase_on_default).toBe('instance_provisioned')
  })

  test('returns the static fallback when the phase is not in enabled_phases', async () => {
    const deps: GeneratePromptDeps = {
      llm: async () => '{"body":"should not be used","options":[]}',
      enabled_phases: new Set(['work_interview_gap_fill']),
    }
    const spec = await generatePromptForPhase(baseInput({ phase: 'signup' }), deps)
    expect(spec.is_fallback).toBe(true)
    expect(spec.body).toBe(STATIC_PHASE_SPECS['signup']!.body)
  })

  test('falls back when the LLM call throws', async () => {
    const deps: GeneratePromptDeps = {
      llm: async () => {
        throw new Error('upstream 503')
      },
      enabled_phases: new Set(['signup']),
    }
    const spec = await generatePromptForPhase(baseInput(), deps)
    expect(spec.is_fallback).toBe(true)
    expect(spec.body).toBe(STATIC_PHASE_SPECS['signup']!.body)
  })

  test('falls back when the LLM call times out', async () => {
    const deps: GeneratePromptDeps = {
      llm: async () => new Promise(() => {}), // never resolves
      enabled_phases: new Set(['signup']),
      timeout_ms: 50,
    }
    const spec = await generatePromptForPhase(baseInput(), deps)
    expect(spec.is_fallback).toBe(true)
  })

  test('falls back when the LLM returns malformed JSON', async () => {
    const deps: GeneratePromptDeps = {
      llm: async () => 'not actually json {',
      enabled_phases: new Set(['signup']),
    }
    const spec = await generatePromptForPhase(baseInput(), deps)
    expect(spec.is_fallback).toBe(true)
  })

  test('falls back when the LLM response misses the body field', async () => {
    const deps: GeneratePromptDeps = {
      llm: async () => '{"options":[]}',
      enabled_phases: new Set(['signup']),
    }
    const spec = await generatePromptForPhase(baseInput(), deps)
    expect(spec.is_fallback).toBe(true)
  })
})

describe('generatePromptForPhase — happy path', () => {
  test('returns the LLM body when the call succeeds with valid JSON', async () => {
    const deps: GeneratePromptDeps = {
      llm: async () =>
        JSON.stringify({
          body: 'Hey there — what should I call you?',
          options: [],
        }),
      enabled_phases: new Set(['signup']),
    }
    const spec = await generatePromptForPhase(baseInput(), deps)
    expect(spec.is_fallback).toBe(false)
    expect(spec.body).toBe('Hey there — what should I call you?')
    expect(spec.options).toEqual([])
    // Argus r1 (2026-05-10) — signup defaults to staying when the LLM
    // does NOT emit a next_phase signal and does NOT extract an
    // agent_name. The static-fallback path advances (no LLM, no
    // multi-turn capacity), but a wired LLM stays by default until it
    // has enough context. Tested below alongside the advance path.
    expect(spec.next_phase_on_default).toBe('signup')
  })

  // 2026-05-14 — T9: the LLM driver's `decideNextPhase` accepts the
  // LLM's explicit next_phase only when it equals either the current
  // phase (stay) or the static spec's advance target. After T9 the
  // signup static target is `instance_provisioned` (was `name_chosen`).
  // Tests now use the post-T9 advance target.
  test('advances signup when the LLM explicitly emits next_phase=instance_provisioned (the spec\'d static_next)', async () => {
    const deps: GeneratePromptDeps = {
      llm: async () =>
        JSON.stringify({
          body: 'Got it Sam — picking your URL next.',
          options: [],
          next_phase: 'instance_provisioned',
        }),
      enabled_phases: new Set(['signup']),
    }
    const spec = await generatePromptForPhase(baseInput(), deps)
    expect(spec.next_phase_on_default).toBe('instance_provisioned')
  })

  test('advances signup when the LLM extracts an agent_name (advance heuristic)', async () => {
    const deps: GeneratePromptDeps = {
      llm: async () =>
        JSON.stringify({
          body: 'Got it Sam — picking your URL next.',
          options: [],
          extracted_fields: { agent_name: 'Sam' },
        }),
      enabled_phases: new Set(['signup']),
    }
    const spec = await generatePromptForPhase(baseInput(), deps)
    // Post-T9: heuristic returns the static next (now instance_provisioned).
    expect(spec.next_phase_on_default).toBe('instance_provisioned')
  })

  test('rejects out-of-band next_phase values and falls back to the static target heuristic', async () => {
    const deps: GeneratePromptDeps = {
      llm: async () =>
        JSON.stringify({
          body: 'hi',
          options: [],
          next_phase: 'some_invalid_phase',
        }),
      enabled_phases: new Set(['signup']),
    }
    const spec = await generatePromptForPhase(baseInput(), deps)
    // No name extracted + invalid next_phase → stay (heuristic default).
    expect(spec.next_phase_on_default).toBe('signup')
  })

  test('extracts agent_name + archetype_hint from the JSON envelope', async () => {
    const deps: GeneratePromptDeps = {
      llm: async () =>
        JSON.stringify({
          body: 'Got it — Sherlock-but-warmer. What should I call you?',
          options: [],
          extracted_fields: {
            agent_name: 'Sam',
            archetypes: ['sherlock holmes warmer'],
          },
          persona_acknowledgment: 'Got it — Sherlock-but-warmer.',
        }),
      enabled_phases: new Set(['signup']),
    }
    const spec = await generatePromptForPhase(baseInput(), deps)
    expect(spec.extracted_fields).toBeDefined()
    expect(spec.extracted_fields!.agent_name).toBe('Sam')
    expect(spec.extracted_fields!.archetypes).toEqual(['sherlock holmes warmer'])
    expect(spec.persona_acknowledgment).toBe('Got it — Sherlock-but-warmer.')
  })

  test('ignores extracted_fields when the LLM returns malformed sub-fields', async () => {
    const deps: GeneratePromptDeps = {
      llm: async () =>
        JSON.stringify({
          body: 'Hello.',
          options: [],
          extracted_fields: {
            agent_name: 123, // wrong type — dropped
            archetypes: 'not an array', // wrong type — dropped
          },
        }),
      enabled_phases: new Set(['signup']),
    }
    const spec = await generatePromptForPhase(baseInput(), deps)
    expect(spec.is_fallback).toBe(false)
    // No valid sub-fields → no extracted_fields key on output.
    expect(spec.extracted_fields).toBeUndefined()
  })

  test('passes the user transcript through to the LLM as recent_turns', async () => {
    let capturedUser = ''
    const deps: GeneratePromptDeps = {
      llm: async (call) => {
        capturedUser = call.user
        return JSON.stringify({ body: 'ok', options: [] })
      },
      enabled_phases: new Set(['signup']),
    }
    await generatePromptForPhase(
      baseInput({
        transcript_so_far: [
          { role: 'agent', body: 'Hi', phase: 'signup' },
          { role: 'user', body: 'sherlock-but-warmer', phase: 'signup' },
        ],
      }),
      deps,
    )
    expect(capturedUser).toContain('recent_turns')
    expect(capturedUser).toContain('sherlock-but-warmer')
  })

  test('hints the web channel signup so the LLM does not suggest a Telegram name', async () => {
    let capturedUser = ''
    const deps: GeneratePromptDeps = {
      llm: async (call) => {
        capturedUser = call.user
        return JSON.stringify({ body: 'ok', options: [] })
      },
      enabled_phases: new Set(['signup']),
    }
    await generatePromptForPhase(baseInput({ signup_via: 'web' }), deps)
    expect(capturedUser).toContain('web signup')
  })
})

describe('generatePromptForPhase — option validation', () => {
  test('drops options whose value is not allowed for free-text phases', async () => {
    const deps: GeneratePromptDeps = {
      llm: async () =>
        JSON.stringify({
          body: 'pick or type',
          options: [
            { label: 'A', body: 'one', value: 'one' },
            { label: 'B', body: 'two', value: 'two' },
          ],
        }),
      enabled_phases: new Set(['signup']),
    }
    // signup intent shape is 'free-text' (allowed_option_values=[]); the
    // parser forces options=[] regardless of what the LLM emits.
    const spec = await generatePromptForPhase(baseInput(), deps)
    expect(spec.options).toEqual([])
  })
})

describe('phase-goals.md', () => {
  test('PHASE_GOALS exposes a non-empty registry', () => {
    expect(Object.keys(PHASE_GOALS).length).toBeGreaterThan(0)
  })

  test('every phase the driver can dispatch has a non-empty goal entry', () => {
    // The set of phases the driver handles is the union of the static
    // fallback table (excluding the parked phases that only exist for
    // type safety). Each must have a markdown body.
    const driverPhases = Object.keys(STATIC_PHASE_SPECS)
    for (const phase of driverPhases) {
      const goal = PHASE_GOALS[phase]
      expect(goal, `phase-goals.md missing entry for "${phase}"`).toBeDefined()
      expect(goal!.length, `phase-goals.md empty entry for "${phase}"`).toBeGreaterThan(0)
    }
  })

  test('phase-goals.md is colocated with the driver module', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const goalsPath = join(here, '..', 'phase-goals.md')
    const raw = readFileSync(goalsPath, 'utf8')
    expect(raw.length).toBeGreaterThan(100)
    expect(raw).toContain('## signup')
  })
})
