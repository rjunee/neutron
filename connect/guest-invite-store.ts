/**
 * @neutronai/connect — ConnectGuestInviteStore.
 *
 * M2.6 Phase 3 (Neutron Connect: public ingress + OSS-guest auth tier). CRUD +
 * atomic single-use redemption over `connect_guest_invites`
 * (migrations/0058_connect_guest_invites.sql) — the owner-issued, project-scoped,
 * expiring credential a guest presents at the public `POST /connect/guest-auth`
 * handshake. The relay (connect node) is the SOLE guest authority (research § 8
 * #3); this store is the invite ledger that makes "no self-mint, no replay" real.
 *
 * Per docs/plans/m26-ph3-connect-public-ingress-brief.md § 3.1 / § 3.5 (3.10).
 *
 * SECURITY (brief § 3.4 invariant 3):
 *   - The raw invite token is a bearer-like secret; we persist ONLY its SHA-256
 *     hash. A DB read never leaks a usable invite.
 *   - Redemption is single-use + atomic: `claimInTx` runs a guarded UPDATE
 *     (`redeemed_at_ms IS NULL`) and asserts exactly one row changed, so a
 *     replayed invite is refused (`already_redeemed`) and an expired invite is
 *     refused (`expired`) BEFORE any connected_members write. Run inside the
 *     SAME accept transaction as the member insert so claim + member creation
 *     commit (or roll back) together.
 *
 * REVOCATION (ISSUES #421 residual, migration 0110). Until 0110 an invite had no
 * owner-driven terminal state: it closed when the GUEST redeemed it or when the
 * clock passed `expires_at_ms`, and nothing else. An owner who sent a link to the
 * wrong address had to wait out the 7-day ceiling — and because the surface gate
 * (`surface-gate.ts`) holds the ENTIRE `/connect/v1` prefix open while any live
 * invite exists, that unwanted link kept a cross-boundary API reachable from the
 * internet for a week. `revoke` is the missing third terminal state.
 *
 *   - It is a STATUS TRANSITION (`revoked_at_ms`), not a DELETE — see 0110's
 *     header for the full reasoning. In short: the owner keeps an audit trail of
 *     what they issued and when they took it back, and the boundary keeps the
 *     ability to make an INFORMED refusal for a token it knows was withdrawn.
 *   - It is guarded and idempotent: the UPDATE requires `revoked_at_ms IS NULL`,
 *     so a second revoke is a no-op that reports `false` rather than rewriting
 *     the timestamp.
 *   - A REDEEMED invite is still revocable, and revoking it is NOT how you eject
 *     the guest it already admitted — that is `revokeMember` on the member row.
 *     Revoking a spent invite is an audit act; the caller is told which state it
 *     was in so it can say so.
 *   - `claimInTx` refuses a revoked invite BEFORE the claim UPDATE, and the
 *     guarded UPDATE additionally carries `revoked_at_ms IS NULL` so a revoke
 *     that lands mid-handshake still wins rather than racing.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { Access } from './connected-members-store.ts'

/** The invite's read/write access grant (connect-spec §1.4, OQ-4). Identical
 *  domain to a member's `Access`; the claimed invite seeds the member row's
 *  `access`. */
export type GuestInviteAccess = Access

/**
 * Why a guest-invite redemption was refused. Maps to an HTTP status in the
 * handshake handler (4xx — never a member write).
 *
 * `revoked` is an INTERNAL reason. It is deliberately NOT distinguishable on the
 * public edge: `guest-auth-handler.ts` collapses it onto the EXPIRED response
 * (410, `reason:'expired'`) byte-for-byte, and `invite-preview-handler.ts`
 * collapses it onto the same 410 `gone` an already-redeemed invite returns. The
 * distinction survives only where it is useful and safe — the owner's own
 * authenticated invite ledger.
 */
export type GuestInviteRefusalReason =
  | 'not_found'
  | 'expired'
  | 'already_redeemed'
  | 'revoked'

export class GuestInviteError extends Error {
  override readonly name = 'GuestInviteError'
  constructor(readonly reason: GuestInviteRefusalReason) {
    super(`guest invite refused: ${reason}`)
  }
}

export interface IssueGuestInviteInput {
  project_id: string
  /** Optional owner-suggested label; the guest still self-asserts at handshake. */
  display_name_hint?: string
  /** Read/write access grant recorded onto the claimed member row
   *  (connect-spec §1.4). Guest default 'write'. */
  access?: GuestInviteAccess
  /** TTL in ms from `now`. */
  ttl_ms: number
  now: number
}

export interface IssuedGuestInvite {
  /** The RAW single-use token — returned to the owner, NEVER persisted. */
  token: string
  token_hash: string
  project_id: string
  expires_at_ms: number
}

/** The claimed invite's project binding + recorded scope, returned from
 *  `claimInTx` after a successful atomic single-use redemption. */
export interface ClaimedGuestInvite {
  token_hash: string
  project_id: string
  access: GuestInviteAccess
  display_name_hint: string | null
}

