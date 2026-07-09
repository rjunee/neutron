/**
 * @neutronai/connect — ConnectedMembersStore.
 *
 * M2.6 Phase 2 (Neutron Connect). CRUD over the per-project `connected_members`
 * table (migrations/0055_connected_members.sql) — the meeting-point's record of
 * every member that has joined ONE owner's session. Transport / identity only;
 * NOT a memory store (brief § 2.2, research § 7.2).
 *
 * The store is the single seam the local-slug assigner consults for collision
 * checks (`hasSlug`) and the routing layer consults to resolve an authenticated
 * caller → its `local_slug` (`resolveActiveByHomeIdentity`). Revocation flips
 * `status` so the next routed turn from that member is refused at the
 * resolve_member gate.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'

/**
 * The member's role in the meeting point. ONE owner per project; everyone else
 * is a `collaborator`, regardless of where they are hosted. Hosting shape
 * (Managed VPS vs Neutron Open self-hosted) is an authentication-mechanism
 * detail, NEVER an identity tier — a Managed collaborator and a self-hosted
 * collaborator are the same role with the same features. The capability axis is
 * `access` (read|write), which is orthogonal to role and is the only knob that
 * gates what a collaborator can do. `role` is display-only — nothing downstream
 * branches on it for access control.
 */
export type MemberRole = 'owner' | 'collaborator'
/**
 * Connect read/write access (connect-spec §1.4, OQ-4). A plain session-post
 * permission, NOT the old 3-value `gbrain_scope` quarantine-whitelist:
 *   - write → the collaborator's turns drive the host's one session + memory.
 *   - read  → the collaborator observes; their POST /messages is refused at the
 *             post boundary. Never writes.
 * The owner is the only admin (the former `admin` value disappeared with OQ-4).
 */
export type Access = 'read' | 'write'
export type MemberStatus = 'pending' | 'active' | 'revoked'

export interface ConnectedMember {
  /** Meeting-point-assigned, grammar-valid namespace key. PK. */
  local_slug: string
  /** Human label, rendered with the role badge. */
  display_name: string
  role: MemberRole
  /** Provenance/audit: the configured auth authority (Managed-OAuth collaborator) |
   *  self-asserted handle (self-hosted/token collaborator) | NULL (owner). NOT a
   *  role signal — where a member authenticated from, nothing more. */
  home_authority: string | null
  /**
   * Resolution key: the caller's JWT-authenticated origin instance slug
   * (ConnectAuthContext.origin_instance_slug). Inbound turns resolve their
   * local_slug by the ACTIVE row whose home_instance_slug matches. NULL for owner.
   */
  home_instance_slug: string | null
  /** Audit: the caller's platform user id at accept time. */
  home_user_id: string | null
  /** Read/write session-post permission (connect-spec §1.4). Gated at the
   *  post boundary: a `read` member's POST /messages is refused. */
  access: Access
  /** ISO-8601 UTC accept timestamp; NULL while pending. */
  approved_at: string | null
  status: MemberStatus
}

interface ConnectedMemberRow {
  local_slug: string
  display_name: string
  role: MemberRole
  home_authority: string | null
  home_instance_slug: string | null
  home_user_id: string | null
  access: Access
  approved_at: string | null
  status: MemberStatus
}

// Column + TS symbol are both `home_instance_slug` (column renamed by migration
// 0065; the TS symbol followed in the B5 connect local-vocab rename, so SELECTs
// no longer alias). 0070 renamed gbrain_scope → access (connect-spec §1.4).
const INSERT_COLS =
  'local_slug, display_name, role, home_authority, home_instance_slug, home_user_id, access, approved_at, status'
const SELECT_COLS =
  'local_slug, display_name, role, home_authority, home_instance_slug, home_user_id, access, approved_at, status'

export class ConnectedMembersStore {
  constructor(private readonly db: ProjectDb) {}

