/**
 * T7 (2026-05-14) — substrate-callers regression tests. Per
 * docs/plans/P2-onboarding-v2.md § 1.3 + the archived v1 § 4.7 (runner
 * contract). 2026-05-31 Sam-locked update: Pass-1 default model is
 * BEST_MODEL (Opus 4.7), NOT FAST_MODEL (Haiku 4.5). See
 * `substrate-callers.ts` file header for the rationale.
 *
 * Walks the production substrate → Pass-1 / Pass-2 caller path with a
 * deterministic Substrate stub. Verifies:
 *
 *   1. Pass-1 caller invokes `substrate.start` with model_preference[0] =
 *      claude-opus-4-8 AND the supplied pass1Prompt as a system message.
 *   2. Pass-2 caller invokes `substrate.start` with model_preference[0] =
 *      claude-opus-4-8 AND the supplied pass2Prompt as a system message.
 *   3. Both callers return `{result, dollars_billed}` matching the
 *      Pass1LlmCall / Pass2LlmCall interfaces.
 *   4. Markdown-fenced JSON output is extracted correctly (extractJsonObject).
 *   5. An `error` event before completion bubbles as ImportError.
 *   6. A completion-without-tokens turn returns result=null + 0 dollars.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildPass1SubstrateCaller,
  buildPass2SubstrateCaller,
  extractJsonObject,
} from '../substrate-callers.ts'
import { FAST_MODEL, BEST_MODEL, setBestModelOverride } from '../../../runtime/models.ts'
import type { Substrate, AgentSpec } from '../../../runtime/substrate.ts'
import type { Event } from '../../../runtime/events.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'
import { ImportError, type Chunk } from '../types.ts'
import type { AggregatedPass1 } from '../pass2-synthesis.ts'

interface RecordedCall {
  spec: AgentSpec
}

function makeSubstrateStub(events: ReadonlyArray<Event>): { substrate: Substrate; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      calls.push({ spec })
      const evIter = (async function* () {
        for (const ev of events) yield ev
      })()
      return {
        events: evIter,
        respondToTool: () => Promise.reject(new Error('tool_resolution=internal')),
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  }
  return { substrate, calls }
}

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    chunk_hash: 'h-1',
    conversation_id: 'c-1',
    chunk_index: 0,
    text: 'USER: hi from Casey\nUSER: also Topline status',
    byte_length: 50,
    approx_tokens: 12,
    ...overrides,
  }
}

function makeAggregated(): AggregatedPass1 {
  return {
    entities: [{ name: 'Casey', kind: 'person', mention_count: 4 }],
    topics: [{ name: 'Topline', recurrence_score: 2, recency_score: 1, summaries: ['Q3 invoice'] }],
    tasks: [{ title: 'Reply to Priya', priority_hint: 'P1' }],
    voice_signals: { tone: 'terse' },
    totals: { chunks: 5, entities_seen: 12, topics_seen: 4, tasks_seen: 3 },
  }
}

describe('buildPass1SubstrateCaller — Opus 4.7 dispatch (2026-05-31 Sam-locked)', () => {
  test('invokes substrate.start with model_preference=[BEST_MODEL] + system prompt + chunk-text user turn', async () => {
    const { substrate, calls } = makeSubstrateStub([
      { kind: 'token', text: '{"candidate_entities":[]}' },
      {
        kind: 'completion',
        usage: { input_tokens: 100, output_tokens: 50 },
        substrate_instance_id: 'cc-test',
      },
    ])
    const pass1 = buildPass1SubstrateCaller({ substrate })
    const out = await pass1({
      chunk: makeChunk({ text: 'USER: hi from Casey' }),
      prompt: 'PASS-1 PROMPT BODY',
    })
    expect(calls.length).toBe(1)
    // 2026-05-31 — Pass-1 default is Opus 4.7, not Haiku 4.5. See
    // substrate-callers.ts file header for the Sam-locked rationale.
    expect(calls[0]!.spec.model_preference[0]).toBe(BEST_MODEL)
    expect(calls[0]!.spec.model_preference[0]).toBe('claude-opus-4-8')
    // Codex r3 P1 (T7 forge-fix r3): system + user are combined into one
    // user-turn `prompt` because the Anthropic Messages API doesn't
    // accept `role:'system'` inside messages. No `messages` array shipped.
    expect(calls[0]!.spec.messages).toBeUndefined()
    expect(calls[0]!.spec.prompt).toContain('PASS-1 PROMPT BODY')
    expect(calls[0]!.spec.prompt).toContain('USER: hi from Casey')
    expect(calls[0]!.spec.prompt).toContain('conversation_id: c-1')
    // Empty tools surface (no MCP needed for triage).
    expect(calls[0]!.spec.tools).toEqual([])
    // Result is the parsed JSON object.
    expect(out.result).toEqual({ candidate_entities: [] })
    // Dollars billed at Opus 4.7 rates ($5/MTok input + $25/MTok output,
    // verified 2026-05-17 from docs.claude.com): (100*5 + 50*25)/1M.
    expect(out.dollars_billed).toBeCloseTo((100 * 5 + 50 * 25) / 1_000_000, 8)
  })

  test('respects model_preference override (cost-sensitive BYO-API-key owners can opt down to Haiku/Sonnet)', async () => {
    const { substrate, calls } = makeSubstrateStub([
      { kind: 'token', text: '{}' },
      { kind: 'completion', usage: { input_tokens: 0, output_tokens: 0 }, substrate_instance_id: 'x' },
    ])
    const pass1 = buildPass1SubstrateCaller({
      substrate,
      model_preference: [FAST_MODEL, BEST_MODEL],
    })
    await pass1({ chunk: makeChunk(), prompt: 'p' })
    expect(calls[0]!.spec.model_preference).toEqual([FAST_MODEL, BEST_MODEL])
  })

  test('parses markdown-fenced JSON output (Anthropic emit quirk)', async () => {
    const { substrate } = makeSubstrateStub([
      {
        kind: 'token',
        text: 'Here you go:\n```json\n{"candidate_entities":[{"name":"X","kind":"person","mention_count":2}]}\n```',
      },
      { kind: 'completion', usage: { input_tokens: 10, output_tokens: 20 }, substrate_instance_id: 'x' },
    ])
    const pass1 = buildPass1SubstrateCaller({ substrate, pricing: { input_usd_per_m: 0, output_usd_per_m: 0 } })
    const out = await pass1({ chunk: makeChunk(), prompt: 'p' })
    expect(out.result).toEqual({
      candidate_entities: [{ name: 'X', kind: 'person', mention_count: 2 }],
    })
  })

  test('returns result=null when the model emits no parseable JSON', async () => {
    const { substrate } = makeSubstrateStub([
      { kind: 'token', text: 'sorry, no idea' },
      { kind: 'completion', usage: { input_tokens: 5, output_tokens: 5 }, substrate_instance_id: 'x' },
    ])
    const pass1 = buildPass1SubstrateCaller({ substrate, pricing: { input_usd_per_m: 0, output_usd_per_m: 0 } })
    const out = await pass1({ chunk: makeChunk(), prompt: 'p' })
    expect(out.result).toBeNull()
  })

  test('error event before completion throws ImportError(substrate_error)', async () => {
    const { substrate } = makeSubstrateStub([
      { kind: 'error', message: '503 backend down', retryable: true },
    ])
    const pass1 = buildPass1SubstrateCaller({ substrate })
    await expect(pass1({ chunk: makeChunk(), prompt: 'p' })).rejects.toBeInstanceOf(ImportError)
    try {
      await pass1({ chunk: makeChunk(), prompt: 'p' })
    } catch (err) {
      const e = err as ImportError
      expect(e.code).toBe('substrate_error')
      expect(e.message).toContain('503 backend down')
    }
  })

  test('stream without a completion event throws ImportError(substrate_error)', async () => {
    const { substrate } = makeSubstrateStub([
      { kind: 'token', text: '{}' },
    ])
    const pass1 = buildPass1SubstrateCaller({ substrate })
    await expect(pass1({ chunk: makeChunk(), prompt: 'p' })).rejects.toBeInstanceOf(ImportError)
  })

  test('dollars accounting respects pricing override (test seam)', async () => {
    const { substrate } = makeSubstrateStub([
      { kind: 'token', text: '{}' },
      { kind: 'completion', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 }, substrate_instance_id: 'x' },
    ])
    const pass1 = buildPass1SubstrateCaller({
      substrate,
      pricing: { input_usd_per_m: 1, output_usd_per_m: 2 },
    })
    const out = await pass1({ chunk: makeChunk(), prompt: 'p' })
    expect(out.dollars_billed).toBeCloseTo(3, 5)
  })
})

describe('buildPass2SubstrateCaller — § 2.3 Opus 4.7 dispatch', () => {
  test('invokes substrate.start with model_preference=[BEST_MODEL] + system prompt + aggregated JSON user turn', async () => {
    const { substrate, calls } = makeSubstrateStub([
      {
        kind: 'token',
        text: '{"proposed_projects":[{"name":"Topline","rationale":"top topic","suggested_topics":["sales"]}]}',
      },
      { kind: 'completion', usage: { input_tokens: 500, output_tokens: 250 }, substrate_instance_id: 'x' },
    ])
    const pass2 = buildPass2SubstrateCaller({ substrate })
    const out = await pass2({ aggregated: makeAggregated(), prompt: 'PASS-2 PROMPT BODY' })
    expect(calls.length).toBe(1)
    expect(calls[0]!.spec.model_preference[0]).toBe(BEST_MODEL)
    expect(calls[0]!.spec.model_preference[0]).toBe('claude-opus-4-8')
    // Codex r3 P1: single user-turn body, no messages array.
    expect(calls[0]!.spec.messages).toBeUndefined()
    expect(calls[0]!.spec.prompt).toContain('PASS-2 PROMPT BODY')
    // User-turn payload includes the aggregated JSON.
    expect(calls[0]!.spec.prompt).toContain('"entities"')
    expect(calls[0]!.spec.prompt).toContain('"Casey"')
    expect(calls[0]!.spec.tools).toEqual([])
    // Result parsed.
    const r = out.result as { proposed_projects: Array<{ name: string }> }
    expect(r.proposed_projects[0]!.name).toBe('Topline')
    // Dollars at Opus 4.7 rates — $5/MTok input, $25/MTok output.
    // Verified 2026-05-17 from docs.claude.com/en/docs/about-claude/models/overview.
    // Pre-S22 the constants were the legacy Opus 4.1 rates ($15/$75); the
    // arithmetic below used those numbers and would now read 3× the truth.
    expect(out.dollars_billed).toBeCloseTo(
      (500 * 5 + 250 * 25) / 1_000_000,
      8,
    )
  })

  test('error event throws ImportError(substrate_error)', async () => {
    const { substrate } = makeSubstrateStub([
      { kind: 'error', message: '429 rate limited', retryable: true, retry_after_ms: 60_000 },
    ])
    const pass2 = buildPass2SubstrateCaller({ substrate })
    await expect(pass2({ aggregated: makeAggregated(), prompt: 'p' })).rejects.toBeInstanceOf(ImportError)
  })
})

// ---------------------------------------------------------------------------
// P2-v2 S23 — registry-driven pricing regression tests.
//
// Pre-S23 substrate-callers.ts inlined `HAIKU_4_5_*`, `OPUS_4_7_*`, and
// `SONNET_4_6_*` constants. Two follow-up bugs from S21 R2 / S22 R3:
//
//   1. Fallback pricing was hard-coded to Sonnet 4.6 rates regardless of
//      what `NEUTRON_SONNET_MODEL` resolved to — a same-shape bug as the
//      S21 R1 "fallback billed at Opus rates" issue, shifted one layer.
//   2. Haiku 4.5 was pinned at $0.8/$4.0 (legacy Haiku 3.5 rates), not the
//      $1/$5 verified at docs.claude.com on 2026-05-17.
//
// These tests pin the new contract: pricing is resolved from the model id
// actually dispatched, via `runtime/model-pricing.ts`. An unknown model id
// throws at build time (loud-fail beats silent-mis-bill).
// ---------------------------------------------------------------------------

describe('S23 — Pass-1 bills against registry rates (Opus 4.7 default per 2026-05-31)', () => {
  test('default Pass-1 dispatch bills at Opus 4.7 rates ($5 input + $25 output per MTok)', async () => {
    const { substrate } = makeSubstrateStub([
      { kind: 'token', text: '{}' },
      {
        kind: 'completion',
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        substrate_instance_id: 'x',
      },
    ])
    // No pricing override — production defaults exercised. 2026-05-31:
    // Pass-1 default model is BEST_MODEL (Opus 4.7), so the bill matches
    // Opus's rate table.
    const pass1 = buildPass1SubstrateCaller({ substrate })
    const out = await pass1({ chunk: makeChunk(), prompt: 'p' })
    // Opus 4.7: 1M*$5 + 1M*$25 = $30.
    expect(out.dollars_billed).toBeCloseTo(30, 5)
    // Sanity guard: a reading below $25 indicates a regression to the
    // pre-2026-05-31 Haiku 4.5 default rates ($1/$5 → $6 total).
    expect(out.dollars_billed).toBeGreaterThan(25)
  })

  test('Pass-1 with explicit Haiku model_preference still bills against Haiku 4.5 rates', async () => {
    const { substrate } = makeSubstrateStub([
      { kind: 'token', text: '{}' },
      {
        kind: 'completion',
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        substrate_instance_id: 'x',
      },
    ])
    // Explicit opt-down to Haiku 4.5 — pricing follows the model id.
    const pass1 = buildPass1SubstrateCaller({
      substrate,
      model_preference: [FAST_MODEL],
    })
    const out = await pass1({ chunk: makeChunk(), prompt: 'p' })
    // Haiku 4.5: 1M*$1 + 1M*$5 = $6.
    expect(out.dollars_billed).toBeCloseTo(6, 5)
  })

  test('Pass-1 with model_preference pointed at unknown id throws at build time', async () => {
    const { substrate } = makeSubstrateStub([])
    // Simulate an operator typo by passing model_preference pointing at
    // an unregistered id. The throw must surface a known-models list so
    // the operator can self-diagnose without grepping source.
    let caught: unknown = null
    try {
      buildPass1SubstrateCaller({
        substrate,
        model_preference: ['claude-some-future-haiku-typo'],
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).toContain('claude-some-future-haiku-typo')
    expect(msg).toContain('claude-haiku-4-5')
  })
})

describe('S23 — Pass-2 bills against registry rates per-model, fallback included', () => {
  test('Pass-2 primary success bills against Opus 4.7 registry rate ($5/$25)', async () => {
    const { substrate } = makeSubstrateStub([
      { kind: 'token', text: '{}' },
      {
        kind: 'completion',
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        substrate_instance_id: 'x',
      },
    ])
    const pass2 = buildPass2SubstrateCaller({ substrate })
    const out = await pass2({ aggregated: makeAggregated(), prompt: 'p' })
    // Opus 4.7: 1M*$5 + 1M*$25 = $30.
    expect(out.dollars_billed).toBeCloseTo(30, 5)
  })

  test('Pass-2 unknown primary model id throws at build time (no silent rate fallback)', async () => {
    const { substrate } = makeSubstrateStub([])
    let caught: unknown = null
    try {
      buildPass2SubstrateCaller({
        substrate,
        model_preference: ['claude-opus-typo-9-9'],
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('claude-opus-typo-9-9')
  })

  test('Pass-2 unknown fallback_model_preference throws at build time (would-be silent-mis-bill)', async () => {
    const { substrate } = makeSubstrateStub([])
    let caught: unknown = null
    try {
      buildPass2SubstrateCaller({
        substrate,
        fallback_model_preference: ['claude-sonnet-typo-9-9'],
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).toContain('claude-sonnet-typo-9-9')
    // Operator gets the registered alternatives in the throw message.
    expect(msg).toContain('claude-sonnet-4-6')
  })
})

describe('extractJsonObject — defensive parsing', () => {
  test('direct JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 })
  })

  test('markdown ```json fence', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  test('markdown unlabeled ``` fence', () => {
    expect(extractJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  test('preamble + first-object slice', () => {
    expect(extractJsonObject('Here is the result: {"a":1, "b":[2,3]} done.')).toEqual({
      a: 1,
      b: [2, 3],
    })
  })

  test('preamble + nested object', () => {
    expect(extractJsonObject('Output: {"a":{"x":1}} ok')).toEqual({ a: { x: 1 } })
  })

  test('quoted-brace inside string does not unbalance', () => {
    expect(extractJsonObject('{ "k": "value with } brace" }')).toEqual({
      k: 'value with } brace',
    })
  })

  test('empty input → null', () => {
    expect(extractJsonObject('')).toBeNull()
    expect(extractJsonObject('   ')).toBeNull()
  })

  test('garbage → null', () => {
    expect(extractJsonObject('this is not JSON at all')).toBeNull()
  })
})

describe('always-latest (2026-06-30) — import survives a watchdog-adopted UNPRICED model', () => {
  // Regression for the Codex cross-model review finding: the import default is
  // now the dynamic getBestModel(); when the model-update watchdog adopts a
  // brand-new top-tier id BEFORE a pricing row exists, the caller must NOT throw
  // at construction (that would break onboarding/imports). dollars_billed is
  // telemetry-only, so it degrades to $0 (with a one-time warn) instead.
  const UNPRICED = 'claude-opus-9-9' // not in MODEL_PRICING_TABLE

  test('buildPass1SubstrateCaller constructs + runs, billing $0 on an unpriced latest model', async () => {
    setBestModelOverride(UNPRICED)
    try {
      const { substrate, calls } = makeSubstrateStub([
        { kind: 'token', text: '{"candidate_entities":[]}' },
        { kind: 'completion', usage: { input_tokens: 100, output_tokens: 50 }, substrate_instance_id: 'cc' },
      ])
      // Must NOT throw at construction (the regression).
      const pass1 = buildPass1SubstrateCaller({ substrate })
      const out = await pass1({ chunk: makeChunk(), prompt: 'P1' })
      // The import RAN on the latest (unpriced) model…
      expect(calls[0]!.spec.model_preference[0]).toBe(UNPRICED)
      // …and billing degraded to $0 rather than crashing.
      expect(out.dollars_billed).toBe(0)
    } finally {
      setBestModelOverride(undefined)
    }
  })

  test('buildPass2SubstrateCaller constructs + runs on an unpriced latest model', async () => {
    setBestModelOverride(UNPRICED)
    try {
      const { substrate, calls } = makeSubstrateStub([
        { kind: 'token', text: '{"projects":[]}' },
        { kind: 'completion', usage: { input_tokens: 10, output_tokens: 5 }, substrate_instance_id: 'cc' },
      ])
      const pass2 = buildPass2SubstrateCaller({ substrate })
      const out = await pass2({ aggregated: makeAggregated(), prompt: 'P2' })
      expect(calls[0]!.spec.model_preference[0]).toBe(UNPRICED)
      expect(out.dollars_billed).toBe(0)
    } finally {
      setBestModelOverride(undefined)
    }
  })
})
