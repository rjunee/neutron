/**
 * @neutronai/gateway/http — Expo-app project reminders surface (P5.4).
 *
 * Per SPEC.md § Phases→Steps (P5.4 — "Tasks tab +
 * Reminders tab (per-project). Projections over P6 task DB + reminders
 * engine"). Exposes four routes:
 *
 *   - `GET  /api/app/projects/<project_id>/reminders[?status=pending]`
 *       list reminders scoped to (project_slug, project_id)
 *   - `POST /api/app/projects/<project_id>/reminders`
 *       create — `{ message: string, fire_at: number (unix seconds) }`
 *   - `POST /api/app/projects/<project_id>/reminders/<id>/snooze`
 *       reschedule — `{ new_fire_at: number (unix seconds) }`
 *   - `POST /api/app/projects/<project_id>/reminders/<id>/cancel`
 *
 * Auth shares the app-ws surface contract (Bearer token resolved by
 * `AppWsAuthResolver`). The project is encoded into the reminder's
 * `topic_id` as `app-project:<project_id>` at create time so the
 * existing instance+topic_id index handles project isolation without
 * touching the schema. Engine-organic reminders (Telegram topic ids
 * or NULL) are intentionally NOT included — the tab is project-scoped
 * by spec.
 *
 * Server is authoritative — mutations return the post-mutation
 * ordered list so the client doesn't have to follow up with a GET.
 */

import type { ReminderStore } from '@neutronai/reminders/index.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { sanitizeProjectId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { ownerSlugMismatch } from './auth-helpers.ts'

const PATH_PREFIX = '/api/app/projects/'
/**
 * Matches `/api/app/projects/<project_id>/reminders[/<id>/<action>]`.
 * Group 1 = project_id, 2 = reminder id (optional), 3 = action
 * (optional, only valid when [2] is present).
 *
 * The verb character class is `[a-z-]+` (P5.5) so kebab-case verbs
 * like `convert-to-task` match — the rest of the URL surface
 * convention is kebab-case for multi-word actions.
 */
const REMINDERS_PATH_RE =
  /^\/api\/app\/projects\/([^/]+)\/reminders(?:\/([^/]+)\/([a-z-]+))?$/

/** Encode the project_id into a topic_id used only by the app surface. */
export function appProjectTopicId(project_id: string): string {
  return `app-project:${project_id}`
}

/** Limits for create / snooze payloads. */
export const MAX_REMINDER_MESSAGE_LEN = 4096
/** Reject fire_at more than this many seconds in the past at create time. */
export const MAX_PAST_DRIFT_SECONDS = 60
/** Reject fire_at more than this many seconds in the future (cap absurdity). */
export const MAX_FUTURE_DRIFT_SECONDS = 60 * 60 * 24 * 365 * 5 // 5 years
/** P5.5 — max title length for convert-to-task (matches TaskStore.title cap). */
export const MAX_CONVERT_TITLE_LEN = 256
/** P5.5 — valid priority range for convert-to-task (0 = highest, 3 = lowest). */
export const MIN_CONVERT_PRIORITY = 0
export const MAX_CONVERT_PRIORITY = 3

/**
 * P5.5 — adapter input for the Reminders Core's
 * `reminders_convert_to_task` tool, surfaced as a per-instance HTTP
 * route. The surface deliberately remaps the Core's input shape
 * (`id` → `reminder_id`, adds the URL-resolved `project_slug` +
 * `project_id`) so the surface signature stays uniform with snooze /
 * cancel.
 */
export interface ConvertReminderToTaskInput {
  project_slug: string
  reminder_id: string
  project_id: string
  title?: string
  priority?: number
}

export interface ConvertReminderToTaskResult {
  task_id: string
  linked_reminder_id: string | null
  cancelled_reminder_id: string
}

export type ConvertReminderToTaskAdapter = (
  input: ConvertReminderToTaskInput,
) => Promise<ConvertReminderToTaskResult>

