/**
 * @neutronai/gateway/http — Expo-app admin surface (P5.7).
 *
 * Per SPEC.md § Phases→Steps / P5.7
 *   "Admin tab. Personality edit, gateway reboot (Open), GBrain
 *    browse, connector admin."
 *
 * Owns three routes (plus the P7.4 Phase 2 `/project-backup/*` family
 * documented further down):
 *
 *   - `POST /api/app/admin/gateway/restart`    Open-tier process-restart trigger
 *   - `GET  /api/app/admin/memory`             read-only browse (stats + top-K recent)
 *   - `GET  /api/app/admin/connectors`         installed-Cores list
 *   - `POST /api/app/admin/max-oauth/mint-reauth-token`
 *                                              mint a fresh start_token JWT so an
 *                                              already-authed owner can swap their
 *                                              attached Claude Max credential
 *                                              without operator SQL (2026-06-01).
 *
 * Personality editing moved to the dedicated `/api/app/persona/*`
 * surface at `gateway/http/admin-personality-surface.ts` (PR #280,
 * 2026-05-22). ISSUE #31 (2026-05-23) ripped out the legacy
 * `/personality` GET + PUT routes and the vestigial tone/style
 * companion file the runtime never read — the deleted route now
 * falls through to the surface's default `unknown_admin_route` 404.
 *
 * All routes are bearer-authed via the shared `AppWsAuthResolver` so
 * the dev-bypass + HS256 paths used by the P5.1 chat surface and the
 * P5.3 / P5.4 surfaces cover this one identically.
 *
 * Storage:
 *   - Gateway restart on Open tier: invokes the injected `restartGateway`
 *     callback (defaults to `process.kill(process.pid, 'SIGTERM')`,
 *     letting systemd/Restart=always bring the unit back). On Managed
 *     tier the route returns 503 + a stable code so the Expo client can
 *     redirect the user to the Managed dashboard's own /admin/restart.
 *   - GBrain browse: read-only stats + top-K recent entries via
 *     the injected `MemoryStore`. When the store dep is unwired
 *     (Open self-hoster without a GBrain MCP), the route returns a
 *     `{ configured: false }` envelope so the Expo client can render a
 *     "not configured" empty state.
 *   - Connectors: `CoreInstallationsStore.listForProject`. When the
 *     store dep is unwired (legacy boot before the Cores runtime is
 *     composed), returns an empty list with `configured: false`.
 *
 * v1 explicitly out-of-scope (deferred to follow-up sprints):
 *   - bulk Core operations (install/uninstall/upgrade from the UI),
 *   - gateway version upgrade UI,
 *   - GBrain edit / delete entries,
 *   - persona-template marketplace,
 *   - multi-instance admin (one instance per Expo session in v1).
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { CoreInstallationsStore } from '@neutronai/cores-runtime/installations-store.ts'
import type { MemoryStore } from '@neutronai/gbrain-memory/memory-store.ts'
import type { ProjectBackupStore } from '../git/project-backup-store.ts'
import { defaultEnumerateProjects } from '../projects/enumerate.ts'
import {
  jsonError,
  jsonOk,
  jsonResponse,
  ownerSlugMismatch,
  readJsonBody,
  resolveBearer,
} from './surface-kit.ts'
import { PlatformOperationUnsupportedError, type PlatformAdapter } from '@neutronai/runtime/platform-adapter.ts'

/** Maximum number of GBrain entries returned by the browse endpoint. */
export const MAX_MEMORY_RECENT = 20

/** Deployment tier — controls whether the restart route is allowed to
 *  signal the local process or must redirect to a Managed-side route. */
export type DeploymentTier = 'open' | 'managed'

