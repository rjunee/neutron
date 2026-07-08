/**
 * @neutronai/tasks-core — TaskStore interface + reference adapters.
 *
 * The Tasks Core programs against `TaskStore` (create / list / update /
 * complete / delete). The `tasks/` workspace package is the
 * substrate's P0 placeholder — its public API is one constant and
 * nothing else (per `tasks/AGENTS.md`: "P0 ships only the empty
 * skeleton", the canonical task DB lands in P6). Until then the Core
 * carries its own backend interface here and wraps an in-memory
 * reference implementation; when P6 lands, the real per-project task
 * DB grows the same `TaskStore` shape and the Core swaps its adapter
 * without touching the tool contract or the manifest.
 *
 * Why this lives in the Core, not under `tasks/`:
 * - The brief says `tasks/` public API stays unchanged this sprint
 *   (Tasks Core wraps; doesn't refactor). The substrate is intentionally
 *   empty pre-P6 and growing a real TaskStore now would pre-empt P6's
 *   schema decisions.
 * - The Core ships a self-contained behavioural contract today so the
 *   launcher + MCP tools work end-to-end (M2 Casey dogfood). The P6
 *   work later promotes this interface into `tasks/`, leaving the
 *   Core as a thin adapter.
 *
 * `TODO(P6)`: move `TaskStore` + `buildInMemoryTaskStore` under
 * `tasks/` once the canonical schema lands; Core retains only the
 * adapter (`buildSubstrateTaskStore(store)`) that wires the Core's
 * tool surface to whichever store the substrate exposes.
 */

import { randomUUID } from 'node:crypto'

import {
  NO_PROJECT,
  TaskStore as SubstrateTaskStore,
  TaskNotFoundError as SubstrateTaskNotFoundError,
  type Task as SubstrateTask,
} from '@neutronai/tasks'

import type { ProjectDb } from '@neutronai/persistence/index.ts'

import { CORE_PACKAGE_NAME } from './manifest.ts'

/**
 * Task status — open (still pending) or done (completed). The MCP tool
 * schema constrains writes to this pair; future `cancelled` /
 * `blocked` states land alongside P6's full task system overhaul.
 */
export type TaskStatus = 'open' | 'done'

/**
 * The row shape returned by every `TaskStore` read path. Mirrors the
 * tool output schema 1:1 — fields not set on a row are simply absent
 * (the JSON Schema's `required` block names only the always-present
 * fields, so optional fields like `due_date` round-trip cleanly).
 */
export interface TaskRow {
  id: string
  title: string
  status: TaskStatus
  /** ISO-8601 string. */
  due_date?: string
  priority?: number
  project_id?: string
  /** Wall-clock ms when the row was first persisted. */
  created_at: number
  /** Wall-clock ms of the most recent mutation. */
  updated_at: number
  /** Wall-clock ms the row transitioned to status='done'. */
  completed_at?: number
}

export interface TaskCreateInput {
  title: string
  due_date?: string
  priority?: number
  project_id?: string
}

/**
 * Fields a `TaskStore.update` call may set. Every field is optional;
 * the store applies a partial patch and bumps `updated_at`. `id`,
 * `created_at`, and the audit timestamps remain immutable through this
 * surface.
 */
export interface TaskUpdateFields {
  title?: string
  due_date?: string
  priority?: number
  project_id?: string
  status?: TaskStatus
}

export interface TaskListInput {
  project_id?: string
  /**
   * Status filter. `'open'` (default) excludes completed rows;
   * `'done'` includes only completed rows; `'all'` returns every row
   * regardless of status. The launcher's default tab maps to `'open'`
   * — completed work doesn't visually crowd the active list.
   */
  status?: TaskStatus | 'all'
  limit?: number
  /**
   * Ordering. `'recent'` (default) is created_at DESC — matches the
   * legacy list semantics. `'focus_score'` is the P6 focus ordering
   * (focus_score DESC, due_date ASC, created_at DESC) — surfaces the
   * highest-priority open work first. Pick-next dispatches with
   * `'focus_score'`; the launcher's default tab keeps `'recent'`.
   */
  order?: 'recent' | 'focus_score'
}

/**
 * Input for the `pickNext` candidate query. Returns the top
 * `focus_score`-ranked open tasks (newest-first on ties) — the
 * pick-next service hands these to the LLM for the final selection.
 */
