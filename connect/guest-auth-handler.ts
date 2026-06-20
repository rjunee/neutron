/**
 * @neutronai/connect — the public guest-auth handshake handler (M2.6 Ph3).
 *
 * `POST /connect/v1/connect/guest-auth` — the ONLY pre-authenticated
 * endpoint on the connect node's public edge (brief § 2.1, § 3.1, 3.7). An OSS
 * self-hosted guest (no Managed OAuth account) presents a single-use owner
 * invite + a self-asserted display_name + handle; the connect node (the SOLE
 * guest authority — research § 8 #3):
 *   1. atomically claims the invite (single-use — a replay 409s) AND runs
 *      `acceptGuestMember` (records the connected_members row role='collaborator'
 *      + the project_members row, slug allocated INSIDE the tx), then
 *   2. mints a guest bearer with the node's EXISTING cross-instance minter
 *      (aud=connect.<owner_slug>, a single project membership, sub = the
 *      connect-assigned guest subject) — validated by the EXISTING
 *      jwt-bearer-middleware with NO middleware change (brief § 0.2, test #2).
 *
 * The guest caches the bearer and from then on is indistinguishable at the
 * transport layer from a trusted member: it POSTs the SAME `/messages`, the SAME
 * middleware validates it, the SAME `resolve_member` maps it → its local_slug.
 * Ph3 adds NO second routing path (brief § 0.1).
 *
 * SECURITY: role is fixed 'collaborator' server-side here; the caller never gets
 * a say. The bearer carries NO role claim — the resolver reads the role from the
 * stored row, never the token (brief § 3.4 invariant 1). The handshake mints ONLY
 * against an atomically-claimed valid invite (no self-mint / replay / widening —
 * invariant 3).
 */

import {
  mintInstanceToken,
  type CrossInstanceActiveKey,
} from './api/mint-instance-token.ts'
import type { Membership } from '../jwt-validator/index.ts'
import type { ProjectDb } from '../persistence/index.ts'
import { ConnectedMembersStore } from './connected-members-store.ts'
import { ConnectGuestInviteStore, GuestInviteError } from './guest-invite-store.ts'
import { acceptGuestMember, type MirrorMemoryOnJoinFn } from './member-join.ts'

/** Caps on self-asserted free-text fields (abuse floor; the slug assigner +
 *  origin-tag grammar already bound what actually routes). */
const MAX_DISPLAY_NAME_LEN = 80
const MAX_GUEST_HANDLE_LEN = 253 // a DNS name ceiling — handles are domain-shaped

/** Guest bearer TTL. Short like every cross-instance token; the guest refreshes by
 *  re-presenting nothing — Ph3 ships a single handshake, refresh UX is Ph5. We
 *  give guests a slightly longer window than the 5-min fan-out token so a human
 *  conversation isn't interrupted mid-turn. */
export const GUEST_BEARER_TTL_SECONDS = 30 * 60

export interface GuestAuthHandlerDeps {
  store: ConnectedMembersStore
  inviteStore: ConnectGuestInviteStore
  db: ProjectDb
  /** The owner/connect instance slug — the minted bearer's audience target. */
  owner_slug: string
  /** The connect node's active signing key (the same KeyManager that mints
   *  cross-instance bearers). The guest bearer is signed by it; its public half is
   *  in the JWKS the existing middleware already trusts. */
  getActiveKey: () => Promise<CrossInstanceActiveKey>
  /** LIFT: the §1.8 import-on-join memory-mirror seam (connect-spec §1.8 + §2.4).
   *  Optional + threaded straight through to `acceptGuestMember` so the mounted
   *  guest-auth path can trigger the snapshot import without coupling the handler
   *  to GBrain. NOT supplied by the production composer yet — see the seam's
   *  PRODUCTION WIRING STATE note in `member-join.ts` (distributed activation is
   *  gated on the HTTP host-snapshot transport + per-project GBrain scoping). */
  mirrorMemoryOnJoin?: MirrorMemoryOnJoinFn
  now?: () => number
}

