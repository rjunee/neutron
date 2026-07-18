/**
 * @neutronai/onboarding/interview — button-backed answer capture tests.
 *
 * BUG 1 (2026-06-30, Ryan live test): the personality was persisted ONLY by the
 * flaky post-turn LLM extractor, so a TAPPED choice left the field null until the
 * extractor caught up — and the per-turn required-step guard re-asked it. These
 * tests pin the deterministic capture that settles the field at choice-time (tap
 * OR typed answer to the choice block) so the step is never re-asked, while
 * conservatively declining anything that isn't a genuine answer (escape hatch, an
 * early yes/no, a question back, a non-choice turn).
 *
 * 2026-07-01 (DROP the agent-NAME step): Neutron Open never asks the owner to
 * name the orchestrator, so `agent_personality` is the ONLY field this settles.
 * The former name-capture branch is gone — a name-suggestion-shaped choice block
 * (once personality is set) settles nothing.
 */

import { describe, expect, it } from 'bun:test'

import { captureButtonBackedRequiredField } from '../button-backed-answer.ts'
import {
  DEFINED_PERSONALITY_CHARACTER_NAMES,
  IMPORT_DECISION_OPTIONS,
} from '../onboarding-preamble.ts'

/** The 3 non-button required fields already filled, so the only open step is the
 *  button-driven personality. */
const BASE = {
  user_first_name: 'Sam',
  primary_projects: ['A', 'B', 'C'],
  non_work_interests: ['climbing'],
} as const

/** The DURABLE option values (ButtonStore `options[].value`) of a realistic
 *  personality-archetype question — the DEFINED archetype names (with the agent's
 *  "— why" gloss) plus the escape hatch. This is what the runner reads off the
 *  prior prompt row, NOT the stripped body. */
function personalityOptions(): string[] {
  return [
    ...DEFINED_PERSONALITY_CHARACTER_NAMES.map((n) => `${n} — some vibe`),
    "Something else (I'll describe it)",
  ]
}

describe('captureButtonBackedRequiredField — personality step', () => {
  const firstArchetype = DEFINED_PERSONALITY_CHARACTER_NAMES[0]!

  it('TAP of an archetype settles agent_personality (no extractor needed)', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE },
      user_text: firstArchetype,
      prior_agent_options: personalityOptions(),
    })
    expect(out).toEqual({ field: 'agent_personality', value: firstArchetype })
  })

  it('TAP of the tapped option line (with the — why gloss) settles verbatim', () => {
    const line = `${firstArchetype} — some vibe`
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE },
      user_text: line,
      prior_agent_options: personalityOptions(),
    })
    expect(out).toEqual({ field: 'agent_personality', value: line })
  })

  it('a typed free-form voice descriptor settles agent_personality', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE },
      user_text: 'warm but blunt, a sharp technical peer',
      prior_agent_options: personalityOptions(),
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
      prior_agent_options: personalityOptions(),
    })
    expect(out).toBeNull()
  })

  it('a bare confirmation does not settle personality', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE },
      user_text: 'yes',
      prior_agent_options: personalityOptions(),
    })
    expect(out).toBeNull()
  })
})

describe('captureButtonBackedRequiredField — no name step (DROP the agent-NAME step)', () => {
  const withPersonality = { ...BASE, agent_personality: 'Sherlock Holmes' }

  it('once personality is set, a name-suggestion choice block settles NOTHING', () => {
    // Personality already settled; the prior turn (hypothetically) offered a
    // non-archetype choice block. Nothing to capture — Open never names the agent.
    const out = captureButtonBackedRequiredField({
      phase_state: withPersonality,
      user_text: 'Sage',
      prior_agent_options: ['Sage', 'Atlas', 'Nova', "I'll choose my own"],
    })
    expect(out).toBeNull()
  })

  it('a typed proper-noun (a would-be name) is never captured once personality is set', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: withPersonality,
      user_text: 'Agamotto',
      prior_agent_options: ['Sage', 'Atlas', 'Nova', "I'll choose my own"],
    })
    expect(out).toBeNull()
  })
})

