/**
 * @neutronai/gateway/http — Expo-app global Focus surface (P5.5).
 *
 * Per SPEC.md § Phases→Steps (P5.5 — "Global Focus
 * view. Cross-project today/most-important projection") and
 * docs/engineering-plan.md § B.P5:
 *
 *   "Global 'Focus' view (cross-project). Top-level tab outside any
 *    project. Aggregates: today's most-important tasks across all
 *    projects (driven by the daily-nudge engine from P6), reminders
 *    firing today, the current-focus pick (one most-important thing).
 *    Tap any item → jumps into the originating project at the relevant
 *    context. This is the 'help me focus on what matters across
 *    everything' surface — a projection, not a source of truth."
 *
 * P5.5 scope (this sprint) — the aggregation + projection layer:
 *
 *   - `GET  /api/app/focus`  returns the prioritized cross-project
 *     list of tasks + reminders for the authenticated owner.
 *
 * Daily-nudge LLM (P6.x) is explicitly OUT OF SCOPE: P5.5 sorts by
 * priority DESC + due_at ASC and tags the bucket (`overdue` / `today`
 * / `soon`) deterministically. When the LLM nudge engine lands, the
 * "current focus pick" surfaces as a flagged item in this same
 * response — the response shape is forward-compatible.
 *
 * Auth shares the app-ws / app-launcher contract (Bearer token resolved
 * by `AppWsAuthResolver`). Instance isolation is enforced server-side:
 * every read filters by the resolved `project_slug` so a token bound to
 * one instance can never see another instance's tasks / reminders.
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { ReminderStore, type Reminder } from '@neutronai/reminders/store.ts'
import { ALL_TASK_ORDERS, NO_PROJECT, TaskStore, type Task, type TaskOrder } from '@neutronai/tasks/store.ts'

/**
 * Window (in milliseconds) past `now` that counts as "due today" for
 * task surfacing. 24h instead of "midnight rollover" so a task due in
 * 23 hours doesn't get hidden because today's calendar date already
 * flipped past it server-side.
 */
