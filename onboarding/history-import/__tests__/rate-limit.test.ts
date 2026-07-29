/**
 * Golden test for the 429 matcher + backoff schedule extracted (K3,
 * 2026-07-03) from the deleted per-chunk pipeline. Cases are ported from the
 * retired `pass2-retry-on-429.test.ts` (schedule + `is429RetryableError`) and
 * `g6-error-string-conformance.test.ts` (`is429ErrorMessage`) so both
 * matchers stay pinned byte-for-byte after consolidation.
 */
import { describe, expect, test } from 'bun:test'
import {
  RATE_LIMIT_BACKOFF_MS_DEFAULT,
  RATE_LIMIT_BACKOFF_TOTAL_MS_DEFAULT,
  is429ErrorMessage,
  is429RetryableError,
} from '../rate-limit.ts'
import { ImportError } from '../types.ts'

describe('RATE_LIMIT_BACKOFF schedule (K3 golden)', () => {
  test('first attempt immediate, then min(60, 5*2^attempt)s, 30 retries (~27 min)', () => {
    expect(RATE_LIMIT_BACKOFF_MS_DEFAULT.length).toBeGreaterThanOrEqual(31)
    expect(RATE_LIMIT_BACKOFF_MS_DEFAULT[0]).toBe(0)
    expect(RATE_LIMIT_BACKOFF_MS_DEFAULT[1]).toBe(5_000) // 5s
    expect(RATE_LIMIT_BACKOFF_MS_DEFAULT[2]).toBe(10_000) // 10s
    expect(RATE_LIMIT_BACKOFF_MS_DEFAULT[3]).toBe(20_000) // 20s
    expect(RATE_LIMIT_BACKOFF_MS_DEFAULT[4]).toBe(40_000) // 40s
    expect(RATE_LIMIT_BACKOFF_MS_DEFAULT[5]).toBe(60_000) // cap
    expect(RATE_LIMIT_BACKOFF_MS_DEFAULT[10]).toBe(60_000) // still capped
    expect(RATE_LIMIT_BACKOFF_TOTAL_MS_DEFAULT).toBeGreaterThanOrEqual(25 * 60 * 1000)
  })
})

describe('is429RetryableError (K3 golden)', () => {
  test('detects HTTP 429 + rate_limit shapes', () => {
    expect(is429RetryableError(new Error('pass2 substrate error: HTTP 429: rate_limit_error'))).toBe(
      true,
    )
    expect(is429RetryableError(new Error('rate_limit_error'))).toBe(true)
    expect(is429RetryableError(new Error('rate-limit hit'))).toBe(true)
    expect(
      is429RetryableError(new ImportError('substrate_error', null, 'pass2 substrate error: HTTP 429')),
    ).toBe(true)
    expect(is429RetryableError(new Error('HTTP 400: bad request'))).toBe(false)
    expect(is429RetryableError(new Error('HTTP 500: server error'))).toBe(false)
    expect(is429RetryableError(new Error('parse_failed'))).toBe(false)
    expect(is429RetryableError(undefined)).toBe(false)
    expect(is429RetryableError(null)).toBe(false)
  })
})

describe('is429ErrorMessage (K3 golden — g6 conformance parity)', () => {
  test('matches the real HTTP 429 producer + Anthropic rate-limit envelope', () => {
    expect(is429ErrorMessage("HTTP 429: You've hit your limit")).toBe(true)
    expect(
      is429ErrorMessage('rate_limit_error: number of request tokens has exceeded your rate limit'),
    ).toBe(true)
    expect(is429ErrorMessage('rate-limit exceeded')).toBe(true)
    expect(is429ErrorMessage('HTTP 400: invalid_request_error')).toBe(false)
  })
})
