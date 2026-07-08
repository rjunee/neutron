/**
 * @neutronai/connect — the Managed-OAuth collaborator accept handler (the
 * cross-instance, bearer-authenticated accept mechanism; M2.6 Phase 5). Closes
 * the dangling `acceptTrustedMember` (zero production callers before Ph5) by
 * wiring the route a Managed invitee on a DIFFERENT instance hits to join an
 * owner's connect project (brief § 2.3, component 1.4). The OAuth-bearer path is
 * one of the two collaborator auth mechanisms (the other is the self-hosted token
 * handshake); both land the same `role='collaborator'` — neither is a tier.
 *
 * `POST /connect/v1/connect/trusted-accept` — runs AFTER
 * `authorizeConnectRequest`, so the presented cross-instance bearer IS the
 * M2.5 OAuth gate: the invitee on another instance obtained it via the M2.5
 * cross-instance handoff (identity/oauth/cross-instance-handoff.ts →
 * gateway/cross-instance/federated-token-store.ts), and the bearer's
 * `aud = connect.<owner_slug>` proves it was minted for THIS meeting point.
 * `ctx.origin_instance_slug` / `ctx.origin_user_id` are the invitee's authenticated
 * cross-instance identity (brief test #4: "the M2.5 cross-instance token gate was
 * exercised for the cross-instance case").
 *
 * Flow:
 *   1. verify the connect invite JWT (the M2.4 `issueInviteToken` primitive,
 *      extended at issuance with the connect-project target) — signature,
 *      audience, expiry, project_id.
 *   2. atomically CLAIM the single-use invite row on the owner's DB (the same
 *      `claimInviteToken` the same-authority M2.4 accept uses — single-use is
 *      preserved; a replay 409s).
 *   3. call `acceptTrustedMember` with the invitee's AUTHENTICATED cross-instance
 *      identity (home_instance_slug + home_user_id from the bearer, NEVER a body
 *      field) → records the `connected_members` role='collaborator' row +
 *      the `project_members.origin_instance` row.
 *
 * SECURITY (brief § 5):
 *   - The cross-instance bearer (the M2.5 gate) IS the identity binding for a
 *     cross-instance invitee — the invitee's home identity is server-resolved
 *     from the validated JWT, never a request field. (The M2.4 email-hash
 *     binding is an inviter-side audit field carried on the invite; the accept
 *     gate for a cross-instance member is the authenticated cross-instance bearer,
 *     which the email-bound link alone cannot satisfy — brief § 2.3.)
 *   - `role` is fixed 'collaborator' by `acceptTrustedMember`, server-side; a
 *     body field cannot assert it.
 *   - Single-use + atomic: the invite is claimed before the member write; a
 *     replayed accept 409s.
 *   - NO new persistence path — granting trusted scope ≠ writing memory; the
 *     Ph4 persister behind `assertPersistable` still gates every GBrain write.
 */

import type { KeyLike } from 'jose'
import type { ProjectDb } from '../persistence/index.ts'
import type { ConnectAuthContext } from './api/jwt-bearer-middleware.ts'
import {
  verifyInviteToken,
  claimInviteToken,
  InviteTokenError,
} from './invite-token.ts'
import { ConnectedMembersStore, type Access } from './connected-members-store.ts'
import {
  acceptTrustedMember,
  type RegisterMembershipFn,
  type MirrorMemoryOnJoinFn,
} from './member-join.ts'

/** Free-text display-name cap (mirrors the guest handshake's abuse floor). */
const MAX_DISPLAY_NAME_LEN = 80

export interface TrustedAcceptHandlerDeps {
  store: ConnectedMembersStore
  /** The owner's project DB — the invite row + the member rows live here. */
  db: ProjectDb
  /** The owner/connect instance slug (the receiving meeting point). */
  owner_slug: string
  /** Resolves the public key for the invite JWT's kid (the owner's JWKS). */
  resolveKey: (kid: string) => Promise<KeyLike | null>
  /** Optional M2.5 membership-registration seam (LIFT). */
  registerMembership?: RegisterMembershipFn
  /** LIFT: the §1.8 import-on-join memory-mirror seam (connect-spec §1.8 + §2.4).
   *  Optional + threaded straight through to `acceptTrustedMember`. NOT supplied
   *  by the production composer yet — see the seam's PRODUCTION WIRING STATE note
   *  in `member-join.ts` (distributed activation is gated on the HTTP host-snapshot
   *  transport + per-project GBrain scoping). */
  mirrorMemoryOnJoin?: MirrorMemoryOnJoinFn
  now?: () => number
}