export interface TaskPickNextCandidatesInput {
  project_id?: string
  /** Maximum candidates to return. Default 20 (cap 50). */
  limit?: number
}

/**
 * Backend contract every TaskStore implementation satisfies. The
 * shape is intentionally narrow and substrate-agnostic — an in-memory
 * fake (this module) and the P6 SQLite/canonical task DB satisfy the
 * same surface.
 */
export interface TaskStore {
  create(input: TaskCreateInput): Promise<TaskRow>
  list(input: TaskListInput): Promise<TaskRow[]>
  /** Returns the updated row. Throws `TaskNotFoundError` on unknown id. */
  update(id: string, fields: TaskUpdateFields): Promise<TaskRow>
  /** Returns the completed row. Throws `TaskNotFoundError` on unknown id. */
  complete(id: string): Promise<TaskRow>
  /** Removes the row by id. Throws `TaskNotFoundError` on unknown id. */
  delete(id: string): Promise<void>
  /**
   * Return the focus_score-ranked top open tasks for the pick-next
   * service. Pure data fetch — the LLM-driven candidate selection
   * lives in the pick-next service. Excludes done / cancelled rows.
   */
  pickNextCandidates(input: TaskPickNextCandidatesInput): Promise<TaskRow[]>
}

/**
 * Thrown when an `update` / `complete` / `delete` call references a
 * task id that doesn't exist. The Core's tool layer surfaces this as
 * `error` outcome via the CapabilityGuard wrapper — the audit log
 * records the failure and the caller sees the message.
 */
export class TaskNotFoundError extends Error {
  readonly code = 'task_not_found' as const
  readonly task_id: string

  constructor(task_id: string) {
    super(`task not found: ${task_id}`)
    this.name = 'TaskNotFoundError'
    this.task_id = task_id
  }
}

/**
 * Default page size when callers omit `limit`. Generous enough for a
 * launcher-shell preview list, conservative enough that an unbounded
 * query doesn't fan out the full project history once a long-lived
 * project accumulates thousands of completed rows.
 */
const DEFAULT_LIST_LIMIT = 100

/**
 * Default + cap for the `pickNextCandidates` candidate window. The
 * pick-next prompt fits ~20 candidates without bloating the LLM token
 * budget; the cap prevents pathological callers from pulling the full
 * project backlog into one prompt.
 */
export const DEFAULT_PICK_NEXT_CANDIDATE_LIMIT = 20
export const PICK_NEXT_CANDIDATE_LIMIT_CAP = 50

interface InMemoryTaskStoreOptions {
  /**
   * Wall-clock override for tests that need deterministic timestamps.
   * Returns ms since epoch. Production callers omit this and the
   * store falls through to `Date.now()`.
   */
  now?: () => number
  /**
   * Id minter override for tests that want stable ids (`t-0`, `t-1`,
   * ...). Production callers omit and the store falls through to
   * `randomUUID()`.
   */
  nextId?: () => string
}

/**
 * Reference in-memory `TaskStore`. Sufficient for verifying the Core's
 * tool wiring end-to-end and shipping the Tier 1 Tasks Core surface to
 * Casey (M2 dogfood) before the P6 canonical task DB lands.
 *
 * Ordering: `list` returns RECENT-FIRST (newest `created_at` first) per
 * the brief's behavioural-spec gate.
 *
 * Status semantics: `update({status: 'done'})` and `complete()` both
 * stamp `completed_at`. `update({status: 'open'})` clears `completed_at`
 * (a "re-open" path the launcher exposes when a user un-checks a
 * completed task).
 */
