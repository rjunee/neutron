/**
 * @neutronai/gateway/http — owner-side Neutron Connect invite issuance.
 *
 * Backs `POST /api/app/projects/<id>/connect-invites` — the owner/admin taps
 * "Invite a collaborator" in the app and this mints a shareable accept link for a
 * cross-org collaborator. There is ONE collaborator concept; what the owner picks
 * is a DELIVERY METHOD, never a tier (brief: connect-trust-class-collapse). Both
 * deliveries land the SAME `role='collaborator'` member — the difference is only
 * how the invitee authenticates:
 *
 *   - `link`  — a single-use, project-scoped, hashed, expiring invite. Works for
 *               ANYONE (a Neutron Open self-hoster with no Managed account, or a
 *               Managed user who just wants a link). Wraps
 *               `ConnectGuestInviteStore.issue`; the RAW token is returned exactly
 *               ONCE as an accept URL `https://connect.<domain>/connect/accept#<token>`
 *               (unrecoverable after issue — the store persists hash-only). The
 *               invitee authenticates via the connect-node token handshake.
 *   - `email` — binds the invite to an email so a Managed invitee on a DIFFERENT
 *               instance can OAuth-auto-accept. Extends the M2.4 `issueInviteToken`
 *               path with the connect-project target + the owner-chosen scope,
 *               returning `https://connect.<domain>/invite?invite=<token>`. The
 *               invitee authenticates via the M2.5 cross-instance OAuth bearer.
 *
 * `scope` ∈ `write`|`read` flows into `access` on the eventual member row — the
 * post-boundary lever (connect-spec §1.4: a `read` member cannot post). The owner
 * picks it at invite time, INDEPENDENT of delivery. **Owner-only at launch** (§ 11 LOCK):
 * the route is owner/admin-gated via the resolved context's role (defense-in-depth
 * re-checked here, single-sourced through `canInviteRole`).
 *
 * Pure handler over a `resolveContext` seam — the same shape as
 * `app-project-invite.ts`. The production composition (authz + owner DB +
 * signing key + connect base URL) is wired in `gateway/index.ts`; tests inject a
 * synthetic context.
 */

import {
  issueInviteToken,
  type InviteSigningKey,
} from '../../onboarding/api/invite-link-generate.ts'
import { canInviteRole } from './app-project-invite.ts'
import { ConnectGuestInviteStore } from '../../connect/guest-invite-store.ts'
import type { ProjectDb } from '../../persistence/index.ts'

/** How the owner delivers the collaborator invite. A DELIVERY METHOD, not a
 *  trust tier — both land the same `role='collaborator'`. `link` works for
 *  anyone (token handshake); `email` enables OAuth auto-accept for a Managed
 *  invitee on another instance. */
export type ConnectInviteDelivery = 'link' | 'email'
export type ConnectInviteScope = 'write' | 'read'

/** Default shareable-link lifetime: 7 days. Long enough for an owner to send a
 *  link and the collaborator to act on it; short enough to bound a leaked link.
 *  The owner may pass a shorter `ttl_ms`; we clamp to this ceiling. */
export const DEFAULT_CONNECT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000

export interface AppConnectInviteRequest {
  caller_user_id: string
  caller_instance_slug: string
  project_id: string
  /** Delivery method. Defaults to 'link' when omitted. */
  delivery?: ConnectInviteDelivery
  /** GBrain scope to bind. Defaults to 'write'. */
  scope?: ConnectInviteScope
  /** Link-delivery lifetime override (ms). Clamped to the default ceiling. */
  ttl_ms?: number
  /** Required for `delivery:'email'` — the invite is email-bound (audit + OAuth
   *  auto-accept target). */
  invitee_email?: string
}

export type ConnectInviteFailCode =
  | 'project_not_found'
  | 'forbidden'
  | 'not_group'
  | 'workspace_unavailable'

export type ConnectInviteContext =
  | {
      ok: true
      inviter_role: 'owner' | 'admin'
      /** The owner's project DB — link invites + the email-invite audit row
       *  land here (the connect node reads the same DB at accept time). */
      owner_db: ProjectDb
      /** Project id within the owner's instance (the connect project). */
      project_id: string
      /** For the email delivery: the workspace/connect instance slug bound into the
       *  invite + the active EdDSA signing key. Both optional — the LINK delivery
       *  needs neither (the link invite is a random hashed token, no JWT). When
       *  absent the email delivery returns a typed `workspace_unavailable` rather
       *  than minting an unsigned token. */
      workspace_instance_slug?: string
      signing_key?: InviteSigningKey
      /** Optional email-invite TTL override (seconds); defaults to 7 days. */
      trusted_ttl_seconds?: number
    }
  | { ok: false; code: ConnectInviteFailCode; message: string }

export interface AppConnectInviteDeps {
  resolveContext: (input: {
    caller_user_id: string
    caller_instance_slug: string
    project_id: string
  }) => Promise<ConnectInviteContext>
  /** Render the by-link accept URL `https://connect.<domain>/connect/accept#<token>`. */
  buildGuestAcceptUrl: (rawToken: string) => string
  /** Render the by-email cross-instance accept URL
   *  `https://connect.<domain>/invite?invite=<token>`. */
  buildTrustedAcceptUrl: (token: string) => string
  now?: () => number
}

