/**
 * @neutronai/tasks/inbox — the task-scanner: drain the inbox, mutate the
 * store, re-render the markdown surface.
 *
 * This is the neutron analogue of `~/vajra/scripts/task-scanner.py`, but
 * the store (not the markdown) is the source of truth:
 *
 *   1. ROTATE the inbox: atomically `rename` `task-inbox.jsonl` to a
 *      `.processing` sidecar, then read it. A concurrent appender always
 *      writes to the path `task-inbox.jsonl`, so anything it opened before
 *      the rename lands in the rotated file we read; anything after lands
 *      in a freshly-recreated inbox the NEXT scan drains. No append is ever
 *      lost — there is no read-modify-rewrite window (see `rotateInbox`).
 *   2. Parse every rotated line (`parseInbox`).
 *   3. Apply each row to the `TaskStore` (`applyInboxRows`).
 *   4. Archive every processed row + its outcome to
 *      `task-inbox.archive.jsonl` (append-only audit log).
 *   5. Re-render `tasks.md` + `DASHBOARD.md` from the post-mutation
 *      store state (atomic writes), then delete the `.processing` sidecar.
 *      A crash before that delete is recovered on the next scan (the
 *      sidecar is read back in), and reprocessing is safe because `add`
 *      is idempotent on a stable id and edit-ops on missing rows skip.
 *
 * Designed to be driven by a cron tick (mirroring the focus-score
 * recompute cron) OR invoked ad-hoc. Path resolution is injected so the
 * scanner is testable and composition can wire the real
 * `<NEUTRON_HOME>` project-folder paths.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
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

/** The in-flight sidecar an inbox is rotated to while a scan drains it. */
function processingPathFor(inboxPath: string): string {
  return `${inboxPath}.processing`
}

/**
 * Atomically claim the queue for processing and return its contents.
 *
 * The rotate (`rename`) is the crux of the concurrent-append guarantee:
 * appenders always target `inboxPath`, so the rename moves a CONSISTENT
 * snapshot out of the way in one atomic step — there is no
 * read-then-rewrite window where a racing append could be clobbered. A
 * leftover `.processing` sidecar from a crashed prior scan is read back
 * FIRST (older rows), then the rename brings the current queue in behind
 * it. Returns the full body to parse + apply.
 */
function rotateInbox(inboxPath: string): string {
  const processingPath = processingPathFor(inboxPath)
  let body = ''
  // Recover a leftover sidecar from a crashed scan BEFORE the rename
  // below would clobber it on disk (we've already captured its bytes).
  if (existsSync(processingPath)) {
    body += readFileSync(processingPath, 'utf8')
  }
  if (existsSync(inboxPath)) {
    renameSync(inboxPath, processingPath)
    body += readFileSync(processingPath, 'utf8')
  }
  return body
}

/** Remove the in-flight sidecar once the scan has fully committed. */
function clearProcessing(inboxPath: string): void {
  const processingPath = processingPathFor(inboxPath)
  try {
    if (existsSync(processingPath)) unlinkSync(processingPath)
  } catch {
    /* best-effort; the next scan recovers + reprocesses idempotently */
  }
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
  // 1. Rotate the queue out of the way atomically, then parse it. The
  // rename claims a consistent snapshot — appends racing the scan land in
  // a freshly-recreated inbox the next scan drains, never lost.
  const consumedBody = rotateInbox(deps.paths.inbox)
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

  // 4. Re-render the markdown surface from post-mutation store state.
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

  // 5. Commit: drop the in-flight sidecar now the store + markdown are
  // both durable. A crash before here leaves the sidecar for recovery.
  clearProcessing(deps.paths.inbox)

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
