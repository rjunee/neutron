/**
 * @neutronai/gateway/http — credential CRUD surface (project Settings + Admin).
 *
 * The owner-facing read+write path for per-project / global service
 * credentials (static long-lived tokens: Meta Ads, Google Ads, Apify, …).
 *
 * ── THE ROUTE *IS* THE SCOPE (ISSUES #486) ──────────────────────────────────
 * Two route families, one per scope, mirroring `codex-credential-surface.ts`:
 *
 *   GLOBAL (the Admin tab — instance-wide defaults):
 *   - `GET    /api/app/credentials`            list the global defaults
 *   - `POST   /api/app/credentials`            set a global default
 *   - `DELETE /api/app/credentials/<service>`  delete a global default
 *
 *   PROJECT (a project's Settings tab — this project only):
 *   - `GET    /api/app/projects/<project_id>/credentials`            list (project + inherited global)
 *   - `POST   /api/app/projects/<project_id>/credentials`            set THIS PROJECT's credential
 *   - `DELETE /api/app/projects/<project_id>/credentials/<service>`  delete THIS PROJECT's credential
 *
 * The project family CANNOT write instance-wide state. It used to: a `scope`
 * field in the POST body (and `?scope=global` on the DELETE) let a caller
 * standing inside ONE project silently rewrite the default EVERY other project
 * inherits — two writers for one fact. The project routes now reject
 * `scope: 'global'` outright (HTTP 400 `scope_not_allowed`) rather than
 * quietly downgrading it, so a stale client gets an error it can show instead
 * of a write that lands somewhere the user was not looking. The project GET
 * still RETURNS the inherited globals: reading them where you use them is the
 * useful part; authoring them from there was the defect.
 *
 * Bearer-authed via the shared `AppWsAuthResolver` (same dev-bypass + HS256
 * paths as the work-board / tabs / tasks surfaces). It dispatches the SAME
 * `ProjectCredentialStore` the resolver + the per-turn awareness injection use.
 *
 * ── Scope keying (the leak-gate) ────────────────────────────────────────────
 * `owner_slug` (the owner boundary) is ALWAYS the SERVER-derived
 * `resolved.project_slug` from the bearer — never client-supplied — so a caller
 * can only ever read/write credentials WITHIN their own owner boundary. The
 * `<project_id>` path segment IS authoritative as the per-project SUB-key (it is
 * the real project id, the same one the Cores segment by), but only underneath
 * that server-derived owner boundary. A project-scoped write lands under
 * (owner_slug, sanitized-url-project_id); a global write lands under
 * (owner_slug, '' sentinel). `list` returns METADATA ONLY — ciphertext and
 * plaintext never leave the store.
 *
 * ── Per-project connected-account selection (#500) ──────────────────────────
 * The surface also owns `/api/app/projects/<id>/accounts` — GET the view (every
 * selectable service, every connected account, whether this project reads it),
 * PUT one toggle. CONNECTING an account stays global and is unchanged: one
 * consent, one refresh token, one thing to rotate. Only SELECTION is
 * per-project, which is why it lives on a project route rather than in Admin —
 * it is the counterpart to #486, not a regression of it. No secret material is
 * read or written by that family; the id it toggles is the resolver's own
 * `account_id`, and the owner is shown a humanised label, never the hex key.
 */

