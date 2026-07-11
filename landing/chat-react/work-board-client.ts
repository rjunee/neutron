/**
 * landing/chat-react — web WORK BOARD API client (Work Board Phase 1b).
 *
 * The web twin of the mobile `app/lib/work-board-client.ts`. A thin fetch
 * wrapper over the gateway's project-scoped Work Board surface
 * (`gateway/http/work-board-surface.ts`, Phase 1a):
 *
 *   GET    /api/app/projects/<id>/work-board                     list
 *   POST   /api/app/projects/<id>/work-board                     create
 *   PATCH  /api/app/projects/<id>/work-board/<item_id>           update
 *   POST   /api/app/projects/<id>/work-board/<item_id>/complete  complete
 *   POST   /api/app/projects/<id>/work-board/<item_id>/reorder   reorder
 *   DELETE /api/app/projects/<id>/work-board/<item_id>           delete
 *
 * ── Board order is the engine's, not the client's ───────────────────────────
 * The list comes back active+next first (by `sort_order`) then the completed
 * history (reverse-chron) — the store is the single source of truth, so the tab
 * NEVER re-sorts. Live `work_board_changed` frames carry the SAME full-snapshot
 * shape (minus the server-only `project_slug`), so the controller's frame parse
 * and this client's `list()` produce the SAME {@link WorkBoardItem} the tab
 * renders, and a live apply is a drop-in replacement for a re-fetch.
 *
 * ── Agent + human parity ────────────────────────────────────────────────────
 * Every action here (add / edit / complete / reorder / delete) hits the SAME
 * canonical `WorkBoardStore` the agent's `work_board_*` tools + the per-turn
 * injection use — one code path, so a human write fires the same
 * `work_board_changed` push the agent's does.
 *
 * Wire shapes mirror the gateway types but are re-declared here (rather than
 * imported across the workspace boundary) so the browser bundle stays free of a
 * gateway dependency — the same convention `tasks-client.ts` / `docs-client.ts`
 * follow. Pure given an injected `fetchImpl`, so it unit-tests without a DOM or
 * a live server.
 */

import {
  GatewayClientError,
  GatewayHttpClient,
  type GatewayHttpClientOptions,
} from '@neutronai/client-core'

/* ─── wire types (mirror work-board/store.ts) ─── */

export type WorkBoardStatus = 'upcoming' | 'in_progress' | 'done' | 'failed'

/**
 * One board item, in the shape the tab renders. `project_slug` is server-only
 * (present on the HTTP GET row, absent on the live `work_board_changed` frame),
 * so it is OPTIONAL here — that lets a parsed live frame item and a fetched row
 * satisfy the SAME type without the tab caring which path produced it.
 */
export interface WorkBoardItem {
  id: string
  project_slug?: string
  title: string
  status: WorkBoardStatus
  sort_order: number
  design_doc_ref: string | null
  /** Lightweight in-topic ("inline") work marker. */
  inline_active: boolean
  /** Bound `code_trident_runs.id` when a sub-agent run works this item. */
  linked_run_id: string | null
  created_at: string
  updated_at: string
  /** ISO-8601 UTC; null until status='done'. */
  completed_at: string | null
  /**
   * Item 1 — the bound trident run's LIVE progress, present ONLY when this item
   * has a live `linked_run_id`. The tab renders it as a compact sub-label; absent
   * on unbound/idle items.
   */
  run_progress?: RunProgress
}

/** Human-legible live phase of a bound run (mirror of `trident/run-progress.ts`). */
export type RunPhaseLabel =
  | 'planning'
  | 'building'
  | 'reviewing'
  | 'merged'
  | 'failed'
  | 'cancelled'

/**
 * M1 UX REDESIGN — the inner-step label the redesigned Work item renders live
 * (mirror of `trident/run-progress.ts` `RunStepLabel`): building → reviewing →
 * fixing → merging → terminal done/failed.
 */
export type RunStepLabel = 'building' | 'reviewing' | 'fixing' | 'merging' | 'done' | 'failed'

/** Item 1 — a bound run's live progress, as the tab consumes it. */
export interface RunProgress {
  run_id: string
  phase_label: RunPhaseLabel
  /** M1 redesign — the inner-step label (building/reviewing/fixing/merging + terminal). */
  step_label: RunStepLabel
  round: number
  started_at: string
  last_advanced_at: string
  elapsed_ms: number
  stalled: boolean
  stalled_ms: number | null
  pr: number | null
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | null
  failure_reason: string | null
}

