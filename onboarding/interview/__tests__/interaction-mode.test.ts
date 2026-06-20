/**
 * Unit tests — per-phase interaction-mode classifier + mixed-phase
 * text-input validators (sprint 2026-06-03 onboarding-buttons-only-tweak-later).
 *
 * The classifier is the buttons-only/mixed/freeform map the engine
 * consults BEFORE the LLM router. These tests pin the brief § 2
 * classification exhaustively (every phase asserted) and the per-phase
 * validation rules in § 2.
 */

import { describe, expect, test } from 'bun:test'

import { ALL_PHASES } from '../phase.ts'
import {
  BUTTONS_ONLY_NUDGE_TEXT,
  FREEFORM_SUB_STEPS_BY_PHASE,
  INTERACTION_MODE_BY_PHASE,
  TEXT_INPUT_FIELDS_BY_PHASE,
  resolveInteractionMode,
  validateMixedTextInput,
} from '../interaction-mode.ts'

describe('INTERACTION_MODE_BY_PHASE — brief § 2 classification', () => {
  const BUTTONS_ONLY = [
    'instance_provisioned',
    'ai_substrate_offered',
    'import_upload_pending',
    'import_running',
    'projects_proposed',
    'persona_synthesizing',
    'persona_reviewed',
    'max_oauth_offered',
    'wow_fired',
  ] as const
  const MIXED = ['agent_name_chosen', 'slug_chosen', 'personality_offered'] as const
  const FREEFORM = [
    'signup',
    'identity_oauth',
    // Argus r3 BLOCKER (2026-06-03): reclassified from buttons-only — the
    // "anything missed?" reply needs to reach its dedicated handler, not
    // the canned nudge (the happy-path success body has no button).
    'import_analysis_presented',
    'work_interview_gap_fill',
    'completed',
    'failed',
  ] as const

  test('every phase in the enum is classified (total map)', () => {
    for (const phase of ALL_PHASES) {
      expect(INTERACTION_MODE_BY_PHASE[phase]).toBeDefined()
    }
  })

  test('buttons-only phases', () => {
    for (const phase of BUTTONS_ONLY) {
      expect(INTERACTION_MODE_BY_PHASE[phase]).toBe('buttons-only')
    }
  })

  test('mixed phases', () => {
    for (const phase of MIXED) {
      expect(INTERACTION_MODE_BY_PHASE[phase]).toBe('mixed')
    }
  })

  test('freeform phases (incl. work_interview_gap_fill exception)', () => {
    for (const phase of FREEFORM) {
      expect(INTERACTION_MODE_BY_PHASE[phase]).toBe('freeform')
    }
  })

  test('work_interview_gap_fill is freeform NOT buttons-only (text answers)', () => {
    // Documented exception: this phase collects open text answers. Making
    // it buttons-only would re-introduce the silent-drop bug inverted.
    expect(INTERACTION_MODE_BY_PHASE['work_interview_gap_fill']).toBe('freeform')
  })
})

describe('TEXT_INPUT_FIELDS_BY_PHASE — mixed-phase declared fields', () => {
  test('each mixed phase declares exactly its one field', () => {
    expect(TEXT_INPUT_FIELDS_BY_PHASE['agent_name_chosen']).toEqual(['custom_name'])
    expect(TEXT_INPUT_FIELDS_BY_PHASE['slug_chosen']).toEqual(['custom_slug'])
    expect(TEXT_INPUT_FIELDS_BY_PHASE['personality_offered']).toEqual(['custom_description'])
  })
})

describe('resolveInteractionMode — spec override vs central map', () => {
  test('spec.interaction_mode overrides the central map', () => {
    expect(resolveInteractionMode({ interaction_mode: 'freeform' }, 'ai_substrate_offered')).toBe(
      'freeform',
    )
  })
  test('falls back to the central map when spec omits the field', () => {
    expect(resolveInteractionMode({}, 'ai_substrate_offered')).toBe('buttons-only')
    expect(resolveInteractionMode(null, 'agent_name_chosen')).toBe('mixed')
    expect(resolveInteractionMode(undefined, 'signup')).toBe('freeform')
  })
})

