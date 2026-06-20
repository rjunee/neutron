/**
 * Unit tests for the per-instance gateway HTTP auth gate
 * (`landing/auth-gate.ts`).
 *
 * 2026-05-27 returning-user resume sprint regression tests — Part A.
 *
 * Pins:
 *   1. Tokenless browser GET /chat → 302 to identity signin with
 *      `return_url` preserved on the original full URL.
 *   2. GET /chat?start=<valid-token> → authenticated + Set-Cookie.
 *   3. GET /chat with valid session cookie → allow.
 *   4. Programmatic (Accept: application/json) request tokenless →
 *      pass-through-unauthed (downstream bearer-auth decides).
 *   5. GET /chat with cross-instance start_token → falls through to
 *      the no-auth branch (not authenticated).
 */

import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, importJWK, type KeyLike } from 'jose'
import { evaluateAuthGate } from '../auth-gate.ts'
import {
  signSessionCookie,
  formatSetCookie,
  SESSION_COOKIE_MAX_AGE_S,
} from '../session-cookie.ts'
import {
  issueStartToken,
  verifyStartTokenCryptographic,
} from '@neutronai/runtime/__tests__/start-token-testkit.ts'

const COOKIE_SECRET = 'test-cookie-secret-32-chars-long'
const PROJECT_SLUG = 't-55555555'
const IDENTITY_BASE_URL = 'https://auth.neutron.example'

interface KeyMaterial {
  kid: string
  privateKey: KeyLike
  publicKey: KeyLike
}

async function makeKeyMaterial(): Promise<KeyMaterial> {
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

async function mintTokenFor(
  km: KeyMaterial,
  opts: { project_slug?: string; ttl_seconds?: number } = {},
): Promise<string> {
  const issued = await issueStartToken({
    project_slug: opts.project_slug ?? PROJECT_SLUG,
    user_id: 'user-1',
    signup_via: 'web',
    signing_key: { kid: km.kid, privateKey: km.privateKey },
    ttl_seconds: opts.ttl_seconds ?? 600,
  })
  return issued.token
}

function makeBrowserRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(init.headers ?? {}),
    },
  })
}

function buildGateOpts(km: KeyMaterial): Parameters<typeof evaluateAuthGate>[1] {
  return {
    project_slug: PROJECT_SLUG,
    cookie_secret: COOKIE_SECRET,
    resolveKey: async (kid) => (kid === km.kid ? km.publicKey : null),
    identity_public_base_url: IDENTITY_BASE_URL,
    verifyStartToken: verifyStartTokenCryptographic,
  }
}