describe('captureButtonBackedRequiredField — import decision (2026-07-18)', () => {
  /** The DURABLE option values of the guard's import step, as the ButtonStore
   *  row holds them. */
  const importOptions = (): string[] => IMPORT_DECISION_OPTIONS.map((o) => o.label)
  /** The live-bug row: name captured, nothing else. */
  const NAME_ONLY = { user_first_name: 'Ryan', signup_via: 'web' } as const

  it('TAP of each option settles import_decision with the locked vocabulary', () => {
    for (const o of IMPORT_DECISION_OPTIONS) {
      const out = captureButtonBackedRequiredField({
        phase_state: { ...NAME_ONLY },
        user_text: o.label,
        prior_agent_options: importOptions(),
      })
      expect(out).toEqual({ field: 'import_decision', value: o.decision })
    }
  })

  it('FREE TEXT naming a provider is captured (buttons are not the only path)', () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['I have claude history', 'claude'],
      ['yeah, a ChatGPT export', 'chatgpt'],
      ['my openai one', 'chatgpt'],
      ['anthropic please', 'claude'],
    ]
    for (const [text, expected] of cases) {
      const out = captureButtonBackedRequiredField({
        phase_state: { ...NAME_ONLY },
        user_text: text,
        prior_agent_options: importOptions(),
      })
      expect(out).toEqual({ field: 'import_decision', value: expected })
    }
  })

  it('FREE TEXT declines are captured as "neither" — including a provider-naming decline', () => {
    for (const text of [
      'skip',
      'neither',
      'no thanks',
      'not now',
      "I don't have a Claude export",
      'nothing to import',
    ]) {
      const out = captureButtonBackedRequiredField({
        phase_state: { ...NAME_ONLY },
        user_text: text,
        prior_agent_options: importOptions(),
      })
      expect(out).toEqual({ field: 'import_decision', value: 'neither' })
    }
  })

  it('a leading "no" that still names a provider is NOT read as a skip', () => {
    // "no, my Claude one" is a correction, not a decline. A false `neither` is
    // exactly the bug this guard exists to stop, so the decline matcher must not
    // swallow it.
    const out = captureButtonBackedRequiredField({
      phase_state: { ...NAME_ONLY },
      user_text: 'no, my claude one',
      prior_agent_options: importOptions(),
    })
    expect(out).toEqual({ field: 'import_decision', value: 'claude' })
  })

  it('a CONTRASTIVE answer never records the opposite of the explicit pick', () => {
    // "I don't have ChatGPT history, only Claude" carries a decline phrase AND a
    // selection. Reading the decline would durably record `neither` and stop the
    // guard asking, silently denying the owner the import they just asked for.
    // Ambiguous → capture nothing → the guard re-asks with buttons.
    for (const text of [
      "I don't have ChatGPT history, only Claude",
      'no chatgpt export, but I do have claude',
    ]) {
      const out = captureButtonBackedRequiredField({
        phase_state: { ...NAME_ONLY },
        user_text: text,
        prior_agent_options: importOptions(),
      })
      expect(out).toBeNull()
    }
  })

  it('a negation attached to the ONLY named provider is a decline', () => {
    for (const text of ['no chatgpt for me', 'not the claude one', 'no gpt export here']) {
      const out = captureButtonBackedRequiredField({
        phase_state: { ...NAME_ONLY },
        user_text: text,
        prior_agent_options: importOptions(),
      })
      expect(out).toEqual({ field: 'import_decision', value: 'neither' })
    }
  })

  it('an AMBIGUOUS answer captures nothing (the guard re-asks rather than inventing one)', () => {
    for (const text of ['I have both', 'hmm', 'what do you mean?']) {
      const out = captureButtonBackedRequiredField({
        phase_state: { ...NAME_ONLY },
        user_text: text,
        prior_agent_options: importOptions(),
      })
      expect(out).toBeNull()
    }
  })

  it('never fires without the import step actually having been presented', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...NAME_ONLY },
      user_text: 'skip',
      prior_agent_options: ['Tell me more', 'Later'],
    })
    expect(out).toBeNull()
  })

  it('stops capturing once settled (explicitly, or by an import that actually ran)', () => {
    for (const settled of [
      { import_decision: 'neither' },
      { import_job_id: 'job-1' },
      { import_result: { proposed_projects: [] } },
    ]) {
      const out = captureButtonBackedRequiredField({
        phase_state: { ...NAME_ONLY, ...settled },
        user_text: 'Import my ChatGPT history',
        prior_agent_options: importOptions(),
      })
      expect(out).toBeNull()
    }
  })

  it('the import step and the personality step never cross-capture', () => {
    // An import answer can never become a personality...
    expect(
      captureButtonBackedRequiredField({
        phase_state: { ...BASE },
        user_text: 'Import my Claude history',
        prior_agent_options: importOptions(),
      }),
    ).toEqual({ field: 'import_decision', value: 'claude' })
    // ...and an archetype tap is still a personality even while the import
    // decision is open (the two menus are disjoint anchors).
    const archetype = DEFINED_PERSONALITY_CHARACTER_NAMES[0]!
    expect(
      captureButtonBackedRequiredField({
        phase_state: { ...BASE },
        user_text: `${archetype} — some vibe`,
        prior_agent_options: personalityOptions(),
      }),
    ).toEqual({ field: 'agent_personality', value: `${archetype} — some vibe` })
  })
})

describe('captureButtonBackedRequiredField — guards against mis-capture', () => {
  it('an EARLY yes/no (import offer) never settles personality', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { user_first_name: 'Sam' }, // early: projects/interests not yet filled
      user_text: 'Yes, import it',
      prior_agent_options: ['Yes, import it', 'No thanks'],
    })
    expect(out).toBeNull()
  })

  it('a turn with NO options block (plain conversation) never settles', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE },
      user_text: 'Marcus Aurelius',
      prior_agent_options: [],
    })
    expect(out).toBeNull()
  })

  it('personality already settled → nothing to capture', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE, agent_personality: 'Yoda' },
      user_text: 'warm and direct',
      prior_agent_options: personalityOptions(),
    })
    expect(out).toBeNull()
  })

  it('an empty answer never settles', () => {
    const out = captureButtonBackedRequiredField({
      phase_state: { ...BASE },
      user_text: '   ',
      prior_agent_options: personalityOptions(),
    })
    expect(out).toBeNull()
  })
})
