/**
 * @neutronai/gateway/http — Expo-app project-settings + project-list
 * surface (P5.2 + ISSUES #9).
 *
 * Per docs/plans/P5.2-project-view-shell-sprint-brief.md § 4.5 + § 4.12,
 * extended by ISSUES #9 (per-instance `projects` SQLite table substrate).
 *
 * Routes:
 *   - `GET   /api/app/projects`                          — list endpoint (ISSUES #9)
 *   - `GET   /api/app/projects/<project_id>/settings`    — read drawer doc
 *   - `PATCH /api/app/projects/<project_id>/settings`    — flip privacy_mode
 *
 * Auth: shared `AppWsAuthResolver` (dev-bypass + HS256 paths used by
 * launcher / tasks / reminders / docs cover this surface identically).
 *
 * Storage:
 *   - `InMemoryProjectSettingsStore` (this module) — kept as a
 *     drop-in test seam. Gateway unit / integration tests that boot
 *     the surface against a synthetic auth resolver use this.
 *   - `SqliteProjectSettingsStore` (`gateway/projects/sqlite-store.ts`,
 *     ISSUES #9) — the production implementation. Backed by the
 *     per-instance `projects` + `project_members` tables (migration
 *     0038). Replaces the in-memory store in the production composer
 *     (`gateway/index.ts`) so PATCH writes survive a gateway restart.
 *
 * Settings PATCH whitelist: only `privacy_mode`. Any other field →
 * 400 with `field_not_writable`. This is the minimum mutation
 * surface that delivers user-visible value at P5.2; other fields
 * (persona / billing_mode / members / description) are read-only
 * here and edited via follow-up surfaces (P5.7 admin, member-invite,
 * etc.).
 *
 * List endpoint: read-only at ISSUES #9. Project create / delete via
 * HTTP is explicitly out of scope (deferred — see PR description) —
 * projects are populated by the auto-seed on first settings access
 * AND/OR by a future onboarding/signup sprint that explicitly writes
 * to the table.
 */

import { sanitizeProjectId } from '../../channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '../../channels/adapters/app-ws/auth.ts'
import {
  handleAppProjectInvite,
  httpStatusForInvite,
  type AppProjectInviteDeps,
} from './app-project-invite.ts'
import {
  handleAppConnectInvite,
  httpStatusForConnectInvite,
  type AppConnectInviteDeps,
  type ConnectInviteDelivery,
  type ConnectInviteScope,
} from './app-connect-invite.ts'

// R6 (audit P2-12): the legacy `'workspace'` (group-visibility) privacy tier +
// the per-seat/group billing values are removed-concept residue. Single-owner Open
// has only owner-private vs link-public projects, and only personal billing.
export type PrivacyMode = 'private' | 'public'
export type BillingMode = 'personal'

export const ALL_PRIVACY_MODES: ReadonlyArray<PrivacyMode> = ['private', 'public']
export const ALL_BILLING_MODES: ReadonlyArray<BillingMode> = ['personal']

export interface ProjectMember {
  user_id: string
  name: string
  role: 'owner' | 'member'
}

export interface ProjectSettings {
  id: string
  name: string
  description: string
  persona: string
  privacy_mode: PrivacyMode
  billing_mode: BillingMode
  members: ProjectMember[]
}

/**
 * M2.3 unified-list discriminator. `solo` projects live in this
 * owner's own DB; `shared` projects come from a workspace instance the
 * user is a member of (fetched cross-instance). Per engineering-plan § A.3.2
 * both render in ONE flat list with NO workspace switcher — the `kind` +
 * `origin_instance` fields are what the UI uses to show a solo-vs-shared
 * pill.
 */
export type ProjectOrigin = 'solo' | 'shared'

