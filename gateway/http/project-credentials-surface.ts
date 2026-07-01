/**
 * @neutronai/gateway/http — per-project credential CRUD surface (Settings tab).
 *
 * The owner-facing read+write path for per-project / global service
 * credentials (static long-lived tokens: Meta Ads, Google Ads, Apify, …). Owns:
 *
 *   - `GET    /api/app/projects/<project_id>/credentials`            list (project + global)
 *   - `POST   /api/app/projects/<project_id>/credentials`           set (scope in body)
 *   - `DELETE /api/app/projects/<project_id>/credentials/<service>` delete (?scope=project|global)
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
 */

import { sanitizeProjectId } from '../../channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '../../channels/adapters/app-ws/auth.ts'
import {
  ProjectCredentialValidationError,
  type CredentialScope,
  type ProjectCredentialStore,
} from '../../project-credentials/store.ts'

export interface ProjectCredentialsSurfaceOptions {
  store: ProjectCredentialStore
  auth: AppWsAuthResolver
}

export interface ProjectCredentialsSurface {
  /**
   * HTTP route dispatcher. Returns the `Response` for an owned route, or
   * `null` so `compose.ts` falls through to the downstream chain.
   */
  handler: (req: Request) => Promise<Response | null>
}

const PATH_PREFIX = '/api/app/projects/'
const CREDENTIALS_PATH_RE =
  /^\/api\/app\/projects\/([^/]+)\/credentials(?:\/([^/]+))?$/

const MAX_SERVICE_SEGMENT_LEN = 128

export function createProjectCredentialsSurface(
  opts: ProjectCredentialsSurfaceOptions,
): ProjectCredentialsSurface {
  const { store, auth } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!pathname.startsWith(PATH_PREFIX)) return null
      const match = CREDENTIALS_PATH_RE.exec(pathname)
      if (match === null) return null
      const raw_project_id = match[1] ?? ''
      const raw_service = match[2] ?? ''
      const project_id = sanitizeProjectId(raw_project_id)
      if (project_id === null) {
        return jsonError(
          400,
          'invalid_project_id',
          'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
        )
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonError(401, resolved.code, resolved.message)
      }
      const owner_slug = resolved.project_slug
      const method = req.method

      // Collection path: `/credentials`.
      if (raw_service === '') {
        if (method === 'GET') {
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

async function handleSet(
  req: Request,
  store: ProjectCredentialStore,
  owner_slug: string,
  project_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) return jsonError(400, 'malformed_json', 'expected JSON body')
  const fields = body as Record<string, unknown>

  const scope = readScope(fields['scope'])
  if (scope === null) {
    return jsonError(400, 'invalid_scope', "scope must be 'project' or 'global'")
  }
  // A `token` alias is accepted alongside `plaintext` for a friendlier client.
  const rawToken = fields['plaintext'] ?? fields['token']
  try {
    const credential = await store.set(owner_slug, {
      service: fields['service'] as string,
      plaintext: rawToken as string,
      scope,
      // For project scope the surface pins the REAL project id from the URL
      // (server-authoritative under owner_slug); global ignores it.
      project_id,
      label: (fields['label'] ?? null) as string | null,
      expires_at: (fields['expires_at'] ?? null) as string | null,
    })
    return jsonOk({ credential, project_id }, 201)
  } catch (err) {
    return mapWriteError(err)
  }
}

async function handleDelete(
  store: ProjectCredentialStore,
  owner_slug: string,
  project_id: string,
  service: string,
  url: URL,
): Promise<Response> {
  // `?scope=global` deletes the instance-wide default; default is the
  // per-project credential under the URL project id.
  const scope = readScope(url.searchParams.get('scope')) ?? 'project'
  const target_project_id = scope === 'global' ? '' : project_id
  const removed = await store.delete(owner_slug, target_project_id, service)
  if (!removed) {
    return jsonError(404, 'credential_not_found', `service=${service} scope=${scope}`)
  }
  return jsonOk({ deleted: service, scope, project_id })
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

/** Parse a scope value: 'project' | 'global', or null when absent/malformed. */
function readScope(raw: unknown): CredentialScope | null {
  if (raw === 'project' || raw === 'global') return raw
  return null
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

function jsonOk(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
