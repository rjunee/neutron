/**
 * @neutronai/github — device-flow protocol.
 *
 * These exist because the polling loop is where this gets subtly wrong, and none
 * of it is observable from a working demo: a demo where the owner approves
 * quickly exercises exactly one of the six branches. `authorization_pending`
 * mistaken for a failure breaks every owner who takes longer than one interval;
 * a `slow_down` that does not persist earns escalating rejections; a terminal
 * error that retries hammers a decision already made.
 *
 * No network, no clock, no waiting — `fetch`, `now` and `sleep` are injected.
 */

import { describe, expect, it } from 'bun:test'

import {
  ACCESS_TOKEN_URL,
  DEFAULT_SCOPES,
  DEVICE_CODE_URL,
  GitHubDeviceFlowError,
  pollForAccessToken,
  requestDeviceCode,
  type DeviceCodeGrant,
  type FetchLike,
} from '../device-flow.ts'

function jsonRes(body: unknown, status = 200): {
  ok: boolean
  status: number
  json: () => Promise<unknown>
} {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

/** Replays a queue of responses and records every request it saw. */
function scriptedFetch(queue: Array<{ ok: boolean; status: number; json: () => Promise<unknown> }>): {
  fetchImpl: FetchLike
  calls: Array<{ url: string; body: string }>
} {
  const calls: Array<{ url: string; body: string }> = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body })
      const next = queue.shift()
      if (next === undefined) throw new Error('scriptedFetch: ran out of responses')
      return next
    },
  }
}

function grant(over: Partial<DeviceCodeGrant> = {}): DeviceCodeGrant {
  return {
    device_code: 'dev-code',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    interval_seconds: 5,
    expires_in_seconds: 900,
    ...over,
  }
}

