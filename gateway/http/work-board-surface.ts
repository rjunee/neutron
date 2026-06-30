/**
 * @neutronai/gateway/http — Expo-app project Work Board surface (Phase 1a).
 *
 * The HUMAN read+WRITE path on the Work Board. Owns:
 *
 *   - `GET    /api/app/projects/<project_id>/work-board`                 list
 *   - `POST   /api/app/projects/<project_id>/work-board`                 create
 *   - `PATCH  /api/app/projects/<project_id>/work-board/<item_id>`       update
 *   - `POST   /api/app/projects/<project_id>/work-board/<item_id>/complete`
 *   - `POST   /api/app/projects/<project_id>/work-board/<item_id>/reorder`
 *   - `DELETE /api/app/projects/<project_id>/work-board/<item_id>`
 *
 * All routes are bearer-authed via the shared `AppWsAuthResolver` (same
 * dev-bypass + HS256 paths as the tabs/tasks/chat surfaces). It dispatches the
 * SAME `WorkBoardStore` the agent tools + the per-turn injection use — one code
 * path, so a write here fires the same `work_board_changed` push.
 *
 * Scope: the board is INSTANCE-scoped by the SERVER-derived `project_slug`
 * (`resolved.project_slug` from the bearer, never the client-supplied path id).
 * The `<project_id>` path segment is sanitized for URL-scheme consistency with
 * the tabs/tasks surfaces but is NOT the storage key; `store.get(project_slug,
 * id)` returning null is reported as 404 so a caller can't probe another scope.
 *
 * `design_doc_ref` schemes are allow-listed at the store (https + in-app docs
 * link only); a rejected scheme surfaces here as a 400, not a 500.
 */

import { sanitizeProjectId } from '../../channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '../../channels/adapters/app-ws/auth.ts'
import {
  WorkBoardValidationError,
  type WorkBoardStatus,
  type WorkBoardStore,
} from '../../work-board/store.ts'

export interface WorkBoardSurfaceOptions {
  store: WorkBoardStore
  auth: AppWsAuthResolver
}

export interface WorkBoardSurface {
  /**
   * HTTP route dispatcher. Returns the `Response` for an owned route, or
   * `null` so `compose.ts` falls through to the downstream chain.
   */
  handler: (req: Request) => Promise<Response | null>
}

const PATH_PREFIX = '/api/app/projects/'
const WORK_BOARD_PATH_RE =
  /^\/api\/app\/projects\/([^/]+)\/work-board(?:\/([^/]+))?(?:\/([a-z]+))?$/

const MAX_ITEM_ID_LEN = 128
const VALID_STATUSES: WorkBoardStatus[] = ['upcoming', 'in_progress', 'done']

export function createWorkBoardSurface(opts: WorkBoardSurfaceOptions): WorkBoardSurface {
  const { store, auth } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!pathname.startsWith(PATH_PREFIX)) return null
      const match = WORK_BOARD_PATH_RE.exec(pathname)
      if (match === null) return null
      const raw_project_id = match[1] ?? ''
      const raw_item_id = match[2] ?? ''
      const action = match[3] ?? ''
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
      const project_slug = resolved.project_slug
      const method = req.method

      // Bare collection path: `/work-board`.
      if (raw_item_id === '') {
        if (method === 'GET') {
          return jsonOk({ items: store.list(project_slug), project_id })
        }
        if (method === 'POST') {
          return handleCreate(req, store, project_slug, project_id)
        }
        return jsonError(405, 'method_not_allowed', `method '${method}' not allowed on /work-board`)
      }

      // item_id-scoped routes: `/work-board/<id>[/<verb>]`.
      const item_id = sanitizeItemId(raw_item_id)
      if (item_id === null) {
        return jsonError(400, 'invalid_item_id', 'item_id must be 1-128 chars from [A-Za-z0-9_.-]')
      }

      if (action === '') {
        if (method === 'PATCH') {
          return handleUpdate(req, store, project_slug, project_id, item_id)
        }
        if (method === 'DELETE') {
          return handleDelete(store, project_slug, project_id, item_id)
        }
        return jsonError(
          405,
          'method_not_allowed',
          `method '${method}' not allowed on /work-board/<id>`,
        )
      }
      if (action === 'complete' && method === 'POST') {
        return handleComplete(store, project_slug, project_id, item_id)
      }
      if (action === 'reorder' && method === 'POST') {
        return handleReorder(req, store, project_slug, project_id, item_id)
      }
      return jsonError(
        405,
        'method_not_allowed',
        `unknown work-board action '${action}' or method '${method}'`,
      )
    },
  }
}

