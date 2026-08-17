/**
 * @neutronai/gateway/http — Expo-app project Work Board surface (Phase 1a).
 *
 * The HUMAN read+WRITE path on the Work Board. Owns:
 *
 *   - `GET    /api/app/projects/<project_id>/work-board`                 list
 *   - `POST   /api/app/projects/<project_id>/work-board`                 create
 *     (a create that omits `task_type` is auto-classified build|research from
 *      the title — #429 task 3; an explicit task_type always wins)
 *   - `PATCH  /api/app/projects/<project_id>/work-board/<item_id>`       update
 *   - `POST   /api/app/projects/<project_id>/work-board/<item_id>/complete`
 *   - `POST   /api/app/projects/<project_id>/work-board/<item_id>/reorder`
 *   - `DELETE /api/app/projects/<project_id>/work-board/<item_id>`
 *     (`?reason=shipped|cancelled|moved`, default `cancelled` — the X's existing
 *      semantics; `?plan_doc=delete` to deliberately destroy the card's spec doc,
 *      which no other path ever does. Routed through the shared
 *      `WorkBoardRemovalService` chokepoint the agent removal tool also rides.)
 *
 * All routes are bearer-authed via the shared `AppWsAuthResolver` (same
 * dev-bypass + HS256 paths as the tabs/tasks/chat surfaces). It dispatches the
 * SAME `WorkBoardStore` the agent tools + the per-turn injection use — one code
 * path, so a write here fires the same `work_board_changed` push.
 *
 * Scope: the board is PER-PROJECT. The storage key is
 * `workBoardScopeKey(resolved.project_slug, <project_id>)` — the bearer-derived
 * owner slug bounds the scope (single-owner box), and the VALIDATED URL
 * `<project_id>` selects the project within it (General → the bare owner slug,
 * which also carries all pre-scoping legacy rows). So project A and project B
 * read/write DIFFERENT boards. `store.get(scope, id)` returning null is reported
 * as 404, so a caller can't read or probe an item from another project's scope.
 *
 * `design_doc_ref` schemes are allow-listed at the store (https + in-app docs
 * link only); a rejected scheme surfaces here as a 400, not a 500.
 */

