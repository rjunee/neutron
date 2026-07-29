/**
 * admin-respawn-session.ts — operator force-recover endpoint for a wedged REPL
 * (substrate-lift S2 § 2 row #13, ◆ ADAPTED-AT-BOUNDARY).
 *
 * LIFTED from Nova `gateway/admin-respawn-topic.ts`. The param adapts
 * `?name=<topic>` → `?session=<sessionKey>`; the route is
 * `POST /admin/respawn-session`. It routes into the guarded `respawnReplSession`
 * actuation with `force=true`, which clears any `capped_at` so the operator can
 * release a hard-capped REPL the auto-watchdog has stopped retrying (the Nova
 * "stuck-turn cap-hit" release semantic).
 *
 * Split into a pure param-handler (`handleAdminRespawnSession`) that's trivially
 * unit-testable, plus a Bun `Request → Response` adapter
 * (`handleAdminRespawnSessionRequest`) that the per-instance gateway listener
 * mounts. Auth is a constant-time `X-Gateway-Token` compare (`timingSafeEqual`,
 * length-checked); a small per-window rate limit blocks accidental respawn storms.
 */

import type { RespawnOutcome } from './session-respawn.ts'
import { constantTimeEqual } from '../../../constant-time-equal.ts'

/** Constant-time token compare (length-checked) for the privileged operator
 *  endpoint — this route force-respawns + clears caps, so a `!==` compare leaking
 *  the token via timing is a real regression (Codex P2). The length pre-check
 *  leaks only the token LENGTH (standard for `timingSafeEqual`, which requires
 *  equal-length buffers). */
function tokensMatch(provided: string | null, expected: string): boolean {
  if (provided === null) return false
  return constantTimeEqual(provided, expected)
}

export interface AdminRespawnResult {
  status: number
  body: Record<string, unknown>
}

export interface AdminRespawnDeps {
  /** Actuate the (forced) respawn. Wraps `respawnReplSession(opts, key, ...,
   *  force=true)` in production. */
  respawn: (sessionKey: string) => RespawnOutcome
}

/** Map a respawn outcome to an HTTP-shaped result. Pure. */
export function handleAdminRespawnSession(
  sessionKey: string | undefined,
  deps: AdminRespawnDeps,
): AdminRespawnResult {
  if (!sessionKey || !sessionKey.trim()) {
    return { status: 400, body: { ok: false, error: 'invalid-session-key' } }
  }
  const outcome = deps.respawn(sessionKey.trim())
  if (outcome.ok) {
    return {
      status: 202,
      body: {
        ok: true,
        session_key: outcome.sessionKey ?? sessionKey,
        session_id: outcome.sessionId,
        status: 'respawn-initiated',
      },
    }
  }
  switch (outcome.reason) {
    case 'session-not-found':
      return { status: 404, body: { ok: false, error: 'session-not-found' } }
    case 'no-session-to-resume':
      return { status: 409, body: { ok: false, error: 'no-session-to-resume' } }
    case 'invalid-session-key':
      return { status: 400, body: { ok: false, error: 'invalid-session-key' } }
    case 'spawn-cwd-invalid':
      return { status: 502, body: { ok: false, error: 'spawn-cwd-invalid' } }
    default:
      return { status: 500, body: { ok: false, error: outcome.reason ?? 'spawn-failed' } }
  }
}

export interface AdminRespawnRateLimitConfig {
  windowMs: number
  maxRequests: number
}

/** Mutable sliding-window rate-limit bucket. One per mounted surface so two
 *  instance gateways sharing a process don't share a rate-limit window. */
export interface AdminRespawnRateState {
  hits: number[]
}

export interface AdminRespawnRequestDeps extends AdminRespawnDeps {
  /** The expected operator token. Request must present it in `X-Gateway-Token`. */
  gatewayToken: string
  /** Rate-limit config. Default 5 requests / 60s. */
  rateLimit?: AdminRespawnRateLimitConfig
  /** Per-surface rate-limit bucket. When omitted, falls back to the shared
   *  module-level bucket (the single-instance-per-process default + the unit-test
   *  path that `resetAdminRespawnRateLimitForTest` clears). `createAdminRespawnSurface`
   *  allocates a fresh bucket per mount so multiple single-process gateways
   *  stay isolated (Codex P2). */
  rateState?: AdminRespawnRateState
  /** DI clock. */
  now?: () => number
}

/** Shared fallback sliding-window rate-limit state (single-instance-per-process +
 *  unit tests). Per-surface mounts pass their own bucket via `deps.rateState`. */
const rateState: AdminRespawnRateState = { hits: [] }

/** Bun `Request → Response` adapter. Auth (X-Gateway-Token) → rate-limit →
 *  resolve `session` (query or JSON body) → `respawn(force)`. */
export async function handleAdminRespawnSessionRequest(
  req: Request,
  deps: AdminRespawnRequestDeps,
): Promise<Response> {
  const token = req.headers.get('X-Gateway-Token')
  if (!tokensMatch(token, deps.gatewayToken)) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 })
  }
  const now = (deps.now ?? Date.now)()
  const rl = deps.rateLimit ?? { windowMs: 60_000, maxRequests: 5 }
  const rs = deps.rateState ?? rateState
  rs.hits = rs.hits.filter((t) => now - t < rl.windowMs)
  if (rs.hits.length >= rl.maxRequests) {
    return Response.json({ ok: false, error: 'rate-limited' }, { status: 429 })
  }
  rs.hits.push(now)

  let sessionKey: string | undefined
  const url = new URL(req.url)
  sessionKey = url.searchParams.get('session') ?? undefined
  if (!sessionKey && req.method === 'POST') {
    try {
      const body = (await req.json()) as { session?: string }
      if (typeof body.session === 'string') sessionKey = body.session
    } catch {
      /* no/invalid body — fall through to the 400 below */
    }
  }

  const result = handleAdminRespawnSession(sessionKey, deps)
  return Response.json(result.body, { status: result.status })
}

/** Test helper: clear the module-level rate-limit window. */
export function resetAdminRespawnRateLimitForTest(): void {
  rateState.hits = []
}