describe('evaluateAuthGate — Part A regression tests', () => {
  test('tokenless browser GET /chat → 302 to signin with return_url preserved', async () => {
    const km = await makeKeyMaterial()
    const req = makeBrowserRequest('https://t-55555555.neutron.example/chat')
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('redirect-to-signin')
    if (decision.kind === 'redirect-to-signin') {
      const url = new URL(decision.location)
      expect(url.origin).toBe(IDENTITY_BASE_URL)
      expect(url.pathname).toBe('/oauth/google/start')
      expect(url.searchParams.get('via')).toBe('web')
      const returnUrl = url.searchParams.get('return_url')
      expect(returnUrl).toBe('https://t-55555555.neutron.example/chat')
    }
  })

  test('GET /chat?start=<valid-token> → authenticated + Set-Cookie', async () => {
    const km = await makeKeyMaterial()
    const token = await mintTokenFor(km)
    const req = makeBrowserRequest(
      `https://t-55555555.neutron.example/chat?start=${encodeURIComponent(token)}`,
    )
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('authenticated')
    if (decision.kind === 'authenticated') {
      expect(decision.set_cookie).toContain('__neutron_chat_session=')
      expect(decision.set_cookie).toContain('HttpOnly')
      // Lax — survives the OAuth-callback cross-site nav that mints it.
      expect(decision.set_cookie).toContain('SameSite=Lax')
      expect(decision.verified.project_slug).toBe(PROJECT_SLUG)
    }
  })

  test('GET /chat with valid session cookie → allow', async () => {
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    const req = makeBrowserRequest('https://t-55555555.neutron.example/chat', {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('allow')
  })

  test('GET /api/app/admin (Accept: application/json) tokenless → pass-through-unauthed', async () => {
    const km = await makeKeyMaterial()
    const req = new Request('https://t-55555555.neutron.example/api/app/admin/personality', {
      headers: { accept: 'application/json' },
    })
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('pass-through-unauthed')
  })

  test('GET /chat with cross-instance start_token → 302 to signin (not authenticated)', async () => {
    const km = await makeKeyMaterial()
    // Token issued for a DIFFERENT instance.
    const token = await mintTokenFor(km, { project_slug: 'someone-else' })
    const req = makeBrowserRequest(
      `https://t-55555555.neutron.example/chat?start=${encodeURIComponent(token)}`,
    )
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('redirect-to-signin')
  })

  test('GET /chat with expired start_token → 302 to signin', async () => {
    const km = await makeKeyMaterial()
    const expiredToken = await mintTokenFor(km, { ttl_seconds: 1 })
    // Wait past the TTL.
    await new Promise((r) => setTimeout(r, 1100))
    const req = makeBrowserRequest(
      `https://t-55555555.neutron.example/chat?start=${encodeURIComponent(expiredToken)}`,
    )
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('redirect-to-signin')
  })

  test('valid cookie for a DIFFERENT instance on this gateway → falls through', async () => {
    const km = await makeKeyMaterial()
    // Cookie was set on a different instance — should not authenticate
    // this gateway's instance.
    const otherCookie = signSessionCookie(
      'someone-else',
      COOKIE_SECRET,
      Date.now(),
    )
    const req = makeBrowserRequest('https://t-55555555.neutron.example/chat', {
      headers: { cookie: `${otherCookie.name}=${otherCookie.value}` },
    })
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('redirect-to-signin')
  })

  test('honours X-Forwarded-Proto/Host on return_url', async () => {
    const km = await makeKeyMaterial()
    const req = new Request('http://127.0.0.1:7800/chat', {
      headers: {
        accept: 'text/html',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 't-55555555.neutron.example',
      },
    })
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('redirect-to-signin')
    if (decision.kind === 'redirect-to-signin') {
      const url = new URL(decision.location)
      const returnUrl = url.searchParams.get('return_url')
      expect(returnUrl).toBe('https://t-55555555.neutron.example/chat')
    }
  })

  test('strips pre-existing ?start= from return_url to avoid recycling a stale token', async () => {
    const km = await makeKeyMaterial()
    // Token-bearing URL but token is structurally bad → falls through to
    // signin. The return_url MUST NOT echo the bad token.
    const req = makeBrowserRequest(
      'https://t-55555555.neutron.example/chat?start=bad-token&debug=1',
    )
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('redirect-to-signin')
    if (decision.kind === 'redirect-to-signin') {
      const url = new URL(decision.location)
      const returnUrl = url.searchParams.get('return_url') ?? ''
      expect(returnUrl).not.toContain('start=bad-token')
      // Other query params survive so deeplinks like ?debug=1 round-trip.
      expect(returnUrl).toContain('debug=1')
    }
  })

  test('formatSetCookie + signed cookie format is stable across gates', () => {
    // Make sure the per-instance gateway's cookie format matches the
    // platform proxy's so an ops `curl --cookie` works against both.
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    const header = formatSetCookie(cookie)
    expect(header).toMatch(
      /^__neutron_chat_session=[^.]+\.\d+\.[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/,
    )
  })
})

describe('evaluateAuthGate — Argus r1 fix-pass regression tests (BLOCKER #1 + #2)', () => {
  test('BLOCKER #1: cookie-only GET /chat (no ?start=) + mint hook wired → redirect to /chat?start=<fresh> + refreshed cookie (no hot-loop)', async () => {
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    const mintedToken = await mintTokenFor(km)
    let mintCalled = 0
    const req = makeBrowserRequest('https://t-55555555.neutron.example/chat', {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    const opts = buildGateOpts(km)
    opts.mintStartToken = async (): Promise<string | null> => {
      mintCalled++
      return mintedToken
    }
    const decision = await evaluateAuthGate(req, opts)
    // Hard assertion: the decision MUST NOT be `allow` because that's
    // what hot-loops — the chat client would render, WS upgrade would
    // 400, onClose would navigate back to /chat, cookie would still
    // pass, and we'd be back at `allow` again.
    expect(decision.kind).toBe('redirect')
    if (decision.kind === 'redirect') {
      expect(decision.location).toBe(`/chat?start=${encodeURIComponent(mintedToken)}`)
      expect(decision.set_cookie).toBeDefined()
      expect(decision.set_cookie ?? '').toContain('__neutron_chat_session=')
      expect(decision.set_cookie ?? '').toContain('HttpOnly')
    }
    expect(mintCalled).toBe(1)
  })

  test('BLOCKER #1: cookie-only GET /chat + mint hook returns null → fall through to allow (no loop, but degraded UX)', async () => {
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    const req = makeBrowserRequest('https://t-55555555.neutron.example/chat', {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    const opts = buildGateOpts(km)
    opts.mintStartToken = async (): Promise<string | null> => null
    const decision = await evaluateAuthGate(req, opts)
    // Mint hook failed → no redirect to mint; chat.html serves, WS
    // upgrade will still 400 but the gate has logged the mint failure
    // for the operator. No INFINITE loop because the chat-client's
    // onClose can be diagnosed at the operator level.
    expect(decision.kind).toBe('allow')
  })

  test('BLOCKER #1: cookie-only GET /chat + NO mint hook wired (legacy) → allow (back-compat)', async () => {
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    const req = makeBrowserRequest('https://t-55555555.neutron.example/chat', {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    // No mintStartToken — same shape as test/dev deploys with
    // NEUTRON_AUTH_DB_PATH unset.
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('allow')
  })

  test('BLOCKER #1: GET /chat?start=<existing> + cookie → allow (no mint, no redirect)', async () => {
    // When ?start= is already in the URL, the cookie path short-circuits
    // to `allow` BEFORE the token branch — the chat.html bootstrap reads
    // the URL token and the WS upgrade uses it. We must NOT mint a
    // second token here (would burn a JWT for nothing).
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    const token = await mintTokenFor(km)
    let mintCalled = 0
    const req = makeBrowserRequest(
      `https://t-55555555.neutron.example/chat?start=${encodeURIComponent(token)}`,
      { headers: { cookie: `${cookie.name}=${cookie.value}` } },
    )
    const opts = buildGateOpts(km)
    opts.mintStartToken = async (): Promise<string | null> => {
      mintCalled++
      return 'should-not-be-called'
    }
    const decision = await evaluateAuthGate(req, opts)
    expect(decision.kind).toBe('allow')
    expect(mintCalled).toBe(0)
  })

  test('BLOCKER #1: mint hook is NOT invoked on /api/app/* even with cookie (only browser /chat GET triggers mint)', async () => {
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    let mintCalled = 0
    const req = makeBrowserRequest(
      'https://t-55555555.neutron.example/api/app/focus',
      { headers: { cookie: `${cookie.name}=${cookie.value}` } },
    )
    const opts = buildGateOpts(km)
    opts.mintStartToken = async (): Promise<string | null> => {
      mintCalled++
      return 'should-not-be-called'
    }
    const decision = await evaluateAuthGate(req, opts)
    expect(decision.kind).toBe('allow')
    expect(mintCalled).toBe(0)
  })

  test('BLOCKER #2: cookie-valid GET / → 302 to /chat with refreshed Set-Cookie (sliding refresh)', async () => {
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    const req = makeBrowserRequest('https://t-55555555.neutron.example/', {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('redirect')
    if (decision.kind === 'redirect') {
      expect(decision.location).toBe('/chat')
      // 2026-05-27 persistent-session-cookie sprint — sliding refresh:
      // every cookie-valid authenticated hit emits a refreshed cookie so
      // the 30-day TTL rolls forward. The browser would carry the existing
      // cookie same-origin anyway, but the explicit Set-Cookie pushes
      // `expires_at_ms` to `now + 30d` on every request.
      expect(decision.set_cookie).toBeDefined()
      expect(decision.set_cookie ?? '').toContain('__neutron_chat_session=')
      expect(decision.set_cookie ?? '').toContain('Max-Age=2592000')
    }
  })

  test('BLOCKER #2: tokenless GET / (browser) → 302 to identity signin with return_url=https://<host>/', async () => {
    const km = await makeKeyMaterial()
    const req = makeBrowserRequest('https://t-55555555.neutron.example/')
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('redirect-to-signin')
    if (decision.kind === 'redirect-to-signin') {
      const url = new URL(decision.location)
      expect(url.searchParams.get('return_url')).toBe(
        'https://t-55555555.neutron.example/',
      )
    }
  })

  test('BLOCKER #2: GET /?start=<valid> (returning-user OAuth callback) → 302 to /chat?start=<token> + Set-Cookie', async () => {
    // The identity service's `onReturningWebSignin` appends ?start=<fresh>
    // to the threaded return_url. If the original return_url was bare
    // `https://<slug>.<base>/`, the callback hits GET / with the token.
    // The gate must NOT serve a 404; it must 302 to /chat?start= so the
    // WS upgrade has a usable JWT.
    const km = await makeKeyMaterial()
    const token = await mintTokenFor(km)
    const req = makeBrowserRequest(
      `https://t-55555555.neutron.example/?start=${encodeURIComponent(token)}`,
    )
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('redirect')
    if (decision.kind === 'redirect') {
      expect(decision.location).toBe(`/chat?start=${encodeURIComponent(token)}`)
      expect(decision.set_cookie).toBeDefined()
      expect(decision.set_cookie ?? '').toContain('__neutron_chat_session=')
    }
  })

  test('BLOCKER #2: GET /?start=<cross-instance> → 302 to identity signin (no /chat redirect)', async () => {
    // A cross-instance token on `/` must NOT redirect to /chat (which would
    // pass the token through and trip the WS upgrade's instance check) —
    // it must bounce back through signin.
    const km = await makeKeyMaterial()
    const token = await mintTokenFor(km, { project_slug: 'someone-else' })
    const req = makeBrowserRequest(
      `https://t-55555555.neutron.example/?start=${encodeURIComponent(token)}`,
    )
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('redirect-to-signin')
  })

  test('BLOCKER #1 + #2: hot-loop simulation — GET /chat (cookie + mint) → 302, then follow the new URL → allow (no loop)', async () => {
    // Walks the actual fix end-to-end:
    //   1. Cookie-only GET /chat: gate mints + 302s to /chat?start=<fresh>
    //   2. Browser follows the 302 to /chat?start=<fresh>: gate ALLOWs
    //      (cookie still valid, ?start= present so no mint) → landing
    //      serves chat.html with the token rideable for the WS upgrade.
    // This is the loop-breaker: hit #2 reaches `allow`, not another
    // mint-and-redirect, so the chain terminates in ONE round-trip.
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    const mintedToken = await mintTokenFor(km)
    let mintCalled = 0
    const opts = buildGateOpts(km)
    opts.mintStartToken = async (): Promise<string | null> => {
      mintCalled++
      return mintedToken
    }
    // Hit #1
    const req1 = makeBrowserRequest('https://t-55555555.neutron.example/chat', {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    const d1 = await evaluateAuthGate(req1, opts)
    expect(d1.kind).toBe('redirect')
    let nextLocation = ''
    if (d1.kind === 'redirect') nextLocation = d1.location
    expect(nextLocation).toBe(`/chat?start=${encodeURIComponent(mintedToken)}`)
    // Hit #2 — follow the 302. Browser carries the cookie + the new ?start=.
    const req2 = makeBrowserRequest(
      `https://t-55555555.neutron.example${nextLocation}`,
      { headers: { cookie: `${cookie.name}=${cookie.value}` } },
    )
    const d2 = await evaluateAuthGate(req2, opts)
    expect(d2.kind).toBe('allow')
    // Mint was invoked EXACTLY ONCE — the second hit did NOT mint a
    // second token. If both hits minted, that's the loop signature.
    expect(mintCalled).toBe(1)
  })
})

describe('evaluateAuthGate — sliding refresh (persistent session cookie sprint)', () => {
  test('cookie-valid GET /chat (no ?start=, no mint hook) → allow includes a refreshed Set-Cookie', async () => {
    // Mint a cookie at now=0, then evaluate the gate at now=1000 (1 sec
    // later). The gate's cookie branch should `allow` AND carry a fresh
    // Set-Cookie whose Max-Age is the new 30-day TTL — proving that
    // sliding-refresh fires on every cookie-valid authenticated hit.
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, 0)
    const req = makeBrowserRequest('https://t-55555555.neutron.example/chat', {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    const opts = buildGateOpts(km)
    opts.now = (): number => 1000
    const decision = await evaluateAuthGate(req, opts)
    expect(decision.kind).toBe('allow')
    if (decision.kind === 'allow') {
      expect(decision.set_cookie).toBeDefined()
      expect(decision.set_cookie ?? '').toContain('__neutron_chat_session=')
      expect(decision.set_cookie ?? '').toContain('Max-Age=2592000')
      expect(decision.set_cookie ?? '').toContain('HttpOnly')
      expect(decision.set_cookie ?? '').toContain('SameSite=Lax')
    }
  })

  test('cookie expired by 5 minutes → still rejected (gate falls through to no-auth)', async () => {
    // Cookie minted at now=0; evaluate at now = max-age + 5min. The
    // cookie verifier returns null (past expiry), the gate falls through
    // to the no-auth browser-nav branch, and emits a redirect-to-signin.
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, 0)
    const req = makeBrowserRequest('https://t-55555555.neutron.example/chat', {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    const opts = buildGateOpts(km)
    opts.now = (): number => SESSION_COOKIE_MAX_AGE_S * 1000 + 5 * 60 * 1000
    const decision = await evaluateAuthGate(req, opts)
    expect(decision.kind).toBe('redirect-to-signin')
  })

  test('cookie-valid GET / → redirect to /chat AND emits a refreshed Set-Cookie', async () => {
    // The `/` → `/chat` redirect now also rolls the cookie forward —
    // covered by the updated BLOCKER #2 test above. Re-pin here with the
    // sliding-refresh framing + explicit Max-Age assertion + the `now`
    // injection harness so the sliding-refresh semantics are exercised
    // independently of the BLOCKER #2 fix.
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, 0)
    const req = makeBrowserRequest('https://t-55555555.neutron.example/', {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    const opts = buildGateOpts(km)
    opts.now = (): number => 1000
    const decision = await evaluateAuthGate(req, opts)
    expect(decision.kind).toBe('redirect')
    if (decision.kind === 'redirect') {
      expect(decision.location).toBe('/chat')
      expect(decision.set_cookie).toBeDefined()
      expect(decision.set_cookie ?? '').toContain('__neutron_chat_session=')
      expect(decision.set_cookie ?? '').toContain('Max-Age=2592000')
    }
  })
})

/**
 * 2026-06-03 — pending-redirect HTTP 302 fallback (Sam's incident).
 *
 * Belt-and-braces alongside the chat-bridge WS reconnect-replay path:
 * after a slug rename whose live `slug_renamed` WS envelope was dropped,
 * a user who does a PLAIN PAGE RELOAD of `chat.<base>/chat` (no live WS)
 * gets 302'd straight to `<new_slug>.<base>/chat?start=<token>` by the
 * auth-gate's `resolvePendingRedirect` hook — instead of re-rendering the
 * stale chat surface and staying stranded.
 */
describe('evaluateAuthGate — pending-redirect HTTP 302 fallback (2026-06-03)', () => {
  const NEW_HOST = 'sage.neutron.example'
  const NEW_LOCATION = `https://${NEW_HOST}/chat?start=start-token-abc`

  test('cookie-valid GET /chat + pending redirect → 302 to new host (not signin, not mint)', async () => {
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    let hostSeen: string | null = null
    const req = makeBrowserRequest('https://t-55555555.neutron.example/chat', {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    const opts = buildGateOpts(km)
    opts.resolvePendingRedirect = async (current_host): Promise<string | null> => {
      hostSeen = current_host
      return NEW_LOCATION
    }
    const decision = await evaluateAuthGate(req, opts)
    expect(decision.kind).toBe('redirect')
    if (decision.kind === 'redirect') {
      expect(decision.location).toBe(NEW_LOCATION)
      // No Set-Cookie — destination is a different origin (host-scoped
      // cookies) and mints its own on consuming the ?start= token.
      expect(decision.set_cookie).toBeUndefined()
    }
    // The hook was handed the resolved request host for its self-guard.
    expect(hostSeen as string | null).toBe('t-55555555.neutron.example')
  })

  test('cookie-valid GET / + pending redirect → 302 to new host', async () => {
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    const req = makeBrowserRequest('https://t-55555555.neutron.example/', {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    const opts = buildGateOpts(km)
    opts.resolvePendingRedirect = async (): Promise<string | null> => NEW_LOCATION
    const decision = await evaluateAuthGate(req, opts)
    expect(decision.kind).toBe('redirect')
    if (decision.kind === 'redirect') {
      expect(decision.location).toBe(NEW_LOCATION)
    }
  })

  test('hook resolves host from X-Forwarded-Host (production Caddy chain)', async () => {
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    let hostSeen: string | null = null
    const req = new Request('http://127.0.0.1:7800/chat', {
      headers: {
        accept: 'text/html',
        'x-forwarded-host': 'sage.neutron.example',
        cookie: `${cookie.name}=${cookie.value}`,
      },
    })
    const opts = buildGateOpts(km)
    // Already on the destination host → the hook self-guards and returns
    // null; the gate must NOT 302 (no self-redirect loop).
    opts.resolvePendingRedirect = async (current_host): Promise<string | null> => {
      hostSeen = current_host
      return null
    }
    const decision = await evaluateAuthGate(req, opts)
    expect(hostSeen as string | null).toBe('sage.neutron.example')
    // Falls through to allow (no mint hook wired in this opts).
    expect(decision.kind).toBe('allow')
  })

  test('no pending redirect (hook returns null) → falls through to normal allow', async () => {
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    const req = makeBrowserRequest('https://t-55555555.neutron.example/chat', {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    const opts = buildGateOpts(km)
    opts.resolvePendingRedirect = async (): Promise<string | null> => null
    const decision = await evaluateAuthGate(req, opts)
    expect(decision.kind).toBe('allow')
  })

  test('hook throws → fail-open to allow (a redirect-delivery bug must not lock the user out)', async () => {
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    const req = makeBrowserRequest('https://t-55555555.neutron.example/chat', {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    const opts = buildGateOpts(km)
    opts.resolvePendingRedirect = async (): Promise<string | null> => {
      throw new Error('db unavailable')
    }
    const decision = await evaluateAuthGate(req, opts)
    expect(decision.kind).toBe('allow')
  })

  test('pending-redirect hook is NOT consulted on /api/app/* (JSON surface)', async () => {
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    let called = 0
    const req = makeBrowserRequest(
      'https://t-55555555.neutron.example/api/app/focus',
      { headers: { cookie: `${cookie.name}=${cookie.value}` } },
    )
    const opts = buildGateOpts(km)
    opts.resolvePendingRedirect = async (): Promise<string | null> => {
      called++
      return NEW_LOCATION
    }
    const decision = await evaluateAuthGate(req, opts)
    expect(called).toBe(0)
    expect(decision.kind).toBe('allow')
  })

  test('pending redirect takes priority over the mint-and-redirect path', async () => {
    // Both hooks wired + a pending row present: the redirect to the new
    // host must win (the user belongs on the new subdomain, not a
    // freshly-minted token for the OLD one).
    const km = await makeKeyMaterial()
    const cookie = signSessionCookie(PROJECT_SLUG, COOKIE_SECRET, Date.now())
    let mintCalled = 0
    const req = makeBrowserRequest('https://t-55555555.neutron.example/chat', {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    const opts = buildGateOpts(km)
    opts.mintStartToken = async (): Promise<string | null> => {
      mintCalled++
      return 'fresh-old-slug-token'
    }
    opts.resolvePendingRedirect = async (): Promise<string | null> => NEW_LOCATION
    const decision = await evaluateAuthGate(req, opts)
    expect(decision.kind).toBe('redirect')
    if (decision.kind === 'redirect') {
      expect(decision.location).toBe(NEW_LOCATION)
    }
    expect(mintCalled).toBe(0)
  })
})

describe('evaluateAuthGate — slug-rename AUTH-LOOP fix (2026-06-05)', () => {
  // The per-instance gateway is booted as PROJECT_SLUG (its frozen-at-boot
  // identity). A no-restart rename flips the registry's url_slug to a NEW
  // slug WITHOUT bouncing this process, so `opts.project_slug` stays the
  // OLD value while the handoff button's `?start` token carries the NEW
  // slug. The fix gives the HTTP gate the SAME shim the WS path has.
  const INTERNAL_HANDLE = 't-internal-vibe'
  const NEW_SLUG = 'vibe'
  const OLD_SLUG = 'old-name'

  function buildShimGateOpts(
    km: KeyMaterial,
    overrides: Partial<Parameters<typeof evaluateAuthGate>[1]> = {},
  ): Parameters<typeof evaluateAuthGate>[1] {
    return {
      ...buildGateOpts(km),
      internal_handle: INTERNAL_HANDLE,
      ownerRegistry: {
        // Registry reflects the post-rename CURRENT url_slug for OUR handle.
        getCurrentUrlSlugByInternalHandle: (ih): string | null =>
          ih === INTERNAL_HANDLE ? NEW_SLUG : null,
      },
      slugHistoryStore: {
        // OLD_SLUG is a non-expired historical slug for OUR handle only.
        lookup: async ({ old_slug, internal_handle }) =>
          old_slug === OLD_SLUG && internal_handle === INTERNAL_HANDLE
            ? { expires_at_ms: Date.now() + 5 * 60 * 1000 }
            : null,
      },
      ...overrides,
    }
  }

  test('NEW-slug ?start token (handoff button) → authenticated, NOT redirect-to-signin (no OAuth loop)', async () => {
    const km = await makeKeyMaterial()
    // Token minted by the rename with claim = the NEW slug 'vibe'.
    const token = await mintTokenFor(km, { project_slug: NEW_SLUG })
    const req = makeBrowserRequest(
      `https://vibe.neutron.example/chat?start=${encodeURIComponent(token)}`,
    )
    const decision = await evaluateAuthGate(req, buildShimGateOpts(km))
    expect(decision.kind).toBe('authenticated')
    if (decision.kind === 'authenticated') {
      // Cookie collapses to the gateway's frozen identity (downstream
      // uniformity), exactly as the WS path does — NOT the NEW slug.
      expect(decision.set_cookie).toContain('__neutron_chat_session=')
      expect(decision.verified.project_slug).toBe(NEW_SLUG)
    }
  })

  test('OLD-slug ?start token (grace window) → authenticated via slug-history shim', async () => {
    const km = await makeKeyMaterial()
    const token = await mintTokenFor(km, { project_slug: OLD_SLUG })
    const req = makeBrowserRequest(
      `https://vibe.neutron.example/chat?start=${encodeURIComponent(token)}`,
    )
    const decision = await evaluateAuthGate(req, buildShimGateOpts(km))
    expect(decision.kind).toBe('authenticated')
  })

  test('genuinely cross-instance token (not current slug, not in our history) → still 302 to signin', async () => {
    const km = await makeKeyMaterial()
    const token = await mintTokenFor(km, { project_slug: 'someone-elses-slug' })
    const req = makeBrowserRequest(
      `https://vibe.neutron.example/chat?start=${encodeURIComponent(token)}`,
    )
    const decision = await evaluateAuthGate(req, buildShimGateOpts(km))
    expect(decision.kind).toBe('redirect-to-signin')
  })

  test('registry shim THROWS + no slug-history match → fail-closed → 302 (no widening)', async () => {
    const km = await makeKeyMaterial()
    const token = await mintTokenFor(km, { project_slug: NEW_SLUG })
    const req = makeBrowserRequest(
      `https://vibe.neutron.example/chat?start=${encodeURIComponent(token)}`,
    )
    const decision = await evaluateAuthGate(
      req,
      buildShimGateOpts(km, {
        ownerRegistry: {
          getCurrentUrlSlugByInternalHandle: (): string | null => {
            throw new Error('registry unreachable')
          },
        },
        slugHistoryStore: {
          lookup: async () => null,
        },
      }),
    )
    expect(decision.kind).toBe('redirect-to-signin')
  })

  test('shims UNWIRED (dev/smoke/Open self-host) → strict equality preserved → NEW-slug token 302s', async () => {
    const km = await makeKeyMaterial()
    const token = await mintTokenFor(km, { project_slug: NEW_SLUG })
    const req = makeBrowserRequest(
      `https://vibe.neutron.example/chat?start=${encodeURIComponent(token)}`,
    )
    // buildGateOpts has no internal_handle / shims wired.
    const decision = await evaluateAuthGate(req, buildGateOpts(km))
    expect(decision.kind).toBe('redirect-to-signin')
  })

  test('exact-match token still authenticates with shims wired (no regression)', async () => {
    const km = await makeKeyMaterial()
    const token = await mintTokenFor(km, { project_slug: PROJECT_SLUG })
    const req = makeBrowserRequest(
      `https://t-55555555.neutron.example/chat?start=${encodeURIComponent(token)}`,
    )
    const decision = await evaluateAuthGate(req, buildShimGateOpts(km))
    expect(decision.kind).toBe('authenticated')
  })
})
