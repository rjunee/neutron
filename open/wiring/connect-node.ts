/**
 * @neutronai/open/wiring — assemble this instance's Connect node (ISSUES #421).
 *
 * Connect shipped as seven independently-built, independently-tested leaf
 * handlers and NO production code that put them together. `runtime/connect-
 * handlers.ts` even declares the bundle shape they slot into and then states
 * "Open code never constructs these". This module constructs them — it is the
 * assembly that was missing, and it is the only one: Managed consumes the same
 * `connect_api` composition field through the same `gateway/composition.ts`
 * block, so there is exactly one code path.
 *
 * WHAT IT MOUNTS (all under `/connect/v1`, all behind the SURFACE STATE GATE in
 * `connect/surface-gate.ts` — inert until the owner issues their first invite):
 *
 *   GET  /health                  liveness + the receiving slug
 *   GET  /connect/invite-preview  public, read-only, NON-consuming invite look-up
 *   POST /connect/guest-auth      public single-use handshake → collaborator bearer
 *   POST /connect/guest-refresh   authenticated re-mint for the SAME active member
 *   POST /messages               authenticated inbound turn → the owner's session
 *   GET  /projects               authenticated thin project list for the caller
 *
 * `trusted_accept` is deliberately NOT mounted here. It exists for an invitee who
 * authenticates with a Managed cross-instance OAuth bearer against a central
 * identity service; a self-hosted install is its own sole authority and has no
 * such issuer to trust, so the route stays 404 rather than pretending to a trust
 * relationship this node cannot verify. The by-link handshake covers the guest.
 *
 * RATE LIMITS. Both unauthenticated endpoints are capped per real TCP peer, and
 * both authenticated ones per authenticated subject. The caps are deliberately
 * tighter than a hosted relay's: a self-hosted box is one person's collaboration
 * surface, not a shared meeting point, so nothing legitimate needs volume.
 */

import { buildGuestAuthHandler } from '@neutronai/connect/guest-auth-handler.ts'
import { buildGuestRefreshHandler } from '@neutronai/connect/guest-refresh-handler.ts'
import { buildInvitePreviewHandler } from '@neutronai/connect/invite-preview-handler.ts'
import { buildResolveMember } from '@neutronai/connect/member-join.ts'
import { ConnectedMembersStore } from '@neutronai/connect/connected-members-store.ts'
import { ConnectGuestInviteStore } from '@neutronai/connect/guest-invite-store.ts'
// `connect/api/*` is reached by DYNAMIC import only — the `connect-is-dynamic-only`
// rule in `.dependency-cruiser.cjs` forbids a static edge from outside `connect/`,
// so the federation edge stays off every module's static import graph. Types come
// from the structural aliases in `@neutronai/runtime/connect-handlers.ts` for the
// same reason.
import type { ProjectRef } from '@neutronai/runtime/connect-handlers.ts'
import type { ChannelRouter } from '@neutronai/channels/router.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

import type { ConnectNodeIdentity } from '../connect-node-identity.ts'

/** Fixed window for every edge bucket. */
const RATE_WINDOW_MS = 60_000

/**
 * Per-window caps. The unauthenticated buckets are the abuse floor for invite
 * guessing: an invite token is 256 bits, so 10/min/peer is not what stops a brute
 * force (the entropy is), but it does stop a single host turning the handshake
 * into a CPU/DB amplifier.
 */
const RATE_MAX = {
  'guest-auth': 10,
  'invite-preview': 30,
  messages: 120,
  'guest-refresh': 20,
} as const

export interface ConnectNodeWiringDeps {
  /** The owner's project DB — invites, members, inbound audit rows. */
  db: ProjectDb
  /** This instance's own slug; the bearer audience + the receiving slug. */
  owner_slug: string
  /** Owner-facing label used in the invite-preview data-locality disclosure. */
  owner_display: string
  /** The host a collaborator reaches this instance on, for the disclosure. */
  connect_host: string
  /** The live router inbound Connect turns are delivered into. */
  router: ChannelRouter
  /** This install's own Connect signing identity. */
  identity: ConnectNodeIdentity
  now?: () => number
}

/**
 * The `connect_api` composition value. Structurally the shape
 * `gateway/composition/input/connect-input.ts` declares; handed straight to
 * `composeProductionGraph`.
 */