export interface AppAdminSurfaceOptions {
  auth: AppWsAuthResolver
  /** Absolute path to the per-instance home dir (`<owner_home>`). */
  owner_home: string
  /** Per-instance slug — recorded into restart events + cross-checks. */
  project_slug: string
  /** Open vs Managed. Open processes self-signal SIGTERM; Managed
   *  returns 503 + redirect-hint so the Expo client uses the existing
   *  Managed admin surface. */
  tier?: DeploymentTier
  /**
   * Override the in-process restart action. Production wires the
   * default (`process.kill(process.pid, 'SIGTERM')`); tests inject a
   * spy so the suite can assert the route invoked the action without
   * killing the test runner.
   */
  restartGateway?: () => void
  /** Cores installations — when unset, the connectors endpoint
   *  returns `{ configured: false, connectors: [] }`. */
  coresStore?: CoreInstallationsStore
  /** GBrain memory store — when unset, the memory endpoint
   *  returns `{ configured: false, entries: [] }`. */
  memoryStore?: MemoryStore
  /** P7.4 Phase 2 — project-backup store; when unset, the
   *  `/project-backup/*` routes return `{ configured: false }` so
   *  the admin UI hides the Backup tab. */
  projectBackupStore?: ProjectBackupStore
  /** P7.4 Phase 2 — platform adapter (used for configure/disconnect/
   *  generate-keypair routes). When unset, those routes return 503. */
  platform?: PlatformAdapter
  /** P7.4 Phase 2 — enumerate the projects on this instance for the
   *  Backup sub-tab's per-project card list. Defaults to reading the
   *  filesystem under `<owner_home>/Projects/`. */
  enumerateProjects?: () => Promise<string[]>
  /**
   * Switch-Max-account sprint (2026-06-01) — mint a fresh start_token
   * JWT bound to the resolved bearer's user_id + this gateway's
   * project_slug. Returns the signed token string on success, or null
   * when the identity-side signing-key resolution fails (no
   * NEUTRON_AUTH_DB_PATH wired, key rotated out, DB closed, etc.).
   *
   * Wired in `gateway/index.ts` alongside the existing
   * `mintStartToken` closure (same KeyManager + instances
   * registry dependencies). When undefined the mint-reauth endpoint
   * returns 503 + `reauth_not_configured` so the Expo client can
   * surface a clear "this deployment doesn't support in-app Max
   * swap" message instead of a generic error.
   *
   * The TTL is short (5 min — fixed in the closure) so a leaked
   * paste URL becomes unusable quickly. A new token is minted on
   * every call; idempotency is not required because the start-token
   * JTI is single-use (the verifier rejects replays on the identity
   * side).
   */
  mintReauthStartToken?: (user_id: string) => Promise<string | null>
  /**
   * Identity service base URL as seen by the user's browser (e.g.
   * `https://auth.example.test`). Used to construct the paste
   * URL `<identity>/oauth/max/start` with the instance slug, return URL, and start token as query params.
   * Required when `mintReauthStartToken` is wired; the surface
   * returns 503 if either is missing.
   */
  identityPublicBaseUrl?: string
  /**
   * Default return URL the user lands on after pasting the fresh
   * Max token (typically the per-instance chat URL, e.g.
   * `https://<slug>.<base_domain>/chat`). Used when the request body
   * omits `return_url`. Required when `mintReauthStartToken` is wired.
   */
  defaultReauthReturnUrl?: string
  /**
   * Operator-configured extra hosts the optional `return_url`
   * override is allowed to point at, on top of the built-in
   * configured-base-domain (`*.<base-domain>`) + localhost allowlist. Same shape as
   * `NEUTRON_MAX_OAUTH_RETURN_HOSTS` / `NEUTRON_RETURN_URL_EXTRA_HOSTS`
   * (comma-separated list of exact hostnames; a leading `.` opts in
   * for any subdomain of that suffix).
   *
   * Defaults to an empty list so an unconfigured deployment only
   * accepts platform-owned hosts. A bad override returns 400
   * `invalid_return_url` and never reaches the start-token mint, so
   * the paste URL can never 302 a user to an attacker-controlled
   * destination.
   */
  extraReauthReturnHosts?: ReadonlyArray<string>
  /** Override `Date.now` for deterministic tests. */
  now?: () => number
}

