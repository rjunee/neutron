/**
 * Regression: per-instance gateway `/start?token=` allowlist (2026-05-28).
 *
 * Incident — Sam completed Google OAuth signin on his renamed
 * `rainman` instance; identity 302'd him to
 * `https://rainman.neutron.example/start?token=<jwt>` (the renamed-
 * instance returning-user redirect composed by
 * `identity/main.ts:onReturningWebSignin` via
 * `signup/deep-link-builder.ts:buildPerOwnerDeepLink`). The browser
 * showed "Not Found". Root cause: the per-instance gateway's
 * `LANDING_PATHS` allowlist in `gateway/http/compose.ts` admitted
 * `/chat`, `/chat.js`, `/api/v1/sign-up`, `/invite[.js]`,
 * `/onboarding/invite-accept`, and `/recover` — but NOT `/start`. The
 * 2026-05-22 sprint that added the `/start?token=` 302 handler at
 * `landing/server.ts:674-689` wired both ends of the contract
 * (`buildPerOwnerDeepLink` emits `<slug>.<apex>/start?token=…`; the
 * landing handler 302s to `/chat?start=<token>`) but never updated the
 * composer's allowlist. Latent for 6 days; surfaced only for
 * renamed-instance + returning-signin (first-signin uses a different
 * trampoline; placeholder-handle instances land on `chat.<apex>/start`
 * via the platform proxy which doesn't go through the composer).
 *
 * Fix: add `/start` to `LANDING_PATHS`. These tests pin the routing
 * decision at the composer level so a future allowlist edit can't
 * silently drop it.
 */

import { describe, expect, test } from 'bun:test'
import { composeHttpHandler, type LandingHandler } from '../compose.ts'

function fakeServer(): import('bun').Server<unknown> {
  return {
    upgrade: () => true,
  } as unknown as import('bun').Server<unknown>
}

/**
 * Minimal landing handler that mirrors the production
 * `landing/server.ts:674-689` `/start?token=` 302 handler. The real
 * handler is exercised exhaustively in `landing/__tests__/server.test.ts`
 * (`/start?token= rewrite (per-instance entry point, 2026-05-22)`); these
 * tests only need a stand-in to assert the composer routes to landing
 * for `/start` rather than falling through to the default 404.
 */
function makeLandingWithStartHandler(): LandingHandler {
  return {
    fetch: async (req) => {
      const url = new URL(req.url)
      if (url.pathname === '/start' && req.method === 'GET') {
        const token =
          url.searchParams.get('token') ?? url.searchParams.get('start') ?? ''
        if (token.length === 0) {
          return new Response('missing start token', { status: 400 })
        }
        const dest = new URL('/chat', `${url.protocol}//${url.host}`)
        dest.searchParams.set('start', token)
        for (const key of ['debug', 'import']) {
          const v = url.searchParams.get(key)
          if (v !== null) dest.searchParams.set(key, v)
        }
        return new Response(null, {
          status: 302,
          headers: { location: `${dest.pathname}${dest.search}` },
        })
      }
      return new Response('landing-404', { status: 404 })
    },
    websocket: { open() {}, message() {}, close() {} },
  }
}

function makeDefault(body = 'default-404'): (req: Request) => Response {
  return (): Response => new Response(body, { status: 404 })
}