export interface CreateWorkBoardItemInput {
  title: string
  status?: WorkBoardStatus
  design_doc_ref?: string | null
  /** M1 — full context/ask; a substantial spec is persisted to a plans/ doc. */
  spec?: string
}

/** Result of a ▶ start/retry dispatch. */
export interface StartBuildResult {
  ok: boolean
  run_id?: string
}

export interface UpdateWorkBoardItemInput {
  title?: string
  status?: WorkBoardStatus
  design_doc_ref?: string | null
}

interface ListResponse {
  ok: boolean
  items: WorkBoardItem[]
  project_id: string
}
interface ItemResponse {
  ok: boolean
  item: WorkBoardItem
}
export class WorkBoardClientError extends GatewayClientError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status)
    this.name = 'WorkBoardClientError'
  }
}

/**
 * The reserved General board id. The web shell scopes General as the EMPTY
 * project id ('') everywhere — the rail's General row is `vm.projectId === null`
 * (→ `''`), and the live `work_board_changed` filter keys off
 * `(framePid ?? '') === projectId`, so General MUST stay '' for a no-`project_id`
 * snapshot to be applied (a General frame carries no `project_id`). But the HTTP
 * work-board surface keys General on the literal `'general'` id
 * (`workBoardScopeKey(owner_slug, 'general') → owner_slug`, `store.ts`) and 400s
 * on an empty path segment (`sanitizeProjectId('')` → null → the `//work-board`
 * double-slash the ProjectShell Codex-P2 note calls out as wrong-scope). So we
 * normalize '' → 'general' at the URL boundary ONLY: General's board is reachable
 * over HTTP while every other layer keeps treating it as ''. Named ids pass
 * through untouched.
 */
export const GENERAL_WORK_BOARD_PROJECT_ID = 'general'

/** Map the client-side scope id to its HTTP path segment ('' ⇒ General). */
export function workBoardPathSegment(project_id: string): string {
  return project_id.length === 0 ? GENERAL_WORK_BOARD_PROJECT_ID : project_id
}

export type WorkBoardClientOptions = GatewayHttpClientOptions

export class WebWorkBoardClient extends GatewayHttpClient {
  protected override readonly guardNetworkErrors = true

  protected override makeError(code: string, message: string, status: number): GatewayClientError {
    return new WorkBoardClientError(code, message, status)
  }

  /** The full board: active+next first (board order), then completed (reverse-chron). */
  async list(project_id: string): Promise<WorkBoardItem[]> {
    const path = `/api/app/projects/${encodeURIComponent(workBoardPathSegment(project_id))}/work-board`
    const res = await this.req<ListResponse>(path)
    return res.items
  }

  /** Append a new item at the end of the board (the "add" affordance). */
  async create(project_id: string, input: CreateWorkBoardItemInput): Promise<WorkBoardItem> {
    const path = `/api/app/projects/${encodeURIComponent(workBoardPathSegment(project_id))}/work-board`
    const res = await this.req<ItemResponse>(path, { method: 'POST', body: input })
    return res.item
  }

  /** Patch a board item — used for inline title edits + status changes. */
  async update(
    project_id: string,
    item_id: string,
    input: UpdateWorkBoardItemInput,
  ): Promise<WorkBoardItem> {
    const path = `/api/app/projects/${encodeURIComponent(workBoardPathSegment(project_id))}/work-board/${encodeURIComponent(item_id)}`
    const res = await this.req<ItemResponse>(path, { method: 'PATCH', body: input })
    return res.item
  }

  /** Mark an item done (stamps `completed_at`, moves it to the completed history). */
  async complete(project_id: string, item_id: string): Promise<WorkBoardItem> {
    const path = `/api/app/projects/${encodeURIComponent(workBoardPathSegment(project_id))}/work-board/${encodeURIComponent(item_id)}/complete`
    const res = await this.req<ItemResponse>(path, { method: 'POST' })
    return res.item
  }

