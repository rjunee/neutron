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
 *      Any rows a pre-rename-opened fd appends to the sidecar DURING this
 *      apply window are drained IN ORDER within the same scan
 *      (`drainClaimed`), so a dependent `add`→`update` pair across the
 *      rotate boundary stays ordered.
 *   5. Re-render `tasks.md` + `DASHBOARD.md` from the post-mutation store
 *      state (atomic writes), then `finalizeProcessing`: requeue any
 *      residual past the inline drain and delete the sidecar. A crash
 *      before that delete is recovered on the next scan; reprocessing is
 *      safe because every `add` row carries a stable id (stamped at
 *      append) so replay collides on the PK and skips, and edit-ops on
 *      missing rows skip.
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

interface CompleteLineTail {
  /** The complete-line slice from `baseline` up to and including the last `\n`. */
  tail: string
  /** Byte offset to advance the baseline to (always a newline boundary). */
  nextBaseline: number
}

/**
 * Return the COMPLETE-LINE tail of `buf` past byte offset `baseline`:
 * everything from `baseline` up to and INCLUDING the last `\n`. A
 * concurrent appender (a pre-rename-held fd) can leave the sidecar ending
 * mid-line, so slicing purely by byte count (`subarray(baseline)`) could
 * hand a partial JSON line to the parser — recorded as a parse error and
 * its committed completion then recorded as a SECOND parse error, silently
 * losing the row. Snapping to the last newline guarantees we only ever
 * parse — and advance the baseline past — whole lines; any trailing
 * partial stays put for the next read/scan to complete. Returns null when
 * there is no complete new line past `baseline`.
 */
export function completeLineTail(buf: Buffer, baseline: number): CompleteLineTail | null {
  if (buf.length <= baseline) return null
  // 0x0a === '\n'. lastIndexOf scans the whole buffer; if the last newline
  // sits before our baseline, the bytes past baseline are only a partial line.
  const lastNewline = buf.lastIndexOf(0x0a)
  if (lastNewline < baseline) return null
  const nextBaseline = lastNewline + 1
  return { tail: buf.subarray(baseline, nextBaseline).toString('utf8'), nextBaseline }
}

interface Consumable {
  /** Bytes safe to apply/requeue past `baseline` (may be ''). */
  tail: string
  /** Byte offset consumed up to (start of any leftover partial). */
  nextBaseline: number
  /** Sidecar length the tail was sliced from (for the unlink growth guard). */
  length: number
  /** An actively-growing (in-flight) partial remains past `nextBaseline`. */
  partial: boolean
}

/**
 * Is `text` a SETTLED final JSONL row rather than an in-flight fragment?
 *
 * A trailing line without a terminating newline is either a complete row
 * hand-written with no closing newline OR a truncated mid-write from an
 * out-of-band fd that paused after a fragment. Timing cannot tell them
 * apart (a paused writer looks stable), but JSON STRUCTURE can: every row
 * the queue emits is a single-line JSON object, and NO proper byte-prefix
 * of a complete JSON object is itself valid JSON (the closing `}` is always
 * the last byte; any shorter prefix is unbalanced or mid-token). So a
 * fragment never parses, while a complete row always does. A blank tail has
 * nothing to wait for. Anything else (non-blank, unparseable) is treated as
 * an in-flight fragment and left in the sidecar.
 */
