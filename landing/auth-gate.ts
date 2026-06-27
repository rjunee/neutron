/**
 * @neutronai/landing — per-instance gateway auth gate.
 *
 * 2026-05-27 returning-user resume sprint. The per-instance gateway used
 * to serve every user-facing route (`GET /chat`, `GET /api/app/*`,
 * `GET /`) without an HTTP-level auth check — only the WebSocket
 * upgrade demanded `?start=<jwt>`. That left a returning user whose
 * Max OAuth tokens were revoked stranded at "disconnected. refresh to
 * continue." when they revisited their personal URL: the static HTML
 * served fine, but the WS upgrade 400'd and there was no path back to
 * signin.
 *
 * This gate runs BEFORE the landing/app surfaces, on a curated set of
 * user-facing routes. The decision tree:
 *
 *   1. Session cookie present + valid → ALLOW (pass through to the
 *      underlying surface).
 *   2. `?start=<token>` query param valid cryptographically + instance
 *      claim matches THIS gateway's instance → ALLOW + emit a fresh
 *      session cookie. The token is NOT consumed (jti claim happens
 *      later in the `/ws/app/chat` chat upgrade); we just verify the
 *      signature so the gate doesn't burn the one-time-use token on a
 *      stale GET.
 *   3. Otherwise → 302 to identity service's `/oauth/google/start` with
 *      `return_url=<original full URL>`. The identity service threads
 *      the return_url through OAuth state, callback 302s back with a
 *      fresh `?start=<token>` so the next HTTP hit re-enters this gate
 *      at branch (2).
 *
 * Public routes that BYPASS the gate (the boot wrapper decides which
 * paths route here vs around):
 *   - `GET /healthz` — liveness probe
 *   - Static assets (favicon, logo, OG image, etc.)
 *   - `/ws/app/chat` chat upgrade — already gates via `?start=<jwt>` internally
 *   - `POST /onboarding/invite-accept` — owner-side invite handler with
 *     its own JWT
 *   - `/api/internal/*` — token-gated (operator-only)
 *   - `/webhook/telegram` — secret-token-gated
 *   - `/avatar.png`, `/profile-pic/candidate/*` — non-sensitive static
 *   - `/recover` — used to re-mint tokens after WS disconnect
 *   - `/start?token=…` — the per-instance `/start` 302 handler in
 *     landing/server.ts already cookies + bounces to `/chat?start=…`.
 *
 * Programmatic API requests (Expo app, mobile native) carry
 * `Authorization: Bearer <JWT>` headers and `Accept: application/json`.
 * The gate honours `Accept` — non-text/html requests are NOT redirected
 * to signin; they fall through and let the existing bearer-auth chain
 * (connect API middleware) handle them. Without this carve-out
 * the gate would 302 every Expo API call to an HTML signin page.
 */

import type {
  ConsumedStartToken,
  VerifyStartTokenInput,
} from '../runtime/start-token-types.ts'
import type { KeyLike } from 'jose'
import {
  formatSetCookie,
  readSessionCookie,
  signSessionCookie,
} from './session-cookie.ts'

/** Resolve a JWKS key by `kid`. Structurally identical to the resolver
 *  the platform chat-proxy uses; defined locally since C2 relocated that
 *  module Managed-side (open-not-to-managed boundary). */
export type JwksResolveKey = (kid: string) => Promise<KeyLike | null>

/** Result union of the injected start-token verifier — structural mirror
 *  of `signup/start-token.ts:VerifyStartTokenCryptographicResult`. Defined
 *  locally since C2 closed the open-not-to-managed boundary (same posture
 *  as `JwksResolveKey` above): the Managed production composer injects
 *  `verifyStartTokenCryptographic`; tests inject fakes. */
export type VerifyStartTokenGateResult =
  | { ok: true; claims: ConsumedStartToken }
  | { ok: false; reason: string }
export type VerifyStartTokenGateFn = (
  input: VerifyStartTokenInput,
) => Promise<VerifyStartTokenGateResult>