export type AppConnectInviteResponse =
  | {
      status: 'created'
      delivery: 'link'
      /** One-time accept URL carrying the raw token in the fragment. */
      accept_url: string
      expires_at_ms: number
      scope: ConnectInviteScope
    }
  | {
      status: 'created'
      delivery: 'email'
      accept_url: string
      jti: string
      expires_at_ms: number
      scope: ConnectInviteScope
    }
  | {
      status: 'error'
      code: ConnectInviteFailCode | 'invalid_request' | 'invalid_email' | 'mint_failed'
      reason: string
    }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function httpStatusForConnectInvite(resp: AppConnectInviteResponse): number {
  if (resp.status === 'created') return 200
  switch (resp.code) {
    case 'invalid_request':
    case 'invalid_email':
      return 400
    case 'project_not_found':
      return 404
    case 'forbidden':
      return 403
    case 'not_group':
    case 'workspace_unavailable':
      return 409
    case 'mint_failed':
      return 500
    default:
      return 500
  }
}

/**
 * Issue a Neutron Connect collaborator invite (by-link or by-email delivery).
 * Never throws — every failure surfaces as a typed `status:'error'`.
 */
export async function handleAppConnectInvite(
  req: AppConnectInviteRequest,
  deps: AppConnectInviteDeps,
): Promise<AppConnectInviteResponse> {
  const delivery: ConnectInviteDelivery = req.delivery ?? 'link'
  if (delivery !== 'link' && delivery !== 'email') {
    return { status: 'error', code: 'invalid_request', reason: "delivery must be 'link' or 'email'" }
  }
  const scope: ConnectInviteScope = req.scope === 'read' ? 'read' : 'write'

  if (delivery === 'email') {
    const email = (req.invitee_email ?? '').trim()
    if (email.length < 3 || email.length > 320 || !EMAIL_RE.test(email)) {
      return { status: 'error', code: 'invalid_email', reason: 'invitee_email must be a valid email address' }
    }
  }

  let ctx: ConnectInviteContext
  try {
    ctx = await deps.resolveContext({
      caller_user_id: req.caller_user_id,
      caller_instance_slug: req.caller_instance_slug,
      project_id: req.project_id,
    })
  } catch (err) {
    return {
      status: 'error',
      code: 'mint_failed',
      reason: `resolve_context_failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!ctx.ok) {
    return { status: 'error', code: ctx.code, reason: ctx.message }
  }
  // Defense in depth (owner-only at launch, § 11 LOCK) — the resolver owns
  // authz, but a wrong-role context must never mint.
  if (!canInviteRole(ctx.inviter_role)) {
    return {
      status: 'error',
      code: 'forbidden',
      reason: 'only the project owner or an admin can invite members',
    }
  }

  const now = deps.now ?? ((): number => Date.now())

  if (delivery === 'link') {
    const ttlMs = clampTtlMs(req.ttl_ms)
    try {
      const inviteStore = new ConnectGuestInviteStore(ctx.owner_db)
      const issued = await inviteStore.issue({
        project_id: ctx.project_id,
        access: scope,
        ttl_ms: ttlMs,
        now: now(),
      })
      return {
        status: 'created',
        delivery: 'link',
        accept_url: deps.buildGuestAcceptUrl(issued.token),
        expires_at_ms: issued.expires_at_ms,
        scope,
      }
    } catch (err) {
      return { status: 'error', code: 'mint_failed', reason: err instanceof Error ? err.message : String(err) }
    }
  }

  // email delivery (OAuth auto-accept for a Managed invitee on another instance)
  if (ctx.signing_key === undefined || ctx.workspace_instance_slug === undefined) {
    return {
      status: 'error',
      code: 'workspace_unavailable',
      reason:
        'by-email collaborator invites need a configured signing key (NEUTRON_AUTH_DB_PATH); by-link invites work without it',
    }
  }
  try {
    const issued = await issueInviteToken({
      workspace_instance_slug: ctx.workspace_instance_slug,
      project_id: ctx.project_id,
      invitee_email: (req.invitee_email ?? '').trim(),
      inviter_user_id: req.caller_user_id,
      inviter_instance_slug: req.caller_instance_slug,
      signing_key: ctx.signing_key,
      inviter_db: ctx.owner_db,
      access: scope,
      ...(ctx.trusted_ttl_seconds !== undefined ? { ttl_seconds: ctx.trusted_ttl_seconds } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    })
    return {
      status: 'created',
      delivery: 'email',
      accept_url: deps.buildTrustedAcceptUrl(issued.token),
      jti: issued.jti,
      expires_at_ms: issued.expires_at_ms,
      scope,
    }
  } catch (err) {
    return { status: 'error', code: 'mint_failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

function clampTtlMs(ttlMs: number | undefined): number {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return DEFAULT_CONNECT_INVITE_TTL_MS
  }
  return Math.min(ttlMs, DEFAULT_CONNECT_INVITE_TTL_MS)
}
