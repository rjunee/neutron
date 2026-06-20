/**
 * `composeHttpHandler` auth-gate dispatch integration test.
 *
 * 2026-05-27 returning-user resume sprint — Part A integration. Drives
 * the composed handler with a stubbed landing surface + auth-gate
 * configured. Confirms:
 *
 *   1. Tokenless browser GET /chat is 302'd to identity signin BEFORE
 *      hitting the landing surface (the landing /chat handler never
 *      executes).
 *   2. GET /chat?start=<valid-token> reaches landing AND the response
 *      carries the Set-Cookie header from the gate.
 *   3. GET /healthz bypasses the gate entirely (unauthenticated 200).
 *   4. POST /webhook/telegram bypasses the gate (it has its own secret
 *      auth).
 *   5. Programmatic GET /api/app/admin/foo (Accept: application/json)
 *      tokenless falls through to the landing/app surface (the gate
 *      doesn't 302).
 */

import { describe, expect, test } from 'bun:test'
import type { Server, WebSocketHandler } from 'bun'
import { exportJWK, generateKeyPair, importJWK, type KeyLike } from 'jose'
import { composeHttpHandler } from '../compose.ts'
import { signSessionCookie } from '../../../landing/session-cookie.ts'
import {
  issueStartToken,
  verifyStartTokenCryptographic,
} from '@neutronai/runtime/__tests__/start-token-testkit.ts'

const COOKIE_SECRET = 'test-cookie-secret-32-chars-long'
const PROJECT_SLUG = 't-55555555'
const IDENTITY_BASE_URL = 'https://auth.neutron.example'

async function makeKeyMaterial(): Promise<{
  kid: string
  privateKey: KeyLike
  publicKey: KeyLike
}> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  })
  const pubJwk = await exportJWK(publicKey)
  const verifyKey = (await importJWK(
    { ...pubJwk, alg: 'EdDSA' },
    'EdDSA',
  )) as KeyLike
  return { kid: 'k1', privateKey, publicKey: verifyKey }
}

const fakeServer = {} as unknown as Server<unknown>
const NOOP_WS: WebSocketHandler<unknown> = {
  message(): void {},
  open(): void {},
  close(): void {},
}

