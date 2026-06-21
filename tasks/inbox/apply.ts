/**
 * @neutronai/tasks/inbox — apply parsed inbox rows to the TaskStore.
 *
 * The store is the single source of truth (see `tasks/store.ts`); the
 * inbox is just an append-queue of intents. This module turns one
 * {@link InboxRow} into the matching `TaskStore` mutation and reports a
 * structured {@link ApplyOutcome} so the scanner can archive the row
 * with its result (applied / skipped / errored) for audit.
 *
 * Idempotency: an `add` row carrying a stable `id` collides on the
 * primary key when replayed, which we surface as `skipped:'duplicate'`
 * rather than an error — so a re-scan of an un-truncated queue is safe.
 */

import {
  NO_PROJECT,
  TaskNotFoundError,
  type CreateTaskInput,
  type Task,
  type TaskStore,
  type UpdateTaskFields,
} from '../store.ts'
import type { InboxRow } from './types.ts'

/** Provenance stamped on tasks created/edited via the inbox queue. */
export const TASK_SOURCE_INBOX = 'inbox' as const

export type ApplyStatus = 'applied' | 'skipped' | 'errored'

export interface ApplyOutcome {
  row: InboxRow
  status: ApplyStatus
  /** The affected task id, when known. */
  task_id?: string
  /** A short machine-readable reason for skip/error. */
  reason?: string
}

export interface ApplyDeps {
  store: TaskStore
  project_slug: string
}

/**
 * Resolve the task id an edit-style row (`complete` / `update` /
 * `cancel` / `delete`) targets. Prefers an explicit `id`; otherwise
 * locates the first OPEN task whose title matches exactly, scoped to
 * the row's project when given. Returns null when nothing matches.
 *
 * Both paths are scoped to `deps.project_slug`: `TaskStore`'s by-id
 * methods operate on a GLOBAL id (no slug filter), so an explicit id is
 * verified to belong to this scanner's slug before it's returned — a
 * scanner for one slug must never mutate another slug's task even if its
 * id leaks into this inbox.
 */
function resolveTaskId(deps: ApplyDeps, row: InboxRow): string | null {
  if (row.id !== undefined) {
    const task = deps.store.get(row.id)
    if (task === null || task.project_slug !== deps.project_slug) return null
    return task.id
  }
  if (row.title === undefined) return null
  const listInput: Parameters<TaskStore['list']>[0] = {
    project_slug: deps.project_slug,
    status: 'open',
    limit: 500,
  }
  if (row.project !== undefined) listInput.project_id = row.project
  const match = deps.store
    .list(listInput)
    .find((t) => t.title === row.title)
  return match?.id ?? null
}

/** Is this the SQLite UNIQUE/PK violation a replayed `add` id triggers? */
function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /unique|constraint|primary key/i.test(msg)
}

/**
 * Apply one inbox row to the store. Never throws — every failure is
 * captured in the returned {@link ApplyOutcome}.
 */
export async function applyInboxRow(
  deps: ApplyDeps,
  row: InboxRow,
): Promise<ApplyOutcome> {
  try {
    switch (row.action) {
      case 'add':
        return await applyAdd(deps, row)
      case 'complete':
        return await applyComplete(deps, row)
      case 'update':
        return await applyUpdate(deps, row)
      case 'cancel':
        return await applyCancel(deps, row)
      case 'delete':
        return await applyDelete(deps, row)
      default:
        return { row, status: 'errored', reason: `unknown action: ${row.action}` }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { row, status: 'errored', reason }
  }
}

async function applyAdd(deps: ApplyDeps, row: InboxRow): Promise<ApplyOutcome> {
  // `parseInbox` guarantees title is present for `add`.
  const input: CreateTaskInput = {
    project_slug: deps.project_slug,
    project_id: row.project ?? NO_PROJECT,
    title: row.title as string,
    source: row.source ?? TASK_SOURCE_INBOX,
  }
  if (row.id !== undefined) input.id = row.id
  if (row.priority !== undefined) input.priority = row.priority
  if (row.due_date !== undefined) input.due_date = row.due_date
  if (row.notes !== undefined) input.description = row.notes
  try {
    const task = await deps.store.create(input)
    return { row, status: 'applied', task_id: task.id }
  } catch (err) {
    if (isUniqueViolation(err)) {
      const dup: ApplyOutcome = { row, status: 'skipped', reason: 'duplicate' }
      if (row.id !== undefined) dup.task_id = row.id
      return dup
    }
    throw err
  }
}

async function applyComplete(deps: ApplyDeps, row: InboxRow): Promise<ApplyOutcome> {
  const id = resolveTaskId(deps, row)
  if (id === null) return { row, status: 'skipped', reason: 'not_found' }
  try {
    const task = await deps.store.complete(id)
    return { row, status: 'applied', task_id: task.id }
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      return { row, status: 'skipped', reason: 'not_found', task_id: id }
    }
    throw err
  }
}