export interface AuthGateOptions {
  /** This gateway's instance slug. The `?start=<token>` flow verifies the
   *  JWT's `project_slug` claim against this value — a cross-instance token
   *  is rejected as if no token were present. */
  project_slug: string
  /** HMAC secret for session cookies. Same secret as the platform proxy
   *  (`NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET`) — cookies are host-scoped
   *  so the two gateways don't collide, but identical secret + format
   *  means tests + ops tooling can verify both ends in one shot. */
  cookie_secret: string
  /** JWKS resolver — production wires through `JwksCache.resolveKey`
   *  against the auth service's JWKS endpoint (host from
   *  `NEUTRON_AUTH_PUBLIC_BASE_URL`); tests inject an in-memory map. */
  resolveKey: JwksResolveKey
  /** Cryptographic start-token verifier — the Managed production composer
   *  wires `signup/start-token.ts:verifyStartTokenCryptographic` (C2
   *  open-not-to-managed boundary: the Open gate no longer imports the
   *  Managed module statically); tests inject fakes. */
  verifyStartToken: VerifyStartTokenGateFn
  /** Identity service's public base URL — used to build the
   *  signin URL. Configured via `NEUTRON_AUTH_PUBLIC_BASE_URL`
   *  (no default — operator sets it, e.g. `https://auth.example.test`). */
  identity_public_base_url: string
  /** Inject for test determinism. Defaults to Date.now. */
  now?: () => number
  /**
   * Argus r1 BLOCKER #1 (2026-05-27) — mint a fresh start_token bound to
   * THIS gateway's instance. Wired by the production composer using the
   * same `KeyManager` + instance registry lookup as `/recover`. Used when
   * a cookie-authenticated browser hits `GET /chat` without `?start=` so
   * the inevitable `/ws/app/chat` upgrade has a usable token.
   *
   * Without this hook, a cookie-only `/chat` GET serves chat.html with
   * no token; the WS upgrade 400s on missing-start-token, chat.ts's
   * onClose navigates back to `/chat`, the cookie still passes the gate,
   * → hot redirect loop. With this hook, the gate 302s to
   * `/chat?start=<fresh>` so the WS upgrade has a valid token and the
   * loop never starts.
   *
   * Optional — when omitted the gate falls through to `allow` for the
   * cookie-only `/chat` case (test / dev / pre-rollout deploys). The
   * caller is responsible for ensuring the chat client's onClose path
   * doesn't loop in that mode (it doesn't — there's no auth gate to
   * loop through). Returns the freshly-issued JWT string, OR `null` if
   * the mint failed (DB unwired, signing key missing, owner mismatch).
   */
  mintStartToken?: () => Promise<string | null>
  /**
   * 2026-06-03 — pending-redirect HTTP 302 fallback (belt-and-braces
   * alongside the WS reconnect-replay path in chat-bridge `startSession`).
   *
   * Closes Sam's 2026-06-03 incident: after a slug rename whose live
   * `slug_renamed` WS envelope failed to deliver (WS dropped mid-slug-
   * pick), the slug-picker hook persists a pending-redirect row. The
   * WS-replay path catches a reconnecting socket, but a user who does a
   * PLAIN PAGE RELOAD (no live WS yet) would re-render `chat.<base>` and
   * stay stranded. This hook lets the gate 302 such a reload straight
   * to `<new_slug>.<base>/chat?start=<token>`.
   *
   * The production composer wires this against the same per-instance
   * `SqlitePendingRedirectStore` the chat-bridge reader consumes + the
   * instance's `owner_user_id` (to build the `web:<user_id>` topic key).
   * It does an atomic `take()` (one-shot, idempotent with the WS-replay
   * path's `takeAndClaim`) and returns the fully-formed redirect
   * `location` (`https://<new_host>/chat?start=<new_start_token>`), OR
   * `null` when there is no pending row, it expired, or the request is
   * already ON the destination host (no self-redirect loop). The gate
   * passes the request's resolved host so the hook can apply that guard.
   *
   * Optional — when omitted the gate skips the check (dev / smoke
   * deploys, Open self-hosters without slug-rename).
   */
  resolvePendingRedirect?: (current_host: string) => Promise<string | null>
  /**
   * 2026-06-05 slug-rename AUTH-LOOP fix. This gateway's frozen-at-boot
   * `internal_handle`. Required for the two slug-rename shims below — both
   * resolve BY this handle (never by the attacker-controlled claim) so a
   * token bound to a DIFFERENT instance whose claim happens to name a slug
   * in our registry cannot pass. When unset, the shims are inert and the
   * gate falls back to strict `claim === project_slug` equality.
   */
  internal_handle?: string
  /**
   * 2026-06-05 slug-rename AUTH-LOOP fix — registry shim. Returns the
   * instance's CURRENT `url_slug` for the given `internal_handle`. Mirrors
   * the WS-upgrade path (`gateway/http/chat-bridge.ts:validateStartToken`):
   * a NEW-slug `?start` token minted by a rename the per-instance gateway
   * hasn't RESTARTED for (so `opts.project_slug` is still the OLD slug) is
   * accepted when the registry confirms the claim IS this instance's current
   * url_slug. Without this, the "Open your agent →" handoff button's
   * NEW-slug token was rejected by strict equality and the gate 302→OAuth
   * looped forever (2026-06-05 handle→custom-slug rename incident). See
   * docs/plans/slug-rename-auth-loop-2026-06-05.md.
   */
  ownerRegistry?: {
    getCurrentUrlSlugByInternalHandle(internal_handle: string): string | null
  }
  /**
   * 2026-06-05 slug-rename AUTH-LOOP fix — slug-history shim. Accepts an
   * OLD-slug `?start` token within the post-rename grace window (P1.5
   * § 1.5.5). Same store shape the WS-path shim consumes; cross-instance
   * safety is enforced by the `internal_handle` precondition above. Fails
   * closed on a backing-store throw (rather than accept under uncertainty).
   */
  slugHistoryStore?: {
    lookup(input: {
      old_slug: string
      internal_handle: string
      now_ms: number
    }): Promise<{ expires_at_ms: number } | null>
  }
}

