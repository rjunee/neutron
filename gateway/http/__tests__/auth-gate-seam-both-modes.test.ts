/**
 * C5b — BOTH-MODE auth-gate seam characterization (the unification proof).
 *
 * The live browser login path has TWO gate implementations that used to be
 * wired through DIFFERENT seams:
 *
 *   - Managed owner-gated mode: `composition.auth_gate` (an `AuthGateOptions`
 *     decision object) wrapping the WHOLE route ladder — OAuth-backed, 302s a
 *     tokenless browser to the identity service, verifies a `?start=` JWT
 *     (cryptographic, NOT consumed), sliding-refreshes the session cookie.
 *
 *   - Open anonymous mode: `openFetch` (the single-owner `OpenOwnerGate`) wired
 *     as `landing_server.fetch` — mints the owner cookie locally on cold-start,
 *     no identity service, single-use local `?start=` token, injects the
 *     React-shell bootstrap.
 *
 * C5b unifies these onto ONE seam (`composition.auth_gate`, both modes) WITHOUT
 * changing observable behavior for either. These tests pin that observable
 * behavior AGAINST THE REAL `composeHttpHandler` ladder for BOTH modes. They
 * MUST be green on the pre-unification wiring (they encode the invariant) and
 * stay green through the refactor: only the two `build*Handler` helpers below
 * (which encapsulate the seam wiring) change — every assertion is stable.
 *
 * The load-bearing invariants pinned here:
 *   MANAGED  — tokenless browser → identity signin; `?start=` → cookie + allow;
 *              cookie-valid `/` → 302 `/chat`; the COOKIE-STITCH is an APPEND
 *              (a downstream Set-Cookie is NEVER replaced — both survive) for
 *              BOTH the `authenticated` and `allow` decisions; `/healthz` +
 *              `/webhook/telegram` bypass; JSON `/api/app/*` falls through.
 *   OPEN     — fresh `/chat` cold-starts (mints owner cookie + local token 302);
 *              `?start=` is single-use (replay mints no cookie); resumable
 *              cookie serves the injected shell with NO new cookie; a
 *              non-resumable cookie cold-starts; the bare `GET /` branch is
 *              SHADOWED in the compose chain (falls to the default handler, NOT
 *              openFetch's `/`→`/chat` redirect); SPA deep links mint+bounce;
 *              `/api/app/*` is not gated by the owner gate.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server, WebSocketHandler } from 'bun'
import { exportJWK, generateKeyPair, importJWK, type KeyLike } from 'jose'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { InMemoryConsumedTokens } from '@neutronai/runtime/consumed-tokens-in-memory.ts'
import { signSessionCookie } from '@neutronai/landing/session-cookie.ts'
import type { LandingStackWithEngine } from '@neutronai/gateway/wiring/build-landing-stack.ts'
import {
  issueStartToken,
  verifyStartTokenCryptographic,
} from '@neutronai/runtime/__tests__/start-token-testkit.ts'
import { buildLocalStartTokenAuth } from '@neutronai/open/local-start-token.ts'
import { OWNER_USER_ID } from '@neutronai/open/owner-identity.ts'
import type { OpenWiringContext } from '@neutronai/open/wiring/context.ts'
import {
  buildOpenOwnerGate,
  type ProjectRailRow,
  type WireOwnerGateDeps,
} from '@neutronai/open/wiring/owner-gate.ts'
import {
  buildManagedAuthGate,
  composeHttpHandler,
  type ComposedHttpHandler,
} from '../compose.ts'

const COOKIE_SECRET = 'test-cookie-secret-32-chars-long'
const IDENTITY_BASE_URL = 'https://auth.neutron.example'
const FAKE_SERVER = {} as unknown as Server<unknown>
const NOOP_WS: WebSocketHandler<unknown> = {
  message(): void {},
  open(): void {},
  close(): void {},
}

// ───────────────────────────── shared helpers ─────────────────────────────

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
  const verifyKey = (await importJWK({ ...pubJwk, alg: 'EdDSA' }, 'EdDSA')) as KeyLike
  return { kid: 'k1', privateKey, publicKey: verifyKey }
}

/** All Set-Cookie header values on a response, preserving append order. */
function setCookies(res: Response): string[] {
  return res.headers.getSetCookie()
}