  /** Insert a new member row. Throws on PK (local_slug) conflict. */
  async insert(member: ConnectedMember): Promise<void> {
    await this.db.run(
      `INSERT INTO connected_members
         (${INSERT_COLS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        member.local_slug,
        member.display_name,
        member.role,
        member.home_authority,
        member.home_instance_slug,
        member.home_user_id,
        member.access,
        member.approved_at,
        member.status,
      ],
    )
  }

  get(localSlug: string): ConnectedMember | null {
    const row = this.db
      .prepare<ConnectedMemberRow, [string]>(
        `SELECT ${SELECT_COLS} FROM connected_members WHERE local_slug = ? LIMIT 1`,
      )
      .get(localSlug)
    return row === null || row === undefined ? null : row
  }

  /** True if `localSlug` is already taken (any status). Backs the slug assigner. */
  hasSlug(localSlug: string): boolean {
    const row = this.db
      .prepare<{ one: number }, [string]>(
        `SELECT 1 AS one FROM connected_members WHERE local_slug = ? LIMIT 1`,
      )
      .get(localSlug)
    return row !== null && row !== undefined
  }

  /**
   * Resolve the ACTIVE member for an authenticated caller's FULL home identity:
   * (origin instance slug, platform user id). Keying on the instance slug ALONE is
   * a security bug — a single origin instance (esp. a workspace instance) holds
   * many platform users, so any user with a membership in that instance would
   * otherwise resolve to the ONE accepted member's local_slug (accept-gate bypass +
   * cross-user attribution impersonation). The JWT subject (origin_user_id) is
   * part of the resolution key, not just an audit field.
   *
   * Returns null when no active membership exists for THIS identity (never
   * joined, joined-as-a-different-user, OR revoked) — the routing layer turns
   * that into a 403.
   */
  resolveActiveByHomeIdentity(
    homeInstanceSlug: string,
    homeUserId: string,
  ): ConnectedMember | null {
    const row = this.db
      .prepare<ConnectedMemberRow, [string, string]>(
        `SELECT ${SELECT_COLS} FROM connected_members
           WHERE home_instance_slug = ? AND home_user_id = ? AND status = 'active'
           ORDER BY approved_at DESC
           LIMIT 1`,
      )
      .get(homeInstanceSlug, homeUserId)
    return row === null || row === undefined ? null : row
  }

  list(): ConnectedMember[] {
    return this.db
      .prepare<ConnectedMemberRow, []>(
        `SELECT ${SELECT_COLS} FROM connected_members ORDER BY local_slug ASC`,
      )
      .all()
  }

  /**
   * M2.6 Ph5 — the members of ONE project, for the app's role badge render
   * (brief § 1.10, test #9). `connected_members` has no project_id column (a
   * member's identity is project-agnostic); the project association lives on
   * `project_members.origin_instance = local_slug`. Join on that to scope to a
   * project. Returns any status so the UI can show a revoked member greyed out.
   *
   * Ordering is by display_name (alphabetical) — NOT by role. There is no role
   * hierarchy to rank by: an owner and a collaborator are not "higher" / "lower",
   * just different. The owner-first grouping the UI wants is applied client-side
   * (connectMemberSort), which the API ordering must not pre-empt.
   */
  listByProject(projectId: string): ConnectedMember[] {
    return this.db
      .prepare<ConnectedMemberRow, [string]>(
        `SELECT ${SELECT_COLS.split(', ')
          .map((c) => `cm.${c}`)
          .join(', ')}
           FROM connected_members cm
           JOIN project_members pm ON pm.origin_instance = cm.local_slug
          WHERE pm.project_id = ?
          ORDER BY cm.display_name ASC, cm.local_slug ASC`,
      )
      .all(projectId)
  }

  /**
   * M2.6 Ph5 — is `localSlug` a member of `projectId`? Guards the in-app revoke
   * route so an owner of project A cannot revoke a member of project B by slug
   * (Codex P1 — the revoke path must be project-scoped, not slug-global). Joins
   * via `project_members.origin_instance = local_slug`.
   */
  isProjectMember(projectId: string, localSlug: string): boolean {
    const row = this.db
      .prepare<{ one: number }, [string, string]>(
        `SELECT 1 AS one FROM project_members
          WHERE project_id = ? AND origin_instance = ? LIMIT 1`,
      )
      .get(projectId, localSlug)
    return row !== null && row !== undefined
  }

  /**
   * Flip a member's status (e.g. → 'revoked' on leave, → 'active' on accept).
   * Optionally stamp approved_at (set on the pending → active transition).
   */
  async setStatus(
    localSlug: string,
    status: MemberStatus,
    approvedAt?: string | null,
  ): Promise<void> {
    if (approvedAt !== undefined) {
      await this.db.run(
        `UPDATE connected_members SET status = ?, approved_at = ? WHERE local_slug = ?`,
        [status, approvedAt, localSlug],
      )
      return
    }
    await this.db.run(
      `UPDATE connected_members SET status = ? WHERE local_slug = ?`,
      [status, localSlug],
    )
  }
}
