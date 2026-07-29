/**
 * @neutronai/app — pure helpers for the in-app invite flow (M2.4).
 *
 * Extracted so the validation + formatting logic is unit-testable
 * without rendering React Native components (mirrors
 * `lib/task-formatters.ts` feeding `TaskCreateModal`). The
 * `<InviteModal>` + `<Toast>` components stay presentational and call
 * these.
 */

// Single-@ plausibility check — the binding email is hashed + compared
// at accept time, so deeper validation buys nothing. Mirrors the
// gateway's `isPlausibleEmail`.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Whether the Invite pill should render for `user_id` on `project`.
 *
 * Two gates, BOTH required — this mirrors the gateway's
 * `canInviteRole` authz (see `gateway/http/app-project-invite.ts`) plus
 * the group precondition, so the client never surfaces an action the
 * server is guaranteed to reject:
 *
 *   1. Role — only an owner or admin can mint invites. A plain member
 *      never sees the pill. (Admin can't appear on a personal project
 *      today — the DB CHECK is owner|member — but the check is
 *      future-proofed for the workspace roles M2.3 resolves.)
 *   2. Group — invites only make sense for a shared/group project. A
 *      `billing_mode === 'personal'` project has no workspace to
 *      host collaborators, so the mint path returns `not_group`.
 *      Personal projects are ~100% of prod today; without this gate
 *      every prod owner saw a primary Invite action that always failed
 *      (Argus r1 BLOCKING).
 *
 * Takes a structural type so it doesn't depend on the full
 * `ProjectSettings` shape — `ProjectMember.role` (`'owner' | 'member'`)
 * is assignable to the widened role param.
 */
export function canInviteToProject(
  project: {
    billing_mode: string;
    members: ReadonlyArray<{ user_id: string; role: 'owner' | 'admin' | 'member' }>;
  },
  user_id: string | null,
): boolean {
  if (user_id === null) return false;
  if (project.billing_mode === 'personal') return false;
  const role = project.members.find((m) => m.user_id === user_id)?.role;
  return role === 'owner' || role === 'admin';
}

export function isValidInviteeEmail(email: string): boolean {
  const t = email.trim();
  return t.length >= 3 && t.length <= 320 && EMAIL_RE.test(t);
}

/**
 * Human "Expires in …" label for the invite link, derived from the
 * server's `expires_at_ms` and the current wall clock. Coarse by
 * design — the exact second is irrelevant to the user.
 */
export function formatInviteExpiry(expires_at_ms: number, now_ms: number): string {
  const remaining = expires_at_ms - now_ms;
  if (remaining <= 0) return 'Expired';
  const minutes = remaining / 60_000;
  if (minutes < 60) return `Expires in ${Math.max(1, Math.round(minutes))} min`;
  const hours = remaining / 3_600_000;
  if (hours < 24) return `Expires in ${Math.round(hours)} h`;
  const days = Math.round(remaining / 86_400_000);
  return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

export interface JoinedToastInfo {
  /** Project display name the invitee just joined. */
  project: string;
  /** Owner display name who shared it (may be empty). */
  owner: string;
}

/**
 * Parse the `?joined=<project>&by=<owner>` deep-link params the
 * post-accept redirect carries into the app, into toast copy. Returns
 * null when there's no `joined` param so the screen renders nothing.
 * `useLocalSearchParams` may surface a value as a string or string[]
 * (repeated param); we take the first.
 */
export function parseJoinedToast(
  params: Record<string, unknown>,
): JoinedToastInfo | null {
  const project = firstString(params['joined']).trim();
  if (project.length === 0) return null;
  const owner = firstString(params['by']).trim();
  return { project, owner };
}

/** Compose the toast strings from joined info. */
export function joinedToastCopy(info: JoinedToastInfo): {
  message: string;
  detail: string;
} {
  return {
    message: `Joined ${info.project}`,
    detail: info.owner.length > 0 ? `shared by ${info.owner}` : '',
  };
}

function firstString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return '';
}
