/**
 * landing/server tests — the landing HTTP surface (`/chat` SPA shell,
 * `/chat-react.js` bundle, `/start` rewrite, `/api/v1/sign-up` redirect,
 * `/onboarding/telegram`).
 *
 * The legacy `/ws/chat` onboarding WebSocket was removed (onboarding +
 * chat are unified on the per-instance `/ws/app/chat` Expo-app socket),
 * so the landing server no longer upgrades a websocket; a request to the
 * old path now 404s like any unknown route.
 *
 * Codex r1 P1 fix verification: the web sign-up path now resolves to a
 * working surface instead of a 404.
 */

import { describe, expect, test, mock } from 'bun:test'
import { createLandingServer, computeAssetEtag, type ChatBridge, type PendingChatClaim } from '../server.ts'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// The landing server no longer consumes a bridge (the `/ws/chat` socket
// that drove it was removed), but the optional field still accepts one.
// These tests pass a stub bridge to pin that back-compat.
function makeBridge(overrides: Partial<ChatBridge> = {}): ChatBridge {
  return {
    validateStartToken: mock(async ({ start_token }: { start_token: string }) =>
      start_token === 'good'
        ? ({
            project_slug: 'alice',
            user_id: 'u-1',
            jti: 'jti-1',
            expires_at_ms: Date.now() + 60_000,
          } satisfies PendingChatClaim)
        : null,
    ),
    startSession: mock(async () => true),
    handleInbound: mock(async () => {}),
    ...overrides,
  }
}

// ISSUES #353 — pure function backing the /chat-react.js cache-busting ETag
// (see `createLandingServer`'s route handler + module header above it).
describe('computeAssetEtag', () => {
  test('is deterministic for the same bytes', () => {
    expect(computeAssetEtag('const x = 1;')).toBe(computeAssetEtag('const x = 1;'))
  })

  test('changes when the bytes change (the whole point of cache-busting)', () => {
    expect(computeAssetEtag('const x = 1;')).not.toBe(computeAssetEtag('const x = 2;'))
  })

  test('is a quoted opaque string (RFC 9110 ETag syntax)', () => {
    const etag = computeAssetEtag('hello world')
    expect(etag.startsWith('"')).toBe(true)
    expect(etag.endsWith('"')).toBe(true)
  })
})

