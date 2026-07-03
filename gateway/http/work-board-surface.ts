/**
 * @neutronai/gateway/http — Expo-app project Work Board surface (Phase 1a).
 *
 * The HUMAN read+WRITE path on the Work Board. Owns:
 *
 *   - `GET    /api/app/projects/<project_id>/work-board`                 list
 *   - `POST   /api/app/projects/<project_id>/work-board`                 create
 *   - `PATCH  /api/app/projects/<project_id>/work-board/<item_id>`       update
 *   - `POST   /api/app/projects/<project_id>/work-board/<item_id>/complete`
 *   - `POST   /api/app/projects/<project_id>/work-board/<item_id>/reorder`
 *   - `DELETE /api/app/projects/<project_id>/work-board/<item_id>`
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

import { sanitizeProjectId } from '../../channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '../../channels/adapters/app-ws/auth.ts'
import {
  WorkBoardValidationError,
  workBoardScopeKey,
  type WorkBoardItem,
  type WorkBoardStatus,
  type WorkBoardStore,
} from '../../work-board/store.ts'
import { isTerminalPhase } from '../../trident/state-machine.ts'
import { runProgressForItem } from '../../trident/run-progress.ts'
import type { TridentPhase, TridentRun } from '../../trident/store.ts'

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
  project_slug: string,
  input: { title: string; status?: WorkBoardStatus; design_doc_ref?: string | null; spec?: string },
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

export interface WorkBoardSurfaceOptions {
  store: WorkBoardStore
  auth: AppWsAuthResolver
  /** Trident run access for live progress (item 1) + delete-cancels-run (item 3). */
  trident_runs?: TridentRunAccess
  /** Injectable clock (ms) for the run-progress derivation; defaults to wall-clock. */
  now?: () => number
  /** M1 on-disk spec — persist a non-trivial create `spec` to a plans/ doc. */
  create_card?: WorkBoardCreateCardFn
  /** M1 ▶ play button — start/retry a build from the card's saved spec. */
  start_build?: WorkBoardStartBuildFn
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
const VALID_STATUSES: WorkBoardStatus[] = ['upcoming', 'in_progress', 'done']

export function createWorkBoardSurface(opts: WorkBoardSurfaceOptions): WorkBoardSurface {
  const { store, auth, trident_runs } = opts
  const nowMs = opts.now ?? (() => Date.now())
  const createCard = opts.create_card
  const startBuild = opts.start_build

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
      const method = req.method

      // Bare collection path: `/work-board`.
      if (raw_item_id === '') {
        if (method === 'GET') {
          return jsonOk({ items: withRunProgress(store.list(scope)), project_id })
        }
        if (method === 'POST') {
          return handleCreate(req, store, scope, project_id, createCard)
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
          return handleUpdate(req, store, scope, project_id, item_id)
        }
        if (method === 'DELETE') {
          return handleDelete(store, scope, project_id, item_id, trident_runs)
        }
        return jsonError(
          405,
          'method_not_allowed',
          `method '${method}' not allowed on /work-board/<id>`,
        )
      }
      if (action === 'start' && method === 'POST') {
        return handleStart(store, scope, project_id, item_id, trident_runs, startBuild)
      }
      if (action === 'complete' && method === 'POST') {
        return handleComplete(store, scope, project_id, item_id)
      }
      if (action === 'reorder' && method === 'POST') {
        return handleReorder(req, store, scope, project_id, item_id)
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
  project_slug: string,
  project_id: string,
  createCard: WorkBoardCreateCardFn | undefined,
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
  const design_doc_ref = readOptionalString(fields['design_doc_ref'])
  if (design_doc_ref === false) {
    return jsonError(400, 'invalid_design_doc_ref', 'design_doc_ref must be a string')
  }
  const spec = readOptionalString(fields['spec'])
  if (spec === false) {
    return jsonError(400, 'invalid_spec', 'spec must be a string')
  }
  try {
    // M1 on-disk spec: when the spec-doc path is wired, route through it so a
    // non-trivial `spec` is persisted to a plans/ doc and the card is linked;
    // else fall back to a plain title-only (+ optional ref) create.
    const item =
      createCard !== undefined
        ? await createCard(project_slug, {
            title,
            ...(status !== null ? { status } : {}),
            ...(design_doc_ref !== null ? { design_doc_ref } : {}),
            ...(spec !== null ? { spec } : {}),
          })
        : await store.create(project_slug, {
            title,
            ...(status !== null ? { status } : {}),
            ...(design_doc_ref !== null ? { design_doc_ref } : {}),
          })
    return jsonOk({ item, project_id }, 201)
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
): Promise<Response> {
  const item = store.get(project_slug, item_id)
  if (item === null) return jsonError(404, 'item_not_found', `item_id=${item_id}`)
  if (startBuild === undefined) {
    return jsonError(501, 'build_dispatch_unavailable', 'trident build dispatch is not enabled on this instance')
  }
  // Don't start a card that already has a live build (the ▶ is hidden for these,
  // but a stale client / concurrent request could still hit this).
  const runId = item.linked_run_id
  if (trident_runs !== undefined && runId !== null && runId.length > 0) {
    const run = trident_runs.get(runId)
    if (run !== null && !isTerminalPhase(run.phase)) {
      return jsonError(409, 'already_running', `item_id=${item_id} already has a live build (${runId})`)
    }
  }
  const result = await startBuild(project_slug, item)
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
    return jsonOk({ item, project_id })
  } catch (err) {
    return mapWriteError(err)
  }
}

async function handleComplete(
  store: WorkBoardStore,
  project_slug: string,
  project_id: string,
  item_id: string,
): Promise<Response> {
  const owned = store.get(project_slug, item_id)
  if (owned === null) return jsonError(404, 'item_not_found', `item_id=${item_id}`)
  const item = await store.complete(project_slug, item_id)
  return jsonOk({ item, project_id })
}

async function handleReorder(
  req: Request,
  store: WorkBoardStore,
  project_slug: string,
  project_id: string,
  item_id: string,
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
  return jsonOk({ items: store.list(project_slug), project_id })
}

async function handleDelete(
  store: WorkBoardStore,
  project_slug: string,
  project_id: string,
  item_id: string,
  trident_runs: TridentRunAccess | undefined,
): Promise<Response> {
  const owned = store.get(project_slug, item_id)
  if (owned === null) return jsonError(404, 'item_not_found', `item_id=${item_id}`)
  // Item 3 — deleting a card bound to a RUNNING build must not orphan the trident
  // run (it would keep building headless). Cancel it FIRST: if the item names a
  // non-terminal `linked_run_id`, set the run's phase to `stopped` (the existing
  // trident stop path — `code-command.ts` executeStop) so the outer loop stops
  // harvesting/advancing/merging it. Best-effort: a cancel failure never blocks
  // the delete (the row is disposable; the run reap backstops liveness). Only
  // THEN remove the board item.
  let cancelled_run: string | undefined
  const runId = owned.linked_run_id
  if (trident_runs !== undefined && runId !== null && runId.length > 0) {
    try {
      const run = trident_runs.get(runId)
      if (run !== null && !isTerminalPhase(run.phase)) {
        await trident_runs.update(runId, { phase: 'stopped' })
        cancelled_run = runId
      }
    } catch {
      // Cancel is best-effort — proceed with the delete regardless.
    }
  }
  await store.delete(project_slug, item_id)
  return jsonOk({
    deleted: item_id,
    project_id,
    ...(cancelled_run !== undefined ? { cancelled_run } : {}),
  })
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

function jsonOk(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
