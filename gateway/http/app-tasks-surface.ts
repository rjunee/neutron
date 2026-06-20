/**
 * @neutronai/gateway/http — Expo-app project-scoped tasks surface (P5.4).
 *
 * Per SPEC.md § Phases→Steps — P5.4 ("Tasks tab
 * (project-scoped). Backed by P6.0 canonical TaskStore"). Owns:
 *
 *   - `GET    /api/app/projects/<project_id>/tasks?status=<filter>`   list
 *   - `POST   /api/app/projects/<project_id>/tasks`                   create
 *   - `PATCH  /api/app/projects/<project_id>/tasks/<task_id>`         update
 *   - `POST   /api/app/projects/<project_id>/tasks/<task_id>/complete`
 *   - `POST   /api/app/projects/<project_id>/tasks/<task_id>/cancel`
 *   - `DELETE /api/app/projects/<project_id>/tasks/<task_id>`
 *
 * All routes are bearer-authed via the shared `AppWsAuthResolver` so
 * the dev-bypass + HS256 paths used by the P5.1 chat surface and P5.3
 * launcher cover this surface identically.
 *
 * Server-authoritative: every mutating route re-fetches the matching
 * task and returns the canonical row (so the Expo client never has to
 * second-guess the server's view). Sort order is the TaskStore's own
 * (open dated → open dateless → done by completed_at DESC → cancelled
 * by updated_at DESC — see `tasks/store.ts:TaskStore.list`).
 *
 * Project isolation: every mutation re-asserts that the on-disk task's
 * `project_id` matches the path's `<project_id>` before mutating, so a
 * caller cannot reach into another project by guessing a task_id. Cross-
 * project isolation is enforced by the project DB itself (the gateway
 * runs one process per instance), with the bearer's project_slug double-
 * checked in the same pre-mutation re-fetch.
 *
 * Input validation: every payload field is shape-checked before
 * touching the store. Title must be a non-empty trimmed string;
 * `due_date` if present must parse as ISO-8601; `priority` if present
 * must be an integer 0-3 (matches the migration CHECK); status filters
 * are validated against an enum. Failures return 400 with a stable
 * error code so the Expo client can render inline.
 */

import { sanitizeProjectId } from '../../channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '../../channels/adapters/app-ws/auth.ts'
import { ownerSlugMismatch } from './auth-helpers.ts'
import {
  ALL_TASK_ORDERS,
  ALL_TASK_STATUSES,
  TASK_SOURCE_APP,
  TaskNotFoundError,
  TaskStore,
  type Task,
  type TaskOrder,
  type TaskStatus,
  type TaskStatusFilter,
  type UpdateTaskFields,
} from '../../tasks/store.ts'

export interface AppTasksSurfaceOptions {
  store: TaskStore
  auth: AppWsAuthResolver
}

export interface AppTasksSurface {
  /**
   * HTTP route dispatcher. Returns the `Response` for an owned route,
   * or `null` to indicate the request belongs to a sibling surface so
   * `compose.ts` falls through to the downstream chain.
   */
  handler: (req: Request) => Promise<Response | null>
}

const PATH_PREFIX = '/api/app/projects/'
/**
 * Matches:
 *   /api/app/projects/<project_id>/tasks                              → action=''
 *   /api/app/projects/<project_id>/tasks/<task_id>                    → action='', task_id set
 *   /api/app/projects/<project_id>/tasks/<task_id>/<verb>             → action=<verb>, task_id set
 *
 * `task_id` and `<verb>` are split at the parser level so the routing
 * decision is unambiguous (the launcher surface's regex doesn't apply
 * here — we need the trailing-id + verb shape).
 */
const TASKS_PATH_RE =
  /^\/api\/app\/projects\/([^/]+)\/tasks(?:\/([^/]+))?(?:\/([a-z]+))?$/

/** Maximum title length (matches the launcher's display-name cap). */
const MAX_TITLE_LEN = 256
const MAX_DESCRIPTION_LEN = 8192
const MAX_OWNER_PERSONA_LEN = 128
const MAX_TASK_ID_LEN = 128