describe('createLandingServer', () => {
  test('GET /chat returns the React chat shell', async () => {
    const bridge = makeBridge()
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
    // We don't actually boot Bun.serve; we just exercise fetch().
    const fakeServer = {
      upgrade(): boolean {
        return true
      },
    } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/chat'), fakeServer)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Neutron')
    // React shell mounts into #root and loads the bundle.
    expect(text).toContain('id="root"')
    expect(text).toContain('/chat-react.js')
  })

  test('GET /chat-react.js serves the React/assistant-ui bundle', async () => {
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
    const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/chat-react.js'), fakeServer)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    const body = await res.text()
    // The bundle carries React + assistant-ui + chat-core — large + non-empty.
    expect(body.length).toBeGreaterThan(100_000)
  }, 30_000)

  // ISSUES #353 — cache-busting: no unversioned `max-age` (browsers must
  // revalidate) + a strong content ETag that changes iff the bundle's bytes do,
  // so a redeploy is never masked by a stale cached copy. See `computeAssetEtag`.
  describe('/chat-react.js cache-busting (#353)', () => {
    test('serves cache-control: no-cache with a strong ETag over the bundle bytes', async () => {
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
      const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
      const res = await handler.fetch(new Request('http://x.test/chat-react.js'), fakeServer)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-cache')
      const etag = res.headers.get('etag')
      expect(etag).not.toBeNull()
      const body = await res.text()
      expect(etag).toBe(computeAssetEtag(body))
    }, 30_000)

    test('a matching If-None-Match round-trips a 304 with no body (unchanged bytes)', async () => {
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
      const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
      const first = await handler.fetch(new Request('http://x.test/chat-react.js'), fakeServer)
      const etag = first.headers.get('etag')
      expect(etag).not.toBeNull()
      const second = await handler.fetch(
        new Request('http://x.test/chat-react.js', { headers: { 'if-none-match': etag as string } }),
        fakeServer,
      )
      expect(second.status).toBe(304)
      expect(await second.text()).toBe('')
      expect(second.headers.get('etag')).toBe(etag)
    }, 30_000)

    test('a stale If-None-Match (simulating a post-deploy client) gets a fresh 200', async () => {
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
      const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
      const res = await handler.fetch(
        new Request('http://x.test/chat-react.js', { headers: { 'if-none-match': '"sha256-stale-from-before-deploy"' } }),
        fakeServer,
      )
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body.length).toBeGreaterThan(100_000)
    }, 30_000)
  })

  test('GET /ws/chat now 404s — the legacy onboarding socket was removed (chat moved to /ws/app/chat)', async () => {
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
    const upgrade = mock(() => true)
    const fakeServer = { upgrade } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/ws/chat?start=good'), fakeServer)
    expect(res.status).toBe(404)
    // The landing server never attempts an upgrade for this path anymore.
    expect(upgrade).not.toHaveBeenCalled()
  })

  test('unknown route returns 404', async () => {
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
    const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/anything-else'), fakeServer)
    expect(res.status).toBe(404)
  })

  // ─────────────────────────────────────────────────────────────────
  // 2026-05-22 sprint — per-instance `/start?token=` rewrite handler.
  // The identity service's `onReturningWebSignin` builds per-instance
  // deep links pointing at `<slug>.<base>/start?token=...` for owners
  // who have picked a real URL slug; without this handler the
  // per-instance gateway 404'd the entry point because the landing
  // server only knew `/chat` + `/recover`.
  // ─────────────────────────────────────────────────────────────────
  describe('/start?token= rewrite (per-instance entry point, 2026-05-22)', () => {
    test('GET /start?token=<jwt> 302s to /chat?start=<jwt>', async () => {
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
      const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
      const res = await handler.fetch(
        new Request('http://prism.test/start?token=abc.def.ghi'),
        fakeServer,
      )
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/chat?start=abc.def.ghi')
    })

    test('GET /start?start=<jwt> (legacy compat) also 302s to /chat?start=<jwt>', async () => {
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
      const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
      const res = await handler.fetch(
        new Request('http://prism.test/start?start=legacy.jwt'),
        fakeServer,
      )
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/chat?start=legacy.jwt')
    })

    test('GET /start without ?token or ?start returns 400', async () => {
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
      const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
      const res = await handler.fetch(new Request('http://prism.test/start'), fakeServer)
      expect(res.status).toBe(400)
    })

    test('propagates ?debug= so the destination chat.html re-enables debug', async () => {
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
      const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
      const res = await handler.fetch(
        new Request('http://prism.test/start?token=jwt&debug=1'),
        fakeServer,
      )
      expect(res.status).toBe(302)
      const loc = res.headers.get('location') ?? ''
      expect(loc).toContain('start=jwt')
      expect(loc).toContain('debug=1')
    })

    test('handler does NOT validate the token — that is /chat`s job downstream', async () => {
      // The handler is a thin URL rewrite; the per-instance gateway's
      // /chat handler (via the downstream chat upgrade's
      // validateStartToken) is the auth gate. The rewrite must NOT 401
      // for a malformed-looking token — that would block /chat from
      // surfacing its own 401 + user-facing error envelope.
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
      const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
      const res = await handler.fetch(
        new Request('http://prism.test/start?token=not-a-real-jwt'),
        fakeServer,
      )
      expect(res.status).toBe(302)
    })
  })

  test('throws when static_dir missing chat-react.html', () => {
    expect(() =>
      createLandingServer({ static_dir: '/no/such/path', bridge: makeBridge() }),
    ).toThrow()
  })

  test('Codex r9 P1: GET /api/v1/sign-up?via=tg redirects to identity OAuth', async () => {
    const handler = createLandingServer({
      static_dir: dirname(HERE),
      bridge: makeBridge(),
      resolveSignupRedirect: ({ via }) => `https://auth.neutron.example/oauth/start?via=${via}`,
    })
    const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/api/v1/sign-up?via=tg'), fakeServer)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://auth.neutron.example/oauth/start?via=tg')
  })

  test('Codex r9 P1: GET /api/v1/sign-up returns 503 when redirect not configured', async () => {
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
    const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/api/v1/sign-up?via=tg'), fakeServer)
    expect(res.status).toBe(503)
  })

  test('Codex r9 P1: defaults via=web when query missing', async () => {
    const handler = createLandingServer({
      static_dir: dirname(HERE),
      bridge: makeBridge(),
      resolveSignupRedirect: ({ via }) => `https://auth.example/oauth/start?via=${via}`,
    })
    const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/api/v1/sign-up'), fakeServer)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://auth.example/oauth/start?via=web')
  })

  test('Argus follow-up: via=telegram resolves to the same target as via=tg', async () => {
    const handler = createLandingServer({
      static_dir: dirname(HERE),
      bridge: makeBridge(),
      resolveSignupRedirect: ({ via }) => `https://auth.example/oauth/start?via=${via}`,
    })
    const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
    const tgRes = await handler.fetch(new Request('http://x.test/api/v1/sign-up?via=tg'), fakeServer)
    const telegramRes = await handler.fetch(
      new Request('http://x.test/api/v1/sign-up?via=telegram'),
      fakeServer,
    )
    expect(tgRes.status).toBe(302)
    expect(telegramRes.status).toBe(302)
    expect(telegramRes.headers.get('location')).toBe(tgRes.headers.get('location'))
    expect(telegramRes.headers.get('location')).toBe('https://auth.example/oauth/start?via=tg')
  })

  test('Argus follow-up: unrecognized via still defaults to web', async () => {
    const handler = createLandingServer({
      static_dir: dirname(HERE),
      bridge: makeBridge(),
      resolveSignupRedirect: ({ via }) => `https://auth.example/oauth/start?via=${via}`,
    })
    const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/api/v1/sign-up?via=bogus'), fakeServer)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://auth.example/oauth/start?via=web')
  })

  test('Sprint 26: GET /onboarding/telegram serves the landing HTML when present', async () => {
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
    const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(
      new Request('http://x.test/onboarding/telegram?bot=alice_bot&signin_event_id=abc-123-def&instance=t-dddddddd'),
      fakeServer,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const csp = res.headers.get('content-security-policy') ?? ''
    // CSP must lock down framing and form action.
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'none'")
    const text = await res.text()
    // The HTML carries the launcher script + button.
    expect(text).toContain('Open in Telegram')
    expect(text).toContain('id="deeplink"')
  })

  test('Sprint 26: GET /onboarding/telegram 404s when the static file is absent', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-landing-'))
    // Provide chat-react.html (required by createLandingServer) but NO
    // onboarding-telegram.html.
    writeFileSync(join(tmp, 'chat-react.html'), '<html><div id="root"></div></html>')
    try {
      const handler = createLandingServer({ static_dir: tmp, bridge: makeBridge() })
      const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
      const res = await handler.fetch(
        new Request('http://x.test/onboarding/telegram'),
        fakeServer,
      )
      expect(res.status).toBe(404)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
