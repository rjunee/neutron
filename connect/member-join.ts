/**
 * @neutronai/connect — collaborator join / leave lifecycle + the
 * routing-layer member resolver.
 *
 * M2.6 (Neutron Connect). Per docs/plans/m26-ph2-connect-server-brief.md § 2.2,
 * § 3.2 and docs/plans/m26-ph3-connect-public-ingress-brief.md § 3.1, § 3.4
 * (3.9), § 6, as collapsed by docs/plans/connect-trust-class-collapse-brief.md
 * (single owner|collaborator role; the former guest/trusted tiers are gone).
 *
 * There is ONE non-owner role — `collaborator` — regardless of where a member is
 * hosted. What differs is purely the AUTHENTICATION MECHANISM, an implementation
 * detail that is never stamped onto identity:
 *   - Managed-OAuth handshake: a collaborator already on the configured auth
 *     authority (acceptTrustedMember — the M2.5 cross-instance bearer path), and
 *   - self-hosted token handshake: a Neutron Open self-hoster with NO Managed
 *     account, authenticated by redeeming a single-use owner invite at the connect
 *     node (acceptGuestMember — the relay is the sole authority).
 * Both produce the SAME `role='collaborator'` member with the SAME features; the
 * capability axis is `access` (read|write), orthogonal to role. Both share ONE allocator
 * + ONE `connected_members` PK namespace, so two collaborators named "Mona" from
 * two authorities never collide; both route through the EXACT same transport once
 * resolved.
 *
 * `acceptTrustedMember` / `acceptGuestMember` record the full identity:
 *   - a `connected_members` row (role='collaborator', a grammar-valid meeting-
 *     point-assigned local_slug, status='active'), and
 *   - a `project_members` row carrying `origin_instance = local_slug`, and
 *   - (Managed-OAuth path only, optionally) the M2.5 membership row via
 *     `registerMembership`.
 *
 * ISSUES #108 fix (brief § 6 test #7): the `local_slug` is allocated INSIDE the
 * accept transaction. The ProjectDb per-instance write mutex holds the
 * BEGIN→COMMIT window, so two concurrent accepts of the SAME display_name
 * serialize — the second sees the first's committed slug via `hasSlug` and picks
 * a distinct suffix, instead of both computing the same base outside the tx and
 * colliding on the PK insert. The fix lives on the SHARED in-tx insert helper, so
 * it covers BOTH the trusted and the guest accept path at once.
 *
 * `revokeMember` flips status='revoked' so the next authenticated POST
 * /connect/v1/messages from that collaborator (either auth mechanism) is
 * refused by `buildResolveMember`'s gate (brief test #6).
 */

import { randomUUID } from 'node:crypto'
import { createLogger } from '@neutronai/logger'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { ConnectAuthContext } from './api/jwt-bearer-middleware.ts'
import type { MemberResolution } from './api/server.ts'
import { assignLocalSlug, slugifyDisplayName } from './local-slug.ts'
import {
  ConnectedMembersStore,
  type Access,
  type ConnectedMember,
  type MemberRole,
} from './connected-members-store.ts'
import { ConnectGuestInviteStore } from './guest-invite-store.ts'

const log = createLogger('connect')

/**
 * Home authority recorded for collaborators who joined via the
 * Managed-OAuth handshake. There is NO hosted default: the operator sets the
 * authority via the `NEUTRON_TRUSTED_HOME_AUTHORITY` env var (e.g.
 * `auth.example.test`). When unset it is the empty string — no configured
 * authority, matching the self-hosted reality (the trusted-home check then has
 * no authority to match against).
 */
export const TRUSTED_HOME_AUTHORITY =
  process.env.NEUTRON_TRUSTED_HOME_AUTHORITY ?? ''