export function createAppTasksSurface(opts: AppTasksSurfaceOptions): AppTasksSurface {
  const { store, auth } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!pathname.startsWith(PATH_PREFIX)) return null
      const match = TASKS_PATH_RE.exec(pathname)
      if (match === null) return null
      const raw_project_id = match[1] ?? ''
      const raw_task_id = match[2] ?? ''
      const action = match[3] ?? ''
      const project_id = sanitizeProjectId(raw_project_id)
      if (project_id === null) {
        return jsonError(400, 'invalid_project_id', 'project_id must be 1-128 chars from [A-Za-z0-9_.-]')
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonError(401, resolved.code, resolved.message)
      }

      const method = req.method

      // Bare list path: `/tasks` (no task_id segment).
      if (raw_task_id === '') {
        if (method === 'GET') {
          return handleList(req, store, resolved.project_slug, project_id)
        }
        if (method === 'POST') {
          return handleCreate(req, store, resolved.project_slug, project_id)
        }
        return jsonError(405, 'method_not_allowed', `method '${method}' not allowed on /tasks`)
      }

      // task_id-scoped routes: `/tasks/<id>[/<verb>]`.
      const task_id = sanitizeTaskId(raw_task_id)
      if (task_id === null) {
        return jsonError(400, 'invalid_task_id', 'task_id must be 1-128 chars from [A-Za-z0-9_.-]')
      }

      if (action === '') {
        if (method === 'PATCH') {
          return handleUpdate(req, store, resolved.project_slug, project_id, task_id)
        }
        if (method === 'DELETE') {
          return handleDelete(store, resolved.project_slug, project_id, task_id)
        }
        return jsonError(405, 'method_not_allowed', `method '${method}' not allowed on /tasks/<id>`)
      }
      if (action === 'complete' && method === 'POST') {
        return handleComplete(store, resolved.project_slug, project_id, task_id)
      }
      if (action === 'cancel' && method === 'POST') {
        return handleCancel(store, resolved.project_slug, project_id, task_id)
      }
      return jsonError(
        405,
        'method_not_allowed',
        `unknown tasks action '${action}' or method '${method}'`,
      )
    },
  }
}

function handleList(
  req: Request,
  store: TaskStore,
  project_slug: string,
  project_id: string,
): Response {
  const url = new URL(req.url)
  const raw_status = url.searchParams.get('status')
  const status = parseStatusFilter(raw_status)
  if (status === undefined) {
    return jsonError(
      400,
      'invalid_status_filter',
      `status must be one of: ${['open', 'done', 'cancelled', 'all'].join(', ')}`,
    )
  }
  const raw_limit = url.searchParams.get('limit')
  const limit = parseLimit(raw_limit)
  if (limit === undefined) {
    return jsonError(400, 'invalid_limit', 'limit must be an integer between 1 and 500')
  }
  const raw_order = url.searchParams.get('order')
  const order = parseOrder(raw_order)
  if (order === undefined) {
    return jsonError(
      400,
      'invalid_order',
      `order must be one of: ${ALL_TASK_ORDERS.join(', ')}`,
    )
  }

  const listInput: Parameters<TaskStore['list']>[0] = {
    project_slug,
    project_id,
    status,
    order,
  }
  if (limit !== null) listInput.limit = limit
  const tasks = store.list(listInput)
  return jsonOk({ tasks, project_id, project_slug, status, order })
}

