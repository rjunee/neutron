/**
 * landing/chat-react — web TASKS API client (WAVE 3 PR-8).
 *
 * The web twin of the mobile `app/lib/tasks-client.ts`. A thin fetch wrapper for
 * the gateway's project-scoped tasks surface (`gateway/http/app-tasks-surface.ts`):
 *
 *   GET    /api/app/projects/<id>/tasks?status=<f>&order=<o>   list
 *   POST   /api/app/projects/<id>/tasks                        create
 *   PATCH  /api/app/projects/<id>/tasks/<task_id>              update (reprioritize)
 *   POST   /api/app/projects/<id>/tasks/<task_id>/complete     complete
 *   POST   /api/app/projects/<id>/tasks/<task_id>/cancel       cancel
 *   DELETE /api/app/projects/<id>/tasks/<task_id>              delete
 *
 * ── Prioritized order is the engine's (WAVE 3 PR-7) ─────────────────────────
 * The web Tasks tab lists with `order='focus_score'` so the rows come back in
 * the LLM-primary prioritized order shipped in PR-7 (`tasks/prioritize-llm.ts`):
 * ranked rows first by their `llm_rank`, fresh rows interleaved by `focus_score`.
 * The store is the single source of truth for the ordering — the client never
 * re-sorts. The `llm_rank` / `llm_reason` / `prioritized_by` columns ride along
 * on every row so the tab can surface the rank + the LLM's one-line rationale.
 *
 * ── Agent + user parity ─────────────────────────────────────────────────────
 * Every action here (add / complete / reprioritize / cancel / delete) is the
 * SAME canonical `TaskStore` the agent's `cores/free/tasks` backend writes
 * (`buildSubstrateTaskStoreBackend`). Reprioritize = a PATCH of the 0-3
 * `priority` field — the same column the deterministic focus-score reads — so a
 * user nudge competes with the agent's ranking on the next prioritize pass.
 *
 * Wire shapes mirror the gateway types byte-for-byte but are re-declared here
 * (rather than imported across the workspace boundary) so the browser bundle
 * stays free of a gateway dependency — the same convention the sibling
 * `docs-client.ts` / `tabs-client.ts` follow. Pure given an injected
 * `fetchImpl`, so it unit-tests without a DOM or a live server.
 */

/* ─── wire types (mirror tasks/store.ts) ─── */

export type TaskStatus = 'open' | 'done' | 'cancelled'
export type TaskStatusFilter = TaskStatus | 'all'

/** `'default'` = canonical order; `'focus_score'` = the PR-7 prioritized order. */
export type TaskOrder = 'default' | 'focus_score'

export interface Task {
  id: string
  project_slug: string
  project_id: string
  title: string
  description: string | null
  status: TaskStatus
  /** 0-3; 0 = none, 3 = highest. Null when unset. */
  priority: number | null
  /** ISO-8601, sortable. */
  due_date: string | null
  owner_persona: string | null
  source: string | null
  /** Deterministic focus score (`tasks/focus-score.ts`). Null pre-cron. */
  focus_score: number | null
  focus_score_updated_at: string | null
  /** 1-based rank from the most recent LLM-primary prioritize pass (PR-7). */
  llm_rank: number | null
  /** LLM's one-line rationale for the rank. Null in the deterministic fallback. */
  llm_reason: string | null
  /** Which mechanism produced the current rank. Null until first pass. */
  prioritized_by: 'llm' | 'deterministic' | null
  prioritized_at: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface CreateTaskInput {
  title: string
  description?: string | null
  priority?: number | null
  due_date?: string | null
  owner_persona?: string | null
}

export interface UpdateTaskInput {
  title?: string
  description?: string | null
  priority?: number | null
  due_date?: string | null
  owner_persona?: string | null
  status?: TaskStatus
}

interface ListResponse {
  ok: boolean
  tasks: Task[]
  project_id: string
  status: TaskStatusFilter
  order: TaskOrder
}
interface TaskResponse {
  ok: boolean
  task: Task
}
interface ErrorBody {
  ok?: boolean
  code?: string
  message?: string
}

export class TasksClientError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`)
    this.name = 'TasksClientError'
    this.code = code
    this.status = status
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export interface TasksClientOptions {
  /** Page origin (`https://host`); the surface lives at `/api/app/...`. */
  base_url: string
  /** App-ws bearer token (`config.token`). */
  token: string
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: FetchImpl
}

