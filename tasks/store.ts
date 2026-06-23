/**
 * @neutronai/tasks — canonical per-instance task store.
 *
 * Per docs/engineering-plan.md § B.P6, this module owns the single
 * source of truth for tasks across the instance: agents, the chat
 * surface, the app's Tasks tab, the CLI, the reminder→task converter,
 * and the overnight-work auto-task creator all write through one
 * schema. STATUS.md / ACTIONS.md are auto-generated read-only
 * projections (see `tasks/projection/`).
 *
 * P6.0 (substrate, shipped):
 *   * the `tasks` table (migration 0032)
 *   * CRUD methods used by every surface:
 *       create / list / get / update / complete / cancel / delete
 *   * project scoping (`project_id` defaults to `''` for "no project")
 *   * project isolation (every read filters by project_slug)
 *
 * P6 (this sprint) adds on top:
 *   * `focus_score` / `focus_score_updated_at` columns (migration 0037)
 *   * synchronous focus-score stamping on every score-affecting write
 *   * a mutation-event subscription surface (`TaskStore.subscribe`)
 *     consumed by the projection layer + (optionally) the reminder-
 *     link layer
 *   * source canonicalization — the `source` enum is now explicit, and
 *     every internal write that's not user-attributable is stamped
 *     before it hits the store
 *
 * The Tier 1 Tasks Core (`cores/free/tasks`) writes through the SAME
 * store via `buildSubstrateTaskStoreBackend` (PR #155 R2). One source
 * of truth across surfaces.
 */

import { randomUUID } from 'node:crypto'
import type { ProjectDb } from '../persistence/index.ts'
import { computeFocusScore } from './focus-score.ts'

/**
 * Task lifecycle states.
 *
 * P6.0 ships the minimal-viable enum. The engineering plan
 * (§ B.P6) names additional states (`archived`, `snoozed`) that depend
 * on the staleness engine + snooze UX; those land in later P6 sprints
 * via a forward-only ALTER + new CHECK CASE in a follow-up migration.
 */
export type TaskStatus = 'open' | 'done' | 'cancelled'

export const ALL_TASK_STATUSES: ReadonlyArray<TaskStatus> = [
  'open',
  'done',
  'cancelled',
]

/**
 * Status filter accepted by `TaskStore.list`. `'all'` returns every row
 * regardless of status — the launcher / app default to `'open'`, while
 * the projection generator reads `'all'` to render a full STATUS.md
 * snapshot.
 */
export type TaskStatusFilter = TaskStatus | 'all'

/**
 * Empty-string sentinel for "task is not scoped to any project." Keeps
 * the project-scoping index dense (NOT NULL DEFAULT '') and avoids a
 * NULL branch in every query.
 */
export const NO_PROJECT: '' = ''

/**
 * Sort order for `TaskStore.list`.
 *
 *   - `'default'` keeps the P6.0 ordering (open-first, then dated
 *     ASC, then dateless newest-first; non-open by completed_at/
 *     updated_at DESC). The Expo client and the Tasks Core's launcher
 *     surface bind to this ordering today.
 *   - `'focus_score'` is the **prioritized** ordering. It sorts open
 *     rows by the LLM-primary rank first (`llm_rank ASC NULLS LAST`,
 *     stamped by `tasks/prioritize-llm.ts`), falling back to the
 *     deterministic `focus_score DESC NULLS LAST, due_date ASC NULLS
 *     LAST, created_at DESC` for rows the last prioritize pass hasn't
 *     reached (and for instances with no LLM credential, where the
 *     prioritize pass writes `llm_rank` from the focus order anyway).
 *     The HTTP surfaces, the Tasks Core, and the projection layer all
 *     request this order, so the LLM-primary ranking flows to every
 *     rendered task list without each caller opting in separately
 *     (WAVE 3 PR-7). The name stays `'focus_score'` for back-compat.
 */
export type TaskOrder = 'default' | 'focus_score'

export const ALL_TASK_ORDERS: ReadonlyArray<TaskOrder> = ['default', 'focus_score']

/**
 * Canonical source vocabulary for the `source` column.
 *
 * Every NEW write should stamp one of these. Legacy rows with a NULL
 * source are tolerated — the projection layer treats null as
 * `'unknown'` and surfaces them under `### Active` without a source
 * tag.
 *
 * `chat` is reserved — the chat agent's MCP-tool invocation envelope
 * doesn't yet stamp `source` (the Tasks Core adapter pins everything
 * to `'@neutronai/tasks-core'` regardless of caller). Promote when the
 * envelope grows a caller-tag.
 */