// ══════════════════════════════ MANAGED MODE ══════════════════════════════
// Owner-gated: `composition.auth_gate` decision object wrapping the ladder.

const MANAGED_SLUG = 't-55555555'

interface ManagedLandingOpts {
  /** Extra Set-Cookie the DOWNSTREAM landing surface emits — used to pin the
   *  APPEND (never-replace) cookie-stitch: the gate's cookie must NOT clobber
   *  a cookie the underlying surface set. */
  downstreamSetCookie?: string
  onFetch?: () => void
}

function managedLanding(opts: ManagedLandingOpts = {}): {
  fetch: (req: Request, server: Server<unknown>) => Promise<Response>
  websocket: WebSocketHandler<unknown>
} {
  return {
    fetch: async () => {
      opts.onFetch?.()
      const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
      if (opts.downstreamSetCookie !== undefined) {
        headers.append('set-cookie', opts.downstreamSetCookie)
      }
      return new Response('chat html', { headers })
    },
    websocket: NOOP_WS,
  }
}

interface ManagedHandlerOpts {
  km: Awaited<ReturnType<typeof makeKeyMaterial>>
  landing?: ReturnType<typeof managedLanding>
  appAdmin?: { handler: (req: Request) => Promise<Response | null> }
  telegram?: { handler: (req: Request) => Promise<Response> }
  defaultHandler?: (req: Request) => Response | Promise<Response>
}

/**
 * Build the composed handler for MANAGED mode through the REAL compose chain.
 * This helper encapsulates the seam wiring — it is the ONLY thing the C5b
 * unification changes on the Managed side; the assertions stay identical.
 */
function buildManagedHandler(opts: ManagedHandlerOpts): ComposedHttpHandler {
  const input: Parameters<typeof composeHttpHandler>[0] = {
    landing: opts.landing ?? managedLanding(),
    // C5b — Managed flows through the ONE seam via the `buildManagedAuthGate`
    // adapter (the OAuth decision gate wrapped into the unified `HttpGate`).
    gate: buildManagedAuthGate({
      project_slug: MANAGED_SLUG,
      cookie_secret: COOKIE_SECRET,
      resolveKey: async (kid: string) => (kid === opts.km.kid ? opts.km.publicKey : null),
      identity_public_base_url: IDENTITY_BASE_URL,
      verifyStartToken: verifyStartTokenCryptographic,
    }),
    defaultHandler:
      opts.defaultHandler ?? ((): Response => new Response('default 404', { status: 404 })),
  }
  if (opts.appAdmin !== undefined) input.appAdmin = opts.appAdmin
  if (opts.telegram !== undefined) input.telegramWebhookHandler = opts.telegram.handler
  return composeHttpHandler(input)
}

async function managedToken(km: Awaited<ReturnType<typeof makeKeyMaterial>>): Promise<string> {
  return (
    await issueStartToken({
      project_slug: MANAGED_SLUG,
      user_id: 'user-1',
      signup_via: 'web',
      signing_key: { kid: km.kid, privateKey: km.privateKey },
      ttl_seconds: 600,
    })
  ).token
}

function managedCookieHeader(): string {
  const c = signSessionCookie(MANAGED_SLUG, COOKIE_SECRET, Date.now())
  return `${c.name}=${c.value}`
}

