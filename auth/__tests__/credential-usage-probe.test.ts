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
  parseUnifiedRateLimitHeaders,
  probeCredentialUsage,
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
  it('reads both windows and normalises the reset headers from seconds to ms', () => {
    const reading = parseUnifiedRateLimitHeaders(
      new Headers({
        [UNIFIED_5H_UTILIZATION_HEADER]: '0.17',
        [UNIFIED_7D_UTILIZATION_HEADER]: '0.34',
        [UNIFIED_5H_RESET_HEADER]: '1785464400',
        [UNIFIED_7D_RESET_HEADER]: '1785866400',
      }),
    )
    expect(reading).toEqual({
      session: 0.17,
      weekly: 0.34,
      session_reset_at: 1785464400000,
      weekly_reset_at: 1785866400000,
    })
  })

  it('returns null — never a zero — when the windows are absent', () => {
    expect(parseUnifiedRateLimitHeaders(new Headers())).toBeNull()
  })

  it('returns null when only ONE of the two windows is reported', () => {
    const headers = new Headers({ [UNIFIED_5H_UTILIZATION_HEADER]: '0.5' })
    expect(parseUnifiedRateLimitHeaders(headers)).toBeNull()
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