/**
 * 2026-06-05 slug-rename AUTH-LOOP fix — does `claimSlug` (a start-token's
 * `project_slug` claim) belong to THIS gateway's instance?
 *
 * Mirrors the WS-upgrade path's `validateStartToken` shim
 * (`gateway/http/chat-bridge.ts`), in priority order:
 *   1. Exact match against the gateway's frozen-at-boot `project_slug`.
 *   2. Registry shim — the claim equals the instance's CURRENT `url_slug`
 *      (NEW-slug JWT minted by a rename the gateway hasn't restarted for).
 *   3. Slug-history shim — the claim is a non-expired OLD slug for this
 *      instance (grace window after a rename).
 *
 * Cross-instance safety: (2)+(3) are gated on `opts.internal_handle` and
 * resolve BY our own handle — never by the (caller-supplied) claim — so a
 * token bound to a different instance cannot pass even if its slug collides
 * with a name in our registry. Both shims FAIL CLOSED (a registry/DB throw
 * makes that path contribute no match) so an unreachable backing store can
 * never widen acceptance beyond strict equality.
 */
async function startTokenSlugMatchesInstance(
  claimSlug: string,
  opts: AuthGateOptions,
  now_ms: number,
): Promise<boolean> {
  if (claimSlug === opts.project_slug) return true
  const ih = opts.internal_handle
  if (ih === undefined || ih.length === 0) return false
  if (opts.ownerRegistry !== undefined) {
    try {
      const current = opts.ownerRegistry.getCurrentUrlSlugByInternalHandle(ih)
      if (current !== null && current === claimSlug) return true
    } catch {
      // Fail-closed — fall through to the slug-history shim.
    }
  }
  if (opts.slugHistoryStore !== undefined) {
    try {
      const match = await opts.slugHistoryStore.lookup({
        old_slug: claimSlug,
        internal_handle: ih,
        now_ms,
      })
      if (match !== null && match.expires_at_ms >= now_ms) return true
    } catch {
      // Fail-closed — reject rather than accept under uncertainty.
    }
  }
  return false
}