export interface AppRemindersSurfaceOptions {
  store: ReminderStore
  auth: AppWsAuthResolver
  /** Override `Date.now` for tests. */
  now?: () => number
  /**
   * P5.5 — adapter for the Reminders Core's
   * `reminders_convert_to_task` tool, surfaced as a per-instance HTTP
   * route. When omitted, the route returns 501 `not_implemented`.
   * Production composition wires this from
   * `cores/free/reminders/src/backend.ts:buildReminderStoreBackend`
   * (which has the canonical TaskStore wired per P6 § 4.9).
   */
  convertReminderToTask?: ConvertReminderToTaskAdapter
}

export interface AppRemindersSurface {
  handler: (req: Request) => Promise<Response | null>
}

export interface AppRemindersListItem {
  id: string
  message: string
  fire_at: number
  status: 'pending' | 'fired' | 'cancelled'
  recurrence: 'weekly' | 'monthly' | 'occasional' | null
  created_at: number
}

export function createAppRemindersSurface(
  opts: AppRemindersSurfaceOptions,
): AppRemindersSurface {
  const { store, auth } = opts
  const now = opts.now ?? (() => Date.now())
  const convertReminderToTask = opts.convertReminderToTask ?? null
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!pathname.startsWith(PATH_PREFIX)) return null
      const match = REMINDERS_PATH_RE.exec(pathname)
      if (match === null) return null
      const raw_project_id = match[1]
      const reminder_id = match[2] ?? ''
      const action = match[3] ?? ''
      const project_id = sanitizeProjectId(raw_project_id)
      if (project_id === null) {
        return jsonResponse(400, {
          ok: false,
          code: 'invalid_project_id',
          message: 'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
        })
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonResponse(401, { ok: false, code: resolved.code, message: resolved.message })
      }

      const method = req.method
      const topic_id = appProjectTopicId(project_id)

      if (reminder_id === '' && action === '' && method === 'GET') {
        return handleList(store, resolved.project_slug, project_id, topic_id, url)
      }
      if (reminder_id === '' && action === '' && method === 'POST') {
        return await handleCreate(req, store, resolved.project_slug, project_id, topic_id, now)
      }
      if (reminder_id !== '' && method === 'POST') {
        const validated_id = validateReminderId(reminder_id)
        if (validated_id === null) {
          return jsonResponse(400, {
            ok: false,
            code: 'invalid_reminder_id',
            message: 'reminder id must be 1-128 chars from [A-Za-z0-9_.-]',
          })
        }
        if (action === 'snooze') {
          return await handleSnooze(req, store, resolved.project_slug, project_id, topic_id, validated_id, now)
        }
        if (action === 'cancel') {
          return await handleCancel(store, resolved.project_slug, project_id, topic_id, validated_id)
        }
        if (action === 'convert-to-task') {
          return await handleConvertToTask(
            req,
            store,
            resolved.project_slug,
            project_id,
            topic_id,
            validated_id,
            convertReminderToTask,
          )
        }
      }
      return jsonResponse(405, {
        ok: false,
        code: 'method_not_allowed',
        message: `unknown reminders route or method '${method}' for path '${pathname}'`,
      })
    },
  }
}