/**
 * A row in the unified project list. Extends the local `ProjectSettings`
 * shape with origin provenance. Solo items carry full settings; shared
 * items carry only what the cross-instance `/projects` endpoint exposes
 * (id/name/owner) — the remaining settings fields are filled with safe
 * defaults because a member doesn't own the workspace project's settings
 * drawer. `origin_instance` / `owning_instance_slug` are load-bearing for the
 * privacy quarantine: a shared item's foreign origin tag MUST survive to
 * the client so nothing persists it into this instance's GBrain.
 */
export interface ProjectListItem extends ProjectSettings {
  /** `solo` (local) | `shared` (from a workspace the user belongs to). */
  kind: ProjectOrigin
  /** Slug of the instance that owns this project. Equals this gateway's
   *  `project_slug` for solo items; the workspace slug for shared items. */
  origin_instance: string
  /** Alias of `origin_instance`, kept explicit for client dedup + display. */
  owning_instance_slug: string
}

/** A shared (group) project surfaced by the cross-instance `/projects`
 *  endpoint of a workspace the user belongs to. */
export interface SharedProjectItem {
  project_id: string
  display_name: string
  owning_instance_slug: string
}

export interface SharedProjectsResult {
  items: SharedProjectItem[]
  /** Per-workspace failures — a degraded workspace surfaces here without
   *  blanking the list (graceful degradation per § A.3.2). */
  source_errors: Array<{ workspace_instance_slug: string; error: string }>
}

/**
 * Resolves the shared (cross-instance) half of the unified list. The
 * production implementation (`gateway/projects/shared-projects-resolver.ts`)
 * enumerates workspace memberships, mints cross-instance tokens, and fans
 * out. Injected into the surface so the surface stays pure + testable with
 * a stub; when omitted, the surface returns local-only (back-compat +
 * graceful degradation when the identity DB / signing key aren't wired).
 */
export interface SharedProjectsResolver {
  fetch(args: { user_id: string; project_slug: string }): Promise<SharedProjectsResult>
}

/**
 * The settings store. Keyed by (project_slug, project_id). Production
 * uses `SqliteProjectSettingsStore`
 * (`gateway/projects/sqlite-store.ts`); the in-memory implementation
 * below stays as a test seam.
 *
 * `list` returns every project in the instance scope — backs the new
 * `GET /api/app/projects` route (ISSUES #9). The dev-stub
 * `app/lib/projects.ts` is rewired to call this endpoint; the
 * project-list screen reads the same source of truth as the settings
 * drawer.
 */
export interface ProjectSettingsStore {
  get(project_slug: string, project_id: string): Promise<ProjectSettings | null>
  update(
    project_slug: string,
    project_id: string,
    patch: { privacy_mode?: PrivacyMode },
  ): Promise<ProjectSettings | null>
  list(project_slug: string): Promise<ProjectSettings[]>
}

/**
 * Default settings for a project that has no explicit row yet. Single-owner
 * Open has no hardcoded demo seed (the `acme`/`northwind`/`neutron`
 * `KNOWN_PROJECTS` demo map was removed in the R6 refactor — audit P2-11): real
 * projects are written to the `projects` table by the onboarding wow-moment
 * (`onboarding/wow-moment/actions/03-project-shells.ts`). Any project_id not
 * yet persisted lands here with a humanised name + empty fields; the shell
 * renders the canonical sections with a clear "not configured" state.
 */
export function buildDefaultSettings(project_id: string): ProjectSettings {
  return {
    id: project_id,
    name: humaniseProjectId(project_id),
    description: '',
    persona: '',
    privacy_mode: 'private',
    billing_mode: 'personal',
    members: [],
  }
}

function humaniseProjectId(project_id: string): string {
  const trimmed = project_id.replace(/[-_]+/g, ' ').trim()
  if (trimmed.length === 0) return project_id
  return trimmed
    .split(/\s+/)
    .map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}

/**
 * In-memory implementation. Keyed by `${project_slug}::${project_id}`.
 * Per-process state — server restarts wipe in-flight privacy_mode
 * mutations. That's acceptable degraded mode for P5.2 (the brief
 * explicitly defers SQLite persistence; the wire shape doesn't
 * change when persistence lands).
 */
