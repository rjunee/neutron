/**
 * Regression test — session cookie survives the OAuth-callback
 * cross-site redirect chain (2026-06-03 forced-re-login incident).
 *
 * Incident (Sam, 2026-06-03): every reload of
 * `https://chat.neutron.example/chat` forced a fresh login. The
 * `__neutron_chat_session` cookie was being minted with
 * `SameSite=Strict`, which browsers silently DROP when the response
 * that sets the cookie is served to a top-level GET navigation
 * initiated from a DIFFERENT site — exactly the OAuth-callback shape:
 *
 *   chat.<base>/chat → 302 → auth.<base>/oauth/google/start → Google
 *     → 302 → auth.<base>/callback → 302 → chat.<base>/chat?start=<jwt>
 *
 * The final hop is navigated to *from* `auth.<base>` (cross-site). Under
 * Strict the cookie never lands; the next reload has no cookie; the
 * auth-gate 302s back to OAuth. Fix: SameSite=Lax (the standard policy
 * for OAuth-issued session cookies) — set + sent on cross-site
 * top-level GET navigations, still blocked on cross-site sub-resources
 * and POSTs (CSRF protection intact).
 *
 * This test walks the chain end-to-end (mocked JWKS):
 *   1. The OAuth-callback hop `GET /chat?start=<jwt>` (Referer =
 *      auth.<base>/callback) → the gate mints a Set-Cookie that MUST
 *      carry `SameSite=Lax` and MUST NOT carry `SameSite=Strict`.
 *   2. A subsequent SAME-SITE reload carrying that cookie → the gate
 *      ALLOWs (or redirects to a valid per-instance page) — it must NOT
 *      302 back to OAuth signin.
 *
 * Time-dependent assertions use `Date.now()`-relative timestamps per
 * internal design notes.
 */

import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, importJWK, type KeyLike } from 'jose'
import { evaluateAuthGate } from '../auth-gate.ts'
import { SESSION_COOKIE_NAME } from '../session-cookie.ts'
import {
  issueStartToken,
  verifyStartTokenCryptographic,
} from '@neutronai/runtime/__tests__/start-token-testkit.ts'

const COOKIE_SECRET = 'test-cookie-secret-32-chars-long'
const PROJECT_SLUG = 't-55555555'
const IDENTITY_BASE_URL = 'https://auth.neutron.example'
const CHAT_HOST = 'https://t-55555555.neutron.example'
const CALLBACK_REFERER = 'https://auth.neutron.example/callback'

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

async function mintToken(km: KeyMaterial): Promise<string> {
  const issued = await issueStartToken({
    project_slug: PROJECT_SLUG,
    user_id: 'user-1',
    signup_via: 'web',
    signing_key: { kid: km.kid, privateKey: km.privateKey },
    ttl_seconds: 600,
  })
  return issued.token
}

function browserGet(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    headers: {
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...headers,
    },
  })
}

function gateOpts(km: KeyMaterial): Parameters<typeof evaluateAuthGate>[1] {
  return {
    project_slug: PROJECT_SLUG,
    cookie_secret: COOKIE_SECRET,
    resolveKey: async (kid) => (kid === km.kid ? km.publicKey : null),
    identity_public_base_url: IDENTITY_BASE_URL,
    verifyStartToken: verifyStartTokenCryptographic,
  }
}

/** Extract the bare `<name>=<value>` the browser would echo back from a
 *  full `Set-Cookie` header value. */
function browserCookie(setCookie: string): string {
  return setCookie.split(';')[0]!.trim()
}

describe('session cookie survives OAuth-callback cross-site redirect', () => {
  test('OAuth-callback hop GET /chat?start=<jwt> mints a SameSite=Lax cookie (NOT Strict)', async () => {
    const km = await makeKeyMaterial()
    const token = await mintToken(km)
    // The browser is navigating to chat.<base> FROM auth.<base>/callback
    // (cross-site top-level GET). Referer reflects the OAuth callback.
    const req = browserGet(
      `${CHAT_HOST}/chat?start=${encodeURIComponent(token)}`,
      { referer: CALLBACK_REFERER },
    )
    const decision = await evaluateAuthGate(req, gateOpts(km))

    expect(decision.kind).toBe('authenticated')
    if (decision.kind === 'authenticated') {
      // The load-bearing assertion for the incident: Lax, not Strict.
      // Strict would silently drop this cookie at landing time.
      expect(decision.set_cookie).toContain('SameSite=Lax')
      expect(decision.set_cookie).not.toContain('SameSite=Strict')
      expect(decision.set_cookie).toContain(`${SESSION_COOKIE_NAME}=`)
      expect(decision.set_cookie).toContain('HttpOnly')
      expect(decision.set_cookie).toContain('Secure')
    }
  })

  test('same-site reload carrying the minted cookie → gate ALLOWs (no bounce back to OAuth)', async () => {
    const km = await makeKeyMaterial()
    const token = await mintToken(km)

    // Step 1: the OAuth-callback hop mints the cookie.
    const mintReq = browserGet(
      `${CHAT_HOST}/chat?start=${encodeURIComponent(token)}`,
      { referer: CALLBACK_REFERER },
    )
    const mintDecision = await evaluateAuthGate(mintReq, gateOpts(km))
    expect(mintDecision.kind).toBe('authenticated')
    const setCookie =
      mintDecision.kind === 'authenticated' ? mintDecision.set_cookie : ''
    expect(setCookie).toContain('SameSite=Lax')
    const cookieHeader = browserCookie(setCookie)

    // Step 2: the user reloads chat.<base>/chat — same-site GET, no
    // ?start=, carrying the just-minted cookie. Under the fixed Lax
    // policy the browser DOES attach the cookie, so the gate must NOT
    // 302 back to OAuth signin.
    const reloadReq = browserGet(`${CHAT_HOST}/chat`, { cookie: cookieHeader })
    const reloadDecision = await evaluateAuthGate(reloadReq, gateOpts(km))

    expect(reloadDecision.kind).not.toBe('redirect-to-signin')
    // With no mint hook wired the cookie-valid /chat path falls through
    // to `allow`; the refreshed cookie also rides Lax.
    expect(['allow', 'redirect']).toContain(reloadDecision.kind)
    if (reloadDecision.kind === 'allow' && reloadDecision.set_cookie) {
      expect(reloadDecision.set_cookie).toContain('SameSite=Lax')
      expect(reloadDecision.set_cookie).not.toContain('SameSite=Strict')
    }
  })

  test('regression guard: an absent cookie still bounces to OAuth (gate logic unchanged)', async () => {
    const km = await makeKeyMaterial()
    // No cookie, no token — the gate must still send the browser to
    // signin. This pins that the Lax change did NOT loosen the no-auth
    // path.
    const req = browserGet(`${CHAT_HOST}/chat`)
    const decision = await evaluateAuthGate(req, gateOpts(km))
    expect(decision.kind).toBe('redirect-to-signin')
  })
})
