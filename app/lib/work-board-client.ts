/**
 * @neutronai/app — project-scoped WORK BOARD API client (Work Board Phase 1b).
 *
 * The mobile twin of the web `landing/chat-react/work-board-client.ts`. A thin
 * fetch wrapper for the gateway's Work Board surface (Phase 1a,
 * `gateway/http/work-board-surface.ts`):
 *
 *   GET    /api/app/projects/<id>/work-board                     list
 *   POST   /api/app/projects/<id>/work-board                     create
 *   PATCH  /api/app/projects/<id>/work-board/<item_id>           update
 *   POST   /api/app/projects/<id>/work-board/<item_id>/complete  complete
 *   POST   /api/app/projects/<id>/work-board/<item_id>/reorder   reorder
 *   DELETE /api/app/projects/<id>/work-board/<item_id>           delete
 *
 * Mirrors the `TasksClient` shape: pass the bearer at construction, each call
 * returns the canonical server view (server-authoritative). The board comes back
 * active+next first (by `sort_order`) then completed (reverse-chron) — the store
 * is the single source of truth, so the screen NEVER re-sorts. A live
 * `work_board_changed` frame carries the SAME snapshot (minus `project_slug`).
 *
 * `fetchImpl` is injectable for unit tests; it defaults to the global `fetch`.
 */

export type WorkBoardStatus = 'upcoming' | 'in_progress' | 'done' | 'failed';

export interface WorkBoardItem {
  id: string;
  /** Server-only; absent on the live `work_board_changed` frame. */
  project_slug?: string;
  title: string;
  status: WorkBoardStatus;
  sort_order: number;
  design_doc_ref: string | null;
  /** Lightweight in-topic ("inline") work marker. */
  inline_active: boolean;
  /** Bound `code_trident_runs.id` when a sub-agent run works this item. */
  linked_run_id: string | null;
  created_at: string;
  updated_at: string;
  /** ISO-8601 UTC; null until status='done'. */
  completed_at: string | null;
  /**
   * M1 redesign — the bound trident run's LIVE progress, present ONLY when
   * this item has a live `linked_run_id`. Mirror of the web client's
   * `WorkBoardItem.run_progress` (`landing/chat-react/work-board-client.ts`).
   */
  run_progress?: RunProgress;
}

/** Human-legible live phase of a bound run (mirror of `trident/run-progress.ts`). */
export type RunPhaseLabel =
  | 'planning'
  | 'building'
  | 'reviewing'
  | 'merged'
  | 'failed'
  | 'cancelled';

/**
 * M1 UX REDESIGN — the inner-step label the redesigned Work item renders live
 * (mirror of `trident/run-progress.ts` `RunStepLabel`): building → reviewing →
 * fixing → merging → terminal done/failed.
 */
export type RunStepLabel = 'building' | 'reviewing' | 'fixing' | 'merging' | 'done' | 'failed';

/** A bound run's live progress, as the row consumes it. */
export interface RunProgress {
  run_id: string;
  phase_label: RunPhaseLabel;
  /** M1 redesign — the inner-step label (building/reviewing/fixing/merging + terminal). */
  step_label: RunStepLabel;
  round: number;
  started_at: string;
  last_advanced_at: string;
  elapsed_ms: number;
  stalled: boolean;
  stalled_ms: number | null;
  pr: number | null;
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | null;
  failure_reason: string | null;
}

export interface CreateWorkBoardItemInput {
  title: string;
  status?: WorkBoardStatus;
  design_doc_ref?: string | null;
  /** M1 — full context/ask; a substantial spec is persisted to a plans/ doc. */
  spec?: string;
}

export interface UpdateWorkBoardItemInput {
  title?: string;
  status?: WorkBoardStatus;
  design_doc_ref?: string | null;
}