import { sanitizeProjectId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { jsonError, jsonOk, readJsonBody, resolveBearer } from './surface-kit.ts'
import {
  WorkBoardValidationError,
  workBoardScopeKey,
  type WorkBoardItem,
  type WorkBoardStatus,
  type WorkBoardStore,
  type WorkBoardTaskType, WorkBoardRunStillLiveError } from '@neutronai/work-board/store.ts'
import {
  WorkBoardRemovalService,
  WORK_BOARD_REMOVAL_REASONS,
  type WorkBoardRemovalReason,
} from '@neutronai/work-board/removal.ts'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import { runProgressForItem } from '@neutronai/trident/run-progress.ts'
import type { TridentPhase, TridentRun } from '@neutronai/trident/store.ts'

/**
 * The minimal trident-run surface the board needs (M1 trident-UX hardening):
 * READ a linked run to derive its live progress for the GET payload (item 1),
 * and CANCEL a linked run when its Plan item is deleted (item 3). `TridentRunStore`
 * satisfies it structurally (`get` / `update`). Optional — a board-less / trident-
 * less boot omits it and both features degrade to no-ops.
 */
export interface TridentRunAccess {
  get(id: string): TridentRun | null
  update(id: string, patch: { phase: TridentPhase }): Promise<unknown>
  /**
   * §F6a — the terminal-write CHOKEPOINT. Deleting a board card bound to a LIVE
   * build cancels the run: this writes the terminal phase AND runs the terminal-
   * observer chain (delivery + board reconcile) — the SAME chain the tick loop
   * fires for a loop-reaped run. When absent (board-less / observer-less boots,
   * unit tests), the delete path falls back to a bare `update`, which flips the
   * phase but runs no observers (the pre-F6a behaviour).
   *
   * Returns `{ won }` — whether the ATOMIC terminal transition actually landed.
   * A lost race (`won:false`, the run went terminal out-of-band first) cancelled
   * nothing, so the delete surface must NOT report a `cancelled_run` (Codex r3).
   */
  terminate?(id: string, phase: TridentPhase, reason?: string): Promise<{ won: boolean }>
}

/**
 * Result of a ▶ start/retry dispatch. Decoupled from `trident/board-dispatch`
 * so the surface never imports the dispatch internals — the composer maps its
 * `BoardBoundBuildResult` onto this shape.
 */
export type WorkBoardStartResult =
  | { ok: true; run_id: string }
  | {
      ok: false
      code: 'missing_board_item' | 'unknown_board_item' | 'underspecified' | 'backend_error'
      message: string
    }

/**
 * Create a card, persisting a non-trivial `spec` to a plans/ doc and linking the
 * card to it (M1 on-disk spec). The composer wires this to
 * `WorkBoardSpecDocService.createCardWithOptionalSpec`; when absent the surface
 * falls back to a plain `store.create` (a supplied `spec` is then ignored).
 */
export type WorkBoardCreateCardFn = (
  /** The BOARD scope key (General collapses to the owner slug). */
  scope: string,
  /** The PROJECT id the spec doc belongs to — `general` for General. */
  docs_project_id: string,
  input: {
    title: string
    status?: WorkBoardStatus
    task_type?: WorkBoardTaskType
    design_doc_ref?: string | null
    spec?: string
  },
) => Promise<WorkBoardItem>

/**
 * ▶ start/retry a build bound to `item`, using the item's SAVED spec (its
 * design_doc_ref doc, else its title) as the task. The composer wires this to
 * the `dispatchBoardBoundBuild` chokepoint (required-item + ask-before-acting
 * gate + attachRun binding). When absent, the start route returns 501.
 */
export type WorkBoardStartBuildFn = (
  project_slug: string,
  item: WorkBoardItem,
) => Promise<WorkBoardStartResult>

/**
 * #379 — ▶ start/retry a RESEARCH card bound to `item`. The composer wires this
 * to the general agent-dispatch service (Atlas), which delivers the result back
 * to the chat and marks the card terminal on completion. When absent (LLM-less
 * box), a research ▶ returns 501, exactly as `start_build` does for a build card.
 */
export type WorkBoardStartResearchFn = (
  project_slug: string,
  item: WorkBoardItem,
) => Promise<WorkBoardStartResult>

export interface WorkBoardSurfaceOptions {
  store: WorkBoardStore
  auth: AppWsAuthResolver
  /** Trident run access for live progress (item 1) + delete-cancels-run (item 3). */
  trident_runs?: TridentRunAccess
  /** Injectable clock (ms) for the run-progress derivation; defaults to wall-clock. */
  now?: () => number
  /** M1 on-disk spec — persist a non-trivial create `spec` to a plans/ doc. */
  create_card?: WorkBoardCreateCardFn
  /** M1 ▶ play button — start/retry a BUILD ('build' task_type) from the card's saved spec. */
  start_build?: WorkBoardStartBuildFn
  /** #379 ▶ play button — start/retry a RESEARCH ('research' task_type) Atlas dispatch. */
  start_research?: WorkBoardStartResearchFn
  /** #379 — cancel a NON-trident (agent-dispatch) run bound to a card being
   *  deleted, so a research subprocess is not orphaned. Best-effort; a no-op for
   *  an unknown run id. Wired to `DispatchService.stop`. */
  cancel_dispatch?: (run_id: string) => Promise<void>
  /** #429 task 3 — auto-classify build|research from the title when a create
   *  omits task_type. Absent → store default ('build'), the pre-existing
   *  behavior. Total (never rejects); an explicit task_type always short-circuits
   *  it. */
  classify_task_type?: (title: string) => Promise<WorkBoardTaskType>
  /**
   * DERIVED inline activity. With this wired, the wire field `inline_active` on
   * every item-bearing response is EVIDENCE-DERIVED truth; the stored column is
   * only a hint (where they disagree, the evidence wins — a crashed session's
   * stuck flag reads not-active, and a live inline edit reads active with no
   * `work_board_update` anywhere in the path).
   *
   * BATCH shape on purpose (acceptance e): the composer does ONE O(1) evidence
   * read per RESPONSE, never one per row. Absent ⇒ raw stored-flag passthrough —
   * degraded, not broken. Display-only: it never gates, denies or delays a route,
   * and it never writes to the store.
   */
  derive_inline_active?: (items: WorkBoardItem[], project_id: string) => WorkBoardItem[]
  /**
   * The shared card-removal CHOKEPOINT (cancel a live bound run → dispose the
   * plan doc by reason → hard-delete the row). The composer builds ONE and hands
   * it to both this surface and the agent tool, so the UI's X and an agent
   * removal run the SAME path. Absent → the surface builds its own from the deps
   * it already has (board-less boots + unit tests); either way there is exactly
   * ONE implementation of the logic — the class.
   */
  removal?: WorkBoardRemovalService
}

export interface WorkBoardSurface {
  /**
   * HTTP route dispatcher. Returns the `Response` for an owned route, or
   * `null` so `compose.ts` falls through to the downstream chain.
   */
  handler: (req: Request) => Promise<Response | null>
}

const PATH_PREFIX = '/api/app/projects/'
const WORK_BOARD_PATH_RE =
  /^\/api\/app\/projects\/([^/]+)\/work-board(?:\/([^/]+))?(?:\/([a-z]+))?$/

const MAX_ITEM_ID_LEN = 128
// 'archived' (SHELVED) is client-writable — it is the deprioritise lane, and the
// whole point is that taking a card off the board no longer requires claiming it
// shipped. 'failed' stays OUT: it is run-driven, written only by the terminal
// reconcile, so a client PATCH of it is still a 400.
const VALID_STATUSES: WorkBoardStatus[] = ['upcoming', 'in_progress', 'done', 'archived']
const VALID_TASK_TYPES: WorkBoardTaskType[] = ['build', 'research']

export function createWorkBoardSurface(opts: WorkBoardSurfaceOptions): WorkBoardSurface {
  const { store, auth, trident_runs } = opts
  const nowMs = opts.now ?? (() => Date.now())
  const createCard = opts.create_card
  const startBuild = opts.start_build
  const startResearch = opts.start_research
  const cancelDispatch = opts.cancel_dispatch
  const classifyTaskType = opts.classify_task_type
  const deriveInline = opts.derive_inline_active
  // The removal chokepoint. An internal default keeps board-less boots and the
  // surface's own unit tests working WITHOUT a second copy of the logic — it is
  // the same class the composer builds, minus the docs store (so a doc is only
  // ever left in place here).
  const removal =
    opts.removal ??
    new WorkBoardRemovalService({
      store,
      ...(trident_runs !== undefined ? { trident_runs } : {}),
      is_terminal_phase: (phase: string) => isTerminalPhase(phase as TridentPhase),
      ...(cancelDispatch !== undefined ? { cancel_dispatch: cancelDispatch } : {}),
    })

  /**
   * Attach each bound item's live run progress (item 1) so the HTTP GET carries
   * the same phase/round/elapsed/stalled state the `work_board_changed` push
   * ships. A no-op passthrough when no trident-run access is wired.
   */
  const withRunProgress = (items: WorkBoardItem[]): unknown[] => {
    if (trident_runs === undefined) return items
    const when = nowMs()
    const lookup = (id: string): TridentRun | null => trident_runs.get(id)
    return items.map((it) => {
      const progress = runProgressForItem(it, lookup, when)
      return progress === null ? it : { ...it, run_progress: progress }
    })
  }

  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!pathname.startsWith(PATH_PREFIX)) return null
      const match = WORK_BOARD_PATH_RE.exec(pathname)
      if (match === null) return null
      const raw_project_id = match[1] ?? ''
      const raw_item_id = match[2] ?? ''
      const action = match[3] ?? ''
      const project_id = sanitizeProjectId(raw_project_id)
      if (project_id === null) {
        return jsonError(
          400,
          'invalid_project_id',
          'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
        )
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonError(401, resolved.code, resolved.message)
      }
      // Per-project storage key: the bearer-derived owner slug bounds the scope
      // (single-owner box) and the validated URL `project_id` selects the project
      // within it (General → the bare owner slug). Threaded to EVERY store call
      // so project A and project B are distinct boards; the URL `project_id` is
      // echoed back to the client verbatim.
      const scope = workBoardScopeKey(resolved.project_slug, project_id)
      // Derived inline activity: the wire `inline_active` on every item-bearing
      // response below is the EVIDENCE-derived value, not the stored hint. One
      // batch call per response (one O(1) evidence read, never per row); an
      // unwired dep is an identity passthrough of the raw flag.
      const derive = (items: WorkBoardItem[]): WorkBoardItem[] =>
        deriveInline !== undefined ? deriveInline(items, project_id) : items
      // Nullable because `store.update`/`store.complete` echo `null` for a row
      // that vanished mid-write; a null echo stays null (no shape change).
      const deriveOne = (item: WorkBoardItem | null): WorkBoardItem | null =>
        item === null ? null : (derive([item])[0] ?? item)
      const method = req.method

      // Bare collection path: `/work-board`.
      if (raw_item_id === '') {
        if (method === 'GET') {
          // Derive FIRST, then attach run progress — `run_progress` rides on the
          // already-derived rows.
          return jsonOk({ items: withRunProgress(derive(store.list(scope))), project_id })
        }
        if (method === 'POST') {
          return handleCreate(req, store, scope, project_id, createCard, classifyTaskType, deriveOne)
        }
        return jsonError(405, 'method_not_allowed', `method '${method}' not allowed on /work-board`)
      }

      // item_id-scoped routes: `/work-board/<id>[/<verb>]`.
      const item_id = sanitizeItemId(raw_item_id)
      if (item_id === null) {
        return jsonError(400, 'invalid_item_id', 'item_id must be 1-128 chars from [A-Za-z0-9_.-]')
      }

      if (action === '') {
        if (method === 'PATCH') {
          return handleUpdate(req, store, scope, project_id, item_id, deriveOne)
        }
        if (method === 'DELETE') {
          return handleDelete(store, removal, scope, project_id, item_id, url.searchParams)
        }
        return jsonError(
          405,
          'method_not_allowed',
          `method '${method}' not allowed on /work-board/<id>`,
        )
      }
      if (action === 'start' && method === 'POST') {
        return handleStart(store, scope, project_id, item_id, trident_runs, startBuild, startResearch)
      }
      if (action === 'complete' && method === 'POST') {
        return handleComplete(store, scope, project_id, item_id, deriveOne)
      }
      if (action === 'reorder' && method === 'POST') {
        return handleReorder(req, store, scope, project_id, item_id, derive)
      }
      return jsonError(
        405,
        'method_not_allowed',
        `unknown work-board action '${action}' or method '${method}'`,
      )
    },
  }
}

