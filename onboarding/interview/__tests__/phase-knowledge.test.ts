/**
 * Unit tests — `PHASE_KNOWLEDGE` table + `validatePhaseKnowledgePack`.
 *
 * P2-v3 S2 (2026-05-18) introduced 4 packs + the validator. P2-v3 S3
 * (2026-05-18) extends to 11 packs covering every user-input-bearing
 * phase. Asserts:
 *   - every hand-authored pack passes validation at module load
 *   - every still-null phase (transit / terminal / external-driven) returns
 *     `null` from `getKnowledgeForPhase`
 *   - the validator rejects malformed packs (missing fields, oversize
 *     strings, wrong types)
 *   - every `expected_tangents.expected_action` is one of 'answer' / 'amend'
 *   - the `max_oauth_offered` pick-only invariant: every advance example
 *     uses an allowed canonical_value
 *   - every populated pack carries ≥3 expected_tangents (the design § 6 S3
 *     coverage floor)
 *
 * The router-prompt-wiring assertions (which exercise `llm-router.ts`'s
 * `buildSystemPrompt` directly) were split out to
 * `phase-knowledge-router-wiring.test.ts` (K11a2) — that file dies with
 * K11b1 alongside `llm-router.ts`; this file's pack-content/validation
 * assertions are the RETAINED half and now import `PhaseKnowledgePack`
 * from its new home, `phase-spec-resolver.ts`.
 */

import { describe, expect, test } from 'bun:test'
import {
  getKnowledgeForPhase,
  PHASE_KNOWLEDGE,
  validatePhaseKnowledgePack,
  type PhaseKnowledgePack,
} from '../phase-spec-resolver.ts'
import type { OnboardingPhase } from '../phase.ts'
import { ALL_PHASES } from '../phase.ts'

const S2_PHASES: ReadonlyArray<OnboardingPhase> = [
  'signup',
  'ai_substrate_offered',
  'import_upload_pending',
  'personality_offered',
]

const S3_PHASES: ReadonlyArray<OnboardingPhase> = [
  'import_analysis_presented',
  'work_interview_gap_fill',
  'agent_name_chosen',
  'slug_chosen',
  'projects_proposed',
  'persona_reviewed',
  'max_oauth_offered',
]

const POPULATED_PHASES: ReadonlyArray<OnboardingPhase> = [
  ...S2_PHASES,
  ...S3_PHASES,
]

const FOREVER_NULL_PHASES: ReadonlyArray<OnboardingPhase> = [
  'identity_oauth',
  'instance_provisioned',
  'import_running',
  'persona_synthesizing',
  'wow_fired',
  'completed',
  'failed',
]

describe('PHASE_KNOWLEDGE module-load validation', () => {
  test('every hand-authored pack passes validatePhaseKnowledgePack', () => {
    for (const phase of POPULATED_PHASES) {
      const pack = PHASE_KNOWLEDGE[phase]
      expect(pack).not.toBeNull()
      expect(() => validatePhaseKnowledgePack(pack!, phase)).not.toThrow()
    }
  })

  test('every forever-null phase entry is null', () => {
    for (const phase of FOREVER_NULL_PHASES) {
      expect(PHASE_KNOWLEDGE[phase]).toBeNull()
    }
  })

  test('the table covers every OnboardingPhase (exhaustive Record)', () => {
    // Compile-time exhaustiveness is enforced via the Record type. This
    // runtime check pins the same contract at test time.
    for (const phase of ALL_PHASES) {
      const has = Object.prototype.hasOwnProperty.call(PHASE_KNOWLEDGE, phase)
      expect(has).toBe(true)
    }
  })

  test('S2 + S3 together cover 11 of 18 phases', () => {
    const populated = ALL_PHASES.filter((p) => PHASE_KNOWLEDGE[p] !== null)
    expect(populated.length).toBe(11)
    const stillNull = ALL_PHASES.filter((p) => PHASE_KNOWLEDGE[p] === null)
    expect(stillNull.length).toBe(7)
  })
})

describe('getKnowledgeForPhase', () => {
  test('returns the pack for every populated phase', () => {
    for (const phase of POPULATED_PHASES) {
      const pack = getKnowledgeForPhase(phase)
      expect(pack).not.toBeNull()
      expect(typeof pack?.why_we_ask).toBe('string')
    }
  })

  test('returns null for transit / terminal phases', () => {
    for (const phase of FOREVER_NULL_PHASES) {
      expect(getKnowledgeForPhase(phase)).toBeNull()
    }
  })
})