/**
 * Result of evaluating the gate for a single request. The caller is
 * responsible for stitching the decision into the outgoing response —
 * `allow` falls through to the underlying handler, `redirect` returns a
 * 302, `authenticated` falls through but adds a `Set-Cookie` header.
 */
export type AuthGateDecision =
  /** Request is authenticated — pass through to the underlying surface.
   *  Carries an optional `set_cookie` so cookie-valid requests can refresh
   *  the session cookie on every authenticated hit (sliding refresh,
   *  2026-05-27 persistent-session-cookie sprint). Callers that wrap the
   *  decision (`applyAuthGate`, `composeHttpHandler`) MUST append this
   *  `Set-Cookie` onto the underlying response when defined so the cookie's
   *  expiry rolls forward and an active user never times out. */
  | { kind: 'allow'; set_cookie?: string }
  /** Request just consumed a `?start=<token>` — pass through AND set
   *  the fresh session cookie via `Set-Cookie`. The verified claims are
   *  surfaced for callers that want them (audit log, etc.). */
  | { kind: 'authenticated'; set_cookie: string; verified: ConsumedStartToken }
  /** Request lacks auth and is a browser navigation — return a 302
   *  pointing at the identity service's signin URL with `return_url`
   *  preserved. */
  | { kind: 'redirect-to-signin'; location: string }
  /**
   * Argus r1 BLOCKER #1 + #2 (2026-05-27) — the gate is producing a
   * 302 to a per-instance route (NOT identity signin) because either:
   *
   *   - The user has a valid session cookie on `GET /` so the gate
   *     redirects to `/chat` (BLOCKER #2 — bare `/` would otherwise
   *     404). No fresh cookie needed; the existing cookie carries.
   *
   *   - The user has a valid session cookie on `GET /chat` without
   *     `?start=` and `mintStartToken` is wired, so the gate
   *     mints a fresh JWT + 302s to `/chat?start=<fresh>` with a
   *     refreshed session cookie. The destination's HTML bootstrap
   *     reads the token + the WS upgrade consumes it, breaking the
   *     hot-loop the previous shape produced (BLOCKER #1).
   *
   *   - The user just signed in (`GET /?start=<valid>`) — the gate
   *     consumed the token + minted a cookie, then 302s to
   *     `/chat?start=<token>` so the destination's WS upgrade has the
   *     same JWT and the chat surface boots cleanly (BLOCKER #2 path
   *     for tokenless first-signin where identity calls back on `/`).
   */
  | { kind: 'redirect'; location: string; set_cookie?: string }
  /** Request lacks auth but is a programmatic API call (Accept !=
   *  text/html). Fall through and let the underlying bearer-auth
   *  middleware decide; the gate stays out of API paths. */
  | { kind: 'pass-through-unauthed' }

/**
 * Evaluate the auth gate for a single request. The caller wraps the
 * decision into either a 302 (redirect-to-signin) or passes through to
 * the underlying handler (allow / authenticated / pass-through-unauthed)
 * with the `set_cookie` field appended to the response headers when
 * present.
 */
