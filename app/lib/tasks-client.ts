/**
 * @neutronai/app — project-scoped tasks API client (P5.4).
 *
 * Thin fetch wrapper for the gateway's
 * `/api/app/projects/<project_id>/tasks[/<task_id>[/<verb>]]` surface.
 * Mirrors the P5.3 `LauncherClient` shape: pass the bearer token at
 * construction time, each call returns the canonical server view
 * (server-authoritative).
 *
 * P5.4 extension: `list()` accepts an optional `order` argument so
 * the typed client exposes the gateway's `?order=focus_score` opt-in
 * (P6 brief § 4.7). The default `'default'` matches the P6.0
 * canonical ordering (open dated → open dateless → done → cancelled);
 * `'focus_score'` switches to focus_score DESC NULLS LAST. The P5.4
 * tasks tab defaults to `'focus_score'` so the P6 substrate's
 * value-add becomes user-visible without a UI gesture (see brief
 * § 4.2 — Atlas locked this call up-front).
 */

export type TaskStatus = 'open' | 'done' | 'cancelled';
export type TaskStatusFilter = TaskStatus | 'all';
export type TaskOrder = 'default' | 'focus_score';

export interface Task {
  id: string;
  project_slug: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number | null;
  due_date: string | null;
  owner_persona: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /**
   * P6 focus-score column. The gateway surface returns this when the
   * P6.0 + P6 follow-up migrations have run; older snapshots may
   * omit the field, so the type is optional. The row component
   * renders a chip only when present + non-null.
   */
  focus_score?: number | null;
}

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  priority?: number | null;
  due_date?: string | null;
  owner_persona?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  priority?: number | null;
  due_date?: string | null;
  owner_persona?: string | null;
  status?: TaskStatus;
}

export interface TasksClientOptions {
  base_url: string;
  token: string;
}

interface ListResponse {
  ok: boolean;
  tasks: Task[];
  project_id: string;
  status: TaskStatusFilter;
}

interface TaskResponse {
  ok: boolean;
  task: Task;
}

interface DeleteResponse {
  ok: boolean;
  deleted_task_id: string;
}

export class TasksClient {
  private readonly base_url: string;
  private readonly token: string;

  constructor(opts: TasksClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  async list(
    project_id: string,
    status: TaskStatusFilter = 'open',
    order: TaskOrder = 'default',
  ): Promise<Task[]> {
    const params = new URLSearchParams({ status });
    if (order !== 'default') {
      params.set('order', order);
    }
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/tasks?${params.toString()}`;
    const res = await this.req<ListResponse>(path);
    return res.tasks;
  }

  async create(project_id: string, input: CreateTaskInput): Promise<Task> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/tasks`;
    const res = await this.req<TaskResponse>(path, { method: 'POST', body: input });
    return res.task;
  }

  async update(project_id: string, task_id: string, input: UpdateTaskInput): Promise<Task> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/tasks/${encodeURIComponent(task_id)}`;
    const res = await this.req<TaskResponse>(path, { method: 'PATCH', body: input });
    return res.task;
  }

  async complete(project_id: string, task_id: string): Promise<Task> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/tasks/${encodeURIComponent(task_id)}/complete`;
    const res = await this.req<TaskResponse>(path, { method: 'POST' });
    return res.task;
  }

  async cancel(project_id: string, task_id: string): Promise<Task> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/tasks/${encodeURIComponent(task_id)}/cancel`;
    const res = await this.req<TaskResponse>(path, { method: 'POST' });
    return res.task;
  }

  async delete(project_id: string, task_id: string): Promise<void> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/tasks/${encodeURIComponent(task_id)}`;
    await this.req<DeleteResponse>(path, { method: 'DELETE' });
  }

  private async req<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await fetch(`${this.base_url}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // fall through to status-coded error below
    }
    if (!res.ok) {
      const code = (json as { code?: string } | null)?.code ?? 'request_failed';
      const message =
        (json as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
      throw new TasksClientError(code, message, res.status);
    }
    return json as T;
  }
}

export class TasksClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`);
    this.name = 'TasksClientError';
    this.code = code;
    this.status = status;
  }
}