export function buildInMemoryTaskStore(
  options: InMemoryTaskStoreOptions = {},
): TaskStore {
  const now = options.now ?? ((): number => Date.now())
  const nextId = options.nextId ?? ((): string => randomUUID())
  const rows = new Map<string, TaskRow>()

  return {
    async create(input: TaskCreateInput): Promise<TaskRow> {
      const id = nextId()
      const ts = now()
      const row: TaskRow = {
        id,
        title: input.title,
        status: 'open',
        created_at: ts,
        updated_at: ts,
      }
      if (input.due_date !== undefined) row.due_date = input.due_date
      if (input.priority !== undefined) row.priority = input.priority
      if (input.project_id !== undefined) row.project_id = input.project_id
      rows.set(id, row)
      return { ...row }
    },

    async list(input: TaskListInput): Promise<TaskRow[]> {
      const limit = input.limit ?? DEFAULT_LIST_LIMIT
      const status = input.status ?? 'open'
      const order = input.order ?? 'recent'
      const out: TaskRow[] = []
      for (const row of rows.values()) {
        if (status !== 'all' && row.status !== status) continue
        if (
          input.project_id !== undefined &&
          row.project_id !== input.project_id
        ) {
          continue
        }
        out.push({ ...row })
      }
      if (order === 'focus_score') {
        // In-memory fake has no focus_score column; derive a tiebreak
        // that mirrors the canonical store's ordering: P6 scale is 0-3
        // with 3 = most urgent (priorityToFocusScale 5), so sort
        // priority DESC; due_date ASC (sooner first); created_at DESC.
        // Tests supply priorities within the canonical 0-3 range.
        out.sort((a, b) => {
          const pa = a.priority ?? -1
          const pb = b.priority ?? -1
          if (pa !== pb) return pb - pa
          const da = a.due_date ?? '￿'
          const db = b.due_date ?? '￿'
          if (da !== db) return da < db ? -1 : 1
          return b.created_at - a.created_at
        })
      } else {
        out.sort((a, b) => b.created_at - a.created_at)
      }
      return out.slice(0, limit)
    },

    async pickNextCandidates(
      input: TaskPickNextCandidatesInput,
    ): Promise<TaskRow[]> {
      const requestedLimit = input.limit ?? DEFAULT_PICK_NEXT_CANDIDATE_LIMIT
      const cappedLimit = Math.min(requestedLimit, PICK_NEXT_CANDIDATE_LIMIT_CAP)
      const listInput: TaskListInput = {
        status: 'open',
        limit: cappedLimit,
        order: 'focus_score',
      }
      if (input.project_id !== undefined) listInput.project_id = input.project_id
      // Reach into the local `list` we just defined — keeps the
      // ordering rules in one place.
      const out: TaskRow[] = []
      for (const row of rows.values()) {
        if (row.status !== 'open') continue
        if (
          input.project_id !== undefined &&
          row.project_id !== input.project_id
        ) {
          continue
        }
        out.push({ ...row })
      }
      out.sort((a, b) => {
        const pa = a.priority ?? -1
        const pb = b.priority ?? -1
        if (pa !== pb) return pb - pa
        const da = a.due_date ?? '￿'
        const db = b.due_date ?? '￿'
        if (da !== db) return da < db ? -1 : 1
        return b.created_at - a.created_at
      })
      return out.slice(0, cappedLimit)
    },

    async update(id: string, fields: TaskUpdateFields): Promise<TaskRow> {
      const row = rows.get(id)
      if (row === undefined) throw new TaskNotFoundError(id)
      const next: TaskRow = { ...row, updated_at: now() }
      if (fields.title !== undefined) next.title = fields.title
      if (fields.due_date !== undefined) next.due_date = fields.due_date
      if (fields.priority !== undefined) next.priority = fields.priority
      if (fields.project_id !== undefined) next.project_id = fields.project_id
      if (fields.status !== undefined) {
        next.status = fields.status
        if (fields.status === 'done') {
          next.completed_at = next.updated_at
        } else {
          delete next.completed_at
        }
      }
      rows.set(id, next)
      return { ...next }
    },

    async complete(id: string): Promise<TaskRow> {
      const row = rows.get(id)
      if (row === undefined) throw new TaskNotFoundError(id)
      const ts = now()
      const next: TaskRow = {
        ...row,
        status: 'done',
        updated_at: ts,
        completed_at: ts,
      }
      rows.set(id, next)
      return { ...next }
    },

    async delete(id: string): Promise<void> {
      if (!rows.has(id)) throw new TaskNotFoundError(id)
      rows.delete(id)
    },
  }
}

/**
 * Origin tag every task this Core writes through the canonical store
 * carries in the substrate's `source` column. Matches the equivalent
 * pattern in `@neutronai/reminders-core` (`CORE_SOURCE_TAG`) so an
 * operator can grep `source = '@neutronai/tasks-core'` to attribute a
 * row to the Core's tool surface vs the app/UI/agent writers.
 */
export const CORE_TASK_SOURCE_TAG: string = CORE_PACKAGE_NAME