describe('C5b seam — MANAGED mode (owner-gated) through the real compose chain', () => {
  test('tokenless browser GET /chat → 302 to identity signin, landing NOT reached', async () => {
    const km = await makeKeyMaterial()
    let landingCalled = false
    const h = buildManagedHandler({
      km,
      landing: managedLanding({ onFetch: () => (landingCalled = true) }),
    })
    const res = await h.fetch(
      new Request(`https://${MANAGED_SLUG}.neutron.example/chat`, {
        headers: { accept: 'text/html' },
      }),
      FAKE_SERVER as Server<never>,
    )
    expect(res.status).toBe(302)
    expect(landingCalled).toBe(false)
    expect(res.headers.get('location') ?? '').toContain(`${IDENTITY_BASE_URL}/oauth/google/start`)
  })

  test('GET /chat?start=<valid> → 200 authenticated + Set-Cookie, landing reached', async () => {
    const km = await makeKeyMaterial()
    let landingCalled = false
    const token = await managedToken(km)
    const h = buildManagedHandler({
      km,
      landing: managedLanding({ onFetch: () => (landingCalled = true) }),
    })
    const res = await h.fetch(
      new Request(
        `https://${MANAGED_SLUG}.neutron.example/chat?start=${encodeURIComponent(token)}`,
        { headers: { accept: 'text/html' } },
      ),
      FAKE_SERVER as Server<never>,
    )
    expect(res.status).toBe(200)
    expect(landingCalled).toBe(true)
    expect(setCookies(res).some((c) => c.includes('__neutron_chat_session='))).toBe(true)
  })

  test('cookie-valid GET /chat → 200 allow with a refreshed (sliding) Set-Cookie', async () => {
    const km = await makeKeyMaterial()
    const h = buildManagedHandler({ km })
    const res = await h.fetch(
      new Request(`https://${MANAGED_SLUG}.neutron.example/chat`, {
        headers: { accept: 'text/html', cookie: managedCookieHeader() },
      }),
      FAKE_SERVER as Server<never>,
    )
    expect(res.status).toBe(200)
    expect(setCookies(res).some((c) => c.includes('__neutron_chat_session='))).toBe(true)
  })

  test('cookie-valid GET / → 302 to /chat (root has no downstream handler)', async () => {
    const km = await makeKeyMaterial()
    const h = buildManagedHandler({ km })
    const res = await h.fetch(
      new Request(`https://${MANAGED_SLUG}.neutron.example/`, {
        headers: { accept: 'text/html', cookie: managedCookieHeader() },
      }),
      FAKE_SERVER as Server<never>,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/chat')
  })

  test('tokenless browser GET / → 302 to identity signin (never 404)', async () => {
    const km = await makeKeyMaterial()
    const h = buildManagedHandler({ km })
    const res = await h.fetch(
      new Request(`https://${MANAGED_SLUG}.neutron.example/`, {
        headers: { accept: 'text/html' },
      }),
      FAKE_SERVER as Server<never>,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toContain(`${IDENTITY_BASE_URL}/oauth/google/start`)
  })

  // ── THE cookie-stitch invariant: APPEND, never replace, both decisions ──
  test('cookie-stitch APPEND (allow): a downstream Set-Cookie survives ALONGSIDE the gate cookie', async () => {
    const km = await makeKeyMaterial()
    const h = buildManagedHandler({
      km,
      landing: managedLanding({ downstreamSetCookie: 'downstream_pref=abc; Path=/' }),
    })
    const res = await h.fetch(
      new Request(`https://${MANAGED_SLUG}.neutron.example/chat`, {
        headers: { accept: 'text/html', cookie: managedCookieHeader() },
      }),
      FAKE_SERVER as Server<never>,
    )
    const cookies = setCookies(res)
    // BOTH present — the gate appended its session cookie without clobbering
    // the surface's cookie.
    expect(cookies.some((c) => c.startsWith('downstream_pref='))).toBe(true)
    expect(cookies.some((c) => c.includes('__neutron_chat_session='))).toBe(true)
    expect(cookies.length).toBeGreaterThanOrEqual(2)
  })

  test('cookie-stitch APPEND (authenticated): downstream Set-Cookie survives on a ?start= mint', async () => {
    const km = await makeKeyMaterial()
    const token = await managedToken(km)
    const h = buildManagedHandler({
      km,
      landing: managedLanding({ downstreamSetCookie: 'downstream_pref=xyz; Path=/' }),
    })
    const res = await h.fetch(
      new Request(
        `https://${MANAGED_SLUG}.neutron.example/chat?start=${encodeURIComponent(token)}`,
        { headers: { accept: 'text/html' } },
      ),
      FAKE_SERVER as Server<never>,
    )
    const cookies = setCookies(res)
    expect(cookies.some((c) => c.startsWith('downstream_pref='))).toBe(true)
    expect(cookies.some((c) => c.includes('__neutron_chat_session='))).toBe(true)
    expect(cookies.length).toBeGreaterThanOrEqual(2)
  })

  test('GET /healthz bypasses the gate (default handler serves it)', async () => {
    const km = await makeKeyMaterial()
    let healthzCalled = false
    const h = buildManagedHandler({
      km,
      defaultHandler: (req) => {
        if (new URL(req.url).pathname === '/healthz') {
          healthzCalled = true
          return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
        }
        return new Response('404', { status: 404 })
      },
    })
    const res = await h.fetch(
      new Request(`https://${MANAGED_SLUG}.neutron.example/healthz`),
      FAKE_SERVER as Server<never>,
    )
    expect(res.status).toBe(200)
    expect(healthzCalled).toBe(true)
  })

  test('POST /webhook/telegram bypasses the gate', async () => {
    const km = await makeKeyMaterial()
    let webhookCalled = false
    const h = buildManagedHandler({
      km,
      telegram: {
        handler: async () => {
          webhookCalled = true
          return new Response('{"ok":true}', { status: 200 })
        },
      },
    })
    const res = await h.fetch(
      new Request(`https://${MANAGED_SLUG}.neutron.example/webhook/telegram`, {
        method: 'POST',
        body: '{}',
      }),
      FAKE_SERVER as Server<never>,
    )
    expect(res.status).toBe(200)
    expect(webhookCalled).toBe(true)
  })

  test('programmatic GET /api/app/* (Accept: application/json) tokenless falls through (no 302)', async () => {
    const km = await makeKeyMaterial()
    let surfaceCalled = false
    const h = buildManagedHandler({
      km,
      appAdmin: {
        handler: async (req) => {
          if (new URL(req.url).pathname.startsWith('/api/app/admin/')) {
            surfaceCalled = true
            return new Response('{"error":"unauthorized"}', { status: 401 })
          }
          return null
        },
      },
    })
    const res = await h.fetch(
      new Request(`https://${MANAGED_SLUG}.neutron.example/api/app/admin/personality`, {
        headers: { accept: 'application/json' },
      }),
      FAKE_SERVER as Server<never>,
    )
    expect(res.status).toBe(401)
    expect(surfaceCalled).toBe(true)
  })
})

// ═══════════════════════════════ OPEN MODE ═══════════════════════════════
// Anonymous single-owner: the `OpenOwnerGate` (openFetch). Local cookie mint,
// no identity service, single-use local start-token, React-shell injection.

const OPEN_SLUG = 'owner'
const REACT_SHELL_TAG = '<script type="module" src="/chat-react.js"></script>'
const REACT_SHELL_HTML = `<!doctype html><html><head></head><body>${REACT_SHELL_TAG}</body></html>`

const OPEN_ROWS: ProjectRailRow[] = [
  {
    id: 'p1',
    label: 'Alpha',
    emoji: '🚀',
    unread: 0,
    last_activity_at: '2026-07-07T00:00:00.000Z',
    activity: 'idle',
    preview: null,
    preview_from: null,
    live_runs: 0,
  },
]

let openTmpDir: string
let openDb: ProjectDb

beforeEach(() => {
  openTmpDir = mkdtempSync(join(tmpdir(), 'neutron-c5b-seam-'))
  openDb = ProjectDb.open(join(openTmpDir, 'project.db'))
  applyMigrations(openDb.raw())
})

afterEach(() => {
  openDb.close()
  rmSync(openTmpDir, { recursive: true, force: true })
})

interface OpenLandingOpts {
  resume?: 'row' | 'null' | 'throw'
  html?: string
}

function openLanding(opts: OpenLandingOpts = {}): LandingStackWithEngine {
  const { resume = 'row', html = REACT_SHELL_HTML } = opts
  return {
    stateStore: {
      get: async () => {
        if (resume === 'throw') throw new Error('stateStore read blew up')
        return resume === 'row' ? ({ phase: 'greeting' } as never) : null
      },
    },
    fetch: () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
  } as unknown as LandingStackWithEngine
}

interface OpenHandlerOpts {
  landing?: LandingStackWithEngine
  appAdmin?: { handler: (req: Request) => Promise<Response | null> }
  defaultHandler?: (req: Request) => Response | Promise<Response>
}

/**
 * Build the composed handler for OPEN mode through the REAL compose chain,
 * returning it alongside the `startTokenAuth` so tests can mint local tokens.
 * This helper encapsulates the seam wiring — the ONLY thing the C5b unification
 * changes on the Open side (`landing_server.fetch = openFetch`, no top-level
 * gate → `landing_server.fetch = raw landing`, `auth_gate = openGate`). Every
 * assertion below is stable across that change.
 */
function buildOpenHandler(opts: OpenHandlerOpts = {}): {
  handler: ComposedHttpHandler
  startTokenAuth: ReturnType<typeof buildLocalStartTokenAuth>
} {
  const startTokenAuth = buildLocalStartTokenAuth(COOKIE_SECRET)
  const ctx: OpenWiringContext = {
    llmPool: null,
    owner_handle: OPEN_SLUG,
    owner_home: openTmpDir,
    project_slug: OPEN_SLUG,
    env: {} as NodeJS.ProcessEnv,
    db: openDb,
    prewarmSubstrate: async (): Promise<void> => {},
  }
  const deps: WireOwnerGateDeps = {
    cookieSecret: COOKIE_SECRET,
    startTokenAuth,
    consumedTokens: new InMemoryConsumedTokens(),
    landing: opts.landing ?? openLanding(),
    readProjectRows: (): ProjectRailRow[] => OPEN_ROWS,
    appWsToken: 'nbt_test_token',
  }
  // C5b — Open flows through the SAME seam: `landing_server.fetch` is the RAW
  // landing surface and the single-owner gate is supplied as `gate`.
  const { gate } = buildOpenOwnerGate(ctx, deps)
  const rawLanding = opts.landing ?? deps.landing
  const input: Parameters<typeof composeHttpHandler>[0] = {
    landing: { fetch: rawLanding.fetch.bind(rawLanding), websocket: NOOP_WS },
    gate,
    defaultHandler:
      opts.defaultHandler ?? ((): Response => new Response('default 404', { status: 404 })),
  }
  if (opts.appAdmin !== undefined) input.appAdmin = opts.appAdmin
  return { handler: composeHttpHandler(input), startTokenAuth }
}

function openReq(pathAndQuery: string, cookieSlug?: string): Request {
  const headers = new Headers({ accept: 'text/html' })
  if (cookieSlug !== undefined) {
    const c = signSessionCookie(cookieSlug, COOKIE_SECRET, Date.now())
    headers.set('cookie', `${c.name}=${c.value}`)
  }
  return new Request(`https://localhost${pathAndQuery}`, { method: 'GET', headers })
}

describe('C5b seam — OPEN mode (anonymous single-owner) through the real compose chain', () => {
  test('fresh GET /chat (no cookie, no token) → 302 local cold-start to /chat?start=<token> + owner cookie', async () => {
    const { handler } = buildOpenHandler()
    const res = await handler.fetch(openReq('/chat'), FAKE_SERVER as Server<never>)
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') ?? ''
    expect(loc).toMatch(/^\/chat\?start=/)
    // Anonymous mode NEVER 302s to an external identity signin.
    expect(loc).not.toContain('oauth')
    expect(setCookies(res).some((c) => c.includes('__neutron_chat_session='))).toBe(true)
  })

  test('GET /chat?start=<valid local token> → 200 injected shell + owner cookie; replay mints NO cookie (single-use)', async () => {
    const { handler, startTokenAuth } = buildOpenHandler()
    const token = startTokenAuth.mint({ project_slug: OPEN_SLUG, user_id: OWNER_USER_ID })

    const first = await handler.fetch(
      openReq(`/chat?start=${encodeURIComponent(token)}`),
      FAKE_SERVER as Server<never>,
    )
    expect(first.status).toBe(200)
    expect(setCookies(first).some((c) => c.includes('__neutron_chat_session='))).toBe(true)
    const body = await first.text()
    expect(body).toContain('window.__neutron_projects=')
    expect(body).toContain(REACT_SHELL_TAG)

    const replay = await handler.fetch(
      openReq(`/chat?start=${encodeURIComponent(token)}`),
      FAKE_SERVER as Server<never>,
    )
    expect(replay.status).toBe(200)
    expect(setCookies(replay).length).toBe(0)
  })

  test('resumable cookie-valid GET /chat → 200 injected shell with NO new cookie', async () => {
    const { handler } = buildOpenHandler({ landing: openLanding({ resume: 'row' }) })
    const res = await handler.fetch(openReq('/chat', OPEN_SLUG), FAKE_SERVER as Server<never>)
    expect(res.status).toBe(200)
    expect(setCookies(res).length).toBe(0)
    expect(await res.text()).toContain('window.__neutron_projects=')
  })

  test('non-resumable cookie-valid GET /chat → 302 cold-start (never strands the loader)', async () => {
    const { handler } = buildOpenHandler({ landing: openLanding({ resume: 'null' }) })
    const res = await handler.fetch(openReq('/chat', OPEN_SLUG), FAKE_SERVER as Server<never>)
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toMatch(/^\/chat\?start=/)
  })

  // ── THE shadowing invariant: bare GET / falls to the default handler ──
  test('bare GET / (no ?invite) is SHADOWED → default handler, NOT openFetch /→/chat redirect', async () => {
    let defaultCalled = false
    const { handler } = buildOpenHandler({
      defaultHandler: () => {
        defaultCalled = true
        return new Response('open default 404', { status: 404 })
      },
    })
    const res = await handler.fetch(openReq('/'), FAKE_SERVER as Server<never>)
    // The landing rung does not match `GET /` (isLandingRoute('/','GET',false)
    // === false), so openFetch is never invoked and its bare-`/` branch cannot
    // run. The request falls through to the default handler.
    expect(defaultCalled).toBe(true)
    expect(res.status).toBe(404)
    expect(res.headers.get('location')).toBeNull()
  })

  // ── root-WITH-invite is NOT shadowed: isLandingRoute('/','GET',true) === true
  //    so on main the landing rung ran openFetch, whose `/` branch owner-cold-
  //    starts (no cookie) / bounces to /chat (cookie). C5b must reproduce this
  //    EXACTLY — never fall through to the raw landing invite page. ──
  test('GET /?invite=<x> (no cookie) → openFetch `/` cold-start 302 to /chat?start= + owner cookie, NOT the raw landing page', async () => {
    let defaultCalled = false
    const { handler } = buildOpenHandler({
      // A distinct landing body so a fall-through to raw landing would be
      // observable (it must NOT happen — openFetch's `/` branch redirects first).
      landing: openLanding({ html: '<!doctype html><html><body>INVITE PAGE</body></html>' }),
      defaultHandler: () => {
        defaultCalled = true
        return new Response('default 404', { status: 404 })
      },
    })
    const res = await handler.fetch(openReq('/?invite=welcome'), FAKE_SERVER as Server<never>)
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toMatch(/^\/chat\?start=/)
    expect(setCookies(res).some((c) => c.includes('__neutron_chat_session='))).toBe(true)
    expect(defaultCalled).toBe(false)
  })

  test('GET /?invite=<x> WITH a valid owner cookie → openFetch `/` branch 302 to /chat', async () => {
    const { handler } = buildOpenHandler()
    const res = await handler.fetch(
      openReq('/?invite=welcome', OPEN_SLUG),
      FAKE_SERVER as Server<never>,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/chat')
  })

  test('SPA deep link GET /projects/p1/docs (no cookie) → 302 mint owner cookie + bounce to the SAME path', async () => {
    const { handler } = buildOpenHandler()
    const res = await handler.fetch(
      openReq('/projects/p1/docs?path=README.md'),
      FAKE_SERVER as Server<never>,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/projects/p1/docs?path=README.md')
    expect(setCookies(res).some((c) => c.includes('__neutron_chat_session='))).toBe(true)
  })

  test('GET /api/app/* is NOT gated by the owner gate — reaches the app surface', async () => {
    let surfaceCalled = false
    const { handler } = buildOpenHandler({
      appAdmin: {
        handler: async (req) => {
          if (new URL(req.url).pathname.startsWith('/api/app/admin/')) {
            surfaceCalled = true
            return new Response('{"ok":true}', { status: 200 })
          }
          return null
        },
      },
    })
    const res = await handler.fetch(
      new Request('https://localhost/api/app/admin/personality', {
        headers: { accept: 'application/json' },
      }),
      FAKE_SERVER as Server<never>,
    )
    expect(res.status).toBe(200)
    expect(surfaceCalled).toBe(true)
  })

  test('a cookie signed for a DIFFERENT slug is ignored → cold-start (host-bound HMAC)', async () => {
    const { handler } = buildOpenHandler()
    const res = await handler.fetch(
      openReq('/chat', 'some-other-instance'),
      FAKE_SERVER as Server<never>,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toMatch(/^\/chat\?start=/)
  })
})
