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

import { BusyRetryExhaustedError } from '../../persistence/index.ts'
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

/** Page size for the title-based task lookup in {@link resolveTaskId}. */
const TITLE_LOOKUP_PAGE_SIZE = 500

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
  // Page through open tasks so a title beyond the first page still
  // resolves (don't cap the lookup). Early-exit on the first exact match.
  for (let offset = 0; ; offset += TITLE_LOOKUP_PAGE_SIZE) {
    const listInput: Parameters<TaskStore['list']>[0] = {
      project_slug: deps.project_slug,
      status: 'open',
      limit: TITLE_LOOKUP_PAGE_SIZE,
      offset,
    }
    if (row.project !== undefined) listInput.project_id = row.project
    const page = deps.store.list(listInput)
    const match = page.find((t) => t.title === row.title)
    if (match !== undefined) return match.id
    if (page.length < TITLE_LOOKUP_PAGE_SIZE) return null
  }
}

/** Is this the SQLite UNIQUE/PK violation a replayed `add` id triggers? */
function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /unique|constraint|primary key/i.test(msg)
}

/**
 * Node IO error codes that signal a TRANSIENT environmental failure — the
 * write might succeed on a later scan once the condition clears (disk
 * freed, lock released, fd / quota available). Distinct from a
 * deterministic per-row rejection (a constraint/validation error), which
 * would re-fail identically every scan.
 */
const TRANSIENT_IO_CODES: ReadonlySet<string> = new Set([
  'ENOSPC', // no space left on device
  'EIO', // low-level I/O error
  'EACCES', // permission denied (e.g. a transient FS remount / readonly flip)
  'EPERM',
  'EAGAIN',
  'EBUSY',
  'EMFILE', // too many open fds (transient)
  'ENFILE',
  'EROFS', // filesystem went read-only on failure
  'EDQUOT', // disk quota exceeded
])

/** SQLite messages that map to disk/IO/contention, not row-level rejection. */
const TRANSIENT_SQLITE_PATTERNS: ReadonlyArray<RegExp> = [
  /disk i\/o error/i, // SQLITE_IOERR
  /database or disk is full/i, // SQLITE_FULL
  /database is locked/i, // SQLITE_BUSY (belt-and-suspenders; usually wrapped)
  /\bSQLITE_BUSY\b/i,
  /unable to open database/i, // SQLITE_CANTOPEN
]

/**
 * Should an exception escaping a store mutation ABORT the scan (so the
 * claimed rows stay in the sidecar for the next scan to retry) rather than
 * be recorded as a per-row `errored` outcome?
 *
 * TRUE only for plausibly-TRANSIENT infra failures: a busy-retry budget
 * exhaustion under sustained contention ({@link BusyRetryExhaustedError}
 * from `withBusyRetry`), or a disk/IO error. These may succeed on a later
 * scan, so the scanner must not advance past the row, archive it, or drop
 * the sidecar — doing so permanently loses a valid row.
 *
 * FALSE for everything else. A deterministic per-row rejection (an
 * unexpected constraint/validation error, or a programming bug) would
 * re-fail identically on every scan; aborting on it would LIVELOCK the
 * whole queue, because `claimInbox` always drains the sidecar before the
 * live inbox. Those are captured as `errored` and skipped — exactly the
 * pre-existing, non-blocking behavior — so one poison row can never wedge
 * the queue.
 */
export function isTransientStoreError(err: unknown): boolean {
  if (err instanceof BusyRetryExhaustedError) return true
  if (err === null || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && TRANSIENT_IO_CODES.has(code)) return true
  const message = (err as { message?: unknown }).message
  if (typeof message === 'string') {
    return TRANSIENT_SQLITE_PATTERNS.some((re) => re.test(message))
  }
  return false
}

/**
 * Apply one inbox row to the store.
 *
 * EXPECTED per-row outcomes are always captured in the returned
 * {@link ApplyOutcome} (never thrown): a replayed `add` id →
 * `skipped:duplicate`, an edit on a missing/foreign task →
 * `skipped:not_found`, an empty update → `skipped:no_fields`, an unknown
 * action → `errored`. A deterministic, unexpected per-row rejection (an
 * unanticipated constraint/validation error or programming bug) is also
 * captured as `errored` so a single poison row can never wedge the queue.
 *
 * A TRANSIENT store/infra failure ({@link isTransientStoreError} —
 * busy-retry exhaustion or a disk/IO error) is the ONE thing that THROWS:
 * it propagates so the scanner can ABORT the scan and leave the row in the
 * sidecar for the next scan to retry idempotently, rather than archiving an
 * `errored` outcome and silently dropping a valid row (see `drainClaimed` /
 * `finalizeProcessing` in `scanner.ts`).
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
    // Transient infra failure → re-throw so the scan ABORTS (no baseline
    // advance, no archive, sidecar left) and the next scan retries the row.
    if (isTransientStoreError(err)) throw err
    // Deterministic per-row failure → record + skip (non-blocking), so a
    // poison row is archived rather than livelocking the queue forever.
    const reason = err instanceof Error ? err.message : String(err)
    return { row, status: 'errored', reason }
  }
}

async function applyAdd(deps: ApplyDeps, row: InboxRow): Promise<ApplyOutcome> {
  // `parseInbox` guarantees title is present for `add`.
  //
  // Replay semantics: an `add` carrying an `id` is exactly-once — a replay
  // (e.g. crash between create and sidecar unlink) collides on the PK and
  // is skipped. `appendInboxRow` stamps an id on every id-less add, so the
  // blessed append API is always exactly-once. A row hand-written directly
  // to the JSONL with NO id is at-least-once: there is no content-derivable
  // id that both dedupes a replay AND still permits a future identical
  // re-add, so the scanner can't retroactively make it exactly-once. We
  // deliberately prefer this over losing rows — see `drainClaimed`, which
  // keeps the higher-severity loss case covered. Hand-editors who want
  // exactly-once include an `"id"`.
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

/**
 * Apply a batch of rows in order, returning one outcome per row. Propagates
 * a TRANSIENT store/infra error ({@link isTransientStoreError}) from the
 * offending row — earlier rows in the batch have already been applied (their
 * outcomes are discarded with the throw), but every apply is idempotent on
 * replay, so the scanner can safely abort and re-drain the whole claim next
 * scan. Deterministic per-row failures are captured as `errored`, not thrown.
 */
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
