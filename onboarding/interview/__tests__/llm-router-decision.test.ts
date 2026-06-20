/**
 * Sprint: P2-v3 S1 — LLM router decision envelope round-trip (2026-05-18).
 * Spec: docs/research/p2-v3-conversational-onboarding-design.md § 2.2 + § 2.5.
 *
 * Table-driven coverage for the JSON envelope → `RouterDecision` shape
 * mapping. Each row is a labelled fixture that names the decision shape
 * (advance / answer / amend, with/without choice_value, with/without
 * state_delta) plus the parser context and the expected projection.
 *
 * Sibling file `onboarding/interview/llm-router.test.ts` covers the
 * router's runtime behaviour (escalation, timeout, telemetry). This
 * file is the *contract test* for the parser surface alone.
 */

import { describe, expect, test } from 'bun:test'
import {
  parseRouterDecision,
  type ParseRouterDecisionContext,
  type RouterDecision,
} from '../llm-router.ts'

// ---------------------------------------------------------------------------
// Envelope builder
// ---------------------------------------------------------------------------

interface EnvelopeFixture {
  action: 'advance' | 'answer' | 'amend'
  confidence: number
  choice_value?: string | null
  freeform_text?: string | null
  response?: string | null
  state_delta?: Record<string, unknown> | null
  reasoning?: string
  candidate_alternatives?: Array<{
    action: 'advance' | 'answer' | 'amend'
    choice_value: string | null
    summary: string
  }>
}

function envelope(fix: EnvelopeFixture): string {
  return JSON.stringify({
    action: fix.action,
    confidence: fix.confidence,
    choice_value: fix.choice_value ?? null,
    freeform_text: fix.freeform_text ?? null,
    response: fix.response ?? null,
    state_delta: fix.state_delta ?? null,
    reasoning: fix.reasoning ?? 'fixture',
    candidate_alternatives: fix.candidate_alternatives ?? [],
  })
}

// ---------------------------------------------------------------------------
// Table-driven happy-path round-trip
// ---------------------------------------------------------------------------

type Row = {
  label: string
  fixture: EnvelopeFixture
  ctx?: ParseRouterDecisionContext
  /** Projection assertion. `null` means "expect parseRouterDecision to
   *  return null" (the failure-path rows). */
  expected: Partial<RouterDecision> | null
}

