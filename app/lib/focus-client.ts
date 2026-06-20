/**
 * @neutronai/app — global Focus API client (P5.5 surface + P5.6 client
 * production refactor).
 *
 * Thin fetch wrapper for the gateway's `GET /api/app/focus` surface —
 * the cross-project today/most-important projection over the owner's
 * tasks + reminders. Read-only. Same auth shape as the launcher
 * client: bearer token at construction time, list returned verbatim
 * from the server.
 *
 * The shape must stay in sync with
 * `gateway/http/app-focus-surface.ts:FocusItem`.
 *
 * P5.6 extends the client by exactly one optional argument
 * (`list({order})`) so the gateway's `?order=focus_score` opt-in flows
 * through the typed client + by one field on `FocusItem`
 * (`focus_score: number | null` — the gateway already returns this
 * per `app-focus-surface.ts:125`; the client type was missing it).
 * The Focus state-provider locks the DEFAULT to `'default'` per brief
 * § 4.3 — Focus's value-add lens is the BUCKET (cross-project
 * urgency), not the focus_score (which is the Tasks tab's value-add
 * per P5.4 § 4.2).
 */

export type FocusItemKind = 'task' | 'reminder';
export type FocusBucket = 'overdue' | 'today' | 'soon';

/**
 * Sort opt-ins exposed by the gateway's `?order=...` query param. The
 * union must stay in sync with the gateway's `ALL_TASK_ORDERS` since
 * the focus surface delegates parsing to the same allow-list.
 */
export type FocusOrder = 'default' | 'focus_score';

export interface FocusItem {
  kind: FocusItemKind;
  id: string;
  project_id: string;
  title: string;
  /** ISO-8601 UTC, or null when the item surfaced without a due time. */
  due_at: string | null;
  priority: number | null;
  bucket: FocusBucket;
  source: 'tasks' | 'reminders';
  origin_source: string | null;
  /** P6 — focus score for task rows. Null for reminders and unscored tasks. */
  focus_score: number | null;
}

export interface FocusResponse {
  ok: true;
  project_slug: string;
  now: string;
  today: FocusItem[];
}

export interface FocusClientOptions {
  base_url: string;
  token: string;
}

export interface FocusListOptions {
  /**
   * Sort opt-in. `'default'` (the brief-locked Focus value) uses the
   * server's deterministic `bucket → priority DESC → due_at ASC`
   * comparator; `'focus_score'` flips the within-bucket sort to
   * `focus_score DESC NULLS LAST` (plumbed for a future per-user
   * preference, off by default at P5.6).
   */
  order?: FocusOrder;
}

/**
 * P6.1 — Current-focus-pick payload from `GET /api/app/focus/current`.
 * Mirrors `gateway/http/app-focus-current-surface.ts:CurrentFocusPickPayload`.
 */
export interface CurrentFocusTask {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: 'open' | 'done' | 'cancelled';
  priority: number | null;
  due_date: string | null;
  focus_score: number | null;
}

export interface CurrentFocusPick {
  day: string;
  task_id: string;
  task: CurrentFocusTask;
  llm_rationale: string;
  created_at: string;
  llm_model: string;
}

export interface CurrentFocusResponse {
  ok: true;
  project_slug: string;
  now: string;
  pick: CurrentFocusPick;
}

export class FocusClient {
  private readonly base_url: string;
  private readonly token: string;

  constructor(opts: FocusClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  async list(opts: FocusListOptions = {}): Promise<FocusResponse> {
    // Only emit `?order=...` for the non-default opt-in so a `'default'`
    // call hits the same URL the MVP's argument-less call did. Keeps
    // the network log + gateway log stable across the P5.5 → P5.6
    // client refactor.
    const path =
      opts.order === undefined || opts.order === 'default'
        ? '/api/app/focus'
        : `/api/app/focus?order=${encodeURIComponent(opts.order)}`;
    const res = await fetch(`${this.base_url}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.token}` },
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // fall through to status-coded error
    }
    if (!res.ok) {
      const code = (json as { code?: string } | null)?.code ?? 'request_failed';
      const message =
        (json as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
      throw new FocusClientError(code, message, res.status);
    }
    // Server is the type authority, but a 200 with malformed JSON
    // (proxy / version mismatch / build skew) would otherwise cast
    // silently and crash deeper in the UI. Validate the shape at the
    // boundary.
    if (
      json === null ||
      typeof json !== 'object' ||
      !Array.isArray((json as { today?: unknown }).today)
    ) {
      throw new FocusClientError(
        'invalid_response',
        'focus endpoint returned an unexpected payload shape',
        res.status,
      );
    }
    return json as FocusResponse;
  }

  /**
   * P6.1 — fetch today's "do this next" LLM pick for the owner.
   * Returns `null` when the gateway responds 404 (no pick today —
   * cron hasn't run, no creds, or no open tasks). Any other failure
   * throws `FocusClientError`.
   *
   * The surface is at `GET /api/app/focus/current` (instance-scoped,
   * NOT per-project — the nudge engine writes one pick per instance
   * per day).
   */
  async getCurrentFocus(): Promise<CurrentFocusPick | null> {
    const res = await fetch(`${this.base_url}/api/app/focus/current`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (res.status === 404) {
      // No pick today — caller treats as "no hero card visible."
      // Drain the body so the connection can be reused.
      try {
        await res.text();
      } catch {
        /* ignore */
      }
      return null;
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* fall through to status-coded error */
    }
    if (!res.ok) {
      const code = (json as { code?: string } | null)?.code ?? 'request_failed';
      const message =
        (json as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
      throw new FocusClientError(code, message, res.status);
    }
    if (
      json === null ||
      typeof json !== 'object' ||
      typeof (json as { pick?: unknown }).pick !== 'object' ||
      (json as { pick?: unknown }).pick === null
    ) {
      throw new FocusClientError(
        'invalid_response',
        'focus/current endpoint returned an unexpected payload shape',
        res.status,
      );
    }
    return (json as CurrentFocusResponse).pick;
  }
}

export class FocusClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`);
    this.name = 'FocusClientError';
    this.code = code;
    this.status = status;
  }
}
