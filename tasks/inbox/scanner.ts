/**
 * @neutronai/tasks/inbox — the task-scanner: drain the inbox, mutate the
 * store, re-render the markdown surface.
 *
 * This is the neutron analogue of `~/vajra/scripts/task-scanner.py`, but
 * the store (not the markdown) is the source of truth:
 *
 *   1. Read `task-inbox.jsonl`, parse every line (`parseInbox`).
 *   2. Apply each row to the `TaskStore` (`applyInboxRows`).
 *   3. Archive every processed row + its outcome to
 *      `task-inbox.archive.jsonl` (append-only audit log).
 *   4. Truncate the inbox — but only the bytes we actually consumed, so
 *      rows appended concurrently during the scan survive to the next
 *      run (byte-prefix check; see `truncateInbox`).
 *   5. Re-render `tasks.md` + `DASHBOARD.md` from the post-mutation
 *      store state (atomic writes).
 *
 * Designed to be driven by a cron tick (mirroring the focus-score
 * recompute cron) OR invoked ad-hoc. Path resolution is injected so the
 * scanner is testable and composition can wire the real
 * `<NEUTRON_HOME>` project-folder paths.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteFile } from '../../runtime/atomic-write.ts'
import type { TaskStore } from '../store.ts'
import { applyInboxRows, listAllTasks, type ApplyOutcome } from './apply.ts'
import { renderDashboardMarkdown, renderTasksMarkdown } from './render.ts'
import {
  parseInbox,
  type InboxAction,
  type ParseError,
  type PriorityTag,
} from './types.ts'

/** The four files the markdown surface lives in. */
export interface TaskScanPaths {
  /** The append-queue the scanner drains. */
  inbox: string
  /** Append-only audit log of processed rows + outcomes. */
  archive: string
  /** Rendered flat task view. */
  tasks_md: string
  /** Rendered focus-scored dashboard. */
  dashboard: string
}

export interface RunTaskScanDeps {
  store: TaskStore
  project_slug: string
  paths: TaskScanPaths
  /** Injected clock (defaults to `new Date()`). */
  now?: () => Date
  /** Done-tail window for the rendered surfaces. */
  done_window_days?: number
}

export interface TaskScanResult {
  processed: number
  applied: number
  skipped: number
  errored: number
  parse_errors: number
  /** Open-task count after the scan (what landed in the markdown Active list). */
  active_count: number
  outcomes: ApplyOutcome[]
  tasks_md_path: string
  dashboard_path: string
}

/** A row the caller appends to the inbox. Loose human-facing forms. */
export interface InboxAppendInput {
  action: InboxAction
  id?: string
  project?: string
  title?: string
  /** `P0`..`P3` mnemonic or a bare 0..3 storage int. */
  priority?: PriorityTag | number | null
  /** `YYYY-MM-DD` or full ISO. */
  due?: string | null
  notes?: string | null
  source?: string | null
}

/**
 * Append one intent to the inbox queue. Atomic per line via `O_APPEND`
 * (a single `appendFileSync` is one `write(2)`), so concurrent
 * appenders never interleave a partial line. Creates the parent dir on
 * first use.
 */
export function appendInboxRow(inboxPath: string, input: InboxAppendInput): void {
  mkdirSync(dirname(inboxPath), { recursive: true })
  // JSON.stringify drops `undefined` fields; `null` survives (explicit clear).
  const line = JSON.stringify(input) + '\n'
  appendFileSync(inboxPath, line, { mode: 0o600 })
}

function readIfExists(path: string): string {
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8')
}

/**
 * Remove the bytes we consumed (`consumedBody`) from the front of the
 * inbox, preserving anything appended during the scan. If the current
 * file no longer starts with what we read (a concurrent rewrite, not a
 * plain append), we leave it untouched — re-processing is safe because
 * `add` is idempotent on a stable id and edit-ops on missing rows skip.
 */