const TODAY_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Window (in seconds, matching ReminderStore's unix-second epoch) past
 * `now` that counts as "firing today". Same 24h horizon as the task
 * window for symmetry.
 */
const REMINDER_TODAY_WINDOW_S = 24 * 60 * 60

/**
 * Priority threshold for "important enough to surface even without a
 * near due date" (per spec: high-priority items appear in Focus even
 * if not due today). Matches the engineering-plan §B.P6 convention
 * that priority is 0-3 with 2+ counted as "high".
 */
const HIGH_PRIORITY_THRESHOLD = 2

/**
 * Hard cap on the number of open task rows the Focus aggregator will
 * scan across all projects. The aggregator page-walks `TaskStore.list`
 * (see `TASK_PAGE_SIZE`) and stops at this many rows so an instance with
 * a pathological backlog can't make the request walk indefinitely.
 *
 * 1000 chosen because: (a) it is well above the open-task counts we
 * see for active instances (Sam + Casey target instances today have
 * <100 open across all projects); (b) it still leaves room for a
 * pile of low-priority undated rows to be filtered out without
 * truncating the surfaced items.
 */
const MAX_TASKS_SCANNED = 1000

/**
 * Page size for the page-walking task scan. Small enough that any
 * single SQL prepare/exec stays fast; large enough that the typical
 * instance fits in 1-2 pages.
 */
const TASK_PAGE_SIZE = 250

/** Hard cap on pending reminders pulled from ReminderStore. */
const MAX_REMINDERS_AGGREGATED = 200

/** Final response cap — keep the prioritized list digestible. */
const MAX_FOCUS_ITEMS_RETURNED = 100

export type FocusItemKind = 'task' | 'reminder'

/**
 * Bucket label for the UI's grouped rendering. Computed server-side so
 * the client doesn't have to re-derive "overdue" vs "today" from
 * timezone-dependent date math.
 */
export type FocusBucket = 'overdue' | 'today' | 'soon'

export interface FocusItem {
  /** Discriminator — clients route taps differently per kind. */
  kind: FocusItemKind
  /** Stable id from the source row (TaskStore.id or ReminderStore.id). */
  id: string
  /** Project the item belongs to. `''` means instance-level / no project. */
  project_id: string
  /** Display title — task.title or a short rendering of the reminder body. */
  title: string
  /**
   * Due/fire time as ISO-8601 UTC. Null for tasks without a due_date
   * that surfaced via the high-priority path. Reminders always have a
   * fire time.
   */
  due_at: string | null
  /** 0-3 for tasks (or null when none set). Reminders default to null. */
  priority: number | null
  /** Bucket label (overdue / today / soon). */
  bucket: FocusBucket
  /**
   * Origin trace — `'tasks'` for TaskStore rows, `'reminders'` for
   * ReminderStore rows. The Task or Reminder may carry its own `source`
   * field (e.g. `'agent'` or `'@neutronai/reminders-core'`); that's
   * surfaced separately as `origin_source`.
   */
  source: 'tasks' | 'reminders'
  /** Pass-through of the underlying row's `source` field, if any. */
  origin_source: string | null
  /** P6 — focus score for task rows. Null for reminders and unscored tasks. */
  focus_score: number | null
}

export interface FocusResponse {
  ok: true
  project_slug: string
  /** ISO-8601 of the snapshot's `now` reference. */
  now: string
  /** The prioritized cross-project list (already capped + sorted). */
  today: FocusItem[]
}

export interface AppFocusSurfaceOptions {
  tasks: TaskStore
  reminders: ReminderStore
  auth: AppWsAuthResolver
  /** Override `Date.now` for tests. */
  now?: () => number
}

export interface AppFocusSurface {
  /**
   * HTTP route dispatcher. Returns the `Response` for an owned route,
   * or `null` to indicate the request belongs to a sibling surface so
   * the compose-chain falls through.
   */
  handler: (req: Request) => Promise<Response | null>
}

const FOCUS_PATH = '/api/app/focus'

export function createAppFocusSurface(opts: AppFocusSurfaceOptions): AppFocusSurface {
  const { tasks, reminders, auth } = opts
  const now = opts.now ?? (() => Date.now())
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      if (url.pathname !== FOCUS_PATH) return null

      if (req.method !== 'GET') {
        return jsonResponse(405, {
          ok: false,
          code: 'method_not_allowed',
          message: `expected GET /api/app/focus, got ${req.method}`,
        })
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        // Log structured detail server-side, but flatten the wire
        // response to a single `unauthorized` code so we don't leak
        // jose's internal claim-validation messages (e.g. which claim
        // failed `exp` check, signature vs expiry vs instance mismatch)
        // to unauthenticated callers. Per security-sentinel review.
        // `missing_bearer` is preserved because it's a client-shape
        // hint, not an auth-internals leak.
        const wireCode =
          resolved.code === 'missing_bearer' ? 'missing_bearer' : 'unauthorized'
        const wireMessage =
          resolved.code === 'missing_bearer'
            ? resolved.message
            : 'authentication required'
        return jsonResponse(401, {
          ok: false,
          code: wireCode,
          message: wireMessage,
        })
      }

      const raw_order = url.searchParams.get('order')
      const order = parseOrder(raw_order)
      if (order === undefined) {
        return jsonResponse(400, {
          ok: false,
          code: 'invalid_order',
          message: `order must be one of: ${ALL_TASK_ORDERS.join(', ')}`,
        })
      }

      const nowMs = now()
      const items = aggregateFocus({
        tasks,
        reminders,
        project_slug: resolved.project_slug,
        nowMs,
        order,
      })
      const body: FocusResponse = {
        ok: true,
        project_slug: resolved.project_slug,
        now: new Date(nowMs).toISOString(),
        today: items,
      }
      return jsonResponse(200, body)
    },
  }
}

function parseOrder(raw: string | null): TaskOrder | undefined {
  if (raw === null || raw === '') return 'default'
  if (ALL_TASK_ORDERS.includes(raw as TaskOrder)) return raw as TaskOrder
  return undefined
}

interface AggregateInput {
  tasks: TaskStore
  reminders: ReminderStore
  project_slug: string
  nowMs: number
  /** Default sort vs focus-score-DESC opt-in. */
  order: TaskOrder
}

/**
 * Pull open tasks + pending reminders for the owner, filter to the
 * "today" window OR high-priority, tag with bucket, and sort.
 *
 * Sort order (matches spec § BEHAVIORAL-SPEC GATE):
 *   1. Bucket order: overdue → today → soon. Overdue items always lead
 *      because they're already late; "today" beats "soon" because the
 *      day is the user's actionable horizon.
 *   2. Within a bucket, priority DESC (3 > 2 > 1 > 0 > null).
 *   3. Within a (bucket, priority), due_at ASC (soonest first; null
 *      sinks to the bottom — those only entered the list via the
 *      high-priority path).
 *
 * This is intentionally deterministic. The P6.x LLM nudge engine will
 * later promote ONE item to a "current focus" flag and re-rank, but
 * P5.5 ships the deterministic projection so the surface is usable
 * today without depending on an unbuilt LLM pass.
 */