export class InMemoryProjectSettingsStore implements ProjectSettingsStore {
  private readonly rows = new Map<string, ProjectSettings>()

  async get(project_slug: string, project_id: string): Promise<ProjectSettings | null> {
    const key = this.keyFor(project_slug, project_id)
    const existing = this.rows.get(key)
    if (existing !== undefined) return cloneSettings(existing)
    const seeded = buildDefaultSettings(project_id)
    this.rows.set(key, seeded)
    return cloneSettings(seeded)
  }

  async update(
    project_slug: string,
    project_id: string,
    patch: { privacy_mode?: PrivacyMode },
  ): Promise<ProjectSettings | null> {
    const current = await this.get(project_slug, project_id)
    if (current === null) return null
    const updated: ProjectSettings = {
      ...current,
      privacy_mode: patch.privacy_mode ?? current.privacy_mode,
    }
    this.rows.set(this.keyFor(project_slug, project_id), updated)
    return cloneSettings(updated)
  }

  async list(project_slug: string): Promise<ProjectSettings[]> {
    const prefix = `${project_slug}::`
    const out: ProjectSettings[] = []
    for (const [key, value] of this.rows.entries()) {
      if (!key.startsWith(prefix)) continue
      out.push(cloneSettings(value))
    }
    out.sort((a, b) => a.id.localeCompare(b.id))
    return out
  }

  private keyFor(project_slug: string, project_id: string): string {
    return `${project_slug}::${project_id}`
  }

  /** Test helper — wipe the in-memory map. */
  reset(): void {
    this.rows.clear()
  }
}

function cloneSettings(s: ProjectSettings): ProjectSettings {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    persona: s.persona,
    privacy_mode: s.privacy_mode,
    billing_mode: s.billing_mode,
    members: s.members.map((m) => ({ ...m })),
  }
}

export interface AppProjectsSurfaceOptions {
  store: ProjectSettingsStore
  auth: AppWsAuthResolver
  /**
   * In-app invite generation deps (M2.4). When omitted, the
   * `POST /api/app/projects/<id>/invite` route returns 501
   * `invite_not_configured` — parity with the landing server's
   * unconfigured-invite-accept behaviour. Production wires this in
   * `gateway/index.ts`; gateway tests inject a synthetic context.
   */
  invite?: AppProjectInviteDeps
  /**
   * M2.3 — resolver for the shared (cross-instance) half of the unified
   * list. When provided, `GET /api/app/projects` merges this owner's
   * solo projects with every group project from the workspaces the user
   * belongs to. When omitted, the endpoint returns local-only (its
   * pre-M2.3 behavior) — this is the graceful-degradation path for
   * single-instance / Open-tier deploys with no identity DB.
   */
  sharedProjects?: SharedProjectsResolver
  /**
   * M2.6 Ph5 — Neutron Connect member management (invite / badges / revoke).
   * When omitted, the `connect-invites` + `connect-members` routes return 501
   * `connect_not_configured`. Production wires this in `gateway/index.ts`
   * (owner box); gateway tests inject synthetic deps.
   */
  connect?: AppConnectSurfaceDeps
}

/** A connected member as the app renders it (owner|collaborator role badge). */
export interface ConnectMemberView {
  local_slug: string
  display_name: string
  role: 'owner' | 'collaborator'
  status: 'pending' | 'active' | 'revoked'
}

export type ConnectSurfaceFail = { ok: false; code: string; message: string; status: number }

/**
 * Owner-side Neutron Connect member-management deps (M2.6 Ph5). Each method owns
 * its own authz (owner/admin gate) + resolves the owner DB; the surface stays a
 * thin router. Revoke is owner-only (§ 11 LOCK).
 */