async function truncateInbox(inboxPath: string, consumedBody: string): Promise<void> {
  if (consumedBody === '') return
  const current = readIfExists(inboxPath)
  if (!current.startsWith(consumedBody)) return
  const remainder = current.slice(consumedBody.length)
  await atomicWriteFile(inboxPath, remainder, { mode: 0o600 })
}

function archiveLine(record: Record<string, unknown>): string {
  return JSON.stringify(record) + '\n'
}

function appendArchive(
  archivePath: string,
  nowIso: string,
  outcomes: ApplyOutcome[],
  parseErrors: ParseError[],
): void {
  if (outcomes.length === 0 && parseErrors.length === 0) return
  mkdirSync(dirname(archivePath), { recursive: true })
  const lines: string[] = []
  for (const o of outcomes) {
    const rec: Record<string, unknown> = {
      processed_at: nowIso,
      status: o.status,
      action: o.row.action,
      raw: o.row.raw,
    }
    if (o.task_id !== undefined) rec['task_id'] = o.task_id
    if (o.reason !== undefined) rec['reason'] = o.reason
    lines.push(archiveLine(rec))
  }
  for (const e of parseErrors) {
    lines.push(
      archiveLine({
        processed_at: nowIso,
        status: 'parse_error',
        line: e.line,
        message: e.message,
        raw: e.raw,
      }),
    )
  }
  appendFileSync(archivePath, lines.join(''), { mode: 0o600 })
}

/**
 * Run one full scan cycle. Idempotent end-to-end: rendering reflects the
 * post-mutation store state, and the inbox is truncated by the exact
 * bytes consumed so a re-run never double-applies an already-drained
 * queue.
 */
export async function runTaskScan(deps: RunTaskScanDeps): Promise<TaskScanResult> {
  // 1. Read + parse the queue (snapshot the exact bytes we consume).
  // Snapshot the bytes FIRST; the clock is sampled after so the
  // consumed-byte set is fixed before any concurrent appender can grow
  // the file (the truncate then preserves only those later appends).
  const consumedBody = readIfExists(deps.paths.inbox)
  const now = deps.now?.() ?? new Date()
  const nowIso = now.toISOString()
  const { rows, errors } = parseInbox(consumedBody)

  // 2. Apply every parsed row to the store, in order.
  const outcomes = await applyInboxRows(
    { store: deps.store, project_slug: deps.project_slug },
    rows,
  )

  // 3. Archive processed rows + parse errors (audit trail).
  appendArchive(deps.paths.archive, nowIso, outcomes, errors)

  // 4. Drain the consumed bytes from the inbox (keep concurrent appends).
  await truncateInbox(deps.paths.inbox, consumedBody)

  // 5. Re-render the markdown surface from post-mutation store state.
  const allTasks = listAllTasks({ store: deps.store, project_slug: deps.project_slug })
  const tasksMd = renderTasksMarkdown({
    tasks: allTasks,
    now,
    ...(deps.done_window_days !== undefined && {
      done_window_days: deps.done_window_days,
    }),
  })
  const dashboard = renderDashboardMarkdown({
    tasks: allTasks,
    now,
    ...(deps.done_window_days !== undefined && {
      done_window_days: deps.done_window_days,
    }),
  })
  await atomicWriteFile(deps.paths.tasks_md, tasksMd, { mode: 0o600 })
  await atomicWriteFile(deps.paths.dashboard, dashboard, { mode: 0o600 })

  const applied = outcomes.filter((o) => o.status === 'applied').length
  const skipped = outcomes.filter((o) => o.status === 'skipped').length
  const errored = outcomes.filter((o) => o.status === 'errored').length
  const activeCount = allTasks.filter((t) => t.status === 'open').length

  return {
    processed: outcomes.length,
    applied,
    skipped,
    errored,
    parse_errors: errors.length,
    active_count: activeCount,
    outcomes,
    tasks_md_path: deps.paths.tasks_md,
    dashboard_path: deps.paths.dashboard,
  }
}