async function handleCreate(
  req: Request,
  store: WorkBoardStore,
  // The BOARD SCOPE KEY, not a slug: `workBoardScopeKey(owner, project_id)`. It
  // was named `project_slug`, which is how it ended up being passed to `writeDoc`
  // as a project id and writing General's plans into a phantom project directory.
  scope: string,
  project_id: string,
  createCard: WorkBoardCreateCardFn | undefined,
  classifyTaskType: ((title: string) => Promise<WorkBoardTaskType>) | undefined,
  /** Derived-inline-activity mapper from the handler closure (identity when unwired). */
  deriveOne: (item: WorkBoardItem | null) => WorkBoardItem | null,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) return jsonError(400, 'malformed_json', 'expected JSON body')
  const fields = body as Record<string, unknown>
  const title = readTitle(fields['title'])
  if (title === null) {
    return jsonError(400, 'invalid_title', 'title must be a non-empty string up to 256 chars')
  }
  const status = readStatus(fields['status'])
  if (status === false) {
    return jsonError(400, 'invalid_status', `status must be one of ${VALID_STATUSES.join('/')}`)
  }
  let task_type = readTaskType(fields['task_type'])
  if (task_type === false) {
    return jsonError(400, 'invalid_task_type', `task_type must be one of ${VALID_TASK_TYPES.join('/')}`)
  }
  const design_doc_ref = readOptionalString(fields['design_doc_ref'])
  if (design_doc_ref === false) {
    return jsonError(400, 'invalid_design_doc_ref', 'design_doc_ref must be a string')
  }
  const spec = readOptionalString(fields['spec'])
  if (spec === false) {
    return jsonError(400, 'invalid_spec', 'spec must be a string')
  }
  // #429 task 3 — the web add-form no longer carries a Build/Research picker, so
  // a create that OMITS task_type is auto-classified from the title here (before
  // BOTH the create_card and the store.create branches, so either path persists
  // the resolved type). An explicit task_type from ANY caller (mobile, agent
  // tools, ▶ retry) short-circuits this — it's never re-classified. The
  // classifier contract never rejects, but a defensive catch keeps a create from
  // failing on a classifier bug: it falls through to the store default ('build').
  if (task_type === null && classifyTaskType !== undefined) {
    try {
      task_type = await classifyTaskType(title)
    } catch {
      task_type = null
    }
  }
  try {
    // M1 on-disk spec: when the spec-doc path is wired, route through it so a
    // non-trivial `spec` is persisted to a plans/ doc and the card is linked;
    // else fall back to a plain title-only (+ optional ref) create.
    const item =
      createCard !== undefined
        ? await createCard(scope, project_id, {
            title,
            ...(status !== null ? { status } : {}),
            ...(task_type !== null ? { task_type } : {}),
            ...(design_doc_ref !== null ? { design_doc_ref } : {}),
            ...(spec !== null ? { spec } : {}),
          })
        : await store.create(scope, {
            title,
            ...(status !== null ? { status } : {}),
            ...(task_type !== null ? { task_type } : {}),
            ...(design_doc_ref !== null ? { design_doc_ref } : {}),
          })
    return jsonOk({ item: deriveOne(item), project_id }, 201)
  } catch (err) {
    return mapWriteError(err)
  }
}

