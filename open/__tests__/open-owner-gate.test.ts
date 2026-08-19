/**
 * Focused unit coverage for `open/wiring/owner-gate.ts` (C3c carve).
 *
 * The owner gate is the SECURITY-sensitive single-owner http shell: owner-cookie
 * minting + one-shot start-token + the auth funnel. These tests drive the real
 * `openFetch` returned by `buildOpenOwnerGate` (real `buildLocalStartTokenAuth`
 * + real `InMemoryConsumedTokens` + a fake landing surface) and pin the CARE
 * invariants the carve MUST preserve verbatim:
 *
 *   1. Single-use `?start=` JTI — a replayed token does NOT re-mint the cookie.
 *   2. Cookie minted ONLY on first claim (not on a bare cookie-present GET, not
 *      on a failed claim).
 *   3. Stale-cookie-over-wiped-DB cold-start — a valid cookie but no/erroring
 *      resumable state funnels to `coldStartRedirect` (never strands the loader).
 *   4. Bootstrap injection — exact-regex replace on the `/chat-react.js` tag, and
 *      the `!html.includes('/chat-react.js')` guard no-ops when the tag is absent.
 *   5. Host-bound HMAC cookie — a cookie signed for a DIFFERENT slug is ignored
 *      (`readSessionCookie` returns null for a non-matching slug → cold-start).
 *   6. The two former byte-identical claim-then-mint blocks (SPA deep-link +
 *      `/chat` `?start=` gate), converged onto one shared helper, still
 *      claim-then-mint IDENTICALLY (same single-use JTI / mint-on-first-claim).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { InMemoryConsumedTokens } from '@neutronai/runtime/consumed-tokens-in-memory.ts'
import { signSessionCookie } from '@neutronai/landing/session-cookie.ts'
import type { LandingStackWithEngine } from '@neutronai/gateway/wiring/build-landing-stack.ts'
import { buildLocalStartTokenAuth } from '../local-start-token.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import {
  buildOpenOwnerGate,
  type ProjectRailRow,
  type WireOwnerGateDeps,
} from '../wiring/owner-gate.ts'

const PROJECT_SLUG = 'owner'
const COOKIE_SECRET = 'test-cookie-secret'
// The exact chat-react shell marker the bootstrap injection replaces.
const REACT_SHELL_TAG = '<script type="module" src="/chat-react.js"></script>'
const REACT_SHELL_HTML = `<!doctype html><html><head></head><body>${REACT_SHELL_TAG}</body></html>`

let tmpDir: string
let db: ProjectDb

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-owner-gate-'))
  seedMigratedDb(join(tmpDir, 'project.db'))
  db = ProjectDb.open(join(tmpDir, 'project.db'))
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeCtx(env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv): OpenWiringContext {
  return {
    llmPool: null,
    owner_handle: PROJECT_SLUG,
    owner_home: tmpDir,
    project_slug: PROJECT_SLUG,
    env,
    db,
    prewarmSubstrate: async (): Promise<void> => {},
  }
}

interface FakeLandingOpts {
  /** `stateStore.get` result: 'row' → resumable, 'null' → wiped DB, 'throw' → read error. */
  resume?: 'row' | 'null' | 'throw'
  /** HTML body the fake `landing.fetch` serves (default: the React shell). */
  html?: string
  /** content-type the fake `landing.fetch` serves (default: text/html). */
  contentType?: string
}

/** A minimal fake landing surface — only `stateStore.get` + `fetch` are read. */
function makeLanding(opts: FakeLandingOpts = {}): LandingStackWithEngine {
  const { resume = 'row', html = REACT_SHELL_HTML, contentType = 'text/html' } = opts
  return {
    stateStore: {
      get: async () => {
        if (resume === 'throw') throw new Error('stateStore read blew up')
        return resume === 'row' ? ({ phase: 'greeting' } as never) : null
      },
    },
    fetch: () =>
      new Response(html, { status: 200, headers: { 'content-type': contentType } }),
  } as unknown as LandingStackWithEngine
}