function handleList(
  store: ReminderStore,
  project_slug: string,
  project_id: string,
  topic_id: string,
  url: URL,
): Response {
  // status query param — only 'pending' is supported today (the engine
  // doesn't expose listFired/listCancelled scoped to a topic). Reject
  // anything else with 400 so clients can't silently fall back to
  // pending semantics for what they think is fired/cancelled.
  const status = url.searchParams.get('status') ?? 'pending'
  if (status !== 'pending') {
    return jsonResponse(400, {
      ok: false,
      code: 'invalid_status',
      message: "only status='pending' is supported by this endpoint today",
    })
  }
  const pending = store.listPendingByTopic(project_slug, topic_id)
  // ISSUE #38 — optional `include_id=<reminder_id>` query param widens
  // the response to include a single specific reminder even when its
  // status is `fired` / `cancelled`. The Expo reminders tab passes this
  // on the FIRST fetch after a push-tap (the tick loop calls
  // `markFired` BEFORE the push dispatcher fans out, so by the time the
  // user taps the row is already `status='fired'` and absent from
  // `listPendingByTopic`). Instance + topic_id scope are still enforced
  // — a `include_id` that resolves to a row on a different instance or
  // topic is silently ignored (no leak). Symmetric pair to the Tasks
  // deep-link consumer pattern (PR #276 ISSUE #18).
  const include_id_raw = url.searchParams.get('include_id')
  let reminders = pending.map(toListItem)
  if (include_id_raw !== null) {
    const include_id = validateReminderId(include_id_raw)
    if (include_id === null) {
      return jsonResponse(400, {
        ok: false,
        code: 'invalid_include_id',
        message: 'include_id must be 1-128 chars from [A-Za-z0-9_.-]',
      })
    }
    // Skip the round-trip if the row is already in the pending list.
    const already_present = pending.some((r) => r.id === include_id)
    if (!already_present) {
      const extra = store.get(include_id)
      // ISSUE #34 follow-up (2026-05-23) — route through
      // `ownerSlugMismatch` so the cross-surface timing-safe gate
      // closes. The include_id is caller-controlled via the query
      // string so this check IS a security boundary (user A's
      // include_id pointing at user B's reminder would otherwise leak
      // user B's row into user A's listing). PR #288 closed every
      // other project_slug-comparison site but missed this one.
      if (
        extra !== null &&
        !ownerSlugMismatch(extra.project_slug, project_slug) &&
        extra.topic_id === topic_id
      ) {
        reminders = [...reminders, toListItem(extra)]
      }
    }
  }
  return jsonResponse(200, {
    ok: true,
    reminders,
    project_id,
    project_slug,
  })
}

async function handleCreate(
  req: Request,
  store: ReminderStore,
  project_slug: string,
  project_id: string,
  topic_id: string,
  now: () => number,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'malformed_json',
      message: 'expected { message: string, fire_at: number }',
    })
  }
  const message = readMessage(body)
  if (message === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_message',
      message: `expected message: non-empty string up to ${MAX_REMINDER_MESSAGE_LEN} chars`,
    })
  }
  const fire_at = readFireAt(body)
  if (fire_at === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_fire_at',
      message: 'expected fire_at: finite number (unix seconds)',
    })
  }
  const now_s = now() / 1000
  if (fire_at < now_s - MAX_PAST_DRIFT_SECONDS) {
    return jsonResponse(400, {
      ok: false,
      code: 'fire_at_in_past',
      message: 'fire_at must be in the future (60s drift tolerance)',
    })
  }
  if (fire_at > now_s + MAX_FUTURE_DRIFT_SECONDS) {
    return jsonResponse(400, {
      ok: false,
      code: 'fire_at_too_far',
      message: 'fire_at must be within 5 years from now',
    })
  }
  await store.create({
    project_slug,
    topic_id,
    fire_at,
    message,
    source: 'app:reminders-tab',
  })
  return await respondWithList(store, project_slug, project_id, topic_id)
}

async function handleSnooze(
  req: Request,
  store: ReminderStore,
  project_slug: string,
  project_id: string,
  topic_id: string,
  reminder_id: string,
  now: () => number,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'malformed_json',
      message: 'expected { new_fire_at: number }',
    })
  }
  const new_fire_at = readNewFireAt(body)
  if (new_fire_at === null) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_new_fire_at',
      message: 'expected new_fire_at: finite number (unix seconds)',
    })
  }
  const now_s = now() / 1000
  if (new_fire_at < now_s - MAX_PAST_DRIFT_SECONDS) {
    return jsonResponse(400, {
      ok: false,
      code: 'fire_at_in_past',
      message: 'new_fire_at must be in the future (60s drift tolerance)',
    })
  }
  if (new_fire_at > now_s + MAX_FUTURE_DRIFT_SECONDS) {
    return jsonResponse(400, {
      ok: false,
      code: 'fire_at_too_far',
      message: 'new_fire_at must be within 5 years from now',
    })
  }
  // Verify the reminder belongs to this (owner, project) pair BEFORE
  // touching it — otherwise a malicious client could rewrite any
  // reminder's fire_at as long as it knew the id.
  const owner_check = store.get(reminder_id)
  if (
    owner_check === null ||
    ownerSlugMismatch(owner_check.project_slug, project_slug) ||
    owner_check.topic_id !== topic_id
  ) {
    return jsonResponse(404, {
      ok: false,
      code: 'reminder_not_found',
      message: 'no reminder with that id for this project',
    })
  }
  const ok = await store.reschedule(reminder_id, new_fire_at)
  if (!ok) {
    return jsonResponse(409, {
      ok: false,
      code: 'reminder_not_pending',
      message: 'reminder is not pending (already fired or cancelled)',
    })
  }
  return await respondWithList(store, project_slug, project_id, topic_id)
}