import { asOwnerHandle, type OwnerHandle } from '@neutronai/persistence/index.ts'
import { sanitizeProjectId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import {
  ProjectCredentialValidationError,
  PROJECT_CREDENTIAL_MIN_SECRET_CHARS,
  type CredentialScope,
  type ProjectCredentialStore,
} from '@neutronai/project-credentials/store.ts'
import {
  AccountSelectionValidationError,
  type ProjectAccountSelectionStore,
} from '@neutronai/project-credentials/account-selection-store.ts'
import type { ServiceAccountSelection } from '../cores/core-credential-resolver.ts'
import { jsonError, jsonOk, readJsonBody, resolveBearer } from './surface-kit.ts'

/**
 * The read side of the per-project account selection (#500), typed
 * structurally so this surface depends on the CAPABILITY rather than on the
 * whole `CoreCredentialResolver`. Satisfied by `CoreCredentialResolver`.
 */
export interface AccountSelectionReader {
  accountSelectionView(projectId: string): Promise<ServiceAccountSelection[]>
}

export interface ProjectCredentialsSurfaceOptions {
  store: ProjectCredentialStore
  auth: AppWsAuthResolver
  /** Writes the per-project connected-account selection (#500). */
  accountSelection: ProjectAccountSelectionStore
  /**
   * Reads it back joined with the LIVE connected accounts — the same resolver
   * the Cores read through, so the toggles shown are the accounts swept.
   */
  credentialResolver: AccountSelectionReader
}

export interface ProjectCredentialsSurface {
  /**
   * HTTP route dispatcher. Returns the `Response` for an owned route, or
   * `null` so `compose.ts` falls through to the downstream chain.
   */
  handler: (req: Request) => Promise<Response | null>
}

const PROJECT_PATH_PREFIX = '/api/app/projects/'
const PROJECT_CREDENTIALS_PATH_RE =
  /^\/api\/app\/projects\/([^/]+)\/credentials(?:\/([^/]+))?$/
/** The GLOBAL family — no project segment, because there is no project. */
const GLOBAL_PATH_PREFIX = '/api/app/credentials'
const GLOBAL_CREDENTIALS_PATH_RE = /^\/api\/app\/credentials(?:\/([^/]+))?$/
/**
 * Per-project CONNECTED-ACCOUNT selection (#500). Genuinely project-scoped —
 * it authors no instance-wide state, which is what makes it the correct
 * counterpart to #486 rather than a regression of it: #486 moved GLOBAL
 * credential authoring out of a project surface; this puts a setting that can
 * only ever mean something inside one project back where it belongs.
 */
const PROJECT_ACCOUNTS_PATH_RE = /^\/api\/app\/projects\/([^/]+)\/accounts$/

const MAX_SERVICE_SEGMENT_LEN = 128

/**
 * The 400 a project-scoped caller gets for asking to write instance-wide
 * state. Deliberately NOT a silent downgrade to project scope: a client that
 * still sends the old `scope: 'global'` is asking for something this route
 * cannot do, and saying so is what stops the write landing somewhere the user
 * was not looking.
 */
const SCOPE_NOT_ALLOWED =
  'global credentials are set in General → Admin, not from inside a project'

export function createProjectCredentialsSurface(
  opts: ProjectCredentialsSurfaceOptions,
): ProjectCredentialsSurface {
  const { store, auth, accountSelection, credentialResolver } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname

      // ── Per-project connected-account selection (#500) ──────────────────
      const accountsMatch = PROJECT_ACCOUNTS_PATH_RE.exec(pathname)
      if (accountsMatch !== null) {
        const sanitized = sanitizeProjectId(accountsMatch[1] ?? '')
        if (sanitized === null) {
          return jsonError(
            400,
            'invalid_project_id',
            'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
          )
        }
        const auth_result = await resolveBearer(req, auth)
        if ('code' in auth_result) {
          return jsonError(401, auth_result.code, auth_result.message)
        }
        return handleAccounts({
          req,
          project_id: sanitized,
          owner_slug: asOwnerHandle(auth_result.project_slug),
          accountSelection,
          credentialResolver,
        })
      }

      // Resolve the SCOPE from the path before anything else — the route is the
      // scope, and no request body or query param can move a call between them.
      let project_id: string | null
      let raw_service: string
      if (pathname.startsWith(GLOBAL_PATH_PREFIX)) {
        const match = GLOBAL_CREDENTIALS_PATH_RE.exec(pathname)
        if (match === null) return null
        project_id = null
        raw_service = match[1] ?? ''
      } else if (pathname.startsWith(PROJECT_PATH_PREFIX)) {
        const match = PROJECT_CREDENTIALS_PATH_RE.exec(pathname)
        if (match === null) return null
        const sanitized = sanitizeProjectId(match[1] ?? '')
        if (sanitized === null) {
          return jsonError(
            400,
            'invalid_project_id',
            'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
          )
        }
        project_id = sanitized
        raw_service = match[2] ?? ''
      } else {
        return null
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonError(401, resolved.code, resolved.message)
      }
      // Server-derived owner boundary — construct the branded handle at the
      // point it is resolved from auth (the spec's known-good construction
      // site). `resolved.project_slug` is the bearer's authorized instance.
      const owner_slug = asOwnerHandle(resolved.project_slug)
      const method = req.method

      // Collection path: `/credentials`.
      if (raw_service === '') {
        if (method === 'GET') {
          if (project_id === null) {
            return jsonOk({ global: store.listGlobal(owner_slug) })
          }
          // The project view READS the inherited globals (useful where you use
          // them) but cannot author them — see the module header.
          return jsonOk({
            project_id,
            project: store.listForProject(owner_slug, project_id),
            global: store.listGlobal(owner_slug),
          })
        }
        if (method === 'POST') {
          return handleSet(req, store, owner_slug, project_id)
        }
        return jsonError(
          405,
          'method_not_allowed',
          `method '${method}' not allowed on /credentials`,
        )
      }

      // Item path: `/credentials/<service>`.
      const service = sanitizeServiceSegment(raw_service)
      if (service === null) {
        return jsonError(400, 'invalid_service', 'service must be 1-128 chars from [A-Za-z0-9_.-]')
      }
      if (method === 'DELETE') {
        return handleDelete(store, owner_slug, project_id, service, url)
      }
      return jsonError(
        405,
        'method_not_allowed',
        `method '${method}' not allowed on /credentials/<service>`,
      )
    },
  }
}

/**
 * POST a credential. `project_id === null` means the GLOBAL route; anything
 * else is that one project. The body's `scope` is honoured only as far as
 * agreeing with the route it arrived on — a project-route call asking for
 * `global` is a 400, never a write.
 */