export const TASK_SOURCE_APP = 'app' as const
export const TASK_SOURCE_TASKS_CORE = '@neutronai/tasks-core' as const
export const TASK_SOURCE_REMINDER = 'reminder' as const
export const TASK_SOURCE_OVERNIGHT = 'overnight' as const
export const TASK_SOURCE_HISTORY_IMPORT = 'history-import' as const
export const TASK_SOURCE_CHAT = 'chat' as const

export interface Task {
  id: string
  project_slug: string
  /** Empty string (`NO_PROJECT`) means instance-level / no project. */
  project_id: string
  title: string
  description: string | null
  status: TaskStatus
  /** 0-3; 0 = none, 3 = highest. Null when no priority is set. */
  priority: number | null
  /** ISO-8601 string (sortable, reminder-integration-friendly). */
  due_date: string | null
  owner_persona: string | null
  /** Where the task came from — see `TASK_SOURCE_*` constants. */
  source: string | null
  /** Deterministic focus score (`tasks/focus-score.ts`). Null = pre-cron. */
  focus_score: number | null
  /** ISO-8601 UTC; null until first score-affecting mutation or cron. */
  focus_score_updated_at: string | null
  /**
   * 1-based rank from the most recent LLM-primary prioritize pass
   * (`tasks/prioritize-llm.ts`; 1 = do first). Null on a row created
   * since the last pass — the `focus_score` order treats null as
   * "rank last, fall back to focus_score". Migration 0085.
   */
  llm_rank: number | null
  /** LLM's one-line rationale for the rank. Null in the deterministic fallback. */
  llm_reason: string | null
  /** Which mechanism produced the current rank. Null until first pass. */
  prioritized_by: 'llm' | 'deterministic' | null
  /** ISO-8601 UTC of the prioritize pass that stamped this row. */
  prioritized_at: string | null
  /** ISO-8601 UTC, stamped at insert. */
  created_at: string
  /** ISO-8601 UTC, stamped on every mutation. */
  updated_at: string
  /** ISO-8601 UTC; populated when status transitions to 'done'. */
  completed_at: string | null
}

export interface CreateTaskInput {
  /** Optional caller-supplied id; UUID v4 generated if absent. */
  id?: string
  project_slug: string
  /** Defaults to `NO_PROJECT` (empty string). */
  project_id?: string
  title: string
  description?: string | null
  priority?: number | null
  /** ISO-8601 string. */
  due_date?: string | null
  owner_persona?: string | null
  source?: string | null
}

export interface UpdateTaskFields {
  title?: string
  description?: string | null
  project_id?: string
  priority?: number | null
  due_date?: string | null
  owner_persona?: string | null
  source?: string | null
  status?: TaskStatus
}

export interface ListTasksInput {
  project_slug: string
  /**
   * Project filter. Omit (or pass `undefined`) for "every project";
   * pass `NO_PROJECT` for "only unprojected tasks"; pass a project id
   * for that project's rows.
   */
  project_id?: string
  /** Default: `'open'`. Pass `'all'` for every status. */
  status?: TaskStatusFilter
  /** Default: `'default'`. Pass `'focus_score'` for the Focus ordering. */
  order?: TaskOrder
  limit?: number
  /**
   * Skip this many rows from the start of the ordered result set
   * before applying `limit`. Used by the P5.5 Focus aggregator
   * (`gateway/http/app-focus-surface.ts`) to page-walk open tasks
   * across all projects without materializing the whole backlog in
   * memory. Default 0.
   */
  offset?: number
}

