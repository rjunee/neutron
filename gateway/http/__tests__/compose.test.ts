/**
 * Tests for gateway/http/compose.ts — the precedence chain wiring landing
 * + telegram webhook + cross-instance API + default healthz into a single
 * `{ fetch, websocket }` for Bun.serve.
 */

import { describe, expect, test } from 'bun:test'
import {
  composeHttpHandler,
  LANDING_ROUTE_PATHS,
  type LandingHandler,
} from '../compose.ts'

function fakeServer(): import('bun').Server<unknown> {
  return {
    upgrade: () => true,
  } as unknown as import('bun').Server<unknown>
}

function makeLanding(routeBody: string): LandingHandler {
  return {
    fetch: async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/chat') return new Response(routeBody, { status: 200 })
      if (url.pathname === '/chat.js') return new Response('js', { status: 200 })
      if (url.pathname === '/ws/chat') return new Response(null, { status: 101 })
      if (url.pathname === '/api/v1/sign-up') return new Response(null, { status: 302 })
      if (url.pathname === '/invite' || url.pathname === '/') return new Response('invite', { status: 200 })
      if (url.pathname === '/onboarding/invite-accept') return new Response('{"ok":true}', { status: 200 })
      return new Response('not found', { status: 404 })
    },
    websocket: { open() {}, message() {}, close() {} },
  }
}

function makeDefault(body = 'default'): (req: Request) => Response {
  return (req: Request): Response => {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') return new Response('ok', { status: 200 })
    return new Response(body, { status: 404 })
  }
}