describe('composeHttpHandler — /start?token= per-project routing (2026-05-28)', () => {
  test('GET /start?token=<jwt> routes through landing and 302s to /chat?start=<jwt>', async () => {
    const composed = composeHttpHandler({
      landing: makeLandingWithStartHandler(),
      defaultHandler: makeDefault('NOT-REACHED'),
    })
    const res = await composed.fetch(
      new Request('http://rainman.neutron.example/start?token=abc.def.ghi'),
      fakeServer(),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/chat?start=abc.def.ghi')
  })

  test('GET /start?token=<jwt> with NO landing wired falls through gracefully (default 404)', async () => {
    // Without landing the composer must NOT crash — the
    // `isLandingRoute` guard pairs with `landing !== undefined`, so the
    // allowlist membership is harmless in isolation. Pins the
    // safe-fallback for boot configurations that skip landing
    // (cross-instance API smoke harness, dev shims).
    const composed = composeHttpHandler({
      defaultHandler: makeDefault('def-404'),
    })
    const res = await composed.fetch(
      new Request('http://rainman.neutron.example/start?token=abc.def.ghi'),
      fakeServer(),
    )
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('def-404')
  })

  test('GET /start without ?token or ?start reaches the landing handler (400 not 404)', async () => {
    // Verifies the routing decision: a tokenless /start must land on
    // the landing handler's existing 400 branch, NOT be silently
    // dropped at the composer's default 404. The handler is the
    // single source of truth for the "missing token" UX.
    const composed = composeHttpHandler({
      landing: makeLandingWithStartHandler(),
      defaultHandler: makeDefault('NOT-REACHED'),
    })
    const res = await composed.fetch(
      new Request('http://rainman.neutron.example/start'),
      fakeServer(),
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('missing start token')
  })

  test('GET /start preserves ?debug= + ?import= pass-through via landing', async () => {
    // Sanity: the composer must hand the request to landing fully
    // intact. `landing/server.ts:680-684` strips the debug + import
    // params back onto the redirect location; this proves the composer
    // doesn't accidentally rebuild the URL or drop query params.
    const composed = composeHttpHandler({
      landing: makeLandingWithStartHandler(),
      defaultHandler: makeDefault(),
    })
    const res = await composed.fetch(
      new Request(
        'http://rainman.neutron.example/start?token=jwt&debug=1&import=chatgpt',
      ),
      fakeServer(),
    )
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') ?? ''
    expect(loc).toContain('start=jwt')
    expect(loc).toContain('debug=1')
    expect(loc).toContain('import=chatgpt')
  })

  test('precedence: /start does NOT shadow cross-instance or telegram handlers', async () => {
    // Sanity: adding /start to the landing allowlist must not promote
    // it ahead of the existing precedence chain (telegram > landing >
    // cross-instance > default). A future regression could move the
    // allowlist check earlier and accidentally swallow telegram
    // webhooks — pin the order.
    const order: string[] = []
    const composed = composeHttpHandler({
      telegramWebhookHandler: async () => {
        order.push('tg')
        return new Response('tg', { status: 200 })
      },
      landing: {
        fetch: async (req) => {
          order.push('landing')
          // Mirror the production /start 302 so the per-instance chain
          // sees a real terminal response, not a fall-through 404
          // that lets cross-instance run after landing for the same
          // request (which would be a serious precedence regression).
          const url = new URL(req.url)
          if (url.pathname === '/start') {
            const token =
              url.searchParams.get('token') ?? url.searchParams.get('start') ?? ''
            if (token.length === 0) {
              return new Response('missing start token', { status: 400 })
            }
            return new Response(null, {
              status: 302,
              headers: { location: `/chat?start=${encodeURIComponent(token)}` },
            })
          }
          return new Response('l', { status: 200 })
        },
        websocket: { open() {}, message() {}, close() {} },
      },
      connectHandler: async (req) => {
        const url = new URL(req.url)
        if (url.pathname.startsWith('/connect/')) {
          order.push('ct')
          return new Response('ct', { status: 200 })
        }
        return null
      },
      defaultHandler: makeDefault(),
    })
    await composed.fetch(
      new Request('http://x/webhook/telegram', { method: 'POST' }),
      fakeServer(),
    )
    await composed.fetch(new Request('http://x/start?token=t'), fakeServer())
    await composed.fetch(new Request('http://x/connect/v1/x'), fakeServer())
    expect(order).toEqual(['tg', 'landing', 'ct'])
  })
})
