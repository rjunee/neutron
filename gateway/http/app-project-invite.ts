/**
 * @neutronai/gateway/http — in-app per-project invite generation (M2.4).
 *
 * Backs `POST /api/app/projects/<id>/invite` — the in-app surface a
 * project owner/admin taps to mint a single-use invite link for a
 * collaborator. Per docs/engineering-plan.md § A.3.8 (solo→group
 * promotion + invite-link generation) + the M2.4 sprint brief.
 *
 * This module is a PURE handler over a `resolveInviteContext` dependency
 * seam — exactly the shape the existing onboarding-api handlers use
 * (provisioning onboarding-api: `invite-accept` + `promote-to-group`).
 * The HTTP route wrapper lives in `gateway/http/app-projects-surface.ts`;
 * the production composition (role check + workspace-instance resolution +
 * signing key) is wired in `gateway/index.ts`. Tests inject a synthetic
 * context so the full mint path is exercisable without a real instance
 * fleet.
 *
 * Token machinery is reused verbatim from
 * `onboarding/api/invite-link-generate.ts` (`issueInviteToken`): an
 * EdDSA JWT bound to (workspace, project, invitee_email_hash) +
 * persisted as a single-use `invites` row on the inviter's project DB. The invite is therefore bound to a specific invitee email — the
 * accept handler enforces `hash(accepter_email) === invitee_email_hash`
 * so possession-of-link alone cannot redeem a forwarded invite. The
 * in-app generate flow collects the invitee's email for this reason;
 * the owner still copies + sends the resulting link themselves
 * (email-side delivery is out of scope per the brief).
 *
 * TTL: inherits `INVITE_TOKEN_TTL_SECONDS` (7 days) from the existing
 * primitive unless the resolved context overrides it. The brief's
 * "5-min TTL" was a default suggestion; reusing the existing shape
 * (per the brief's "or as the existing primitive sets") keeps one
 * source of truth for invite-token lifetime.
 */

import {
  issueInviteToken,
  type InviteSigningKey,
} from '@neutronai/onboarding/api/invite-link-generate.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

export interface AppProjectInviteRequest {
  /** Bearer-resolved user id of the caller (the inviter). */
  caller_user_id: string
  /** Bearer-resolved user-instance slug of the caller. */
  caller_instance_slug: string
  /** Project id from the request path (already sanitized by the surface). */
  project_id: string
  /** Invitee email from the request body — bound into the token. */
  invitee_email: string
}

export type InviteContextFailCode =
  | 'project_not_found'
  | 'forbidden'
  | 'not_group'
  | 'workspace_unavailable'

/**
 * Result of resolving the invite context for (caller, project). On
 * success it carries everything `issueInviteToken` needs; on failure a
 * typed code the surface maps to an HTTP status. The production
 * resolver (gateway/index.ts) performs the owner/admin authz check and
 * the workspace-instance lookup; tests inject a ready-made context.
 */
export type InviteContext =
  | {
      ok: true
      /** Workspace instance hosting the group project. */
      workspace_instance_slug: string
      /** Project id WITHIN the workspace instance (may differ from the path id). */
      workspace_project_id: string
      /** Resolved role of the caller — defense-in-depth re-checked here. */
      inviter_role: 'owner' | 'admin'
      /** Inviter's project DB — the single-use `invites` row lands here. */
      inviter_db: ProjectDb
      /** Active signing key for the EdDSA invite JWT. */
      signing_key: InviteSigningKey
      /** Optional TTL override; defaults to the primitive's 7 days. */
      ttl_seconds?: number
    }
  | { ok: false; code: InviteContextFailCode; message: string }

export interface AppProjectInviteDeps {
  resolveInviteContext: (input: {
    caller_user_id: string
    caller_instance_slug: string
    project_id: string
  }) => Promise<InviteContext>
  /** Render the public `/invite?invite=<token>` URL for the token. */
  buildInviteUrl: (token: string) => string
  /** Wall-clock hook for tests. */
  now?: () => number
}

export type AppProjectInviteResponse =
  | {
      status: 'created'
      invite_url: string
      jti: string
      expires_at_ms: number
    }
  | {
      status: 'error'
      code: InviteContextFailCode | 'invalid_email' | 'mint_failed'
      reason: string
    }

// Pragmatic single-@ check — full RFC 5322 validation is neither
// possible nor useful here; the binding email is hashed and compared
// at accept time, so a typo just produces an invite nobody can redeem.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isPlausibleEmail(email: string): boolean {
  const t = email.trim()
  return t.length >= 3 && t.length <= 320 && EMAIL_RE.test(t)
}

/**
 * Roles permitted to mint a project invite: owner OR admin.
 *
 * Single-sourced so the production resolver (gateway/index.ts), the
 * handler's defense-in-depth re-check below, and the client gate
 * (`app/lib/invite-helpers.ts` `canInviteToProject`) never drift —
 * Argus r1 flagged owner-only/owner|admin divergence between them.
 *
 * Takes a widened `string` on purpose: the user-instance membership role
 * (`'owner' | 'member'` today, DB-CHECK-enforced) and the resolved
 * workspace role (`'owner' | 'admin'`, populated once M2.3 lands) live
 * in different type spaces, and this predicate guards both.
 */
export function canInviteRole(role: string): boolean {
  return role === 'owner' || role === 'admin'
}

/** Map a handler response to its HTTP status code. */
export function httpStatusForInvite(resp: AppProjectInviteResponse): number {
  if (resp.status === 'created') return 200
  switch (resp.code) {
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
 * Generate a single-use invite link for a project.
 *
 *   1. Validate the invitee email (fast 400 on garbage).
 *   2. Resolve the invite context (owner/admin authz + workspace map).
 *   3. Mint + persist the token via the existing `issueInviteToken`
 *      primitive (single-use `invites` row on the inviter's DB).
 *
 * Never throws — every failure surfaces as a typed `status: 'error'`.
 */
export async function handleAppProjectInvite(
  req: AppProjectInviteRequest,
  deps: AppProjectInviteDeps,
): Promise<AppProjectInviteResponse> {
  if (!isPlausibleEmail(req.invitee_email)) {
    return {
      status: 'error',
      code: 'invalid_email',
      reason: 'invitee_email must be a valid email address',
    }
  }

  let ctx: InviteContext
  try {
    ctx = await deps.resolveInviteContext({
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

  // Defense in depth — the resolver is responsible for authz, but a
  // wrong-role context must never mint a token.
  if (!canInviteRole(ctx.inviter_role)) {
    return {
      status: 'error',
      code: 'forbidden',
      reason: 'only the project owner or an admin can invite members',
    }
  }

  try {
    const issued = await issueInviteToken({
      workspace_instance_slug: ctx.workspace_instance_slug,
      project_id: ctx.workspace_project_id,
      invitee_email: req.invitee_email.trim(),
      inviter_user_id: req.caller_user_id,
      inviter_instance_slug: req.caller_instance_slug,
      signing_key: ctx.signing_key,
      inviter_db: ctx.inviter_db,
      ...(ctx.ttl_seconds !== undefined ? { ttl_seconds: ctx.ttl_seconds } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    })
    return {
      status: 'created',
      invite_url: deps.buildInviteUrl(issued.token),
      jti: issued.jti,
      expires_at_ms: issued.expires_at_ms,
    }
  } catch (err) {
    return {
      status: 'error',
      code: 'mint_failed',
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
