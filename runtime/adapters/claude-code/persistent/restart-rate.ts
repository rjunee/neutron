/**
 * restart-rate.ts — crash-loop guard: detect gateway restart markers landing
 * <5min apart and post a crash-loop warning EXACTLY ONCE (edge-latched), instead
 * of silently churning through restart after restart (Vajra mechanism #20,
 * `restart-rate.ts`).
 *
 * Incident this encodes (Nova/Vajra "pristine" 2026-05-21): the gateway
 * restarted, scheduled a deferred respawn, then restarted AGAIN 118s later. Two
 * restarts inside two minutes is the signature of a crash loop — a config error,
 * a poisoned state file, an OOM/CPU-pressure flap — and "just restart again"
 * makes it worse (it wipes in-flight timers, the very bug that lost the pristine
 * topic). The guard surfaces the loop to an operator rather than absorbing it.
 *
 * Design (cross-cutting invariant #1 — EDGE-TRIGGERED, LATCHED alerting; never
 * level/time-dedupe):
 *   - Each gateway boot appends a restart marker (epoch ms) to a small JSON file.
 *   - The two most-recent markers <`CRASH_LOOP_WINDOW_MS` apart == in a loop.
 *   - The warning fires on the absent→present edge of "in a loop" and is LATCHED
 *     (`inCrashLoop`) so a sustained loop warns ONCE, not every boot. When a
 *     later restart is spaced normally the latch clears, re-arming the warning.
 *
 * Pure-by-default: `evaluateRestartRate` is a pure transition over prior state +
 * `now`; the disk read/write (`recordAndEvaluateRestart`) is a thin wrapper.
 */

import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteFileSync } from '../../../atomic-write.ts'

/** Two restarts closer than this == a crash loop (Vajra <5min). */
export const CRASH_LOOP_WINDOW_MS = 5 * 60 * 1000
/** Markers older than this are pruned — bounds the file + the warning's "N
 *  restarts" count to a meaningful recent window. */
export const MARKER_RETENTION_MS = 60 * 60 * 1000

/** Persisted crash-loop guard state. */
export interface RestartRateState {
  /** Restart marker timestamps (epoch ms), oldest→newest, pruned to retention. */
  markers: number[]
  /** Edge latch: was the most recent evaluation already in a crash loop? Keeps
   *  the warning fire-once across a sustained loop. */
  inCrashLoop: boolean
}

export interface CrashLoopDetection {
  crashLoop: boolean
  /** Gap (ms) between the two most-recent markers, when there are ≥2. */
  intervalMs?: number
  /** Markers inside `CRASH_LOOP_WINDOW_MS` of the newest — the loop's size. */
  recentCount: number
}

export interface EvaluateRestartRateResult {
  /** Next state to persist (markers with `now` appended + pruned, latch updated). */
  state: RestartRateState
  /** True ONLY on the absent→present edge of the crash-loop condition. */
  warn: boolean
  detection: CrashLoopDetection
}

const EMPTY_STATE: RestartRateState = { markers: [], inCrashLoop: false }

// ─── Pure (de)serialization ────────────────────────────────────────────────

/** Parse raw file contents into state. A malformed/legacy file degrades to
 *  empty (a fresh start) — the guard must never throw on boot. Also accepts a
 *  bare array of markers (forward/back compat). */
export function parseRestartRateContents(contents: string): RestartRateState {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return { ...EMPTY_STATE }
  }
  if (Array.isArray(parsed)) {
    return { markers: parsed.filter((n) => typeof n === 'number'), inCrashLoop: false }
  }
  if (parsed !== null && typeof parsed === 'object') {
    const r = parsed as Record<string, unknown>
    const markers = Array.isArray(r['markers'])
      ? (r['markers'] as unknown[]).filter((n): n is number => typeof n === 'number')
      : []
    return { markers, inCrashLoop: r['inCrashLoop'] === true }
  }
  return { ...EMPTY_STATE }
}

export function serializeRestartRate(state: RestartRateState): string {
  return JSON.stringify(state, null, 2)
}