async function handleConvertToTask(
  req: Request,
  store: ReminderStore,
  project_slug: string,
  project_id: string,
  topic_id: string,
  reminder_id: string,
  adapter: ConvertReminderToTaskAdapter | null,
): Promise<Response> {
  // 1. Adapter wired? When omitted the surface ships in "no convert"
  //    mode (e.g. unit-test harness without a TaskStore). Surface as
  //    501 so the client can distinguish "not configured" from
  //    "configured but failed".
  if (adapter === null) {
    return jsonResponse(501, {
      ok: false,
      code: 'not_implemented',
      message: 'convert-to-task is not wired on this gateway',
    })
  }
  // 2. Cross-instance / cross-project guard BEFORE invoking the adapter
  //    — otherwise a malicious client could promote any reminder it
  //    learned the id of into a task in this instance. Mirrors the
  //    snooze / cancel ownership check verbatim.
  const owner_check = store.get(reminder_id)
  if (
    owner_check === null ||
    ownerSlugMismatch(owner_check.project_slug, project_slug) ||
    owner_check.topic_id !== topic_id
  ) {
    return jsonResponse(404, {
      ok: false,
      code: 'reminder_not_found',
      message: 'no reminder with that id for this project',
    })
  }
  if (owner_check.status !== 'pending') {
    return jsonResponse(409, {
      ok: false,
      code: 'reminder_not_pending',
      message: 'reminder is not pending (already fired or cancelled)',
    })
  }
  // 3. Optional body — title + priority overrides. Body is optional;
  //    `{}` and a completely empty request are both valid. Malformed
  //    JSON with a non-trivial payload → 400.
  const raw = await req.text().catch(() => '')
  let body: unknown = {}
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw)
    } catch {
      return jsonResponse(400, {
        ok: false,
        code: 'malformed_json',
        message: 'expected {} or { title?: string, priority?: number }',
      })
    }
  }
  const title = readOptionalTitle(body)
  if (title === 'invalid') {
    return jsonResponse(400, {
      ok: false,
      code: 'invalid_title',
      message: `title must be 1..${MAX_CONVERT_TITLE_LEN} non-empty chars`,
    })
  }
  const priority = readOptionalPriority(body)
  if (priority === 'invalid') {
    return jsonResponse(400, {
      ok: false,
      code: 'invalid_priority',
      message: `priority must be an integer ${MIN_CONVERT_PRIORITY}..${MAX_CONVERT_PRIORITY}`,
    })
  }
  // 4. Invoke the adapter. The Reminders Core's
  //    `convertToTask` writes the new task + cancels the original
  //    reminder + creates a fresh linked reminder via the task ↔
  //    reminder auto-link (P6 § 4.8). Errors surface as 500 with the
  //    inner message so the client banner has something useful.
  let result: ConvertReminderToTaskResult
  try {
    const input: ConvertReminderToTaskInput = {
      project_slug,
      reminder_id,
      project_id,
      ...(title !== undefined ? { title } : {}),
      ...(priority !== undefined ? { priority } : {}),
    }
    result = await adapter(input)
  } catch (err) {
    const message =
      err instanceof Error && err.message.length > 0
        ? err.message
        : 'convert-to-task adapter threw'
    return jsonResponse(500, {
      ok: false,
      code: 'convert_failed',
      message,
    })
  }
  // 5. Return the post-mutation list AND the conversion metadata so
  //    the client can surface the new task_id if it wants to.
  const reminders = store
    .listPendingByTopic(project_slug, topic_id)
    .map(toListItem)
  return jsonResponse(200, {
    ok: true,
    reminders,
    project_id,
    project_slug,
    task_id: result.task_id,
    linked_reminder_id: result.linked_reminder_id,
    cancelled_reminder_id: result.cancelled_reminder_id,
  })
}