const HAPPY_ROWS: ReadonlyArray<Row> = [
  // --- advance shapes ---
  {
    label: 'advance / pick-only / canonical choice_value',
    fixture: {
      action: 'advance',
      confidence: 0.92,
      choice_value: 'attach_max',
      reasoning: 'user picked Max',
    },
    ctx: {
      allowed_choice_values: ['attach_max', 'byo_key', 'skip'],
      pick_only: true,
    },
    expected: {
      action: 'advance',
      confidence: 0.92,
      choice_value: 'attach_max',
      freeform_text: null,
      response: null,
      state_delta: null,
      reasoning: 'user picked Max',
    },
  },
  {
    label: 'advance / pick-or-text / canonical option',
    fixture: {
      action: 'advance',
      confidence: 0.91,
      choice_value: 'claude',
      reasoning: 'user said claude',
    },
    ctx: { allowed_choice_values: ['chatgpt', 'claude', 'neither'] },
    expected: {
      action: 'advance',
      confidence: 0.91,
      choice_value: 'claude',
    },
  },
  {
    label: 'advance / pick-or-text / freeform (choice_value null)',
    fixture: {
      action: 'advance',
      confidence: 0.88,
      choice_value: null,
      freeform_text: 'northwind-labs',
      reasoning: 'custom slug',
    },
    ctx: { allowed_choice_values: ['skip'] },
    expected: {
      action: 'advance',
      confidence: 0.88,
      choice_value: null,
      freeform_text: 'northwind-labs',
    },
  },
  {
    label: 'advance / free-text / no options surfaced',
    fixture: {
      action: 'advance',
      confidence: 0.9,
      freeform_text: 'Sam',
      reasoning: 'name capture',
    },
    expected: {
      action: 'advance',
      confidence: 0.9,
      freeform_text: 'Sam',
      choice_value: null,
    },
  },
  {
    // Argus r2 / Codex r2 BLOCKING #1 happy-path counterpart — even with
    // an explicit empty allow-list (as parseCtxFromInput now always sets),
    // a freeform-bearing advance is still valid.
    label: 'advance / free-text / explicit empty allow-list / freeform reply',
    fixture: {
      action: 'advance',
      confidence: 0.9,
      choice_value: null,
      freeform_text: 'user typed something',
      reasoning: 'name capture w/ empty allow-list ctx',
    },
    ctx: { allowed_choice_values: [] },
    expected: {
      action: 'advance',
      confidence: 0.9,
      choice_value: null,
      freeform_text: 'user typed something',
    },
  },
  // --- answer shapes ---
  {
    label: 'answer / tangent FAQ',
    fixture: {
      action: 'answer',
      confidence: 0.95,
      response: 'Claude export lives at Settings → Privacy → Data Controls.',
      reasoning: 'tangent: claude steps',
    },
    expected: {
      action: 'answer',
      response: 'Claude export lives at Settings → Privacy → Data Controls.',
      choice_value: null,
      freeform_text: null,
      state_delta: null,
    },
  },
  {
    // Argus r2 / Codex r2 BLOCKING #2 happy-path counterpart — a normal,
    // well-formed answer with a non-empty response body parses cleanly.
    label: 'answer / well-formed response (BLOCKING #2 happy-path)',
    fixture: {
      action: 'answer',
      confidence: 0.93,
      response: 'Here is the Claude export path: Settings → Privacy → Data Controls.',
      reasoning: 'tangent claude',
    },
    expected: {
      action: 'answer',
      response: 'Here is the Claude export path: Settings → Privacy → Data Controls.',
    },
  },
  {
    label: 'answer / ask-clarify body with candidates',
    fixture: {
      action: 'answer',
      confidence: 0.92,
      response: 'Did you mean ChatGPT or Claude?',
      reasoning: 'clarify',
      candidate_alternatives: [
        { action: 'advance', choice_value: 'chatgpt', summary: 'go with chatgpt' },
        { action: 'advance', choice_value: 'claude', summary: 'go with claude' },
      ],
    },
    expected: {
      action: 'answer',
      response: 'Did you mean ChatGPT or Claude?',
    },
  },
  // --- amend shapes ---
  {
    label: 'amend / agent_name update',
    fixture: {
      action: 'amend',
      confidence: 0.94,
      state_delta: { agent_name: 'Aria' },
      response: 'Got it - calling you Doe. So whats your name?',
      reasoning: 'address pref',
    },
    expected: {
      action: 'amend',
      state_delta: { agent_name: 'Aria' },
      response: 'Got it - calling you Doe. So whats your name?',
      choice_value: null,
      freeform_text: null,
    },
  },
  {
    label: 'amend / primary_projects extension',
    fixture: {
      action: 'amend',
      confidence: 0.9,
      state_delta: { primary_projects: ['Topline', 'Acme', 'Neutron'] },
      response: 'Added Neutron to your project list.',
      reasoning: 'project add',
    },
    expected: {
      action: 'amend',
      state_delta: { primary_projects: ['Topline', 'Acme', 'Neutron'] },
    },
  },
]

