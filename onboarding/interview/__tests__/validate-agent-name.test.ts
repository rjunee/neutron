/**
 * K11a6-completion survivor — direct pin of the RETAINED canonical
 * agent-name validator `validateAgentName` (phase-prompts.ts:1313).
 *
 * Why this file exists: the validator's semantics were previously pinned
 * only THROUGH the conversational drive (mixed-mode rejection turns in
 * `tests/integration/personality-name-slug-projects-flow.open.test.ts` and
 * `interaction-mode.test.ts`), both of which co-delete with K11b1. The
 * retained consumer path (`buildAgentNameChosenPromptSpec`'s button filter,
 * pinned by `agent-name-chosen-prompt-spec.test.ts`) exercises reserved +
 * length filtering but not the full contract. This suite pins the validator
 * directly on its retained seam so no rule is left un-covered when the
 * drive-shaped suites die (K8 coverage-loss rule).
 *
 * Contract (Sam-locked, per the phase-prompts.ts doc block):
 *   - 2..32 chars after trim
 *   - charset: letters, digits, space, hyphen, apostrophe (Unicode-aware)
 *   - first character is a letter (Unicode-aware)
 *   - case-insensitive match against RESERVED_AGENT_NAMES rejected
 */

import { describe, expect, test } from 'bun:test'
import {
  RESERVED_AGENT_NAMES,
  validateAgentName,
} from '../phase-prompts.ts'

describe('validateAgentName — retained canonical validator', () => {
  test('valid names pass and are returned trimmed', () => {
    expect(validateAgentName('Sage')).toEqual({ ok: true, value: 'Sage' })
    expect(validateAgentName('  Mimir  ')).toEqual({ ok: true, value: 'Mimir' })
    // Apostrophes, hyphens, spaces and digits are all legal past the first letter.
    expect(validateAgentName("D'Artagnan")).toEqual({ ok: true, value: "D'Artagnan" })
    expect(validateAgentName('Jean-Luc')).toEqual({ ok: true, value: 'Jean-Luc' })
    expect(validateAgentName('Agent 47x')).toEqual({ ok: true, value: 'Agent 47x' })
  })

  test('unicode letters are accepted (letter-first, Unicode-aware charset)', () => {
    expect(validateAgentName('Åsa')).toEqual({ ok: true, value: 'Åsa' })
    expect(validateAgentName('安倍')).toEqual({ ok: true, value: '安倍' })
  })

  test('length floor: under 2 chars rejected with the user-facing reason', () => {
    const out = validateAgentName('X')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('at least 2 characters')
    // Whitespace-only trims to empty → same floor.
    expect(validateAgentName('   ').ok).toBe(false)
  })

  test('length cap: over 32 chars rejected with the user-facing reason', () => {
    const out = validateAgentName('A'.repeat(33))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('32 characters or fewer')
    // Exactly 32 is legal.
    expect(validateAgentName('A'.repeat(32)).ok).toBe(true)
  })

  test('punctuation outside the charset is rejected with the letters/numbers guidance', () => {
    const out = validateAgentName('Mimir@home')
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.reason).toContain('letters, numbers, spaces, hyphens and apostrophes')
    }
    expect(validateAgentName('Sage!').ok).toBe(false)
    expect(validateAgentName('a_b').ok).toBe(false)
  })

  test('first character must be a letter', () => {
    expect(validateAgentName('47agent').ok).toBe(false)
    expect(validateAgentName('-Sage').ok).toBe(false)
    expect(validateAgentName("'Sage").ok).toBe(false)
  })

  test('reserved names are rejected case-insensitively, with the name echoed in the reason', () => {
    for (const reserved of ['Claude', 'claude', 'CHATGPT', 'Assistant', 'neutron']) {
      const out = validateAgentName(reserved)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toContain('is reserved')
    }
    // The exported reserved set is the lookup source (lower-cased entries).
    expect(RESERVED_AGENT_NAMES.has('claude')).toBe(true)
    expect(RESERVED_AGENT_NAMES.has('gpt')).toBe(true)
  })
})
