/**
 * jsonl-resumability.ts — classify a failed-probe / pending REPL entry as RESUMABLE
 * by reading the topic's transcript JSONL from disk (Vajra mechanism #20,
 * cross-cutting invariant #5: "disk JSONL is the source of truth").
 *
 * Incident this encodes (Nova/Vajra "pristine" 2026-05-21): the gateway
 * restarted, scheduled a `setTimeout`-based zombie respawn, then restarted AGAIN
 * 118s later — wiping the in-memory timer — so the topic vanished silently even
 * though its JSONL was fully intact. The lesson: recovery must reconstruct
 * resumability FROM DISK on boot, never rely on a surviving `setTimeout` or the
 * in-memory registry index.
 *
 * Relationship to `session-validation.ts`: `validateAndPersistSessionId` is the
 * binary existence gate — "does a JSONL with ≥1 line exist?" (the ghost-session
 * guard, Nova 2026-04-13). THIS module is the richer classifier the boot-drain
 * uses: it reads the transcript's mtime and last *real* conversational turn so a
 * failed-probe / scheduled-but-lost entry with a live JSONL is RECOVERED rather
 * than dropped, and (optionally) a long-cold transcript can be flagged stale.
 *
 * Pure-by-default: the classification logic (`classifyResumable`) is a pure
 * function over already-read metadata so it is testable without touching disk;
 * the disk read (`readSessionJsonlMeta`) is a thin, fs-injectable wrapper.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { dashifyCwd } from './session-validation.ts'

/** Why an entry was (not) classified resumable. `live`/`stale` both imply a
 *  real transcript exists; the rest are disqualifiers. */
export type ResumableReason = 'no-jsonl' | 'empty' | 'no-real-turn' | 'stale' | 'live'

/** Disk-read transcript metadata — the input to the pure classifier. */
export interface JsonlMeta {
  /** Whether the `<projectsDir>/<cwd-dashed>/<sessionId>.jsonl` file exists. */
  exists: boolean
  /** File size in bytes (0 when absent). */
  sizeBytes: number
  /** Last-modified time, epoch ms (0 when absent). */
  mtimeMs: number
  /** Count of *real* conversational turns (user/assistant message lines). A
   *  transcript of only `summary`/`system`/meta lines has 0 — it is not a
   *  resumable conversation. */
  realTurnCount: number
  /** Epoch ms of the last real turn's `timestamp`, when parseable. Undefined
   *  when no real turn carried a timestamp (falls back to `mtimeMs`). */
  lastRealTurnAtMs?: number
}

export interface ClassifyResumableResult {
  resumable: boolean
  reason: ResumableReason
  /** Age (ms) of the transcript at `now` — `now - max(lastRealTurnAtMs,
   *  mtimeMs)`. Undefined when no transcript exists. */
  ageMs?: number
}

export interface ClassifyResumableOptions {
  /** When set, a transcript older than this is classified `stale` (not
   *  resumable). Default UNDEFINED — disk is the source of truth, so age alone
   *  never disqualifies a real transcript unless a caller opts in. */
  maxAgeMs?: number
}

/** The CC transcript path for a session: `<projectsDir>/<cwd-dashed>/<id>.jsonl`. */
export function sessionJsonlPath(
  sessionId: string,
  cwd: string,
  projectsDir: string = join(homedir(), '.claude', 'projects'),
): string {
  return join(projectsDir, dashifyCwd(cwd), `${sessionId}.jsonl`)
}

/** Is one parsed JSONL record a *real* conversational turn? A real turn is a
 *  user- or assistant-authored message — NOT a `summary` line, a `system` meta
 *  record, or a record missing a `message` body. Mirrors the Vajra
 *  `isRealUserEvent`/turn-tail discipline (#8 stuck-turn, #11 api5xx) used to
 *  decide whether a transcript holds a resumable conversation. */
export function isRealTurnRecord(rec: unknown): boolean {
  if (rec === null || typeof rec !== 'object') return false
  const r = rec as Record<string, unknown>
  if (r['type'] !== 'user' && r['type'] !== 'assistant') return false
  // A real turn has a message body. `summary`/meta lines (and the occasional
  // bare marker) lack one and must not count as a resumable conversation.
  return r['message'] !== undefined && r['message'] !== null
}

/** Parse one JSONL line's `timestamp` (ISO 8601) → epoch ms, or undefined. */
function parseRecordTimestamp(rec: unknown): number | undefined {
  if (rec === null || typeof rec !== 'object') return undefined
  const ts = (rec as Record<string, unknown>)['timestamp']
  if (typeof ts !== 'string') return undefined
  const ms = Date.parse(ts)
  return Number.isNaN(ms) ? undefined : ms
}