/**
 * ▶ play button — START (a never-dispatched card) or RETRY (a card whose last
 * run failed/stopped) a build bound to the card, using its SAVED spec (the
 * design_doc_ref doc, else the title) as the task. Guards against double-firing:
 * a card that already has a LIVE (non-terminal) linked run returns 409 (the ▶
 * should not have rendered). An underspecified card (no doc + thin title) is
 * rejected 409 with the ask-before-acting guidance rather than firing a doomed
 * build. The dispatch chokepoint itself does the attachRun binding, so the card
 * flips to in_progress + fork ⑂ and the #174 live progress takes over.
 */
async function handleStart(
  store: WorkBoardStore,
  project_slug: string,
  project_id: string,
  item_id: string,
  trident_runs: TridentRunAccess | undefined,
  startBuild: WorkBoardStartBuildFn | undefined,
  startResearch: WorkBoardStartResearchFn | undefined,
): Promise<Response> {
  const item = store.get(project_slug, item_id)
  if (item === null) return jsonError(404, 'item_not_found', `item_id=${item_id}`)
  // #379 — ROUTE BY TASK TYPE. A 'research' card dispatches an Atlas
  // research/analysis agent (agent-dispatch); a 'build' card (the default)
  // dispatches an autonomous Trident run. The play button no longer stamps a
  // Trident build on everything.
  const isResearch = item.task_type === 'research'
  const dispatch = isResearch ? startResearch : startBuild
  if (dispatch === undefined) {
    const what = isResearch ? 'research (agent-dispatch)' : 'trident build'
    return jsonError(501, 'dispatch_unavailable', `${what} dispatch is not enabled on this instance`)
  }
  // Don't start a card that already has a live run (the ▶ is hidden for these,
  // but a stale client / concurrent request could still hit this). A BUILD card's
  // liveness is derived from the trident run store; a RESEARCH card's linked run
  // is an agent-dispatch run (not a trident row), so a still-set linked_run_id
  // whose trident lookup is null means "a live research run" → also guard it
  // (the composer's dispatch additionally coalesces a double-▶ via spawn_key).
  const runId = item.linked_run_id
  if (runId !== null && runId.length > 0) {
    if (isResearch) {
      // A research card keeps its linked_run_id ONLY while the dispatch is live
      // (the terminal reconcile clears it); a still-set id ⇒ a live research run.
      return jsonError(409, 'already_running', `item_id=${item_id} already has a live research run (${runId})`)
    }
    if (trident_runs !== undefined) {
      const run = trident_runs.get(runId)
      if (run !== null && !isTerminalPhase(run.phase)) {
        return jsonError(409, 'already_running', `item_id=${item_id} already has a live build (${runId})`)
      }
    }
  }
  const result = await dispatch(project_slug, item)
  if (!result.ok) {
    // #337 — an underspecified card is NOT an error to paint in the work pane:
    // `startBuild` has already posted a clarifying question to the chat and left
    // the item pending. Return 200 so the client shows no raw-guard banner.
    if (result.code === 'underspecified') {
      return jsonOk({ asked_in_chat: true, item_id, project_id })
    }
    const status = result.code === 'backend_error' ? 500 : 409
    return jsonError(status, result.code, result.message)
  }
  return jsonOk({ started: item_id, run_id: result.run_id, project_id })
}

