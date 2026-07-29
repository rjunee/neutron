/**
 * v0.1.80 (2026-05-22) — `personality_offered` character-anchored shape tests.
 *
 * Spec: docs/plans/2026-05-22-phase-prompt-ux-bundle.md (Fix 2).
 */

import { describe, expect, test } from 'bun:test'
import {
  buildPersonalityOfferedPromptSpec,
  parseCharacterChoiceIndex,
  PERSONALITY_CHARACTER_PREFIX,
  type PersonalityCharacterSuggestionsBuilderInput,
} from '../phase-prompts.ts'

const SAMPLE_SUGGESTIONS: PersonalityCharacterSuggestionsBuilderInput = {
  personalized: [
    { name: 'Hermione Granger', why: 'Studious, prepared, never afraid to push back.' },
    { name: 'Naval Ravikant', why: 'Aphoristic, principled, distills first principles.' },
    { name: 'Don Draper', why: 'Persuasive, crisp, knows how a story should land.' },
  ],
  wild: [
    { name: 'Bilbo Baggins', why: 'Warm and curious, surprises you with grit.' },
    { name: 'Tony Stark', why: 'Restless, witty, never settles for first attempt.' },
  ],
}

describe('buildPersonalityOfferedPromptSpec — character-anchored shape (v0.1.80)', () => {
  test('renders 5 buttons A..E with `character:<index>` values', () => {
    const spec = buildPersonalityOfferedPromptSpec({
      character_suggestions: SAMPLE_SUGGESTIONS,
    })
    expect(spec.phase).toBe('personality_offered')
    expect(spec.options).toHaveLength(5)
    expect(spec.allow_freeform).toBe(true)
    expect(spec.next_phase_on_default).toBe('agent_name_chosen')
    const labels = spec.options.map((o) => o.label)
    expect(labels).toEqual(['A', 'B', 'C', 'D', 'E'])
    const values = spec.options.map((o) => o.value)
    expect(values).toEqual([
      `${PERSONALITY_CHARACTER_PREFIX}0`,
      `${PERSONALITY_CHARACTER_PREFIX}1`,
      `${PERSONALITY_CHARACTER_PREFIX}2`,
      `${PERSONALITY_CHARACTER_PREFIX}3`,
      `${PERSONALITY_CHARACTER_PREFIX}4`,
    ])
    const bodies = spec.options.map((o) => o.body)
    expect(bodies).toEqual([
      'Hermione Granger',
      'Naval Ravikant',
      'Don Draper',
      'Bilbo Baggins',
      'Tony Stark',
    ])
  })

  test('Codex r3 P1 — long character names stay under the 37-byte wire cap', () => {
    // Regression for the BLOCKER. Previously `value: "character:${c.name}"`
    // would emit a 49-byte value for "Lieutenant Commander Data of the
    // USS Enterprise", crashing ButtonPrimitive validation at 37 bytes.
    // Index form: max `character:4` = 11 bytes regardless of name length.
    const longNames: PersonalityCharacterSuggestionsBuilderInput = {
      personalized: [
        {
          name: 'Lieutenant Commander Data of the USS Enterprise',
          why: 'Methodical, precise, an officer who follows the rules.',
        },
        {
          name: 'Albus Percival Wulfric Brian Dumbledore',
          why: 'Wise, mischievous, never tells you everything at once.',
        },
        {
          name: 'Hermione Jean Granger of Gryffindor House',
          why: 'Studious, prepared, never afraid to push back.',
        },
      ],
      wild: [
        {
          name: 'Aragorn son of Arathorn II, King Elessar Telcontar',
          why: 'Quiet authority, steady under pressure.',
        },
        {
          name: 'Genghis Khan, Emperor of the Mongol Empire',
          why: 'Decisive, ruthless, plays the long game.',
        },
      ],
    }
    const spec = buildPersonalityOfferedPromptSpec({
      character_suggestions: longNames,
    })
    expect(spec.options).toHaveLength(5)
    const VALUE_BYTE_CAP = 37
    for (const opt of spec.options) {
      const byteLen = Buffer.byteLength(opt.value, 'utf8')
      expect(byteLen).toBeLessThanOrEqual(VALUE_BYTE_CAP)
    }
    // Body still shows the full name (button body, not button value).
    expect(spec.body).toContain('**Lieutenant Commander Data of the USS Enterprise**')
    expect(spec.body).toContain('**Albus Percival Wulfric Brian Dumbledore**')
  })

  test('body splits personalized from wild with the "more unexpected" framing', () => {
    const spec = buildPersonalityOfferedPromptSpec({
      character_suggestions: SAMPLE_SUGGESTIONS,
    })
    expect(spec.body).toContain('What kind of voice should your agent have?')
    expect(spec.body).toContain('Some thoughts based on what')
    expect(spec.body).toContain('**Hermione Granger**')
    expect(spec.body).toContain('Or something more unexpected:')
    expect(spec.body).toContain('**Tony Stark**')
    expect(spec.body).toContain('Or tell me in your own words.')
  })

  test('legacy path renders the 3 static suggestions as tappable index-buttons (v0.1.121)', () => {
    const spec = buildPersonalityOfferedPromptSpec({})
    // v0.1.121 — the legacy (no-character-suggester) fallback now buttons
    // the static defaults via the `personality:<index>` wire format.
    expect(spec.options).toHaveLength(3)
    expect(spec.options.map((o) => o.value)).toEqual([
      'personality:0',
      'personality:1',
      'personality:2',
    ])
    expect(spec.allow_freeform).toBe(true)
    expect(spec.body).toContain('Tap one that fits')
    // The button bodies carry the human-readable phrases (not bullets).
    expect(spec.options[0]?.body).toContain('warm collaborator')
  })

  test('malformed character suggestions fall back to the legacy index-buttons', () => {
    const spec = buildPersonalityOfferedPromptSpec({
      character_suggestions: {
        personalized: [],
        wild: [],
      } as unknown as PersonalityCharacterSuggestionsBuilderInput,
    })
    // Empty personalized array → legacy shape ships with index-buttons.
    expect(spec.options).toHaveLength(3)
    expect(spec.options.every((o) => o.value.startsWith('personality:'))).toBe(
      true,
    )
  })

  test('rejection_reason is stitched onto the character-anchored body', () => {
    const spec = buildPersonalityOfferedPromptSpec({
      character_suggestions: SAMPLE_SUGGESTIONS,
      rejection_reason:
        "I didn't catch what you'd like — tell me in a few words.",
    })
    expect(spec.body.startsWith("I didn't catch what")).toBe(true)
    expect(spec.body).toContain('**Hermione Granger**')
    expect(spec.options).toHaveLength(5)
  })
})