interface GuestInviteRow {
  token_hash: string
  project_id: string
  display_name_hint: string | null
  access: GuestInviteAccess
  created_at_ms: number
  expires_at_ms: number
  redeemed_at_ms: number | null
  redeemed_by_slug: string | null
  /** Set by `revoke`; NULL means "not revoked" (migration 0110). */
  revoked_at_ms: number | null
}

/**
 * The state of an invite as the OWNER sees it in their ledger. Derived, never
 * stored — the columns are the facts, this is the reading of them. Precedence
 * matters and is deliberate: an owner who revokes a spent invite should see
 * `revoked` (their act, the one they need confirmed), and a revoked invite whose
 * expiry has since passed should still read `revoked`, because "I took it back"
 * outranks "it would have lapsed anyway".
 */
export type OwnerInviteState = 'live' | 'redeemed' | 'revoked' | 'expired'

/** One row of the owner's invite ledger. Carries NO raw token — that is
 *  unrecoverable after issuance by construction. */
export interface OwnerInviteView {
  /** The invite's stable id: its `token_hash`. NOT a credential — the raw token
   *  is what redeems, and it cannot be derived from this. See
   *  `app-projects-surface.ts` for why exposing it to the owner is safe. */
  invite_id: string
  project_id: string
  access: GuestInviteAccess
  state: OwnerInviteState
  created_at_ms: number
  expires_at_ms: number
  redeemed_at_ms: number | null
  revoked_at_ms: number | null
}

/** What `revoke` did, for a caller that wants to say something honest about it. */
export interface RevokeInviteResult {
  /** True only when THIS call performed the transition. A second revoke is a
   *  no-op and reports `false` — idempotent, never an error. */
  revoked: boolean
  /** The state the invite was in BEFORE this call; `null` when no such invite
   *  exists on this instance. */
  prior_state: OwnerInviteState | null
}

function ownerInviteState(row: GuestInviteRow, nowMs: number): OwnerInviteState {
  if (row.revoked_at_ms !== null) return 'revoked'
  if (row.redeemed_at_ms !== null) return 'redeemed'
  if (row.expires_at_ms <= nowMs) return 'expired'
  return 'live'
}

/** SHA-256 hex of a raw invite token. The on-disk lookup key. */
export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

export class ConnectGuestInviteStore {
  constructor(private readonly db: ProjectDb) {}