function isSettledRow(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

/**
 * Read the sidecar and decide what is SAFE to consume past `baseline`.
 *
 * Complete (newline-terminated) lines are always safe. The tricky case is a
 * trailing line WITHOUT a terminating newline. Under the blessed
 * {@link appendInboxRow} API every row is one atomic `write(2)` of
 * `JSON + '\n'`, so the queue files never hold a torn line; a newline-less
 * tail therefore only arises from a direct hand-edit (or the
 * documented-as-unreachable out-of-band fd held across the rename). We must
 * neither STRAND it (livelock — `claimInbox` always drains the sidecar
 * before the live inbox, so a stuck tail blocks all later rows) nor TEAR an
 * actively-growing concurrent write. The decision:
 *
 *   1. Complete JSONL row (valid JSON or blank — see {@link isSettledRow}):
 *      consume it. No proper byte-prefix of a complete JSON object is itself
 *      valid JSON, so this never mistakes a fragment for a row — and it
 *      needs no timing assumption.
 *   2. Otherwise (malformed / truncated tail): use GROWTH as the tiebreaker.
 *      A second read that shows the file still growing means a writer is
 *      mid-line → consume only whole lines and leave the partial
 *      (`partial:true`). A stable tail is a settled malformed line (a
 *      hand-edit) → consume it so it is archived as a parse error like any
 *      other bad row, never blocking the queue.
 *
 * The only unhandled case — an out-of-band writer that PAUSES mid-line
 * exactly across the two reads — is unreachable under the blessed API and
 * accepted (a rare archived parse error, never a silent live-inbox drop).
 *
 * Returns null ONLY when the sidecar is gone/unreadable (so the caller must
 * NOT blind-unlink it). When the file is readable but has nothing new past
 * `baseline`, returns an empty consumable carrying the current length so the
 * caller's unlink can still apply its growth guard.
 */
function readConsumable(path: string, baseline: number): Consumable | null {
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    return null
  }
  if (buf.length <= baseline) {
    return { tail: '', nextBaseline: buf.length, length: buf.length, partial: false }
  }
  const endsOnBoundary = buf[buf.length - 1] === 0x0a // '\n'
  if (!endsOnBoundary) {
    // The final, newline-less line starts after the last '\n' (or at the
    // baseline if no newline remains past it).
    const lastNewline = buf.lastIndexOf(0x0a)
    const tailStart = Math.max(lastNewline + 1, baseline)
    if (!isSettledRow(buf.subarray(tailStart).toString('utf8'))) {
      // Malformed tail: defer only while a writer is actively appending.
      let confirm: Buffer
      try {
        confirm = readFileSync(path)
      } catch {
        return null
      }
      if (confirm.length !== buf.length) {
        // Still growing → only whole lines are safe; leave the partial.
        const whole = completeLineTail(buf, baseline)
        return {
          tail: whole?.tail ?? '',
          nextBaseline: whole?.nextBaseline ?? baseline,
          length: buf.length,
          partial: true,
        }
      }
      // Stable malformed tail → fall through and consume it (archived as a
      // parse error), so a hand-edited bad final line can never livelock.
    }
  }
  return {
    tail: buf.subarray(baseline).toString('utf8'),
    nextBaseline: buf.length,
    length: buf.length,
    partial: false,
  }
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
 * Returns false when there is nothing to do. The claimed bytes live at
 * the sidecar path; the drain reads them from disk (so a pre-rename fd's
 * late writes are picked up) rather than from a claim-time snapshot.
 */
function claimInbox(inboxPath: string): boolean {
  const processingPath = processingPathFor(inboxPath)
  if (existsSync(processingPath)) {
    // Leftover from a crashed scan. A pre-rename appender could STILL hold
    // an fd to this inode and write to it during recovery, so it gets the
    // same late-write drain/requeue handling as a fresh rotation.
    return true
  }
  if (!existsSync(inboxPath)) return false
  renameSync(inboxPath, processingPath)
  return true
}

/**
 * Thrown when a TRANSIENT store/infra exception (busy-retry exhaustion
 * under sustained contention, or a disk/IO error — see
 * {@link isTransientStoreError}) interrupts the apply phase. The scan is
 * ABORTED before it advances the baseline, archives outcomes, or drops the
 * sidecar, so the claimed rows stay in the `.processing` sidecar and the
 * next scan recovers + retries them idempotently (stable ids /
 * skip-on-missing). Carries the underlying error as {@link cause}.
 *
 * This is deliberately NOT raised for deterministic per-row rejections
 * (unknown action, an unexpected constraint/validation error, a programming
 * bug): those are captured as `errored` outcomes and skipped so a single
 * poison row can never wedge the queue (`claimInbox` always drains the
 * sidecar before the live inbox).
 */
export class TaskScanAbortedError extends Error {
  override readonly name: string = 'TaskScanAbortedError'

  constructor(readonly cause: unknown) {
    super(
      `task scan aborted on transient store error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
}

/** Max in-order tail-drain passes over the rotated sidecar per scan. */
const MAX_TAIL_DRAIN_PASSES = 8

interface DrainResult {
  outcomes: ApplyOutcome[]
  errors: ParseError[]
  /** Bytes of the sidecar consumed (applied) by the time the drain ended. */
  finalBaseline: number
}

/**
 * Apply the claimed body, then drain — IN ORDER, within this same scan —
 * any rows a pre-rename-opened fd appended to the sidecar during the apply
 * window. Draining inline (rather than requeueing to the live inbox)
 * preserves global append order: sidecar-inode rows are older than
 * anything in the freshly-recreated live inbox, so applying them now,
 * before the next scan reads the live inbox, keeps a dependent
 * `add`→`update` pair in order. Applies to BOTH a fresh rotation and a
 * recovered leftover sidecar (a pre-crash fd can still target either).
 * Bounded to {@link MAX_TAIL_DRAIN_PASSES} passes so a pathological
 * continuous writer can't spin the scan forever — any final residual is
 * handled by {@link finalizeProcessing}.
 */
async function drainClaimed(deps: RunTaskScanDeps): Promise<DrainResult> {
  const applyDeps = { store: deps.store, project_slug: deps.project_slug }
  const errors: ParseError[] = []
  const outcomes: ApplyOutcome[] = []
  let baseline = 0
  const processingPath = processingPathFor(deps.paths.inbox)

  // Read the sidecar and apply everything safe to consume; loop to drain —
  // IN ORDER — any rows a pre-rename-opened fd appends during the apply
  // window. `readConsumable` settles a newline-less final row vs an
  // in-flight partial (see its doc), so a continuous writer leaves only a
  // growing partial that this loop stops on (and finalize defers), while a
  // settled row is consumed here. Bounded so a pathological continuous
  // writer can't spin the scan forever.
  for (let pass = 0; pass < MAX_TAIL_DRAIN_PASSES; pass++) {
    const slice = readConsumable(processingPath, baseline)
    if (slice === null || slice.nextBaseline <= baseline) break
    if (slice.tail.length > 0) {
      const parsed = parseInbox(slice.tail)
      let applied: ApplyOutcome[]
      try {
        applied = await applyInboxRows(applyDeps, parsed.rows)
      } catch (err) {
        // A TRANSIENT store/infra error (busy-retry exhausted, disk/IO)
        // escaped the apply. ABORT the scan WITHOUT advancing the baseline:
        // the claimed rows stay in the sidecar and the next scan recovers +
        // retries them idempotently. Advancing here would let `runTaskScan`
        // archive nothing for the row yet finalize past it, unlinking the
        // sidecar and permanently losing a valid row.
        throw new TaskScanAbortedError(err)
      }
      errors.push(...parsed.errors)
      outcomes.push(...applied)
    }
    // Advance only AFTER a clean apply, so an abort never moves the baseline
    // past rows that were not durably committed-and-archived.
    baseline = slice.nextBaseline
  }
  return { outcomes, errors, finalBaseline: baseline }
}

/**
 * Commit the scan: requeue any residual rows written to the rotated inode
 * AFTER the inline drain gave up (only possible under sustained
 * concurrent writes past {@link MAX_TAIL_DRAIN_PASSES}), then delete the
 * sidecar. The requeue appends to the live inbox for the next scan — this
 * vanishing residual is the only path that can reorder relative to live
 * appends, and a crash before the unlink simply defers it via the
 * leftover-sidecar recovery path.
 *
 * The sidecar is dropped ONLY when nothing can be lost by doing so:
 *
 *   - If the requeue WRITE fails (disk full, EACCES on the live inbox,
 *     …), the residual bytes were never persisted to the live inbox, so we
 *     LEAVE the sidecar in place. The next scan recovers it via the
 *     leftover-sidecar path; reprocessing is idempotent (stable ids /
 *     skip-on-missing). The previous code unconditionally unlinked here,
 *     silently dropping the residual on any requeue failure.
 *   - A trailing PARTIAL line (no newline yet — an in-flight write) is left
 *     too, so its eventual completion is recovered whole rather than split.
 *   - We re-read the sidecar immediately before unlinking and only remove
 *     it if it hasn't grown since the requeue read — closing the TOCTOU
 *     window where a pre-rename fd appends a row between read and unlink
 *     that would otherwise be dropped with the dirent.
 */
export function finalizeProcessing(inboxPath: string, finalBaseline: number): void {
  const processingPath = processingPathFor(inboxPath)

  // Requeue any residual past the inline drain's baseline. A settled
  // newline-less final line counts as complete; an actively-growing partial
  // is left (`partial:true`) for the next scan.
  const residual = readConsumable(processingPath, finalBaseline)
  // Sidecar gone or unreadable — do NOT blind-unlink (an unreadable-but-
  // present sidecar must be left for the next scan, not dropped). A truly
  // vanished sidecar needs no cleanup.
  if (residual === null) return

  if (residual.tail.length > 0) {
    // Normalize: the requeued bytes MUST end in a newline so the next scan
    // parses them as whole lines. Without this, a settled newline-less final
    // row would be requeued un-terminated and re-leave the sidecar forever.
    const tail = residual.tail.endsWith('\n') ? residual.tail : residual.tail + '\n'
    try {
      appendFileSync(inboxPath, tail, { mode: 0o600 })
    } catch {
      // Requeue write failed (disk full, EACCES on the live inbox, …): the
      // residual is NOT in the live inbox, so we must NOT drop the sidecar —
      // leave it for the next scan to recover (reprocessing is idempotent).
      return
    }
  }

  // An actively-growing partial remains: leave the sidecar so the next scan
  // recovers the completed line rather than dropping the in-flight write.
  if (residual.partial) return

  // Close the unlink window: a pre-rename fd could append a fresh row to the
  // sidecar inode AFTER our read but BEFORE the unlink, and the unlink would
  // drop that row with the dirent. Only remove it if it hasn't grown.
  try {
    if (readFileSync(processingPath).length !== residual.length) return
  } catch {
    return
  }
  try {
    unlinkSync(processingPath)
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
 *
 * Throws {@link TaskScanAbortedError} if a TRANSIENT store/infra error
 * (busy-retry exhaustion, disk/IO) interrupts the apply phase: the scan is
 * aborted before archiving, rendering, or finalizing, leaving the claimed
 * rows in the `.processing` sidecar for the next scan to recover. A caller
 * driving this on a cron tick should log + swallow that error and let the
 * next tick retry; the rows are never lost.
 */
export async function runTaskScan(deps: RunTaskScanDeps): Promise<TaskScanResult> {
  // 1. Claim the queue (atomic rotate, or drain a crashed leftover). A
  // false claim (nothing pending) still re-renders below so a bare cron
  // tick refreshes the time-sensitive focus ordering.
  const claimed = claimInbox(deps.paths.inbox)
  const now = deps.now?.() ?? new Date()
  const nowIso = now.toISOString()

  // 2. Apply the claimed rows + drain any late tail writes, in order.
  const drained: DrainResult = !claimed
    ? { outcomes: [], errors: [], finalBaseline: 0 }
    : await drainClaimed(deps)
  const outcomes = drained.outcomes
  const errors = drained.errors

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

  // 5. Commit: requeue any residual past the inline drain, then drop the
  // sidecar now the store + markdown are both durable. A crash before here
  // leaves the sidecar for the next scan to recover.
  if (claimed) {
    finalizeProcessing(deps.paths.inbox, drained.finalBaseline)
  }

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