describe('PhaseKnowledgePack content invariants', () => {
  test('every expected_tangents.expected_action is answer or amend', () => {
    for (const phase of POPULATED_PHASES) {
      const pack = PHASE_KNOWLEDGE[phase]!
      for (const ex of pack.expected_tangents) {
        expect(['answer', 'amend']).toContain(ex.expected_action)
      }
    }
  })

  test('every advance_examples.canonical_value is null or non-empty string', () => {
    for (const phase of POPULATED_PHASES) {
      const pack = PHASE_KNOWLEDGE[phase]!
      for (const ex of pack.advance_examples) {
        const v = ex.canonical_value
        if (v === null) continue
        expect(typeof v).toBe('string')
        expect((v as string).length).toBeGreaterThan(0)
      }
    }
  })

  test('every pack carries ≥3 expected_tangents (design § 6 S3 floor)', () => {
    for (const phase of POPULATED_PHASES) {
      const pack = PHASE_KNOWLEDGE[phase]!
      expect(pack.expected_tangents.length).toBeGreaterThanOrEqual(3)
    }
  })

  test('import_upload_pending pack contains the brief-incident tangent', () => {
    const pack = PHASE_KNOWLEDGE['import_upload_pending']!
    const hasBriefIncident = pack.expected_tangents.some((t) =>
      t.user_text_example
        .toLowerCase()
        .includes('claude as well'),
    )
    expect(hasBriefIncident).toBe(true)
  })

  test('ai_substrate_offered advance_examples cover every option value', () => {
    const pack = PHASE_KNOWLEDGE['ai_substrate_offered']!
    const canonical = new Set(pack.advance_examples.map((e) => e.canonical_value))
    expect(canonical.has('chatgpt')).toBe(true)
    expect(canonical.has('claude')).toBe(true)
    expect(canonical.has('neither')).toBe(true)
    // 'both' option removed 2026-06-06 (remove-both-import-option).
    expect(canonical.has('both')).toBe(false)
  })

  test('max_oauth_offered pick-only invariant: every advance_example uses an allowed canonical_value', () => {
    // 2026-05-28 single-CTA collapse: BYO + skip dropped. Only
    // `attach_max` remains in the allow-list; every advance example
    // must canonicalise to that value.
    const allowed: ReadonlySet<string> = new Set(['attach_max'])
    const pack = PHASE_KNOWLEDGE['max_oauth_offered']!
    expect(pack.advance_examples.length).toBeGreaterThan(0)
    for (const ex of pack.advance_examples) {
      expect(ex.canonical_value).not.toBeNull()
      expect(allowed.has(ex.canonical_value as string)).toBe(true)
    }
    // Every allowed value should be exemplified at least once so the
    // router has a few-shot anchor for every branch.
    const seen = new Set(pack.advance_examples.map((e) => e.canonical_value))
    for (const v of allowed) {
      expect(seen.has(v)).toBe(true)
    }
  })

  test('max_oauth_offered every expected_tangent.expected_action is answer (no amend examples on a pick-only phase)', () => {
    const pack = PHASE_KNOWLEDGE['max_oauth_offered']!
    for (const t of pack.expected_tangents) {
      expect(t.expected_action).toBe('answer')
    }
  })

  test('S3 packs cover the brief-named tangent shapes', () => {
    // Spot-check the high-leverage tangents the brief identified as the
    // five v3 failure-modes (slug-as-public-id curiosity, mid-list amend,
    // escape-hatch, revisit, verbose pick-only).
    const slug = PHASE_KNOWLEDGE['slug_chosen']!
    expect(
      slug.expected_tangents.some((t) =>
        t.user_text_example.toLowerCase().includes('other than the url'),
      ),
    ).toBe(true)

    const gapFill = PHASE_KNOWLEDGE['work_interview_gap_fill']!
    expect(
      gapFill.expected_tangents.some((t) =>
        t.user_text_example.toLowerCase().includes('skip the rest'),
      ),
    ).toBe(true)

    const projects = PHASE_KNOWLEDGE['projects_proposed']!
    expect(
      projects.expected_tangents.some(
        (t) =>
          t.expected_action === 'amend' &&
          t.user_text_example.toLowerCase().includes('drop'),
      ),
    ).toBe(true)

    const persona = PHASE_KNOWLEDGE['persona_reviewed']!
    // Argus r1 IMPORTANT (resolved r2): the 'personality feels off' and
    // 'change the name' tangents were originally `amend` with a
    // `revisit_target` state_delta hint, but the engine has no reader
    // for `revisit_target` in `consumePersonaReviewedChoice`. Per the
    // data-only fix, they're now `answer` tangents that route to the
    // `revisit_personality` / `revisit_agent_name` FAQs (the FAQ body
    // tells the user how to actually trigger a revisit). No
    // state_delta on these tangents — spec § 2.3 amend semantics now
    // preserved (sparse state delta acted on by engine).
    expect(
      persona.expected_tangents.some(
        (t) =>
          t.expected_action === 'answer' &&
          t.user_text_example.toLowerCase().includes('personality'),
      ),
    ).toBe(true)
    expect(
      persona.expected_tangents.some(
        (t) =>
          t.expected_action === 'answer' &&
          t.user_text_example.toLowerCase().includes('change the name'),
      ),
    ).toBe(true)
    // None of persona_reviewed's tangents should carry an amend action
    // until the engine grows a real handler for the resulting
    // state_delta key.
    expect(
      persona.expected_tangents.every((t) => t.expected_action === 'answer'),
    ).toBe(true)
    // The FAQ keys those tangents route to must still exist on the
    // pack (so the LLM has the answer text to surface).
    expect(typeof persona.faqs['revisit_personality']).toBe('string')
    expect(typeof persona.faqs['revisit_agent_name']).toBe('string')

    const max = PHASE_KNOWLEDGE['max_oauth_offered']!
    expect(
      max.advance_examples.some(
        (e) =>
          e.user_text_example.toLowerCase().includes('subscription') &&
          e.canonical_value === 'attach_max',
      ),
    ).toBe(true)
  })
})

