/**
 * @neutronai/gateway/http — Codex subscription connect surface.
 *
 * The admin-panel "Connect Codex" flow for the trident cross-model reviewer.
 * Sibling of `project-credentials-surface.ts`, same bearer auth
 * (`AppWsAuthResolver`) and same owner-boundary rule: `owner_slug` is ALWAYS the
 * server-derived `resolved.project_slug`, never client-supplied.
 *
 * The Codex subscription is a GLOBAL, trident-wide credential (trident runs
 * across ANY project), so the PRIMARY surface is the account-wide route with NO
 * project segment — connected from the General admin UI. A per-project OVERRIDE
 * route stays for the edge case (one project needs a different subscription); an
 * override wins over the global default for that project (store resolver:
 * project → global → unset).
 *
 *   GLOBAL (primary — General admin UI):
 *   - `GET    /api/app/codex-auth`                       → global connection status
 *   - `POST   /api/app/codex-auth`                       → connect global (body: { auth })
 *   - `DELETE /api/app/codex-auth`                       → disconnect global
 *
 *   PROJECT OVERRIDE (optional — per-project Settings):
 *   - `GET    /api/app/projects/<project_id>/codex-auth` → effective status (project→global)
 *   - `POST   /api/app/projects/<project_id>/codex-auth` → connect a project override
 *   - `DELETE /api/app/projects/<project_id>/codex-auth` → remove the project override
 *
 * The POST body carries the owner's pasted `~/.codex/auth.json`. Validation +
 * the metered-key rejection + materialization all live in `CodexCredentialService`
 * — this surface is just auth + routing + JSON. A metered `OPENAI_API_KEY` paste
 * comes back as HTTP 400 `metered_key`; a good subscription bundle returns
 * `{ ok, status: 'connected', scope }` after materializing to the scope's CODEX_HOME.
 */

import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { sanitizeProjectId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { CodexCredentialService, CodexTarget } from '@neutronai/trident/codex-credential.ts'
import { jsonError, jsonOk, readJsonBody, resolveBearer } from './surface-kit.ts'

export interface CodexCredentialSurfaceOptions {
  service: CodexCredentialService
  auth: AppWsAuthResolver
}

export interface CodexCredentialSurface {
  handler: (req: Request) => Promise<Response | null>
}

/** Global (account-wide) route — the primary Connect Codex surface. */
const GLOBAL_CODEX_AUTH_PATH = '/api/app/codex-auth'
/** Per-project override route. */
const PROJECT_PREFIX = '/api/app/projects/'
const PROJECT_CODEX_AUTH_PATH_RE = /^\/api\/app\/projects\/([^/]+)\/codex-auth$/

export function createCodexCredentialSurface(
  opts: CodexCredentialSurfaceOptions,
): CodexCredentialSurface {
  const { service, auth } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname

      // Resolve the target scope from the path: the global route carries no
      // project segment; the project route pins the URL project id as an override.
      let target: CodexTarget
      if (pathname === GLOBAL_CODEX_AUTH_PATH) {
        target = { scope: 'global' }
      } else if (pathname.startsWith(PROJECT_PREFIX)) {
        const match = PROJECT_CODEX_AUTH_PATH_RE.exec(pathname)
        if (match === null) return null
        const project_id = sanitizeProjectId(match[1] ?? '')
        if (project_id === null) {
          return jsonError(400, 'invalid_project_id', 'project_id must be 1-128 chars from [A-Za-z0-9_.-]')
        }
        target = { scope: 'project', project_id }
      } else {
        return null
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) return jsonError(401, resolved.code, resolved.message)
      // Server-derived owner boundary — construct the branded handle at the
      // point it is resolved from auth (the spec's known-good construction site).
      const owner_slug = asOwnerHandle(resolved.project_slug)

      switch (req.method) {
        case 'GET': {
          // Status resolves project → global for the override route (effective
          // credential for this project); global route reports the global default.
          const status = service.status(owner_slug, target)
          return jsonOk({ ...status })
        }
        case 'POST': {
          const body = (await readJsonBody(req)) as Record<string, unknown> | null
          if (body === null) return jsonError(400, 'malformed_json', 'expected JSON body')
          // Accept `auth` (canonical) or `auth_json` / `value` aliases.
          const pasted = body['auth'] ?? body['auth_json'] ?? body['value']
          const result = await service.connect(owner_slug, pasted, target)
          if (!result.ok) {
            return jsonError(400, result.code ?? 'invalid_auth', result.error ?? 'could not connect Codex')
          }
          return jsonOk({ status: result.status, mode: result.mode, scope: result.scope }, 201)
        }
        case 'DELETE': {
          const { ok } = await service.disconnect(owner_slug, target)
          if (!ok) return jsonError(404, 'codex_not_connected', 'no Codex credential to disconnect')
          return jsonOk({ disconnected: true, scope: target.scope })
        }
        default:
          return jsonError(405, 'method_not_allowed', `method '${req.method}' not allowed on /codex-auth`)
      }
    },
  }
}