async function handleCancel(
  store: ReminderStore,
  project_slug: string,
  project_id: string,
  topic_id: string,
  reminder_id: string,
): Promise<Response> {
  const owner_check = store.get(reminder_id)
  if (
    owner_check === null ||
    ownerSlugMismatch(owner_check.project_slug, project_slug) ||
    owner_check.topic_id !== topic_id
  ) {
    return jsonResponse(404, {
      ok: false,
      code: 'reminder_not_found',
      message: 'no reminder with that id for this project',
    })
  }
  const ok = await store.cancel(reminder_id)
  if (!ok) {
    return jsonResponse(409, {
      ok: false,
      code: 'reminder_not_pending',
      message: 'reminder is not pending (already fired or cancelled)',
    })
  }
  return await respondWithList(store, project_slug, project_id, topic_id)
}

async function respondWithList(
  store: ReminderStore,
  project_slug: string,
  project_id: string,
  topic_id: string,
): Promise<Response> {
  const reminders = store
    .listPendingByTopic(project_slug, topic_id)
    .map(toListItem)
  return jsonResponse(200, {
    ok: true,
    reminders,
    project_id,
    project_slug,
  })
}

function toListItem(r: {
  id: string
  message: string
  fire_at: number
  status: 'pending' | 'fired' | 'cancelled'
  recurrence: 'weekly' | 'monthly' | 'occasional' | null
  created_at: number
}): AppRemindersListItem {
  return {
    id: r.id,
    message: r.message,
    fire_at: r.fire_at,
    status: r.status,
    recurrence: r.recurrence,
    created_at: r.created_at,
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

function readMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const v = (body as Record<string, unknown>)['message']
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_REMINDER_MESSAGE_LEN) return null
  return trimmed
}

function readFireAt(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null
  const v = (body as Record<string, unknown>)['fire_at']
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return v
}

function readNewFireAt(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null
  const v = (body as Record<string, unknown>)['new_fire_at']
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return v
}

/**
 * P5.5 — optional title for the convert-to-task body. Returns:
 *   - `undefined` if the field is absent or `null`.
 *   - `string` if present and a non-empty 1..MAX_CONVERT_TITLE_LEN string.
 *   - `'invalid'` if present but malformed (non-string, empty, too long).
 */
function readOptionalTitle(body: unknown): string | undefined | 'invalid' {
  if (typeof body !== 'object' || body === null) return undefined
  const v = (body as Record<string, unknown>)['title']
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') return 'invalid'
  const trimmed = v.trim()
  if (trimmed.length === 0) return 'invalid'
  if (trimmed.length > MAX_CONVERT_TITLE_LEN) return 'invalid'
  return trimmed
}

/**
 * P5.5 — optional priority for the convert-to-task body. Returns:
 *   - `undefined` if absent or `null`.
 *   - `number` if present and an integer in 0..3.
 *   - `'invalid'` if present but out-of-range / non-integer / non-number.
 */
function readOptionalPriority(body: unknown): number | undefined | 'invalid' {
  if (typeof body !== 'object' || body === null) return undefined
  const v = (body as Record<string, unknown>)['priority']
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v)) return 'invalid'
  if (v < MIN_CONVERT_PRIORITY || v > MAX_CONVERT_PRIORITY) return 'invalid'
  return v
}

function validateReminderId(raw: string): string | null {
  if (raw.length === 0 || raw.length > 128) return null
  // UUIDs (with hyphens) + slug-like ids. Same charset as project_id /
  // launcher slugs so a malformed client can't push surprising bytes
  // through downstream join keys.
  if (!/^[A-Za-z0-9_.-]+$/.test(raw)) return null
  return raw
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
