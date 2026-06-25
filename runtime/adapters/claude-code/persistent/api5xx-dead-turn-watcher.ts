/**
 * api5xx-dead-turn-watcher.ts — per-turn API-5xx dead-turn notifier (JSONL watcher).
 *
 * § Terminal-detection port, master-table row #11
 * (docs/research/vajra-terminal-detection-keystroke-port-2026-06-25.md). Ports
 * Vajra's `session-error-watcher.ts` + `pane-scan-watchdog.ts ADDENDUM`.
 *
 * THE INCIDENT (Ryan 2026-06-16): a mid-turn API 5xx — `Overloaded` /
 * `internal_server_error` / `rate_limit_error` — aborts the agent's turn BEFORE
 * it ever calls `reply()`. The substrate's turn `completion` never resolves, so
 * the user sees NOTHING: the turn dies silently. Neither the PTY-ring detectors
 * (#56/#55/#58 — they key off live TUI signatures) nor the #57 stuck-turn
 * watcher (it keys off an *unanswered real-user turn* going stale) recognise a
 * turn the model STARTED but a 5xx killed before any reply landed.
 *
 * THE FIX (this module): watch the turn's transcript JSONL and edge-fire a
 * "resend your last message" retry notice when a 5xx error record appears.
 *
 * WHY A JSONL WATCHER, NOT A RING SCAN. The Vajra original anchored on the
 * `⎿`-prefixed pane error line; the brief deliberately ports it as a JSONL
 * watcher instead — disk is the source of truth (cross-cutting invariant §5) and
 * the JSONL carries clean, typed records, so we never have to disambiguate a real
 * CLI error line from prose quoting "API Error: 500". This module does NOT touch
 * the `OutputScanner` / PTY ring.
 *
 * INVARIANTS CARRIED VERBATIM (each encodes a paid-for incident):
 *   1. EDGE-TRIGGERED LATCH. Fire on absent→present; clear ONLY on present→absent.
 *      NEVER time-dedupe — a stale error line must not re-fire forever (the
 *      hourly-re-fire-on-stale-banner bug). Here: a matching error record fires
 *      once and LATCHES; a later HEALTHY considered-record (a clean
 *      `result`/`system`/`error` with no 5xx token) clears the latch so a fresh
 *      error can fire again.
 *   2. JSONL / DISK IS THE SOURCE OF TRUTH.
 *   3. ALLOWLIST: match the error pattern on `result` / `system` / `error`
 *      records ONLY. `type:"user"` and `tool_result` records are IGNORED entirely
 *      (they neither fire nor clear the latch) — tool output legitimately echoes
 *      the word "overloaded" and must not trip the detector.
 *   4. REASSEMBLE records split across `fs.watch` callbacks — a single JSONL
 *      record can land in fragments; the core buffers a trailing partial line
 *      until its newline arrives.
 *
 * Pure + injectable: `classifyApi5xxRecord` operates on a string,
 * `Api5xxDeadTurnCore.feed` operates on a string and holds only the pending
 * buffer + the latch, and the `fs.watch` driver takes injectable fs primitives —
 * so every invariant is unit-testable without a live agent.
 */

import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  mkdirSync,
  watch as fsWatch,
} from 'node:fs'
import { dirname, basename } from 'node:path'

/**
 * The 5xx / overload signatures. CARRIED VERBATIM from the Vajra spec
 * (`/Overloaded|overloaded_error|rate_limit_error|internal_server_error/`). Note
 * the case-sensitive capital-O `Overloaded`: that is the API's literal overload
 * message; matching it case-sensitively (no `i` flag) is intentional and matches
 * Vajra. The allowlist (§3) is the real guard against prose false-fires anyway.
 */
export const API_5XX_ERROR_RE = /Overloaded|overloaded_error|rate_limit_error|internal_server_error/