interface TaskDbRow {
  id: string
  project_slug: string
  project_id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: number | null
  due_date: string | null
  owner_persona: string | null
  source: string | null
  focus_score: number | null
  focus_score_updated_at: string | null
  llm_rank: number | null
  llm_reason: string | null
  prioritized_by: 'llm' | 'deterministic' | null
  prioritized_at: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

const COLS =
  'id, project_slug, project_id, title, description, status, priority, due_date, owner_persona, source, focus_score, focus_score_updated_at, llm_rank, llm_reason, prioritized_by, prioritized_at, created_at, updated_at, completed_at'

const DEFAULT_LIST_LIMIT = 100

/**
 * The five mutation kinds the store emits as events. Subscribers receive
 * the post-mutation row (or the pre-delete row for `'delete'`); the
 * `kind` lets a subscriber tell apart "score may have changed" from
 * "row deleted".
 */
export type TaskMutationKind =
  | 'create'
  | 'update'
  | 'complete'
  | 'cancel'
  | 'delete'

export interface TaskMutationEvent {
  kind: TaskMutationKind
  /** Post-mutation row for create/update/complete/cancel; pre-delete row for delete. */
  task: Task
  /** Pre-mutation row, present for update/complete/cancel/delete. */
  previous?: Task
}

export type TaskMutationListener = (event: TaskMutationEvent) => void | Promise<void>

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
 * Canonical task store backed by the per-instance `tasks` table
 * (migrations 0032 + 0037). All reads filter by `project_slug`; project
 * scoping is layered on top via `project_id`.
 *
 * Write paths stamp `updated_at` on every mutation and ratchet
 * `completed_at` when `status` flips to / from `'done'` (re-opening a
 * completed task clears `completed_at` again — matches the launcher's
 * un-check semantics on the Tier 1 Tasks Core).
 *
 * `focus_score` is stamped synchronously on every score-affecting write
 * (`create`, and `update` calls that touch `priority` or `due_date`).
 * The 4-hourly cron handler (`tasks/focus-score-cron.ts`) re-converges
 * the score across all open rows so the staleness + overdue components
 * stay current even when no mutation fired.
 *
 * Subscribers attached via `subscribe(...)` receive a `TaskMutationEvent`
 * after every successful create / update / complete / cancel / delete.
 * Listener exceptions are caught + logged so one bad subscriber does NOT
 * block the others or roll back the underlying write.
 */
export class TaskStore {
  private readonly listeners: TaskMutationListener[] = []

  constructor(private readonly db: ProjectDb) {}

  /**
   * Subscribe to subsequent successful mutations on this store
   * instance. Returns an unsubscribe function. Idempotent w.r.t.
   * duplicate listeners — passing the same function twice fires it
   * twice on each mutation; callers wanting de-dup should hold their
   * own bookkeeping.
   *
   * Listeners run synchronously after the write commits. Their
   * exceptions are caught + logged via `console.warn`; the underlying
   * mutation is NOT rolled back.
   */
  subscribe(listener: TaskMutationListener): () => void {
    this.listeners.push(listener)
    return () => {
      const idx = this.listeners.indexOf(listener)
      if (idx >= 0) this.listeners.splice(idx, 1)
    }
  }

  private async emit(event: TaskMutationEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        const result = listener(event)
        if (result instanceof Promise) {
          await result
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[task-store] listener threw on ${event.kind} ${event.task.id}: ${msg}`,
        )
      }
    }
  }

  async create(input: CreateTaskInput): Promise<Task> {
    const id = input.id ?? randomUUID()
    const ts = nowIso()
    const project_id = input.project_id ?? NO_PROJECT
    const description = input.description ?? null
    const priority = input.priority ?? null
    const due_date = input.due_date ?? null
    const owner_persona = input.owner_persona ?? null
    const source = input.source ?? null

    // Stamp the focus score synchronously so the post-create row is
    // consistent without waiting for the cron tick. The cron is the
    // convergence guarantee, not the only write path.
    const focus_score = computeFocusScore({
      priority,
      due_date,
      updated_at: ts,
      now: new Date(ts),
    })
    const focus_score_updated_at = ts

    await this.db.run(
      `INSERT INTO tasks
         (id, project_slug, project_id, title, description, status, priority, due_date, owner_persona, source, focus_score, focus_score_updated_at, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id,
        input.project_slug,
        project_id,
        input.title,
        description,
        priority,
        due_date,
        owner_persona,
        source,
        focus_score,
        focus_score_updated_at,
        ts,
        ts,
      ],
    )

    const row: Task = {
      id,
      project_slug: input.project_slug,
      project_id,
      title: input.title,
      description,
      status: 'open',
      priority,
      due_date,
      owner_persona,
      source,
      focus_score,
      focus_score_updated_at,
      // A freshly-created task has no LLM ranking yet — the next
      // prioritize pass (`tasks/prioritize-llm.ts`) stamps these; until
      // then the `focus_score` order sorts it via the focus_score fallback.
      llm_rank: null,
      llm_reason: null,
      prioritized_by: null,
      prioritized_at: null,
      created_at: ts,
      updated_at: ts,
      completed_at: null,
    }
    await this.emit({ kind: 'create', task: row })
    return row
  }