async function handleCreate(
  req: Request,
  store: WorkBoardStore,
  project_slug: string,
  project_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) return jsonError(400, 'malformed_json', 'expected JSON body')
  const fields = body as Record<string, unknown>
  const title = readTitle(fields['title'])
  if (title === null) {
    return jsonError(400, 'invalid_title', 'title must be a non-empty string up to 256 chars')
  }
  const status = readStatus(fields['status'])
  if (status === false) {
    return jsonError(400, 'invalid_status', `status must be one of ${VALID_STATUSES.join('/')}`)
  }
  const design_doc_ref = readOptionalString(fields['design_doc_ref'])
  if (design_doc_ref === false) {
    return jsonError(400, 'invalid_design_doc_ref', 'design_doc_ref must be a string')
  }
  try {
    const item = await store.create(project_slug, {
      title,
      ...(status !== null ? { status } : {}),
      ...(design_doc_ref !== null ? { design_doc_ref } : {}),
    })
    return jsonOk({ item, project_id }, 201)
  } catch (err) {
    return mapWriteError(err)
  }
}

async function handleUpdate(
  req: Request,
  store: WorkBoardStore,
  project_slug: string,
  project_id: string,
  item_id: string,
): Promise<Response> {
  const owned = store.get(project_slug, item_id)
  if (owned === null) return jsonError(404, 'item_not_found', `item_id=${item_id}`)
  const body = await readJsonBody(req)
  if (body === null) return jsonError(400, 'malformed_json', 'expected JSON body')
  const fields = body as Record<string, unknown>
  const patch: { title?: string; status?: WorkBoardStatus; design_doc_ref?: string | null } = {}
  if (fields['title'] !== undefined) {
    const title = readTitle(fields['title'])
    if (title === null) {
      return jsonError(400, 'invalid_title', 'title must be a non-empty string up to 256 chars')
    }
    patch.title = title
  }
  if (fields['status'] !== undefined) {
    const status = readStatus(fields['status'])
    if (status === false || status === null) {
      return jsonError(400, 'invalid_status', `status must be one of ${VALID_STATUSES.join('/')}`)
    }
    patch.status = status
  }
  if (fields['design_doc_ref'] !== undefined) {
    const ref = readOptionalString(fields['design_doc_ref'])
    if (ref === false) {
      return jsonError(400, 'invalid_design_doc_ref', 'design_doc_ref must be a string or null')
    }
    patch.design_doc_ref = ref
  }
  try {
    const item = await store.update(project_slug, item_id, patch)
    return jsonOk({ item, project_id })
  } catch (err) {
    return mapWriteError(err)
  }
}

async function handleComplete(
  store: WorkBoardStore,
  project_slug: string,
  project_id: string,
  item_id: string,
): Promise<Response> {
  const owned = store.get(project_slug, item_id)
  if (owned === null) return jsonError(404, 'item_not_found', `item_id=${item_id}`)
  const item = await store.complete(project_slug, item_id)
  return jsonOk({ item, project_id })
}

async function handleReorder(
  req: Request,
  store: WorkBoardStore,
  project_slug: string,
  project_id: string,
  item_id: string,
): Promise<Response> {
  const owned = store.get(project_slug, item_id)
  if (owned === null) return jsonError(404, 'item_not_found', `item_id=${item_id}`)
  const body = (await readJsonBody(req)) ?? {}
  const fields = body as Record<string, unknown>
  const before = readOptionalString(fields['before'])
  const after = readOptionalString(fields['after'])
  if (before === false || after === false) {
    return jsonError(400, 'invalid_reorder_target', 'before/after must be item id strings')
  }
  await store.reorder(project_slug, item_id, {
    ...(before !== null ? { before } : {}),
    ...(after !== null ? { after } : {}),
  })
  return jsonOk({ items: store.list(project_slug), project_id })
}

async function handleDelete(
  store: WorkBoardStore,
  project_slug: string,
  project_id: string,
  item_id: string,
): Promise<Response> {
  const owned = store.get(project_slug, item_id)
  if (owned === null) return jsonError(404, 'item_not_found', `item_id=${item_id}`)
  await store.delete(project_slug, item_id)
  return jsonOk({ deleted: item_id, project_id })
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

/** Validated non-empty title (<=256 chars) or null when malformed. */
function readTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > 256) return null
  return trimmed
}

/** Status enum: a valid status, `null` when absent, or `false` when malformed. */
function readStatus(raw: unknown): WorkBoardStatus | null | false {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return false
  if (!VALID_STATUSES.includes(raw as WorkBoardStatus)) return false
  return raw as WorkBoardStatus
}

/** Optional string: the string, `null` when absent/empty, or `false` when malformed. */
function readOptionalString(raw: unknown): string | null | false {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return false
  return raw
}

function sanitizeItemId(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_ITEM_ID_LEN) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(raw)) return null
  return raw
}

/** Map a store validation error to a 400; rethrow anything else (500). */
function mapWriteError(err: unknown): Response {
  if (err instanceof WorkBoardValidationError) return jsonError(400, err.code, err.message)
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
