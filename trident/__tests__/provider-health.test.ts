/**
 * ISSUES #567 — EXHAUSTED IS NOT TRANSIENT, AND THE CLASSIFIER IS WHERE THAT IS DECIDED.
 *
 * The owner is quota-constrained across providers, so "this account is maxed out" is
 * the NORMAL case, not an edge one. Before this split it reported as `deferred`, which
 * reads as a blip: the run retried, paid for the rest of the panel, and still could not
 * merge — every single time, because quota does not clear between two calls a second
 * apart.
 *
 * The direction of failure is deliberate and asymmetric, and these tests hold it:
 *   • a FALSE `exhausted` stops the run and pages the owner about a bill they do not
 *     owe, so the markers are narrow;
 *   • a FALSE `transient` costs one retry, so `unknown` is treated as transient.
 * That is why `rate limit` is a TRANSIENT marker and not an exhaustion one — it is the
 * per-minute case far more often than the out-of-credit case, and the two share a
 * status code.
 */

import { describe, expect, it } from 'bun:test'

import {
  EXIT_PROVIDER_EXHAUSTED,
  classifyProviderFailure,
  classifyProviderResponse,
  exhaustedRemedyText,
} from '../provider-health.ts'

describe('classifyProviderFailure — the text is the evidence', () => {
  it('recognises the ways a provider says "you have nothing left to spend"', () => {
    for (const text of [
      'error: insufficient_quota',
      'You exceeded your current quota, please check your plan and billing details.',
      'Quota exceeded for this organization',
      'HTTP 402: insufficient balance',
      'Usage limit reached — resets on the 1st',
      'billing_hard_limit_reached',
      'Your subscription has expired',
      'No credits remaining on this account',
    ]) {
      expect(classifyProviderFailure(text)).toBe('exhausted')
    }
  })

  it('recognises the ways a provider says "busy, try again"', () => {
    for (const text of [
      'Service Unavailable',
      'upstream overloaded',
      'request timed out after 60s',
      'ECONNRESET',
      '502 Bad Gateway',
      'Rate limit exceeded, retry after 20s',
    ]) {
      expect(classifyProviderFailure(text)).toBe('transient')
    }
  })

  it('EXHAUSTION WINS when a message carries both signals', () => {
    // The load-bearing ordering. A quota message delivered with a 429 is still a quota
    // message, and retrying it burns the panel to learn nothing. If this ever flipped,
    // the exact incident #567 describes would come straight back — silently, because
    // every other assertion here would still pass.
    expect(
      classifyProviderFailure('429 rate limit: you exceeded your current quota'),
    ).toBe('exhausted')
  })

  it('is UNKNOWN — not exhausted — for anything it cannot place', () => {
    // Treated as transient by callers. One wasted retry against a genuinely dead
    // provider is cheaper than a false alarm that teaches the owner to ignore alarms.
    expect(classifyProviderFailure('401 Unauthorized')).toBe('unknown')
    expect(classifyProviderFailure('something exploded')).toBe('unknown')
    expect(classifyProviderFailure('')).toBe('unknown')
    expect(classifyProviderFailure(null)).toBe('unknown')
    expect(classifyProviderFailure(undefined)).toBe('unknown')
    // An AUTH failure must never read as a spend problem: the remedies are different
    // and one of them ends with the owner buying capacity they already have.
    expect(classifyProviderFailure('invalid api key')).toBe('unknown')
  })

  it('is case-insensitive, because provider casing is not a contract', () => {
    expect(classifyProviderFailure('INSUFFICIENT_QUOTA')).toBe('exhausted')
    expect(classifyProviderFailure('Timed Out')).toBe('transient')
  })
})

describe('classifyProviderResponse — the body decides, the status only narrows', () => {
  it('402 is exhaustion on its own', () => {
    expect(classifyProviderResponse(402, '')).toBe('exhausted')
  })

  it('429 is AMBIGUOUS and is resolved by the body', () => {
    // THE CASE THAT MATTERS. Moonshot answers 429 for both a per-minute rate limit and
    // an out-of-credit account, so the status alone cannot decide — and getting it
    // wrong in the exhausted direction blocks merges on a blip, while getting it wrong
    // in the transient direction is the #567 incident.
    expect(classifyProviderResponse(429, 'rate limit exceeded, slow down')).toBe('transient')
    expect(classifyProviderResponse(429, '{"error":{"code":"insufficient_quota"}}')).toBe(
      'exhausted',
    )
    expect(classifyProviderResponse(429, '')).toBe('transient')
  })

  it('5xx is transient regardless of body', () => {
    expect(classifyProviderResponse(503, '')).toBe('transient')
    expect(classifyProviderResponse(500, 'internal error')).toBe('transient')
  })

  it('a 4xx that is neither stays UNKNOWN, so auth is not billed as spend', () => {
    expect(classifyProviderResponse(401, 'invalid key')).toBe('unknown')
    expect(classifyProviderResponse(403, 'forbidden')).toBe('unknown')
    // …but an exhaustion message under ANY status is still exhaustion — some providers
    // return 400 with a quota body.
    expect(classifyProviderResponse(400, 'quota exceeded')).toBe('exhausted')
  })
})

describe('the exit code and the remedy text', () => {
  it('EXIT_PROVIDER_EXHAUSTED is distinct from every deferred code the wrappers use', () => {
    // codex-review.sh defers on 3/5 and reports not-connected on 10/11; the kimi CLI
    // defers on 2/3 and reports not-connected on 10. Reusing any of those would make
    // exhaustion indistinguishable from a flake for exactly the case the owner hit.
    expect(EXIT_PROVIDER_EXHAUSTED).toBe(4)
    expect([0, 2, 3, 5, 10, 11]).not.toContain(EXIT_PROVIDER_EXHAUSTED)
  })

  it('the remedy text names all three ways out, and none of them is "wait"', () => {
    const text = exhaustedRemedyText('Cross-model review ONE', 'gpt-5.6-sol')
    expect(text).toContain('Cross-model review ONE')
    expect(text).toContain('gpt-5.6-sol')
    expect(text).toContain('add capacity')
    expect(text).toContain('re-point')
    expect(text).toContain('NONE')
    // It must also say what it is NOT doing, or a silent non-retry looks like a bug.
    expect(text).toContain('will not clear on its own')
    expect(text).toContain('nothing will be retried')
  })
})