export interface AppConnectSurfaceDeps {
  invite: AppConnectInviteDeps
  listMembers: (input: {
    caller_user_id: string
    caller_instance_slug: string
    project_id: string
  }) => Promise<{ ok: true; members: ConnectMemberView[] } | ConnectSurfaceFail>
  revokeMember: (input: {
    caller_user_id: string
    caller_instance_slug: string
    project_id: string
    local_slug: string
  }) => Promise<{ ok: true; revoked: boolean } | ConnectSurfaceFail>
}

export interface AppProjectsSurface {
  handler: (req: Request) => Promise<Response | null>
}

const PATH_PREFIX = '/api/app/projects'
const LIST_PATH = '/api/app/projects'
const PATH_RE = /^\/api\/app\/projects\/([^/]+)\/settings$/
const INVITE_PATH_RE = /^\/api\/app\/projects\/([^/]+)\/invite$/
// M2.6 Ph5 — connect member-management routes.
const CONNECT_INVITES_RE = /^\/api\/app\/projects\/([^/]+)\/connect-invites$/
const CONNECT_MEMBERS_RE = /^\/api\/app\/projects\/([^/]+)\/connect-members$/
const CONNECT_REVOKE_RE = /^\/api\/app\/projects\/([^/]+)\/connect-members\/([^/]+)\/revoke$/

const ALLOWED_PATCH_FIELDS: ReadonlyArray<'privacy_mode'> = ['privacy_mode']
const ALLOWED_PATCH_FIELD_SET: ReadonlySet<string> = new Set(ALLOWED_PATCH_FIELDS)