  /**
   * Issue a fresh single-use invite. Generates a 256-bit URL-safe token,
   * persists ONLY its hash, returns the raw token to the caller (the owner
   * hands it to the guest out-of-band). The raw token is unrecoverable after
   * this call.
   */
  async issue(input: IssueGuestInviteInput): Promise<IssuedGuestInvite> {
    const token = randomBytes(32).toString('base64url')
    const token_hash = hashInviteToken(token)
    const scope: GuestInviteAccess = input.access ?? 'write'
    const expires_at_ms = input.now + input.ttl_ms
    await this.db.run(
      `INSERT INTO connect_guest_invites
         (token_hash, project_id, display_name_hint, access,
          created_at_ms, expires_at_ms, redeemed_at_ms, redeemed_by_slug)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      [
        token_hash,
        input.project_id,
        input.display_name_hint ?? null,
        scope,
        input.now,
        expires_at_ms,
      ],
    )
    return { token, token_hash, project_id: input.project_id, expires_at_ms }
  }

  /** Read a row by token hash (audit / classification). */
  getByHash(tokenHash: string): GuestInviteRow | null {
    const row = this.db
      .prepare<GuestInviteRow, [string]>(
        `SELECT token_hash, project_id, display_name_hint, access,
                created_at_ms, expires_at_ms, redeemed_at_ms, redeemed_by_slug,
                revoked_at_ms
           FROM connect_guest_invites WHERE token_hash = ? LIMIT 1`,
      )
      .get(tokenHash)
    return row === null || row === undefined ? null : row
  }

  /**
   * The OWNER'S INVITE LEDGER for one project, newest first — every invite ever
   * issued for it with its derived state. This is what makes revocation
   * operable: the raw token is unrecoverable after issuance, so without a list
   * the owner has no handle to name the invite they want withdrawn.
   *
   * Owner-authenticated callers only (`app-projects-surface.ts` resolves the
   * bearer before this runs). It returns no raw token and no guest identity —
   * only the issuance facts the owner already authored.
   */
  listByProject(projectId: string, nowMs: number): OwnerInviteView[] {
    const rows = this.db
      .prepare<GuestInviteRow, [string]>(
        `SELECT token_hash, project_id, display_name_hint, access,
                created_at_ms, expires_at_ms, redeemed_at_ms, redeemed_by_slug,
                revoked_at_ms
           FROM connect_guest_invites
          WHERE project_id = ?
          ORDER BY created_at_ms DESC`,
      )
      .all(projectId)
    return rows.map((row) => ({
      invite_id: row.token_hash,
      project_id: row.project_id,
      access: row.access,
      state: ownerInviteState(row, nowMs),
      created_at_ms: row.created_at_ms,
      expires_at_ms: row.expires_at_ms,
      redeemed_at_ms: row.redeemed_at_ms,
      revoked_at_ms: row.revoked_at_ms,
    }))
  }

  /**
   * REVOKE an outstanding invite (ISSUES #421 residual). Project-scoped on
   * purpose: `token_hash` is the primary key and would be enough to find the
   * row, but requiring the project the caller NAMED means a caller cannot reach
   * an invite belonging to a project they did not ask for — the same rule
   * `connect-owner-surface.ts` applies to member revocation.
   *
   * Guarded + idempotent. The UPDATE requires `revoked_at_ms IS NULL`, so:
   *   - first call  → 1 row changed → `{ revoked: true }`
   *   - second call → 0 rows changed → `{ revoked: false }`, not an error
   *   - unknown id  → `{ revoked: false, prior_state: null }`
   *
   * Revoking a LIVE invite is the case that matters: the surface gate stops
   * counting it on the very next request, so if it was the only thing holding
   * the cross-boundary API open, the API closes with no restart.
   */
  async revoke(
    projectId: string,
    tokenHash: string,
    nowMs: number,
  ): Promise<RevokeInviteResult> {
    // Read-then-guarded-write in ONE transaction. The read exists only to report
    // the prior state honestly; correctness rests on the UPDATE's
    // `revoked_at_ms IS NULL` guard, and the transaction keeps the two from
    // disagreeing with each other under a concurrent handshake.
    return this.db.transaction((tx) => {
      const row = tx
        .prepare<GuestInviteRow, [string, string]>(
          `SELECT token_hash, project_id, display_name_hint, access,
                  created_at_ms, expires_at_ms, redeemed_at_ms, redeemed_by_slug,
                  revoked_at_ms
             FROM connect_guest_invites
            WHERE token_hash = ? AND project_id = ? LIMIT 1`,
        )
        .get(tokenHash, projectId)
      if (row === null || row === undefined) {
        return { revoked: false, prior_state: null }
      }
      const prior_state = ownerInviteState(row, nowMs)
      const res = tx.runSync(
        `UPDATE connect_guest_invites
            SET revoked_at_ms = ?
          WHERE token_hash = ? AND project_id = ? AND revoked_at_ms IS NULL`,
        [nowMs, tokenHash, projectId],
      )
      return { revoked: res.changes === 1, prior_state }
    })
  }

  /**
   * Atomically claim (single-use) an invite by RAW token, INSIDE an outer
   * transaction `tx` (the same tx as the connected_members insert, so the claim
   * and the member creation are one atomic unit — brief § 3.1). Throws
   * `GuestInviteError` (rolling the outer tx back) on any refusal:
   *   - not_found       — no invite for this token hash
   *   - expired         — past `expires_at_ms`
   *   - already_redeemed — already claimed (single-use); also the race-loser path
   *
   * MUST be called from within `db.transaction(...)` so `tx.runSync` shares the
   * held write lock (the ProjectDb mutex serializes the BEGIN→COMMIT window).
   */
  claimInTx(tx: ProjectDb, rawToken: string, nowMs: number): ClaimedGuestInvite {
    const tokenHash = hashInviteToken(rawToken)
    const row = new ConnectGuestInviteStore(tx).getByHash(tokenHash)
    if (row === null) throw new GuestInviteError('not_found')
    // Checked BEFORE redeemed/expired: an owner's withdrawal is the strongest
    // statement about this invite, and it is the one the caller must not be able
    // to walk past. (The public edge still shows it as an expired invite — see
    // `GuestInviteRefusalReason`.)
    if (row.revoked_at_ms !== null) throw new GuestInviteError('revoked')
    if (row.redeemed_at_ms !== null) throw new GuestInviteError('already_redeemed')
    if (row.expires_at_ms <= nowMs) throw new GuestInviteError('expired')

    // Atomic single-use claim. The `redeemed_at_ms IS NULL` + `expires_at_ms >`
    // + `revoked_at_ms IS NULL` guards re-assert under the lock so a concurrent
    // claim (or a replay, or a revoke that lands after the SELECT above) still
    // resolves to exactly one winner; the loser sees changes===0 and 409s.
    const res = tx.runSync(
      `UPDATE connect_guest_invites
            SET redeemed_at_ms = ?
          WHERE token_hash = ? AND redeemed_at_ms IS NULL AND expires_at_ms > ?
            AND revoked_at_ms IS NULL`,
      [nowMs, tokenHash, nowMs],
    )
    if (res.changes !== 1) throw new GuestInviteError('already_redeemed')

    return {
      token_hash: tokenHash,
      project_id: row.project_id,
      access: row.access,
      display_name_hint: row.display_name_hint,
    }
  }

  /** Stamp the assigned local_slug onto a just-claimed invite (audit). Must run
   *  inside the same tx as `claimInTx`. */
  recordRedeemedBySlugInTx(tx: ProjectDb, tokenHash: string, localSlug: string): void {
    tx.runSync(
      `UPDATE connect_guest_invites SET redeemed_by_slug = ? WHERE token_hash = ?`,
      [localSlug, tokenHash],
    )
  }
}
