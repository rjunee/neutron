/**
 * Tests for landing/boot.ts — the platform-level signup landing process.
 *
 * Per docs/plans/2026-05-05-001-feat-per-instance-gateway-http-routes-plan.md
 * § 4 (`/api/v1/sign-up` lives on platform-level, not per-instance).
 *
 * Verifies:
 *   - port resolution precedence (override > --port > NEUTRON_SIGNUP_PORT > default)
 *   - bootSignup with port:0 + identityOauthUrl produces a working listener
 *   - GET /api/v1/sign-up?via=web → 302 to the identity URL with via param
 *   - GET /api/v1/sign-up?via=tg  → 302 to the identity URL with via=tg
 *   - GET / serves index.html when present
 *   - GET /chat serves the static chat.html
 *   - GET /ws/chat 404s (the legacy onboarding socket was removed; chat
 *     is unified on the per-instance `/ws/app/chat`)
 */

import { describe, expect, test } from 'bun:test'
import { bootSignup, resolveSignupPort, resolveIdentityOauthUrl } from '../boot-impl.ts'

describe('resolveSignupPort', () => {
  test('explicit override wins', () => {
    expect(resolveSignupPort(['--port=1234'], { NEUTRON_SIGNUP_PORT: '5678' }, 9999)).toBe(9999)
  })
  test('--port flag wins over env', () => {
    expect(resolveSignupPort(['--port=1234'], { NEUTRON_SIGNUP_PORT: '5678' })).toBe(1234)
  })
  test('env wins over default', () => {
    expect(resolveSignupPort([], { NEUTRON_SIGNUP_PORT: '5678' })).toBe(5678)
  })
  test('default 7900 when neither set', () => {
    expect(resolveSignupPort([], {})).toBe(7900)
  })
  test('throws on out-of-range port', () => {
    expect(() => resolveSignupPort(['--port=99999'], {})).toThrow(/must be an integer in/)
  })
  test('throws on non-integer port', () => {
    expect(() => resolveSignupPort(['--port=abc'], {})).toThrow(/not an integer/)
  })
  test('throws on bad NEUTRON_SIGNUP_PORT', () => {
    expect(() => resolveSignupPort([], { NEUTRON_SIGNUP_PORT: 'abc' })).toThrow(/not an integer/)
  })
})

describe('resolveIdentityOauthUrl', () => {
  test('returns the env value when set', () => {
    expect(resolveIdentityOauthUrl({ NEUTRON_IDENTITY_OAUTH_URL: 'https://auth.example/x' })).toBe(
      'https://auth.example/x',
    )
  })
  test('returns null when missing or empty', () => {
    expect(resolveIdentityOauthUrl({})).toBeNull()
    expect(resolveIdentityOauthUrl({ NEUTRON_IDENTITY_OAUTH_URL: '' })).toBeNull()
  })
})

describe('bootSignup — live listener', () => {
  test('GET /api/v1/sign-up?via=web → 302 to identity URL with via=web', async () => {
    const handle = await bootSignup({
      port: 0,
      identityOauthUrl: 'https://auth.example/oauth/google/start',
    })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/v1/sign-up?via=web`, { redirect: 'manual' })
      expect(res.status).toBe(302)
      const loc = res.headers.get('location')
      expect(loc).not.toBeNull()
      const u = new URL(loc!)
      expect(u.origin).toBe('https://auth.example')
      expect(u.pathname).toBe('/oauth/google/start')
      expect(u.searchParams.get('via')).toBe('web')
    } finally {
      await handle.stop()
    }
  })

  test('GET /api/v1/sign-up?via=tg → 302 with via=tg', async () => {
    const handle = await bootSignup({
      port: 0,
      identityOauthUrl: 'https://auth.example/oauth/google/start',
    })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/v1/sign-up?via=tg`, { redirect: 'manual' })
      expect(res.status).toBe(302)
      const u = new URL(res.headers.get('location')!)
      expect(u.searchParams.get('via')).toBe('tg')
    } finally {
      await handle.stop()
    }
  })

  test('GET /api/v1/sign-up returns 503 when no identityOauthUrl is configured', async () => {
    const handle = await bootSignup({ port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/v1/sign-up?via=web`)
      expect(res.status).toBe(503)
    } finally {
      await handle.stop()
    }
  })

  test('GET / serves index.html when present (it ships in @neutronai/landing)', async () => {
    const handle = await bootSignup({ port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
    } finally {
      await handle.stop()
    }
  })

  test('GET /chat serves the static React chat shell', async () => {
    const handle = await bootSignup({ port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/chat`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
    } finally {
      await handle.stop()
    }
  })

  test('GET /ws/chat?start=anything → 404 (legacy onboarding socket removed; chat is on /ws/app/chat)', async () => {
    const handle = await bootSignup({ port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/ws/chat?start=any-token`)
      expect(res.status).toBe(404)
    } finally {
      await handle.stop()
    }
  })

  test('GET /healthz is 404 (signup landing has no healthz)', async () => {
    const handle = await bootSignup({ port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`)
      expect(res.status).toBe(404)
    } finally {
      await handle.stop()
    }
  })

  test('throws on missing chat-react.html in staticDir', async () => {
    let threw: unknown = null
    try {
      await bootSignup({ port: 0, staticDir: '/no/such/path' })
    } catch (err) {
      threw = err
    }
    expect(threw).not.toBeNull()
    expect((threw as Error).message).toContain('missing chat-react.html')
  })
})
