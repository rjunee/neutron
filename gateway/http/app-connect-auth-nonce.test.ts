import { describe, expect, test } from 'bun:test'
import { createAppConnectAuthSurface, type AppConnectAuthClaim } from './app-connect-auth.ts'

function harness() {
  let clock = 1000
  const redeemed: string[] = []
  const logs: Record<string, string>[] = []
  let claim: AppConnectAuthClaim | null = { project_slug: 'owner', user_id: 'user', session_id: 'first' }
  const surface = createAppConnectAuthSurface({
    project_slug: 'owner',
    auth_base_url: 'https://identity.example.test',
    resolveUserClaim: async () => claim,
    now: () => clock,
    log: (_event, fields) => logs.push(fields),
    store: {
      status: async () => ({ connected: false }),
      disconnect: async () => {},
      connectViaRedeem: async (code) => {
        redeemed.push(code)
        return { connected: true }
      },
    },
  })
  return {
    logs, redeemed,
    session(id: string | null) { claim = id === null ? null : { project_slug: 'owner', user_id: 'user', session_id: id } },
    advance() { clock += 10 * 60_000 },
    async start() {
      const response = await surface.handler(new Request('https://example.test/api/app/connect/auth/start', { method: 'POST' }))
      const { auth_url } = await response!.json() as { auth_url: string }
      const callback = new URL(new URL(auth_url).searchParams.get('return_url')!)
      expect(callback.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      callback.searchParams.set('connect_code', 'issued-code')
      return callback
    },
    callback(url: URL) { return surface.handler(new Request(url.toString())) },
  }
}

function refusal(response: Response | null, outcome: string) {
  expect(response!.status).toBe(302)
  const location = new URL(response!.headers.get('location')!)
  expect(location.searchParams.get('connect')).toBe('error')
  expect(location.searchParams.get('connect_error')).toBe(outcome)
}

describe('connect callback nonce', () => {
  test('legitimate round trip redeems exactly once', async () => {
    const h = harness()
    const callback = await h.start()
    const response = await h.callback(callback)
    expect(response!.status).toBe(302)
    expect(new URL(response!.headers.get('location')!).searchParams.get('connect')).toBe('connected')
    expect(h.redeemed).toEqual(['issued-code'])
    expect(h.logs).toEqual([{ outcome: 'verified', reason: 'matched' }])
  })

  test('missing nonce refuses before redeem even with a pending session', async () => {
    const h = harness()
    const callback = await h.start()
    callback.searchParams.delete('state')
    refusal(await h.callback(callback), 'failed_verification')
    expect(h.redeemed).toEqual([])
    expect(h.logs.at(-1)).toEqual({ outcome: 'failed_verification', reason: 'missing_nonce' })
  })

  test('another session nonce refuses for the same user with both sessions pending', async () => {
    const h = harness()
    const first = await h.start()
    h.session('second')
    const second = await h.start()
    expect(first.searchParams.get('state')).not.toBe(second.searchParams.get('state'))
    h.session('first')
    refusal(await h.callback(second), 'failed_verification')
    expect(h.redeemed).toEqual([])
    expect(h.logs.at(-1)).toEqual({ outcome: 'failed_verification', reason: 'nonce_mismatch' })
    expect((await h.callback(first))!.headers.get('location')).toContain('connect=connected')
  })

  test('replayed nonce refuses before a second redeem', async () => {
    const h = harness()
    const callback = await h.start()
    await h.callback(callback)
    refusal(await h.callback(callback), 'could_not_verify')
    expect(h.redeemed).toEqual(['issued-code'])
    expect(h.logs.at(-1)).toEqual({ outcome: 'could_not_verify', reason: 'already_used' })
  })

  test('expired nonce cannot be verified at the expiry boundary', async () => {
    const h = harness()
    const callback = await h.start()
    h.advance()
    refusal(await h.callback(callback), 'could_not_verify')
    expect(h.redeemed).toEqual([])
    expect(h.logs.at(-1)).toEqual({ outcome: 'could_not_verify', reason: 'expired' })
  })

  test('session without pending attempt cannot verify', async () => {
    const h = harness()
    const callback = await h.start()
    h.session('second')
    refusal(await h.callback(callback), 'could_not_verify')
    expect(h.redeemed).toEqual([])
    expect(h.logs.at(-1)).toEqual({ outcome: 'could_not_verify', reason: 'no_pending_attempt' })
  })

  test('no authenticated session cannot verify', async () => {
    const h = harness()
    const callback = await h.start()
    h.session(null)
    expect((await h.callback(callback))!.status).toBe(401)
    expect(h.redeemed).toEqual([])
    expect(h.logs.at(-1)).toEqual({ outcome: 'could_not_verify', reason: 'no_session' })
  })

  test('incomplete verifier output cannot verify', async () => {
    const h = harness()
    const callback = await h.start()
    h.session('')
    expect((await h.callback(callback))!.status).toBe(401)
    expect(h.redeemed).toEqual([])
    expect(h.logs.at(-1)).toEqual({ outcome: 'could_not_verify', reason: 'no_session_id' })
  })

  test('simultaneous callbacks consume before the redeem await', async () => {
    const h = harness()
    const callback = await h.start()
    const responses = await Promise.all([h.callback(callback), h.callback(callback)])
    expect(responses.map(r => new URL(r!.headers.get('location')!).searchParams.get('connect')).sort()).toEqual(['connected', 'error'])
    expect(h.redeemed).toEqual(['issued-code'])
  })
})