async function applyUpdate(deps: ApplyDeps, row: InboxRow): Promise<ApplyOutcome> {
  const id = resolveTaskId(deps, row)
  if (id === null) return { row, status: 'skipped', reason: 'not_found' }
  const fields: UpdateTaskFields = {}
  // For `update`, a `title` is a NEW value only when an explicit id was
  // given; otherwise the title was used to LOCATE the row and must not
  // overwrite itself.
  if (row.id !== undefined && row.title !== undefined) fields.title = row.title
  if (row.project !== undefined) fields.project_id = row.project
  if (row.priority !== undefined) fields.priority = row.priority
  if (row.due_date !== undefined) fields.due_date = row.due_date
  if (row.notes !== undefined) fields.description = row.notes
  if (row.source !== undefined) fields.source = row.source
  if (Object.keys(fields).length === 0) {
    return { row, status: 'skipped', reason: 'no_fields', task_id: id }
  }
  try {
    const task = await deps.store.update(id, fields)
    return { row, status: 'applied', task_id: task.id }
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      return { row, status: 'skipped', reason: 'not_found', task_id: id }
    }
    throw err
  }
}

async function applyCancel(deps: ApplyDeps, row: InboxRow): Promise<ApplyOutcome> {
  const id = resolveTaskId(deps, row)
  if (id === null) return { row, status: 'skipped', reason: 'not_found' }
  try {
    const task = await deps.store.cancel(id)
    return { row, status: 'applied', task_id: task.id }
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      return { row, status: 'skipped', reason: 'not_found', task_id: id }
    }
    throw err
  }
}

async function applyDelete(deps: ApplyDeps, row: InboxRow): Promise<ApplyOutcome> {
  const id = resolveTaskId(deps, row)
  if (id === null) return { row, status: 'skipped', reason: 'not_found' }
  try {
    await deps.store.delete(id)
    return { row, status: 'applied', task_id: id }
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      return { row, status: 'skipped', reason: 'not_found', task_id: id }
    }
    throw err
  }
}

/** Apply a batch of rows in order, returning one outcome per row. */
export async function applyInboxRows(
  deps: ApplyDeps,
  rows: InboxRow[],
): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = []
  for (const row of rows) {
    outcomes.push(await applyInboxRow(deps, row))
  }
  return outcomes
}

/** Page size for {@link listAllTasks}. */
const LIST_PAGE_SIZE = 1000

/**
 * Pull EVERY task (any status) for the slug, focus-ordered — paging
 * through the store so the rendered markdown never silently drops tasks
 * past a fixed cap (an instance can hold more than one page of tasks).
 */
export function listAllTasks(deps: ApplyDeps): Task[] {
  const all: Task[] = []
  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const page = deps.store.list({
      project_slug: deps.project_slug,
      status: 'all',
      order: 'focus_score',
      limit: LIST_PAGE_SIZE,
      offset,
    })
    all.push(...page)
    if (page.length < LIST_PAGE_SIZE) break
  }
  return all
}
