/**
 * Regression coverage for the M2 onboarding UX surface fixes
 * (2026-05-12). Each describe block pins ONE failure mode visible in
 * Sam's 2026-05-12 prod screenshots so the same mode cannot ship again.
 *
 *   Fix 1 — `name_chosen` redundant Continue gate.
 *     Pinned by `__tests__/auto-skip-phases.test.ts` at the engine level.
 *     The additional assertions here pin the static-spec body so a
 *     well-meaning refactor cannot accidentally reintroduce a "Continue
 *     to pick your personal URL?" button-only prompt as the user-visible
 *     turn.
 *
 *   Fix 3 — `signup` affordance disconnect.
 *     Screenshot 1 showed a "What's your name? Just type it below."
 *     bubble with two visible buttons (A — Skip, B — Pause) — a
 *     contradiction between the prompt body and the rendered controls.
 *     Tests here pin:
 *       - STATIC_PHASE_SPECS.signup ships ZERO options. The textbox is
 *         the type affordance; no escape-ramp buttons appear.
 *       - PHASE_INTENTS.signup.shape === 'free-text' AND
 *         allowed_option_values is empty, so the LLM-driven path also
 *         cannot ship a button keyboard.
 *       - allow_freeform is true so the composer is the real affordance.
 *
 * The choice — drop all buttons at signup, treat the inline text input
 * as THE type affordance — is documented in the PR description. Two
 * affordance options were considered:
 *
 *   (a) Re-add 3-4 buttons (Use Telegram name [tg only], Type, Skip, Pause)
 *       and gate them per `signup_via`.
 *   (b) Zero buttons; rely on the composer textbox.
 *
 * (b) won because the textbox is already mounted and visible (the user
 * is meant to type), and any auxiliary buttons that don't match the
 * prompt copy create exactly the affordance contradiction the
 * screenshot captured. The "Pause" / "Skip" escape ramps are recovered
 * later in the flow via the resume-on-reconnect prompt.
 */

import { describe, expect, test } from 'bun:test'
import { STATIC_PHASE_SPECS } from '../phase-prompts.ts'
import { PHASE_INTENTS } from '../phase-spec-resolver.ts'
import { LEGAL_TRANSITIONS } from '../phase.ts'

describe('P2 v2 — agent_name_chosen is user-visible (no Continue gate)', () => {
  // P2 v2 § 3.10 — agent_name_chosen is the USER-VISIBLE name-picker
  // phase. v1 treated it as an auto-skipped transit gate; v2 wires
  // it as a real interactive phase. Pin the new contract so a future
  // refactor that reintroduces the auto-skip gate (which used to feed
  // a "Continue / Pause" button keyboard) regresses noisily.
  test('LEGAL_TRANSITIONS routes agent_name_chosen → slug_chosen', () => {
    const legal = LEGAL_TRANSITIONS['agent_name_chosen']
    expect(legal).toContain('slug_chosen')
  })

  test('agent_name_chosen → work_interview_gap_fill is illegal (the gap-fill phase ends BEFORE name)', () => {
    const legal = LEGAL_TRANSITIONS['agent_name_chosen']
    expect(legal).not.toContain('work_interview_gap_fill')
  })

  test('agent_name_chosen static spec routes to slug_chosen on default — guards the walker', () => {
    const spec = STATIC_PHASE_SPECS['agent_name_chosen']
    expect(spec).toBeDefined()
    expect(spec!.next_phase_on_default).toBe('slug_chosen')
  })

  test('agent_name_chosen body is free-text with zero options (no button gate)', () => {
    const spec = STATIC_PHASE_SPECS['agent_name_chosen']!
    expect(spec.options.length).toBe(0)
    expect(spec.allow_freeform).toBe(true)
    // The legacy gate copy must not surface — agent_name_chosen is a
    // proper "what should I be called?" prompt, not a Continue gate.
    expect(spec.body.toLowerCase()).not.toContain('continue to pick your personal url?')
  })
})

describe('Fix 3 — signup affordance is the textbox, not a button keyboard', () => {
  test('STATIC_PHASE_SPECS.signup ships zero options', () => {
    const spec = STATIC_PHASE_SPECS['signup']
    expect(spec).toBeDefined()
    expect(spec!.options).toEqual([])
  })

  test('STATIC_PHASE_SPECS.signup allows free-form so the composer is the real input', () => {
    const spec = STATIC_PHASE_SPECS['signup']!
    expect(spec.allow_freeform).toBe(true)
  })

  test('PHASE_INTENTS.signup forces the LLM path to free-text — no buttons allowed', () => {
    const intent = PHASE_INTENTS['signup']
    expect(intent).not.toBeNull()
    expect(intent).toBeDefined()
    expect(intent!.shape).toBe('free-text')
    // `parseLlmSpec` enforces options=[] whenever shape is free-text
    // (see phase-spec-resolver.ts:541). Pinning the allowed list to
    // empty is belt-and-braces — even if the parser contract drifts,
    // there are no values for the LLM to surface that the engine would
    // route. The "Use my Telegram name" / "Skip this for now" / "Pause"
    // values from the pre-2026-05-09 era are GONE from this allow-list.
    expect(intent!.allowed_option_values).toEqual([])
  })

  test('signup body never advertises a "type below" instruction paired with button-only options', () => {
    // The screenshot failure mode was a prompt body that ENCOURAGED
    // typing while the only visible controls were "Skip" / "Pause".
    // We don't pin the exact body wording (the persona-discovery copy
    // evolves), but we DO pin the invariant: when the body says any
    // "type" / "tell me" / "type below" cue, the options list MUST be
    // empty so the textbox is the only affordance the user sees.
    const spec = STATIC_PHASE_SPECS['signup']!
    const body = spec.body.toLowerCase()
    const hasTypeCue =
      body.includes('type') ||
      body.includes('tell me') ||
      body.includes('who do you want') ||
      body.includes("what's your") ||
      body.includes('what would you')
    if (hasTypeCue) {
      expect(spec.options.length).toBe(0)
      expect(spec.allow_freeform).toBe(true)
    }
  })
})