/** Drop markers older than `retentionMs` relative to `now`. Pure. */
export function pruneMarkers(
  markers: number[],
  now: number,
  retentionMs = MARKER_RETENTION_MS,
): number[] {
  return markers.filter((t) => now - t <= retentionMs)
}

/**
 * Pure crash-loop detector over a marker list (assumed oldest→newest). A loop
 * exists iff the two most-recent markers are <`windowMs` apart.
 */
export function detectCrashLoop(
  markers: number[],
  windowMs = CRASH_LOOP_WINDOW_MS,
): CrashLoopDetection {
  if (markers.length < 2) {
    return { crashLoop: false, recentCount: markers.length }
  }
  const sorted = [...markers].sort((a, b) => a - b)
  const newest = sorted[sorted.length - 1]!
  const prev = sorted[sorted.length - 2]!
  const intervalMs = newest - prev
  const recentCount = sorted.filter((t) => newest - t < windowMs).length
  return { crashLoop: intervalMs < windowMs, intervalMs, recentCount }
}

/**
 * Pure state transition for one restart: append `now` as a marker, prune to
 * retention, detect the crash loop on the resulting markers, and apply the edge
 * latch. `warn` is true ONLY when the crash-loop condition newly became true
 * (absent→present) — a sustained loop warns once; a normally-spaced restart
 * clears the latch and re-arms it.
 */
export function evaluateRestartRate(
  prev: RestartRateState,
  now: number,
  windowMs = CRASH_LOOP_WINDOW_MS,
  retentionMs = MARKER_RETENTION_MS,
): EvaluateRestartRateResult {
  const markers = pruneMarkers([...prev.markers, now], now, retentionMs)
  const detection = detectCrashLoop(markers, windowMs)
  const warn = detection.crashLoop && !prev.inCrashLoop
  return {
    state: { markers, inCrashLoop: detection.crashLoop },
    warn,
    detection,
  }
}

/** Operator-facing crash-loop warning text. */
export function buildCrashLoopWarningText(detection: CrashLoopDetection): string {
  const secs =
    detection.intervalMs !== undefined ? Math.round(detection.intervalMs / 1000) : undefined
  const gap = secs !== undefined ? `${secs}s apart` : 'in quick succession'
  return (
    `⚠️ CRASH-LOOP: the persistent-REPL gateway restarted ${gap} ` +
    `(${detection.recentCount} restarts in the last ${Math.round(CRASH_LOOP_WINDOW_MS / 60000)}min). ` +
    `Auto-restart is making it worse — a restart wipes in-flight respawn timers. ` +
    `Investigate the boot crash (config / poisoned state file / OOM) before relying on auto-recovery.`
  )
}

// ─── Disk-touching wrappers ────────────────────────────────────────────────

/** Load persisted guard state. Absent/corrupt → fresh empty state. */
export function loadRestartRate(path: string): RestartRateState {
  if (!existsSync(path)) return { ...EMPTY_STATE }
  try {
    return parseRestartRateContents(readFileSync(path, 'utf8'))
  } catch {
    return { ...EMPTY_STATE }
  }
}

/** Atomically persist guard state. */
export function saveRestartRate(path: string, state: RestartRateState): void {
  atomicWriteFileSync(path, serializeRestartRate(state))
}

/**
 * Record a restart at `now`, evaluate the crash-loop guard, persist the new
 * state, and return whether to warn (+ the detection for the message). The ONE
 * call a boot path makes. Best-effort persistence: a write failure still returns
 * the in-memory verdict (the warning is the load-bearing output; losing the
 * latch at worst re-warns next boot).
 */
export function recordAndEvaluateRestart(
  path: string,
  now: number,
  windowMs = CRASH_LOOP_WINDOW_MS,
  retentionMs = MARKER_RETENTION_MS,
): { warn: boolean; detection: CrashLoopDetection } {
  const prev = loadRestartRate(path)
  const result = evaluateRestartRate(prev, now, windowMs, retentionMs)
  try {
    saveRestartRate(path, result.state)
  } catch {
    /* best-effort — the verdict below still stands */
  }
  return { warn: result.warn, detection: result.detection }
}
