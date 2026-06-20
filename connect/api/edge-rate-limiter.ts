/**
 * @neutronai/connect/api — public-edge rate limiter (M2.6 Ph3, 3.11).
 *
 * The Ph3 public HTTPS ingress opens the connect node's `/connect/v1/*`
 * surface to anyone on the internet — an abuse surface the trusted (dial-out)
 * path never faced (callers there already held a Managed-issued JWT). This is a
 * thin, fail-closed, in-memory fixed-window limiter applied at the EDGE, BEFORE
 * `resolve_member` / the ChannelRouter ingress ever run (brief § 2.2, test #5):
 *
 *   - `/connect/guest-auth` (unauthenticated): keyed PER-IP (the client IP from
 *     the Caddy-set `X-Forwarded-For`). An unauthenticated flood is rejected
 *     before the invite store is even touched.
 *   - `POST /messages` (authenticated): keyed PER-CALLER (the JWT-authenticated
 *     subject), so a compromised guest bearer cannot flood the owner's session.
 *
 * Fixed-window (not token-bucket) on purpose: it is trivially correct, needs no
 * background timer, and the window edge is acceptable for an abuse floor (not a
 * fairness scheduler). State is per-process + bounded by a periodic sweep of
 * expired windows so a flood of distinct keys cannot grow the map unboundedly.
 *
 * This limiter is constructed ONLY on a connect node (where the public edge
 * exists). Non-connect workspace instances never wire it, so the trusted
 * workspace↔user fan-out path keeps its exact pre-Ph3 posture (brief § 2.2).
 */

export type RateLimitBucket =
  | 'guest-auth'
  | 'messages'
  | 'events'
  // M2.6 Ph5 — the public-edge invite-preview read (per-IP, like guest-auth) and
  // the authenticated guest-bearer refresh (per-caller, like messages).
  | 'invite-preview'
  | 'guest-refresh'

export interface EdgeRateLimiter {
  /**
   * Record a hit for `(bucket, key)` and return whether it is ALLOWED. Returns
   * `false` once the per-window cap is exceeded — callers reject at the edge
   * (429) without running any downstream work.
   */
  check(bucket: RateLimitBucket, key: string): boolean
}

export interface EdgeRateLimiterOptions {
  /** Window length in ms. */
  windowMs: number
  /**
   * Max allowed hits per key per window. A bare number applies one cap to every
   * bucket; a per-bucket map sets distinct caps (e.g. a strict per-IP cap on the
   * unauthenticated `guest-auth` edge + a generous per-caller cap on `messages`).
   * The map is PARTIAL — a bucket the caller did not configure is not limited
   * (treated as unlimited), so adding a new bucket never silently throttles a
   * caller that hasn't opted into capping it.
   */
  max: number | Partial<Record<RateLimitBucket, number>>
  /** Injectable clock (tests). */
  now?: () => number
}

interface WindowState {
  windowStart: number
  count: number
}

/**
 * Build a fixed-window edge limiter. Per (bucket,key): up to `max` hits per
 * `windowMs`; the (max+1)-th within a window returns `false`.
 */
export function createEdgeRateLimiter(
  opts: EdgeRateLimiterOptions,
): EdgeRateLimiter {
  const now = opts.now ?? ((): number => Date.now())
  const capFor = (bucket: RateLimitBucket): number =>
    typeof opts.max === 'number' ? opts.max : (opts.max[bucket] ?? Infinity)
  const windows = new Map<string, WindowState>()
  // Sweep expired windows opportunistically so a flood of unique keys (e.g. a
  // spray of distinct IPs at guest-auth) cannot grow the map without bound.
  let lastSweep = now()

  function sweep(t: number): void {
    if (t - lastSweep < opts.windowMs) return
    lastSweep = t
    for (const [k, w] of windows) {
      if (t - w.windowStart >= opts.windowMs) windows.delete(k)
    }
  }

  return {
    check(bucket, key): boolean {
      const t = now()
      sweep(t)
      const mapKey = `${bucket}\x00${key}`
      const w = windows.get(mapKey)
      if (w === undefined || t - w.windowStart >= opts.windowMs) {
        windows.set(mapKey, { windowStart: t, count: 1 })
        return capFor(bucket) >= 1
      }
      w.count += 1
      return w.count <= capFor(bucket)
    },
  }
}

/**
 * Extract the client IP for per-IP limiting at the public edge. The connect
 * node sits behind Caddy, which sets `X-Forwarded-For: <client>, <proxies...>`;
 * the FIRST entry is the originating client. Falls back to a constant bucket
 * when the header is absent (e.g. a direct-to-process test request) so the
 * limiter still fails closed rather than skipping entirely.
 */
export function clientIpFromRequest(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff !== null && xff.length > 0) {
    const first = xff.split(',')[0]?.trim()
    if (first !== undefined && first.length > 0) return first
  }
  const real = req.headers.get('x-real-ip')
  if (real !== null && real.length > 0) return real.trim()
  return 'unknown'
}