/** Fallback origin slug for a self-hosted collaborator whose self-asserted handle
 *  yields no usable slug. NOT grammar-stamped anywhere (only `local_slug` is); it
 *  is the collaborator bearer's single-membership slug + the resolver key part.
 *  Pair uniqueness is guaranteed by the connect-assigned `home_user_id`, never by
 *  this value. */
const GUEST_ORIGIN_FALLBACK_SLUG = 'guest'

/** Membership-registration seam (LIFT — the M2.5 path). Injected so the join
 *  handler stays decoupled from the identity DB and tests can assert the call. */
export type RegisterMembershipFn = (args: {
  /** The meeting-point the member is joining (the receiving instance slug). */
  workspace_instance_slug: string
  /** The accepting member's platform user id. */
  accepter_user_id: string
  /** Always 'member' for a contributor in Ph2. */
  role: 'member'
}) => Promise<void>

/**
 * Memory-mirror seam (LIFT — connect-spec §1.8 + §2.4, import-on-join). Injected
 * so the accept path stays decoupled from GBrain + the host snapshot transport.
 * On a join it triggers the ONE-WAY host→collaborator import of the shared
 * project's GBrain GRAPH layer into the joining collaborator's own GBrain,
 * scoped + §4-author-tagged. The wiring closure bakes in the host context (the
 * owner instance slug) + the collaborator's GBrain client; the accept function
 * supplies only what it knows — the project + the resolved author. Optional:
 * tests + nodes that mirror elsewhere may omit it. Best-effort by contract — its
 * implementation must NOT fail the join if GBrain is unreachable (§1.8).
 *
 * PRODUCTION WIRING STATE (2026-06-14, B2 fix-pass — read before assuming this
 * runs in prod). This is an OPTIONAL LIFT seam, exactly like `registerMembership`
 * below: it is threaded all the way through the mounted accept handlers
 * (`buildGuestAuthHandler` / `buildTrustedAcceptHandler`), so supplying it is a
 * one-line composer change. The production composer does NOT supply it yet, and
 * NOT because of an oversight — the accept handlers run OWNER/HOST-side, but
 * §1.8 imports the snapshot into the joining COLLABORATOR's OWN GBrain, which is
 * a REMOTE self-hosted instance the connect node has no handle on at accept time
 * (the join is browser-initiated — `landing/connect-accept.ts`). A real
 * cross-instance import is therefore gated on two not-yet-built pieces, both the
 * deferred live-fan-out trident's scope (connect-spec §7 C-E): (i) the HTTP
 * host-snapshot transport (`SharedProjectGraphSource` is `InProcessGraphSource`
 * only today), and (ii) per-project GBrain source scoping — GBrain is per-
 * instance `source=default` today (`gateway/wiring/build-gbrain-memory.ts`:
 * "project partitioning lands in M2.6"), so a host export would ship the host's
 * WHOLE cross-project memory, a privacy regression. The real collaborator-side
 * trigger point is `gateway/projects/shared-projects-resolver.ts` (shared-project
 * discovery). Tracked in ISSUES.md (import-on-join activation). The module +
 * ledger + real-GBrain in-process round-trip are landed and tested; only the
 * distributed activation is deferred. */
export type MirrorMemoryOnJoinFn = (args: {
  /** The shared project (in the owner's instance) the member is joining. */
  project_id: string
  /** The uniform §4 author the join is attributed to (the joining collaborator). */
  author: { id: string; display: string }
}) => Promise<void>

/**
 * Shared in-tx member insert. Allocates the `local_slug` INSIDE the held
 * transaction (the #108 fix — see module header) and writes BOTH the
 * `connected_members` row and the `project_members` row atomically. Used by
 * `acceptTrustedMember` AND `acceptGuestMember` so the allocator race is fixed
 * once for both classes.
 *
 * project_members.origin_instance = local_slug so the owner's session attributes
 * the member's turns unambiguously (forward-only column from migration 0056).
 * The upsert re-points an existing `(project_id, user_id)` row to the new
 * local_slug instead of colliding (a previously-revoked member re-joining).
 */