function aggregateFocus(input: AggregateInput): FocusItem[] {
  const { tasks, reminders, project_slug, nowMs, order } = input
  const nowS = Math.floor(nowMs / 1000)
  const horizonMs = nowMs + TODAY_WINDOW_MS
  const horizonS = nowS + REMINDER_TODAY_WINDOW_S

  // Tasks — open, all projects, instance-scoped. We page-walk `TaskStore.list`
  // until we either run out of open rows OR exceed `MAX_TASKS_SCANNED`.
  //
  // Why page-walking instead of a single capped read: TaskStore.list
  // orders open rows as (dated ASC, then dateless DESC). A naive
  // `limit: MAX_TASKS_AGGREGATED` would silently drop high-priority
  // DATELESS tasks on instances with more open dated tasks than the
  // cap, because the dateless rows sort AFTER all the dated rows.
  // The spec says high-priority items must surface in `soon` even
  // without a near due date — page-walking preserves that contract
  // up to MAX_TASKS_SCANNED rows of headroom.
  //
  // Codex r1 P2: prior shape was a single `tasks.list({ ..., limit: 200 })`
  // which silently omitted high-priority dateless tasks on instances
  // with >200 dated open rows.
  const taskItems: FocusItem[] = []
  let scannedTasks = 0
  let offset = 0
  while (scannedTasks < MAX_TASKS_SCANNED) {
    const batch = tasks.list({
      project_slug,
      status: 'open',
      order,
      limit: TASK_PAGE_SIZE,
      offset,
    })
    if (batch.length === 0) break
    for (const t of batch) {
      scannedTasks += 1
      const due = parseDueDateMs(t.due_date)
      const isHigh = (t.priority ?? 0) >= HIGH_PRIORITY_THRESHOLD
      const dueSoon = due !== null && due <= horizonMs
      // `order=focus_score` flips the SORT key, NOT the FILTER. An
      // earlier shape admitted every scored row, so a P3 dateless task
      // could knock a high-pri reminder out of the 100-item cap. The
      // today/high-pri gate is unchanged regardless of order — the
      // focus_score order only reorders what passes the gate.
      if (!isHigh && !dueSoon) continue
      taskItems.push(taskToFocusItem(t, due, nowMs))
    }
    if (batch.length < TASK_PAGE_SIZE) break
    offset += batch.length
  }

  // Reminders — pending, instance-scoped, fire_at <= now + 24h.
  // Bounded at the SQL layer via `listPendingFiringBefore` so an instance
  // with a year of recurring reminders doesn't materialise every
  // pending row in JS heap before the cap kicks in.
  const pendingReminders = reminders.listPendingFiringBefore(
    project_slug,
    horizonS,
    MAX_REMINDERS_AGGREGATED,
  )
  const reminderItems: FocusItem[] = pendingReminders.map((r) =>
    reminderToFocusItem(r, nowS),
  )

  const merged = [...taskItems, ...reminderItems]
  if (order === 'focus_score') {
    merged.sort(compareFocusByScore)
  } else {
    merged.sort(compareFocus)
  }
  if (merged.length > MAX_FOCUS_ITEMS_RETURNED) {
    merged.length = MAX_FOCUS_ITEMS_RETURNED
  }
  return merged
}

function taskToFocusItem(task: Task, due_ms: number | null, nowMs: number): FocusItem {
  return {
    kind: 'task',
    id: task.id,
    project_id: task.project_id === NO_PROJECT ? '' : task.project_id,
    title: task.title,
    due_at: due_ms === null ? null : new Date(due_ms).toISOString(),
    priority: task.priority,
    bucket: bucketFor(due_ms, nowMs),
    source: 'tasks',
    origin_source: task.source,
    focus_score: task.focus_score,
  }
}

function reminderToFocusItem(reminder: Reminder, nowS: number): FocusItem {
  const fire_ms = Math.round(reminder.fire_at * 1000)
  const now_ms = nowS * 1000
  // The reminder's topic_id is the engine's routing handle (Telegram
  // thread id, app-socket synthetic topic, etc.) — it doubles as the
  // project_id for app-socket reminders because the topic id format
  // for the Expo channel is `app:<slug>:<project_id>:<user_id>` per
  // channels/adapters/app-ws/envelope.ts. For non-app-socket reminders
  // we surface the raw topic_id; the Focus UI treats empty / unknown
  // project_id values as "instance-level" reminders.
  const project_id = extractProjectIdFromTopic(reminder.topic_id) ?? ''
  return {
    kind: 'reminder',
    id: reminder.id,
    project_id,
    title: summarizeReminderBody(reminder.message),
    due_at: new Date(fire_ms).toISOString(),
    priority: null,
    bucket: bucketFor(fire_ms, now_ms),
    source: 'reminders',
    origin_source: reminder.source,
    focus_score: null,
  }
}