async function handleUpdate(
  req: Request,
  store: WorkBoardStore,
  project_slug: string,
  project_id: string,
  item_id: string,
  /** Derived-inline-activity mapper from the handler closure (identity when unwired). */
  deriveOne: (item: WorkBoardItem | null) => WorkBoardItem | null,
): Promise<Response> {
  const owned = store.get(project_slug, item_id)
  if (owned === null) return jsonError(404, 'item_not_found', `item_id=${item_id}`)
  const body = await readJsonBody(req)
  if (body === null) return jsonError(400, 'malformed_json', 'expected JSON body')
  const fields = body as Record<string, unknown>
  const patch: { title?: string; status?: WorkBoardStatus; design_doc_ref?: string | null } = {}
  if (fields['title'] !== undefined) {
    const title = readTitle(fields['title'])
    if (title === null) {
      return jsonError(400, 'invalid_title', 'title must be a non-empty string up to 256 chars')
    }
    patch.title = title
  }
  if (fields['status'] !== undefined) {
    const status = readStatus(fields['status'])
    if (status === false || status === null) {
      return jsonError(400, 'invalid_status', `status must be one of ${VALID_STATUSES.join('/')}`)
    }
    patch.status = status
  }
  if (fields['design_doc_ref'] !== undefined) {
    const ref = readOptionalString(fields['design_doc_ref'])
    if (ref === false) {
      return jsonError(400, 'invalid_design_doc_ref', 'design_doc_ref must be a string or null')
    }
    patch.design_doc_ref = ref
  }
  try {
    const item = await store.update(project_slug, item_id, patch)
    return jsonOk({ item: deriveOne(item), project_id })
  } catch (err) {
    // 409, not 500: the store REFUSES to SHELVE (status:'archived') an item whose
    // build is still live, and that is a legitimate answer about state rather
    // than a fault — the same rule handleComplete applies to 'done'. The client
    // shows the message.
    if (err instanceof WorkBoardRunStillLiveError) {
      return jsonError(409, 'run_still_live', err.message)
    }
    return mapWriteError(err)
  }
}