export function createAppProjectsSurface(opts: AppProjectsSurfaceOptions): AppProjectsSurface {
  const { store, auth, invite, sharedProjects, connect } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (pathname !== PATH_PREFIX && !pathname.startsWith(`${PATH_PREFIX}/`)) {
        return null
      }
      const method = req.method

      // GET /api/app/projects — list endpoint (ISSUES #9).
      if (pathname === LIST_PATH) {
        if (method !== 'GET') {
          return jsonError(
            405,
            'method_not_allowed',
            `method '${method}' not allowed on /api/app/projects`,
          )
        }
        const resolved = await resolveBearer(req, auth)
        if ('code' in resolved) {
          return jsonError(401, resolved.code, resolved.message)
        }
        return handleList(store, resolved.project_slug, resolved.user_id, sharedProjects)
      }

      // POST /api/app/projects/<project_id>/invite — in-app invite
      // generation (M2.4).
      const inviteMatch = INVITE_PATH_RE.exec(pathname)
      if (inviteMatch !== null) {
        if (method !== 'POST') {
          return jsonError(
            405,
            'method_not_allowed',
            `method '${method}' not allowed on /invite`,
          )
        }
        const invite_project_id = sanitizeProjectId(inviteMatch[1] ?? '')
        if (invite_project_id === null) {
          return jsonError(400, 'invalid_project_id', 'project_id must be 1-128 chars from [A-Za-z0-9_.-]')
        }
        const resolved = await resolveBearer(req, auth)
        if ('code' in resolved) {
          return jsonError(401, resolved.code, resolved.message)
        }
        if (invite === undefined) {
          return jsonError(
            501,
            'invite_not_configured',
            'invite generation is not configured on this gateway',
          )
        }
        return handleInviteRoute(req, invite, resolved, invite_project_id)
      }

      // POST /api/app/projects/<id>/connect-invites (delivery: link|email).
      const connectInviteMatch = CONNECT_INVITES_RE.exec(pathname)
      if (connectInviteMatch !== null) {
        if (method !== 'POST') {
          return jsonError(405, 'method_not_allowed', `method '${method}' not allowed on /connect-invites`)
        }
        const cp = sanitizeProjectId(connectInviteMatch[1] ?? '')
        if (cp === null) {
          return jsonError(400, 'invalid_project_id', 'project_id must be 1-128 chars from [A-Za-z0-9_.-]')
        }
        const resolved = await resolveBearer(req, auth)
        if ('code' in resolved) return jsonError(401, resolved.code, resolved.message)
        if (connect === undefined) {
          return jsonError(501, 'connect_not_configured', 'Neutron Connect is not configured on this gateway')
        }
        return handleConnectInviteRoute(req, connect.invite, resolved, cp)
      }

      // M2.6 Ph5 — GET /api/app/projects/<id>/connect-members (badges).
      const connectMembersMatch = CONNECT_MEMBERS_RE.exec(pathname)
      if (connectMembersMatch !== null) {
        if (method !== 'GET') {
          return jsonError(405, 'method_not_allowed', `method '${method}' not allowed on /connect-members`)
        }
        const cp = sanitizeProjectId(connectMembersMatch[1] ?? '')
        if (cp === null) {
          return jsonError(400, 'invalid_project_id', 'project_id must be 1-128 chars from [A-Za-z0-9_.-]')
        }
        const resolved = await resolveBearer(req, auth)
        if ('code' in resolved) return jsonError(401, resolved.code, resolved.message)
        if (connect === undefined) {
          return jsonError(501, 'connect_not_configured', 'Neutron Connect is not configured on this gateway')
        }
        return handleConnectMembersRoute(connect, resolved, cp)
      }

      // M2.6 Ph5 — POST /api/app/projects/<id>/connect-members/<slug>/revoke (owner-only).
      const connectRevokeMatch = CONNECT_REVOKE_RE.exec(pathname)
      if (connectRevokeMatch !== null) {
        if (method !== 'POST') {
          return jsonError(405, 'method_not_allowed', `method '${method}' not allowed on /revoke`)
        }
        const cp = sanitizeProjectId(connectRevokeMatch[1] ?? '')
        const localSlug = (connectRevokeMatch[2] ?? '').trim()
        if (cp === null || localSlug.length === 0 || localSlug.length > 64) {
          return jsonError(400, 'invalid_request', 'project_id + member slug required')
        }
        const resolved = await resolveBearer(req, auth)
        if ('code' in resolved) return jsonError(401, resolved.code, resolved.message)
        if (connect === undefined) {
          return jsonError(501, 'connect_not_configured', 'Neutron Connect is not configured on this gateway')
        }
        return handleConnectRevokeRoute(connect, resolved, cp, localSlug)
      }

      // GET / PATCH /api/app/projects/<project_id>/settings.
      const match = PATH_RE.exec(pathname)
      if (match === null) return null
      const raw_project_id = match[1] ?? ''
      const project_id = sanitizeProjectId(raw_project_id)
      if (project_id === null) {
        return jsonError(400, 'invalid_project_id', 'project_id must be 1-128 chars from [A-Za-z0-9_.-]')
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonError(401, resolved.code, resolved.message)
      }

      if (method === 'GET') {
        return handleGet(store, resolved.project_slug, project_id)
      }
      if (method === 'PATCH') {
        return handlePatch(req, store, resolved.project_slug, project_id)
      }
      return jsonError(
        405,
        'method_not_allowed',
        `method '${method}' not allowed on /settings`,
      )
    },
  }
}