/**
 * The ONLY record types the error pattern is matched against (§3 allowlist). A
 * mid-turn API failure surfaces as a `result` (turn-end error), a `system`
 * (`api_error`-class notice), or an `error` record. Everything else — `user`
 * (incl. `tool_result` blocks, which echo tool output), `assistant`, `summary` —
 * is ignored so a tool that prints "overloaded" can never trip the detector.
 */
export const API_5XX_CONSIDERED_TYPES: ReadonlySet<string> = new Set([
  'result',
  'system',
  'error',
])

/** Max chars of the raw JSONL line carried on a notice (bounds the surfaced text). */
const NOTICE_RECORD_MAX = 2000

/** A fired dead-turn detection — handed to the injected notice sink. */
export interface DeadTurnNotice {
  /** Stable discriminator. */
  reason: 'api_5xx_dead_turn'
  /** The matched 5xx token (e.g. `overloaded_error`) — for logging / dedupe. */
  matched: string
  /** The raw JSONL record line that matched, truncated to {@link NOTICE_RECORD_MAX}. */
  record: string
}

/** Per-record verdict. `fire` = a 5xx error on a considered record (rising-edge
 *  candidate). `clear` = a healthy considered record (falling edge — resets the
 *  latch). `ignore` = a non-considered / unparseable record (no state change). */
export type Api5xxVerdict = 'fire' | 'clear' | 'ignore'

/**
 * Classify ONE JSONL line. Pure. Parse-failures and non-allowlisted records
 * return `ignore` so an incomplete fragment or a `user`/`tool_result` echo never
 * affects the latch. A considered record (`result`/`system`/`error`) returns
 * `fire` iff the 5xx pattern matches its raw text, else `clear`.
 *
 * The pattern is tested against the RAW line for considered records — exactly
 * what Vajra did ("match error patterns on result / system lines"). It is safe:
 * the allowlist has already excluded the `user`/`tool_result` records whose
 * content legitimately quotes "overloaded".
 */
export function classifyApi5xxRecord(line: string): Api5xxVerdict {
  const trimmed = line.trim()
  if (trimmed.length === 0) return 'ignore'
  let ev: { type?: unknown }
  try {
    ev = JSON.parse(trimmed) as { type?: unknown }
  } catch {
    return 'ignore'
  }
  if (typeof ev !== 'object' || ev === null) return 'ignore'
  const type = ev.type
  if (typeof type !== 'string' || !API_5XX_CONSIDERED_TYPES.has(type)) return 'ignore'
  return API_5XX_ERROR_RE.test(trimmed) ? 'fire' : 'clear'
}

/**
 * The stateful detection core: line-reassembly (§4) + the edge-latch (§1). Feed
 * it byte chunks as they arrive (a chunk may split a record mid-line, or carry
 * several records); it returns the notices that fired on this feed.
 *
 * State is exactly two fields — a pending partial-line buffer and the latch — and
 * BOTH are updated BEFORE `feed` returns, so a caller that performs the notify
 * side-effect afterwards is fire-once even if the notify throws (the
 * stamp-before-await invariant, cross-cutting §4).
 */
export class Api5xxDeadTurnCore {
  /** Trailing partial line carried across feeds until its newline lands (§4). */
  private pending = ''
  /** Latched-present: a 5xx error record fired and no healthy record has cleared
   *  it yet. While true a further 5xx record does NOT re-fire (§1). */
  private latchedPresent = false

  /** Test/introspection: is the dead-turn state currently latched up? */
  get latched(): boolean {
    return this.latchedPresent
  }

