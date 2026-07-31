/**
 * @neutronai/open/wiring — the OWNER side of Connect (ISSUES #421).
 *
 * The cross-boundary half of Connect (`connect-node.ts`) is useless to a
 * self-hoster without the half the owner drives: issuing the invite, seeing who
 * is connected, and revoking them. `gateway/http/app-projects-surface.ts` has
 * routed `/api/app/projects/<id>/connect-invites` and `/connect-members[...]`
 * all along — but only when a `connect` deps object is supplied, and no composer
 * ever supplied one, so an Open install answered 501 `connect_not_configured`
 * while the mobile app (`app/lib/connect-members-client.ts`) was already calling
 * the route.
 *
 * This module is that deps object. It is also what makes the surface STATE GATE
 * meaningful: the gate opens on a live invite, and this is the only way an owner
 * creates one, so "inert until you deliberately open it" is a promise the
 * product can actually keep.
 *
 * AUTHZ. Single-owner Open has exactly one principal. The surface has already
 * authenticated the caller as the owner (`resolveBearer` against the owner
 * bearer / app-ws token) before any of these run, and each resolver re-asserts
 * ownership by resolving the project out of THIS install's DB — a project id
 * that does not exist here is `project_not_found`, never someone else's project.
 * `inviter_role` is reported as `'owner'` because on a single-owner install the
 * authenticated caller IS the owner; `canInviteRole` then re-checks it.
 */

import type {
  AppConnectSurfaceDeps,
  ConnectMemberView,
  ConnectSurfaceFail,
} from '@neutronai/gateway/http/app-projects-surface.ts'
import type { ConnectInviteContext } from '@neutronai/gateway/http/app-connect-invite.ts'
import { ConnectedMembersStore } from '@neutronai/connect/connected-members-store.ts'
import { revokeMember } from '@neutronai/connect/member-join.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

export interface ConnectOwnerSurfaceDeps {
  db: ProjectDb
  /** This install's slug — the receiving instance for a revoke. */
  owner_slug: string
  /** Public base URL a collaborator can reach this install on (no trailing
   *  slash), e.g. `https://neutron.example.com`. */
  connect_base_url: string
}

const NOT_FOUND: ConnectSurfaceFail = {
  ok: false,
  code: 'project_not_found',
  message: 'no such project on this instance',
  status: 404,
}

/** Does this project exist (and is it not soft-deleted) on this install? */
function projectExists(db: ProjectDb, projectId: string): boolean {
  try {
    const row = db
      .prepare<{ one: number }, [string]>(
        `SELECT 1 AS one FROM projects WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(projectId)
    return row !== null && row !== undefined
  } catch {
    return false
  }
}

export function buildConnectOwnerSurfaceDeps(
  deps: ConnectOwnerSurfaceDeps,
): AppConnectSurfaceDeps {
  const store = new ConnectedMembersStore(deps.db)
  const base = deps.connect_base_url.replace(/\/+$/, '')

  return {
    invite: {
      resolveContext: async ({ project_id }): Promise<ConnectInviteContext> => {
        if (!projectExists(deps.db, project_id)) {
          return { ok: false, code: 'project_not_found', message: NOT_FOUND.message }
        }
        return {
          ok: true,
          // Single-owner install: the authenticated caller is the owner.
          inviter_role: 'owner',
          owner_db: deps.db,
          project_id,
          // `workspace_instance_slug` + `signing_key` are deliberately omitted.
          // They power the by-EMAIL delivery, which mints a JWT an invitee's
          // MANAGED instance auto-accepts via central OAuth. A self-hosted
          // install has no counterpart to that flow, so the email delivery
          // returns a typed `workspace_unavailable` rather than minting a token
          // nothing can redeem. By-LINK — the delivery a self-hoster actually
          // uses — needs neither and works fully.
        }
      },
      buildGuestAcceptUrl: (rawToken: string): string =>
        `${base}/connect/accept#${rawToken}`,
      buildTrustedAcceptUrl: (token: string): string =>
        `${base}/invite?invite=${encodeURIComponent(token)}`,
    },

    listMembers: async ({ project_id }) => {
      if (!projectExists(deps.db, project_id)) return NOT_FOUND
      const members: ConnectMemberView[] = store.listByProject(project_id).map((m) => ({
        local_slug: m.local_slug,
        display_name: m.display_name,
        role: m.role,
        status: m.status,
      }))
      return { ok: true, members }
    },

    revokeMember: async ({ project_id, local_slug }) => {
      if (!projectExists(deps.db, project_id)) return NOT_FOUND
      // Project-scoped, never slug-global: revoking by slug alone would let a
      // caller reach a member of a project they did not name.
      if (!store.isProjectMember(project_id, local_slug)) {
        return {
          ok: false,
          code: 'member_not_found',
          message: 'no such member on this project',
          status: 404,
        }
      }
      const result = await revokeMember(
        { local_slug, receiving_instance_slug: deps.owner_slug },
        { store },
      )
      return { ok: true, revoked: result.revoked }
    },
  }
}
