/**
 * @neutronai/gateway/http — Expo/web-app TAB RESOLVER surface (WAVE 3, PR-1).
 *
 * Per `docs/plans/wave3-tabbed-interface-build-plan.md` § 3.1 + § 4 (PR-1).
 * Both clients (mobile RN + web React) fetch their tab set from the engine
 * rather than hardcoding it. Two read-only routes:
 *
 *   - `GET /api/app/projects/<project_id>/tabs`  → ordered project-scope tabs
 *   - `GET /api/app/tabs`                         → ordered global-scope tabs
 *
 * v1 returns BUILTIN descriptors only (Chat/Documents/Tasks per-project;
 * Admin global) — see `tabs/registry.ts`. Core-contributed tabs + the
 * install-scope union land in PR-2; this surface's payload shape is stable
 * across that change (the array just grows).
 *
 * Auth shares the app-ws surface contract (Bearer token resolved by
 * `AppWsAuthResolver`), identical to the sibling `/api/app/projects/<id>/*`
 * surfaces. The per-project route additionally validates `project_id`.
 *
 * Flag gate — `NEUTRON_TABS_REGISTRY` (default OFF). The composition reads
 * the env at boot and passes `enabled` here. When DISABLED the surface
 * DISCLAIMS its routes (returns `null`) so they fall through to the default
 * 404 chain exactly as if unmounted — clients keep their pre-WAVE-3
 * hardcoded tabs (no regression). When ENABLED it serves descriptors.
 *
 * Like every sibling app surface the handler returns `null` for non-owned
 * paths so the compose-chain can keep walking downstream.
 */

import { sanitizeProjectId } from '../../channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '../../channels/adapters/app-ws/auth.ts'
import {
  resolveGlobalTabs,
  resolveProjectTabs,
  type TabDescriptor,
} from '../../tabs/registry.ts'

export interface AppTabsSurfaceOptions {
  auth: AppWsAuthResolver
  /**
   * `NEUTRON_TABS_REGISTRY` resolved to a boolean at composition time.
   * `false` → the surface disclaims (404 fall-through) so the flag-off path
   * is indistinguishable from the surface being unmounted.
   */
  enabled: boolean
}

export interface AppTabsSurface {
  /**
   * HTTP route dispatcher. Returns the `Response` for an owned route, or
   * `null` to indicate the request belongs to a sibling surface (or that
   * the registry flag is off). Caller (`compose.ts`) chains downstream.
   */
  handler: (req: Request) => Promise<Response | null>
}

/** Exact-match path for the global tab set. */
const GLOBAL_TABS_PATH = '/api/app/tabs'
/** Matches `/api/app/projects/<project_id>/tabs`; project id is group [1]. */
const PROJECT_TABS_PATH_RE = /^\/api\/app\/projects\/([^/]+)\/tabs$/

export function createAppTabsSurface(opts: AppTabsSurfaceOptions): AppTabsSurface {
  const { auth, enabled } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname

      const isGlobal = pathname === GLOBAL_TABS_PATH
      const projectMatch = PROJECT_TABS_PATH_RE.exec(pathname)
      if (!isGlobal && projectMatch === null) return null

      // Flag OFF → behave as if the surface were never mounted. Disclaim the
      // route so it 404s through the default chain (clients fall back to
      // their hardcoded tab set, no regression).
      if (!enabled) return null

      const method = req.method
      if (method !== 'GET') {
        return jsonResponse(405, {
          ok: false,
          code: 'method_not_allowed',
          message: `method '${method}' not allowed on the tabs surface (GET only)`,
        })
      }

      // Bearer auth — routed inside the surface so the unauth response shape
      // matches the sibling app surfaces (consistent JSON envelope).
      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonResponse(401, { ok: false, code: resolved.code, message: resolved.message })
      }

      if (isGlobal) {
        const tabs = resolveGlobalTabs()
        return jsonResponse(200, { ok: true, scope: 'global', tabs })
      }

      // Per-project route — validate the path-supplied project id.
      const raw_project_id = projectMatch![1] ?? ''
      const project_id = sanitizeProjectId(raw_project_id)
      if (project_id === null) {
        return jsonResponse(400, {
          ok: false,
          code: 'invalid_project_id',
          message: 'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
        })
      }
      const tabs = resolveProjectTabs()
      return jsonResponse(200, { ok: true, scope: 'project', project_id, tabs })
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

async function resolveBearer(
  req: Request,
  auth: AppWsAuthResolver,
): Promise<ResolvedAuth | AuthFailure> {
  const header = req.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) {
    return { code: 'missing_bearer', message: 'expected Authorization: Bearer <token>' }
  }
  const token = header.slice('bearer '.length).trim()
  const result = await auth.resolve(token)
  if ('code' in result) return { code: result.code, message: result.message }
  return { user_id: result.user_id, project_slug: result.project_slug }
}

function jsonResponse(
  status: number,
  body: { ok: boolean; tabs?: TabDescriptor[]; [k: string]: unknown },
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
