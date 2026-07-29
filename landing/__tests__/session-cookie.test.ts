/**
 * Unit tests for the shared HMAC-signed session cookie module
 * (`landing/session-cookie.ts`).
 *
 * 2026-05-27 persistent-session-cookie sprint — Part A.
 *
 * Pins:
 *   1. `SESSION_COOKIE_MAX_AGE_S` is the new 30-day constant
 *      (was 15 min; bumped 2026-05-27 to fix mid-chat auto-logout).
 *   2. `signSessionCookie` emits cookies with `max_age_s = 2592000`.
 *   3. `readSessionCookie` round-trips a freshly-signed cookie.
 *   4. Cookie at the EXACT expiry boundary: valid 1ms before, null
 *      1ms after.
 *   5. `formatSetCookie` renders all required attributes
 *      (HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age). Lax — NOT
 *      Strict — so the cookie survives the OAuth-callback cross-site
 *      navigation that mints it (2026-06-03 forced-re-login fix).
 *   6. Cross-secret rejection (HMAC verify with a different secret
 *      returns null — same envelope, different signature).
 *   7. Cross-instance slug parse: cookie signed for one slug reads back
 *      as that exact slug (no slug confusion across instances
 *      deployments).
 *
 * Time-dependent tests use `Date.now()`-relative timestamps per
 * internal design notes
 * — never hardcoded ISO strings that silently rot once wall-clock
 * passes a hardcoded threshold.
 */

import { describe, expect, test } from 'bun:test'
import {
  SESSION_COOKIE_MAX_AGE_S,
  SESSION_COOKIE_NAME,
  formatSetCookie,
  readSessionCookie,
  signSessionCookie,
} from '../session-cookie.ts'

const SECRET_A = 'test-cookie-secret-A-32-chars-long'
const SECRET_B = 'test-cookie-secret-B-32-chars-long'
const PROJECT_SLUG = 't-55555555'

function makeCookieRequest(cookieHeaderValue: string): Request {
  return new Request('https://t-55555555.neutron.example/chat', {
    headers: { cookie: cookieHeaderValue },
  })
}

describe('SESSION_COOKIE_MAX_AGE_S — pinned constant', () => {
  test('equals 30 days (2,592,000 seconds)', () => {
    // The 2026-05-27 persistent-session-cookie sprint bumped this from
    // 15 min to 30 days. If this constant drifts back to the smaller
    // value, the mid-chat auto-logout bug returns — the chat surface
    // strands users at "disconnected. refresh to continue." after the
    // cookie expires.
    expect(SESSION_COOKIE_MAX_AGE_S).toBe(30 * 24 * 60 * 60)
    expect(SESSION_COOKIE_MAX_AGE_S).toBe(2_592_000)
  })

  test('cookie name is the shared platform / per-instance gateway name', () => {
    // Pin the cookie name so accidental renames don't silently break
    // host-scoped cookie continuity across the proxy + per-instance gates.
    expect(SESSION_COOKIE_NAME).toBe('__neutron_chat_session')
  })
})

describe('signSessionCookie', () => {
  test('emits a cookie whose max_age_s field is the 30-day constant', () => {
    const NOW = Date.now()
    const cookie = signSessionCookie(PROJECT_SLUG, SECRET_A, NOW)
    expect(cookie.name).toBe(SESSION_COOKIE_NAME)
    expect(cookie.max_age_s).toBe(2_592_000)
    expect(cookie.max_age_s).toBe(SESSION_COOKIE_MAX_AGE_S)
  })

  test('encodes the instance slug + expiry + HMAC in the value', () => {
    const NOW = Date.now()
    const cookie = signSessionCookie(PROJECT_SLUG, SECRET_A, NOW)
    const parts = cookie.value.split('.')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe(PROJECT_SLUG)
    // Expiry is now + max_age_s * 1000.
    expect(Number.parseInt(parts[1]!, 10)).toBe(NOW + SESSION_COOKIE_MAX_AGE_S * 1000)
    // HMAC envelope is non-empty base64url.
    expect(parts[2]!.length).toBeGreaterThan(0)
  })
})