  /**
   * Feed a byte chunk. Appends to the pending buffer, extracts COMPLETE lines
   * (the final fragment with no trailing newline stays buffered for the next
   * feed — record-reassembly across `fs.watch` callbacks), classifies each, and
   * applies the edge-latch. Returns the notices fired this feed (usually 0 or 1).
   */
  feed(chunk: string): DeadTurnNotice[] {
    this.pending += chunk
    const fired: DeadTurnNotice[] = []
    // Split on newline; the LAST element is the (possibly empty) incomplete
    // trailing line — retain it as the new pending buffer so a record split
    // across two callbacks is reassembled, never misparsed.
    const parts = this.pending.split('\n')
    this.pending = parts.pop() ?? ''
    for (const line of parts) {
      const verdict = classifyApi5xxRecord(line)
      if (verdict === 'ignore') continue
      if (verdict === 'clear') {
        // Falling edge: a healthy considered record clears the latch so the next
        // 5xx can fire again. (Append-only log → "absent" = a later clean record.)
        this.latchedPresent = false
        continue
      }
      // verdict === 'fire'
      if (this.latchedPresent) continue // already present — do NOT re-fire (§1)
      // STAMP THE LATCH BEFORE RETURNING (fire-once even if the caller's notify
      // throws — cross-cutting invariant §4).
      this.latchedPresent = true
      const matched = API_5XX_ERROR_RE.exec(line)?.[0] ?? ''
      fired.push({
        reason: 'api_5xx_dead_turn',
        matched,
        record: line.trim().slice(0, NOTICE_RECORD_MAX),
      })
    }
    return fired
  }

  /** Reset the reassembly buffer (NOT the latch) — used by the driver when the
   *  underlying file is truncated / rotated so a stale partial line from the old
   *  file can't fuse onto the new file's first line. */
  resetBuffer(): void {
    this.pending = ''
  }
}

/** A directory watcher handle (injectable so tests don't touch real `fs.watch`). */
export interface DirWatchHandle {
  close: () => void
}

/** Result of reading new bytes from the JSONL: the bytes appended since `offset`
 *  and the file's current size (so the driver can advance its offset). */
export interface JsonlReadResult {
  bytes: string
  size: number
}

export interface Api5xxWatcherDeps {
  /** Absolute path to the turn's transcript JSONL. */
  jsonlPath: string
  /** Notice sink — fired ONCE per rising edge. Best-effort (a throw is swallowed
   *  so a sink failure can't brick the watcher). The gateway wires this to the
   *  user-facing retry-affordance surface (the dev-channel / delivery seam). */
  notify: (notice: DeadTurnNotice) => void | Promise<void>
  /** Watch the JSONL's PARENT DIRECTORY (robust to the file not existing yet /
   *  being recreated on resume) and call `onChange` on any relevant event.
   *  Default: a real `fs.watch` on the directory, filtered to the basename. */
  watchDir?: (dir: string, base: string, onChange: () => void) => DirWatchHandle
  /** Read bytes from `path` starting at `offset` to EOF; returns null when the
   *  file is missing/unreadable. Default: a never-throws `openSync`/`readSync`
   *  range read (mirrors the #57 `realReadJsonlTail` primitive). */
  readFrom?: (path: string, offset: number) => JsonlReadResult | null
  /** Ensure the watch directory exists before attaching (so `fs.watch` can bind
   *  even when `claude` hasn't created the projects subdir yet). Default: a
   *  recursive `mkdirSync`. Tests pass a no-op. */
  ensureDir?: (dir: string) => void
}

/** Live watcher handle. `pump()` is exposed so tests (and a caller that prefers
 *  a poll cadence) can drive a read deterministically; `stop()` closes it. */
export interface Api5xxWatcherHandle {
  /** Read any new bytes and process them now. Idempotent w.r.t. already-read bytes. */
  pump: () => void
  /** Detach the directory watcher. Safe to call repeatedly. */
  stop: () => void
}

/**
 * Default range reader. Never throws — a missing/unreadable file returns null so
 * the watcher waits for the file to appear rather than crashing. Handles
 * truncation/rotation: when the file is SHORTER than the prior offset it reads
 * from 0 (the caller resets the reassembly buffer on that case).
 */
