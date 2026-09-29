/**
 * @neutronai/gateway/http — operator REPL-respawn surface (substrate-lift S2 § 2
 * row #13). Mounts the `admin-respawn-session` handler onto the per-instance
 * gateway as `POST /admin/respawn-session`.
 *
 * This is the live caller Argus r1 BLOCKING #2 flagged as missing: the handler +
 * the `respawnReplSession` actuation were built + tested but nothing routed to
 * them, so an operator had no way to clear `capped_at` on a hard-capped REPL.
 *
 * Same `disclaim-with-null` contract as the other app surfaces: returns `null`
 * for any path/method it doesn't own so the compose chain falls through. Auth
 * (constant-time `X-Gateway-Token`) + a small sliding-window rate limit live in
 * `handleAdminRespawnSessionRequest`.
 *
 * The `respawn` closure is injected so this surface stays decoupled from the
 * runtime module singleton — the boot shell wires it to
 * `respawnSupervisedSession(replRegistryPath, sessionKey)`.
 */

import {
  handleAdminRespawnSessionRequest,
  type AdminRespawnRateLimitConfig,
  type AdminRespawnRateState,
} from '@neutronai/runtime/adapters/claude-code/persistent/admin-respawn-session.ts'
import type { RespawnOutcome } from '@neutronai/runtime/adapters/claude-code/persistent/session-respawn.ts'

export interface AdminRespawnSurfaceInput {
  /** Expected operator token — request must present it in `X-Gateway-Token`. */
  gatewayToken: string
  /** Force-recover actuation. Boot wires `respawnSupervisedSession(path, key)`. */
  respawn: (sessionKey: string) => RespawnOutcome
  /** Explicit operator cap release; ordinary recovery remains a separate actor. */
  rearmCap?: (authorization: unknown) => Promise<boolean>
  /** Independent signature verification, before consuming any operator rate budget. */
  authorizeCapRearm?: (authorization: unknown) => boolean
  /** Override the default 5-req/60s rate limit. */
  rateLimit?: AdminRespawnRateLimitConfig
  /** DI clock (tests). */
  now?: () => number
}

export interface AdminRespawnSurface {
  /** Returns a `Response` for `POST /admin/respawn-session`, else `null`. */
  handler: (req: Request) => Promise<Response | null>
}

async function readCapAuthorization(req: Request): Promise<unknown> {
  const reader = req.body?.getReader()
  if (!reader) throw new Error('Missing authorization')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > 65_536) throw new Error('Authorization too large')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function createAdminRespawnSurface(input: AdminRespawnSurfaceInput): AdminRespawnSurface {
  // Per-surface rate-limit bucket: two instance gateways mounting this route in the
  // same process must not share a window (Codex P2).
  const rateState: AdminRespawnRateState = { hits: [] }
  return {
    handler: async (req: Request): Promise<Response | null> => {
      const url = new URL(req.url)
      if (url.pathname === '/admin/rearm-session-cap' && req.method === 'POST') {
        // Browser/owner credentials confer NO cap-release authority. The callback
        // must authenticate the independent operator signature before acting.
        let request: unknown
        try { request = await readCapAuthorization(req) } catch { return Response.json({ ok: false }, { status: 403 }) }
        if (input.authorizeCapRearm?.(request) !== true) return Response.json({ ok: false }, { status: 403 })
        const now = (input.now ?? Date.now)()
        const limit = input.rateLimit ?? { windowMs: 60_000, maxRequests: 5 }
        rateState.hits = rateState.hits.filter(t => now - t < limit.windowMs)
        if (rateState.hits.length >= limit.maxRequests) return Response.json({ ok: false }, { status: 429 })
        rateState.hits.push(now)
        try {
          const rearmed = await input.rearmCap?.(request) === true
          return Response.json({ ok: rearmed, status: rearmed ? 'rearmed' : 'refused' }, { status: rearmed ? 200 : 409 })
        } catch { return Response.json({ ok: false, status: 'refused' }, { status: 409 }) }
      }
      if (url.pathname !== '/admin/respawn-session') return null
      if (req.method !== 'POST') return null
      return handleAdminRespawnSessionRequest(req, {
        gatewayToken: input.gatewayToken,
        respawn: input.respawn,
        rateState,
        ...(input.rateLimit !== undefined ? { rateLimit: input.rateLimit } : {}),
        ...(input.now !== undefined ? { now: input.now } : {}),
      })
    },
  }
}