/** Injectable fs seam (tests pass fakes; production defaults to `node:fs`). */
export interface JsonlResumabilityDeps {
  existsSync: (p: string) => boolean
  readFileSync: (p: string) => string
  statMtimeMs: (p: string) => number
  statSizeBytes: (p: string) => number
}

const defaultDeps: JsonlResumabilityDeps = {
  existsSync: (p) => existsSync(p),
  readFileSync: (p) => readFileSync(p, 'utf8'),
  statMtimeMs: (p) => statSync(p).mtimeMs,
  statSizeBytes: (p) => statSync(p).size,
}

/**
 * Read transcript metadata for a session from disk. Scans the JSONL for real
 * conversational turns (so a transcript of only summary/system lines reads as
 * `realTurnCount: 0`) and records the last real turn's timestamp + the file
 * mtime. A read/parse error degrades to `{ exists: false }` (treated as
 * not-resumable) rather than throwing — recovery must never brick on a corrupt
 * transcript.
 */
export function readSessionJsonlMeta(
  sessionId: string,
  cwd: string,
  projectsDir?: string,
  deps: JsonlResumabilityDeps = defaultDeps,
): JsonlMeta {
  const path = sessionJsonlPath(sessionId, cwd, projectsDir)
  const absent: JsonlMeta = { exists: false, sizeBytes: 0, mtimeMs: 0, realTurnCount: 0 }
  if (!sessionId || !deps.existsSync(path)) return absent
  let contents: string
  let mtimeMs = 0
  let sizeBytes = 0
  try {
    contents = deps.readFileSync(path)
    mtimeMs = deps.statMtimeMs(path)
    sizeBytes = deps.statSizeBytes(path)
  } catch {
    return absent
  }
  let realTurnCount = 0
  let lastRealTurnAtMs: number | undefined
  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let rec: unknown
    try {
      rec = JSON.parse(trimmed)
    } catch {
      continue // a partially-flushed tail line — skip, don't poison the scan
    }
    if (!isRealTurnRecord(rec)) continue
    realTurnCount++
    const ts = parseRecordTimestamp(rec)
    if (ts !== undefined) lastRealTurnAtMs = ts
  }
  const meta: JsonlMeta = { exists: true, sizeBytes, mtimeMs, realTurnCount }
  if (lastRealTurnAtMs !== undefined) meta.lastRealTurnAtMs = lastRealTurnAtMs
  return meta
}

/**
 * Pure classifier: given transcript metadata + the current clock, decide whether
 * a failed-probe / pending entry is RESUMABLE.
 *
 *   - no file on disk            → `no-jsonl`     (not resumable)
 *   - file present but empty     → `empty`        (not resumable; ghost session)
 *   - no real conversational turn → `no-real-turn` (not resumable)
 *   - real turn(s), within maxAge → `live`         (RESUMABLE — recover from disk)
 *   - real turn(s), past maxAge   → `stale`        (not resumable; opt-in only)
 *
 * `maxAgeMs` is opt-in: with it unset (the default) any transcript carrying a
 * real turn is resumable, honouring "disk JSONL is the source of truth" — the
 * 2026-05-21 lesson is that a lost timer must not drop a topic whose conversation
 * is intact, regardless of how long the gateway was down.
 */
export function classifyResumable(
  meta: JsonlMeta,
  now: number,
  opts: ClassifyResumableOptions = {},
): ClassifyResumableResult {
  if (!meta.exists) return { resumable: false, reason: 'no-jsonl' }
  if (meta.sizeBytes === 0) return { resumable: false, reason: 'empty' }
  if (meta.realTurnCount === 0) return { resumable: false, reason: 'no-real-turn' }
  const lastActivityMs = Math.max(meta.lastRealTurnAtMs ?? 0, meta.mtimeMs)
  const ageMs = Math.max(0, now - lastActivityMs)
  if (opts.maxAgeMs !== undefined && ageMs > opts.maxAgeMs) {
    return { resumable: false, reason: 'stale', ageMs }
  }
  return { resumable: true, reason: 'live', ageMs }
}

/** Convenience: read a `{ sessionId, cwd }` entry's transcript from disk and
 *  classify it in one call. Used by the boot-drain to decide whether an
 *  unregistered pending entry is recoverable-from-disk (retain) vs a true ghost
 *  (drop). */
export function classifyEntryResumable(
  entry: { sessionId: string; cwd: string },
  now: number,
  opts: ClassifyResumableOptions = {},
  projectsDir?: string,
  deps: JsonlResumabilityDeps = defaultDeps,
): ClassifyResumableResult {
  const meta = readSessionJsonlMeta(entry.sessionId, entry.cwd, projectsDir, deps)
  return classifyResumable(meta, now, opts)
}
