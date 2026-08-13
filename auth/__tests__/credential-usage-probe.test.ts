/**
 * The usage probe reads four headers and classifies everything else.
 *
 * The cases that matter are the ones where a wrong answer would be INVISIBLE: a
 * 200 with no windows must not become "0% used", and a 429 with no windows must
 * not become "0% used" either — that is the exact moment the bar is supposed to
 * be red.
 */

import { describe, expect, it } from 'bun:test'

import {
  ANTHROPIC_MESSAGES_URL,
  parseUnifiedRateLimitHeaders,
  probeCredentialUsage,
  probeMessagesUrl,
  UNIFIED_5H_RESET_HEADER,
  UNIFIED_5H_UTILIZATION_HEADER,
  UNIFIED_7D_RESET_HEADER,
  UNIFIED_7D_UTILIZATION_HEADER,
} from '../credential-usage-probe.ts'

const TOKEN = 'sk-ant-oat01-test-token-value-not-a-real-credential'

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response('{}', { status, headers })
}

function stubFetch(res: Response): typeof fetch {
  return (async () => res) as unknown as typeof fetch
}

describe('parseUnifiedRateLimitHeaders', () => {
  // The clock the plausibility bound is measured against. Both reset instants in
  // the fixture below land inside it: 1785464400 is ~4.6 days after this.
  const NOW = 1785_064_400_000

  it('reads both windows and normalises the reset headers from seconds to ms', () => {
    const reading = parseUnifiedRateLimitHeaders(
      new Headers({
        [UNIFIED_5H_UTILIZATION_HEADER]: '0.17',
        [UNIFIED_7D_UTILIZATION_HEADER]: '0.34',
        [UNIFIED_5H_RESET_HEADER]: '1785464400',
        [UNIFIED_7D_RESET_HEADER]: '1785866400',
      }),
      NOW,
    )
    expect(reading).toEqual({
      session: 0.17,
      weekly: 0.34,
      session_reset_at: 1785464400000,
      weekly_reset_at: 1785866400000,
    })
  })

  it('returns null — never a zero — when the windows are absent', () => {
    expect(parseUnifiedRateLimitHeaders(new Headers(), NOW)).toBeNull()
  })

  it('returns null when only ONE of the two windows is reported', () => {
    const headers = new Headers({ [UNIFIED_5H_UTILIZATION_HEADER]: '0.5' })
    expect(parseUnifiedRateLimitHeaders(headers, NOW)).toBeNull()
  })

  // ── THE RESET INSTANTS ARE BOUNDED, THE SAME WAY KIMI'S ARE ────────────────
  // Argus round 4: this side had no plausibility check while the other provider's
  // had one, so a `…-reset` header that was ALREADY in milliseconds was multiplied
  // by 1000 again and rendered downstream as a countdown of "11574074d 1h" with
  // nothing on the card flagging it. The windows still read; only the unbelievable
  // instant is dropped, and an absent instant renders as "unknown", never as "now".

  it('DROPS a reset instant that is absurdly far in the future — an already-ms header', () => {
    const reading = parseUnifiedRateLimitHeaders(
      new Headers({
        [UNIFIED_5H_UTILIZATION_HEADER]: '0.17',
        [UNIFIED_7D_UTILIZATION_HEADER]: '0.34',
        // The seconds field carrying a MILLISECONDS value: ×1000 puts it ~31,000
        // years out. `formatCountdown` would print it without complaint.
        [UNIFIED_5H_RESET_HEADER]: String(NOW),
        [UNIFIED_7D_RESET_HEADER]: '1785866400',
      }),
      NOW,
    )
    expect(reading).not.toBeNull()
    // The window itself still reads — a bad instant costs the countdown, not the gauge.
    expect(reading?.session).toBe(0.17)
    expect(reading?.session_reset_at).toBeUndefined()
    expect(reading?.weekly_reset_at).toBe(1785866400000)
  })

  it('DROPS a reset instant further in the past than clock skew — a ms value read as seconds', () => {
    const reading = parseUnifiedRateLimitHeaders(
      new Headers({
        [UNIFIED_5H_UTILIZATION_HEADER]: '0.9',
        [UNIFIED_7D_UTILIZATION_HEADER]: '0.9',
        // Epoch ms divided by 1000 twice over: lands in 1970.
        [UNIFIED_5H_RESET_HEADER]: '1785464',
        [UNIFIED_7D_RESET_HEADER]: '1785866400',
      }),
      NOW,
    )
    expect(reading?.session_reset_at).toBeUndefined()
  })

  it('KEEPS an instant a minute in the past — a window that just rolled is not skew', () => {
    const justRolled = Math.floor((NOW - 60_000) / 1000)
    const reading = parseUnifiedRateLimitHeaders(
      new Headers({
        [UNIFIED_5H_UTILIZATION_HEADER]: '0.9',
        [UNIFIED_7D_UTILIZATION_HEADER]: '0.4',
        [UNIFIED_5H_RESET_HEADER]: String(justRolled),
        [UNIFIED_7D_RESET_HEADER]: '1785866400',
      }),
      NOW,
    )
    expect(reading?.session_reset_at).toBe(justRolled * 1000)
  })
})

