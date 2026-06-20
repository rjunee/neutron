/**
 * @neutronai/landing — shared HMAC-signed session cookie.
 *
 * Lifted from `landing/onboarding-chat-proxy.ts` (2026-05-09 chat-shared
 * subdomain sprint) so the same cookie format can be used by BOTH the
 * onboarding-chat-proxy AND the new per-instance gateway auth-gate
 * (`landing/auth-gate.ts`, 2026-05-27 returning-user resume sprint).
 *
 * Format: `<project_slug>.<expires_at_ms>.<base64url(HMAC-SHA256(<slug>.<expires_at_ms>))>`.
 *
 * The cookie is host-scoped so the per-instance gateway sets one cookie
 * (Domain=<slug>.<base>) and the platform proxy sets a separate cookie
 * (Domain=chat.<base>). Same secret + same format on both ends — only
 * the host scoping differs.
 *
 * The session cookie is the LONG-LIVED auth substrate (30 days). The
 * per-instance gateway's auth-gate refreshes it on every authenticated
 * HTTP request (sliding refresh), so an active user stays logged in
 * indefinitely — matches the industry-standard chat-surface shape
 * (Slack, Discord, ChatGPT all use 30-day+ session cookies).
 *
 * Start-token JWTs (`START_TOKEN_TTL_SECONDS`) stay short-lived (15 min)
 * since they're one-shot artifacts for the WS upgrade handshake. The
 * cookie outlives the JWT because authenticated state — not token
 * freshness — gates HTTP requests. The brief flipped the original
 * 2026-05-09 model where cookie TTL piggy-backed on JWT TTL.
 */

import { createHmac } from 'node:crypto'
import { constantTimeEqual } from '../runtime/constant-time-equal.ts'

/** Cookie name shared across the platform proxy + per-instance gateway. */
export const SESSION_COOKIE_NAME = '__neutron_chat_session'
/** Cookie max-age in seconds — 30 days. The auth-gate refreshes the
 *  cookie on every authenticated request (sliding refresh) so an active
 *  user's session keeps rolling forward indefinitely. */
export const SESSION_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60

export interface SessionCookie {
  name: string
  value: string
  max_age_s: number
}

/**
 * Sign a fresh session cookie for `project_slug`. The signed `value` is
 * an opaque string the browser sends back on every subsequent request to
 * the same host; the verifier reads `<slug>` out, checks expiry, and
 * matches the HMAC in constant time.
 */
export function signSessionCookie(
  project_slug: string,
  secret: string,
  now_ms: number,
): SessionCookie {
  const expires_at_ms = now_ms + SESSION_COOKIE_MAX_AGE_S * 1000
  const body = `${project_slug}.${expires_at_ms}`
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return {
    name: SESSION_COOKIE_NAME,
    value: `${body}.${sig}`,
    max_age_s: SESSION_COOKIE_MAX_AGE_S,
  }
}

/**
 * Read + verify the session cookie from a `Request`. Returns the
 * embedded `project_slug` on success, or `null` if the cookie is missing,
 * malformed, expired, or signed with a different secret.
 */
export function readSessionCookie(
  req: Request,
  secret: string,
  now_ms: number,
): string | null {
  const header = req.headers.get('cookie')
  if (header === null) return null
  const value = parseCookie(header, SESSION_COOKIE_NAME)
  if (value === null) return null
  const parts = value.split('.')
  if (parts.length !== 3) return null
  const [project_slug, expires_at_ms_raw, sig] = parts
  if (
    project_slug === undefined ||
    expires_at_ms_raw === undefined ||
    sig === undefined ||
    project_slug.length === 0
  ) {
    return null
  }
  const expires_at_ms = Number.parseInt(expires_at_ms_raw, 10)
  if (!Number.isFinite(expires_at_ms) || expires_at_ms < now_ms) return null
  const expected = createHmac('sha256', secret)
    .update(`${project_slug}.${expires_at_ms_raw}`)
    .digest('base64url')
  if (!constantTimeEqual(sig, expected)) return null
  return project_slug
}

/**
 * Build the `Set-Cookie` header value for a freshly-signed cookie.
 * `HttpOnly; Secure; SameSite=Lax; Path=/`.
 *
 * SameSite=**Lax** (not Strict) is the deliberate, load-bearing choice
 * here: this cookie is minted at the END of the OAuth-callback redirect
 * chain — `chat.<base>/chat` → 302 → `auth.<base>/oauth/google/start` →
 * Google → 302 → `auth.<base>/callback` → 302 →
 * `chat.<base>/chat?start=<jwt>`. The response that mints the cookie is
 * served to a top-level GET navigation initiated *from* `auth.<base>`
 * (a different site). Under SameSite=**Strict**, browsers silently DROP
 * a Set-Cookie set in that cross-site-navigation context (and won't
 * attach the cookie on the first same-site reload afterwards either) —
 * so the cookie never lands, and every reload of `chat.<base>/chat`
 * re-runs the full OAuth flow. That was the 2026-06-03 "forced re-login
 * on every reload" incident.
 *
 * Lax permits the cookie to be set + sent on cross-site TOP-LEVEL GET
 * navigations — exactly the OAuth-callback shape — while still blocking
 * it on cross-site sub-resource requests and POSTs (CSRF protection
 * intact). This is the standard policy for OAuth-issued session cookies.
 * HttpOnly (no client-JS read) + Secure (HTTPS only) are unchanged.
 *
 * No `Domain` attribute: the cookie stays host-bound to the chat host
 * (`chat.<base>` / `<slug>.<base>`). The identity service on `auth.<base>`
 * never reads `__neutron_chat_session` (it gates on OAuth + start-token
 * JWTs), so spanning subdomains via `Domain=.<base>` would only widen
 * scope with no consumer — host-binding is the tighter, correct choice.
 */
export function formatSetCookie(c: SessionCookie): string {
  return `${c.name}=${c.value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${c.max_age_s}`
}

function parseCookie(header: string, name: string): string | null {
  const parts = header.split(';')
  for (const raw of parts) {
    const trimmed = raw.trim()
    if (!trimmed.startsWith(`${name}=`)) continue
    return trimmed.slice(name.length + 1)
  }
  return null
}