/**
 * Pull the project_id out of an app-surface synthetic topic id. Two
 * shapes are recognized today:
 *
 *   1. `app-project:<project_id>` — written by the P5.4 reminders
 *      surface (`appProjectTopicId()` in
 *      `gateway/http/app-reminders-surface.ts`). This is the
 *      production format for reminders the user creates from a
 *      project's Reminders tab.
 *   2. `app:<slug>:<project_id>:<user_id>` — written by the P5.1
 *      app-ws envelope helpers when the engine emits a reminder back
 *      through a chat-derived topic
 *      (`channels/adapters/app-ws/envelope.ts`).
 *
 * Returns null for any other shape (Telegram thread ids, malformed
 * strings, null). Engine-level reminders carry the raw Telegram
 * thread id which the Focus view does NOT treat as a project_id —
 * they surface with `project_id = ''` (instance-level) and route to
 * the project list since they have no originating tab.
 *
 * Codex r1 P1: pre-fix, only shape (2) was decoded, so reminders
 * created via the P5.4 Reminders tab (the dominant production path)
 * always rendered as instance-level and tapping them missed the
 * originating project.
 */
function extractProjectIdFromTopic(topic_id: string | null): string | null {
  if (typeof topic_id !== 'string') return null
  if (topic_id.startsWith('app-project:')) {
    const pid = topic_id.slice('app-project:'.length)
    return pid.length === 0 ? null : pid
  }
  const parts = topic_id.split(':')
  if (parts.length === 4 && parts[0] === 'app') {
    const pid = parts[2]
    if (pid !== undefined && pid.length > 0) return pid
  }
  return null
}

/**
 * Truncate a reminder body for the Focus list title. Reminder messages
 * are sometimes long instruction payloads for the fire-time agent;
 * we show a short single-line preview.
 */
function summarizeReminderBody(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return '(reminder)'
  if (collapsed.length <= 80) return collapsed
  return `${collapsed.slice(0, 77)}...`
}

function bucketFor(due_ms: number | null, nowMs: number): FocusBucket {
  if (due_ms === null) return 'soon'
  if (due_ms < nowMs) return 'overdue'
  if (due_ms <= nowMs + TODAY_WINDOW_MS) return 'today'
  return 'soon'
}

const BUCKET_RANK: Record<FocusBucket, number> = {
  overdue: 0,
  today: 1,
  soon: 2,
}

function compareFocus(a: FocusItem, b: FocusItem): number {
  const bucketDiff = BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket]
  if (bucketDiff !== 0) return bucketDiff
  // Priority DESC (higher first); null treated as 0.
  const aPrio = a.priority ?? 0
  const bPrio = b.priority ?? 0
  if (aPrio !== bPrio) return bPrio - aPrio
  // due_at ASC (sooner first); null sinks to the bottom.
  const aDue = a.due_at === null ? Number.POSITIVE_INFINITY : Date.parse(a.due_at)
  const bDue = b.due_at === null ? Number.POSITIVE_INFINITY : Date.parse(b.due_at)
  if (aDue !== bDue) return aDue - bDue
  // Final tie-break by id so the order is stable across calls.
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

/**
 * Focus-score-DESC comparator (opt-in via `?order=focus_score`).
 *
 * Sort order:
 *   1. focus_score DESC NULLS LAST. Reminders + unscored tasks land
 *      together at the bottom of the score-aware order.
 *   2. Bucket order (overdue → today → soon) as a stable secondary so
 *      reminders cluster sensibly inside the null-score bottom.
 *   3. due_at ASC (sooner first); null sinks to the bottom.
 *   4. id ASC for stable tie-break.
 */
function compareFocusByScore(a: FocusItem, b: FocusItem): number {
  const aScore = a.focus_score
  const bScore = b.focus_score
  if (aScore === null && bScore !== null) return 1
  if (aScore !== null && bScore === null) return -1
  if (aScore !== null && bScore !== null && aScore !== bScore) {
    return bScore - aScore
  }
  const bucketDiff = BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket]
  if (bucketDiff !== 0) return bucketDiff
  const aDue = a.due_at === null ? Number.POSITIVE_INFINITY : Date.parse(a.due_at)
  const bDue = b.due_at === null ? Number.POSITIVE_INFINITY : Date.parse(b.due_at)
  if (aDue !== bDue) return aDue - bDue
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

function parseDueDateMs(due_date: string | null): number | null {
  if (due_date === null) return null
  const ms = Date.parse(due_date)
  if (Number.isNaN(ms)) return null
  return ms
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
