/**
 * @neutronai/gateway/http — Codex subscription connect surface (Settings tab).
 *
 * The admin-panel "Connect Codex" flow for the trident cross-model reviewer
 * (Part B). Sibling of `project-credentials-surface.ts`, same bearer auth
 * (`AppWsAuthResolver`) and same owner-boundary rule: `owner_slug` is ALWAYS the
 * server-derived `resolved.project_slug`, never client-supplied.
 *
 *   - `GET    /api/app/projects/<project_id>/codex-auth`  → connection status
 *   - `POST   /api/app/projects/<project_id>/codex-auth`  → connect (body: { auth })
 *   - `DELETE /api/app/projects/<project_id>/codex-auth`  → disconnect
 *
 * The POST body carries the owner's pasted `~/.codex/auth.json`. Validation +
 * the metered-key rejection + materialization all live in `CodexCredentialService`
 * — this surface is just auth + routing + JSON. A metered `OPENAI_API_KEY` paste
 * comes back as HTTP 400 `metered_key`; a good subscription bundle returns
 * `{ ok, status: 'connected' }` after materializing to the per-tenant CODEX_HOME.
 */

import { sanitizeProjectId } from '../../channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '../../channels/adapters/app-ws/auth.ts'
import type { CodexCredentialService } from '../../trident/codex-credential.ts'

export interface CodexCredentialSurfaceOptions {
  service: CodexCredentialService
  auth: AppWsAuthResolver
}

export interface CodexCredentialSurface {
  handler: (req: Request) => Promise<Response | null>
}

const PATH_PREFIX = '/api/app/projects/'
const CODEX_AUTH_PATH_RE = /^\/api\/app\/projects\/([^/]+)\/codex-auth$/

export function createCodexCredentialSurface(
  opts: CodexCredentialSurfaceOptions,
): CodexCredentialSurface {
  const { service, auth } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      if (!url.pathname.startsWith(PATH_PREFIX)) return null
      const match = CODEX_AUTH_PATH_RE.exec(url.pathname)
      if (match === null) return null

      const project_id = sanitizeProjectId(match[1] ?? '')
      if (project_id === null) {
        return jsonError(400, 'invalid_project_id', 'project_id must be 1-128 chars from [A-Za-z0-9_.-]')
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) return jsonError(401, resolved.code, resolved.message)
      const owner_slug = resolved.project_slug

      switch (req.method) {
        case 'GET': {
          const status = service.status(owner_slug)
          return jsonOk({ ...status })
        }
        case 'POST': {
          const body = (await readJsonBody(req)) as Record<string, unknown> | null
          if (body === null) return jsonError(400, 'malformed_json', 'expected JSON body')
          // Accept `auth` (canonical) or `auth_json` / `value` aliases.
          const pasted = body['auth'] ?? body['auth_json'] ?? body['value']
          const result = await service.connect(owner_slug, pasted)
          if (!result.ok) {
            return jsonError(400, result.code ?? 'invalid_auth', result.error ?? 'could not connect Codex')
          }
          return jsonOk({ status: result.status, mode: result.mode }, 201)
        }
        case 'DELETE': {
          const { ok } = await service.disconnect(owner_slug)
          if (!ok) return jsonError(404, 'codex_not_connected', 'no Codex credential to disconnect')
          return jsonOk({ disconnected: true })
        }
        default:
          return jsonError(405, 'method_not_allowed', `method '${req.method}' not allowed on /codex-auth`)
      }
    },
  }
}

interface ResolvedAuth {
  user_id: string
  project_slug: string
}
interface AuthFailure {
  code: string
  message: string
}

async function resolveBearer(req: Request, auth: AppWsAuthResolver): Promise<ResolvedAuth | AuthFailure> {
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

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