export interface AppAdminSurface {
  /**
   * HTTP route dispatcher. Returns the `Response` for an owned route,
   * or `null` to indicate the request belongs to a sibling surface so
   * `compose.ts` falls through to the downstream chain.
   */
  handler: (req: Request) => Promise<Response | null>
}

const PATH_PREFIX = '/api/app/admin'

export function createAppAdminSurface(opts: AppAdminSurfaceOptions): AppAdminSurface {
  const {
    auth,
    owner_home,
    project_slug,
    tier = 'open',
    coresStore,
    memoryStore,
    projectBackupStore,
    platform,
    enumerateProjects,
    mintReauthStartToken,
    identityPublicBaseUrl,
    defaultReauthReturnUrl,
    extraReauthReturnHosts,
  } = opts
  const restartGateway = opts.restartGateway ?? defaultRestartGateway
  const now = opts.now ?? ((): number => Date.now())
  // Lazy-imported default that reads `<owner_home>/Projects/`.
  const resolveEnumerate = enumerateProjects ?? defaultEnumerateProjects(owner_home)
  const reauthExtraHosts = extraReauthReturnHosts ?? []

  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!pathname.startsWith(PATH_PREFIX)) return null

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonError(401, resolved.code, resolved.message)
      }
      // Instance-boundary safety. The per-instance gateway opens with a fixed
      // `project_slug`; a bearer that resolves to a different slug must
      // not be allowed to read or mutate this instance's persona or
      // connectors. Match the per-project DB's instance-boundary contract.
      if (ownerSlugMismatch(resolved.project_slug, project_slug)) {
        return jsonError(
          403,
          'project_mismatch',
          `bearer project '${resolved.project_slug}' does not match gateway project '${project_slug}'`,
        )
      }

      const method = req.method
      const route = pathname.slice(PATH_PREFIX.length)

      // NOTE — `/personality` (legacy `GET` + `PUT`) is intentionally
      // removed (ISSUE #31, 2026-05-23). Requests now fall through to
      // the surface's default `unknown_admin_route` 404 at the bottom
      // of this dispatcher. The canonical persona-edit surface is the
      // sibling `/api/app/persona/*` (admin-personality-surface.ts).

      if (route === '/gateway/restart') {
        if (method === 'POST') {
          return handleGatewayRestart({
            tier,
            project_slug,
            restartGateway,
            now,
          })
        }
        return jsonError(
          405,
          'method_not_allowed',
          `method '${method}' not allowed on /gateway/restart`,
        )
      }
      if (route === '/memory') {
        if (method === 'GET') return await handleMemory(memoryStore)
        return jsonError(405, 'method_not_allowed', `method '${method}' not allowed on /memory`)
      }
      if (route === '/connectors') {
        if (method === 'GET') return await handleConnectors(coresStore, project_slug)
        return jsonError(405, 'method_not_allowed', `method '${method}' not allowed on /connectors`)
      }
      // Switch-Max-account sprint (2026-06-01) — mint a fresh
      // start_token JWT so an already-authed owner can re-paste a
      // different Claude Max token from the admin UI without operator
      // SQL. Auth is the same bearer the rest of /api/app/admin/* uses
      // (already enforced above); the route just composes the existing
      // identity-side paste-token form URL from the freshly-minted JWT.
      if (route === '/max-oauth/mint-reauth-token') {
        if (method === 'POST') {
          return await handleMintReauthToken({
            req,
            project_slug,
            user_id: resolved.user_id,
            mintReauthStartToken,
            identityPublicBaseUrl,
            defaultReauthReturnUrl,
            extraReauthReturnHosts: reauthExtraHosts,
          })
        }
        return jsonError(
          405,
          'method_not_allowed',
          `method '${method}' not allowed on /max-oauth/mint-reauth-token`,
        )
      }
      // P7.4 Phase 2 — project-backup routes.
      if (route === '/project-backup/projects') {
        if (method === 'GET') {
          return await handleListProjectBackupProjects({
            store: projectBackupStore,
            enumerateProjects: resolveEnumerate,
          })
        }
        return jsonError(
          405,
          'method_not_allowed',
          `method '${method}' not allowed on /project-backup/projects`,
        )
      }
      const projectBackupMatch = route.match(
        /^\/project-backup\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/(status|configure|disconnect-remote|run-now|generate-keypair)$/,
      )
      if (projectBackupMatch !== null) {
        const project_id = projectBackupMatch[1]!
        const subroute = projectBackupMatch[2]!
        if (subroute === 'status' && method === 'GET') {
          return await handleProjectBackupStatus({
            project_id,
            store: projectBackupStore,
          })
        }
        if (subroute === 'configure' && method === 'POST') {
          return await handleProjectBackupConfigure({
            project_id,
            store: projectBackupStore,
            platform,
            req,
          })
        }
        if (subroute === 'disconnect-remote' && method === 'POST') {
          return await handleProjectBackupDisconnect({
            project_id,
            store: projectBackupStore,
            platform,
          })
        }
        if (subroute === 'run-now' && method === 'POST') {
          return await handleProjectBackupRunNow({
            project_id,
            store: projectBackupStore,
          })
        }
        if (subroute === 'generate-keypair' && method === 'POST') {
          return await handleProjectBackupGenerateKeypair({
            project_id,
            platform,
          })
        }
        return jsonError(
          405,
          'method_not_allowed',
          `method '${method}' not allowed on /project-backup/${project_id}/${subroute}`,
        )
      }
      return jsonError(404, 'unknown_admin_route', `no admin route at '${pathname}'`)
    },
  }
}