describe('parseRouterDecision — happy-path round-trip', () => {
  for (const row of HAPPY_ROWS) {
    test(row.label, () => {
      const out = parseRouterDecision(envelope(row.fixture), row.ctx)
      expect(out).not.toBeNull()
      const decision = out!
      const expected = row.expected!
      for (const key of Object.keys(expected) as Array<keyof RouterDecision>) {
        expect(decision[key]).toEqual(expected[key] as never)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Table-driven failure-path coverage
// ---------------------------------------------------------------------------

const FAILURE_ROWS: ReadonlyArray<
  { label: string; raw: string; ctx?: ParseRouterDecisionContext }
> = [
  { label: 'malformed JSON — random text', raw: 'this is not json' },
  { label: 'malformed JSON — partial object', raw: '{' },
  { label: 'malformed JSON — empty string', raw: '' },
  { label: 'top-level null', raw: 'null' },
  { label: 'top-level array', raw: '[]' },
  {
    label: 'missing action',
    raw: JSON.stringify({ confidence: 0.9, reasoning: 'x' }),
  },
  {
    label: 'unknown action token',
    raw: envelope({ action: 'foo' as never, confidence: 0.9 }),
  },
  {
    label: 'confidence > 1',
    raw: envelope({ action: 'advance', confidence: 1.5 }),
  },
  {
    label: 'confidence < 0',
    raw: envelope({ action: 'advance', confidence: -0.1 }),
  },
  {
    label: 'confidence non-finite',
    raw: envelope({ action: 'advance', confidence: NaN }),
  },
  {
    label: 'choice_value not in allow-list',
    raw: envelope({
      action: 'advance',
      confidence: 0.9,
      choice_value: 'unknown',
    }),
    ctx: { allowed_choice_values: ['skip'] },
  },
  {
    label: 'pick_only=true with null choice_value on advance',
    raw: envelope({
      action: 'advance',
      confidence: 0.9,
      choice_value: null,
    }),
    ctx: {
      pick_only: true,
      allowed_choice_values: ['attach_max', 'byo_key', 'skip'],
    },
  },
  {
    label: 'advance with BOTH null choice_value AND null freeform_text (Codex r1 P2)',
    raw: envelope({
      action: 'advance',
      confidence: 0.95,
      choice_value: null,
      freeform_text: null,
    }),
  },
  {
    // Argus r2 / Codex r2 BLOCKING #1 — free-text phase (empty allow-list)
    // MUST reject any non-null choice_value on advance. Without this, the
    // LLM can hallucinate a canonical button selection (e.g. "skip") on a
    // free-text prompt and the engine routes through the wrong branch
    // while silently dropping the user's actual reply.
    label: 'advance with hallucinated choice_value on free-text phase (allow-list empty)',
    raw: envelope({
      action: 'advance',
      confidence: 0.9,
      choice_value: 'skip',
      freeform_text: null,
      reasoning: 'hallucinated canonical token',
    }),
    ctx: { allowed_choice_values: [] },
  },
  {
    // Argus r2 / Codex r2 BLOCKING #2 — `action='answer'` MUST carry a
    // non-null `response`. The whole point of `answer` is the in-context
    // reply body; a null response wires the engine into "stay on phase,
    // emit nothing" silent no-op.
    label: 'answer with null response (BLOCKING #2)',
    raw: envelope({
      action: 'answer',
      confidence: 0.9,
      response: null,
      reasoning: 'forgot to fill response',
    }),
  },
  {
    label: 'answer with empty-string response (BLOCKING #2)',
    raw: envelope({
      action: 'answer',
      confidence: 0.9,
      response: '',
      reasoning: 'empty body is also a no-op',
    }),
  },
  {
    // NON-empty state_delta on a non-amend action stays a reject — only the
    // EMPTY {} case is normalized (§ 2.2.1; hybrid amend+advance deferred).
    label: 'answer with stray state_delta',
    raw: envelope({
      action: 'answer',
      confidence: 0.9,
      state_delta: { agent_name: 'X' },
      response: 'hi',
    }),
  },
  {
    label: 'amend with null state_delta',
    raw: envelope({
      action: 'amend',
      confidence: 0.9,
      state_delta: null,
    }),
  },
  {
    // {} normalizes to null first, then "amend needs a non-empty state_delta"
    // rejects — so an amend that emitted {} still fails (§ 2.2.1).
    label: 'amend with empty state_delta',
    raw: envelope({
      action: 'amend',
      confidence: 0.9,
      state_delta: {},
    }),
  },
  {
    label: 'reserved sentinel __freeform__ as choice_value',
    raw: envelope({
      action: 'advance',
      confidence: 0.9,
      choice_value: '__freeform__',
    }),
  },
  {
    label: 'reserved sentinel __timeout__ as choice_value',
    raw: envelope({
      action: 'advance',
      confidence: 0.9,
      choice_value: '__timeout__',
    }),
  },
  // NOTE (envelope-conformance round 2): the four prior reject rows —
  // `reasoning over 200 chars`, `candidate_alternatives entry missing summary`,
  // `candidate_alternatives summary over 80 chars`, and
  // `candidate_alternatives entry with bad action token` — are now RECOVERABLE
  // diagnostic-field violations. They NORMALIZE (truncate/drop) instead of
  // rejecting; their positive coverage lives in the normalization describe
  // block below.
  {
    label: 'state_delta not a plain object (string)',
    raw: JSON.stringify({
      action: 'amend',
      confidence: 0.9,
      choice_value: null,
      freeform_text: null,
      response: null,
      state_delta: 'not-an-object',
      reasoning: 'x',
    }),
  },
  {
    label: 'state_delta not a plain object (array)',
    raw: JSON.stringify({
      action: 'amend',
      confidence: 0.9,
      choice_value: null,
      freeform_text: null,
      response: null,
      state_delta: ['agent_name'],
      reasoning: 'x',
    }),
  },
  {
    label: 'freeform_text wrong type (number)',
    raw: JSON.stringify({
      action: 'advance',
      confidence: 0.9,
      choice_value: null,
      freeform_text: 42,
      response: null,
      state_delta: null,
      reasoning: 'x',
    }),
  },
  {
    label: 'response wrong type (object)',
    raw: JSON.stringify({
      action: 'answer',
      confidence: 0.9,
      choice_value: null,
      freeform_text: null,
      response: { body: 'x' },
      state_delta: null,
      reasoning: 'x',
    }),
  },
  {
    label: 'choice_value wrong type (number)',
    raw: JSON.stringify({
      action: 'advance',
      confidence: 0.9,
      choice_value: 7,
      freeform_text: null,
      response: null,
      state_delta: null,
      reasoning: 'x',
    }),
  },
]

describe('parseRouterDecision — failure-path coverage', () => {
  for (const row of FAILURE_ROWS) {
    test(row.label, () => {
      expect(parseRouterDecision(row.raw, row.ctx)).toBeNull()
    })
  }
})

// ---------------------------------------------------------------------------
// Normalization coverage (envelope-conformance sprint 2026-06-05, § 2.2.1)
//
// These were FAILURE rows pre-sprint (strict-reject). The parser now NORMALIZES
// recoverable contract violations instead of rejecting them into the
// synthesised "say it again" stall: spurious advance-only fields are dropped on
// non-advance actions, and an empty state_delta {} is treated as null. Each row
// asserts the envelope PARSES and the offending field was coerced.
// ---------------------------------------------------------------------------

describe('parseRouterDecision — normalization (§ 2.2.1)', () => {
  test('answer with stray choice_value → parses, choice_value dropped to null', () => {
    const out = parseRouterDecision(
      envelope({
        action: 'answer',
        confidence: 0.9,
        choice_value: 'skip',
        response: 'hi',
      }),
    )
    expect(out).not.toBeNull()
    expect(out!.action).toBe('answer')
    expect(out!.choice_value).toBeNull()
    expect(out!.response).toBe('hi')
  })

  test('answer with stray freeform_text → parses, freeform_text dropped to null', () => {
    const out = parseRouterDecision(
      envelope({
        action: 'answer',
        confidence: 0.9,
        freeform_text: 'hi',
        response: 'hi',
      }),
    )
    expect(out).not.toBeNull()
    expect(out!.action).toBe('answer')
    expect(out!.freeform_text).toBeNull()
  })

  test('amend with stray choice_value → parses, choice_value dropped, real state_delta survives', () => {
    const out = parseRouterDecision(
      envelope({
        action: 'amend',
        confidence: 0.9,
        choice_value: 'skip',
        state_delta: { agent_name: 'X' },
      }),
    )
    expect(out).not.toBeNull()
    expect(out!.action).toBe('amend')
    expect(out!.choice_value).toBeNull()
    expect(out!.state_delta).toEqual({ agent_name: 'X' })
  })

  test('advance with empty state_delta {} → parses, state_delta normalized to null', () => {
    const out = parseRouterDecision(
      envelope({
        action: 'advance',
        confidence: 0.9,
        choice_value: 'skip',
        state_delta: {},
      }),
      { allowed_choice_values: ['skip'] },
    )
    expect(out).not.toBeNull()
    expect(out!.action).toBe('advance')
    expect(out!.state_delta).toBeNull()
  })

  // Round 2 — diagnostic-only field repair (these were FAILURE rows pre-round-2).
  test('reasoning over 200 chars → parses, reasoning truncated to 200', () => {
    const out = parseRouterDecision(
      envelope({
        action: 'answer',
        confidence: 0.9,
        response: 'hi',
        reasoning: 'x'.repeat(201),
      }),
    )
    expect(out).not.toBeNull()
    expect(out!.reasoning.length).toBe(200)
  })

  test('candidate_alternatives entry missing summary → parses, bad entry dropped', () => {
    const out = parseRouterDecision(
      JSON.stringify({
        action: 'answer',
        confidence: 0.9,
        choice_value: null,
        freeform_text: null,
        response: 'here you go',
        state_delta: null,
        reasoning: 'low',
        candidate_alternatives: [{ action: 'advance', choice_value: 'skip' }],
      }),
    )
    expect(out).not.toBeNull()
    expect(out!.action).toBe('answer')
  })

  test('candidate_alternatives summary over 80 chars → parses (THE round-2 prod stall)', () => {
    const out = parseRouterDecision(
      JSON.stringify({
        action: 'amend',
        confidence: 0.95,
        choice_value: null,
        freeform_text: null,
        response: 'got it',
        state_delta: { primary_projects: ['Northwind'] },
        reasoning: 'corrected',
        candidate_alternatives: [
          { action: 'advance', choice_value: null, summary: 'y'.repeat(120) },
        ],
      }),
    )
    expect(out).not.toBeNull()
    expect(out!.action).toBe('amend')
    expect(out!.state_delta).toEqual({ primary_projects: ['Northwind'] })
  })

  test('candidate_alternatives entry with bad action token → parses, bad entry dropped', () => {
    const out = parseRouterDecision(
      JSON.stringify({
        action: 'answer',
        confidence: 0.9,
        choice_value: null,
        freeform_text: null,
        response: 'here you go',
        state_delta: null,
        reasoning: 'low',
        candidate_alternatives: [
          { action: 'forge_ahead', choice_value: 'skip', summary: 'go' },
        ],
      }),
    )
    expect(out).not.toBeNull()
    expect(out!.action).toBe('answer')
  })

  test('hybrid amend+advance: advance carrying a non-empty state_delta parses (§ 2.3)', () => {
    const out = parseRouterDecision(
      envelope({
        action: 'advance',
        confidence: 0.98,
        choice_value: null,
        freeform_text: 'Northwind, Acme, a book',
        state_delta: { primary_projects: ['Northwind', 'Acme', 'Book'] },
      }),
      { allowed_choice_values: [] },
    )
    expect(out).not.toBeNull()
    expect(out!.action).toBe('advance')
    expect(out!.state_delta).toEqual({
      primary_projects: ['Northwind', 'Acme', 'Book'],
    })
  })
})

// ---------------------------------------------------------------------------
// Fence-stripping + tolerant parsing
// ---------------------------------------------------------------------------

describe('parseRouterDecision — fence tolerance', () => {
  test('strips ```json ... ``` fences', () => {
    const raw =
      '```json\n' +
      envelope({
        action: 'answer',
        confidence: 0.92,
        response: 'sure',
        reasoning: 'ok',
      }) +
      '\n```'
    const out = parseRouterDecision(raw)
    expect(out).not.toBeNull()
    expect(out!.action).toBe('answer')
  })

  test('strips bare ``` ... ``` fences', () => {
    const raw =
      '```\n' +
      envelope({
        action: 'answer',
        confidence: 0.92,
        response: 'sure',
        reasoning: 'ok',
      }) +
      '\n```'
    const out = parseRouterDecision(raw)
    expect(out).not.toBeNull()
  })

  test('tolerates leading/trailing whitespace', () => {
    const raw =
      '   \n  ' +
      envelope({
        action: 'answer',
        confidence: 0.92,
        response: 'sure',
        reasoning: 'ok',
      }) +
      '  \n'
    const out = parseRouterDecision(raw)
    expect(out).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// No-context parse path — same shape rules without allow-list checking
// ---------------------------------------------------------------------------

describe('parseRouterDecision — no-context calls', () => {
  test('accepts advance with arbitrary choice_value when no allow-list context is supplied', () => {
    const out = parseRouterDecision(
      envelope({
        action: 'advance',
        confidence: 0.9,
        choice_value: 'anything',
        reasoning: 'no ctx',
      }),
    )
    expect(out).not.toBeNull()
    expect(out!.choice_value).toBe('anything')
  })

  test('still rejects reserved sentinels even with no context', () => {
    const out = parseRouterDecision(
      envelope({
        action: 'advance',
        confidence: 0.9,
        choice_value: '__cancel__',
      }),
    )
    expect(out).toBeNull()
  })
})