describe('composeHttpHandler — auth-gate dispatch', () => {
  test('tokenless browser GET /chat → 302 before landing surface', async () => {
    const km = await makeKeyMaterial()
    let landingCalled = false
    const composed = composeHttpHandler({
      landing: {
        fetch: async () => {
          landingCalled = true
          return new Response('chat html', {
            headers: { 'content-type': 'text/html' },
          })
        },
        websocket: NOOP_WS,
      },
      authGate: {
        project_slug: PROJECT_SLUG,
        cookie_secret: COOKIE_SECRET,
        resolveKey: async (kid) => (kid === km.kid ? km.publicKey : null),
        identity_public_base_url: IDENTITY_BASE_URL,
        verifyStartToken: verifyStartTokenCryptographic,
      },
      defaultHandler: () => new Response('default 404', { status: 404 }),
    })
    const res = await composed.fetch(
      new Request('https://t-55555555.neutron.example/chat', {
        headers: { accept: 'text/html' },
      }),
      fakeServer,
    )
    expect(res.status).toBe(302)
    expect(landingCalled).toBe(false)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain(`${IDENTITY_BASE_URL}/oauth/google/start`)
    expect(location).toContain('return_url=')
  })

  test('GET /chat?start=<valid-token> → landing called AND response carries Set-Cookie', async () => {
    const km = await makeKeyMaterial()
    const token = (
      await issueStartToken({
        project_slug: PROJECT_SLUG,
        user_id: 'user-1',
        signup_via: 'web',
        signing_key: { kid: km.kid, privateKey: km.privateKey },
        ttl_seconds: 600,
      })
    ).token
    let landingCalled = false
    const composed = composeHttpHandler({
      landing: {
        fetch: async () => {
          landingCalled = true
          return new Response('chat html', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        },
        websocket: NOOP_WS,
      },
      authGate: {
        project_slug: PROJECT_SLUG,
        cookie_secret: COOKIE_SECRET,
        resolveKey: async (kid) => (kid === km.kid ? km.publicKey : null),
        identity_public_base_url: IDENTITY_BASE_URL,
        verifyStartToken: verifyStartTokenCryptographic,
      },
      defaultHandler: () => new Response('404', { status: 404 }),
    })
    const res = await composed.fetch(
      new Request(
        `https://t-55555555.neutron.example/chat?start=${encodeURIComponent(token)}`,
        { headers: { accept: 'text/html' } },
      ),
      fakeServer,
    )
    expect(res.status).toBe(200)
    expect(landingCalled).toBe(true)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('__neutron_chat_session=')
  })

  test('GET /chat with valid session cookie → landing called (no redirect)', async () => {
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    let landingCalled = false
    const composed = composeHttpHandler({
      landing: {
        fetch: async () => {
          landingCalled = true
          return new Response('chat html', { headers: { 'content-type': 'text/html' } })
        },
        websocket: NOOP_WS,
      },
      authGate: {
        project_slug: PROJECT_SLUG,
        cookie_secret: COOKIE_SECRET,
        resolveKey: async (kid) => (kid === km.kid ? km.publicKey : null),
        identity_public_base_url: IDENTITY_BASE_URL,
        verifyStartToken: verifyStartTokenCryptographic,
      },
      defaultHandler: () => new Response('404', { status: 404 }),
    })
    const res = await composed.fetch(
      new Request('https://t-55555555.neutron.example/chat', {
        headers: {
          accept: 'text/html',
          cookie: `${cookie.name}=${cookie.value}`,
        },
      }),
      fakeServer,
    )
    expect(res.status).toBe(200)
    expect(landingCalled).toBe(true)
  })

  test('GET /healthz bypasses the gate (public)', async () => {
    const km = await makeKeyMaterial()
    let healthzCalled = false
    const composed = composeHttpHandler({
      authGate: {
        project_slug: PROJECT_SLUG,
        cookie_secret: COOKIE_SECRET,
        resolveKey: async (kid) => (kid === km.kid ? km.publicKey : null),
        identity_public_base_url: IDENTITY_BASE_URL,
        verifyStartToken: verifyStartTokenCryptographic,
      },
      defaultHandler: (req) => {
        if (new URL(req.url).pathname === '/healthz') {
          healthzCalled = true
          return new Response('{"ok":true}', {
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const res = await composed.fetch(
      new Request('https://t-55555555.neutron.example/healthz'),
      fakeServer,
    )
    expect(res.status).toBe(200)
    expect(healthzCalled).toBe(true)
  })

  test('POST /webhook/telegram bypasses the gate', async () => {
    const km = await makeKeyMaterial()
    let webhookCalled = false
    const composed = composeHttpHandler({
      telegramWebhookHandler: async () => {
        webhookCalled = true
        return new Response('{"ok":true}', { status: 200 })
      },
      authGate: {
        project_slug: PROJECT_SLUG,
        cookie_secret: COOKIE_SECRET,
        resolveKey: async (kid) => (kid === km.kid ? km.publicKey : null),
        identity_public_base_url: IDENTITY_BASE_URL,
        verifyStartToken: verifyStartTokenCryptographic,
      },
      defaultHandler: () => new Response('404', { status: 404 }),
    })
    const res = await composed.fetch(
      new Request('https://t-55555555.neutron.example/webhook/telegram', {
        method: 'POST',
        body: '{}',
      }),
      fakeServer,
    )
    expect(res.status).toBe(200)
    expect(webhookCalled).toBe(true)
  })

  test('GET /api/app/admin (Accept: application/json) tokenless falls through (no 302)', async () => {
    const km = await makeKeyMaterial()
    let surfaceCalled = false
    const composed = composeHttpHandler({
      appAdmin: {
        handler: async (req) => {
          if (new URL(req.url).pathname.startsWith('/api/app/admin/')) {
            surfaceCalled = true
            return new Response('{"error":"unauthorized"}', { status: 401 })
          }
          return null
        },
      },
      authGate: {
        project_slug: PROJECT_SLUG,
        cookie_secret: COOKIE_SECRET,
        resolveKey: async (kid) => (kid === km.kid ? km.publicKey : null),
        identity_public_base_url: IDENTITY_BASE_URL,
        verifyStartToken: verifyStartTokenCryptographic,
      },
      defaultHandler: () => new Response('404', { status: 404 }),
    })
    const res = await composed.fetch(
      new Request('https://t-55555555.neutron.example/api/app/admin/personality', {
        headers: { accept: 'application/json' },
      }),
      fakeServer,
    )
    // The surface handler decides 401 — the gate stayed out of the way.
    expect(res.status).toBe(401)
    expect(surfaceCalled).toBe(true)
  })

  test('GET /chat without authGate configured → landing called unchanged (legacy behavior)', async () => {
    let landingCalled = false
    const composed = composeHttpHandler({
      landing: {
        fetch: async () => {
          landingCalled = true
          return new Response('chat html')
        },
        websocket: NOOP_WS,
      },
      // No authGate
      defaultHandler: () => new Response('404', { status: 404 }),
    })
    const res = await composed.fetch(
      new Request('https://t-55555555.neutron.example/chat', {
        headers: { accept: 'text/html' },
      }),
      fakeServer,
    )
    expect(res.status).toBe(200)
    expect(landingCalled).toBe(true)
  })
})

describe('composeHttpHandler — Argus r1 fix-pass (BLOCKER #1 + #2)', () => {
  test('BLOCKER #1: cookie-only GET /chat with mint hook wired → 302 to /chat?start=<fresh> + Set-Cookie, landing NOT called (no hot-loop)', async () => {
    const km = await makeKeyMaterial()
    const mintedToken = (
      await issueStartToken({
        project_slug: PROJECT_SLUG,
        user_id: 'user-1',
        signup_via: 'web',
        signing_key: { kid: km.kid, privateKey: km.privateKey },
        ttl_seconds: 600,
      })
    ).token
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    let landingCalled = 0
    let mintCalled = 0
    const composed = composeHttpHandler({
      landing: {
        fetch: async () => {
          landingCalled++
          return new Response('chat html', { headers: { 'content-type': 'text/html' } })
        },
        websocket: NOOP_WS,
      },
      authGate: {
        project_slug: PROJECT_SLUG,
        cookie_secret: COOKIE_SECRET,
        resolveKey: async (kid) => (kid === km.kid ? km.publicKey : null),
        identity_public_base_url: IDENTITY_BASE_URL,
        verifyStartToken: verifyStartTokenCryptographic,
        mintStartToken: async (): Promise<string | null> => {
          mintCalled++
          return mintedToken
        },
      },
      defaultHandler: () => new Response('404', { status: 404 }),
    })
    const res = await composed.fetch(
      new Request('https://t-55555555.neutron.example/chat', {
        headers: {
          accept: 'text/html',
          cookie: `${cookie.name}=${cookie.value}`,
        },
      }),
      fakeServer,
    )
    expect(res.status).toBe(302)
    expect(landingCalled).toBe(0)
    expect(mintCalled).toBe(1)
    const location = res.headers.get('location') ?? ''
    expect(location).toBe(`/chat?start=${encodeURIComponent(mintedToken)}`)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('__neutron_chat_session=')
  })

  test('BLOCKER #1: two-hop end-to-end — cookie-only /chat 302s to /chat?start=, then a second hit serves landing (one round-trip, no loop)', async () => {
    const km = await makeKeyMaterial()
    const mintedToken = (
      await issueStartToken({
        project_slug: PROJECT_SLUG,
        user_id: 'user-1',
        signup_via: 'web',
        signing_key: { kid: km.kid, privateKey: km.privateKey },
        ttl_seconds: 600,
      })
    ).token
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    let landingCalled = 0
    let mintCalled = 0
    const composed = composeHttpHandler({
      landing: {
        fetch: async () => {
          landingCalled++
          return new Response('chat html', { headers: { 'content-type': 'text/html' } })
        },
        websocket: NOOP_WS,
      },
      authGate: {
        project_slug: PROJECT_SLUG,
        cookie_secret: COOKIE_SECRET,
        resolveKey: async (kid) => (kid === km.kid ? km.publicKey : null),
        identity_public_base_url: IDENTITY_BASE_URL,
        verifyStartToken: verifyStartTokenCryptographic,
        mintStartToken: async (): Promise<string | null> => {
          mintCalled++
          return mintedToken
        },
      },
      defaultHandler: () => new Response('404', { status: 404 }),
    })
    // Hop 1 — cookie-only /chat.
    const res1 = await composed.fetch(
      new Request('https://t-55555555.neutron.example/chat', {
        headers: {
          accept: 'text/html',
          cookie: `${cookie.name}=${cookie.value}`,
        },
      }),
      fakeServer,
    )
    expect(res1.status).toBe(302)
    const next = res1.headers.get('location') ?? ''
    // Hop 2 — follow the 302 with the same cookie (browser would).
    const res2 = await composed.fetch(
      new Request(`https://t-55555555.neutron.example${next}`, {
        headers: {
          accept: 'text/html',
          cookie: `${cookie.name}=${cookie.value}`,
        },
      }),
      fakeServer,
    )
    expect(res2.status).toBe(200)
    expect(landingCalled).toBe(1)
    // Mint was invoked EXACTLY ONCE across both hops. If the second hop
    // also minted (signature of the loop), this would be >= 2.
    expect(mintCalled).toBe(1)
  })

  test('BLOCKER #2: cookie-valid GET / → 302 to /chat, landing + default handler NOT called', async () => {
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    let landingCalled = 0
    let defaultCalled = 0
    const composed = composeHttpHandler({
      landing: {
        fetch: async () => {
          landingCalled++
          return new Response('SHOULD NOT REACH LANDING', { status: 200 })
        },
        websocket: NOOP_WS,
      },
      authGate: {
        project_slug: PROJECT_SLUG,
        cookie_secret: COOKIE_SECRET,
        resolveKey: async (kid) => (kid === km.kid ? km.publicKey : null),
        identity_public_base_url: IDENTITY_BASE_URL,
        verifyStartToken: verifyStartTokenCryptographic,
      },
      defaultHandler: () => {
        defaultCalled++
        return new Response('SHOULD NOT REACH 404', { status: 404 })
      },
    })
    const res = await composed.fetch(
      new Request('https://t-55555555.neutron.example/', {
        headers: {
          accept: 'text/html',
          cookie: `${cookie.name}=${cookie.value}`,
        },
      }),
      fakeServer,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/chat')
    expect(landingCalled).toBe(0)
    expect(defaultCalled).toBe(0)
  })

  test('BLOCKER #2: tokenless GET / (browser) → 302 to identity signin (NOT 404)', async () => {
    const km = await makeKeyMaterial()
    let landingCalled = 0
    let defaultCalled = 0
    const composed = composeHttpHandler({
      landing: {
        fetch: async () => {
          landingCalled++
          return new Response('SHOULD NOT REACH LANDING', { status: 200 })
        },
        websocket: NOOP_WS,
      },
      authGate: {
        project_slug: PROJECT_SLUG,
        cookie_secret: COOKIE_SECRET,
        resolveKey: async (kid) => (kid === km.kid ? km.publicKey : null),
        identity_public_base_url: IDENTITY_BASE_URL,
        verifyStartToken: verifyStartTokenCryptographic,
      },
      defaultHandler: () => {
        defaultCalled++
        return new Response('SHOULD NOT REACH 404', { status: 404 })
      },
    })
    const res = await composed.fetch(
      new Request('https://t-55555555.neutron.example/', {
        headers: { accept: 'text/html' },
      }),
      fakeServer,
    )
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain(`${IDENTITY_BASE_URL}/oauth/google/start`)
    expect(location).toContain(
      `return_url=${encodeURIComponent('https://t-55555555.neutron.example/')}`,
    )
    expect(landingCalled).toBe(0)
    expect(defaultCalled).toBe(0)
  })

  test('BLOCKER #2: GET /?start=<valid> (identity callback on bare /) → 302 to /chat?start=<token> + Set-Cookie', async () => {
    const km = await makeKeyMaterial()
    const token = (
      await issueStartToken({
        project_slug: PROJECT_SLUG,
        user_id: 'user-1',
        signup_via: 'web',
        signing_key: { kid: km.kid, privateKey: km.privateKey },
        ttl_seconds: 600,
      })
    ).token
    let landingCalled = 0
    const composed = composeHttpHandler({
      landing: {
        fetch: async () => {
          landingCalled++
          return new Response('chat html', { status: 200 })
        },
        websocket: NOOP_WS,
      },
      authGate: {
        project_slug: PROJECT_SLUG,
        cookie_secret: COOKIE_SECRET,
        resolveKey: async (kid) => (kid === km.kid ? km.publicKey : null),
        identity_public_base_url: IDENTITY_BASE_URL,
        verifyStartToken: verifyStartTokenCryptographic,
      },
      defaultHandler: () => new Response('404', { status: 404 }),
    })
    const res = await composed.fetch(
      new Request(
        `https://t-55555555.neutron.example/?start=${encodeURIComponent(token)}`,
        { headers: { accept: 'text/html' } },
      ),
      fakeServer,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `/chat?start=${encodeURIComponent(token)}`,
    )
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('__neutron_chat_session=')
    expect(landingCalled).toBe(0)
  })
})
