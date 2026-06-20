/**
 * @neutronai/connect — the guest-bearer refresh handler (M2.6 Phase 5).
 *
 * `POST /connect/v1/connect/guest-refresh` — the item Ph3 explicitly
 * deferred here (guest-auth-handler.ts:44-48 "refresh UX is Ph5"). A guest
 * bearer is 30 min (`GUEST_BEARER_TTL_SECONDS`); a human conversation outlives
 * that. The single-use invite is CONSUMED at the first handshake, so refresh
 * CANNOT re-redeem it (brief § 3.2). Instead the guest presents its CURRENT
 * (still-valid) bearer and the connect node re-mints a fresh one for the SAME
 * identity.
 *
 * This handler runs AFTER `authorizeConnectRequest` — the existing
 * jwt-bearer-middleware validates the presented bearer (signature, audience,
 * exp) with NO middleware change (brief § 3.2). The handler then:
 *   1. resolves the member by FULL home identity (`buildResolveMember` discipline
 *      — the SAME `resolveActiveByHomeIdentity` the routing gate uses), and
 *      REFUSES (403) if the member is revoked / not active (brief § 3.3, § 5 #4),
 *   2. mints a fresh 30-min bearer with the existing `mintInstanceToken`, with
 *      the SAME `sub` + the SAME single membership the presented bearer carried,
 *      NO `role` claim (the role lives only on the stored row).
 *
 * SECURITY (brief § 5 #4): NO new authority, NO invite re-use, NO scope/role
 * widening. Refresh re-mints the SAME identity's bearer; it cannot change role or
 * scope (those live on the stored `connected_members` row, server-side). A
 * revoked member is refused regardless. This handler NEVER
 * touches `inviteStore.claimInTx` — re-redeeming a consumed invite is not even a
 * code path (brief test #7). Because the existing middleware enforces `exp`,
 * refresh requires a STILL-VALID bearer (refresh before expiry); the validator's
 * own clock tolerance is the only grace window — kept tight so a long-dead
 * bearer can't refresh forever (brief § 3.2).
 */

import {
  mintInstanceToken,
  type CrossInstanceActiveKey,
} from './api/mint-instance-token.ts'
import type { ConnectAuthContext } from './api/jwt-bearer-middleware.ts'
import { ConnectedMembersStore } from './connected-members-store.ts'
import { GUEST_BEARER_TTL_SECONDS } from './guest-auth-handler.ts'

export interface GuestRefreshHandlerDeps {
  store: ConnectedMembersStore
  /** The owner/connect instance slug — the re-minted bearer's audience target. */
  owner_slug: string
  /** The connect node's active signing key (the same KeyManager that mints
   *  the original guest bearer). */
  getActiveKey: () => Promise<CrossInstanceActiveKey>
  now?: () => number
}

/**
 * Build the `POST /connect/guest-refresh` handler. Returns a context-style
 * handler the cross-instance API server invokes AFTER the bearer middleware
 * authenticated the caller (so `ctx` carries the validated origin identity +
 * memberships).
 */
export function buildGuestRefreshHandler(
  deps: GuestRefreshHandlerDeps,
): (ctx: ConnectAuthContext) => Promise<Response> {
  const now = deps.now ?? ((): number => Date.now())

  return async (ctx: ConnectAuthContext): Promise<Response> => {
    // Resolve the member by the FULL home identity (origin instance slug + subject
    // user id) — the SAME anti-impersonation key the routing gate uses. A
    // revoked / unknown / never-accepted caller resolves to null → 403, so a
    // revoked guest cannot extend its access past its current bearer's natural
    // expiry (brief § 3.3).
    const member = deps.store.resolveActiveByHomeIdentity(
      ctx.origin_instance_slug,
      ctx.origin_user_id,
    )
    if (member === null) {
      return json(403, { error: 'member_not_active' })
    }

    // Re-mint with the SAME single membership the presented bearer carried + the
    // SAME sub. No role claim (the role lives only on the stored row); no scope
    // widening (scope lives on the stored row too). The membership the caller
    // declared (`origin_instance_slug`) is the one we re-mint, so refresh cannot
    // widen the bearer's reach.
    const membership = ctx.memberships.find((m) => m.slug === ctx.origin_instance_slug)
    const memberships =
      membership !== undefined
        ? [membership]
        : [{ slug: ctx.origin_instance_slug, role: 'member' as const, kind: 'user' as const }]

    let minted
    try {
      minted = await mintInstanceToken({
        getActiveKey: deps.getActiveKey,
        userId: ctx.origin_user_id,
        memberships,
        targetInstanceSlug: deps.owner_slug,
        now: now(),
        ttlSeconds: GUEST_BEARER_TTL_SECONDS,
      })
    } catch (err) {
      return json(503, {
        error: 'guest_mint_unavailable',
        message: err instanceof Error ? err.message : 'unknown',
      })
    }

    return json(200, {
      token: minted.token,
      audience: minted.audience,
      /** Same membership slug the bearer must keep stamping `/messages` with. */
      origin_instance_slug: ctx.origin_instance_slug,
      local_slug: member.local_slug,
      // Server-resolved from the stored row (never a token claim) — informational.
      role: member.role,
    })
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