  /** Move an active item before/after a sibling; returns the renumbered board. */
  async reorder(
    project_id: string,
    item_id: string,
    target: { before?: string; after?: string },
  ): Promise<WorkBoardItem[]> {
    const path = `/api/app/projects/${encodeURIComponent(workBoardPathSegment(project_id))}/work-board/${encodeURIComponent(item_id)}/reorder`
    const res = await this.req<ListResponse>(path, { method: 'POST', body: target })
    return res.items
  }

  /**
   * ▶ START or RETRY a build bound to this item, using its SAVED spec (its
   * linked design doc, else its title) as the task. The card flips to a live
   * build (in_progress + fork ⑂) via the same dispatch chokepoint the agent
   * uses. Throws `WorkBoardClientError` (e.g. `underspecified`, `already_running`,
   * `build_dispatch_unavailable`) on a non-2xx so the tab can surface it.
   */
  async start(project_id: string, item_id: string): Promise<StartBuildResult> {
    const path = `/api/app/projects/${encodeURIComponent(workBoardPathSegment(project_id))}/work-board/${encodeURIComponent(item_id)}/start`
    const res = await this.req<{ ok: boolean; run_id?: string }>(path, { method: 'POST' })
    return { ok: res.ok === true, ...(typeof res.run_id === 'string' ? { run_id: res.run_id } : {}) }
  }

  /** Delete an item (the human board is full-CRUD for the owner). */
  async delete(project_id: string, item_id: string): Promise<void> {
    const path = `/api/app/projects/${encodeURIComponent(workBoardPathSegment(project_id))}/work-board/${encodeURIComponent(item_id)}`
    await this.req<{ ok: boolean; deleted: string }>(path, { method: 'DELETE' })
  }
}

/**
 * Extract the docs-root-relative path a card's `design_doc_ref` points at, or
 * null when the ref isn't an in-app docs link (external https URL / absent). A
 * browser-side mirror of `work-board/spec-doc.ts#docPathFromDesignRef` (the app
 * bundle can't import across the workspace boundary). Both accepted in-app forms
 * map to a docs-relative path the Documents tab can open:
 *   - `neutron-docs:plans/foo.md`                          → `plans/foo.md`
 *   - `/api/app/projects/<id>/docs/file?path=plans/foo.md` → `plans/foo.md`
 */
export function docPathFromDesignRef(ref: string | null | undefined): string | null {
  if (typeof ref !== 'string') return null
  const r = ref.trim()
  if (r.length === 0) return null
  if (r.startsWith('neutron-docs:')) {
    const p = r.slice('neutron-docs:'.length).trim().replace(/^\/+/, '')
    return p.length > 0 ? p : null
  }
  if (r.startsWith('/api/app/')) {
    const q = r.indexOf('?')
    if (q >= 0) {
      const p = new URLSearchParams(r.slice(q + 1)).get('path')
      if (p !== null && p.trim().length > 0) return p.trim().replace(/^\/+/, '')
    }
    return null
  }
  return null
}

/** A short display label for a card's doc link — the basename without `.md`. */
export function docLinkLabel(ref: string | null | undefined): string | null {
  const path = docPathFromDesignRef(ref)
  if (path === null) return null
  const base = path.split('/').pop() ?? path
  return base.replace(/\.md$/i, '')
}

/**
 * Parse a raw `work_board_changed` frame's `items` array into typed
 * {@link WorkBoardItem}s, dropping any malformed entry. Shared by the
 * controller's live-frame apply path so a hostile/garbled frame can't crash the
 * tab. Field-for-field the same shape the HTTP GET returns (minus the
 * server-only `project_slug`), so a live apply is interchangeable with a
 * re-fetch.
 */
