/**
 * @neutronai/app — project-reminders API client (P5.4).
 *
 * Thin fetch wrapper for the gateway's
 * `/api/app/projects/<project_id>/reminders[*]` surface. Mirrors the
 * P5.3 `LauncherClient` shape: pass the bearer token at construction
 * time; each call returns the post-mutation reminder list (server is
 * authoritative — no optimistic UI without echo).
 */

export interface ReminderItem {
  id: string;
  message: string;
  /** Unix seconds (UTC). */
  fire_at: number;
  status: 'pending' | 'fired' | 'cancelled';
  recurrence: 'weekly' | 'monthly' | 'occasional' | null;
  created_at: number;
  /**
   * Origin tag — `null` for organic engine rows, `'app:reminders-tab'`
   * for user-driven creates from this tab, `'@neutronai/tasks'` for
   * P6 task-auto-link rows, `'@neutronai/reminders-core'` for Core
   * writes, agent-prefixed strings for agent writes. The
   * `<ReminderRow>` source chip surfaces the non-self tags.
   */
  source?: string | null;
}

/** Convert-to-task response envelope (P5.5). */
export interface ReminderConvertToTaskResult {
  /** Post-mutation pending list (the original is gone; a fresh task-linked reminder usually appears). */
  reminders: ReminderItem[];
  /** Canonical task id created by the conversion. */
  task_id: string;
  /** Auto-created linked reminder id (via `task_reminder_links`), or null if the migration hasn't run. */
  linked_reminder_id: string | null;
  /** Original reminder id that was cancelled by the conversion. */
  cancelled_reminder_id: string;
}

export interface RemindersClientOptions {
  base_url: string;
  token: string;
}

interface ListResponse {
  ok: boolean;
  reminders: ReminderItem[];
  project_id: string;
  project_slug?: string;
}

export class RemindersClient {
  private readonly base_url: string;
  private readonly token: string;

  constructor(opts: RemindersClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  /**
   * ISSUE #38 — `include_id` widens the response to include one specific
   * reminder even when its status is no longer `pending`. The tick loop
   * calls `markFired` BEFORE the push dispatcher fans out, so the row
   * is `status='fired'` by the time a user taps the reminder push.
   * Passing the deep-link `reminder_id` here keeps the row in the list
   * so the route's highlight + scroll effect can locate it.
   */
  async list(
    project_id: string,
    opts?: { include_id?: string | null },
  ): Promise<ReminderItem[]> {
    const include_id =
      typeof opts?.include_id === 'string' && opts.include_id.length > 0
        ? opts.include_id
        : null;
    const path =
      `/api/app/projects/${encodeURIComponent(project_id)}/reminders?status=pending` +
      (include_id !== null ? `&include_id=${encodeURIComponent(include_id)}` : '');
    const res = await this.req(path);
    return res.reminders;
  }

  async create(
    project_id: string,
    message: string,
    fire_at: number,
  ): Promise<ReminderItem[]> {
    const res = await this.req(
      `/api/app/projects/${encodeURIComponent(project_id)}/reminders`,
      { method: 'POST', body: { message, fire_at } },
    );
    return res.reminders;
  }

  async snooze(
    project_id: string,
    reminder_id: string,
    new_fire_at: number,
  ): Promise<ReminderItem[]> {
    const res = await this.req(
      `/api/app/projects/${encodeURIComponent(project_id)}/reminders/${encodeURIComponent(reminder_id)}/snooze`,
      { method: 'POST', body: { new_fire_at } },
    );
    return res.reminders;
  }

  async cancel(project_id: string, reminder_id: string): Promise<ReminderItem[]> {
    const res = await this.req(
      `/api/app/projects/${encodeURIComponent(project_id)}/reminders/${encodeURIComponent(reminder_id)}/cancel`,
      { method: 'POST' },
    );
    return res.reminders;
  }

  /**
   * P5.5 — convert a pending reminder into a canonical task. Surfaces
   * the P6 `reminders_convert_to_task` Core tool over HTTP. On success
   * the original reminder is cancelled, a new task is created via
   * `TaskStore.create({due_date: ISO(fire_at), ...})`, and the task's
   * auto-created linked reminder (via `task_reminder_links`) appears
   * in the post-mutation pending list.
   */
  async convertToTask(
    project_id: string,
    reminder_id: string,
    opts?: { title?: string; priority?: number },
  ): Promise<ReminderConvertToTaskResult> {
    const res = await this.req(
      `/api/app/projects/${encodeURIComponent(project_id)}/reminders/${encodeURIComponent(reminder_id)}/convert-to-task`,
      { method: 'POST', body: opts ?? {} },
    );
    const payload = res as ListResponse & {
      task_id?: string;
      linked_reminder_id?: string | null;
      cancelled_reminder_id?: string;
    };
    return {
      reminders: payload.reminders,
      task_id: typeof payload.task_id === 'string' ? payload.task_id : '',
      linked_reminder_id:
        typeof payload.linked_reminder_id === 'string' ? payload.linked_reminder_id : null,
      cancelled_reminder_id:
        typeof payload.cancelled_reminder_id === 'string'
          ? payload.cancelled_reminder_id
          : reminder_id,
    };
  }

  private async req(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<ListResponse> {
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
      throw new RemindersClientError(code, message, res.status);
    }
    return json as ListResponse;
  }
}

export class RemindersClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`);
    this.name = 'RemindersClientError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Format a unix-second fire_at into a human-readable label relative to
 * `now`. Examples:
 *   - "in 2m" / "in 3h" / "in 2d"
 *   - "tomorrow 9:00 AM"
 *   - "Mar 15, 9:00 AM" (anything > 6 days out, or fully past midnight today)
 *   - "fired 5m ago" / "fired Mar 14" (negative deltas)
 *
 * Locale-aware via `Intl.DateTimeFormat`; no external dependency.
 */
export function formatFireAt(fire_at_seconds: number, now_ms: number = Date.now()): string {
  const fire_ms = fire_at_seconds * 1000;
  const delta_ms = fire_ms - now_ms;
  const past = delta_ms < 0;
  const abs_ms = Math.abs(delta_ms);

  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  if (abs_ms < MIN) {
    return past ? 'just now' : 'in <1m';
  }
  if (abs_ms < HOUR) {
    const m = Math.round(abs_ms / MIN);
    return past ? `${m}m ago` : `in ${m}m`;
  }
  if (abs_ms < DAY) {
    const h = Math.round(abs_ms / HOUR);
    return past ? `${h}h ago` : `in ${h}h`;
  }
  if (abs_ms < 2 * DAY) {
    const time = new Date(fire_ms).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    return past ? `yesterday ${time}` : `tomorrow ${time}`;
  }
  if (!past && abs_ms < 7 * DAY) {
    const d = Math.round(abs_ms / DAY);
    return `in ${d}d`;
  }
  const date = new Date(fire_ms);
  const datePart = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return past ? `${datePart}` : `${datePart}, ${timePart}`;
}
