/**
 * landing/chat-react — web TASKS API client.
 *
 * The web twin of the mobile `app/lib/tasks-client.ts`, over the SAME gateway
 * surface (`gateway/http/app-tasks-surface.ts`):
 *
 *   GET    /api/app/projects/<id>/tasks?status=&order=       list
 *   POST   /api/app/projects/<id>/tasks                      create
 *   PATCH  /api/app/projects/<id>/tasks/<task_id>            update
 *   POST   /api/app/projects/<id>/tasks/<task_id>/complete   complete
 *   POST   /api/app/projects/<id>/tasks/<task_id>/cancel     cancel
 *   DELETE /api/app/projects/<id>/tasks/<task_id>            delete
 *
 * ── One data path, two clients ──────────────────────────────────────────────
 * There is deliberately NO second store, cache, or shape here. The gateway
 * surface reads the canonical `TaskStore` that the agent's `tasks_core` MCP
 * tools also write, so a task the agent creates in chat and a task typed into
 * this tab are the same row, and the mobile app sees both. Adding a
 * web-specific path would have been the easy way to ship a Tasks screen and the
 * fastest way to make the two clients disagree.
 *
 * Wire shapes mirror `tasks/store.ts` but are re-declared here rather than
 * imported across the workspace boundary, so the browser bundle stays free of a
 * gateway dependency — the same convention `work-board-client.ts` /
 * `docs-client.ts` follow. Pure given an injected `fetchImpl`, so it unit-tests
 * without a DOM or a live server.
 */

import {
  GatewayClientError,
  GatewayHttpClient,
  type GatewayHttpClientOptions,
} from '@neutronai/client-core'

/* ─── wire types (mirror tasks/store.ts) ─── */

export type TaskStatus = 'open' | 'done' | 'cancelled'

/** The status filter the list endpoint accepts (`all` = no status filter). */
export type TaskStatusFilter = TaskStatus | 'all'

/** Server-side ordering. `focus_score` is what both clients ask for. */
export type TaskOrder = 'default' | 'focus_score'

/**
 * One task row as the surface returns it. The store emits more columns than
 * either client renders (`llm_rank`, `llm_reason`, `prioritized_by`,
 * `prioritized_at`, `focus_score_updated_at`); they are typed as optional here
 * so the shape stays honest about the wire without the tab pretending to use
 * them.
 */
export interface Task {
  id: string
  project_slug?: string
  project_id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: number | null
  due_date: string | null
  owner_persona: string | null
  source: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  focus_score?: number | null
}

export interface CreateTaskInput {
  title: string
  description?: string | null
  priority?: number | null
  /** `YYYY-MM-DD` (the surface validates the prefix + parseability). */
  due_date?: string | null
}

/**
 * A task patch. Every field is OPTIONAL-BUT-NULLABLE on purpose: the surface
 * distinguishes an absent key (leave the column alone) from an explicit `null`
 * (clear it), so callers must send only the fields that actually changed.
 */
export interface UpdateTaskInput {
  title?: string
  description?: string | null
  priority?: number | null
  due_date?: string | null
  status?: TaskStatus
}

interface ListResponse {
  ok: boolean
  tasks: Task[]
  project_id: string
  status: string
  order: string
}

interface TaskResponse {
  ok: boolean
  task: Task
}

export class TasksClientError extends GatewayClientError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status)
    this.name = 'TasksClientError'
  }
}

export type TasksClientOptions = GatewayHttpClientOptions

export class WebTasksClient extends GatewayHttpClient {
  protected override readonly guardNetworkErrors = true

  protected override makeError(code: string, message: string, status: number): GatewayClientError {
    return new TasksClientError(code, message, status)
  }

  private base(project_id: string): string {
    return `/api/app/projects/${encodeURIComponent(project_id)}/tasks`
  }

  /**
   * The filtered task list. `order` is omitted when `'default'` so the request
   * matches the mobile client's byte-for-byte (it only sends a non-default
   * order), keeping one server code path warm for both.
   */
  async list(
    project_id: string,
    opts: { status?: TaskStatusFilter; order?: TaskOrder } = {},
  ): Promise<Task[]> {
    const params = new URLSearchParams({ status: opts.status ?? 'open' })
    if (opts.order !== undefined && opts.order !== 'default') params.set('order', opts.order)
    const res = await this.req<ListResponse>(`${this.base(project_id)}?${params.toString()}`)
    return res.tasks
  }

  async create(project_id: string, input: CreateTaskInput): Promise<Task> {
    const res = await this.req<TaskResponse>(this.base(project_id), {
      method: 'POST',
      body: input,
    })
    return res.task
  }

  async update(project_id: string, task_id: string, input: UpdateTaskInput): Promise<Task> {
    const path = `${this.base(project_id)}/${encodeURIComponent(task_id)}`
    const res = await this.req<TaskResponse>(path, { method: 'PATCH', body: input })
    return res.task
  }

  async complete(project_id: string, task_id: string): Promise<Task> {
    const path = `${this.base(project_id)}/${encodeURIComponent(task_id)}/complete`
    const res = await this.req<TaskResponse>(path, { method: 'POST' })
    return res.task
  }

  async cancel(project_id: string, task_id: string): Promise<Task> {
    const path = `${this.base(project_id)}/${encodeURIComponent(task_id)}/cancel`
    const res = await this.req<TaskResponse>(path, { method: 'POST' })
    return res.task
  }

  async delete(project_id: string, task_id: string): Promise<void> {
    const path = `${this.base(project_id)}/${encodeURIComponent(task_id)}`
    await this.req<{ ok: boolean; deleted_task_id: string }>(path, { method: 'DELETE' })
  }

  /**
   * Reopen a completed task. The surface has no `/reopen` verb — status is a
   * plain patch — so this is a named wrapper rather than a new endpoint,
   * mirroring how the mobile checkbox toggles back to open.
   */
  async reopen(project_id: string, task_id: string): Promise<Task> {
    return this.update(project_id, task_id, { status: 'open' })
  }
}