interface GatewayRestartInput {
  tier: DeploymentTier
  project_slug: string
  restartGateway: () => void
  now: () => number
}

function handleGatewayRestart(input: GatewayRestartInput): Response {
  if (input.tier === 'managed') {
    // The Managed control plane already exposes `/admin/restart` on
    // the per-instance gateway, gated by a different auth path (operator-
    // bearer rather than user-bearer). The Expo client renders the
    // returned `redirect_hint` so the user knows where to go.
    return jsonResponse(503, {
      ok: false,
      code: 'restart_not_supported_on_managed',
      message:
        'gateway restart on Managed is routed via the managed control plane; use the dashboard /admin/restart endpoint',
      redirect_hint: '/admin/restart',
    })
  }
  // Open tier — signal the process. `setImmediate` defers the actual
  // kill so the HTTP response can be flushed before the process exits.
  // Tests inject a spy and assert it was called.
  const triggered_at = input.now()
  setImmediate(() => {
    try {
      input.restartGateway()
    } catch (err) {
      // The restart action should not throw in production; log and
      // surface to stderr so an operator can spot a misconfigured
      // supervisor.
      console.error(
        `[app-admin] project=${input.project_slug} gateway restart action failed`,
        err,
      )
    }
  })
  return jsonOk({
    triggered: true,
    triggered_at,
    tier: input.tier,
    project_slug: input.project_slug,
  })
}

interface MemoryEntry {
  id: string
  content_preview: string
  score: number
}

interface MemoryBody {
  configured: boolean
  stats: { count: number; size_bytes: number } | null
  entries: MemoryEntry[]
}

