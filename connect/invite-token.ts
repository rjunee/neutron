/**
 * @neutronai/connect — invite-token mint / verify / claim (P2 S5).
 *
 * L3 (2026-07) — moved VERBATIM here from `onboarding/api/invite-link-generate.ts`
 * so the cross-instance trusted-accept path (`connect/trusted-accept-handler.ts`)
 * consumes it intra-package instead of importing UP into the `onboarding`
 * product band (the `services-below-product` violation this cut removes). The
 * function belongs in connect — it is the federation/invite primitive.
 * `onboarding/api/invite-link-generate.ts` re-exports everything from here so
 * the gateway HTTP importers stay valid (test-policy §2.2 barrel rule).
 *
 * Per docs/plans/P2-onboarding.md § 6 S5 line 2139. Mints a one-time-use
 * ed25519 JWT bound to a (workspace, project, invitee_email) triple +
 * persists the audit row in the inviter's per-project `invites` table.
 *
 * JWT shape (mirrors signup/start-token.ts):
 *   header  { alg: 'EdDSA', typ: 'JWT', kid: <active-key-id> }
 *   payload { sub: <inviter_user_id>,
 *             aud: ['neutron-invite'],
 *             workspace_instance_slug, project_id, invitee_email_hash,
 *             iat, exp, jti }
 *
 * TTL: 7 days. One-time-use enforced via `invites.consumed_at_ms` SQL
 * UPDATE rowsAffected (mirrors signup/start-token.ts:claim()).
 */

import { createHash, randomUUID } from 'node:crypto'
import { SignJWT, jwtVerify, type KeyLike, type JWTPayload } from 'jose'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

export const INVITE_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60
export const INVITE_TOKEN_AUDIENCE = 'neutron-invite'

export type InviteTokenErrorCode =
  | 'expired'
  | 'invalid_signature'
  | 'wrong_audience'
  | 'consumed'
  | 'not_found'
  | 'malformed'