async function handleList(
  store: ProjectSettingsStore,
  project_slug: string,
  user_id: string,
  sharedProjects: SharedProjectsResolver | undefined,
): Promise<Response> {
  // Local solo projects — this owner's own DB. Always rendered, even
  // if the shared fan-out below fails entirely.
  const local = await store.list(project_slug)
  const soloItems: ProjectListItem[] = local.map((p) => ({
    ...p,
    kind: 'solo',
    origin_instance: project_slug,
    owning_instance_slug: project_slug,
  }))

  // No resolver wired → local-only (back-compat + graceful degradation).
  if (sharedProjects === undefined) {
    return jsonOk({ projects: soloItems, project_slug, source_errors: [] })
  }

  // Shared (cross-instance) half. The resolver already swallows per-workspace
  // failures into `source_errors`; we additionally guard the whole call so
  // a resolver-level throw (e.g. identity DB unreachable) still renders the
  // solo list rather than 500-ing the screen.
  let shared: SharedProjectsResult = { items: [], source_errors: [] }
  try {
    shared = await sharedProjects.fetch({ user_id, project_slug })
  } catch (err) {
    shared = {
      items: [],
      source_errors: [
        { workspace_instance_slug: '*', error: err instanceof Error ? err.message : 'aggregator_failed' },
      ],
    }
  }

  // Merge + dedup by (owning_instance_slug, id). Solo wins on collision (the
  // user's own copy is authoritative). Shared items carry only the
  // cross-instance projection, so the settings fields default to a member's
  // read-only view.
  const seen = new Set<string>(soloItems.map((p) => `${p.owning_instance_slug}|${p.id}`))
  const projects: ProjectListItem[] = [...soloItems]
  for (const item of shared.items) {
    const key = `${item.owning_instance_slug}|${item.project_id}`
    if (seen.has(key)) continue
    seen.add(key)
    projects.push(sharedItemToListItem(item))
  }

  return jsonOk({ projects, project_slug, source_errors: shared.source_errors })
}

/** Project a cross-instance `SharedProjectItem` into the unified list shape.
 *  A member sees the shared project's id/name; the settings drawer fields
 *  default to a read-only member view (the member doesn't own the origin
 *  instance's privacy/billing config), so they carry the canonical defaults. */
function sharedItemToListItem(item: SharedProjectItem): ProjectListItem {
  return {
    id: item.project_id,
    name: item.display_name,
    description: '',
    persona: '',
    privacy_mode: 'private',
    billing_mode: 'personal',
    members: [],
    kind: 'shared',
    origin_instance: item.owning_instance_slug,
    owning_instance_slug: item.owning_instance_slug,
  }
}

async function handleGet(
  store: ProjectSettingsStore,
  project_slug: string,
  project_id: string,
): Promise<Response> {
  const project = await store.get(project_slug, project_id)
  if (project === null) {
    return jsonError(404, 'project_not_found', `project_id=${project_id}`)
  }
  return jsonOk({ project, project_id, project_slug })
}

async function handlePatch(
  req: Request,
  store: ProjectSettingsStore,
  project_slug: string,
  project_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'malformed_json', 'expected a JSON object body')
  }
  const fields = body as Record<string, unknown>
  // Strict whitelist — surface a precise error so the client can fix
  // its request.
  for (const key of Object.keys(fields)) {
    if (!ALLOWED_PATCH_FIELD_SET.has(key)) {
      return jsonError(400, 'field_not_writable', `field '${key}' is not writable at P5.2`, {
        field: key,
      })
    }
  }
  if (!('privacy_mode' in fields)) {
    return jsonError(
      400,
      'empty_patch',
      'PATCH body must include at least one writable field (privacy_mode)',
    )
  }
  const raw = fields['privacy_mode']
  if (typeof raw !== 'string' || !ALL_PRIVACY_MODES.includes(raw as PrivacyMode)) {
    return jsonError(
      400,
      'invalid_privacy_mode',
      `privacy_mode must be one of: ${ALL_PRIVACY_MODES.join(', ')}`,
      { field: 'privacy_mode' },
    )
  }
  const updated = await store.update(project_slug, project_id, {
    privacy_mode: raw as PrivacyMode,
  })
  if (updated === null) {
    return jsonError(404, 'project_not_found', `project_id=${project_id}`)
  }
  return jsonOk({ project: updated, project_id, project_slug })
}