export interface ReorderTarget {
  before?: string;
  after?: string;
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface WorkBoardClientOptions {
  base_url: string;
  token: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: FetchImpl;
}

interface ListResponse {
  ok: boolean;
  items: WorkBoardItem[];
  project_id: string;
}

interface ItemResponse {
  ok: boolean;
  item: WorkBoardItem;
}

export class WorkBoardClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`);
    this.name = 'WorkBoardClientError';
    this.code = code;
    this.status = status;
  }
}

export class WorkBoardClient {
  private readonly base_url: string;
  private readonly token: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: WorkBoardClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** The full board: active+next first (board order), then completed (reverse-chron). */
  async list(project_id: string): Promise<WorkBoardItem[]> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/work-board`;
    const res = await this.req<ListResponse>(path);
    return res.items;
  }

  async create(project_id: string, input: CreateWorkBoardItemInput): Promise<WorkBoardItem> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/work-board`;
    const res = await this.req<ItemResponse>(path, { method: 'POST', body: input });
    return res.item;
  }

  async update(
    project_id: string,
    item_id: string,
    input: UpdateWorkBoardItemInput,
  ): Promise<WorkBoardItem> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/work-board/${encodeURIComponent(item_id)}`;
    const res = await this.req<ItemResponse>(path, { method: 'PATCH', body: input });
    return res.item;
  }

  async complete(project_id: string, item_id: string): Promise<WorkBoardItem> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/work-board/${encodeURIComponent(item_id)}/complete`;
    const res = await this.req<ItemResponse>(path, { method: 'POST' });
    return res.item;
  }

  async reorder(
    project_id: string,
    item_id: string,
    target: ReorderTarget,
  ): Promise<WorkBoardItem[]> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/work-board/${encodeURIComponent(item_id)}/reorder`;
    const res = await this.req<ListResponse>(path, { method: 'POST', body: target });
    return res.items;
  }

  async delete(project_id: string, item_id: string): Promise<void> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/work-board/${encodeURIComponent(item_id)}`;
    await this.req<{ ok: boolean; deleted: string }>(path, { method: 'DELETE' });
  }

  /**
   * ▶ START or RETRY a build bound to this item, using its SAVED spec (its
   * linked design doc, else its title). Throws `WorkBoardClientError` on a
   * non-2xx (e.g. `underspecified`, `already_running`).
   */
  async start(project_id: string, item_id: string): Promise<{ ok: boolean; run_id?: string }> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/work-board/${encodeURIComponent(item_id)}/start`;
    return await this.req<{ ok: boolean; run_id?: string }>(path, { method: 'POST' });
  }

  private async req<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await this.fetchImpl(`${this.base_url}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // fall through to the status-coded error below
    }
    if (!res.ok) {
      const code = (json as { code?: string } | null)?.code ?? 'request_failed';
      const message = (json as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
      throw new WorkBoardClientError(code, message, res.status);
    }
    return json as T;
  }
}

/**
 * Extract the docs-root-relative path a card's `design_doc_ref` points at, or
 * null when the ref isn't an in-app docs link. Mirror of
 * `work-board/spec-doc.ts#docPathFromDesignRef` (the app is dep-isolated from
 * the workspace, same convention as `parseWorkBoardItems`).
 */
export function docPathFromDesignRef(ref: string | null | undefined): string | null {
  if (typeof ref !== 'string') return null;
  const r = ref.trim();
  if (r.length === 0) return null;
  if (r.startsWith('neutron-docs:')) {
    const p = r.slice('neutron-docs:'.length).trim().replace(/^\/+/, '');
    return p.length > 0 ? p : null;
  }
  if (r.startsWith('/api/app/')) {
    const q = r.indexOf('?');
    if (q >= 0) {
      const p = new URLSearchParams(r.slice(q + 1)).get('path');
      if (p !== null && p.trim().length > 0) return p.trim().replace(/^\/+/, '');
    }
    return null;
  }
  return null;
}

/** A short display label for a card's doc link — the basename without `.md`. */
export function docLinkLabel(ref: string | null | undefined): string | null {
  const path = docPathFromDesignRef(ref);
  if (path === null) return null;
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

/**
 * Parse a raw `work_board_changed` frame's `items` array into typed
 * {@link WorkBoardItem}s, dropping malformed entries. Shared by the live
 * subscriber so a garbled frame can't crash the screen.
 */
export function parseWorkBoardItems(raw: unknown): WorkBoardItem[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkBoardItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const id = r['id'];
    const title = r['title'];
    const status = r['status'];
    if (typeof id !== 'string' || id.length === 0) continue;
    if (typeof title !== 'string') continue;
    if (
      status !== 'upcoming' &&
      status !== 'in_progress' &&
      status !== 'done' &&
      status !== 'failed'
    )
      continue;
    const run_progress = parseRunProgress(r['run_progress']);
    out.push({
      id,
      title,
      status,
      sort_order: typeof r['sort_order'] === 'number' ? (r['sort_order'] as number) : 0,
      design_doc_ref:
        typeof r['design_doc_ref'] === 'string' ? (r['design_doc_ref'] as string) : null,
      inline_active: r['inline_active'] === true,
      linked_run_id: typeof r['linked_run_id'] === 'string' ? (r['linked_run_id'] as string) : null,
      created_at: typeof r['created_at'] === 'string' ? (r['created_at'] as string) : '',
      updated_at: typeof r['updated_at'] === 'string' ? (r['updated_at'] as string) : '',
      completed_at: typeof r['completed_at'] === 'string' ? (r['completed_at'] as string) : null,
      ...(run_progress !== null ? { run_progress } : {}),
    });
  }
  return out;
}