export function realReadFrom(path: string, offset: number): JsonlReadResult | null {
  try {
    if (!existsSync(path)) return null
    const size = statSync(path).size
    if (size === 0) return { bytes: '', size: 0 }
    const start = size >= offset ? offset : 0 // shrank → rotation; re-read from 0
    if (start >= size) return { bytes: '', size }
    const len = size - start
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.allocUnsafe(len)
      const n = readSync(fd, buf, 0, len, start)
      return { bytes: buf.subarray(0, n).toString('utf8'), size }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Default directory watcher — a real `fs.watch`, filtering to the target file's
 *  basename (a directory watch reports sibling-file events too). Never throws on
 *  close. */
function realWatchDir(dir: string, base: string, onChange: () => void): DirWatchHandle {
  const w = fsWatch(dir, (_event, filename) => {
    // `filename` can be null on some platforms; treat that as "something changed".
    if (filename === null || filename === base) onChange()
  })
  return {
    close: () => {
      try {
        w.close()
      } catch {
        // best-effort
      }
    },
  }
}

/**
 * Start the per-turn API-5xx dead-turn watcher on a transcript JSONL.
 *
 * Watches the JSONL's parent directory (so the watcher survives the file not yet
 * existing and a resume re-creating it), and on every change pumps the bytes
 * appended since the last read into an {@link Api5xxDeadTurnCore} — which
 * reassembles split records and edge-latches — firing `notify` once per rising
 * edge. The latch is stamped inside `feed` BEFORE `notify` runs, so the notify is
 * fire-once even if it throws (cross-cutting invariant §4).
 */
export function startApi5xxDeadTurnWatcher(deps: Api5xxWatcherDeps): Api5xxWatcherHandle {
  const readFrom = deps.readFrom ?? realReadFrom
  const watchDir = deps.watchDir ?? realWatchDir
  const ensureDir = deps.ensureDir ?? ((dir: string) => mkdirSync(dir, { recursive: true }))
  const dir = dirname(deps.jsonlPath)
  const base = basename(deps.jsonlPath)
  const core = new Api5xxDeadTurnCore()

  let offset = 0
  let stopped = false

  const pump = (): void => {
    if (stopped) return
    const read = readFrom(deps.jsonlPath, offset)
    if (read === null) return
    // Rotation/truncation: the file shrank below our offset. `readFrom` already
    // re-read from 0; drop the stale partial line so it can't fuse onto the new
    // file's first record.
    if (read.size < offset) core.resetBuffer()
    offset = read.size
    if (read.bytes.length === 0) return
    const notices = core.feed(read.bytes)
    for (const notice of notices) {
      try {
        const r = deps.notify(notice)
        if (r instanceof Promise) r.catch(() => {})
      } catch {
        // best-effort — a notify failure must not abort the pump or un-latch.
      }
    }
  }

  // SEEK TO EOF ON ATTACH (Codex P2). On a RESUME the transcript already holds
  // the whole prior conversation — including any historical 5xx from a turn that
  // already died and was abandoned. Starting `offset` at 0 and replaying that
  // history would emit a STALE "resend your last message" notice on every resume
  // (and our own edge-latch wouldn't save us: the historical error fires during
  // the catch-up feed BEFORE a later healthy record clears the latch). Seeking to
  // the current EOF means we only ever consider records appended DURING this
  // watcher's lifetime — i.e. a 5xx that kills the CURRENT live turn, which is
  // exactly the per-turn semantics we want. A fresh spawn (file absent → seed
  // null) keeps offset 0, so nothing the new turn writes is missed.
  const seed = readFrom(deps.jsonlPath, 0)
  if (seed !== null) offset = seed.size

  let handle: DirWatchHandle | undefined
  try {
    ensureDir(dir)
    handle = watchDir(dir, base, pump)
  } catch {
    // If the watch can't attach (dir vanished, platform quirk), the watcher is
    // inert rather than crashing the spawn — `pump()` can still be driven by a
    // caller, and `stop()` is a no-op.
    handle = undefined
  }

  // Initial read — catches anything appended between the EOF seed above and the
  // watcher attaching (and, on a fresh spawn where seed was null, the very first
  // records the new turn writes).
  pump()

  return {
    pump,
    stop: () => {
      if (stopped) return
      stopped = true
      handle?.close()
    },
  }
}