export interface SubstrateTaskStoreBackendOptions {
  /**
   * Instance slug the adapter binds to — every write/read scopes to
   * this slug so the Core never leaks tasks across instances.
   */
  project_slug: string
  /**
   * The per-project `ProjectDb` the canonical task store writes through.
   * Same DB the app's `/api/app/projects/<id>/tasks` surface composes
   * its `TaskStore` over, so a tool-created task is immediately
   * visible to that HTTP surface (and vice-versa).
   *
   * Mandatory; `store` is optional.
   */
  projectDb: ProjectDb
  /**
   * Pre-built canonical `TaskStore`. When provided, the adapter uses
   * THIS instance instead of constructing its own — so subscribers
   * attached by the composer (projection writer, reminder-link layer)
   * fire on Core-driven writes too. Without this seam the Core would
   * construct a subscriber-free store and tasks created via
   * `tasks_create` would silently bypass the STATUS.md projection.
   */
  store?: SubstrateTaskStore
}

/**
 * Adapter from the substrate `@neutronai/tasks` canonical `TaskStore` to
 * the Core's product-level `TaskStore`. Stateless wrapper bound to a
 * single instance slug — every id-based mutation (`update`, `complete`,
 * `delete`) re-reads the row first and asserts `project_slug` matches
 * before touching it.
 *
 * Wiring rationale: an in-memory fallback (`buildInMemoryTaskStore()`)
 * would create a process-local store invisible to the Expo app's
 * tasks surface (which reads through `new TaskStore(db)`). Two
 * surfaces with the same conceptual task list would diverge at
 * runtime AND on every gateway restart. This adapter binds the
 * Core's tool wiring to the SAME canonical store the HTTP surface
 * composes — one source of truth, persisted via the per-project
 * SQLite.
 *
 * Type bridges:
 *
 *  - `TaskRow.created_at/updated_at/completed_at` are wall-clock MS
 *    in the Core's surface; the canonical `Task` uses ISO-8601 strings.
 *    The adapter converts ISO → ms on read via `Date.parse`.
 *
 *  - Status set: the Core surfaces `'open' | 'done'`; the canonical
 *    store surfaces `'open' | 'done' | 'cancelled'`. The adapter
 *    filters `cancelled` rows out of `list()` even when the caller
 *    asks for `'all'` — a Core caller's UI can't render `cancelled`
 *    anyway, and surfacing one would mis-type as `'open'`.
 *
 *  - Project scoping: the canonical store treats `NO_PROJECT` (the
 *    empty string) as "no project"; the Core's surface uses
 *    `project_id: undefined` for the same intent. The adapter
 *    bidirectionally maps `''` ↔ `undefined`.
 *
 * Cross-project safety: the canonical store's `get`/`update`/`complete`
 * /`delete` are keyed by `id` alone (no `project_slug` filter on those
 * paths). Without an adapter-layer ownership check a caller who
 * learned another instance's task id could mutate it. Every mutation
 * here re-reads via `get(id)` and rejects when `project_slug` mismatches
 * — same posture the reminders adapter uses (see `ownsRow` in
 * `@neutronai/reminders-core/src/backend.ts`).
 */