const SAMPLE_ROWS: ProjectRailRow[] = [
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

function makeGate(
  overrides: {
    landing?: LandingStackWithEngine
    readProjectRows?: () => ProjectRailRow[]
    env?: NodeJS.ProcessEnv
  } = {},
): {
  openFetch: ReturnType<typeof buildOpenOwnerGate>['openFetch']
  // ISSUES #367 — the GATE, not just the handler. Every test in this file used
  // to call `openFetch` directly, which is exactly how the root-URL 404 hid for
  // so long: the handler's `/` branch was correct and fully covered, while the
  // predicate that decides whether to CALL it never matched `/`. Testing the
  // handler alone cannot see that class of bug.
  gate: ReturnType<typeof buildOpenOwnerGate>['gate']
  startTokenAuth: ReturnType<typeof buildLocalStartTokenAuth>
} {
  const startTokenAuth = buildLocalStartTokenAuth(COOKIE_SECRET)
  const deps: WireOwnerGateDeps = {
    cookieSecret: COOKIE_SECRET,
    startTokenAuth,
    consumedTokens: new InMemoryConsumedTokens(),
    landing: overrides.landing ?? makeLanding(),
    readProjectRows: overrides.readProjectRows ?? ((): ProjectRailRow[] => SAMPLE_ROWS),
    appWsToken: 'nbt_test_token',
  }
  const { openFetch, gate } = buildOpenOwnerGate(makeCtx(overrides.env), deps)
  return { openFetch, gate, startTokenAuth }
}

/** The Bun `server` arg is never touched by the gate — a bare cast suffices. */
const FAKE_SERVER = {} as import('bun').Server<unknown>

function getReq(pathAndQuery: string, cookieSlug?: string): Request {
  const headers = new Headers()
  if (cookieSlug !== undefined) {
    const c = signSessionCookie(cookieSlug, COOKIE_SECRET, Date.now())
    headers.set('cookie', `${c.name}=${c.value}`)
  }
  return new Request(`http://localhost${pathAndQuery}`, { method: 'GET', headers })
}

describe('owner gate — single-use ?start= JTI', () => {
  test('first /chat?start=T mints the cookie; a replay of the SAME token does not', async () => {
    const { openFetch, startTokenAuth } = makeGate()
    const token = startTokenAuth.mint({ project_slug: PROJECT_SLUG, user_id: OWNER_USER_ID })

    const first = await openFetch(getReq(`/chat?start=${encodeURIComponent(token)}`), FAKE_SERVER)
    expect(first.headers.get('set-cookie')).not.toBeNull()

    const second = await openFetch(getReq(`/chat?start=${encodeURIComponent(token)}`), FAKE_SERVER)
    // JTI already claimed on first use → the gate refuses to re-mint.
    expect(second.headers.get('set-cookie')).toBeNull()
  })
})

describe('owner gate — cookie minted ONLY on a first successful claim', () => {
  test('a bare cookie-present /chat GET (resumable) serves chat.html with NO Set-Cookie', async () => {
    const { openFetch } = makeGate({ landing: makeLanding({ resume: 'row' }) })
    const res = await openFetch(getReq('/chat', PROJECT_SLUG), FAKE_SERVER)
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  test('a FAILED claim (bad token, no cookie) serves the page but mints NO cookie', async () => {
    const { openFetch } = makeGate()
    const res = await openFetch(getReq('/chat?start=not-a-valid-token'), FAKE_SERVER)
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

describe('owner gate — stale-cookie-over-wiped-DB cold-start', () => {
  test('valid cookie but stateStore.get === null → 302 cold-start (never strands the loader)', async () => {
    const { openFetch } = makeGate({ landing: makeLanding({ resume: 'null' }) })
    const res = await openFetch(getReq('/chat', PROJECT_SLUG), FAKE_SERVER)
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toMatch(/^\/chat\?start=/)
  })

  test('valid cookie but stateStore.get THROWS → fail-toward-cold-start (302)', async () => {
    const { openFetch } = makeGate({ landing: makeLanding({ resume: 'throw' }) })
    const res = await openFetch(getReq('/chat', PROJECT_SLUG), FAKE_SERVER)
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toMatch(/^\/chat\?start=/)
  })
})

describe('owner gate — React shell bootstrap injection', () => {
  test('injects the project bootstrap before the /chat-react.js tag, preserving it', async () => {
    const { openFetch, startTokenAuth } = makeGate()
    const token = startTokenAuth.mint({ project_slug: PROJECT_SLUG, user_id: OWNER_USER_ID })
    const res = await openFetch(getReq(`/chat?start=${encodeURIComponent(token)}`), FAKE_SERVER)
    const body = await res.text()
    // The canonical project list is injected …
    expect(body).toContain('window.__neutron_projects=')
    expect(body).toContain('"id":"p1"')
    expect(body).toContain('window.__neutron_user_id=')
    // … immediately before the preserved shell tag.
    expect(body).toContain(REACT_SHELL_TAG)
    expect(body.indexOf('window.__neutron_projects=')).toBeLessThan(body.indexOf(REACT_SHELL_TAG))
  })

  test('S0 (b) — injects the per-boot app-ws token so the client presents it (not dev:owner)', async () => {
    const { openFetch, startTokenAuth } = makeGate()
    const token = startTokenAuth.mint({ project_slug: PROJECT_SLUG, user_id: OWNER_USER_ID })
    const res = await openFetch(getReq(`/chat?start=${encodeURIComponent(token)}`), FAKE_SERVER)
    const body = await res.text()
    // The per-boot token is injected as the client's bearer source; it lands
    // before the preserved shell tag alongside the other bootstrap globals.
    expect(body).toContain('window.__neutron_app_ws_token="nbt_test_token"')
    expect(body.indexOf('window.__neutron_app_ws_token=')).toBeLessThan(body.indexOf(REACT_SHELL_TAG))
  })

  test('the !html.includes(/chat-react.js) guard no-ops when the tag is absent', async () => {
    const noShellHtml = '<!doctype html><html><body>auth gate — no shell here</body></html>'
    const { openFetch } = makeGate({
      landing: makeLanding({ resume: 'row', html: noShellHtml }),
    })
    // Valid cookie + resumable → serve + inject; the guard must leave it untouched.
    const res = await openFetch(getReq('/chat', PROJECT_SLUG), FAKE_SERVER)
    const body = await res.text()
    expect(body).toBe(noShellHtml)
    expect(body).not.toContain('window.__neutron_projects=')
  })
})

describe('owner gate — host-bound HMAC cookie (cross-instance / stale-slug ignored)', () => {
  test('a cookie signed for a DIFFERENT slug is ignored → cold-start', async () => {
    const { openFetch } = makeGate()
    // A validly-signed cookie, but for another instance's slug.
    const res = await openFetch(getReq('/chat', 'some-other-instance'), FAKE_SERVER)
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toMatch(/^\/chat\?start=/)
  })
})

describe('owner gate — the two converged claim-then-mint call sites are identical', () => {
  // Both the SPA deep-link (`GET /projects/…?start=`) path and the `/chat?start=`
  // gate now share `claimAndMintThenServe`. Proving BOTH exhibit the SAME
  // claim-then-mint + single-use semantics is what pins the dedup as behavior-
  // preserving.
  const cases: Array<{ name: string; path: (t: string) => string }> = [
    { name: '/chat?start=', path: (t) => `/chat?start=${encodeURIComponent(t)}` },
    {
      name: 'SPA deep-link /projects/p1/docs?start=',
      path: (t) => `/projects/p1/docs?start=${encodeURIComponent(t)}`,
    },
  ]
  for (const { name, path } of cases) {
    test(`${name}: first mints the cookie + injects; replay mints nothing`, async () => {
      const { openFetch, startTokenAuth } = makeGate()
      const token = startTokenAuth.mint({ project_slug: PROJECT_SLUG, user_id: OWNER_USER_ID })

      const first = await openFetch(getReq(path(token)), FAKE_SERVER)
      expect(first.headers.get('set-cookie')).not.toBeNull()
      // Both call sites run the SAME React-bootstrap injection on the body.
      expect(await first.text()).toContain('window.__neutron_projects=')

      const replay = await openFetch(getReq(path(token)), FAKE_SERVER)
      expect(replay.headers.get('set-cookie')).toBeNull()
    })
  }
})

/**
 * ISSUES #303 — the owner session cookie must carry `Secure` whenever the
 * BROWSER spoke https, which on a hosted install is not the scheme this process
 * receives: the reverse proxy terminates TLS and forwards over plain-HTTP,
 * so `new URL(req.url).protocol` is `http:` for a genuine HTTPS request. The
 * gate used to read that protocol directly and therefore minted the owner
 * cookie WITHOUT `Secure` on every hosted deployment.
 *
 * These pin BOTH directions: `Secure` behind a TLS proxy, and NO `Secure` for
 * the direct-bind plain-http self-hoster (who would otherwise have the cookie
 * silently dropped by the browser).
 */
describe('owner gate — Secure flag honours X-Forwarded-Proto (#303)', () => {
  const mintReq = (proto?: string): Request => {
    const headers = new Headers()
    if (proto !== undefined) headers.set('x-forwarded-proto', proto)
    // Deliberately a plain-http request URL — this is exactly what the process
    // sees behind a TLS-terminating proxy.
    return new Request('http://localhost/chat', { method: 'GET', headers })
  }

  const cookieFor = async (proto?: string): Promise<string> => {
    const { openFetch, startTokenAuth } = makeGate()
    const token = startTokenAuth.mint({ project_slug: PROJECT_SLUG, user_id: OWNER_USER_ID })
    const headers = new Headers(mintReq(proto).headers)
    const req = new Request(`http://localhost/chat?start=${encodeURIComponent(token)}`, {
      method: 'GET',
      headers,
    })
    const res = await openFetch(req, FAKE_SERVER)
    const c = res.headers.get('set-cookie')
    expect(c).not.toBeNull()
    return c as string
  }

  test('behind a TLS proxy (X-Forwarded-Proto: https) the cookie IS Secure', async () => {
    expect(await cookieFor('https')).toContain('; Secure')
  })

  test('a proxy CHAIN takes the FIRST token, so "https, http" is still Secure', async () => {
    expect(await cookieFor('https, http')).toContain('; Secure')
  })

  test('direct plain-http self-host (no header) keeps the cookie NON-Secure', async () => {
    expect(await cookieFor(undefined)).not.toContain('Secure')
  })

  test('an unrecognised X-Forwarded-Proto is STILL Secure — a proxy is in front (#392)', async () => {
    // This assertion is INVERTED from its #303 form, deliberately. It used to
    // read `.not.toContain('Secure')`, encoding "fall back to the socket
    // scheme" — which is the behaviour #392 removes. The presence of any
    // `x-forwarded-*` header means something is proxying this request, so it is
    // not a direct dev session and the cookie must be protected regardless of
    // what the header claims. Keying on presence rather than value is what
    // stops a client-supplied `X-Forwarded-Proto: http` stripping `Secure`.
    expect(await cookieFor('gopher')).toContain('Secure')
  })

  test('the cold-start 302 mints a Secure cookie behind a TLS proxy too', async () => {
    const { openFetch } = makeGate()
    const res = await openFetch(mintReq('https'), FAKE_SERVER)
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie')).toContain('; Secure')
  })
})

describe('owner gate — bare `GET /` reaches openFetch (ISSUES #367)', () => {
  // Ryan hit this in production: typing his own instance URL returned "Not
  // Found" and only `/chat` worked. Verified live before the fix — a bare GET /
  // to the instance returned 404 both through the reverse proxy and directly on
  // the instance's own port.
  //
  // The handler was never the problem. `openFetch`'s `/` branch (valid cookie →
  // 302 /chat, otherwise cold-start) has always been correct; the gate's
  // `invokesOpenFetch` predicate simply never matched bare `/`, so the request
  // fell through to `next()` and the default handler 404'd. These assertions go
  // through `gate.apply`, because that is the only place the bug is visible.

  /** `next()` stands in for the rest of the ladder — a 404, as in production. */
  const next = (): Promise<Response> =>
    Promise.resolve(new Response('Not Found', { status: 404 }))

  test('a fresh visitor to `/` is NOT 404 — the gate routes it to openFetch', async () => {
    const { gate } = makeGate()
    const res = await gate.apply(getReq('/'), FAKE_SERVER, next)
    expect(res.status).not.toBe(404)
    // Cold-start redirect, the documented fresh-visitor behaviour.
    expect(res.status).toBe(302)
  })

  test('a returning visitor with a valid cookie is bounced to /chat', async () => {
    const { gate } = makeGate()
    const res = await gate.apply(getReq('/', PROJECT_SLUG), FAKE_SERVER, next)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/chat')
  })

  test('`/?invite=` still routes through, unchanged', async () => {
    // The pre-existing landing-route path must not regress: it matched before
    // via isLandingRoute and must still match now.
    const { gate } = makeGate()
    const res = await gate.apply(getReq('/?invite=abc'), FAKE_SERVER, next)
    expect(res.status).not.toBe(404)
  })

  test('a NON-GET request to `/` still falls through to next()', async () => {
    // The fix is scoped to GET. A POST to the root is not a page load and must
    // not be handed to a handler that only knows how to render one.
    const { gate } = makeGate()
    const res = await gate.apply(
      new Request('http://localhost/', { method: 'POST' }),
      FAKE_SERVER,
      next,
    )
    expect(res.status).toBe(404)
  })

  test('an unrelated path still falls through — the fix did not widen the gate', async () => {
    // `/api/app/*` must keep reaching the app surface via next(); routing it
    // into openFetch would break every API call on the instance.
    const { gate } = makeGate()
    const res = await gate.apply(getReq('/api/app/projects'), FAKE_SERVER, next)
    expect(res.status).toBe(404)
  })
})