async function handleSet(
  req: Request,
  store: ProjectCredentialStore,
  owner_slug: OwnerHandle,
  project_id: string | null,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) return jsonError(400, 'malformed_json', 'expected JSON body')
  const fields = body as Record<string, unknown>

  const scope: CredentialScope = project_id === null ? 'global' : 'project'
  const requested = fields['scope']
  if (requested !== undefined && requested !== null && requested !== scope) {
    return jsonError(400, 'scope_not_allowed', SCOPE_NOT_ALLOWED)
  }
  // A `token` alias is accepted alongside `plaintext` for a friendlier client.
  const rawToken = fields['plaintext'] ?? fields['token']
  const rawService = fields['service']
  if (
    typeof rawService === 'string' &&
    /^[a-z0-9_.-]{1,128}$/.test(rawService.trim().toLowerCase()) &&
    (typeof rawToken !== 'string' || rawToken.length < PROJECT_CREDENTIAL_MIN_SECRET_CHARS)
  ) {
    return jsonError(
      400,
      'invalid_token',
      `token must be at least ${PROJECT_CREDENTIAL_MIN_SECRET_CHARS} characters`,
    )
  }
  try {
    const credential = await store.set(owner_slug, {
      service: fields['service'] as string,
      plaintext: rawToken as string,
      scope,
      // For project scope the surface pins the REAL project id from the URL
      // (server-authoritative under owner_slug); global ignores it.
      project_id: project_id ?? '',
      label: (fields['label'] ?? null) as string | null,
      expires_at: (fields['expires_at'] ?? null) as string | null,
    })
    return jsonOk(project_id === null ? { credential } : { credential, project_id }, 201)
  } catch (err) {
    return mapWriteError(err)
  }
}

async function handleDelete(
  store: ProjectCredentialStore,
  owner_slug: OwnerHandle,
  project_id: string | null,
  service: string,
  url: URL,
): Promise<Response> {
  const scope: CredentialScope = project_id === null ? 'global' : 'project'
  // `?scope=` is legacy. It may only AGREE with the route; the old
  // `?scope=global` on a project URL is now an error, not a global delete.
  const requested = url.searchParams.get('scope')
  if (requested !== null && requested !== scope) {
    return jsonError(400, 'scope_not_allowed', SCOPE_NOT_ALLOWED)
  }
  const removed = await store.delete(owner_slug, project_id ?? '', service)
  if (!removed) {
    return jsonError(404, 'credential_not_found', `service=${service} scope=${scope}`)
  }
  return jsonOk(
    project_id === null ? { deleted: service, scope } : { deleted: service, scope, project_id },
  )
}

/**
 * `GET  /api/app/projects/<id>/accounts` — every selectable service, every
 * connected account, and whether THIS project reads it.
 * `PUT  /api/app/projects/<id>/accounts` — body `{ service, account_id,
 * enabled }`, toggling exactly one account for this project.
 *
 * PUT rather than POST because the operation is idempotent in both directions:
 * the store deletes a disable row to enable and inserts one to disable, so a
 * double-tapped toggle converges instead of erroring or double-counting.
 *
 * There is deliberately NO "disable every account" guard. A project that does
 * not use Gmail is a legitimate configuration, and the response still reports
 * the empty selection honestly so the surface can say so out loud rather than
 * looking broken.
 */
async function handleAccounts(input: {
  req: Request
  project_id: string
  owner_slug: OwnerHandle
  accountSelection: ProjectAccountSelectionStore
  credentialResolver: AccountSelectionReader
}): Promise<Response> {
  const { req, project_id, owner_slug, accountSelection, credentialResolver } = input
  const method = req.method
  if (method === 'GET') {
    return jsonOk({
      project_id,
      services: await credentialResolver.accountSelectionView(project_id),
    })
  }
  if (method === 'PUT') {
    const body = await readJsonBody(req)
    if (body === null) return jsonError(400, 'malformed_json', 'expected JSON body')
    const fields = body as Record<string, unknown>
    const enabled = fields['enabled']
    if (typeof enabled !== 'boolean') {
      return jsonError(400, 'invalid_enabled', 'enabled must be a boolean')
    }
    try {
      await accountSelection.setEnabled(owner_slug, {
        project_id,
        service: fields['service'] as string,
        account_id: fields['account_id'] as string,
        enabled,
      })
    } catch (err) {
      if (err instanceof AccountSelectionValidationError) {
        return jsonError(400, err.code, err.message)
      }
      throw err
    }
    // Return the WHOLE refreshed view, not just the row that moved: the client
    // renders from one source of truth and cannot drift from the server by
    // patching its local copy.
    return jsonOk({
      project_id,
      services: await credentialResolver.accountSelectionView(project_id),
    })
  }
  return jsonError(
    405,
    'method_not_allowed',
    `method '${method}' not allowed on /accounts`,
  )
}

function sanitizeServiceSegment(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_SERVICE_SEGMENT_LEN) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(raw)) return null
  return raw
}

/** Map a store validation error to a 400; rethrow anything else (500). */
function mapWriteError(err: unknown): Response {
  if (err instanceof ProjectCredentialValidationError) return jsonError(400, err.code, err.message)
  throw err
}
