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
 */

import { createHash, randomBytes } from 'node:crypto'
import type { ProjectDb } from '../persistence/index.ts'
import type { Access } from './connected-members-store.ts'

/** The invite's read/write access grant (connect-spec §1.4, OQ-4). Identical
 *  domain to a member's `Access`; the claimed invite seeds the member row's
 *  `access`. */
export type GuestInviteAccess = Access

/** Why a guest-invite redemption was refused. Maps to an HTTP status in the
 *  handshake handler (4xx — never a member write). */
export type GuestInviteRefusalReason =
  | 'not_found'
  | 'expired'
  | 'already_redeemed'

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
                created_at_ms, expires_at_ms, redeemed_at_ms, redeemed_by_slug
           FROM connect_guest_invites WHERE token_hash = ? LIMIT 1`,
      )
      .get(tokenHash)
    return row === null || row === undefined ? null : row
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
   * MUST be called from within `db.transaction(...)` so `tx.raw()` shares the
   * held write lock (the ProjectDb mutex serializes the BEGIN→COMMIT window).
   */
  claimInTx(tx: ProjectDb, rawToken: string, nowMs: number): ClaimedGuestInvite {
    const tokenHash = hashInviteToken(rawToken)
    const row = new ConnectGuestInviteStore(tx).getByHash(tokenHash)
    if (row === null) throw new GuestInviteError('not_found')
    if (row.redeemed_at_ms !== null) throw new GuestInviteError('already_redeemed')
    if (row.expires_at_ms <= nowMs) throw new GuestInviteError('expired')

    // Atomic single-use claim. The `redeemed_at_ms IS NULL` + `expires_at_ms >`
    // guards re-assert under the lock so a concurrent claim (or a replay) that
    // raced past the SELECT above still resolves to exactly one winner; the
    // loser sees changes===0 and 409s.
    const res = tx
      .raw()
      .run(
        `UPDATE connect_guest_invites
            SET redeemed_at_ms = ?
          WHERE token_hash = ? AND redeemed_at_ms IS NULL AND expires_at_ms > ?`,
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
    tx.raw().run(
      `UPDATE connect_guest_invites SET redeemed_by_slug = ? WHERE token_hash = ?`,
      [localSlug, tokenHash],
    )
  }
}