  get(id: string): Task | null {
    const row = this.db
      .prepare<TaskDbRow, [string]>(
        `SELECT ${COLS} FROM tasks WHERE id = ?`,
      )
      .get(id)
    return row === null ? null : rowToTask(row)
  }

  /**
   * List tasks for an instance.
   *
   * Default sort (`order='default'`):
   *   1. Open tasks first. Within open:
   *      a. Tasks with a `due_date` ascending (soonest-due first).
   *      b. Tasks without a `due_date` after, newest-first.
   *   2. Then done tasks, newest-completed first (`completed_at` DESC).
   *   3. Then cancelled tasks, newest-updated first (`updated_at` DESC).
   *
   * Focus sort (`order='focus_score'`):
   *   `focus_score DESC NULLS LAST, due_date ASC NULLS LAST, created_at DESC`
   *   — opt-in for the Focus aggregator and projection layer. Tasks
   *   with null focus_score sort last (graceful degradation for rows
   *   created since the last cron tick).
   */
  list(input: ListTasksInput): Task[] {
    const limit = input.limit ?? DEFAULT_LIST_LIMIT
    const offset = input.offset ?? 0
    const status = input.status ?? 'open'
    const order = input.order ?? 'default'

    const whereClauses: string[] = ['project_slug = ?']
    const params: Array<string> = [input.project_slug]

    if (input.project_id !== undefined) {
      whereClauses.push('project_id = ?')
      params.push(input.project_id)
    }
    if (status !== 'all') {
      whereClauses.push('status = ?')
      params.push(status)
    }

    const where = whereClauses.join(' AND ')

    const orderBy = order === 'focus_score'
      ? `
        CASE WHEN llm_rank IS NULL THEN 1 ELSE 0 END ASC,
        llm_rank ASC,
        CASE WHEN focus_score IS NULL THEN 1 ELSE 0 END ASC,
        focus_score DESC,
        CASE WHEN due_date IS NULL THEN 1 ELSE 0 END ASC,
        due_date ASC,
        created_at DESC`
      : `
        CASE WHEN status = 'open' THEN 0 ELSE 1 END ASC,
        CASE WHEN status = 'open' AND due_date IS NULL THEN 1 ELSE 0 END ASC,
        CASE WHEN status = 'open' THEN due_date END ASC,
        completed_at DESC,
        updated_at DESC,
        created_at DESC`

    const sql = `
      SELECT ${COLS}
        FROM tasks
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?
    `

    return this.db
      .prepare<TaskDbRow, Array<string | number>>(sql)
      .all(...params, limit, offset)
      .map(rowToTask)
  }

  /**
   * Patch fields on an existing task. `status` transitions are
   * mirrored into `completed_at`:
   *   * → 'done'     → stamp `completed_at = updated_at`
   *   * 'done' → X   → clear `completed_at`
   *
   * Recomputes `focus_score` synchronously when `priority` or `due_date`
   * actually changed; the cron does the time-based convergence later.
   *
   * Throws `TaskNotFoundError` if the id is unknown.
   */
  async update(id: string, fields: UpdateTaskFields): Promise<Task> {
    const before = this.get(id)
    if (before === null) throw new TaskNotFoundError(id)
    const ts = nowIso()

    const sets: string[] = ['updated_at = ?']
    const params: Array<string | number | null> = [ts]

    if (fields.title !== undefined) {
      sets.push('title = ?')
      params.push(fields.title)
    }
    if (fields.description !== undefined) {
      sets.push('description = ?')
      params.push(fields.description)
    }
    if (fields.project_id !== undefined) {
      sets.push('project_id = ?')
      params.push(fields.project_id)
    }
    if (fields.priority !== undefined) {
      sets.push('priority = ?')
      params.push(fields.priority)
    }
    if (fields.due_date !== undefined) {
      sets.push('due_date = ?')
      params.push(fields.due_date)
    }
    if (fields.owner_persona !== undefined) {
      sets.push('owner_persona = ?')
      params.push(fields.owner_persona)
    }
    if (fields.source !== undefined) {
      sets.push('source = ?')
      params.push(fields.source)
    }
    if (fields.status !== undefined) {
      sets.push('status = ?')
      params.push(fields.status)
      if (fields.status === 'done' && before.status !== 'done') {
        // Open → done (first completion): stamp completed_at.
        // If the task is already done, leave completed_at alone so
        // redundant `status: 'done'` payloads (e.g. an edit that
        // echoes the current status back) don't reset the timestamp.
        sets.push('completed_at = ?')
        params.push(ts)
      } else if (fields.status !== 'done' && before.status === 'done') {
        // Done → open / cancelled: clear completed_at to honour the
        // invariant that completed_at is populated only while status='done'.
        sets.push('completed_at = NULL')
      }
    }

    // Synchronously refresh focus_score when a score-affecting field
    // changed. We compute against the merged post-update view of
    // (priority, due_date, updated_at).
    const priorityChanged =
      fields.priority !== undefined && fields.priority !== before.priority
    const dueDateChanged =
      fields.due_date !== undefined && fields.due_date !== before.due_date
    if (priorityChanged || dueDateChanged) {
      const nextPriority = fields.priority !== undefined ? fields.priority : before.priority
      const nextDueDate = fields.due_date !== undefined ? fields.due_date : before.due_date
      const score = computeFocusScore({
        priority: nextPriority,
        due_date: nextDueDate,
        updated_at: ts,
        now: new Date(ts),
      })
      sets.push('focus_score = ?')
      params.push(score)
      sets.push('focus_score_updated_at = ?')
      params.push(ts)
    }

    params.push(id)
    await this.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params)

