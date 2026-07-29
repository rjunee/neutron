/**
 * @neutronai/gateway/http — Expo-app project launcher surface (P5.3).
 *
 * Per SPEC.md § Phases→Steps (P5.3 — "Launcher
 * (project-scoped). Drag-and-drop reorder, long-press menu, 'Build me…'
 * → new icon"). Exposes four routes:
 *
 *   - `GET  /api/app/projects/<project_id>/launcher`            list entries
 *   - `POST /api/app/projects/<project_id>/launcher/reorder`    { slug, new_index }
 *   - `POST /api/app/projects/<project_id>/launcher/uninstall`  { slug }
 *   - `POST /api/app/projects/<project_id>/launcher/rename`     { slug, display_name }
 *
 * Auth shares the app-ws surface contract (Bearer token resolved by
 * `AppWsAuthResolver`). Server is authoritative — every mutation
 * returns the post-mutation ordered list so the client doesn't have to
 * apply a separate GET to reconcile, AND the gateway is the single
 * source of truth for the order (no optimistic-only client state).
 *
 * The path is sibling to `/api/app/chat/send`; the surface returns
 * `null` from `handler` for non-owned routes so unrelated `/api/app/...`
 * paths fall through to the compose-chain default.
 */

import { sanitizeProjectId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { jsonResponse, readJsonBody, resolveBearer } from './surface-kit.ts'
import { MAX_DISPLAY_NAME_LEN, type ProjectLauncherStore } from './project-launcher-store.ts'

export interface AppLauncherSurfaceOptions {
  store: ProjectLauncherStore
  auth: AppWsAuthResolver
}

export interface AppLauncherSurface {
  /**
   * HTTP route dispatcher. Returns the `Response` for an owned route,
   * or `null` to indicate the request belongs to a sibling surface.
   * Caller (`compose.ts`) chains downstream.
   */
  handler: (req: Request) => Promise<Response | null>
}

const PATH_PREFIX = '/api/app/projects/'
/** Matches `/api/app/projects/<project_id>/launcher[/<action>]`. The
 *  group order matters — the project id is `[1]`, the action (or `''`
 *  for the bare list path) is `[2]`. */
const LAUNCHER_PATH_RE = /^\/api\/app\/projects\/([^/]+)\/launcher(?:\/([a-z]+))?$/

export function createAppLauncherSurface(opts: AppLauncherSurfaceOptions): AppLauncherSurface {
  const { store, auth } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!pathname.startsWith(PATH_PREFIX)) return null
      const match = LAUNCHER_PATH_RE.exec(pathname)
      if (match === null) return null
      const raw_project_id = match[1]
      const action = match[2] ?? ''
      const project_id = sanitizeProjectId(raw_project_id)
      if (project_id === null) {
        return jsonResponse(400, {
          ok: false,
          code: 'invalid_project_id',
          message: 'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
        })
      }

      // Bearer auth — identical to the chat-send path. Routed inside
      // the surface so the unauth response shape is consistent across
      // all surface routes (avoids the compose-chain returning a plain
      // 401 text for one path and JSON for another).
      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonResponse(401, { ok: false, code: resolved.code, message: resolved.message })
      }

      const method = req.method
      if (action === '' && method === 'GET') {
        return await handleList(store, resolved.project_slug, project_id)
      }
      if (action === 'reorder' && method === 'POST') {
        return await handleReorder(req, store, resolved.project_slug, project_id)
      }
      if (action === 'uninstall' && method === 'POST') {
        return await handleUninstall(req, store, resolved.project_slug, project_id)
      }
      if (action === 'rename' && method === 'POST') {
        return await handleRename(req, store, resolved.project_slug, project_id)
      }
      // The path matched the launcher shape but neither the method nor
      // the action did — return 405 with the canonical JSON envelope so
      // clients can render the failure inline.
      return jsonResponse(405, {
        ok: false,
        code: 'method_not_allowed',
        message: `unknown launcher action '${action}' or method '${method}'`,
      })
    },
  }
}

async function handleList(
  store: ProjectLauncherStore,
  project_slug: string,
  project_id: string,
): Promise<Response> {
  const entries = await store.list(project_slug, project_id)
  return jsonResponse(200, { ok: true, entries, project_id, project_slug })
}

async function handleReorder(
  req: Request,
  store: ProjectLauncherStore,
  project_slug: string,
  project_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'malformed_json',
      message: 'expected { slug: string, new_index: number }',
    })
  }
  const slug = readSlug(body)
  if (slug === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_slug',
      message: 'expected { slug: string, new_index: number }',
    })
  }
  const new_index = (body as Record<string, unknown>)['new_index']
  if (typeof new_index !== 'number' || !Number.isFinite(new_index)) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_new_index',
      message: 'expected new_index: finite number',
    })
  }
  const entries = await store.reorder(project_slug, project_id, slug, new_index)
  return jsonResponse(200, { ok: true, entries, project_id, project_slug })
}

async function handleUninstall(
  req: Request,
  store: ProjectLauncherStore,
  project_slug: string,
  project_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'malformed_json',
      message: 'expected { slug: string }',
    })
  }
  const slug = readSlug(body)
  if (slug === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_slug',
      message: 'expected { slug: string }',
    })
  }
  const entries = await store.uninstall(project_slug, project_id, slug)
  return jsonResponse(200, { ok: true, entries, project_id, project_slug })
}

async function handleRename(
  req: Request,
  store: ProjectLauncherStore,
  project_slug: string,
  project_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'malformed_json',
      message: 'expected { slug: string, display_name: string }',
    })
  }
  const slug = readSlug(body)
  if (slug === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_slug',
      message: 'expected { slug: string, display_name: string }',
    })
  }
  const display_name = (body as Record<string, unknown>)['display_name']
  if (typeof display_name !== 'string' || display_name.trim().length === 0) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_display_name',
      message: 'expected display_name: non-empty string',
    })
  }
  if (display_name.length > MAX_DISPLAY_NAME_LEN) {
    return jsonResponse(413, {
      ok: false,
      code: 'display_name_too_long',
      message: `display_name exceeds ${MAX_DISPLAY_NAME_LEN} chars`,
    })
  }
  const entries = await store.rename(project_slug, project_id, slug, display_name)
  return jsonResponse(200, { ok: true, entries, project_id, project_slug })
}

function readSlug(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const v = (body as Record<string, unknown>)['slug']
  if (typeof v !== 'string' || v.length === 0 || v.length > 128) return null
  // Mirror the project_id charset — Core slugs are stable identifiers
  // (e.g. `notes`, `tasks_core`, `dtc-analytics`). Reject anything that
  // doesn't fit so a malformed client can't push surprising bytes
  // through downstream join keys.
  if (!/^[A-Za-z0-9_.-]+$/.test(v)) return null
  return v
}
