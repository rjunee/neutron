/**
 * @neutronai/tasks/inbox — the task-scanner: drain the inbox, mutate the
 * store, re-render the markdown surface.
 *
 * This is the neutron analogue of `~/vajra/scripts/task-scanner.py`, but
 * the store (not the markdown) is the source of truth:
 *
 *   1. CLAIM the queue (`claimInbox`): atomically `rename`
 *      `task-inbox.jsonl` to a `.processing` sidecar and read it. A
 *      concurrent appender always targets `task-inbox.jsonl`, so anything
 *      opened after the rename lands in a freshly-recreated inbox the NEXT
 *      scan drains; anything opened before but written during the apply
 *      window is recovered by the late-write guard in step 5. If a
 *      `.processing` sidecar already exists (a crashed prior scan), drain
 *      THAT first and let the live inbox wait one cycle — at most one
 *      sidecar exists at a time, so leftover rows are never clobbered.
 *   2. Parse every claimed line (`parseInbox`).
 *   3. Apply each row to the `TaskStore` (`applyInboxRows`).
 *   4. Archive every processed row + its outcome to
 *      `task-inbox.archive.jsonl` (append-only audit log).
 *   5. Re-render `tasks.md` + `DASHBOARD.md` from the post-mutation store
 *      state (atomic writes), then `finalizeProcessing`: requeue any late
 *      writes to the rotated inode and delete the sidecar. A crash before
 *      that delete is recovered on the next scan; reprocessing is safe
 *      because every `add` row carries a stable id (stamped at append) so
 *      replay collides on the PK and skips, and edit-ops on missing rows
 *      skip.
 *
 * Designed to be driven by a cron tick (mirroring the focus-score
 * recompute cron) OR invoked ad-hoc. Path resolution is injected so the
 * scanner is testable and composition can wire the real
 * `<NEUTRON_HOME>` project-folder paths.
 */

import { randomUUID } from 'node:crypto'
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
 * (a single `appendFileSync` is one `write(2)`), so concurrent appenders
 * never interleave a partial line. Creates the parent dir on first use.
 *
 * An `add` row with no caller-supplied `id` gets a stable UUID stamped
 * HERE, at append time, so the persisted row carries an id from the
 * moment it lands on disk. That makes crash recovery idempotent: if a
 * scan applies the row then dies before clearing the sidecar, replay
 * collides on the primary key and is skipped instead of creating a
 * duplicate task (a randomly-id'd `TaskStore.create` would otherwise
 * double-insert).
 */
export function appendInboxRow(inboxPath: string, input: InboxAppendInput): void {
  mkdirSync(dirname(inboxPath), { recursive: true })
  const row: InboxAppendInput =
    input.action === 'add' && input.id === undefined
      ? { ...input, id: randomUUID() }
      : input
  // JSON.stringify drops `undefined` fields; `null` survives (explicit clear).
  const line = JSON.stringify(row) + '\n'
  appendFileSync(inboxPath, line, { mode: 0o600 })
}

/** The in-flight sidecar an inbox is rotated to while a scan drains it. */
function processingPathFor(inboxPath: string): string {
  return `${inboxPath}.processing`
}

interface ClaimedInbox {
  body: string
  /** Bytes read from the sidecar at claim time (for the late-write guard). */
  baselineBytes: number
  /** True when we rotated the live inbox this scan (vs. draining a leftover). */
  rotated: boolean
}

/**
 * Claim the queue for processing and return its contents. At most ONE
 * sidecar exists at a time, which keeps crash recovery simple + lossless:
 *
 *   - If a `.processing` sidecar already exists, it's a leftover from a
 *     crashed scan. Drain THAT first (its rows replay idempotently — see
 *     `appendInboxRow`); the live inbox waits one cycle. We do NOT rotate
 *     this scan, so we never clobber un-committed leftover rows.
 *   - Otherwise atomically `rename` the live inbox to the sidecar. The
 *     rename claims a consistent snapshot in one step: appenders always
 *     target `inboxPath`, so anything opened after the rename lands in a
 *     freshly-recreated inbox the next scan drains. Anything opened
 *     before the rename but written after our read is caught by the
 *     late-write guard in `finalizeProcessing`.
 *
 * Returns null when there is nothing to do.
 */
function claimInbox(inboxPath: string): ClaimedInbox | null {
  const processingPath = processingPathFor(inboxPath)
  if (existsSync(processingPath)) {
    const body = readFileSync(processingPath, 'utf8')
    return { body, baselineBytes: Buffer.byteLength(body, 'utf8'), rotated: false }
  }
  if (!existsSync(inboxPath)) return null
  renameSync(inboxPath, processingPath)
  const body = readFileSync(processingPath, 'utf8')
  return { body, baselineBytes: Buffer.byteLength(body, 'utf8'), rotated: true }
}

/**
 * Commit the scan: requeue any rows an appender wrote to the rotated
 * inode AFTER our claim-time read (a pre-rename-opened fd writing during
 * the multi-step apply window), then delete the sidecar.
 *
 * The guard re-reads the sidecar and, if it grew past the claim-time
 * baseline, copies the new tail back onto the live inbox so the next
 * scan picks it up — no loss across the entire apply window. A residual
 * sub-syscall window remains (a write landing strictly between this
 * re-read and the unlink); for the expected single-scanner,
 * human/agent-cadence usage that is acceptable, and a crash there simply
 * defers those rows to the next scan via the leftover-sidecar path.
 */
function finalizeProcessing(inboxPath: string, claim: ClaimedInbox): void {
  const processingPath = processingPathFor(inboxPath)
  try {
    if (claim.rotated) {
      const latest = readFileSync(processingPath)
      if (latest.length > claim.baselineBytes) {
        const tail = latest.subarray(claim.baselineBytes).toString('utf8')
        if (tail.length > 0) appendFileSync(inboxPath, tail, { mode: 0o600 })
      }
    }
  } catch {
    /* re-read best-effort; fall through to unlink */
  }
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
 * post-mutation store state, and the queue is claimed via an atomic
 * rotate so a re-run never double-applies an already-drained queue.
 */
export async function runTaskScan(deps: RunTaskScanDeps): Promise<TaskScanResult> {
  // 1. Claim the queue (atomic rotate, or drain a crashed leftover), then
  // parse it. A null claim (nothing pending) still re-renders below so a
  // bare cron tick refreshes the time-sensitive focus ordering.
  const claim = claimInbox(deps.paths.inbox)
  const now = deps.now?.() ?? new Date()
  const nowIso = now.toISOString()
  const { rows, errors } = claim === null
    ? { rows: [], errors: [] }
    : parseInbox(claim.body)

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

  // 5. Commit: requeue any late writes to the rotated inode, then drop
  // the sidecar now the store + markdown are both durable. A crash before
  // here leaves the sidecar for the next scan to recover.
  if (claim !== null) finalizeProcessing(deps.paths.inbox, claim)

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