describe('composeHttpHandler — precedence chain', () => {
  test('routes POST /webhook/telegram to telegram handler', async () => {
    let called = 0
    const composed = composeHttpHandler({
      telegramWebhookHandler: async (_req) => {
        called++
        return new Response('tg-200', { status: 200 })
      },
      defaultHandler: makeDefault(),
    })
    const res = await composed.fetch(
      new Request('http://x/webhook/telegram', { method: 'POST', body: '{}' }),
      fakeServer(),
    )
    expect(called).toBe(1)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('tg-200')
  })

  test('GET /webhook/telegram does NOT route to telegram handler (POST-only)', async () => {
    let called = 0
    const composed = composeHttpHandler({
      telegramWebhookHandler: async () => {
        called++
        return new Response('tg-200', { status: 200 })
      },
      defaultHandler: makeDefault(),
    })
    const res = await composed.fetch(new Request('http://x/webhook/telegram'), fakeServer())
    expect(called).toBe(0)
    expect(res.status).toBe(404)
  })

  test('routes /chat to landing handler', async () => {
    const composed = composeHttpHandler({
      landing: makeLanding('chat-html'),
      defaultHandler: makeDefault(),
    })
    const res = await composed.fetch(new Request('http://x/chat'), fakeServer())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('chat-html')
  })

  test('routes /api/v1/sign-up to landing handler', async () => {
    const composed = composeHttpHandler({
      landing: makeLanding(''),
      defaultHandler: makeDefault(),
    })
    const res = await composed.fetch(new Request('http://x/api/v1/sign-up?via=web'), fakeServer())
    expect(res.status).toBe(302)
  })

  test('routes /ws/chat to landing handler (WebSocket upgrade)', async () => {
    const composed = composeHttpHandler({
      landing: makeLanding(''),
      defaultHandler: makeDefault(),
    })
    const res = await composed.fetch(new Request('http://x/ws/chat?start=tok'), fakeServer())
    expect(res.status).toBe(101)
  })

  test('routes / with ?invite= to landing (invite short-circuit)', async () => {
    const composed = composeHttpHandler({
      landing: makeLanding(''),
      defaultHandler: makeDefault(),
    })
    const res = await composed.fetch(new Request('http://x/?invite=token'), fakeServer())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('invite')
  })

  test('routes / WITHOUT ?invite= to default (not landing)', async () => {
    const composed = composeHttpHandler({
      landing: makeLanding(''),
      defaultHandler: makeDefault('root-default'),
    })
    const res = await composed.fetch(new Request('http://x/'), fakeServer())
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('root-default')
  })

  test('routes /cross-instance/* to cross-instance handler', async () => {
    let called = 0
    const composed = composeHttpHandler({
      connectHandler: async (req) => {
        const url = new URL(req.url)
        if (url.pathname.startsWith('/connect/')) {
          called++
          return new Response('ct-200', { status: 200 })
        }
        return null
      },
      defaultHandler: makeDefault(),
    })
    const res = await composed.fetch(new Request('http://x/connect/v1/projects'), fakeServer())
    expect(called).toBe(1)
    expect(res.status).toBe(200)
  })

  test('cross-instance returns null → falls through to default', async () => {
    const composed = composeHttpHandler({
      connectHandler: async () => null,
      defaultHandler: makeDefault('fell-through'),
    })
    const res = await composed.fetch(new Request('http://x/healthz'), fakeServer())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  test('unknown path with no handlers returns default 404', async () => {
    const composed = composeHttpHandler({ defaultHandler: makeDefault('def-404') })
    const res = await composed.fetch(new Request('http://x/some-other'), fakeServer())
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('def-404')
  })

  test('precedence: telegram > landing > cross-instance > default', async () => {
    // Build a handler that "owns" /chat at every layer; assert telegram wins.
    const order: string[] = []
    const composed = composeHttpHandler({
      telegramWebhookHandler: async () => {
        order.push('tg')
        return new Response('tg', { status: 200 })
      },
      landing: {
        fetch: async () => {
          order.push('landing')
          return new Response('l', { status: 200 })
        },
        websocket: { open() {}, message() {}, close() {} },
      },
      connectHandler: async () => {
        order.push('ct')
        return new Response('ct', { status: 200 })
      },
      defaultHandler: () => {
        order.push('def')
        return new Response('d', { status: 200 })
      },
    })
    // POST /webhook/telegram → telegram handler short-circuits.
    await composed.fetch(new Request('http://x/webhook/telegram', { method: 'POST' }), fakeServer())
    // GET /chat → landing wins over cross-instance and default.
    await composed.fetch(new Request('http://x/chat'), fakeServer())
    // GET /something-else → cross-instance returns Response, default never runs.
    await composed.fetch(new Request('http://x/connect/v1/projects'), fakeServer())
    expect(order).toEqual(['tg', 'landing', 'ct'])
  })
})

describe('composeHttpHandler — websocket pass-through', () => {
  test('exposes landing.websocket when landing is wired', () => {
    const wsHandler = { open() {}, message() {}, close() {}, idleTimeout: 60 } as unknown as
      import('bun').WebSocketHandler<unknown>
    const composed = composeHttpHandler({
      landing: { fetch: async () => new Response(null, { status: 404 }), websocket: wsHandler },
      defaultHandler: makeDefault(),
    })
    expect(composed.websocket).toBe(wsHandler)
  })
  test('exposes a no-op websocket when no landing is wired', () => {
    const composed = composeHttpHandler({ defaultHandler: makeDefault() })
    expect(composed.websocket).toBeDefined()
    expect(typeof composed.websocket.open).toBe('function')
    expect(typeof composed.websocket.message).toBe('function')
  })
})

describe('composeHttpHandler — slug-check routing (P1.5 § 1.5.8)', () => {
  // Argus r2 [BLOCKING #2] regression. The /api/v1/slug/check handler
  // shipped in onboarding/api/slug-check.ts (with 9 unit tests) but
  // NOTHING routed it — production fell through to the default 404 and
  // the slug-picker UX could not preflight before driving rename.
  test('GET /api/v1/slug/check routes to the wired handler', async () => {
    let calls = 0
    const composed = composeHttpHandler({
      slugCheckHandler: async () => {
        calls++
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
      defaultHandler: makeDefault('def-404'),
    })
    const res = await composed.fetch(
      new Request('http://x/api/v1/slug/check?slug=nova&user_id=u-1'),
      fakeServer(),
    )
    expect(calls).toBe(1)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('non-GET methods do NOT route to slug-check', async () => {
    let calls = 0
    const composed = composeHttpHandler({
      slugCheckHandler: async () => {
        calls++
        return new Response('should-not-fire')
      },
      defaultHandler: makeDefault('def'),
    })
    const res = await composed.fetch(
      new Request('http://x/api/v1/slug/check?slug=nova', { method: 'POST', body: '{}' }),
      fakeServer(),
    )
    expect(calls).toBe(0)
    expect(res.status).toBe(404)
  })

  test('falls through to default when slugCheckHandler unset', async () => {
    const composed = composeHttpHandler({ defaultHandler: makeDefault('def-404') })
    const res = await composed.fetch(
      new Request('http://x/api/v1/slug/check?slug=foo&user_id=u-1'),
      fakeServer(),
    )
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('def-404')
  })

  test('slug-check fires AHEAD of landing — picker preflight is unambiguous', async () => {
    // /api/v1/slug/check must NOT be shadowed by the landing chain
    // (e.g. a future addition to LANDING_PATHS that swallowed the
    // prefix would hide this route). Pin precedence by wiring both
    // and asserting the picker handler runs.
    let pickerCalls = 0
    let landingCalls = 0
    const composed = composeHttpHandler({
      slugCheckHandler: async () => {
        pickerCalls++
        return new Response('picker', { status: 200 })
      },
      landing: {
        fetch: async () => {
          landingCalls++
          return new Response('landing', { status: 200 })
        },
        websocket: { open() {}, message() {}, close() {} },
      },
      defaultHandler: makeDefault(),
    })
    await composed.fetch(
      new Request('http://x/api/v1/slug/check?slug=nova&user_id=u-1'),
      fakeServer(),
    )
    expect(pickerCalls).toBe(1)
    expect(landingCalls).toBe(0)
  })
})

describe('LANDING_ROUTE_PATHS', () => {
  test('is the locked set of landing-owned exact paths', () => {
    expect(LANDING_ROUTE_PATHS.has('/chat')).toBe(true)
    expect(LANDING_ROUTE_PATHS.has('/chat.js')).toBe(true)
    expect(LANDING_ROUTE_PATHS.has('/ws/chat')).toBe(true)
    expect(LANDING_ROUTE_PATHS.has('/api/v1/sign-up')).toBe(true)
    expect(LANDING_ROUTE_PATHS.has('/invite')).toBe(true)
    expect(LANDING_ROUTE_PATHS.has('/invite.js')).toBe(true)
    expect(LANDING_ROUTE_PATHS.has('/onboarding/invite-accept')).toBe(true)
    // 2026-05-28 — per-instance /start?token= 302→/chat?start= trampoline
    // for returning-user signins on slug-renamed instances. Without this
    // allowlist entry the per-instance gateway 404'd the redirect handler
    // (rainman.neutron.example/start?token=… incident, prod 16:24 PT).
    expect(LANDING_ROUTE_PATHS.has('/start')).toBe(true)
    expect(LANDING_ROUTE_PATHS.has('/healthz')).toBe(false)
    expect(LANDING_ROUTE_PATHS.has('/connect/v1/messages')).toBe(false)
  })
})

describe('composeHttpHandler — Sprint 28 /avatar.png route', () => {
  test('routes GET /avatar.png to the avatarHandler', async () => {
    let called = 0
    const composed = composeHttpHandler({
      avatarHandler: () => {
        called++
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      },
      defaultHandler: makeDefault(),
    })
    const res = await composed.fetch(new Request('http://x/avatar.png'), fakeServer())
    expect(called).toBe(1)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  test('falls through when avatarHandler is not wired', async () => {
    const composed = composeHttpHandler({
      defaultHandler: makeDefault('default-404'),
    })
    const res = await composed.fetch(new Request('http://x/avatar.png'), fakeServer())
    expect(res.status).toBe(404)
  })

  test('POST /avatar.png is NOT routed to the avatarHandler (GET-only)', async () => {
    let called = 0
    const composed = composeHttpHandler({
      avatarHandler: () => {
        called++
        return new Response('img', { status: 200 })
      },
      defaultHandler: makeDefault(),
    })
    const res = await composed.fetch(
      new Request('http://x/avatar.png', { method: 'POST' }),
      fakeServer(),
    )
    expect(called).toBe(0)
    expect(res.status).toBe(404)
  })

  test('routes GET /profile-pic/candidate/<id>.png to the candidateHandler (Codex r2 P2)', async () => {
    const calls: string[] = []
    const composed = composeHttpHandler({
      candidateHandler: (req) => {
        calls.push(new URL(req.url).pathname)
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      },
      defaultHandler: makeDefault(),
    })
    const res = await composed.fetch(
      new Request('http://x/profile-pic/candidate/cand-A.png'),
      fakeServer(),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(calls).toEqual(['/profile-pic/candidate/cand-A.png'])
  })

  test('candidate route falls through when handler is not wired', async () => {
    const composed = composeHttpHandler({
      defaultHandler: makeDefault('default-404'),
    })
    const res = await composed.fetch(
      new Request('http://x/profile-pic/candidate/cand-A.png'),
      fakeServer(),
    )
    expect(res.status).toBe(404)
  })
})