interface TrustedAcceptBody {
  invite_token: string
  /** Optional human label; falls back to the authenticated origin slug. */
  display_name?: string
}

/**
 * Build the `POST /connect/trusted-accept` handler. Returns a context-style
 * handler the cross-instance API server invokes AFTER the bearer middleware
 * authenticated the caller.
 */
export function buildTrustedAcceptHandler(
  deps: TrustedAcceptHandlerDeps,
): (ctx: ConnectAuthContext, req: Request) => Promise<Response> {
  const now = deps.now ?? ((): number => Date.now())

  return async (ctx: ConnectAuthContext, req: Request): Promise<Response> => {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return json(400, { error: 'invalid_json' })
    }
    const parsed = parseBody(body)
    if (parsed === null) {
      return json(400, { error: 'invalid_trusted_accept_request' })
    }

    // 1. Verify the connect invite JWT (signature, audience, expiry, claims).
    let claims
    try {
      claims = await verifyInviteToken({
        token: parsed.invite_token,
        resolveKey: deps.resolveKey,
        now,
      })
    } catch (err) {
      return json(err instanceof InviteTokenError ? statusForInvite(err.code) : 400, {
        error: 'invite_refused',
        reason: err instanceof InviteTokenError ? err.code : 'malformed',
      })
    }

    // 2. Atomically claim the single-use invite row (preserved single-use; a
    // replay 409s) BEFORE any member write.
    try {
      await claimInviteToken({ jti: claims.jti, inviter_db: deps.db, now })
    } catch (err) {
      return json(err instanceof InviteTokenError ? statusForInvite(err.code) : 500, {
        error: 'invite_refused',
        reason: err instanceof InviteTokenError ? err.code : 'claim_failed',
      })
    }

    // 3. Accept the collaborator with the AUTHENTICATED cross-instance identity
    // (from the validated bearer — never a body field). role is fixed
    // 'collaborator' server-side by acceptTrustedMember.
    let result
    try {
      result = await acceptTrustedMember(
        {
          display_name: parsed.display_name ?? ctx.origin_instance_slug,
          home_instance_slug: ctx.origin_instance_slug,
          home_user_id: ctx.origin_user_id,
          project_id: claims.project_id,
          receiving_instance_slug: deps.owner_slug,
          // The owner-chosen access grant rides the invite (the locked lever); a
          // `read` collaborator cannot post (connect-spec §1.4). Anything that is
          // not an explicit `read` claim (incl. the dropped legacy 'admin' and an
          // absent claim) collapses to the collaborator default 'write'.
          access: (claims.access === 'read' ? 'read' : 'write') as Access,
        },
        {
          store: deps.store,
          db: deps.db,
          ...(deps.registerMembership !== undefined
            ? { registerMembership: deps.registerMembership }
            : {}),
          ...(deps.mirrorMemoryOnJoin !== undefined
            ? { mirrorMemoryOnJoin: deps.mirrorMemoryOnJoin }
            : {}),
          now,
        },
      )
    } catch (err) {
      return json(500, {
        error: 'trusted_accept_failed',
        message: err instanceof Error ? err.message : 'unknown',
      })
    }

    return json(200, {
      local_slug: result.member.local_slug,
      role: result.member.role,
      project_id: claims.project_id,
      reused: result.reused,
    })
  }
}

function parseBody(body: unknown): TrustedAcceptBody | null {
  if (body === null || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const invite_token = b['invite_token']
  if (typeof invite_token !== 'string' || invite_token.length === 0) return null
  const display_name = b['display_name']
  if (display_name !== undefined) {
    if (
      typeof display_name !== 'string' ||
      display_name.trim().length === 0 ||
      display_name.length > MAX_DISPLAY_NAME_LEN
    ) {
      return null
    }
    return { invite_token, display_name: display_name.trim() }
  }
  return { invite_token }
}

function statusForInvite(code: InviteTokenError['code']): number {
  switch (code) {
    case 'expired':
      return 410
    case 'consumed':
      return 409
    case 'not_found':
      return 404
    case 'invalid_signature':
    case 'wrong_audience':
      return 401
    default:
      return 400
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