export async function evaluateAuthGate(
  req: Request,
  opts: AuthGateOptions,
): Promise<AuthGateDecision> {
  const now = opts.now ?? ((): number => Date.now())
  const url = new URL(req.url)
  const method = req.method
  const pathname = url.pathname
  const hasStartQuery = url.searchParams.has('start')

  // Branch 1: valid session cookie → allow / redirect / mint-and-redirect.
  const cookieSlug = readSessionCookie(req, opts.cookie_secret, now())
  if (cookieSlug !== null && cookieSlug === opts.project_slug) {
    // 2026-06-03 — pending-redirect HTTP 302 fallback (Sam's incident).
    // Checked FIRST so a plain page reload after a slug rename lands the
    // user on the new subdomain even when the live `slug_renamed` WS
    // envelope was dropped and no socket has reconnected yet. Only on a
    // browser GET of `/` or `/chat` (never `/api/app/*` JSON). The hook
    // does an atomic take() (one-shot; idempotent with the WS-replay
    // path) and self-guards against redirecting when already on the
    // destination host. No Set-Cookie: the destination host is a
    // DIFFERENT origin (cookies are host-scoped) and sets its own
    // session cookie when it consumes the `?start=` token.
    if (
      opts.resolvePendingRedirect !== undefined &&
      method === 'GET' &&
      (pathname === '/chat' || pathname === '/')
    ) {
      try {
        const location = await opts.resolvePendingRedirect(resolveRequestHost(req))
        if (location !== null) {
          return { kind: 'redirect', location }
        }
      } catch (err) {
        console.warn(
          `[auth-gate] project_slug=${opts.project_slug} resolvePendingRedirect threw — falling through:`,
          err,
        )
      }
    }
    // Argus r1 BLOCKER #2 (2026-05-27): GET / has no downstream handler in
    // the per-instance gateway (the brief explicitly required `/` to land
    // the user on `/chat`). The previous shape passed the cookie check
    // and fell through to the default 404. 302 to `/chat` so the next
    // hit re-enters the gate at the cookie-OR-mint branch and serves
    // the chat surface cleanly.
    //
    // 2026-05-27 persistent-session-cookie sprint: also emit a refreshed
    // session cookie so this authenticated hit rolls the 30-day expiry
    // forward (sliding refresh). The browser would carry the existing
    // cookie on its own (same-origin), but for sliding refresh we
    // explicitly push the cookie's `expires_at_ms` to `now + 30d` on
    // every authenticated request.
    if (pathname === '/' && method === 'GET') {
      const refreshed = signSessionCookie(
        opts.project_slug,
        opts.cookie_secret,
        now(),
      )
      return {
        kind: 'redirect',
        location: '/chat',
        set_cookie: formatSetCookie(refreshed),
      }
    }
    // Argus r1 BLOCKER #1 (2026-05-27): cookie-only GET /chat used to
    // ALLOW and serve chat.html, but the chat WS upgrade fires
    // `/ws/app/chat?start=` (empty) → 400 missing-start-token, which trips
    // the new onClose path that navigates back to `/chat` → cookie
    // still valid → ALLOW again → hot redirect loop. Mint a fresh
    // start_token here (same KeyManager + instance lookup as /recover)
    // and 302 to `/chat?start=<fresh>` so the destination's WS upgrade
    // has a usable JWT. Refresh the session cookie so the rolling
    // 15-min TTL doesn't expire mid-session.
    if (
      pathname === '/chat' &&
      method === 'GET' &&
      !hasStartQuery &&
      opts.mintStartToken !== undefined
    ) {
      try {
        const fresh = await opts.mintStartToken()
        if (typeof fresh === 'string' && fresh.length > 0) {
          const refreshed = signSessionCookie(
            opts.project_slug,
            opts.cookie_secret,
            now(),
          )
          return {
            kind: 'redirect',
            location: `/chat?start=${encodeURIComponent(fresh)}`,
            set_cookie: formatSetCookie(refreshed),
          }
        }
      } catch (err) {
        console.warn(
          `[auth-gate] project_slug=${opts.project_slug} mintStartToken threw — falling through to allow (chat.html will boot without a token):`,
          err,
        )
      }
      // Mint hook returned null OR threw — fall through to `allow`. The
      // user lands on chat.html without a fresh ?start=, the WS upgrade
      // 400s, and chat.ts's onClose path may still loop. Logged above
      // so the operator can chase the mint failure; the loop is no
      // worse than the pre-Argus-r1 shape we're already shipping.
    }
    // 2026-05-27 persistent-session-cookie sprint: refresh the cookie on
    // every cookie-valid `allow` so the 30-day TTL keeps rolling forward
    // on each authenticated request (sliding refresh). The caller stitches
    // this `set_cookie` onto the downstream response.
    const refreshed = signSessionCookie(
      opts.project_slug,
      opts.cookie_secret,
      now(),
    )
    return { kind: 'allow', set_cookie: formatSetCookie(refreshed) }
  }

  // Branch 2: `?start=<token>` → verify, cookie, allow / redirect.
  const token = url.searchParams.get('start') ?? ''
  if (token.length > 0) {
    const verifyArgs: VerifyStartTokenInput = {
      token,
      resolveKey: opts.resolveKey,
    }
    if (opts.now !== undefined) verifyArgs.now = opts.now
    const result = await opts.verifyStartToken(verifyArgs)
    // 2026-06-05 slug-rename AUTH-LOOP fix — accept the claim when it
    // belongs to THIS instance (exact, no-restart-rename registry match, or
    // slug-history grace window), mirroring the WS-path validateStartToken
    // shim. The previous strict `claims.project_slug === opts.project_slug`
    // rejected a NEW-slug handoff token against a not-yet-restarted gateway
    // → 302→OAuth→302 loop. The session cookie below still carries
    // `opts.project_slug` (the gateway's frozen identity) — downstream
    // collapse, identical to the WS path's `downstreamSlug`.
    if (
      result.ok &&
      result.claims.signup_via === 'web' &&
      (await startTokenSlugMatchesInstance(
        result.claims.project_slug,
        opts,
        now(),
      ))
    ) {
      const cookie = signSessionCookie(opts.project_slug, opts.cookie_secret, now())
      // Argus r1 BLOCKER #2 path for tokenless first-signin: identity
      // service's `onReturningWebSignin` appends `?start=<fresh>` to
      // the threaded return_url. If the user signed in via the bare
      // domain (return_url=https://<slug>.<base>/), the callback lands
      // on GET / with a valid token but no /chat handler exists. 302
      // to `/chat?start=<token>` so the destination boots cleanly +
      // the WS upgrade has the same JWT (jti claim happens at
      // /ws/app/chat — verifying here does NOT consume the token, the
      // atomic consume is downstream).
      if (pathname === '/' && method === 'GET') {
        return {
          kind: 'redirect',
          location: `/chat?start=${encodeURIComponent(token)}`,
          set_cookie: formatSetCookie(cookie),
        }
      }
      return {
        kind: 'authenticated',
        set_cookie: formatSetCookie(cookie),
        verified: result.claims,
      }
    }
    // Token invalid (expired, cross-instance, telegram-typed) — fall through
    // to the no-auth branches. We do NOT 401 here because the user can
    // recover by re-signing in.
  }

  // Branch 3a: no auth + non-browser request → let the underlying API
  // bearer-auth chain handle it. The gate's job is to send BROWSERS to
  // signin, not to interfere with mobile-app JSON calls.
  if (!isBrowserNavigation(req)) {
    return { kind: 'pass-through-unauthed' }
  }

  // Branch 3b: no auth + browser nav → 302 to identity signin with
  // `return_url` preserved.
  const returnUrl = buildOriginalRequestUrl(req)
  const signinUrl = new URL('/oauth/google/start', opts.identity_public_base_url)
  signinUrl.searchParams.set('via', 'web')
  signinUrl.searchParams.set('return_url', returnUrl)
  return { kind: 'redirect-to-signin', location: signinUrl.toString() }
}