async function handleComplete(
  store: WorkBoardStore,
  project_slug: string,
  project_id: string,
  item_id: string,
  /** Derived-inline-activity mapper from the handler closure (identity when unwired). */
  deriveOne: (item: WorkBoardItem | null) => WorkBoardItem | null,
): Promise<Response> {
  const owned = store.get(project_slug, item_id)
  if (owned === null) return jsonError(404, 'item_not_found', `item_id=${item_id}`)
  // 409, not 500: the store REFUSES to complete an item whose build is still
  // live, and that is a legitimate answer about state rather than a fault. This is
  // the path the board row's pulsing dot takes — its click advances status, so on
  // an in-progress item it lands here and used to assert a running build had
  // finished (2026-08-11). The client shows the message.
  try {
    const item = await store.complete(project_slug, item_id)
    return jsonOk({ item: deriveOne(item), project_id })
  } catch (err) {
    if (err instanceof WorkBoardRunStillLiveError) {
      return jsonError(409, 'run_still_live', err.message)
    }
    throw err
  }
}

async function handleReorder(
  req: Request,
  store: WorkBoardStore,
  project_slug: string,
  project_id: string,
  item_id: string,
  /** Derived-inline-activity mapper from the handler closure (identity when unwired). */
  derive: (items: WorkBoardItem[]) => WorkBoardItem[],
): Promise<Response> {
  const owned = store.get(project_slug, item_id)
  if (owned === null) return jsonError(404, 'item_not_found', `item_id=${item_id}`)
  const body = (await readJsonBody(req)) ?? {}
  const fields = body as Record<string, unknown>
  const before = readOptionalString(fields['before'])
  const after = readOptionalString(fields['after'])
  if (before === false || after === false) {
    return jsonError(400, 'invalid_reorder_target', 'before/after must be item id strings')
  }
  await store.reorder(project_slug, item_id, {
    ...(before !== null ? { before } : {}),
    ...(after !== null ? { after } : {}),
  })
  return jsonOk({ items: derive(store.list(project_slug)), project_id })
}