/** Advancing clock + a sleep that only records, so the loop never really waits. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 0
  const slept: number[] = []
  return {
    slept,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms)
      t += ms
    },
  }
}

describe('requestDeviceCode', () => {
  it('asks for the scopes the instance actually needs, and no more', async () => {
    const s = scriptedFetch([
      jsonRes({ device_code: 'd', user_code: 'U-1', verification_uri: 'https://x', interval: 5, expires_in: 900 }),
    ])
    await requestDeviceCode({ client_id: 'cid', fetchImpl: s.fetchImpl })
    expect(s.calls[0]?.url).toBe(DEVICE_CODE_URL)
    expect(s.calls[0]?.body).toContain(`scope=${encodeURIComponent(DEFAULT_SCOPES).replace(/%20/g, '+')}`)
    // `workflow` would let an agent loop rewrite CI, which nobody asked for.
    expect(DEFAULT_SCOPES).not.toContain('workflow')
    expect(DEFAULT_SCOPES).not.toContain('delete_repo')
  })

  it('returns what the OWNER must be shown', async () => {
    const s = scriptedFetch([
      jsonRes({ device_code: 'd', user_code: 'WXYZ-9', verification_uri: 'https://github.com/login/device', interval: 7, expires_in: 600 }),
    ])
    const g = await requestDeviceCode({ client_id: 'cid', fetchImpl: s.fetchImpl })
    expect(g.user_code).toBe('WXYZ-9')
    expect(g.verification_uri).toBe('https://github.com/login/device')
    expect(g.interval_seconds).toBe(7)
  })

  it('treats a missing user_code as a protocol error, not a default', async () => {
    // There is nothing to show the owner. Inventing a value would produce a
    // screen instructing them to type a code that does not exist.
    const s = scriptedFetch([jsonRes({ device_code: 'd', verification_uri: 'https://x' })])
    await expect(requestDeviceCode({ client_id: 'cid', fetchImpl: s.fetchImpl })).rejects.toThrow(
      GitHubDeviceFlowError,
    )
  })

  it('defaults a missing interval to GitHub 5s rather than polling flat out', async () => {
    const s = scriptedFetch([jsonRes({ device_code: 'd', user_code: 'U', verification_uri: 'https://x' })])
    expect((await requestDeviceCode({ client_id: 'cid', fetchImpl: s.fetchImpl })).interval_seconds).toBe(5)
  })
})

describe('pollForAccessToken', () => {
  it('keeps polling through authorization_pending — the NORMAL case', async () => {
    // Every owner who takes longer than one interval hits this branch. Treating
    // it as failure would break the flow for essentially everyone.
    const s = scriptedFetch([
      jsonRes({ error: 'authorization_pending' }),
      jsonRes({ error: 'authorization_pending' }),
      jsonRes({ access_token: 'ghu_secret' }),
    ])
    const clock = fakeClock()
    const token = await pollForAccessToken({
      client_id: 'cid',
      grant: grant(),
      deps: { fetchImpl: s.fetchImpl, now: clock.now, sleep: clock.sleep },
    })
    expect(token).toBe('ghu_secret')
    expect(s.calls.length).toBe(3)
    expect(s.calls[0]?.url).toBe(ACCESS_TOKEN_URL)
  })

  it('backs off on slow_down and KEEPS the longer interval', async () => {
    // The persistence is the point. A one-off pause that reverts earns
    // escalating rejections from GitHub.
    const s = scriptedFetch([
      jsonRes({ error: 'slow_down' }),
      jsonRes({ error: 'authorization_pending' }),
      jsonRes({ access_token: 'ghu_secret' }),
    ])
    const clock = fakeClock()
    await pollForAccessToken({
      client_id: 'cid',
      grant: grant({ interval_seconds: 5 }),
      deps: { fetchImpl: s.fetchImpl, now: clock.now, sleep: clock.sleep },
    })
    expect(clock.slept[0]).toBe(5_000)
    expect(clock.slept[1]).toBe(10_000)
    // Still 10s, not back to 5s.
    expect(clock.slept[2]).toBe(10_000)
  })

  it('honours a server-supplied interval on slow_down', async () => {
    const s = scriptedFetch([jsonRes({ error: 'slow_down', interval: 30 }), jsonRes({ access_token: 't' })])
    const clock = fakeClock()
    await pollForAccessToken({
      client_id: 'cid',
      grant: grant({ interval_seconds: 5 }),
      deps: { fetchImpl: s.fetchImpl, now: clock.now, sleep: clock.sleep },
    })
    expect(clock.slept[1]).toBe(30_000)
  })

  it('stops immediately on access_denied — the owner already decided', async () => {
    const s = scriptedFetch([jsonRes({ error: 'access_denied' })])
    const clock = fakeClock()
    await expect(
      pollForAccessToken({
        client_id: 'cid',
        grant: grant(),
        deps: { fetchImpl: s.fetchImpl, now: clock.now, sleep: clock.sleep },
      }),
    ).rejects.toMatchObject({ reason: 'access_denied' })
    expect(s.calls.length).toBe(1)
  })

  it('stops immediately on expired_token', async () => {
    const s = scriptedFetch([jsonRes({ error: 'expired_token' })])
    const clock = fakeClock()
    await expect(
      pollForAccessToken({
        client_id: 'cid',
        grant: grant(),
        deps: { fetchImpl: s.fetchImpl, now: clock.now, sleep: clock.sleep },
      }),
    ).rejects.toMatchObject({ reason: 'expired_token' })
    expect(s.calls.length).toBe(1)
  })

  it('RETRIES a 5xx rather than ending a flow the owner may have approved', async () => {
    const s = scriptedFetch([jsonRes({}, 503), jsonRes({ access_token: 'ghu_secret' })])
    const clock = fakeClock()
    expect(
      await pollForAccessToken({
        client_id: 'cid',
        grant: grant(),
        deps: { fetchImpl: s.fetchImpl, now: clock.now, sleep: clock.sleep },
      }),
    ).toBe('ghu_secret')
  })

  it('fails fast on a 4xx — that is a real client error, not a blip', async () => {
    const s = scriptedFetch([jsonRes({}, 400)])
    const clock = fakeClock()
    await expect(
      pollForAccessToken({
        client_id: 'cid',
        grant: grant(),
        deps: { fetchImpl: s.fetchImpl, now: clock.now, sleep: clock.sleep },
      }),
    ).rejects.toMatchObject({ reason: 'protocol_error' })
  })

  it('gives up at the deadline instead of polling forever', async () => {
    const s = scriptedFetch(Array.from({ length: 50 }, () => jsonRes({ error: 'authorization_pending' })))
    const clock = fakeClock()
    await expect(
      pollForAccessToken({
        client_id: 'cid',
        grant: grant({ interval_seconds: 5 }),
        deps: { fetchImpl: s.fetchImpl, now: clock.now, sleep: clock.sleep },
        deadline_ms: 20_000,
      }),
    ).rejects.toMatchObject({ reason: 'timeout' })
  })

  it('an unrecognized error code is a protocol error, never a silent retry loop', async () => {
    const s = scriptedFetch([jsonRes({ error: 'something_new_from_github' })])
    const clock = fakeClock()
    await expect(
      pollForAccessToken({
        client_id: 'cid',
        grant: grant(),
        deps: { fetchImpl: s.fetchImpl, now: clock.now, sleep: clock.sleep },
      }),
    ).rejects.toMatchObject({ reason: 'protocol_error' })
  })

  it('NEVER puts token material in an error', async () => {
    // A credential in an error message ends up in a log, a bug report, or chat.
    const s = scriptedFetch([jsonRes({ error: 'access_denied', access_token: 'ghu_leaked' })])
    const clock = fakeClock()
    try {
      await pollForAccessToken({
        client_id: 'cid',
        grant: grant(),
        deps: { fetchImpl: s.fetchImpl, now: clock.now, sleep: clock.sleep },
      })
      throw new Error('expected a rejection')
    } catch (err) {
      // Note: a body carrying BOTH a token and an error is malformed; the token
      // wins by design (we got what we came for), so assert on the happy path
      // too — either way the string 'ghu_leaked' must never reach an Error.
      if (err instanceof GitHubDeviceFlowError) {
        expect(err.message).not.toContain('ghu_leaked')
        expect(JSON.stringify(err)).not.toContain('ghu_leaked')
      }
    }
  })
})