async function handleMemory(memoryStore: MemoryStore | undefined): Promise<Response> {
  if (memoryStore === undefined) {
    const body: MemoryBody = {
      configured: false,
      stats: null,
      entries: [],
    }
    return jsonOk(body)
  }
  // Reuse a permissive query so the surface returns the most recent /
  // top-relevance items without requiring the client to specify one.
  // Backends that don't support empty queries can ignore the call and
  // return `[]`; we don't fail the whole route on either branch.
  let entries: MemoryEntry[] = []
  try {
    const rows = await memoryStore.query({ query: '', limit: MAX_MEMORY_RECENT })
    entries = rows.slice(0, MAX_MEMORY_RECENT).map((r) => ({
      id: r.id,
      content_preview: r.content.length > 280 ? r.content.slice(0, 280) + '…' : r.content,
      score: r.score,
    }))
  } catch (err) {
    console.warn(`[app-admin] memoryStore.query failed`, err)
  }
  let stats: { count: number; size_bytes: number } | null = null
  try {
    stats = await memoryStore.stats()
  } catch (err) {
    console.warn(`[app-admin] memoryStore.stats failed`, err)
  }
  const body: MemoryBody = {
    configured: true,
    stats,
    entries,
  }
  return jsonOk(body)
}

interface ConnectorListItem {
  slug: string
  package_name: string
  package_version: string
  data_layout: 'tables' | 'sidecar'
  installed_at: number
  started_at: number | null
  uninstalled_at: number | null
  capabilities: string[]
}

interface ConnectorsBody {
  configured: boolean
  connectors: ConnectorListItem[]
}

async function handleConnectors(
  coresStore: CoreInstallationsStore | undefined,
  project_slug: string,
): Promise<Response> {
  if (coresStore === undefined) {
    const body: ConnectorsBody = { configured: false, connectors: [] }
    return jsonOk(body)
  }
  const records = await coresStore.listForProject(project_slug)
  const connectors: ConnectorListItem[] = records
    .filter((r) => r.uninstalled_at === null)
    .map((r) => ({
      slug: r.core_slug,
      package_name: r.package_name,
      package_version: r.package_version,
      data_layout: r.data_layout,
      installed_at: r.installed_at,
      started_at: r.started_at,
      uninstalled_at: r.uninstalled_at,
      capabilities: r.capabilities,
    }))
  const body: ConnectorsBody = { configured: true, connectors }
  return jsonOk(body)
}

// ─── P7.4 Phase 2 — project-backup admin handlers ────────────────────

interface ProjectBackupListBody {
  configured: boolean
  projects: Array<{ project_id: string }>
}

async function handleListProjectBackupProjects(opts: {
  store: ProjectBackupStore | undefined
  enumerateProjects: () => Promise<string[]>
}): Promise<Response> {
  if (opts.store === undefined) {
    const body: ProjectBackupListBody = { configured: false, projects: [] }
    return jsonOk(body)
  }
  let projects: string[] = []
  try {
    projects = await opts.enumerateProjects()
  } catch (err) {
    console.warn(`[app-admin] project-backup enumerate failed`, err)
  }
  const body: ProjectBackupListBody = {
    configured: true,
    projects: projects.map((p) => ({ project_id: p })),
  }
  return jsonOk(body)
}

async function handleProjectBackupStatus(opts: {
  project_id: string
  store: ProjectBackupStore | undefined
}): Promise<Response> {
  if (opts.store === undefined) {
    return jsonError(503, 'backup_unavailable', 'project-backup substrate not configured on this gateway')
  }
  const status = await opts.store.getStatus(opts.project_id)
  return jsonOk({ status })
}