export interface ConnectNodeWiring {
  auth: {
    jwks: ConnectNodeIdentity['jwks']
    receiving_instance_slug: string
  }
  handlers: Record<string, unknown>
  rate_limiter: unknown
  owner_db: ProjectDb
}

/**
 * Thin project list for an authenticated collaborator: the non-deleted projects
 * they are actually a member of, scoped by `project_members.origin_instance =
 * <their assigned local_slug>`. Membership is resolved SERVER-SIDE from the
 * caller's JWT home identity — a caller cannot name a project and be believed.
 */
function buildListProjects(deps: {
  db: ProjectDb
  store: ConnectedMembersStore
  owner_slug: string
}): (ctx: { origin_instance_slug: string; origin_user_id: string }) => Promise<ProjectRef[]> {
  return async (ctx): Promise<ProjectRef[]> => {
    const member = deps.store.resolveActiveByHomeIdentity(
      ctx.origin_instance_slug,
      ctx.origin_user_id,
    )
    if (member === null) return []
    const rows = deps.db
      .prepare<{ id: string; name: string }, [string]>(
        `SELECT p.id AS id, p.name AS name
           FROM projects p
           JOIN project_members pm ON pm.project_id = p.id
          WHERE pm.origin_instance = ? AND p.deleted_at IS NULL
          ORDER BY p.name ASC`,
      )
      .all(member.local_slug)
    return rows.map((r) => ({
      project_id: r.id,
      display_name: r.name,
      // A self-hosted instance hosts its owner's own projects; there is no
      // workspace tier here, so every shared project is `solo` and owned by
      // this instance.
      kind: 'solo' as const,
      owning_instance_slug: deps.owner_slug,
    }))
  }
}

/**
 * Build the Connect node for a single-owner instance. Pure assembly — every
 * component is the SAME one Managed composes; nothing here is Open-specific
 * except that the signing authority is the instance itself.
 */
export async function buildConnectNodeWiring(
  deps: ConnectNodeWiringDeps,
): Promise<ConnectNodeWiring> {
  const store = new ConnectedMembersStore(deps.db)
  const inviteStore = new ConnectGuestInviteStore(deps.db)
  const now = deps.now
  const [{ buildOnInboundMessageHandler }, { createEdgeRateLimiter }] = await Promise.all([
    import('@neutronai/connect/api/handlers/on-inbound-message.ts'),
    import('@neutronai/connect/api/edge-rate-limiter.ts'),
  ])

  const handlers = {
    // The single-use handshake: claim the invite + create the member + mint the
    // collaborator bearer, all against this node's own key.
    guest_auth: buildGuestAuthHandler({
      store,
      inviteStore,
      db: deps.db,
      owner_slug: deps.owner_slug,
      getActiveKey: deps.identity.getActiveKey,
      ...(now !== undefined ? { now } : {}),
    }),
    // Public, read-only, NON-consuming: renders the data-locality disclosure
    // before the guest commits. Never claims the invite.
    invite_preview: buildInvitePreviewHandler({
      inviteStore,
      db: deps.db,
      owner_display: deps.owner_display,
      connect_host: deps.connect_host,
      ...(now !== undefined ? { now } : {}),
    }),
    // Re-mint for the SAME active member; 403 once revoked, so revocation bites
    // within one bearer TTL rather than at the next restart.
    guest_refresh: buildGuestRefreshHandler({
      store,
      owner_slug: deps.owner_slug,
      getActiveKey: deps.identity.getActiveKey,
      ...(now !== undefined ? { now } : {}),
    }),
    // The gate that makes membership load-bearing: role + access + display are
    // read from the stored row, never from a token claim.
    resolve_member: buildResolveMember({ store }),
    // Inbound turn → audit row → the owner's live session.
    on_inbound_message: buildOnInboundMessageHandler({
      router: deps.router,
      db: deps.db,
      receiving_instance_slug: deps.owner_slug,
      ...(now !== undefined ? { now } : {}),
    }),
    list_projects: buildListProjects({ db: deps.db, store, owner_slug: deps.owner_slug }),
  }

  return {
    auth: {
      // This instance's OWN key set — a bearer signed by anyone else fails here.
      jwks: deps.identity.jwks,
      receiving_instance_slug: deps.owner_slug,
    },
    handlers,
    rate_limiter: createEdgeRateLimiter({
      windowMs: RATE_WINDOW_MS,
      max: { ...RATE_MAX },
      ...(now !== undefined ? { now } : {}),
    }),
    owner_db: deps.db,
  }
}
