/**
 * @neutronai/runtime — JSONL turn-progress reader for the stuck-turn watchdog.
 *
 * Ported from Vajra `stuck-turn-watchdog.ts` (incident 2026-04-21). The lesson:
 * a CC turn can wedge while its port `/health` probe still answers OK — the only
 * reliable signal that "the turn actually advanced" is the transcript JSONL.
 * `watchdog.ts` keys its `stuck` decision off this reader (via an injected
 * `turn_progress_at` probe) so a heartbeat that merely bumps the registry's
 * in-memory `last_event_at` can no longer keep a wedged turn looking alive.
 *
 * Everything here is pure + injectable so the parse/threshold logic is testable
 * without a live agent: `parseTailForLastTurnProgress` operates on a string,
 * `realReadJsonlTail` is the only fs-touching primitive (and it never throws),
 * and `makeJsonlTurnProgressProbe` composes them behind a caller-supplied path
 * resolver — the watchdog itself stays free of any cwd/projects-dir knowledge the
 * registry doesn't carry.
 */

import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import type { SubagentRecord } from './registry.ts'

/**
 * Bytes to read from the END of a transcript JSONL on each probe. 256 KB holds
 * many hundreds of turn events for a typical session while bounding per-tick I/O
 * regardless of how large the JSONL has grown. Matches the Vajra tail window.
 */
export const JSONL_TURN_TAIL_BYTES = 256 * 1024

/** Minimal shape we read out of each JSONL line — only the progress-relevant bits. */
interface JsonlEvent {
  type?: string
  timestamp?: string
  isMeta?: boolean
  message?: {
    role?: string
    content?: unknown
  }
}

/**
 * Return true iff `ev` represents REAL turn progress — model output or genuine
 * tool/user activity — as opposed to the bookkeeping noise (`system`,
 * `queue-operation`, summary/meta records) that a WEDGED turn keeps emitting.
 *
 * Progress = any `assistant` record (the model produced output), OR a `user`
 * record with non-empty content (raw user text, or a tool_result block — a
 * returned tool call IS forward progress for an agent that's actively working,
 * which is the key difference from Vajra's *operator-input* filter, where
 * tool_result was excluded). `isMeta` records are never progress.
 *
 * Exported for direct unit testing — the filter rules are fiddly enough that we
 * want them locked in.
 */
export function isRealTurnEvent(ev: JsonlEvent): boolean {
  if (ev.isMeta === true) return false
  if (ev.type === 'assistant') return true
  if (ev.type === 'user') {
    const content = ev.message?.content
    if (typeof content === 'string') return content.trim().length > 0
    if (Array.isArray(content)) return content.length > 0
    return false
  }
  return false
}

export interface TurnProgressParse {
  /** Epoch ms of the latest real turn event in the tail, or null if none. */
  lastProgressMs: number | null
}

/**
 * Parse the tail of a JSONL buffer into the latest real-turn-progress timestamp.
 * The first line of the buffer may be truncated (we started mid-record when
 * reading from a non-zero offset) — `hadTruncatedHead` discards it so a partial
 * JSON line is never misparsed.
 */
export function parseTailForLastTurnProgress(
  tail: string,
  { hadTruncatedHead }: { hadTruncatedHead: boolean },
): TurnProgressParse {
  const lines = tail.split('\n')
  const startIdx = hadTruncatedHead ? 1 : 0
  let lastProgressMs: number | null = null

  for (let i = startIdx; i < lines.length; i += 1) {
    const trimmed = lines[i]?.trim()
    if (!trimmed) continue

    let ev: JsonlEvent
    try {
      ev = JSON.parse(trimmed) as JsonlEvent
    } catch {
      continue
    }
    if (!isRealTurnEvent(ev)) continue

    const ts = ev.timestamp
    if (typeof ts !== 'string') continue
    const ms = Date.parse(ts)
    if (!Number.isFinite(ms)) continue

    if (lastProgressMs === null || ms > lastProgressMs) lastProgressMs = ms
  }
  return { lastProgressMs }
}

/**
 * Real-fs tail reader. Returns the last `maxBytes` of `path` plus a flag noting
 * whether the read started mid-record (so the parser discards the truncated
 * first line). Never throws — a missing / unreadable / empty file returns null
 * so the watchdog falls back to `last_event_at` rather than crashing the tick.
 */
export function realReadJsonlTail(
  path: string,
  maxBytes: number = JSONL_TURN_TAIL_BYTES,
): { bytes: string; hadTruncatedHead: boolean } | null {
  try {
    if (!existsSync(path)) return null
    const size = statSync(path).size
    if (size === 0) return null
    const readLength = Math.min(size, maxBytes)
    const start = size - readLength
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.allocUnsafe(readLength)
      const n = readSync(fd, buf, 0, readLength, start)
      const bytes = buf.subarray(0, n).toString('utf8')
      return { bytes, hadTruncatedHead: start > 0 }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

export interface JsonlTurnProgressProbeDeps {
  /**
   * Resolve the transcript JSONL path for a record, or null when the record has
   * no transcript (no `child_session_id` yet, or an in-process agent). The
   * registry doesn't carry a child's cwd, so the caller — which owns the
   * session-id↔cwd mapping — supplies this. See `session-validation.ts`
   * (`dashifyCwd`) for the `<projectsDir>/<cwd-dashed>/<sessionId>.jsonl` layout.
   */
  resolveTranscriptPath: (rec: SubagentRecord) => string | null
  /** fs tail reader. Default `realReadJsonlTail`; tests inject a stub. */
  readTail?: (
    path: string,
    maxBytes: number,
  ) => { bytes: string; hadTruncatedHead: boolean } | null
  /** Tail window in bytes. Default `JSONL_TURN_TAIL_BYTES`. */
  tailBytes?: number
}

/**
 * Build the `turn_progress_at` probe the watchdog injects. Resolves the record's
 * transcript path, tail-reads its JSONL, and returns the latest real-turn-progress
 * timestamp — or null when there is no transcript or no progress event in the
 * tail (the watchdog then falls back to `last_event_at`). Pure relative to its
 * injected deps; the only side effect is the fs read inside `readTail`.
 */
export function makeJsonlTurnProgressProbe(
  deps: JsonlTurnProgressProbeDeps,
): (rec: SubagentRecord) => number | null {
  const readTail = deps.readTail ?? realReadJsonlTail
  const tailBytes = deps.tailBytes ?? JSONL_TURN_TAIL_BYTES
  return (rec) => {
    const path = deps.resolveTranscriptPath(rec)
    if (!path) return null
    const read = readTail(path, tailBytes)
    if (!read) return null
    return parseTailForLastTurnProgress(read.bytes, {
      hadTruncatedHead: read.hadTruncatedHead,
    }).lastProgressMs
  }
}