export class InviteTokenError extends Error {
  override readonly name = 'InviteTokenError'
  constructor(
    readonly code: InviteTokenErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface InviteSigningKey {
  kid: string
  privateKey: KeyLike
}

export interface IssueInviteTokenInput {
  workspace_instance_slug: string
  project_id: string
  invitee_email: string
  inviter_user_id: string
  /**
   * Slug of the inviter's instance. Stored in the JWT
   * `inviter_instance_slug` claim so the production accept route can
   * resolve which per-project DB owns the `invites` row from the
   * `?invite=<token>` URL alone (without a side-table lookup).
   * Codex r6 P1 fix.
   */
  inviter_instance_slug: string
  signing_key: InviteSigningKey
  /** Per-project DB on the inviter side; the audit row goes here. */
  inviter_db: ProjectDb
  ttl_seconds?: number
  now?: () => number
  jti?: () => string
  /**
   * Connect read/write access to bind into a CONNECT-TRUSTED invite
   * (`write` | `read`, connect-spec §1.4). Carried as a JWT claim so the
   * cross-instance trusted accept records the owner-chosen access on the member
   * row (the locked lever — a `read` member cannot post). Omitted by the M2.4
   * same-authority path (the downstream accept defaults to the collaborator
   * `write`).
   */
  access?: 'write' | 'read'
}

export interface IssuedInviteToken {
  token: string
  jti: string
  expires_at_ms: number
  invitee_email_hash: string
}

/**
 * Hash an invitee email so the persisted row never carries plaintext.
 * sha256(lowercase(trim(email))) hex.
 */
export function hashInviteeEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  return createHash('sha256').update(normalized).digest('hex')
}

/**
 * Mint an invite token + persist the audit row. Returns the JWT, jti,
 * expiry, and the hashed invitee email so the caller can render the
 * /invite landing URL with a server-side rendered "you're joining
 * <workspace> as <hint>" UX.
 */
export async function issueInviteToken(
  input: IssueInviteTokenInput,
): Promise<IssuedInviteToken> {
  const ttl = input.ttl_seconds ?? INVITE_TOKEN_TTL_SECONDS
  if (ttl > INVITE_TOKEN_TTL_SECONDS) {
    throw new InviteTokenError(
      'malformed',
      `invite-token TTL must be <= ${INVITE_TOKEN_TTL_SECONDS}s, got ${ttl}`,
    )
  }
  const now = input.now ?? ((): number => Date.now())
  const iat_s = Math.floor(now() / 1000)
  const exp_s = iat_s + ttl
  const expires_at_ms = exp_s * 1000
  const jti = (input.jti ?? randomUUID)()
  const invitee_email_hash = hashInviteeEmail(input.invitee_email)

  const token = await new SignJWT({
    workspace_instance_slug: input.workspace_instance_slug,
    project_id: input.project_id,
    invitee_email_hash,
    inviter_instance_slug: input.inviter_instance_slug,
    // Only present on a connect-trusted invite; absent on M2.4.
    ...(input.access !== undefined ? { access: input.access } : {}),
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: input.signing_key.kid })
    .setSubject(input.inviter_user_id)
    .setIssuedAt(iat_s)
    .setExpirationTime(exp_s)
    .setAudience([INVITE_TOKEN_AUDIENCE])
    .setJti(jti)
    .sign(input.signing_key.privateKey)

  const created_at_ms = now()
  await input.inviter_db.run(
    `INSERT INTO invites
       (token_id, workspace_instance_slug, invitee_email_hash, project_id,
        inviter_user_id, expires_at_ms, consumed_at_ms, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      jti,
      input.workspace_instance_slug,
      invitee_email_hash,
      input.project_id,
      input.inviter_user_id,
      expires_at_ms,
      created_at_ms,
    ],
  )

  return { token, jti, expires_at_ms, invitee_email_hash }
}

export interface InviteTokenClaims {
  workspace_instance_slug: string
  project_id: string
  invitee_email_hash: string
  inviter_user_id: string
  /**
   * Slug of the inviter's instance. Production accept routes
   * resolve `inviter_db` from this claim (read the instance home path
   * from the registry, open the per-project SQLite at that path).
   */
  inviter_instance_slug: string
  jti: string
  expires_at_ms: number
  /** Present only on a connect-trusted invite (`write` | `read`, §1.4).
   *  Absent on M2.4 same-authority invites. */
  access?: 'write' | 'read'
}

export interface VerifyInviteTokenInput {
  token: string
  /** Resolves the public key for a given kid. Identity service exposes a JWKS. */
  resolveKey: (kid: string) => Promise<KeyLike | null>
  now?: () => number
}

/**
 * Verify a token's signature, audience, expiry, and required claims.
 * Does NOT consume the row; pair with `claimInviteToken` once the
 * downstream side-effect (workspace member add + provision) succeeds.
 */
export async function verifyInviteToken(
  input: VerifyInviteTokenInput,
): Promise<InviteTokenClaims> {
  const now = input.now ?? ((): number => Date.now())
  let parsed: { payload: JWTPayload }
  try {
    parsed = await jwtVerify(
      input.token,
      async (header) => {
        if (header.alg !== 'EdDSA') {
          throw new InviteTokenError('malformed', `unexpected alg=${header.alg}`)
        }
        const kid = header.kid
        if (typeof kid !== 'string' || kid.length === 0) {
          throw new InviteTokenError('malformed', 'header.kid required')
        }
        const key = await input.resolveKey(kid)
        if (key === null) {
          throw new InviteTokenError('invalid_signature', `unknown kid=${kid}`)
        }
        return key
      },
      {
        audience: INVITE_TOKEN_AUDIENCE,
        currentDate: new Date(now()),
      },
    )
  } catch (err) {
    if (err instanceof InviteTokenError) throw err
    const message = err instanceof Error ? err.message : String(err)
    if (/exp/.test(message) || /JWTExpired/i.test(err instanceof Error ? err.name : '')) {
      throw new InviteTokenError('expired', message, err)
    }
    if (/audience/i.test(message)) {
      throw new InviteTokenError('wrong_audience', message, err)
    }
    if (/signature/i.test(message)) {
      throw new InviteTokenError('invalid_signature', message, err)
    }
    throw new InviteTokenError('malformed', message, err)
  }

  const p = parsed.payload
  const workspace_instance_slug = readString(p, 'workspace_instance_slug')
  const project_id = readString(p, 'project_id')
  const invitee_email_hash = readString(p, 'invitee_email_hash')
  const inviter_instance_slug = readString(p, 'inviter_instance_slug')
  const inviter_user_id = typeof p.sub === 'string' ? p.sub : ''
  if (inviter_user_id.length === 0) throw new InviteTokenError('malformed', 'sub claim required')
  const jti = typeof p.jti === 'string' ? p.jti : ''
  if (jti.length === 0) throw new InviteTokenError('malformed', 'jti claim required')
  const exp_s = typeof p.exp === 'number' ? p.exp : 0
  // Optional connect-trusted access claim (non-required; absent on M2.4).
  const rawAccess = (p as Record<string, unknown>)['access']
  const access =
    rawAccess === 'write' || rawAccess === 'read' ? rawAccess : undefined
  return {
    workspace_instance_slug,
    project_id,
    invitee_email_hash,
    inviter_user_id,
    inviter_instance_slug,
    jti,
    expires_at_ms: exp_s * 1000,
    ...(access !== undefined ? { access } : {}),
  }
}

function readString(p: JWTPayload, name: string): string {
  const v = (p as Record<string, unknown>)[name]
  if (typeof v !== 'string' || v.length === 0) {
    throw new InviteTokenError('malformed', `${name} claim required`)
  }
  return v
}

/**
 * Atomically claim the invite token's row. Returns the claims on
 * success. Throws:
 *   - `InviteTokenError('not_found')` when no row matches the jti.
 *   - `InviteTokenError('expired')` when the row has aged past
 *     `expires_at_ms` (defense-in-depth — verifyInviteToken catches
 *     this earlier from the JWT exp claim).
 *   - `InviteTokenError('consumed')` when the row was already claimed
 *     (either by an earlier in-process call OR by a concurrent
 *     cross-process caller — we read changes from the UPDATE's
 *     statement so the loser of a cross-process race surfaces
 *     `consumed`, not `claimed:true`).
 *
 * Implementation: SELECT-then-conditional-UPDATE inside a single
 * `transaction()` call. The per-instance mutex
 * (`persistence/db.ts:transaction`) holds across BEGIN → fn → COMMIT,
 * so concurrent claims on the same `ProjectDb` instance cannot
 * interleave into the open transaction — the second caller's SELECT
 * sees `consumed_at_ms != null` and throws. The UPDATE's
 * `WHERE consumed_at_ms IS NULL` clause + the `result.changes ===
 * 1` check provides cross-process safety: if a different process
 * landed its commit between our SELECT and our UPDATE, the UPDATE
 * affects 0 rows and we throw `consumed` rather than reporting a
 * fictitious win.
 */
export async function claimInviteToken(input: {
  jti: string
  inviter_db: ProjectDb
  now?: () => number
}): Promise<{ claimed: true } | never> {
  const now = (input.now ?? ((): number => Date.now()))()
  await input.inviter_db.transaction(async (tx) => {
    const before = tx
      .prepare<{ expires_at_ms: number; consumed_at_ms: number | null }, [string]>(
        `SELECT expires_at_ms, consumed_at_ms FROM invites WHERE token_id = ?`,
      )
      .get(input.jti)
    if (before === null || before === undefined) {
      throw new InviteTokenError('not_found', `no invite row for jti=${input.jti}`)
    }
    if (before.consumed_at_ms !== null) {
      throw new InviteTokenError('consumed', `invite jti=${input.jti} already consumed`)
    }
    if (before.expires_at_ms <= now) {
      throw new InviteTokenError('expired', `invite jti=${input.jti} expired`)
    }
    // Use the raw bun:sqlite Statement.run so we can inspect `changes`.
    // The transaction's per-instance mutex serializes against any other
    // run/exec/transaction on this ProjectDb; the WHERE clause + the
    // changes check protect against a separate-process write that
    // committed between our SELECT and our UPDATE.
    const stmt = tx.raw().prepare(
      `UPDATE invites SET consumed_at_ms = ? WHERE token_id = ? AND consumed_at_ms IS NULL`,
    )
    const result = stmt.run(now, input.jti) as { changes?: number }
    const changes = result.changes ?? 0
    if (changes !== 1) {
      throw new InviteTokenError(
        'consumed',
        `invite jti=${input.jti} consumed by concurrent caller (UPDATE affected ${changes} rows)`,
      )
    }
  })
  return { claimed: true }
}