async function handleProjectBackupConfigure(opts: {
  project_id: string
  store: ProjectBackupStore | undefined
  platform: PlatformAdapter | undefined
  req: Request
}): Promise<Response> {
  if (opts.store === undefined || opts.platform === undefined) {
    return jsonError(503, 'backup_unavailable', 'project-backup substrate not configured on this gateway')
  }
  if (opts.platform.capabilities.project_backup !== true) {
    return jsonError(503, 'backup_unavailable', 'platform adapter does not expose project_backup capability')
  }
  const body = await readJsonBody(opts.req)
  if (body === null) {
    return jsonError(400, 'malformed_json', 'expected JSON body')
  }
  const fields = body as Record<string, unknown>
  const remote_url = fields['remote_url']
  if (typeof remote_url !== 'string') {
    return jsonError(400, 'invalid_remote_url', 'remote_url must be a string')
  }
  const ssh_key_pem = typeof fields['ssh_key_pem'] === 'string' ? (fields['ssh_key_pem'] as string) : undefined
  const generated_key_request_id =
    typeof fields['generated_key_request_id'] === 'string'
      ? (fields['generated_key_request_id'] as string)
      : undefined
  try {
    const input: { remote_url: string; ssh_key_pem?: string; generated_key_request_id?: string } = {
      remote_url,
    }
    if (ssh_key_pem !== undefined) input.ssh_key_pem = ssh_key_pem
    if (generated_key_request_id !== undefined)
      input.generated_key_request_id = generated_key_request_id
    const config = await opts.platform.setProjectBackupRemoteConfig(opts.project_id, input)
    // Immediately run a validation backup so the user knows whether
    // their wiring works. Even when push fails (the most common
    // failure mode on a fresh remote), the local commit lands and
    // the status reflects the error.
    const backup = await opts.store.backupNow(opts.project_id)
    return jsonOk({ remote: config, backup })
  } catch (err) {
    if (err instanceof PlatformOperationUnsupportedError) {
      return jsonResponse(405, {
        ok: false,
        code: 'managed_auto_provisioned',
        message: err.message,
      })
    }
    return jsonError(400, 'configure_failed', err instanceof Error ? err.message : String(err))
  }
}

async function handleProjectBackupDisconnect(opts: {
  project_id: string
  store: ProjectBackupStore | undefined
  platform: PlatformAdapter | undefined
}): Promise<Response> {
  if (opts.platform === undefined) {
    return jsonError(503, 'backup_unavailable', 'project-backup substrate not configured on this gateway')
  }
  try {
    await opts.platform.clearProjectBackupRemoteConfig(opts.project_id)
    return jsonOk({ disconnected: true })
  } catch (err) {
    if (err instanceof PlatformOperationUnsupportedError) {
      return jsonResponse(405, {
        ok: false,
        code: 'managed_auto_provisioned',
        message: err.message,
      })
    }
    return jsonError(400, 'disconnect_failed', err instanceof Error ? err.message : String(err))
  }
}

async function handleProjectBackupRunNow(opts: {
  project_id: string
  store: ProjectBackupStore | undefined
}): Promise<Response> {
  if (opts.store === undefined) {
    return jsonError(503, 'backup_unavailable', 'project-backup substrate not configured on this gateway')
  }
  const result = await opts.store.backupNow(opts.project_id)
  return jsonOk({
    backup: {
      commit_sha: result.commit_sha,
      pushed: result.pushed,
      push_error: result.push_error,
      completed_at: new Date(result.completed_at_ms).toISOString(),
    },
  })
}

async function handleProjectBackupGenerateKeypair(opts: {
  project_id: string
  platform: PlatformAdapter | undefined
}): Promise<Response> {
  if (opts.platform === undefined) {
    return jsonError(503, 'backup_unavailable', 'project-backup substrate not configured on this gateway')
  }
  try {
    const result = await opts.platform.generateProjectBackupKeypair(opts.project_id)
    return jsonOk({
      request_id: result.request_id,
      public_key: result.public_key,
      expires_at: new Date(result.expires_at_ms).toISOString(),
    })
  } catch (err) {
    if (err instanceof PlatformOperationUnsupportedError) {
      return jsonResponse(405, {
        ok: false,
        code: 'managed_auto_provisioned',
        message: err.message,
      })
    }
    return jsonError(400, 'generate_failed', err instanceof Error ? err.message : String(err))
  }
}

// ─── (end of P7.4 Phase 2 handlers) ─────────────────────────────────

// ─── Switch-Max-account mint-reauth-token handler (2026-06-01) ─────

