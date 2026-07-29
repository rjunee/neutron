/**
 * @neutronai/app — pure helpers for the Neutron Connect member UI (M2.6 Ph5).
 *
 * Extracted so the gating + badge + sort logic is unit-testable without
 * rendering React Native (mirrors `lib/invite-helpers.ts`). The
 * member-management section of `<ProjectSettingsDrawer>` stays
 * presentational and calls these.
 *
 * Connect access control (§ 11 LOCK):
 *   - Issuing invites + managing the roster: owner OR admin.
 *   - Revoking a connected member: OWNER-ONLY. An admin can invite but
 *     cannot revoke — the revoke endpoint returns 403 for non-owners, so
 *     the action must not even render for them.
 *
 * Crucially, Connect invites are NOT gated on `billing_mode`: a personal
 * project CAN be shared cross-org (that's the whole point of Connect), so
 * unlike `canInviteToProject` (which is scoped to the local project store), there is no group precondition.
 */

import type {
  ConnectMemberStatus,
  ConnectMemberView,
  ConnectMemberRole,
} from './connect-members-client';

/** Visual tone for a role badge — drives colour + icon glyph. */
export type ConnectBadgeTone = 'owner' | 'collaborator';

export interface ConnectBadge {
  label: string;
  tone: ConnectBadgeTone;
}

/**
 * Map a member's role to its badge label + tone. There are two roles: the
 * project `owner` and everyone else, a `collaborator` — regardless of where the
 * collaborator is hosted (Managed vs Neutron Open). Hosting shape is an auth
 * mechanism, never a visible tier, so there is no guest-vs-trusted distinction.
 * The tone is the single source the renderer keys colour AND icon off — keep them
 * aligned.
 */
export function connectBadge(role: ConnectMemberRole): ConnectBadge {
  switch (role) {
    case 'collaborator':
      return { label: 'Collaborator', tone: 'collaborator' };
    case 'owner':
    default:
      return { label: 'Owner', tone: 'owner' };
  }
}

/**
 * Whether `user_id` may manage Connect members (issue invites, see the
 * management affordances) on `project`. Owner or admin — mirrors
 * `canInviteToProject`'s role logic but WITHOUT the group precondition,
 * because a personal project is a legitimate Connect share target.
 *
 * Takes a structural type so it doesn't depend on the full
 * `ProjectSettings` shape.
 */
export function canManageConnectMembers(
  project: {
    members: ReadonlyArray<{ user_id: string; role: 'owner' | 'admin' | 'member' }>;
  },
  user_id: string | null,
): boolean {
  if (user_id === null) return false;
  const role = project.members.find((m) => m.user_id === user_id)?.role;
  return role === 'owner' || role === 'admin';
}

/**
 * Whether `user_id` may revoke a connected member. OWNER-ONLY per the
 * § 11 LOCK — an admin who can invite still cannot revoke, so this is
 * strictly narrower than `canManageConnectMembers`.
 */
export function canRevokeConnectMember(
  project: {
    members: ReadonlyArray<{ user_id: string; role: 'owner' | 'admin' | 'member' }>;
  },
  user_id: string | null,
): boolean {
  if (user_id === null) return false;
  const role = project.members.find((m) => m.user_id === user_id)?.role;
  return role === 'owner';
}

/**
 * Human "Expires in …" label for an accept link. Identical contract to
 * `invite-helpers.formatInviteExpiry` — re-exported here so the Connect
 * UI has one import surface without coupling the two flows.
 */
export { formatInviteExpiry as formatAcceptLinkExpiry } from './invite-helpers';

const ROLE_ORDER: Record<ConnectMemberRole, number> = {
  owner: 0,
  collaborator: 1,
};

const STATUS_ORDER: Record<ConnectMemberStatus, number> = {
  active: 0,
  pending: 1,
  revoked: 2,
};

/**
 * Stable display order for the connected-member roster:
 *   1. Revoked members sink to the bottom (greyed, de-emphasised).
 *   2. Among non-revoked, the owner reads first, then collaborators. This is the
 *      ONLY role grouping — collaborators are NOT ranked against each other by
 *      hosting (there is no guest-vs-trusted tier).
 *   3. Within a group, pending below active.
 *   4. Alphabetical by display name as the final tiebreak.
 * Pure + non-mutating (copies before sorting).
 */
export function connectMemberSort(
  members: readonly ConnectMemberView[],
): ConnectMemberView[] {
  return [...members].sort((a, b) => {
    const aRevoked = a.status === 'revoked' ? 1 : 0;
    const bRevoked = b.status === 'revoked' ? 1 : 0;
    if (aRevoked !== bRevoked) return aRevoked - bRevoked;
    const role = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
    if (role !== 0) return role;
    const status = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (status !== 0) return status;
    return a.display_name.localeCompare(b.display_name);
  });
}