async function handleCreate(
  req: Request,
  store: TaskStore,
  project_slug: string,
  project_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonError(400, 'malformed_json', 'expected JSON body')
  }
  const fields = body as Record<string, unknown>

  const title = readTitle(fields['title'])
  if (title === null) {
    return jsonError(400, 'invalid_title', 'title must be a non-empty string up to 256 chars')
  }
  const description = readOptionalString(fields['description'], MAX_DESCRIPTION_LEN)
  if (description === false) {
    return jsonError(400, 'invalid_description', `description must be a string up to ${MAX_DESCRIPTION_LEN} chars`)
  }
  const priority = readPriority(fields['priority'])
  if (priority === false) {
    return jsonError(400, 'invalid_priority', 'priority must be an integer 0..3 or null')
  }
  const due_date = readDueDate(fields['due_date'])
  if (due_date === false) {
    return jsonError(400, 'invalid_due_date', 'due_date must be a valid ISO-8601 string or null')
  }
  const owner_persona = readOptionalString(fields['owner_persona'], MAX_OWNER_PERSONA_LEN)
  if (owner_persona === false) {
    return jsonError(400, 'invalid_owner_persona', `owner_persona must be a string up to ${MAX_OWNER_PERSONA_LEN} chars`)
  }
  const source = readOptionalString(fields['source'], MAX_OWNER_PERSONA_LEN)
  if (source === false) {
    return jsonError(400, 'invalid_source', 'source must be a string')
  }

  const created = await store.create({
    project_slug,
    project_id,
    title,
    description,
    priority,
    due_date,
    owner_persona,
    source: source ?? TASK_SOURCE_APP,
  })
  return jsonOk({ task: created, project_id, project_slug }, 201)
}

async function handleUpdate(
  req: Request,
  store: TaskStore,
  project_slug: string,
  project_id: string,
  task_id: string,
): Promise<Response> {
  const ownership = assertTaskInProject(store, task_id, project_slug, project_id)
  if ('error' in ownership) return ownership.error

  const body = await readJsonBody(req)
  if (body === null) {
    return jsonError(400, 'malformed_json', 'expected JSON body')
  }
  const fields = body as Record<string, unknown>
  const patch: UpdateTaskFields = {}

  if ('title' in fields) {
    const title = readTitle(fields['title'])
    if (title === null) {
      return jsonError(400, 'invalid_title', 'title must be a non-empty string up to 256 chars')
    }
    patch.title = title
  }
  if ('description' in fields) {
    const description = readOptionalString(fields['description'], MAX_DESCRIPTION_LEN)
    if (description === false) {
      return jsonError(400, 'invalid_description', `description must be a string up to ${MAX_DESCRIPTION_LEN} chars`)
    }
    patch.description = description
  }
  if ('priority' in fields) {
    const priority = readPriority(fields['priority'])
    if (priority === false) {
      return jsonError(400, 'invalid_priority', 'priority must be an integer 0..3 or null')
    }
    patch.priority = priority
  }
  if ('due_date' in fields) {
    const due_date = readDueDate(fields['due_date'])
    if (due_date === false) {
      return jsonError(400, 'invalid_due_date', 'due_date must be a valid ISO-8601 string or null')
    }
    patch.due_date = due_date
  }
  if ('owner_persona' in fields) {
    const owner_persona = readOptionalString(fields['owner_persona'], MAX_OWNER_PERSONA_LEN)
    if (owner_persona === false) {
      return jsonError(400, 'invalid_owner_persona', `owner_persona must be a string up to ${MAX_OWNER_PERSONA_LEN} chars`)
    }
    patch.owner_persona = owner_persona
  }
  if ('status' in fields) {
    const status = readStatus(fields['status'])
    if (status === null) {
      return jsonError(400, 'invalid_status', `status must be one of: ${ALL_TASK_STATUSES.join(', ')}`)
    }
    patch.status = status
  }

  try {
    const updated = await store.update(task_id, patch)
    return jsonOk({ task: updated, project_id, project_slug })
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      return jsonError(404, 'task_not_found', `task_id=${task_id}`)
    }
    throw err
  }
}

async function handleComplete(
  store: TaskStore,
  project_slug: string,
  project_id: string,
  task_id: string,
): Promise<Response> {
  const ownership = assertTaskInProject(store, task_id, project_slug, project_id)
  if ('error' in ownership) return ownership.error
  try {
    const updated = await store.complete(task_id)
    return jsonOk({ task: updated, project_id, project_slug })
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      return jsonError(404, 'task_not_found', `task_id=${task_id}`)
    }
    throw err
  }
}