export function buildSubstrateTaskStoreBackend(
  opts: SubstrateTaskStoreBackendOptions,
): TaskStore {
  const store = opts.store ?? new SubstrateTaskStore(opts.projectDb)

  function ownedTask(id: string): SubstrateTask | null {
    const row = store.get(id)
    if (row === null) return null
    if (row.project_slug !== opts.project_slug) return null
    return row
  }

  return {
    async create(input: TaskCreateInput): Promise<TaskRow> {
      const createInput: Parameters<SubstrateTaskStore['create']>[0] = {
        project_slug: opts.project_slug,
        title: input.title,
        priority: input.priority ?? null,
        due_date: input.due_date ?? null,
        source: CORE_TASK_SOURCE_TAG,
      }
      if (input.project_id !== undefined) createInput.project_id = input.project_id
      const row = await store.create(createInput)
      return substrateToRow(row)
    },

    async list(input: TaskListInput): Promise<TaskRow[]> {
      const limit = input.limit ?? DEFAULT_LIST_LIMIT
      const requested = input.status ?? 'open'
      const order = input.order ?? 'recent'
      const listInput: Parameters<SubstrateTaskStore['list']>[0] = {
        project_slug: opts.project_slug,
        // Core's surface only exposes 'open' | 'done'; for 'all' we
        // pass through and filter below. For 'open' / 'done' the
        // canonical store already narrows correctly.
        status: requested,
        limit,
      }
      if (input.project_id !== undefined) listInput.project_id = input.project_id
      if (order === 'focus_score') listInput.order = 'focus_score'
      const rows = store.list(listInput)
      const filtered = rows.filter((r) => r.status !== 'cancelled')
      if (order === 'focus_score') {
        // Canonical store already ordered by focus_score DESC NULLS
        // LAST, due_date ASC NULLS LAST, created_at DESC. Preserve it.
        return filtered.map(substrateToRow)
      }
      // Canonical default order is (open-first, due_date ASC, created_at
      // DESC). The Core's RECENT semantic is created_at DESC; re-sort.
      filtered.sort(
        (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
      )
      return filtered.map(substrateToRow)
    },

    async pickNextCandidates(
      input: TaskPickNextCandidatesInput,
    ): Promise<TaskRow[]> {
      const requestedLimit = input.limit ?? DEFAULT_PICK_NEXT_CANDIDATE_LIMIT
      const cappedLimit = Math.min(requestedLimit, PICK_NEXT_CANDIDATE_LIMIT_CAP)
      const listInput: Parameters<SubstrateTaskStore['list']>[0] = {
        project_slug: opts.project_slug,
        status: 'open',
        order: 'focus_score',
        limit: cappedLimit,
      }
      if (input.project_id !== undefined) listInput.project_id = input.project_id
      const rows = store.list(listInput)
      // status filter already excluded done/cancelled at the canonical
      // layer; defensive filter keeps the Core's invariant explicit.
      const filtered = rows.filter((r) => r.status === 'open')
      return filtered.map(substrateToRow)
    },

    async update(id: string, fields: TaskUpdateFields): Promise<TaskRow> {
      const before = ownedTask(id)
      if (before === null) throw new TaskNotFoundError(id)
      const patch: Parameters<SubstrateTaskStore['update']>[1] = {}
      if (fields.title !== undefined) patch.title = fields.title
      if (fields.due_date !== undefined) patch.due_date = fields.due_date
      if (fields.priority !== undefined) patch.priority = fields.priority
      if (fields.project_id !== undefined) patch.project_id = fields.project_id
      if (fields.status !== undefined) patch.status = fields.status
      try {
        const updated = await store.update(id, patch)
        return substrateToRow(updated)
      } catch (err) {
        if (err instanceof SubstrateTaskNotFoundError) {
          throw new TaskNotFoundError(id)
        }
        throw err
      }
    },

    async complete(id: string): Promise<TaskRow> {
      const before = ownedTask(id)
      if (before === null) throw new TaskNotFoundError(id)
      try {
        const completed = await store.complete(id)
        return substrateToRow(completed)
      } catch (err) {
        if (err instanceof SubstrateTaskNotFoundError) {
          throw new TaskNotFoundError(id)
        }
        throw err
      }
    },

    async delete(id: string): Promise<void> {
      const before = ownedTask(id)
      if (before === null) throw new TaskNotFoundError(id)
      try {
        await store.delete(id)
      } catch (err) {
        if (err instanceof SubstrateTaskNotFoundError) {
          throw new TaskNotFoundError(id)
        }
        throw err
      }
    },
  }
}

function substrateToRow(t: SubstrateTask): TaskRow {
  // The canonical store stamps ISO-8601 strings; the Core's TaskRow
  // surface is wall-clock ms (matches the in-memory reference adapter +
  // the manifest's output_schema declaration). Convert at the boundary.
  const created_at = Date.parse(t.created_at)
  const updated_at = Date.parse(t.updated_at)
  // The Core's status enum is `'open' | 'done'`; the canonical store
  // may surface `'cancelled'`. `list()` filters cancelled rows out
  // BEFORE calling this mapper; on the read paths (`update` returns,
  // `complete` returns) the canonical store's status transitions are
  // bounded to the same `'open' | 'done'` subset the Core writes.
  const status: TaskStatus = t.status === 'done' ? 'done' : 'open'
  const row: TaskRow = {
    id: t.id,
    title: t.title,
    status,
    created_at,
    updated_at,
  }
  if (t.due_date !== null) row.due_date = t.due_date
  if (t.priority !== null) row.priority = t.priority
  if (t.project_id !== NO_PROJECT) row.project_id = t.project_id
  if (t.completed_at !== null) {
    const completed_at = Date.parse(t.completed_at)
    if (Number.isFinite(completed_at)) row.completed_at = completed_at
  }
  return row
}
