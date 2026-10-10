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
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

export interface AdminRespawnSurfaceInput {
  prepareNativeParentTermination?: (request: unknown) => Promise<{ status: 'prepared' | 'refused' }>
  consumeNativeParentTermination?: (request: unknown) => Promise<{ status: 'released' | 'already-retired' | 'refused' }>
  retirePlannerAuthority?: (request: unknown) => Promise<{ status: 'released' | 'already-retired' | 'refused' }>
  preparePlannerConversationQuarantine?: (request: unknown) => Promise<{ status: 'prepared' | 'refused' }>

  reconcileTerminatedChat?: (request: unknown) => Promise<{ status: 'reconciled' } | { status: 'refused'; reason: string }>
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

async function readCapAuthorization(req: Request, maxBytes = 65_536): Promise<unknown> {
  const reader = req.body?.getReader()
  if (!reader) throw new Error('Missing authorization')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maxBytes) throw new Error('Authorization too large')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { fireAndForget('admin-respawn-surface.cancel-authorization-reader', reader.cancel()); reader.releaseLock() }
}

export function createAdminRespawnSurface(input: AdminRespawnSurfaceInput): AdminRespawnSurface {
  // Per-surface rate-limit bucket: two instance gateways mounting this route in the
  // same process must not share a window (Codex P2).
  const rateState: AdminRespawnRateState = { hits: [] }
  const recoveryRoutes: Record<string, ((request: unknown) => Promise<{ status: string }>) | undefined> = {
    '/admin/retire-planner-authority': input.retirePlannerAuthority,
    '/admin/prepare-planner-conversation-quarantine': input.preparePlannerConversationQuarantine,
    '/admin/prepare-native-parent-termination': input.prepareNativeParentTermination,
    '/admin/consume-native-parent-termination': input.consumeNativeParentTermination,
  }
  return {
    handler: async (req: Request): Promise<Response | null> => {
      const url = new URL(req.url)
      if (Object.hasOwn(recoveryRoutes, url.pathname) && req.method === 'POST') {
        // The owner token gates this surface; the consumer independently verifies
        // the pinned operator signature and exact workflow authority.
        const supplied = Buffer.from(req.headers.get('X-Gateway-Token') ?? '')
        const expected = Buffer.from(input.gatewayToken)
        const { timingSafeEqual } = await import('node:crypto')
        if (!supplied.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return Response.json({ status: 'refused' }, { status: 403 })
        const now = (input.now ?? Date.now)()
        const limit = input.rateLimit ?? { windowMs: 60_000, maxRequests: 5 }
        rateState.hits = rateState.hits.filter(t => now - t < limit.windowMs)
        if (rateState.hits.length >= limit.maxRequests) return Response.json({ status: 'refused' }, { status: 429 })
        rateState.hits.push(now)
        try {
          const callback = recoveryRoutes[url.pathname]
          const result = await callback?.(await readCapAuthorization(req)) ?? { status: 'refused' }
          return Response.json(result, { status: result.status === 'refused' ? 409 : 200 })
        } catch { return Response.json({ status: 'refused' }, { status: 409 }) }
      }
      if (url.pathname === '/admin/reconcile-host-terminated-chat' && req.method === 'POST') {
        // The installed owner authenticates the request. Independently signed
        // host evidence, current scope admission, and exact identity are checked
        // by composition; the bearer alone never licenses reconciliation.
        const supplied = req.headers.get('X-Gateway-Token') ?? ''
        const { timingSafeEqual } = await import('node:crypto')
        const a = Buffer.from(supplied), b = Buffer.from(input.gatewayToken)
        if (!a.length || a.length !== b.length || !timingSafeEqual(a, b)) return Response.json({ ok: false }, { status: 403 })
        const now = (input.now ?? Date.now)()
        const limit = input.rateLimit ?? { windowMs: 60_000, maxRequests: 5 }
        rateState.hits = rateState.hits.filter(t => now - t < limit.windowMs)
        if (rateState.hits.length >= limit.maxRequests) return Response.json({ ok: false }, { status: 429 })
        rateState.hits.push(now)
        try {
          // A historical registry contains all conversations, unlike the small
          // cap authorization. Bound its supplied preimage without opening paths.
          const result = await input.reconcileTerminatedChat?.(await readCapAuthorization(req, 4 * 1024 * 1024))
            ?? { status: 'refused', reason: 'reconciliation unavailable' }
          return Response.json(result, { status: result.status === 'reconciled' ? 200 : 409 })
        } catch { return Response.json({ status: 'refused', reason: 'invalid reconciliation request' }, { status: 409 }) }
      }
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