export class WebTasksClient {
  private readonly base_url: string
  private readonly token: string
  private readonly fetchImpl: FetchImpl

  constructor(opts: TasksClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  /**
   * List the project's tasks. Defaults to the PR-7 prioritized ordering
   * (`order='focus_score'`) so the tab renders agent-ranked rows first; pass
   * `'default'` for the canonical order.
   */
  async list(
    project_id: string,
    status: TaskStatusFilter = 'open',
    order: TaskOrder = 'focus_score',
  ): Promise<Task[]> {
    const params = new URLSearchParams({ status })
    if (order !== 'default') params.set('order', order)
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/tasks?${params.toString()}`
    const res = await this.req<ListResponse>(path)
    return res.tasks
  }

  /** Create a task (the "add" affordance). */
  async create(project_id: string, input: CreateTaskInput): Promise<Task> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/tasks`
    const res = await this.req<TaskResponse>(path, { method: 'POST', body: input })
    return res.task
  }

  /** Patch a task — used for reprioritize (priority) + inline edits. */
  async update(project_id: string, task_id: string, input: UpdateTaskInput): Promise<Task> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/tasks/${encodeURIComponent(task_id)}`
    const res = await this.req<TaskResponse>(path, { method: 'PATCH', body: input })
    return res.task
  }

  /** Mark a task done. */
  async complete(project_id: string, task_id: string): Promise<Task> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/tasks/${encodeURIComponent(task_id)}/complete`
    const res = await this.req<TaskResponse>(path, { method: 'POST' })
    return res.task
  }

  /** Cancel a task. */
  async cancel(project_id: string, task_id: string): Promise<Task> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/tasks/${encodeURIComponent(task_id)}/cancel`
    const res = await this.req<TaskResponse>(path, { method: 'POST' })
    return res.task
  }

  /** Delete a task. */
  async delete(project_id: string, task_id: string): Promise<void> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/tasks/${encodeURIComponent(task_id)}`
    await this.req<{ ok: boolean; deleted_task_id: string }>(path, { method: 'DELETE' })
  }

  private async req<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? 'GET'
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` }
    let body: string | undefined
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.body)
    }
    let res: Response
    try {
      res = await this.fetchImpl(`${this.base_url}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      })
    } catch (err) {
      throw new TasksClientError('network', err instanceof Error ? err.message : 'network error', 0)
    }
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      // fall through to the status-coded error below
    }
    if (!res.ok) {
      const errBody = (json ?? {}) as ErrorBody
      const code = errBody.code ?? 'request_failed'
      const message = errBody.message ?? `HTTP ${res.status}`
      throw new TasksClientError(code, message, res.status)
    }
    return json as T
  }
}

/* ─── pure helpers ─── */

/** Priority chip label for the 0-3 scale (null = none). */
export function priorityLabel(priority: number | null): string {
  switch (priority) {
    case 3:
      return 'P0'
    case 2:
      return 'P1'
    case 1:
      return 'P2'
    case 0:
      return 'P3'
    default:
      return ''
  }
}

/** Clamp a 0-3 priority into range; returns null when out of band. */
export function clampPriority(next: number): number | null {
  if (!Number.isInteger(next) || next < 0 || next > 3) return null
  return next
}

/**
 * Format a due date for the row. Returns the bare `YYYY-MM-DD` (the part the
 * store sorts on) so the tab stays timezone-honest — the store anchors on the
 * ISO string, not a localized render.
 */
export function formatDue(due_date: string | null): string {
  if (due_date === null || due_date.length === 0) return ''
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(due_date)
  return m !== null ? (m[1] as string) : due_date
}