describe('FREEFORM_SUB_STEPS_BY_PHASE — Argus r1 sub_step exceptions', () => {
  test('persona_reviewed freeform sub_steps', () => {
    const set = FREEFORM_SUB_STEPS_BY_PHASE['persona_reviewed']
    expect(set).toBeDefined()
    expect(set!.has('pick_line')).toBe(true)
    expect(set!.has('pick_replacement')).toBe(true)
    expect(set!.has('pending_regen_hint')).toBe(true)
    // Gate-collapse (#93, 2026-06-05) — the idle (top-level review) screen
    // now carries a single "Looks good" button, so a typed reply IS the
    // tweak request and must reach the recompose handler (router bypassed).
    // idle is therefore a freeform sub_step now.
    expect(set!.has('idle')).toBe(true)
  })
  test('import_running freeform sub_steps', () => {
    const set = FREEFORM_SUB_STEPS_BY_PHASE['import_running']
    expect(set).toBeDefined()
    expect(set!.has('rate_limit_paused')).toBe(true)
    expect(set!.has('failed')).toBe(true)
    // The transit status post stays buttons-only.
    expect(set!.has('status')).toBe(false)
  })
})

describe('resolveInteractionMode — sub_step awareness (Argus r1 BLOCKER 1 + 2)', () => {
  test('persona_reviewed pending_regen_hint → freeform (NOT buttons-only)', () => {
    expect(resolveInteractionMode(null, 'persona_reviewed', 'pending_regen_hint')).toBe('freeform')
  })
  test('persona_reviewed pick_replacement → freeform', () => {
    expect(resolveInteractionMode(null, 'persona_reviewed', 'pick_replacement')).toBe('freeform')
  })
  test('persona_reviewed pick_line → freeform', () => {
    expect(resolveInteractionMode(null, 'persona_reviewed', 'pick_line')).toBe('freeform')
  })
  test('persona_reviewed idle → freeform (gate-collapse #93: typed reply = tweak path)', () => {
    expect(resolveInteractionMode(null, 'persona_reviewed', 'idle')).toBe('freeform')
  })
  test('persona_reviewed with no sub_step → buttons-only (unchanged)', () => {
    // A null/absent sub_step is not a freeform sub_step (the engine always
    // persists 'idle' on the live review screen, so null only occurs before
    // entry); the phase-level default still applies.
    expect(resolveInteractionMode(null, 'persona_reviewed')).toBe('buttons-only')
    expect(resolveInteractionMode(null, 'persona_reviewed', null)).toBe('buttons-only')
  })
  test('import_running rate_limit_paused → freeform', () => {
    expect(resolveInteractionMode(null, 'import_running', 'rate_limit_paused')).toBe('freeform')
  })
  test('import_running failed → freeform', () => {
    expect(resolveInteractionMode(null, 'import_running', 'failed')).toBe('freeform')
  })
  test('import_running status → buttons-only (unchanged)', () => {
    expect(resolveInteractionMode(null, 'import_running', 'status')).toBe('buttons-only')
  })
  test('import_running with no sub_step → buttons-only (unchanged)', () => {
    expect(resolveInteractionMode(null, 'import_running')).toBe('buttons-only')
  })
  test('explicit spec.interaction_mode still wins over a freeform sub_step', () => {
    // A per-emit override is the most specific signal; it must beat the
    // sub_step exception just as it beats the central map.
    expect(
      resolveInteractionMode({ interaction_mode: 'buttons-only' }, 'persona_reviewed', 'pending_regen_hint'),
    ).toBe('buttons-only')
  })
  test('sub_step on a phase with no freeform exceptions is ignored', () => {
    // ai_substrate_offered has no FREEFORM_SUB_STEPS entry — a stray
    // sub_step value must not flip it to freeform.
    expect(resolveInteractionMode(null, 'ai_substrate_offered', 'whatever')).toBe('buttons-only')
  })
})

describe('BUTTONS_ONLY_NUDGE_TEXT — brief § 4 verbatim', () => {
  test('is the exact canned string', () => {
    expect(BUTTONS_ONLY_NUDGE_TEXT).toBe(
      'Tap one of the buttons above to continue. You can tweak any of this later — just ask me after setup.',
    )
  })
})