function insertMemberInTx(
  tx: ProjectDb,
  fields: {
    display_name: string
    role: MemberRole
    home_authority: string | null
    home_instance_slug: string | null
    home_user_id: string | null
    access: Access
    project_id: string
    approved_at: string
  },
): ConnectedMember {
  const txStore = new ConnectedMembersStore(tx)
  const localSlug = assignLocalSlug(fields.display_name, (slug) =>
    txStore.hasSlug(slug),
  )
  const member: ConnectedMember = {
    local_slug: localSlug,
    display_name: fields.display_name,
    role: fields.role,
    home_authority: fields.home_authority,
    home_instance_slug: fields.home_instance_slug,
    home_user_id: fields.home_user_id,
    access: fields.access,
    approved_at: fields.approved_at,
    status: 'active',
  }
  // Synchronous writes — we already hold the tx's write lock, so re-entrant
  // tx.run would also work; runSync keeps the helper purely synchronous inside
  // the BEGIN/COMMIT window.
  tx.runSync(
    `INSERT INTO connected_members
       (local_slug, display_name, role, home_authority, home_instance_slug,
        home_user_id, access, approved_at, status)
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
  tx.runSync(
    `INSERT INTO project_members
       (project_id, user_id, name, role, joined_at, origin_instance)
     VALUES (?, ?, ?, 'member', ?, ?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET
       name = excluded.name,
       role = 'member',
       joined_at = excluded.joined_at,
       origin_instance = excluded.origin_instance`,
    [
      fields.project_id,
      fields.home_user_id,
      fields.display_name,
      fields.approved_at,
      member.local_slug,
    ],
  )
  return member
}

export interface AcceptTrustedMemberInput {
  /** Human label ("Mona"); namespaced into a collision-free local_slug. */
  display_name: string
  /** The joiner's authenticated origin instance slug (resolution key). */
  home_instance_slug: string
  /** The joiner's platform user id (ConnectAuthContext.origin_user_id). */
  home_user_id: string
  /** The project (in the owner's instance) the member is joining. */
  project_id: string
  /** The meeting-point / receiving instance slug (for the membership seam). */
  receiving_instance_slug: string
  /** Read/write access grant to record on the member row (connect-spec §1.4).
   *  Collaborator default 'write'. */
  access?: Access
  /** Optional override; defaults to the configured TRUSTED_HOME_AUTHORITY for trusted joiners. */
  home_authority?: string
}

export interface AcceptTrustedMemberDeps {
  store: ConnectedMembersStore
  db: ProjectDb
  /** LIFT: the M2.5 membership-registration seam. Optional (tests + nodes that
   *  register membership elsewhere may omit it). */
  registerMembership?: RegisterMembershipFn
  /** LIFT: the §1.8 import-on-join memory-mirror seam. Optional. */
  mirrorMemoryOnJoin?: MirrorMemoryOnJoinFn
  now?: () => number
}

export interface AcceptTrustedMemberResult {
  member: ConnectedMember
  /** True when an already-active member was reused (idempotent re-accept). */
  reused: boolean
}

/**
 * Accept a collaborator via the Managed-OAuth handshake (the M2.5 cross-instance
 * bearer path) into the owner's project session. Stamps `role='collaborator'` —
 * the OAuth mechanism is how they authenticated, not a tier. Idempotent: a second
 * accept for the same FULL home identity (instance slug + user id) while still
 * active reuses the existing record rather than minting a duplicate identity. The
 * idempotency check + slug allocation + both inserts all run INSIDE one
 * transaction so the check-then-insert is atomic (and the #108 allocator race is
 * closed — see module header).
 */
export async function acceptTrustedMember(
  input: AcceptTrustedMemberInput,
  deps: AcceptTrustedMemberDeps,
): Promise<AcceptTrustedMemberResult> {
  const now = deps.now ?? ((): number => Date.now())
  const approvedAt = new Date(now()).toISOString()

  const result = await deps.db.transaction((tx): AcceptTrustedMemberResult => {
    const txStore = new ConnectedMembersStore(tx)
    // Idempotency keyed on the FULL home identity (instance slug + user id), not
    // the instance slug alone: a second DISTINCT user in the same origin instance
    // must mint its own identity. Inside the tx so the check + insert is atomic.
    const existing = txStore.resolveActiveByHomeIdentity(
      input.home_instance_slug,
      input.home_user_id,
    )
    if (existing !== null) {
      return { member: existing, reused: true }
    }
    const member = insertMemberInTx(tx, {
      display_name: input.display_name,
      role: 'collaborator',
      home_authority: input.home_authority ?? TRUSTED_HOME_AUTHORITY,
      home_instance_slug: input.home_instance_slug,
      home_user_id: input.home_user_id,
      access: input.access ?? 'write',
      project_id: input.project_id,
      approved_at: approvedAt,
    })
    return { member, reused: false }
  })

  // LIFT: register the M2.5 membership so the joiner's next federated token
  // includes this meeting-point. Runs on BOTH the fresh and reused path so a
  // re-accept re-grants a dropped membership.
  if (deps.registerMembership !== undefined) {
    await deps.registerMembership({
      workspace_instance_slug: input.receiving_instance_slug,
      accepter_user_id: input.home_user_id,
      role: 'member',
    })
  }

  // LIFT: import-on-join memory mirror (connect-spec §1.8 + §2.4). Runs on BOTH
  // paths — the orchestrator's ledger makes it one-time, so a re-accept after a
  // failed first import retries cleanly. Best-effort by contract: its
  // implementation must not fail the join if GBrain is unreachable.
  if (deps.mirrorMemoryOnJoin !== undefined) {
    // Best-effort at the CALL SITE: a memory-mirror import failure (transport,
    // GBrain, scoping — anything) must NEVER fail the join. The mirror is a
    // recall convenience; the join + membership are authoritative. Log + swallow.
    try {
      await deps.mirrorMemoryOnJoin({
        project_id: input.project_id,
        author: {
          id: result.member.local_slug,
          display: result.member.display_name,
        },
      })
    } catch (err) {
      log.warn('memory_mirror_import_on_join_failed', {
        project_id: input.project_id,
        local_slug: result.member.local_slug,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}

export interface AcceptGuestMemberInput {
  /** The raw single-use invite token the guest presents (relay is sole authority). */
  invite_token: string
  /** Guest-self-asserted human label; namespaced into a collision-free local_slug. */
  display_name: string
  /** Self-asserted, UNVERIFIED home handle (e.g. its domain). Stored as
   *  home_authority (display/audit); also derives the bearer's origin slug. It
   *  buys nothing — role is fixed server-side at 'collaborator' regardless. */
  guest_handle: string
}

export interface AcceptGuestMemberDeps {
  store: ConnectedMembersStore
  inviteStore: ConnectGuestInviteStore
  db: ProjectDb
  /** LIFT: the §1.8 import-on-join memory-mirror seam. Optional. */
  mirrorMemoryOnJoin?: MirrorMemoryOnJoinFn
  now?: () => number
}

export interface AcceptGuestMemberResult {
  member: ConnectedMember
  /** The owner project the (claimed) invite scoped the guest to. */
  project_id: string
  /** The origin slug the guest bearer carries as its single membership AND the
   *  slug the guest must stamp its body `origin_instance` with (== home_instance_slug). */
  origin_slug: string
  /** The connect-assigned guest subject (the bearer `sub`). */
  guest_user_id: string
}

/**
 * Accept a collaborator via the self-hosted token handshake into the owner's
 * project session (Ph3 § 3.1, 3.9). The relay is the SOLE authority: the
 * self-hoster holds no Managed OAuth account, only a single-use owner invite. The
 * WHOLE operation — claim the invite (atomic, single-use) AND allocate the
 * local_slug AND write the member rows — runs in ONE transaction, so a
 * replayed/expired invite refuses before any member write (brief § 3.4 invariant
 * 3) and the slug allocator race (#108) is closed.
 *
 * Identity model (brief § 3.4 invariants 1 & 2):
 *   - role is FIXED to 'collaborator' here, server-side — same role a Managed
 *     OAuth collaborator gets. The caller never asserts it; `buildResolveMember`
 *     later reads it from this stored row, never a token. The token handshake is
 *     an auth mechanism, NOT a lesser tier.
 *   - home_user_id is a connect-assigned unique id (`guest-<uuid>`), so the
 *     (home_instance_slug, home_user_id) resolution PAIR is unique even if two
 *     collaborators self-assert the same handle — no cross-member impersonation.
 *   - home_authority = the self-asserted handle (display/audit only).
 *
 * Throws `GuestInviteError` (rolling the tx back, no member written) on a
 * missing / expired / already-redeemed invite.
 */
export async function acceptGuestMember(
  input: AcceptGuestMemberInput,
  deps: AcceptGuestMemberDeps,
): Promise<AcceptGuestMemberResult> {
  const now = deps.now ?? ((): number => Date.now())
  const nowMs = now()
  const approvedAt = new Date(nowMs).toISOString()

  // Connect-assigned, unique guest identity. home_user_id guarantees the
  // resolution pair is unique; the origin slug is derived from the (untrusted)
  // handle purely as a label for the bearer's single membership.
  const guestUserId = `guest-${randomUUID()}`
  const originSlug = deriveGuestOriginSlug(input.guest_handle)

  const { member, project_id } = await deps.db.transaction((tx) => {
    // Atomic single-use claim FIRST — refuses (rolls back) before any member
    // write on a replayed / expired / missing invite.
    const claim = deps.inviteStore.claimInTx(tx, input.invite_token, nowMs)
    // The invite's access grant (read|write) seeds the member row verbatim.
    const guestAccess: Access = claim.access
    const m = insertMemberInTx(tx, {
      display_name: input.display_name,
      role: 'collaborator',
      home_authority: input.guest_handle,
      home_instance_slug: originSlug,
      home_user_id: guestUserId,
      access: guestAccess,
      project_id: claim.project_id,
      approved_at: approvedAt,
    })
    deps.inviteStore.recordRedeemedBySlugInTx(tx, claim.token_hash, m.local_slug)
    return { member: m, project_id: claim.project_id }
  })

  // LIFT: import-on-join memory mirror (connect-spec §1.8 + §2.4). A guest
  // accept always inserts a fresh member, so this fires once per join; the
  // orchestrator's ledger guards against a duplicate import on a reconnect.
  // Best-effort by contract: must not fail the join if GBrain is unreachable.
  if (deps.mirrorMemoryOnJoin !== undefined) {
    // Best-effort at the CALL SITE: a mirror import failure must NEVER fail the
    // join (recall convenience; join + membership are authoritative). Log + swallow.
    try {
      await deps.mirrorMemoryOnJoin({
        project_id,
        author: {
          id: member.local_slug,
          display: member.display_name,
        },
      })
    } catch (err) {
      log.warn('memory_mirror_import_on_join_failed', {
        project_id,
        local_slug: member.local_slug,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    member,
    project_id,
    origin_slug: originSlug,
    guest_user_id: guestUserId,
  }
}

/** Derive the guest bearer's origin slug from the untrusted handle. Sanitised
 *  via the same slugifier members use, with a neutral fallback. NOT required to
 *  be unique or platform-grammar-valid (only `local_slug` is stamped); the
 *  JWT membership slug only needs to be a non-empty string. */
function deriveGuestOriginSlug(handle: string): string {
  const s = slugifyDisplayName(handle)
  return s === '' ? GUEST_ORIGIN_FALLBACK_SLUG : s
}

/** Membership-revocation seam (LIFT — mirror of registration). */
export type RevokeMembershipFn = (args: {
  workspace_instance_slug: string
  member_user_id: string
}) => Promise<void>

export interface RevokeMemberInput {
  local_slug: string
  receiving_instance_slug: string
}

export interface RevokeMemberDeps {
  store: ConnectedMembersStore
  /** Optional: drop the membership so the JWT-derived path also closes over time. */
  revokeMembership?: RevokeMembershipFn
}

export interface RevokeMemberResult {
  revoked: boolean
}

/**
 * Revoke a member (trusted OR guest). Flips connected_members.status='revoked'
 * (so the next authenticated turn 403s at `buildResolveMember`) and optionally
 * drops the membership. Already-delivered turns are NOT retroactively wiped
 * (accepted semantics, brief § 3.2).
 */
export async function revokeMember(
  input: RevokeMemberInput,
  deps: RevokeMemberDeps,
): Promise<RevokeMemberResult> {
  const member = deps.store.get(input.local_slug)
  if (member === null) return { revoked: false }

  await deps.store.setStatus(input.local_slug, 'revoked')

  if (deps.revokeMembership !== undefined && member.home_user_id !== null) {
    await deps.revokeMembership({
      workspace_instance_slug: input.receiving_instance_slug,
      member_user_id: member.home_user_id,
    })
  }
  return { revoked: true }
}

/**
 * Build the routing-layer member resolver wired into the cross-instance API on a
 * connect node. Resolves an authenticated caller (by their FULL JWT home
 * identity — origin instance slug AND subject user id) to its ACTIVE member
 * identity, re-namespacing the routed turn to the member's local_slug. A
 * revoked / unknown / never-accepted caller is refused with 403 — this is the
 * gate that makes the member-identity layer actually load-bearing (brief
 * constraint "build-but-not-wired is forbidden" + tests #6).
 *
 * SECURITY (brief § 3.4):
 *   - The resolution key MUST include the JWT subject (origin_user_id), not just
 *     the origin instance slug. A single origin instance holds many platform users;
 *     keying on the slug alone lets any user in that instance inherit the one
 *     accepted member's slug — an accept-gate bypass and cross-user impersonation
 *     (Codex caught this on PR #396 r2). Both auth mechanisms carry the SAME
 *     discipline.
 *   - `role` is read SERVER-SIDE from the resolved `connected_members` row and
 *     returned to the caller for display only — it is NEVER read from a token
 *     claim or request body, and nothing downstream branches on it for access
 *     control (the capability axis is `access`). A bearer that *claims* a
 *     role resolves to the stored row's role regardless (test #4a).
 *   - `access` (read|write) + `display_name` are ALSO server-resolved from the
 *     stored row and returned: `access` drives the post-boundary read/write gate
 *     (connect-spec §1.4 — a `read` member's POST /messages is refused) and
 *     `display_name` seeds the uniform `author` envelope (connect-spec §4). Like
 *     `role`, both come from the stored row, NEVER from a token claim or body.
 */
export function buildResolveMember(deps: {
  store: ConnectedMembersStore
}): (ctx: ConnectAuthContext) => Promise<MemberResolution> {
  return async (ctx) => {
    const member = deps.store.resolveActiveByHomeIdentity(
      ctx.origin_instance_slug,
      ctx.origin_user_id,
    )
    if (member === null) {
      return {
        ok: false,
        status: 403,
        reason: 'member_not_active',
      }
    }
    return {
      ok: true,
      local_slug: member.local_slug,
      // Server-resolved from the stored row — never derived from the inbound
      // token. `role` is display-only; `access` gates the post boundary;
      // `display_name` seeds the author envelope (connect-spec §1.4 + §4).
      role: member.role,
      access: member.access,
      display_name: member.display_name,
    }
  }
}