interface MintReauthInput {
  req: Request
  project_slug: string
  user_id: string
  mintReauthStartToken: ((user_id: string) => Promise<string | null>) | undefined
  identityPublicBaseUrl: string | undefined
  defaultReauthReturnUrl: string | undefined
  extraReauthReturnHosts: ReadonlyArray<string>
}

async function handleMintReauthToken(input: MintReauthInput): Promise<Response> {
  if (
    input.mintReauthStartToken === undefined ||
    input.identityPublicBaseUrl === undefined ||
    input.identityPublicBaseUrl.length === 0 ||
    input.defaultReauthReturnUrl === undefined ||
    input.defaultReauthReturnUrl.length === 0
  ) {
    return jsonError(
      503,
      'reauth_not_configured',
      'in-app Max OAuth re-auth is not wired on this gateway (requires identity DB + base URL + default return URL)',
    )
  }
  const body = await readJsonBody(input.req)
  // An empty/absent body is fine — `return_url` is optional.
  const rawReturnUrl =
    body !== null && typeof body === 'object'
      ? ((body as Record<string, unknown>)['return_url'] ?? null)
      : null
  let returnUrl = input.defaultReauthReturnUrl
  if (typeof rawReturnUrl === 'string' && rawReturnUrl.length > 0) {
    // C2 boundary closure — the validator was lifted out of the Managed
    // identity tree into Open `runtime/return-url-validator.ts` (it has
    // no I/O — pure URL parsing + allowlist checks), so this Open
    // surface no longer holds an open→managed edge. Dynamic import kept
    // for lazy-load parity with the prior shape.
    const { validateReturnUrl } = await import('@neutronai/runtime/return-url-validator.ts')
    const validation = validateReturnUrl(rawReturnUrl, {
      extraHosts: input.extraReauthReturnHosts,
    })
    if (!validation.ok) {
      return jsonError(
        400,
        'invalid_return_url',
        `return_url '${rawReturnUrl}' is not on the allowlist (reason=${validation.reason})`,
      )
    }
    returnUrl = validation.url.toString()
  } else if (rawReturnUrl !== null && typeof rawReturnUrl !== 'string') {
    return jsonError(400, 'invalid_return_url', 'return_url must be a string when provided')
  }
  const token = await input.mintReauthStartToken(input.user_id)
  if (token === null || token.length === 0) {
    return jsonError(
      500,
      'mint_failed',
      'failed to mint a fresh start_token (identity signing key unavailable)',
    )
  }
  let pasteUrl: URL
  try {
    pasteUrl = new URL('/oauth/max/start', input.identityPublicBaseUrl)
  } catch {
    return jsonError(
      500,
      'invalid_identity_base_url',
      `identityPublicBaseUrl='${input.identityPublicBaseUrl}' is not a valid URL`,
    )
  }
  pasteUrl.searchParams.set('owner', input.project_slug)
  pasteUrl.searchParams.set('return', returnUrl)
  pasteUrl.searchParams.set('start_token', token)
  // `force=1` opts out of the identity-side "short-circuit when the
  // owner already has a healthy Max token" branch (see
  // `identity/oauth/max-handoff.ts:handleStart` ~line 534). The whole
  // POINT of the re-auth flow is to swap to a DIFFERENT Max account;
  // without `force=1` an already-healthy stored token would silently
  // 302 the user back to `return_url` and never render the paste form.
  pasteUrl.searchParams.set('force', '1')
  console.info(
    `[admin] max_oauth_reauth_minted project=${input.project_slug} user=${input.user_id}`,
  )
  return jsonOk({ paste_url: pasteUrl.toString() })
}

// ─── (end of switch-Max-account handler) ────────────────────────────

function defaultRestartGateway(): void {
  // SIGTERM lets a systemd unit with `Restart=always` bring the gateway
  // back. Tests inject a spy so this branch never fires in CI.
  process.kill(process.pid, 'SIGTERM')
}
