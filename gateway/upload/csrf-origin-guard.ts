/**
 * @neutronai/gateway/upload — CSRF / Origin guard for the upload surfaces.
 *
 * The import-upload surfaces (`POST /api/upload/<source>` and the chunked
 * `start` / `PATCH` / `HEAD` routes) are state-changing endpoints that, on a
 * per-instance gateway, sit behind a cookie-authenticated session. Once the
 * upload surface is publicly exposed, a malicious page on another origin could
 * trigger a cross-site `fetch()` / form POST that rides the user's ambient
 * session cookie — a classic CSRF. This guard rejects such cross-site requests
 * BEFORE any body parsing, disk write, or engine bridge fires.
 *
 * Defense model (standard Fetch-Metadata + Origin CSRF defense):
 *
 *   1. `Sec-Fetch-Site` (sent by every current browser, NOT forgeable from
 *      page JavaScript — it's a forbidden header name):
 *        - `cross-site`            → REJECT (the request originated on another
 *                                     site; this is the CSRF case we block).
 *        - `same-origin`           → allow (same scheme+host+port).
 *        - `same-site`             → allow (sibling subdomain on the same
 *                                     registrable domain — e.g. a different
 *                                     a hosted Neutron subdomain; not a CSRF
 *                                     vector we gate here).
 *        - `none`                  → allow (no initiator — direct address-bar
 *                                     navigation, bookmark, or typed URL).
 *   2. When `Sec-Fetch-Site` is absent (older / non-browser clients), fall
 *      back to the `Origin` header:
 *        - absent                  → allow (non-browser client like curl, the
 *                                     synthetic-auth E2E harness, or a server-
 *                                     to-server caller; browsers omit Origin on
 *                                     same-origin GET/HEAD and direct nav).
 *        - `null`                  → allow (opaque origin — sandboxed iframe /
 *                                     privacy-redirect; matches "browser
 *                                     direct-nav/null" allowance).
 *        - present + host MATCHES  → allow (same-origin).
 *        - present + host MISMATCH → REJECT (cross-origin POST/PATCH).
 *
 * The fallback compares the `Origin` header's host against the request's own
 * host as seen at the public edge. Because the per-instance gateway sits behind
 * Caddy, the public host arrives in `X-Forwarded-Host` (preferred) or `Host`;
 * the raw `req.url` host is the loopback upstream and is NOT trusted for the
 * comparison.
 *
 * "Allow" here means "not a positively-detected cross-site request" — the guard
 * fails OPEN for ambiguous/absent signals so legitimate non-browser ingest and
 * direct navigation keep working, and fails CLOSED only when a browser tells us
 * (via Sec-Fetch-Site) or the Origin host tells us the request is cross-site.
 */

export type CsrfAllowReason =
  | 'sec-fetch-same-origin'
  | 'sec-fetch-same-site'
  | 'sec-fetch-none'
  | 'origin-match'
  | 'origin-null'
  | 'no-origin-no-sec-fetch'

export type CsrfRejectReason = 'sec-fetch-cross-site' | 'origin-mismatch'

export type CsrfDecision =
  | { allowed: true; reason: CsrfAllowReason }
  | { allowed: false; reason: CsrfRejectReason; detail: string }

const SEC_FETCH_SITE_HEADER = 'sec-fetch-site'
const ORIGIN_HEADER = 'origin'
const X_FORWARDED_HOST_HEADER = 'x-forwarded-host'
const HOST_HEADER = 'host'

/**
 * Evaluate whether `req` is a positively-detected cross-site request. Pure
 * predicate — no side effects, safe to call before any auth / body parse.
 */
export function evaluateCsrfOrigin(req: Request): CsrfDecision {
  // 1. Sec-Fetch-Site is the strongest signal — set by the browser, not
  //    reachable from page JS. When present it is authoritative.
  const secFetchSite = req.headers.get(SEC_FETCH_SITE_HEADER)
  if (secFetchSite !== null) {
    const value = secFetchSite.trim().toLowerCase()
    if (value === 'cross-site') {
      return {
        allowed: false,
        reason: 'sec-fetch-cross-site',
        detail: 'Sec-Fetch-Site: cross-site',
      }
    }
    if (value === 'same-origin') return { allowed: true, reason: 'sec-fetch-same-origin' }
    if (value === 'same-site') return { allowed: true, reason: 'sec-fetch-same-site' }
    if (value === 'none') return { allowed: true, reason: 'sec-fetch-none' }
    // Unknown Sec-Fetch-Site token — don't trust it as a positive
    // cross-site signal; fall through to the Origin check below.
  }

  // 2. Origin fallback for clients that don't send Sec-Fetch-Site.
  const origin = req.headers.get(ORIGIN_HEADER)
  if (origin === null) {
    // No Origin → not a positively cross-site request (same-origin GET/HEAD,
    // direct navigation, or a non-browser client).
    return { allowed: true, reason: 'no-origin-no-sec-fetch' }
  }
  if (origin === 'null') {
    // Opaque origin (sandboxed iframe / privacy redirect) — allowed per the
    // "browser direct-nav/null" allowance.
    return { allowed: true, reason: 'origin-null' }
  }

  const originHost = hostOf(origin)
  if (originHost === null) {
    // Unparseable Origin — treat as cross-site rather than silently allowing
    // a malformed value to bypass the check.
    return {
      allowed: false,
      reason: 'origin-mismatch',
      detail: `unparseable Origin: ${origin}`,
    }
  }

  const requestHost = resolveRequestHost(req)
  if (requestHost === null) {
    // We could not determine our own public host — fail open rather than
    // reject every request when proxy headers are misconfigured. Sec-Fetch
    // already covers modern browsers; this is the legacy-only path.
    return { allowed: true, reason: 'no-origin-no-sec-fetch' }
  }

  if (originHost === requestHost) {
    return { allowed: true, reason: 'origin-match' }
  }
  return {
    allowed: false,
    reason: 'origin-mismatch',
    detail: `Origin host ${originHost} != request host ${requestHost}`,
  }
}

/**
 * Standard 403 response for a rejected cross-site request. Shape matches the
 * upload handlers' `{ ok: false, error }` JSON contract.
 */
export function csrfForbiddenResponse(decision: {
  reason: CsrfRejectReason
  detail: string
}): Response {
  return Response.json(
    { ok: false, error: `cross-site request rejected (${decision.reason})` },
    { status: 403 },
  )
}

/**
 * Extract the lowercased `host` (host[:port]) from an absolute origin string
 * like `https://acme.example.com` or `http://localhost:7777`. Returns
 * null when the value is not a parseable absolute URL.
 */
function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Resolve the request's own public host as seen at the edge. Prefers
 * `X-Forwarded-Host` (set by Caddy on the per-instance gateway), falling back
 * to `Host`. `X-Forwarded-Host` may be a comma-separated list when chained
 * through multiple proxies — the FIRST entry is the original client-facing
 * host. Returns null when neither header is usable.
 */
function resolveRequestHost(req: Request): string | null {
  const forwarded = req.headers.get(X_FORWARDED_HOST_HEADER)
  if (forwarded !== null && forwarded.trim().length > 0) {
    const first = forwarded.split(',')[0]?.trim()
    if (first !== undefined && first.length > 0) return first.toLowerCase()
  }
  const host = req.headers.get(HOST_HEADER)
  if (host !== null && host.trim().length > 0) return host.trim().toLowerCase()
  return null
}
