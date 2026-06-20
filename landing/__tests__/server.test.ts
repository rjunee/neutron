/**
 * landing/server tests — `/chat` route serves chat.html, `/ws/chat`
 * upgrade auths via start_token + delegates to the bridge.
 *
 * Codex r1 P1 fix verification: the web sign-up path now resolves to a
 * working surface instead of a 404.
 */

import { describe, expect, test, mock } from 'bun:test'
import { createLandingServer, type ChatBridge, type PendingChatClaim } from '../server.ts'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

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

describe('createLandingServer', () => {
  test('GET /chat returns the chat.html', async () => {
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
    expect(text).toContain('id="log"')
  })

  test('GET /chat.js bundles chat.ts on first request (Codex r2 P1 fix)', async () => {
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
    const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/chat.js'), fakeServer)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    const body = await res.text()
    // The bundled JS contains the bootstrap entry point + the ChatClient class.
    expect(body).toContain('bootChatFromQueryString')
    expect(body).toContain('ChatClient')
    // Sprint 28 Codex r6 P1 — the bundled JS contains the image-gallery
    // render branch so the web client can show portrait thumbnails.
    expect(body).toContain('image-gallery')
  })

  test('GET /chat ships the image-gallery CSS for the portrait picker (Codex r6 P1)', async () => {
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
    const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/chat'), fakeServer)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('.buttons.image-gallery')
    expect(body).toContain('.thumb')
  })

  test('GET /ws/chat without ?start returns 400', async () => {
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
    const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/ws/chat'), fakeServer)
    expect(res.status).toBe(400)
  })

  test('GET /ws/chat with bad token returns 401', async () => {
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
    const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/ws/chat?start=bogus'), fakeServer)
    expect(res.status).toBe(401)
  })

  test('GET /ws/chat with good token attempts upgrade', async () => {
    const upgrade = mock(() => true)
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
    const fakeServer = { upgrade } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/ws/chat?start=good'), fakeServer)
    expect(upgrade).toHaveBeenCalled()
    expect(res.status).toBe(101)
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
  // server only knew `/chat` + `/ws/chat` + `/recover`.
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
      // /chat handler (via /ws/chat.bridge.validateStartToken) is the
      // auth gate. The rewrite must NOT 401 for a malformed-looking
      // token — that would block /chat from surfacing its own 401 +
      // user-facing error envelope.
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
      const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
      const res = await handler.fetch(
        new Request('http://prism.test/start?token=not-a-real-jwt'),
        fakeServer,
      )
      expect(res.status).toBe(302)
    })
  })

  test('throws when static_dir missing chat.html', () => {
    expect(() =>
      createLandingServer({ static_dir: '/no/such/path', bridge: makeBridge() }),
    ).toThrow()
  })

  test('Codex r5 P1: open(ws) calls bridge.startSession', async () => {
    const startSession = mock(async () => true)
    const bridge = makeBridge({ startSession })
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
    const data = {
      project_slug: 'alice',
      user_id: 'u-1',
      pending_claim: { project_slug: 'alice', user_id: 'u-1', jti: 'j', expires_at_ms: Date.now() + 60_000 },
      session_started: false,
    }
    const sent: string[] = []
    const ws = {
      data,
      send: (s: string) => sent.push(s),
      close: () => {},
    }
    // Cast to any to avoid pulling Bun's full ServerWebSocket type into the test.
    await (handler.websocket.open as unknown as (ws: unknown) => Promise<void>)(ws)
    expect(startSession).toHaveBeenCalled()
    expect(data.session_started).toBe(true)
  })

  test('T10 r3 (Argus #1 BLOCKING): send lambda treats ws.send -1 as backpressure (queued), not closed-socket', async () => {
    // Bun ServerWebSocket.send contract:
    //   0  → message dropped (socket closed)  → throw (engine catches → was_new=false → reconnect re-emits)
    //   -1 → backpressure (queued; flushes on drain) → do NOT throw
    //   >0 → bytes sent                              → do NOT throw
    //
    // Pre-r3 `wrote <= 0` lumped backpressure (-1) into closed-socket.
    // The throw propagated through the registry → engine → bridge
    // and tore the WS down with 4001 mid-onboarding the moment a
    // slow client got behind on a larger envelope.
    const bridge = makeBridge()
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
    const data = {
      project_slug: 'alice',
      user_id: 'u-1',
      pending_claim: { project_slug: 'alice', user_id: 'u-1', jti: 'j', expires_at_ms: Date.now() + 60_000 },
      session_started: false,
    } as { project_slug: string; user_id: string; pending_claim: PendingChatClaim; session_started: boolean; send?: (o: unknown) => void }
    let nextReturn: number = 1
    const ws = {
      data,
      send: (_: string) => nextReturn,
      close: () => {},
    }
    await (handler.websocket.open as unknown as (ws: unknown) => Promise<void>)(ws)
    const send = data.send
    expect(send).toBeDefined()
    if (send === undefined) return

    // -1 (backpressure) must NOT throw.
    nextReturn = -1
    expect(() => send({ type: 'agent_message', body: 'queued under backpressure' })).not.toThrow()

    // A positive write must NOT throw.
    nextReturn = 42
    expect(() => send({ type: 'agent_message', body: 'normal write' })).not.toThrow()

    // 0 (real closed-socket) MUST still throw — that's the discriminator
    // the engine uses to flag the welcome envelope as undelivered so
    // reconnect re-emits.
    nextReturn = 0
    expect(() => send({ type: 'agent_message', body: 'after socket closed' })).toThrow(/socket closed/)
  })

  test('Codex r5 P2: open(ws) closes the socket on claim race', async () => {
    const closeFn = mock(() => {})
    const startSession = mock(async () => false)
    const bridge = makeBridge({ startSession })
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
    const data = {
      project_slug: 'alice',
      user_id: 'u-1',
      pending_claim: { project_slug: 'alice', user_id: 'u-1', jti: 'j', expires_at_ms: Date.now() + 60_000 },
      session_started: false,
    }
    const ws = {
      data,
      send: () => {},
      close: closeFn,
    }
    await (handler.websocket.open as unknown as (ws: unknown) => Promise<void>)(ws)
    expect(closeFn).toHaveBeenCalled()
    expect(data.session_started).toBe(false)
  })

  // ─────────────────────────────────────────────────────────────────
  // ISSUES #94 (2026-06-05) — "session not started" when typing in
  // General after onboarding reaches `completed`. A reconnect / reload
  // re-presented the now-spent one-shot `?start=` token; the atomic jti
  // claim failed (startSession → false), the open handler closed the
  // socket with 4001, and session_started stayed false — so the
  // authenticated user (valid 30d session cookie) was stranded with
  // "session not started" on every inbound. The fix: when a same-user
  // session cookie rode the upgrade, resume via the cookie-only path
  // instead of closing.
  // ─────────────────────────────────────────────────────────────────
  test('ISSUES #94: consumed jti + same-user cookie fallback → resume via cookie (no 4001, inbound works)', async () => {
    const closeFn = mock(() => {})
    const startSession = mock(async () => false) // jti already consumed → claim "race"
    const resumeCookieSession = mock(async () => {})
    const handleInbound = mock(async () => {})
    const bridge = makeBridge({ startSession, resumeCookieSession, handleInbound })
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
    const data = {
      project_slug: 'alice',
      user_id: 'u-1',
      pending_claim: { project_slug: 'alice', user_id: 'u-1', jti: 'consumed', expires_at_ms: Date.now() + 60_000 },
      session_started: false,
      // Resolved at upgrade time: a valid same-user session cookie rode the
      // upgrade alongside the (now spent) ?start= token.
      cookie_fallback_claim: { project_slug: 'alice', user_id: 'u-1' },
    }
    const sent: string[] = []
    const ws = { data, send: (s: string) => sent.push(s), close: closeFn }
    await (handler.websocket.open as unknown as (ws: unknown) => Promise<void>)(ws)
    // Did NOT close — the authed user is not stranded.
    expect(closeFn).not.toHaveBeenCalled()
    // Resumed via the cookie-only path (re-registers the sender, re-emits seed).
    expect(resumeCookieSession).toHaveBeenCalled()
    expect(data.session_started).toBe(true)
    // An inbound message now walks handleInbound, NOT the "session not
    // started" guard at server.ts:1164.
    sent.length = 0
    await (handler.websocket.message as unknown as (ws: unknown, m: string) => Promise<void>)(
      ws,
      JSON.stringify({ type: 'user_message', body: 'good' }),
    )
    expect(handleInbound).toHaveBeenCalled()
    expect(sent.join('')).not.toContain('session not started')
  })

  test('ISSUES #94: consumed jti with NO cookie fallback still closes (claim-race unchanged)', async () => {
    const closeFn = mock(() => {})
    const startSession = mock(async () => false)
    const resumeCookieSession = mock(async () => {})
    const bridge = makeBridge({ startSession, resumeCookieSession })
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
    const data = {
      project_slug: 'alice',
      user_id: 'u-1',
      pending_claim: { project_slug: 'alice', user_id: 'u-1', jti: 'consumed', expires_at_ms: Date.now() + 60_000 },
      session_started: false,
      // No cookie_fallback_claim — a genuine pre-open jti race with no
      // session cookie. Must still close cleanly (no silent cross-auth).
    }
    const ws = { data, send: () => {}, close: closeFn }
    await (handler.websocket.open as unknown as (ws: unknown) => Promise<void>)(ws)
    expect(closeFn).toHaveBeenCalled()
    expect(resumeCookieSession).not.toHaveBeenCalled()
    expect(data.session_started).toBe(false)
  })

  test('ISSUES #94 Codex r1 P1: startSession THROW (bootstrap fail, token unspent) still closes — cookie fallback NOT used', async () => {
    // A throw means engine bootstrap failed with the jti UNSPENT. The retry
    // contract must hold: close so the client reconnects + retries, rather
    // than marking a session live whose opening prompt never emitted.
    const closeFn = mock(() => {})
    const startSession = mock(async () => {
      throw new Error('engine.start failed')
    })
    const resumeCookieSession = mock(async () => {})
    const bridge = makeBridge({ startSession, resumeCookieSession })
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
    const data = {
      project_slug: 'alice',
      user_id: 'u-1',
      pending_claim: { project_slug: 'alice', user_id: 'u-1', jti: 'unspent', expires_at_ms: Date.now() + 60_000 },
      session_started: false,
      cookie_fallback_claim: { project_slug: 'alice', user_id: 'u-1' },
    }
    const ws = { data, send: () => {}, close: closeFn }
    await (handler.websocket.open as unknown as (ws: unknown) => Promise<void>)(ws)
    expect(closeFn).toHaveBeenCalled()
    expect(resumeCookieSession).not.toHaveBeenCalled()
    expect(data.session_started).toBe(false)
  })

  test('ISSUES #94 Codex r1 P1: slug-rename — same-user cookie with a DIFFERENT slug is still stashed', async () => {
    // No-restart slug rename: the token claim's `project_slug` collapses to the
    // gateway's frozen downstream slug while the cookie resolver reports the
    // CURRENT slug. The single-instance cookie resolver already guarantees
    // same-instance identity, so a `user_id` match is sufficient — the fallback MUST be
    // stashed despite the slug strings differing.
    let captured: { cookie_fallback_claim?: unknown } | null = null
    const upgrade = mock((_req: unknown, opts: { data: unknown }) => {
      captured = opts.data as { cookie_fallback_claim?: unknown }
      return true
    })
    const cookieToUserClaim = mock(async () => ({ project_slug: 'renamed-slug', user_id: 'u-1' }))
    const handler = createLandingServer({
      static_dir: dirname(HERE),
      bridge: makeBridge(),
      cookieToUserClaim,
    })
    const fakeServer = { upgrade } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/ws/chat?start=good'), fakeServer)
    expect(res.status).toBe(101)
    expect(captured).not.toBeNull()
    expect((captured as unknown as { cookie_fallback_claim?: unknown }).cookie_fallback_claim).toEqual({
      project_slug: 'renamed-slug',
      user_id: 'u-1',
    })
  })

  test('ISSUES #94: happy-path jti claim still wins — cookie fallback NOT consulted', async () => {
    const startSession = mock(async () => true) // jti claim succeeds (first bring-up)
    const resumeCookieSession = mock(async () => {})
    const bridge = makeBridge({ startSession, resumeCookieSession })
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
    const data = {
      project_slug: 'alice',
      user_id: 'u-1',
      pending_claim: { project_slug: 'alice', user_id: 'u-1', jti: 'fresh', expires_at_ms: Date.now() + 60_000 },
      session_started: false,
      cookie_fallback_claim: { project_slug: 'alice', user_id: 'u-1' },
    }
    const ws = { data, send: () => {}, close: () => {} }
    await (handler.websocket.open as unknown as (ws: unknown) => Promise<void>)(ws)
    expect(startSession).toHaveBeenCalled()
    expect(resumeCookieSession).not.toHaveBeenCalled()
    expect(data.session_started).toBe(true)
  })

  test('ISSUES #94: good ?start= token upgrade stashes same-user cookie fallback (slug-rename accept path intact)', async () => {
    // The v0.1.133 slug-rename handoff lands on the renamed slug with a
    // fresh ?start= token. Token precedence is preserved (upgrade still
    // fires), and the cookie is resolved + stashed as a fallback WITHOUT
    // disturbing the validateStartToken accept path.
    let captured: { cookie_fallback_claim?: unknown; pending_claim?: unknown } | null = null
    const upgrade = mock((_req: unknown, opts: { data: unknown }) => {
      captured = opts.data as { cookie_fallback_claim?: unknown; pending_claim?: unknown }
      return true
    })
    const cookieToUserClaim = mock(async () => ({ project_slug: 'alice', user_id: 'u-1' }))
    const handler = createLandingServer({
      static_dir: dirname(HERE),
      bridge: makeBridge(),
      cookieToUserClaim,
    })
    const fakeServer = { upgrade } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/ws/chat?start=good'), fakeServer)
    expect(upgrade).toHaveBeenCalled()
    expect(res.status).toBe(101)
    expect(captured).not.toBeNull()
    // Token path is still the authority — pending_claim is set from the token.
    expect((captured as unknown as { pending_claim?: unknown }).pending_claim).toBeDefined()
    // Same-user cookie stashed as the consumed-token recovery net.
    expect((captured as unknown as { cookie_fallback_claim?: unknown }).cookie_fallback_claim).toEqual({
      project_slug: 'alice',
      user_id: 'u-1',
    })
  })

  test('ISSUES #94: cross-identity cookie is NOT stashed as a fallback', async () => {
    // Defense-in-depth: a session cookie for a DIFFERENT user must never
    // become a fallback for this token's user (no silent cross-auth).
    let captured: { cookie_fallback_claim?: unknown } | null = null
    const upgrade = mock((_req: unknown, opts: { data: unknown }) => {
      captured = opts.data as { cookie_fallback_claim?: unknown }
      return true
    })
    const cookieToUserClaim = mock(async () => ({ project_slug: 'alice', user_id: 'someone-else' }))
    const handler = createLandingServer({
      static_dir: dirname(HERE),
      bridge: makeBridge(),
      cookieToUserClaim,
    })
    const fakeServer = { upgrade } as unknown as import('bun').Server<unknown>
    const res = await handler.fetch(new Request('http://x.test/ws/chat?start=good'), fakeServer)
    expect(res.status).toBe(101)
    expect(captured).not.toBeNull()
    expect((captured as unknown as { cookie_fallback_claim?: unknown }).cookie_fallback_claim).toBeUndefined()
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

  test('Codex r5 P1: message(ws) before session_started is rejected', async () => {
    const handleInbound = mock(async () => {})
    const bridge = makeBridge({ handleInbound })
    const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
    const sent: string[] = []
    const ws = {
      data: {
        project_slug: 'alice',
        user_id: 'u-1',
        pending_claim: { project_slug: 'alice', user_id: 'u-1', jti: 'j', expires_at_ms: Date.now() + 60_000 },
        session_started: false,
      },
      send: (s: string) => sent.push(s),
      close: () => {},
    }
    await (handler.websocket.message as unknown as (ws: unknown, m: string) => Promise<void>)(
      ws,
      JSON.stringify({ type: 'user_message', body: 'hi' }),
    )
    expect(handleInbound).not.toHaveBeenCalled()
    expect(sent.length).toBe(1)
    const parsed = JSON.parse(sent[0]!)
    expect(parsed.type).toBe('error')
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

  // ─────────────────────────────────────────────────────────────────
  // 2026-05-27 persistent-session-cookie sprint (Part B) — cookie-auth
  // path on `/ws/chat`. The upgrade handler accepts EITHER a valid
  // `?start=<jwt>` (status quo precedence — token wins) OR a valid
  // session cookie via the optional `cookieToUserClaim` hook.
  // ─────────────────────────────────────────────────────────────────
  describe('/ws/chat cookie-auth path (persistent-session-cookie sprint, 2026-05-27)', () => {
    test('cookie-only WS upgrade succeeds with refreshed Set-Cookie on the 101', async () => {
      const upgrade = mock(() => true)
      const refreshedCookie =
        '__neutron_chat_session=alice.9999999999999.sigsigsig; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000'
      const cookieToUserClaim = mock(async () => ({
        project_slug: 'alice',
        user_id: 'u-cookie-1',
        set_cookie: refreshedCookie,
      }))
      const handler = createLandingServer({
        static_dir: dirname(HERE),
        bridge: makeBridge(),
        cookieToUserClaim,
      })
      const fakeServer = { upgrade } as unknown as import('bun').Server<unknown>
      const res = await handler.fetch(
        new Request('http://alice.test/ws/chat', {
          headers: { cookie: '__neutron_chat_session=alice.9999999999999.sigsigsig' },
        }),
        fakeServer,
      )
      expect(cookieToUserClaim).toHaveBeenCalled()
      expect(upgrade).toHaveBeenCalled()
      // The upgrade arg carries the refreshed Set-Cookie (newer Bun).
      const upgradeCallArgs = (upgrade as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]
      expect(upgradeCallArgs).toBeDefined()
      const upgradeOpts = upgradeCallArgs?.[1] as { headers?: Record<string, string> } | undefined
      expect(upgradeOpts?.headers?.['set-cookie']).toBe(refreshedCookie)
      // The 101 response shell ALSO carries it (older Bun).
      expect(res.status).toBe(101)
      expect(res.headers.get('set-cookie')).toBe(refreshedCookie)
    })

    test('cookie-only WS upgrade with no cookieToUserClaim wired returns 400 (back-compat)', async () => {
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge: makeBridge() })
      const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
      const res = await handler.fetch(
        new Request('http://alice.test/ws/chat', {
          headers: { cookie: '__neutron_chat_session=anything' },
        }),
        fakeServer,
      )
      // Without the hook, the cookie is invisible — request looks exactly
      // like a tokenless pre-sprint upgrade and gets the familiar 400.
      expect(res.status).toBe(400)
      expect(await res.text()).toBe('missing start token')
    })

    test('token wins over cookie — token path authorizes the upgrade (ISSUES #94: cookie now resolved as a fallback)', async () => {
      // 2026-06-05 (ISSUES #94) — the cookie hook IS now consulted on a
      // token-bearing upgrade, but ONLY to resolve a same-identity recovery
      // fallback (consumed-jti reconnect). The TOKEN still wins: the upgrade
      // is authorized off `validateStartToken`, `pending_claim` is set from
      // the token, and a cookie-hook FAILURE must never break token auth.
      const cookieToUserClaim = mock(async () => {
        throw new Error('cookie hook failure must not break token auth')
      })
      let captured: { pending_claim?: unknown } | null = null
      const upgrade = mock((_req: unknown, opts: { data: unknown }) => {
        captured = opts.data as { pending_claim?: unknown }
        return true
      })
      const handler = createLandingServer({
        static_dir: dirname(HERE),
        bridge: makeBridge(),
        cookieToUserClaim,
      })
      const fakeServer = { upgrade } as unknown as import('bun').Server<unknown>
      const res = await handler.fetch(
        new Request('http://alice.test/ws/chat?start=good', {
          headers: { cookie: '__neutron_chat_session=alice.9999999999999.sigsigsig' },
        }),
        fakeServer,
      )
      // A throwing cookie hook does NOT break the token upgrade.
      expect(upgrade).toHaveBeenCalled()
      expect(res.status).toBe(101)
      // The token is still the authority — pending_claim is set from it.
      expect(captured).not.toBeNull()
      expect((captured as unknown as { pending_claim?: unknown }).pending_claim).toBeDefined()
    })

    test('cookieToUserClaim returns null → 400 (cookie for different instance / expired / missing)', async () => {
      const cookieToUserClaim = mock(async () => null)
      const handler = createLandingServer({
        static_dir: dirname(HERE),
        bridge: makeBridge(),
        cookieToUserClaim,
      })
      const fakeServer = { upgrade: () => true } as unknown as import('bun').Server<unknown>
      const res = await handler.fetch(
        new Request('http://alice.test/ws/chat', {
          headers: { cookie: '__neutron_chat_session=bob.9999999999999.othersig' },
        }),
        fakeServer,
      )
      expect(cookieToUserClaim).toHaveBeenCalled()
      expect(res.status).toBe(400)
      expect(await res.text()).toBe('missing start token')
    })

    test('cookie-only upgrade WITHOUT a set_cookie field omits Set-Cookie on the 101 (no-refresh fallback)', async () => {
      // When the session-cookie sign path fails (HMAC throws — vanishingly
      // rare but possible), the wiring closure returns the claim WITHOUT
      // a `set_cookie` field rather than failing the upgrade. This pins
      // the no-refresh fallback so the cookie carries forward with its
      // existing expiry while the operator chases the sign failure.
      const cookieToUserClaim = mock(async () => ({
        project_slug: 'alice',
        user_id: 'u-cookie-no-refresh',
      }))
      const upgrade = mock(() => true)
      const handler = createLandingServer({
        static_dir: dirname(HERE),
        bridge: makeBridge(),
        cookieToUserClaim,
      })
      const fakeServer = { upgrade } as unknown as import('bun').Server<unknown>
      const res = await handler.fetch(
        new Request('http://alice.test/ws/chat', {
          headers: { cookie: '__neutron_chat_session=alice.9999999999999.sigsigsig' },
        }),
        fakeServer,
      )
      expect(res.status).toBe(101)
      expect(res.headers.get('set-cookie')).toBeNull()
      const upgradeCallArgs = (upgrade as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]
      const upgradeOpts = upgradeCallArgs?.[1] as { headers?: Record<string, string> } | undefined
      expect(upgradeOpts?.headers).toBeUndefined()
    })

    test('open(ws) skips bridge.startSession when pending_claim is null (cookie-only path)', async () => {
      // Pinned per the SocketState type change: cookie-only auth produces
      // `pending_claim: null` and the open handler must NOT call
      // `bridge.startSession` (there is no jti to claim + no welcome
      // envelope to fire — the user is resuming mid-session). It MUST
      // still flip `session_started: true` so inbound messages walk the
      // bridge's handleInbound normally.
      const startSession = mock(async () => true)
      const bridge = makeBridge({ startSession })
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
      const data = {
        project_slug: 'alice',
        user_id: 'u-cookie-1',
        pending_claim: null,
        session_started: false,
      }
      const ws = {
        data,
        send: () => 1,
        close: () => {},
      }
      await (handler.websocket.open as unknown as (ws: unknown) => Promise<void>)(ws)
      expect(startSession).not.toHaveBeenCalled()
      expect(data.session_started).toBe(true)
    })

    test('open(ws) calls bridge.resumeCookieSession on cookie-only path with active_topic_id (r2 BLOCKER fix)', async () => {
      // 2026-05-29 r2 BLOCKER fix (Codex catch) — the cookie-only WS open
      // path is the most common entry for a returning user (refresh on a
      // project topic). The landing server MUST forward to the bridge's
      // `resumeCookieSession` hook so the project-seed re-emit fires
      // there too — not only on fresh start-token or in-place topic_switch.
      const resumeCookieSession = mock(async () => {})
      const startSession = mock(async () => true)
      const bridge = makeBridge({ resumeCookieSession, startSession })
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
      const data = {
        project_slug: 'alice',
        user_id: 'u-cookie-2',
        pending_claim: null,
        session_started: false,
        active_topic_id: 'web:u-cookie-2:project-alpha',
      }
      const ws = {
        data,
        send: () => 1,
        close: () => {},
      }
      await (handler.websocket.open as unknown as (ws: unknown) => Promise<void>)(ws)
      expect(startSession).not.toHaveBeenCalled()
      expect(resumeCookieSession).toHaveBeenCalledTimes(1)
      const call = (resumeCookieSession as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
      const arg = call?.[0] as {
        project_slug: string
        user_id: string
        active_topic_id?: string
        send: (event: unknown) => void
      }
      expect(arg.project_slug).toBe('alice')
      expect(arg.user_id).toBe('u-cookie-2')
      expect(arg.active_topic_id).toBe('web:u-cookie-2:project-alpha')
      expect(typeof arg.send).toBe('function')
      expect(data.session_started).toBe(true)
    })

    test('open(ws) cookie-only path: emits session_ready{user_id} so the client can derive General without a JWT (Argus r3 P2 #1)', async () => {
      // 2026-05-30 Argus r3 P2 #1 fix — the cookie-only WS open path
      // MUST push the authed user_id to the client. Cookie-only sessions
      // have no `?start=` JWT on the URL, so `chat.ts:switchTopic`
      // previously fell through to `decodeJwtSubClaim('')` → null →
      // early-return when the user clicked the General sidebar row. The
      // server-pushed envelope is the trusted source.
      const resumeCookieSession = mock(async () => {})
      const bridge = makeBridge({ resumeCookieSession })
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
      const sent: unknown[] = []
      const ws = {
        data: {
          project_slug: 'alice',
          user_id: 'u-cookie-ready',
          pending_claim: null,
          session_started: false,
        },
        send: (s: string) => {
          sent.push(JSON.parse(s))
          return 1
        },
        close: () => {},
      }
      await (handler.websocket.open as unknown as (ws: unknown) => Promise<void>)(ws)
      const ready = sent.find(
        (m): m is { type: 'session_ready'; user_id: string } =>
          typeof m === 'object' && m !== null && (m as { type?: string }).type === 'session_ready',
      )
      expect(ready).toBeDefined()
      expect(ready?.user_id).toBe('u-cookie-ready')
    })

    test('open(ws) token-auth path: also emits session_ready{user_id} so the client uses a server-trusted value (Argus r3 P2 #1)', async () => {
      // Belt-and-braces — the token-auth path could decode the JWT
      // client-side, but pushing the server's authoritative value keeps
      // the cookie-only and token paths uniform AND removes the JWT
      // decode from a hot path.
      const startSession = mock(async () => true)
      const bridge = makeBridge({ startSession })
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
      const sent: unknown[] = []
      const ws = {
        data: {
          project_slug: 'alice',
          user_id: 'u-token-ready',
          pending_claim: { project_slug: 'alice', user_id: 'u-token-ready', jti: 'j', expires_at_ms: Date.now() + 60_000 },
          session_started: false,
        },
        send: (s: string) => {
          sent.push(JSON.parse(s))
          return 1
        },
        close: () => {},
      }
      await (handler.websocket.open as unknown as (ws: unknown) => Promise<void>)(ws)
      const ready = sent.find(
        (m): m is { type: 'session_ready'; user_id: string } =>
          typeof m === 'object' && m !== null && (m as { type?: string }).type === 'session_ready',
      )
      expect(ready).toBeDefined()
      expect(ready?.user_id).toBe('u-token-ready')
    })

    test('open(ws) token-auth path: claim race (startSession returns false) does NOT emit session_ready', async () => {
      // session_ready must follow `session_started = true` — a failed
      // claim closes the WS with 4001 and the envelope MUST NOT escape.
      const startSession = mock(async () => false)
      const bridge = makeBridge({ startSession })
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
      const sent: unknown[] = []
      const ws = {
        data: {
          project_slug: 'alice',
          user_id: 'u-race',
          pending_claim: { project_slug: 'alice', user_id: 'u-race', jti: 'j', expires_at_ms: Date.now() + 60_000 },
          session_started: false,
        },
        send: (s: string) => {
          sent.push(JSON.parse(s))
          return 1
        },
        close: mock(() => {}),
      }
      await (handler.websocket.open as unknown as (ws: unknown) => Promise<void>)(ws)
      const ready = sent.find(
        (m): m is { type: 'session_ready' } =>
          typeof m === 'object' && m !== null && (m as { type?: string }).type === 'session_ready',
      )
      expect(ready).toBeUndefined()
    })

    test('open(ws) cookie-only path: a thrown resumeCookieSession is swallowed and session still goes live', async () => {
      // The hook is best-effort — a re-emit failure CANNOT block session
      // bring-up (the user is already authed). Mirrors the closeSession
      // try/catch discipline.
      const resumeCookieSession = mock(async () => {
        throw new Error('best-effort failure')
      })
      const bridge = makeBridge({ resumeCookieSession })
      const handler = createLandingServer({ static_dir: dirname(HERE), bridge })
      const data = {
        project_slug: 'alice',
        user_id: 'u-cookie-3',
        pending_claim: null,
        session_started: false,
        active_topic_id: 'web:u-cookie-3:project-beta',
      }
      const ws = {
        data,
        send: () => 1,
        close: mock(() => {}),
      }
      await (handler.websocket.open as unknown as (ws: unknown) => Promise<void>)(ws)
      expect(resumeCookieSession).toHaveBeenCalledTimes(1)
      // Session bring-up succeeds even on hook failure.
      expect(data.session_started).toBe(true)
      // Socket is NOT closed (no 4001 — cookie auth already succeeded).
      expect((ws.close as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0)
    })
  })

  test('Sprint 26: GET /onboarding/telegram 404s when the static file is absent', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-landing-'))
    // Provide chat.html (required by createLandingServer) but NO
    // onboarding-telegram.html.
    writeFileSync(join(tmp, 'chat.html'), '<html></html>')
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