    const after = this.get(id)
    if (after === null) throw new TaskNotFoundError(id)
    await this.emit({ kind: 'update', task: after, previous: before })
    return after
  }

  /**
   * Mark a task done. Idempotent: completing an already-done task
   * leaves `completed_at` at the FIRST completion's timestamp (matches
   * the audit-trail expectation that `completed_at` is "when this
   * actually finished" not "when the latest re-complete fired"). Throws
   * `TaskNotFoundError` if the id is unknown.
   */
  async complete(id: string): Promise<Task> {
    const before = this.get(id)
    if (before === null) throw new TaskNotFoundError(id)
    if (before.status === 'done') {
      return before
    }
    const ts = nowIso()
    await this.db.run(
      `UPDATE tasks
          SET status = 'done', completed_at = ?, updated_at = ?
        WHERE id = ? AND status != 'done'`,
      [ts, ts, id],
    )
    const after = this.get(id)
    if (after === null) throw new TaskNotFoundError(id)
    await this.emit({ kind: 'complete', task: after, previous: before })
    return after
  }

  /**
   * Mark a task cancelled. Idempotent on already-cancelled rows.
   *
   * When cancelling a previously-done task, `completed_at` is cleared
   * so downstream readers can distinguish "completed" (status='done',
   * completed_at populated) from "completed-then-cancelled"
   * (status='cancelled', completed_at NULL). The file-level invariant
   * is that completed_at is non-NULL only while status='done'.
   *
   * Throws `TaskNotFoundError` if the id is unknown.
   */
  async cancel(id: string): Promise<Task> {
    const before = this.get(id)
    if (before === null) throw new TaskNotFoundError(id)
    if (before.status === 'cancelled') {
      return before
    }
    const ts = nowIso()
    await this.db.run(
      `UPDATE tasks
          SET status = 'cancelled', completed_at = NULL, updated_at = ?
        WHERE id = ? AND status != 'cancelled'`,
      [ts, id],
    )
    const after = this.get(id)
    if (after === null) throw new TaskNotFoundError(id)
    await this.emit({ kind: 'cancel', task: after, previous: before })
    return after
  }

  /**
   * Hard-delete a task. Throws `TaskNotFoundError` if the id is
   * unknown — the launcher's "delete" button collapses through this,
   * and cancellation (a softer state change) is `cancel()`.
   *
   * Subscribers run BEFORE the SQL DELETE so they can sweep linked
   * state (cancel the reminder, record the projection write) while
   * referential rows still exist. The FK ON DELETE CASCADE then
   * removes link rows once the task row is gone.
   */
  async delete(id: string): Promise<void> {
    const before = this.get(id)
    if (before === null) throw new TaskNotFoundError(id)
    await this.emit({ kind: 'delete', task: before, previous: before })
    await this.db.run('DELETE FROM tasks WHERE id = ?', [id])
  }
}

function rowToTask(row: TaskDbRow): Task {
  return {
    id: row.id,
    project_slug: row.project_slug,
    project_id: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    due_date: row.due_date,
    owner_persona: row.owner_persona,
    source: row.source,
    focus_score: row.focus_score,
    focus_score_updated_at: row.focus_score_updated_at,
    llm_rank: row.llm_rank,
    llm_reason: row.llm_reason,
    prioritized_by: row.prioritized_by,
    prioritized_at: row.prioritized_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  }
}

function nowIso(): string {
  return new Date().toISOString()
}