describe('parseCharacterChoiceIndex — strict wire-format matcher', () => {
  test('parses valid character:<index> values 0..4', () => {
    expect(parseCharacterChoiceIndex('character:0')).toBe(0)
    expect(parseCharacterChoiceIndex('character:1')).toBe(1)
    expect(parseCharacterChoiceIndex('character:2')).toBe(2)
    expect(parseCharacterChoiceIndex('character:3')).toBe(3)
    expect(parseCharacterChoiceIndex('character:4')).toBe(4)
  })

  test('rejects out-of-range indices', () => {
    // We render at most 5 buttons; >=5 is invalid wire format.
    expect(parseCharacterChoiceIndex('character:5')).toBeNull()
    expect(parseCharacterChoiceIndex('character:9')).toBeNull()
    expect(parseCharacterChoiceIndex('character:10')).toBeNull()
    expect(parseCharacterChoiceIndex('character:-1')).toBeNull()
  })

  test('rejects malformed values (legacy name shape, prefix only, empty)', () => {
    // Legacy `character:<name>` form must NOT parse — defends against
    // pre-upgrade clients sending stale wire format.
    expect(parseCharacterChoiceIndex('character:Hermione Granger')).toBeNull()
    expect(parseCharacterChoiceIndex('character:MaliciousPayload')).toBeNull()
    expect(parseCharacterChoiceIndex('character:')).toBeNull()
    expect(parseCharacterChoiceIndex('')).toBeNull()
    expect(parseCharacterChoiceIndex('character')).toBeNull()
    expect(parseCharacterChoiceIndex('foo:0')).toBeNull()
  })
})