/**
 * Decide whether a request looks like a real browser navigation that
 * should be redirected to signin, vs a programmatic API call that
 * should fall through. The signal is the `Accept` header — every
 * browser sends `text/html` on navigation; API clients send
 * `application/json` or the wildcard accept.
 *
 * Mirrors the `prefersBrowserRedirect` helper in `identity/service.ts`.
 * Kept here as a local copy because the identity-side function is
 * private + this module must not take an import edge on the identity
 * service tree (Open-tier classifying — the auth-gate ships in the
 * public repo whereas identity/service.ts is Managed-only).
 */
function isBrowserNavigation(req: Request): boolean {
  const accept = req.headers.get('accept')
  if (accept === null || accept === '') return false
  const lower = accept.toLowerCase()
  // Every browser sends text/html as a top-priority type on navigation.
  if (!lower.includes('text/html')) return false
  // A client passing `Accept: application/json, text/html;q=0.9`
  // prefers JSON — return false. Substring-checking text/html alone
  // would wrongly fire here.
  if (lower.includes('application/json')) return false
  return true
}

/**
 * Reconstruct the full origin-qualified URL the user originally
 * requested, honouring `X-Forwarded-Proto` / `X-Forwarded-Host` that
 * the production Caddy proxy chain sets. Used as the `return_url`
 * query param on the signin redirect so the identity callback can
 * 302 the user back to exactly where they came from.
 *
 * Mirrors `resolveRequestOriginChatUrl` in `gateway/index.ts` (which
 * does the same for the Max OAuth gate). Kept separate here so the
 * caller doesn't take a circular import.
 */