describe('readSessionCookie', () => {
  test('round-trips a freshly-signed cookie at now=0', () => {
    const cookie = signSessionCookie(PROJECT_SLUG, SECRET_A, 0)
    const req = makeCookieRequest(`${cookie.name}=${cookie.value}`)
    const slug = readSessionCookie(req, SECRET_A, 0)
    expect(slug).toBe(PROJECT_SLUG)
  })

  test('returns the slug 1ms before expiry (cookie still valid at the boundary)', () => {
    const cookie = signSessionCookie(PROJECT_SLUG, SECRET_A, 0)
    const req = makeCookieRequest(`${cookie.name}=${cookie.value}`)
    // expires_at_ms = SESSION_COOKIE_MAX_AGE_S * 1000; readSessionCookie
    // rejects only when `expires_at_ms < now`, so 1ms before is valid.
    const slug = readSessionCookie(req, SECRET_A, SESSION_COOKIE_MAX_AGE_S * 1000 - 1)
    expect(slug).toBe(PROJECT_SLUG)
  })

  test('returns null 1ms after expiry (cookie rejected past the boundary)', () => {
    const cookie = signSessionCookie(PROJECT_SLUG, SECRET_A, 0)
    const req = makeCookieRequest(`${cookie.name}=${cookie.value}`)
    const slug = readSessionCookie(req, SECRET_A, SESSION_COOKIE_MAX_AGE_S * 1000 + 1)
    expect(slug).toBeNull()
  })

  test('returns null when verified with a different secret (cross-secret rejection)', () => {
    // Defense-in-depth: a cookie minted with SECRET_A must NOT validate
    // against SECRET_B even though the envelope shape is identical.
    const cookie = signSessionCookie(PROJECT_SLUG, SECRET_A, 0)
    const req = makeCookieRequest(`${cookie.name}=${cookie.value}`)
    const slug = readSessionCookie(req, SECRET_B, 0)
    expect(slug).toBeNull()
  })

  test('returns the exact slug it was signed for (no slug confusion across instances)', () => {
    // A cookie signed for `t-aaa` must read back as `t-aaa`, never as
    // any other slug. Pins the cross-instance isolation property the
    // auth-gate relies on (`cookieSlug === opts.project_slug`).
    const cookieAaa = signSessionCookie('t-aaa', SECRET_A, 0)
    const reqAaa = makeCookieRequest(`${cookieAaa.name}=${cookieAaa.value}`)
    expect(readSessionCookie(reqAaa, SECRET_A, 0)).toBe('t-aaa')
    expect(readSessionCookie(reqAaa, SECRET_A, 0)).not.toBe('t-bbb')

    const cookieBbb = signSessionCookie('t-bbb', SECRET_A, 0)
    const reqBbb = makeCookieRequest(`${cookieBbb.name}=${cookieBbb.value}`)
    expect(readSessionCookie(reqBbb, SECRET_A, 0)).toBe('t-bbb')
  })
})

describe('formatSetCookie', () => {
  test('includes HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=2592000', () => {
    const NOW = Date.now()
    const cookie = signSessionCookie(PROJECT_SLUG, SECRET_A, NOW)
    const header = formatSetCookie(cookie)
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Secure')
    // Lax — NOT Strict. Strict silently drops the cookie at the
    // OAuth-callback cross-site navigation that mints it (2026-06-03
    // forced-re-login incident). See formatSetCookie docstring.
    expect(header).toContain('SameSite=Lax')
    expect(header).not.toContain('SameSite=Strict')
    expect(header).toContain('Path=/')
    expect(header).toContain('Max-Age=2592000')
    // Cookie name + value precede the attributes.
    expect(header.startsWith(`${SESSION_COOKIE_NAME}=${cookie.value}; `)).toBe(true)
  })

  test('matches the stable format regex used by the auth-gate test', () => {
    // Mirror of the format assertion in `auth-gate.test.ts` so a stray
    // edit to either keeps both ends in sync.
    const NOW = Date.now()
    const cookie = signSessionCookie(PROJECT_SLUG, SECRET_A, NOW)
    const header = formatSetCookie(cookie)
    expect(header).toMatch(
      /^__neutron_chat_session=[^.]+\.\d+\.[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/,
    )
  })
})