async function handleDelete(
  store: WorkBoardStore,
  removal: WorkBoardRemovalService,
  // The BOARD SCOPE KEY, not a slug: `workBoardScopeKey(owner, project_id)`.
  scope: string,
  // The DOCS project id (the validated URL segment) — a SEPARATE argument from
  // the scope on purpose, exactly as the create path hands it to `createCard`.
  // Collapsing the two is the phantom-directory conflation documented in
  // `work-board/spec-doc-service.ts`.
  project_id: string,
  item_id: string,
  query: URLSearchParams,
): Promise<Response> {
  const owned = store.get(scope, item_id)
  if (owned === null) return jsonError(404, 'item_not_found', `item_id=${item_id}`)
  // The removal REASON drives the plan doc's disposition (shipped / cancelled /
  // moved are three different fates). The X in the UI sends none, and its
  // semantics have always been "I'm dropping this" → default `cancelled`.
  const rawReason = query.get('reason')
  if (rawReason !== null && !WORK_BOARD_REMOVAL_REASONS.includes(rawReason as WorkBoardRemovalReason)) {
    return jsonError(400, 'invalid_reason', `reason must be one of ${WORK_BOARD_REMOVAL_REASONS.join('/')}`)
  }
  const reason = (rawReason ?? 'cancelled') as WorkBoardRemovalReason
  // The ONLY way to destroy a plan doc, and it must be spelled out exactly.
  const rawPlanDoc = query.get('plan_doc')
  if (rawPlanDoc !== null && rawPlanDoc !== 'delete') {
    return jsonError(400, 'invalid_plan_doc', "plan_doc must be 'delete' when present")
  }
  // Cancel a live bound run FIRST, dispose the doc, THEN drop the row — the
  // shared chokepoint owns that order (and the agent tool rides the same one).
  const result = await removal.remove(scope, project_id, item_id, {
    reason,
    ...(rawPlanDoc === 'delete' ? { plan_doc: 'delete' as const } : {}),
  })
  if (!result.removed) return jsonError(404, 'item_not_found', `item_id=${item_id}`)
  // Wire-compatible: existing clients read `deleted` / `cancelled_run` unchanged.
  return jsonOk({
    deleted: item_id,
    project_id,
    ...(result.cancelled_run !== undefined ? { cancelled_run: result.cancelled_run } : {}),
    ...(result.plan_doc !== undefined ? { plan_doc: result.plan_doc } : {}),
  })
}

/** Validated non-empty title (<=256 chars) or null when malformed. */
function readTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > 256) return null
  return trimmed
}

/** Status enum: a valid status, `null` when absent, or `false` when malformed. */
function readStatus(raw: unknown): WorkBoardStatus | null | false {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return false
  if (!VALID_STATUSES.includes(raw as WorkBoardStatus)) return false
  return raw as WorkBoardStatus
}

/** task_type enum: a valid kind, `null` when absent, or `false` when malformed. */
function readTaskType(raw: unknown): WorkBoardTaskType | null | false {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return false
  if (!VALID_TASK_TYPES.includes(raw as WorkBoardTaskType)) return false
  return raw as WorkBoardTaskType
}

/** Optional string: the string, `null` when absent/empty, or `false` when malformed. */
function readOptionalString(raw: unknown): string | null | false {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return false
  return raw
}

function sanitizeItemId(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_ITEM_ID_LEN) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(raw)) return null
  return raw
}

/** Map a store validation error to a 400; rethrow anything else (500). */
function mapWriteError(err: unknown): Response {
  if (err instanceof WorkBoardValidationError) return jsonError(400, err.code, err.message)
  throw err
}