async function handleInviteRoute(
  req: Request,
  invite: AppProjectInviteDeps,
  resolved: ResolvedAuth,
  project_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'malformed_json', 'expected a JSON object body')
  }
  const fields = body as Record<string, unknown>
  const invitee_email = fields['invitee_email']
  if (typeof invitee_email !== 'string') {
    return jsonError(400, 'invalid_email', 'invitee_email (string) is required')
  }
  const result = await handleAppProjectInvite(
    {
      caller_user_id: resolved.user_id,
      caller_instance_slug: resolved.project_slug,
      project_id,
      invitee_email,
    },
    invite,
  )
  const status = httpStatusForInvite(result)
  if (result.status === 'created') {
    return jsonOk(
      {
        invite_url: result.invite_url,
        jti: result.jti,
        expires_at_ms: result.expires_at_ms,
        project_id,
      },
      status,
    )
  }
  return jsonError(status, result.code, result.reason)
}

async function handleConnectInviteRoute(
  req: Request,
  invite: AppConnectInviteDeps,
  resolved: ResolvedAuth,
  project_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'malformed_json', 'expected a JSON object body')
  }
  const fields = body as Record<string, unknown>
  // Delivery is a METHOD, not a tier (brief: connect-trust-class-collapse).
  // Defaults to 'link'. Both deliveries land the same role='collaborator'.
  const deliveryRaw = fields['delivery'] ?? 'link'
  if (deliveryRaw !== 'link' && deliveryRaw !== 'email') {
    return jsonError(400, 'invalid_request', "delivery must be 'link' or 'email'")
  }
  const scopeRaw = fields['scope']
  const scope: ConnectInviteScope = scopeRaw === 'read' ? 'read' : 'write'
  const result = await handleAppConnectInvite(
    {
      caller_user_id: resolved.user_id,
      caller_instance_slug: resolved.project_slug,
      project_id,
      delivery: deliveryRaw as ConnectInviteDelivery,
      scope,
      ...(typeof fields['ttl_ms'] === 'number' ? { ttl_ms: fields['ttl_ms'] as number } : {}),
      ...(typeof fields['invitee_email'] === 'string'
        ? { invitee_email: fields['invitee_email'] as string }
        : {}),
    },
    invite,
  )
  const status = httpStatusForConnectInvite(result)
  if (result.status === 'created') {
    return jsonOk(
      {
        delivery: result.delivery,
        accept_url: result.accept_url,
        expires_at_ms: result.expires_at_ms,
        scope: result.scope,
        ...(result.delivery === 'email' ? { jti: result.jti } : {}),
        project_id,
      },
      status,
    )
  }
  return jsonError(status, result.code, result.reason)
}

async function handleConnectMembersRoute(
  connect: AppConnectSurfaceDeps,
  resolved: ResolvedAuth,
  project_id: string,
): Promise<Response> {
  const result = await connect.listMembers({
    caller_user_id: resolved.user_id,
    caller_instance_slug: resolved.project_slug,
    project_id,
  })
  if (!result.ok) {
    return jsonError(result.status, result.code, result.message)
  }
  return jsonOk({ members: result.members, project_id })
}

async function handleConnectRevokeRoute(
  connect: AppConnectSurfaceDeps,
  resolved: ResolvedAuth,
  project_id: string,
  local_slug: string,
): Promise<Response> {
  const result = await connect.revokeMember({
    caller_user_id: resolved.user_id,
    caller_instance_slug: resolved.project_slug,
    project_id,
    local_slug,
  })
  if (!result.ok) {
    return jsonError(result.status, result.code, result.message)
  }
  return jsonOk({ revoked: result.revoked, project_id, local_slug })
}

interface ResolvedAuth {
  user_id: string
  project_slug: string
}

interface AuthFailure {
  code: string
  message: string
}

async function resolveBearer(
  req: Request,
  auth: AppWsAuthResolver,
): Promise<ResolvedAuth | AuthFailure> {
  const header = req.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) {
    return { code: 'missing_bearer', message: 'expected Authorization: Bearer <token>' }
  }
  const token = header.slice('bearer '.length).trim()
  const resolved = await auth.resolve(token)
  if ('code' in resolved) return { code: resolved.code, message: resolved.message }
  return { user_id: resolved.user_id, project_slug: resolved.project_slug }
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

function jsonOk(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({ ok: false, code, message, ...extra }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  )
}
