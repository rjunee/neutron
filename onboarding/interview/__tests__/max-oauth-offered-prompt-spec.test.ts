/**
 * K11a6-completion survivor — RETAINED `max_oauth_offered` prompt-spec pins,
 * ported VERBATIM from the engine-free describe blocks of the two dying
 * drive suites (`max-oauth-offered.test.ts` Tests 1/2/7/10 and
 * `phase-max-oauth-offered-auto-skip.test.ts` single-CTA + substrate-aware
 * describes), which co-delete with K11b1.
 *
 * What is pinned here is retained-live code: `STATIC_PHASE_SPECS`
 * (phase-prompts.ts, the LLM-less/failure copy source K11b1 explicitly
 * retains) and the `buildMaxOauthOfferedPromptSpec` builder
 * (phase-prompts.ts:1910). `phase-spec-resolver.test.ts` pins routing
 * metadata (`next_phase_on_default`, `allow_freeform`, allowed option
 * values) with STUB bodies, so the exact body copy + option label lived
 * only in the dying files — the K8 coverage-loss rule requires this port.
 *
 * NOT ported (deliberately): the `maybeAutoAdvancePastMaxOauthOffered`
 * auto-skip/refresh-row/env-token/identity-bridge behavior. It lives in
 * `engine-agent-name.ts`, which the owner adjudicated retained-but-DEAD
 * (K11 plan §6 addendum — pruned in K11d); pinning it would obstruct the
 * prune while protecting nothing prod-reachable.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildMaxOauthOfferedPromptSpec,
  STATIC_PHASE_SPECS,
} from '../phase-prompts.ts'

describe('STATIC_PHASE_SPECS.max_oauth_offered — single CTA copy', () => {
  test('body matches Sam 2026-05-28 single-CTA framing', () => {
    const spec = STATIC_PHASE_SPECS['max_oauth_offered']
    expect(spec).toBeDefined()
    expect(spec!.body).toBe(
      'I need your Claude Max sub to run premium models. One click to connect.',
    )
    expect(spec!.body).toContain('Claude Max')
    expect(spec!.body).not.toContain('Day-1 brief')
    expect(spec!.body).not.toContain('Fire it')
  })

  test('options is a single Connect-Claude-Max button (BYO + skip dropped)', () => {
    const spec = STATIC_PHASE_SPECS['max_oauth_offered']
    expect(spec!.options).toEqual([
      { label: 'A', body: 'Connect Claude Max', value: 'attach_max' },
    ])
    expect(spec!.allow_freeform).toBe(false)
    expect(spec!.next_phase_on_default).toBe('wow_fired')
  })

  test('body does NOT mention BYO API key or skip-onto-free-tier', () => {
    const spec = STATIC_PHASE_SPECS['max_oauth_offered']
    expect(spec!.body).not.toMatch(/API key/i)
    expect(spec!.body).not.toMatch(/skip/i)
    expect(spec!.body).not.toMatch(/free tier/i)
  })
})

describe('STATIC_PHASE_SPECS.wow_fired — legacy wow-fire copy must not return', () => {
  test('wow_fired has no body containing the old "Fire it" wow-fire question', () => {
    const spec = STATIC_PHASE_SPECS['wow_fired']
    // wow_fired is driven externally (wow-dispatcher) — it intentionally
    // has no static spec entry. If a future commit DOES add one, it must
    // NOT carry the legacy wow-fire body (that lived on max_oauth_offered
    // before T3 restored it).
    if (spec === undefined) {
      expect(spec).toBeUndefined()
      return
    }
    expect(spec.body).not.toContain('Fire it')
    expect(spec.body).not.toContain('Day-1 brief')
    expect(spec.body).not.toContain('Ready to fire')
  })
})

describe('buildMaxOauthOfferedPromptSpec — substrate-aware Shape-1 wording (2026-06-03)', () => {
  const CLAUDE_ACK =
    'Earlier you mentioned you use Claude. To run premium models for you, I need your Max sub connected. One click.'
  const ORIGINAL = 'I need your Claude Max sub to run premium models. One click to connect.'

  test('ai_substrate_used="claude" → acknowledging body', () => {
    const spec = buildMaxOauthOfferedPromptSpec({
      max_handoff_url: null,
      awaiting_byo_paste: false,
      rejection_reason: null,
      ai_substrate_used: 'claude',
    })
    expect(spec.body).toBe(CLAUDE_ACK)
    // Single Connect CTA preserved.
    expect(spec.options).toEqual([
      { label: 'A', body: 'Connect Claude Max', value: 'attach_max' },
    ])
  })

  test('ai_substrate_used="chatgpt" → original blunt body', () => {
    const spec = buildMaxOauthOfferedPromptSpec({
      max_handoff_url: null,
      awaiting_byo_paste: false,
      rejection_reason: null,
      ai_substrate_used: 'chatgpt',
    })
    expect(spec.body).toBe(ORIGINAL)
  })

  test('ai_substrate_used=null / omitted → original blunt body (back-compat)', () => {
    const withNull = buildMaxOauthOfferedPromptSpec({
      max_handoff_url: null,
      awaiting_byo_paste: false,
      rejection_reason: null,
      ai_substrate_used: null,
    })
    const omitted = buildMaxOauthOfferedPromptSpec({
      max_handoff_url: null,
      awaiting_byo_paste: false,
      rejection_reason: null,
    })
    expect(withNull.body).toBe(ORIGINAL)
    expect(omitted.body).toBe(ORIGINAL)
  })

  test('rejection reason is stitched in front of the substrate-aware body', () => {
    const spec = buildMaxOauthOfferedPromptSpec({
      max_handoff_url: null,
      awaiting_byo_paste: false,
      rejection_reason: 'Connect failed; tap to try again.',
      ai_substrate_used: 'claude',
    })
    expect(spec.body).toBe(`Connect failed; tap to try again.\n\n${CLAUDE_ACK}`)
  })
})

describe('buildMaxOauthOfferedPromptSpec — awaiting_byo_paste Skip escape hatch (Argus r1 IMPORTANT)', () => {
  test('awaiting_byo_paste spec carries a Skip option', () => {
    const spec = buildMaxOauthOfferedPromptSpec({
      max_handoff_url: null,
      awaiting_byo_paste: true,
      rejection_reason: null,
    })
    expect(spec.options).toHaveLength(1)
    expect(spec.options[0]).toEqual({ label: 'A', body: 'Skip for now', value: 'skip' })
    expect(spec.allow_freeform).toBe(true)
  })
})
