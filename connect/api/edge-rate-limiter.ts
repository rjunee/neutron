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
 * True when `ip` is a loopback / link-local / RFC-1918 address — i.e. a peer that
 * could plausibly be a reverse proxy sharing the host or the local network,
 * rather than a client dialling in off the internet.
 */
export function isLocalPeerAddress(ip: string): boolean {
  const a = ip.trim().toLowerCase()
  if (a.length === 0) return false
  // IPv6 loopback / link-local / unique-local, and IPv4-mapped forms of the same.
  if (a === '::1' || a === '::' || a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd')) {
    return true
  }
  const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a
  const parts = v4.split('.')
  if (parts.length !== 4) return false
  const [o1, o2] = [Number(parts[0]), Number(parts[1])]
  if (!Number.isInteger(o1) || !Number.isInteger(o2)) return false
  if (o1 === 127) return true // loopback
  if (o1 === 10) return true // RFC 1918
  if (o1 === 192 && o2 === 168) return true // RFC 1918
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true // RFC 1918
  if (o1 === 169 && o2 === 254) return true // link-local
  return false
}

/**
 * Extract the client IP for per-IP limiting at the public edge.
 *
 * ISSUES #421 — THE HEADER IS NOT TRUSTED BY DEFAULT ANY MORE. This function
 * used to read `X-Forwarded-For` unconditionally, on the documented assumption
 * that "the connect node sits behind Caddy, which sets X-Forwarded-For". That
 * assumption held on a hosted box behind a known edge and is FALSE for a
 * self-hosted Neutron on a home network with a port forwarded straight at the
 * process: there, `X-Forwarded-For` is fully attacker-controlled, so the caller
 * gets a fresh rate-limit window per request simply by varying the header, and
 * the per-IP cap on the two UNAUTHENTICATED endpoints (`/connect/guest-auth`,
 * `/connect/invite-preview`) evaporates. Now that Connect is served from every
 * install and not only from behind Caddy, that had to change shape too.
 *
 * The rule, which needs no configuration and no flag:
 *
 *   - `socketIp` (the real TCP peer, from `Bun.Server.requestIP`) is
 *     AUTHORITATIVE whenever the peer is NOT local. A direct internet client
 *     cannot forge its own source address on an established TCP connection, so
 *     its headers are ignored outright.
 *   - Only when the peer IS loopback / RFC-1918 / link-local — i.e. plausibly a
 *     reverse proxy on the same host or LAN, which is exactly the Managed Caddy
 *     deployment — is `X-Forwarded-For` honoured, preserving that posture
 *     unchanged.
 *   - With no socket address available at all (a direct-to-handler call), the
 *     legacy header order applies and finally a constant bucket, so the limiter
 *     still counts rather than skipping.
 */
export function clientIpFromRequest(req: Request, socketIp?: string | null): string {
  const peer = socketIp?.trim() ?? ''
  if (peer.length > 0 && !isLocalPeerAddress(peer)) {
    return peer
  }
  const xff = req.headers.get('x-forwarded-for')
  if (xff !== null && xff.length > 0) {
    const first = xff.split(',')[0]?.trim()
    if (first !== undefined && first.length > 0) return first
  }
  const real = req.headers.get('x-real-ip')
  if (real !== null && real.length > 0) return real.trim()
  if (peer.length > 0) return peer
  return 'unknown'
}