describe('validatePhaseKnowledgePack rejection contract', () => {
  function baseValidPackPlain(): {
    why_we_ask: string
    faqs: Record<string, string>
    expected_tangents: Array<{
      user_text_example: string
      expected_action: string
      summary: string
    }>
    advance_examples: Array<{
      user_text_example: string
      canonical_value: string | null
      summary: string
    }>
  } {
    return {
      why_we_ask: 'asks the user something useful',
      faqs: { foo: 'short answer' },
      expected_tangents: [
        { user_text_example: 'why?', expected_action: 'answer', summary: 'route to faq' },
      ],
      advance_examples: [],
    }
  }

  function run(p: unknown): void {
    validatePhaseKnowledgePack(p as PhaseKnowledgePack, 'test')
  }

  test('throws when why_we_ask is empty', () => {
    const p = baseValidPackPlain()
    p.why_we_ask = ''
    expect(() => run(p)).toThrow()
  })

  test('throws when why_we_ask exceeds the length cap', () => {
    const p = baseValidPackPlain()
    p.why_we_ask = 'x'.repeat(601)
    expect(() => run(p)).toThrow()
  })

  test('throws when a faq value exceeds the length cap', () => {
    const p = baseValidPackPlain()
    p.faqs = { foo: 'y'.repeat(801) }
    expect(() => run(p)).toThrow()
  })

  test('throws when expected_tangents is empty', () => {
    const p = baseValidPackPlain()
    p.expected_tangents = []
    expect(() => run(p)).toThrow()
  })

  test('throws when an expected_tangents.summary is too long', () => {
    const p = baseValidPackPlain()
    p.expected_tangents[0]!.summary = 'z'.repeat(101)
    expect(() => run(p)).toThrow()
  })

  test('throws when an expected_tangents.expected_action is not answer/amend', () => {
    const p = baseValidPackPlain()
    p.expected_tangents[0]!.expected_action = 'advance'
    expect(() => run(p)).toThrow()
  })

  test('throws when advance_examples carries an empty canonical_value string', () => {
    const p = baseValidPackPlain()
    p.advance_examples = [
      { user_text_example: 'foo', canonical_value: '', summary: 'summary' },
    ]
    expect(() => run(p)).toThrow()
  })

  test('throws when advance_examples has too many entries', () => {
    const p = baseValidPackPlain()
    const long: Array<{
      user_text_example: string
      canonical_value: string | null
      summary: string
    }> = []
    for (let i = 0; i < 13; i += 1) {
      long.push({ user_text_example: `ex${i}`, canonical_value: null, summary: `s${i}` })
    }
    p.advance_examples = long
    expect(() => run(p)).toThrow()
  })
})