describe('probeCredentialUsage', () => {
  it('reports a reading from a 200 that carries the windows', async () => {
    const outcome = await probeCredentialUsage(TOKEN, {
      fetch: stubFetch(
        response(200, {
          [UNIFIED_5H_UTILIZATION_HEADER]: '0.86',
          [UNIFIED_7D_UTILIZATION_HEADER]: '0.12',
        }),
      ),
    })
    expect(outcome).toEqual({ kind: 'ok', reading: { session: 0.86, weekly: 0.12 } })
  })

  it('classifies a 200 WITHOUT windows as no-windows, not as an empty reading', async () => {
    const outcome = await probeCredentialUsage(TOKEN, { fetch: stubFetch(response(200)) })
    expect(outcome).toEqual({ kind: 'no-windows' })
  })

  it('still reads the windows off a 429 — the moment the bar matters most', async () => {
    const outcome = await probeCredentialUsage(TOKEN, {
      fetch: stubFetch(
        response(429, {
          [UNIFIED_5H_UTILIZATION_HEADER]: '1',
          [UNIFIED_7D_UTILIZATION_HEADER]: '0.63',
        }),
      ),
    })
    expect(outcome).toEqual({ kind: 'ok', reading: { session: 1, weekly: 0.63 } })
  })

  it('treats a 429 with no windows as fully consumed rather than under-reporting', async () => {
    const outcome = await probeCredentialUsage(TOKEN, { fetch: stubFetch(response(429)) })
    expect(outcome).toEqual({ kind: 'ok', reading: { session: 1, weekly: 1 } })
  })

  it('reports a dead credential distinctly from a transient failure', async () => {
    expect(await probeCredentialUsage(TOKEN, { fetch: stubFetch(response(401)) })).toEqual({
      kind: 'unauthorized',
      httpStatus: 401,
    })
    expect(await probeCredentialUsage(TOKEN, { fetch: stubFetch(response(403)) })).toEqual({
      kind: 'unauthorized',
      httpStatus: 403,
    })
  })

  it('reports a 5xx as transient', async () => {
    const outcome = await probeCredentialUsage(TOKEN, { fetch: stubFetch(response(503)) })
    expect(outcome.kind).toBe('error')
  })

  it('never throws on a transport failure', async () => {
    const outcome = await probeCredentialUsage(TOKEN, {
      fetch: (async () => {
        throw new Error('connect ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    expect(outcome).toEqual({ kind: 'error', message: 'connect ECONNREFUSED' })
  })

  it('sends the credential as a bearer and asks for exactly one token', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    await probeCredentialUsage(TOKEN, {
      apiBaseUrl: 'https://anthropic.example.com',
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init }
        return response(200, {
          [UNIFIED_5H_UTILIZATION_HEADER]: '0',
          [UNIFIED_7D_UTILIZATION_HEADER]: '0',
        })
      }) as unknown as typeof fetch,
    })
    const call = seen as unknown as { url: string; init: RequestInit }
    expect(call.url).toBe('https://anthropic.example.com/v1/messages')
    expect((call.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(String(call.init.body))['max_tokens']).toBe(1)
  })
})

/**
 * THE BASE URL IS OPERATOR INPUT, and it reaches this module straight from the
 * environment (`open/composer.ts` threads `ANTHROPIC_BASE_URL` into `probeDeps`).
 * Both cases below were live defects of `new URL('/v1/messages', base)`: one killed
 * the tick loop with a `TypeError` from OUTSIDE the probe's `try`, the other silently
 * probed a different service and could report its 401 as a lapsed credential.
 */
describe('probeMessagesUrl', () => {
  it('uses the Anthropic endpoint verbatim when no base is configured', () => {
    expect(probeMessagesUrl(undefined)).toBe(ANTHROPIC_MESSAGES_URL)
  })

  it("KEEPS a gateway base's path prefix instead of resolving against its origin", () => {
    // `new URL('/v1/messages', 'https://gw.example.com/anthropic')` answers
    // 'https://gw.example.com/v1/messages' — the prefix dropped, a different door.
    expect(probeMessagesUrl('https://gw.example.com/anthropic')).toBe(
      'https://gw.example.com/anthropic/v1/messages',
    )
  })

  it('does not double the separator on a base with a trailing slash', () => {
    expect(probeMessagesUrl('https://gw.example.com/anthropic/')).toBe(
      'https://gw.example.com/anthropic/v1/messages',
    )
  })

  it('does not throw on a scheme-less base', () => {
    // `new URL` threw `TypeError: Invalid URL` here.
    expect(() => probeMessagesUrl('anthropic.example.com')).not.toThrow()
  })
})

describe('probeCredentialUsage honours the contract that it NEVER throws', () => {
  it('reports a scheme-less base as a transient error rather than throwing', async () => {
    // The failure this pins: the URL was built BEFORE the `try`, so a typo'd
    // `ANTHROPIC_BASE_URL` threw out of a function documented as never throwing and
    // took the monitor's tick loop with it. It must be an ordinary tagged outcome —
    // the next tick retries, and nothing else in the loop notices.
    const outcome = await probeCredentialUsage(TOKEN, {
      apiBaseUrl: 'anthropic.example.com',
      fetch: (async (url: string) => {
        // A real `fetch` rejects a relative URL; the stub reproduces that rather
        // than asserting on which message the runtime chooses.
        throw new TypeError(`Failed to parse URL from ${url}`)
      }) as unknown as typeof fetch,
    })
    expect(outcome.kind).toBe('error')
  })

  it('probes a path-prefixed gateway at the prefixed path', async () => {
    let seen = ''
    await probeCredentialUsage(TOKEN, {
      apiBaseUrl: 'https://gw.example.com/anthropic',
      fetch: (async (url: string) => {
        seen = url
        return response(200, {
          [UNIFIED_5H_UTILIZATION_HEADER]: '0.2',
          [UNIFIED_7D_UTILIZATION_HEADER]: '0.4',
        })
      }) as unknown as typeof fetch,
    })
    expect(seen).toBe('https://gw.example.com/anthropic/v1/messages')
  })
})