export function parseWorkBoardItems(raw: unknown): WorkBoardItem[] {
  if (!Array.isArray(raw)) return []
  const out: WorkBoardItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const r = entry as Record<string, unknown>
    const id = r['id']
    const title = r['title']
    const status = r['status']
    if (typeof id !== 'string' || id.length === 0) continue
    if (typeof title !== 'string') continue
    if (
      status !== 'upcoming' &&
      status !== 'in_progress' &&
      status !== 'done' &&
      status !== 'failed'
    )
      continue
    const run_progress = parseRunProgress(r['run_progress'])
    out.push({
      id,
      title,
      status,
      sort_order: typeof r['sort_order'] === 'number' ? (r['sort_order'] as number) : 0,
      design_doc_ref: typeof r['design_doc_ref'] === 'string' ? (r['design_doc_ref'] as string) : null,
      inline_active: r['inline_active'] === true,
      linked_run_id: typeof r['linked_run_id'] === 'string' ? (r['linked_run_id'] as string) : null,
      created_at: typeof r['created_at'] === 'string' ? (r['created_at'] as string) : '',
      updated_at: typeof r['updated_at'] === 'string' ? (r['updated_at'] as string) : '',
      completed_at: typeof r['completed_at'] === 'string' ? (r['completed_at'] as string) : null,
      ...(run_progress !== null ? { run_progress } : {}),
    })
  }
  return out
}

const RUN_PHASE_LABELS: readonly RunPhaseLabel[] = [
  'planning',
  'building',
  'reviewing',
  'merged',
  'failed',
  'cancelled',
]

const RUN_STEP_LABELS: readonly RunStepLabel[] = [
  'building',
  'reviewing',
  'fixing',
  'merging',
  'done',
  'failed',
]

/**
 * Derive a fallback `step_label` from a `phase_label` for a legacy/absent wire
 * value — keeps the redesign renderable against an older server that predates the
 * explicit `step_label` field. Coarse (no fixing/merging distinction), which is
 * exactly the pre-redesign granularity.
 */
function stepLabelFromPhase(phase: RunPhaseLabel): RunStepLabel {
  switch (phase) {
    case 'building':
    case 'planning':
      return 'building'
    case 'reviewing':
      return 'reviewing'
    case 'merged':
      return 'done'
    case 'failed':
    case 'cancelled':
      return 'failed'
  }
}

/**
 * The EFFECTIVE inner-step label for a run — `step_label` when the server sent a
 * recognized one, else derived from `phase_label`. The HTTP `list()` path returns
 * raw server rows (NOT run through `parseRunProgress`), so a legacy/rolling-deploy
 * gateway that omits `step_label` would otherwise leave it `undefined` and crash
 * the tag/dot derivation (Codex P2). Callers switch on THIS, never `rp.step_label`
 * directly, so both the HTTP and live-frame paths render safely.
 */
export function resolveStepLabel(rp: {
  step_label?: unknown
  phase_label: RunPhaseLabel
}): RunStepLabel {
  return RUN_STEP_LABELS.includes(rp.step_label as RunStepLabel)
    ? (rp.step_label as RunStepLabel)
    : stepLabelFromPhase(rp.phase_label)
}

/** Parse a raw `run_progress` object (item 1) off a live frame; null when absent/malformed. */
function parseRunProgress(raw: unknown): RunProgress | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const run_id = r['run_id']
  const phase_label = r['phase_label']
  if (typeof run_id !== 'string' || run_id.length === 0) return null
  if (typeof phase_label !== 'string' || !RUN_PHASE_LABELS.includes(phase_label as RunPhaseLabel)) {
    return null
  }
  const verdict = r['verdict']
  const rawStep = r['step_label']
  const step_label: RunStepLabel = RUN_STEP_LABELS.includes(rawStep as RunStepLabel)
    ? (rawStep as RunStepLabel)
    : stepLabelFromPhase(phase_label as RunPhaseLabel)
  return {
    run_id,
    phase_label: phase_label as RunPhaseLabel,
    step_label,
    round: typeof r['round'] === 'number' ? (r['round'] as number) : 1,
    started_at: typeof r['started_at'] === 'string' ? (r['started_at'] as string) : '',
    last_advanced_at: typeof r['last_advanced_at'] === 'string' ? (r['last_advanced_at'] as string) : '',
    elapsed_ms: typeof r['elapsed_ms'] === 'number' ? (r['elapsed_ms'] as number) : 0,
    stalled: r['stalled'] === true,
    stalled_ms: typeof r['stalled_ms'] === 'number' ? (r['stalled_ms'] as number) : null,
    pr: typeof r['pr'] === 'number' ? (r['pr'] as number) : null,
    verdict: verdict === 'APPROVE' || verdict === 'REQUEST_CHANGES' ? verdict : null,
    failure_reason: typeof r['failure_reason'] === 'string' ? (r['failure_reason'] as string) : null,
  }
}