const RUN_PHASE_LABELS: readonly RunPhaseLabel[] = [
  'planning',
  'building',
  'reviewing',
  'merged',
  'failed',
  'cancelled',
];

const RUN_STEP_LABELS: readonly RunStepLabel[] = [
  'building',
  'reviewing',
  'fixing',
  'merging',
  'done',
  'failed',
];

/**
 * Derive a fallback `step_label` from a `phase_label` for a legacy/absent wire
 * value — keeps the redesign renderable against an older server that predates
 * the explicit `step_label` field. Mirror of the web client's
 * `stepLabelFromPhase` (`landing/chat-react/work-board-client.ts`).
 */
function stepLabelFromPhase(phase: RunPhaseLabel): RunStepLabel {
  switch (phase) {
    case 'building':
    case 'planning':
      return 'building';
    case 'reviewing':
      return 'reviewing';
    case 'merged':
      return 'done';
    case 'failed':
    case 'cancelled':
      return 'failed';
  }
}

/**
 * The EFFECTIVE inner-step label — `step_label` when the server sent a recognized
 * one, else derived from `phase_label`. The HTTP `list()` path returns raw server
 * rows (NOT run through `parseRunProgress`), so a legacy/rolling-deploy gateway
 * that omits `step_label` would otherwise leave it `undefined` and crash the
 * tag/dot derivation (Codex P2). The row helpers switch on THIS, never
 * `rp.step_label` directly. Mirror of the web client's `resolveStepLabel`.
 */
export function resolveStepLabel(rp: {
  step_label?: unknown;
  phase_label: RunPhaseLabel;
}): RunStepLabel {
  return RUN_STEP_LABELS.includes(rp.step_label as RunStepLabel)
    ? (rp.step_label as RunStepLabel)
    : stepLabelFromPhase(rp.phase_label);
}

/** Parse a raw `run_progress` object off a live frame; null when absent/malformed. */
function parseRunProgress(raw: unknown): RunProgress | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const run_id = r['run_id'];
  const phase_label = r['phase_label'];
  if (typeof run_id !== 'string' || run_id.length === 0) return null;
  if (typeof phase_label !== 'string' || !RUN_PHASE_LABELS.includes(phase_label as RunPhaseLabel)) {
    return null;
  }
  const verdict = r['verdict'];
  const rawStep = r['step_label'];
  const step_label: RunStepLabel = RUN_STEP_LABELS.includes(rawStep as RunStepLabel)
    ? (rawStep as RunStepLabel)
    : stepLabelFromPhase(phase_label as RunPhaseLabel);
  return {
    run_id,
    phase_label: phase_label as RunPhaseLabel,
    step_label,
    round: typeof r['round'] === 'number' ? (r['round'] as number) : 1,
    started_at: typeof r['started_at'] === 'string' ? (r['started_at'] as string) : '',
    last_advanced_at:
      typeof r['last_advanced_at'] === 'string' ? (r['last_advanced_at'] as string) : '',
    elapsed_ms: typeof r['elapsed_ms'] === 'number' ? (r['elapsed_ms'] as number) : 0,
    stalled: r['stalled'] === true,
    stalled_ms: typeof r['stalled_ms'] === 'number' ? (r['stalled_ms'] as number) : null,
    pr: typeof r['pr'] === 'number' ? (r['pr'] as number) : null,
    verdict: verdict === 'APPROVE' || verdict === 'REQUEST_CHANGES' ? verdict : null,
    failure_reason: typeof r['failure_reason'] === 'string' ? (r['failure_reason'] as string) : null,
  };
}