/**
 * Resolve the host the user actually requested, honouring the
 * `X-Forwarded-Host` the production Caddy chain sets (so a request that
 * arrived at `sage.example.test` is seen as such even though the
 * upstream Bun socket only knows its loopback bind). Used by the
 * pending-redirect 302 fallback to avoid redirecting a user who is
 * already ON the destination subdomain back to itself.
 *
 * TRUST ASSUMPTION (Argus r2 minor): `X-Forwarded-Host` is trusted because
 * the instance Bun process binds loopback-only and the production Caddy chain
 * (sole ingress) OVERWRITES the header with the real SNI host — a client
 * cannot inject it. Mirror of the note on `resolveRequestHost` in
 * `landing/server.ts`; if an instance is ever direct-bound without Caddy this
 * header becomes spoofable and derivation must switch to a configured origin.
 */
function resolveRequestHost(req: Request): string {
  const reqUrl = new URL(req.url)
  const xfh = req.headers.get('x-forwarded-host')
  return (xfh ?? reqUrl.host).split(',')[0]!.trim()
}

function buildOriginalRequestUrl(req: Request): string {
  const reqUrl = new URL(req.url)
  const xfp = req.headers.get('x-forwarded-proto')
  const xfh = req.headers.get('x-forwarded-host')
  const proto = (xfp ?? reqUrl.protocol.replace(/:$/, '')).split(',')[0]!.trim()
  const host = (xfh ?? reqUrl.host).split(',')[0]!.trim()
  // Strip any pre-existing `?start=<token>` from the return URL — the
  // identity callback appends a fresh one and we don't want the OAuth
  // round-trip to re-circulate a stale (consumed-jti) token. Other
  // query params survive so deeplinks like `/?invite=abc` round-trip.
  reqUrl.searchParams.delete('start')
  const search = reqUrl.searchParams.toString()
  const suffix = search.length > 0 ? `?${search}` : ''
  return `${proto}://${host}${reqUrl.pathname}${suffix}`
}

/**
 * Helper for callers that want to wrap the underlying handler in the
 * gate. Returns either the gate's own 302 response, OR passes through
 * to the wrapped handler — appending the `Set-Cookie` header if the
 * gate consumed a `?start=<token>`. Returning the wrapped response
 * directly when the gate decides `pass-through-unauthed` lets the
 * downstream chain (e.g. bearer-auth middleware) return its own 401.
 */
export async function applyAuthGate(
  req: Request,
  opts: AuthGateOptions,
  next: () => Promise<Response> | Response,
): Promise<Response> {
  const decision = await evaluateAuthGate(req, opts)
  if (decision.kind === 'redirect-to-signin') {
    return new Response(null, {
      status: 302,
      headers: { location: decision.location },
    })
  }
  if (decision.kind === 'redirect') {
    const headers = new Headers({ location: decision.location })
    if (decision.set_cookie !== undefined) {
      headers.append('set-cookie', decision.set_cookie)
    }
    return new Response(null, { status: 302, headers })
  }
  const res = await next()
  if (decision.kind === 'authenticated') {
    // Tack the Set-Cookie header onto the underlying response. The
    // underlying handler may have set other headers; we preserve them
    // via the spread + override pattern below.
    const headers = new Headers(res.headers)
    headers.append('set-cookie', decision.set_cookie)
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    })
  }
  if (decision.kind === 'allow' && decision.set_cookie !== undefined) {
    // 2026-05-27 persistent-session-cookie sprint — sliding refresh:
    // every cookie-valid `allow` carries a freshly-signed Set-Cookie so
    // the 30-day TTL rolls forward on every authenticated request.
    const headers = new Headers(res.headers)
    headers.append('set-cookie', decision.set_cookie)
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    })
  }
  return res
}