interface GuestAuthRequestBody {
  invite_token: string
  display_name: string
  guest_handle: string
}

/**
 * Build the `POST /connect/guest-auth` handler. Returns a fetch-style handler
 * the cross-instance API server mounts on the public (pre-auth) edge.
 */
export function buildGuestAuthHandler(
  deps: GuestAuthHandlerDeps,
): (req: Request) => Promise<Response> {
  const now = deps.now ?? ((): number => Date.now())

  return async (req: Request): Promise<Response> => {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return json(400, { error: 'invalid_json' })
    }
    const parsed = parseBody(body)
    if (parsed === null) {
      return json(400, { error: 'invalid_guest_auth_request' })
    }

    let accepted: Awaited<ReturnType<typeof acceptGuestMember>>
    try {
      accepted = await acceptGuestMember(
        {
          invite_token: parsed.invite_token,
          display_name: parsed.display_name,
          guest_handle: parsed.guest_handle,
        },
        {
          store: deps.store,
          inviteStore: deps.inviteStore,
          db: deps.db,
          ...(deps.mirrorMemoryOnJoin !== undefined
            ? { mirrorMemoryOnJoin: deps.mirrorMemoryOnJoin }
            : {}),
          now,
        },
      )
    } catch (err) {
      if (err instanceof GuestInviteError) {
        return json(statusForRefusal(err.reason), {
          error: 'invite_refused',
          reason: err.reason,
        })
      }
      return json(500, {
        error: 'guest_accept_failed',
        message: err instanceof Error ? err.message : 'unknown',
      })
    }

    // Mint the collaborator bearer. SINGLE membership (the owner's project origin
    // slug), sub = the connect-assigned subject, aud = connect.<owner_slug>.
    // NO role claim — the role lives only on the stored row.
    const membership: Membership = {
      slug: accepted.origin_slug,
      role: 'member',
      kind: 'user',
    }
    let minted
    try {
      minted = await mintInstanceToken({
        getActiveKey: deps.getActiveKey,
        userId: accepted.guest_user_id,
        memberships: [membership],
        targetInstanceSlug: deps.owner_slug,
        now: now(),
        ttlSeconds: GUEST_BEARER_TTL_SECONDS,
      })
    } catch (err) {
      // The member row is already committed; the guest can re-handshake with a
      // fresh invite. We surface the mint failure rather than leaving the caller
      // with a silent 500-less hang.
      return json(503, {
        error: 'guest_mint_unavailable',
        message: err instanceof Error ? err.message : 'unknown',
      })
    }

    return json(200, {
      token: minted.token,
      audience: minted.audience,
      /** The collaborator MUST stamp its `/messages` body `origin_instance` with
       *  this (== the bearer's single membership slug); resolve_member then
       *  re-stamps the routed turn with the assigned local_slug. */
      origin_instance_slug: accepted.origin_slug,
      local_slug: accepted.member.local_slug,
      role: accepted.member.role,
      project_id: accepted.project_id,
    })
  }
}

function parseBody(body: unknown): GuestAuthRequestBody | null {
  if (body === null || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const invite_token = b['invite_token']
  const display_name = b['display_name']
  const guest_handle = b['guest_handle']
  if (
    typeof invite_token !== 'string' ||
    invite_token.length === 0 ||
    typeof display_name !== 'string' ||
    display_name.trim().length === 0 ||
    display_name.length > MAX_DISPLAY_NAME_LEN ||
    typeof guest_handle !== 'string' ||
    guest_handle.trim().length === 0 ||
    guest_handle.length > MAX_GUEST_HANDLE_LEN
  ) {
    return null
  }
  return {
    invite_token,
    display_name: display_name.trim(),
    guest_handle: guest_handle.trim(),
  }
}

function statusForRefusal(reason: GuestInviteError['reason']): number {
  switch (reason) {
    case 'not_found':
      return 404
    case 'expired':
      return 410
    case 'already_redeemed':
      return 409
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