describe('validateMixedTextInput — agent_name_chosen (custom_name)', () => {
  test('accepts a plain name', () => {
    const r = validateMixedTextInput('agent_name_chosen', 'Sherlock')
    expect(r.valid).toBe(true)
    expect(r.field).toBe('custom_name')
    expect(r.sanitized).toBe('Sherlock')
    expect(r.error).toBeNull()
  })
  test('accepts names with spaces and dashes', () => {
    expect(validateMixedTextInput('agent_name_chosen', 'Lookout Point').valid).toBe(true)
    expect(validateMixedTextInput('agent_name_chosen', 'Jean-Luc').valid).toBe(true)
  })
  // Argus r5 BLOCKER (2026-06-03): the pre-gate now DELEGATES to the
  // canonical `validateAgentName` (apostrophes allowed, 2..32 chars,
  // letter-first, reserved-name guard) instead of a narrower local rule.
  test("accepts apostrophes (canonical parity — O'Neill regression)", () => {
    const r = validateMixedTextInput('agent_name_chosen', "O'Neill")
    expect(r.valid).toBe(true)
    expect(r.field).toBe('custom_name')
    expect(r.sanitized).toBe("O'Neill")
    expect(r.error).toBeNull()
  })
  test('accepts 31- and 32-char names (canonical cap is 32, not 30)', () => {
    expect(validateMixedTextInput('agent_name_chosen', 'A'.repeat(31)).valid).toBe(true)
    expect(validateMixedTextInput('agent_name_chosen', 'A'.repeat(32)).valid).toBe(true)
  })
  test('rejects too-short (1 char) with the canonical reason', () => {
    const r = validateMixedTextInput('agent_name_chosen', 'A')
    expect(r.valid).toBe(false)
    expect(r.error).toBe('A name needs to be at least 2 characters — try another?')
  })
  test('rejects >32 chars with the canonical reason', () => {
    const r = validateMixedTextInput('agent_name_chosen', 'A'.repeat(33))
    expect(r.valid).toBe(false)
    expect(r.error).toBe('Keep the name to 32 characters or fewer — try another?')
  })
  test('rejects illegal characters with the canonical reason', () => {
    const r = validateMixedTextInput('agent_name_chosen', 'name@home')
    expect(r.valid).toBe(false)
    expect(r.error).toBe(
      'Names can use letters, numbers, spaces, hyphens and apostrophes only — try another?',
    )
    expect(validateMixedTextInput('agent_name_chosen', 'na/me').valid).toBe(false)
  })
  test('rejects reserved names with the canonical reason (parity gain)', () => {
    const r = validateMixedTextInput('agent_name_chosen', 'Claude')
    expect(r.valid).toBe(false)
    expect(r.error).toBe('"Claude" is reserved — try another?')
  })
  test('rejects empty / whitespace-only (no specific reason → generic nudge)', () => {
    const r = validateMixedTextInput('agent_name_chosen', '   ')
    expect(r.valid).toBe(false)
    expect(r.error).toBeNull()
  })
})

describe('validateMixedTextInput — slug_chosen (custom_slug)', () => {
  test('accepts a phrase that sanitizes to a legal slug', () => {
    const r = validateMixedTextInput('slug_chosen', 'Lookout Point')
    expect(r.valid).toBe(true)
    expect(r.field).toBe('custom_slug')
  })
  test('accepts an already-legal slug', () => {
    expect(validateMixedTextInput('slug_chosen', 'minas-tirith').valid).toBe(true)
  })
  test('rejects text that sanitizes to an illegal slug', () => {
    // Punctuation-only sanitizes to empty → illegal.
    expect(validateMixedTextInput('slug_chosen', '!!!').valid).toBe(false)
    // Single char is below the slug min length.
    expect(validateMixedTextInput('slug_chosen', 'a').valid).toBe(false)
  })
})

describe('validateMixedTextInput — personality_offered (custom_description)', () => {
  test('accepts free-text description', () => {
    const r = validateMixedTextInput(
      'personality_offered',
      'Warm, dry wit, a bit of a stoic — think Marcus Aurelius with a smile.',
    )
    expect(r.valid).toBe(true)
    expect(r.field).toBe('custom_description')
  })
  test('rejects empty', () => {
    expect(validateMixedTextInput('personality_offered', '   ').valid).toBe(false)
  })
  test('rejects absurdly long (>2000 chars)', () => {
    expect(
      validateMixedTextInput('personality_offered', 'x'.repeat(2001)).valid,
    ).toBe(false)
  })
})

describe('validateMixedTextInput — non-mixed phase', () => {
  test('returns invalid for a buttons-only phase', () => {
    expect(validateMixedTextInput('ai_substrate_offered', 'whatever').valid).toBe(false)
  })
})

// ISSUES #84 (reopened 2026-06-06, import-screen-deadend sprint): the
// verb-gated `detectImportSourceSwitch` detector was RETIRED. On
// `import_upload_pending` the engine now routes ALL non-upload freeform back
// to the source picker unconditionally (non-destructive re-emit), so no
// keyword detector is needed. The behavioral coverage lives in
// `buttons-only-safety-net.test.ts` (engine-level), not here.