async function handleCancel(
  store: TaskStore,
  project_slug: string,
  project_id: string,
  task_id: string,
): Promise<Response> {
  const ownership = assertTaskInProject(store, task_id, project_slug, project_id)
  if ('error' in ownership) return ownership.error
  try {
    const updated = await store.cancel(task_id)
    return jsonOk({ task: updated, project_id, project_slug })
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      return jsonError(404, 'task_not_found', `task_id=${task_id}`)
    }
    throw err
  }
}

async function handleDelete(
  store: TaskStore,
  project_slug: string,
  project_id: string,
  task_id: string,
): Promise<Response> {
  const ownership = assertTaskInProject(store, task_id, project_slug, project_id)
  if ('error' in ownership) return ownership.error
  try {
    await store.delete(task_id)
    return jsonOk({ ok: true, deleted_task_id: task_id, project_id, project_slug })
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      return jsonError(404, 'task_not_found', `task_id=${task_id}`)
    }
    throw err
  }
}

interface OwnershipOk {
  task: Task
}

interface OwnershipErr {
  error: Response
}

/**
 * Re-fetch the task and assert it belongs to the bearer's instance AND
 * the path's project_id. Returns 404 on any mismatch so a caller can't
 * probe for the existence of tasks in other instances / projects.
 */
function assertTaskInProject(
  store: TaskStore,
  task_id: string,
  project_slug: string,
  project_id: string,
): OwnershipOk | OwnershipErr {
  const existing = store.get(task_id)
  if (existing === null) {
    return { error: jsonError(404, 'task_not_found', `task_id=${task_id}`) }
  }
  if (ownerSlugMismatch(existing.project_slug, project_slug) || existing.project_id !== project_id) {
    // Same response shape as not-found so callers can't distinguish
    // "missing" from "exists but isn't mine" via the status code.
    return { error: jsonError(404, 'task_not_found', `task_id=${task_id}`) }
  }
  return { task: existing }
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

function parseStatusFilter(raw: string | null): TaskStatusFilter | undefined {
  if (raw === null || raw === '') return 'open'
  if (raw === 'all') return 'all'
  if (ALL_TASK_STATUSES.includes(raw as TaskStatus)) return raw as TaskStatus
  return undefined
}

function parseLimit(raw: string | null): number | null | undefined {
  if (raw === null || raw === '') return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 500) return undefined
  return parsed
}

/**
 * Optional `?order=` opt-in. Empty or absent maps to the P6.0 default
 * ordering; `'focus_score'` switches to the Focus DESC NULLS LAST
 * variant. Any other value is rejected with 400.
 */
function parseOrder(raw: string | null): TaskOrder | undefined {
  if (raw === null || raw === '') return 'default'
  if (ALL_TASK_ORDERS.includes(raw as TaskOrder)) return raw as TaskOrder
  return undefined
}

/** Returns the validated title or `null` when malformed. */
function readTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LEN) return null
  return trimmed
}

/**
 * Optional-string parser. Returns the string (possibly null) on
 * success, or `false` to mean "field present but malformed". The
 * caller distinguishes `false` from `null` so a missing field stays
 * unset while an explicit `null` clears the column.
 */
function readOptionalString(raw: unknown, max_len: number): string | null | false {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return false
  if (raw.length > max_len) return false
  return raw
}

function readPriority(raw: unknown): number | null | false {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return false
  if (raw < 0 || raw > 3) return false
  return raw
}

function readDueDate(raw: unknown): string | null | false {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return false
  if (raw.length === 0 || raw.length > 64) return false
  // ISO-8601 detection: must parse as a finite Date AND must roughly
  // look like an ISO string (Date.parse accepts many forms; we want to
  // reject e.g. "tomorrow" or "5/20/2026"). Accept anything that starts
  // with `YYYY-MM-DD` and parses cleanly.
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return false
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return false
  return raw
}

function readStatus(raw: unknown): TaskStatus | null {
  if (typeof raw !== 'string') return null
  if (!ALL_TASK_STATUSES.includes(raw as TaskStatus)) return null
  return raw as TaskStatus
}

function sanitizeTaskId(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_TASK_ID_LEN) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(raw)) return null
  return raw
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
