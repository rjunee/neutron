/**
 * @neutronai/onboarding/interview — button-backed answer capture tests.
 *
 * BUG 1 (2026-06-30, Ryan live test): the agent name/personality were persisted
 * ONLY by the flaky post-turn LLM extractor, so a TAPPED choice left the field
 * null until the extractor caught up — and the per-turn required-step guard
 * re-asked it. These tests pin the deterministic capture that settles the field
 * at choice-time (tap OR typed answer to the choice block) so the step is never
 * re-asked, while conservatively declining anything that isn't a genuine answer
 * (escape hatch, an early yes/no, a question back, a non-choice turn).
 */

import { describe, expect, it } from 'bun:test'

import { captureButtonBackedRequiredField } from '../button-backed-answer.ts'
import { DEFINED_PERSONALITY_CHARACTER_NAMES } from '../onboarding-preamble.ts'

/** The 3 non-button required fields already filled, so the only open steps are
 *  the button-driven personality + name. */
const BASE = {
  user_first_name: 'Sam',
  primary_projects: ['A', 'B', 'C'],
  non_work_interests: ['climbing'],
} as const

/** A realistic personality-archetype `[[OPTIONS]]` message (matches what the
 *  step guard forces the agent to render — the DEFINED archetype names). */
function personalityQuestion(): string {
  const opts = DEFINED_PERSONALITY_CHARACTER_NAMES.map((n) => `- ${n} — some vibe`).join('\n')
  return `Whose voice should I take on?\n\n[[OPTIONS]]\n${opts}\n- Something else (I'll describe it)\n[[/OPTIONS]]`
}

/** A realistic name-suggestion `[[OPTIONS]]` message. */
const NAME_QUESTION =
  "What should you call me? Here are a few that fit:\n\n[[OPTIONS]]\n- Sage\n- Atlas\n- Nova\n- I'll choose my own\n[[/OPTIONS]]"

describe('captureButtonBackedRequiredField — personality step', () => {
  const firstArchetype = DEFINED_PERSONALITY_CHARACTER_NAMES[0]!

  it('TAP of an archetype settles agent_personality (no extractor needed)', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE },
      user_text: firstArchetype,
      prior_agent_text: personalityQuestion(),
    })
    expect(out).toEqual({ field: 'agent_personality', value: firstArchetype })
  })

  it('TAP of the tapped option line (with the — why gloss) settles verbatim', () => {
    const line = `${firstArchetype} — some vibe`
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE },
      user_text: line,
      prior_agent_text: personalityQuestion(),
    })
    expect(out).toEqual({ field: 'agent_personality', value: line })
  })

  it('a typed free-form voice descriptor settles agent_personality', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE },
      user_text: 'warm but blunt, a sharp technical peer',
      prior_agent_text: personalityQuestion(),
    })
    expect(out).toEqual({
      field: 'agent_personality',
      value: 'warm but blunt, a sharp technical peer',
    })
  })

  it('the "Something else" escape hatch does NOT settle (extractor handles the description next turn)', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE },
      user_text: "Something else (I'll describe it)",
      prior_agent_text: personalityQuestion(),
    })
    expect(out).toBeNull()
  })

  it('a bare confirmation does not settle personality', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE },
      user_text: 'yes',
      prior_agent_text: personalityQuestion(),
    })
    expect(out).toBeNull()
  })
})

describe('captureButtonBackedRequiredField — name step', () => {
  const withPersonality = { ...BASE, agent_personality: 'Sherlock Holmes' }

  it('TAP of a suggested name settles agent_name', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: withPersonality,
      user_text: 'Sage',
      prior_agent_text: NAME_QUESTION,
    })
    expect(out).toEqual({ field: 'agent_name', value: 'Sage' })
  })

  it('a TYPED custom name (ignoring the buttons) settles agent_name', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: withPersonality,
      user_text: 'Agamotto',
      prior_agent_text: NAME_QUESTION,
    })
    expect(out).toEqual({ field: 'agent_name', value: 'Agamotto' })
  })

  it('the "I\'ll choose my own" escape hatch does NOT settle', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: withPersonality,
      user_text: "I'll choose my own",
      prior_agent_text: NAME_QUESTION,
    })
    expect(out).toBeNull()
  })

  it('a long sentence is NOT captured as a name (let the extractor parse it)', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: withPersonality,
      user_text: 'Hmm, what do each of those names actually mean to you?',
      prior_agent_text: NAME_QUESTION,
    })
    expect(out).toBeNull()
  })

  it('does not fire while personality is still unset (name is not the current step)', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE },
      user_text: 'Sage',
      prior_agent_text: NAME_QUESTION,
    })
    // personality missing + a non-archetype choice block → neither branch fires.
    expect(out).toBeNull()
  })
})

describe('captureButtonBackedRequiredField — guards against mis-capture', () => {
  it('an EARLY yes/no (import offer) never settles personality', () => {
    const importOffer =
      'Want to import your ChatGPT history?\n\n[[OPTIONS]]\n- Yes, import it\n- No thanks\n[[/OPTIONS]]'
    const out = captureButtonBackedRequiredField({
      phase_state: { user_first_name: 'Sam' }, // early: projects/interests not yet filled
      user_text: 'Yes, import it',
      prior_agent_text: importOffer,
    })
    expect(out).toBeNull()
  })

  it('a turn with NO options block (plain conversation) never settles', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE },
      user_text: 'Marcus Aurelius',
      prior_agent_text: 'Tell me, what do you work on these days?',
    })
    expect(out).toBeNull()
  })

  it('a null prior message never settles', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE },
      user_text: 'Sage',
      prior_agent_text: null,
    })
    expect(out).toBeNull()
  })

  it('both fields already settled → nothing to capture', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE, agent_personality: 'Yoda', agent_name: 'Sage' },
      user_text: 'Sage',
      prior_agent_text: NAME_QUESTION,
    })
    expect(out).toBeNull()
  })

  it('an empty answer never settles', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE, agent_personality: 'Yoda' },
      user_text: '   ',
      prior_agent_text: NAME_QUESTION,
    })
    expect(out).toBeNull()
  })
})
