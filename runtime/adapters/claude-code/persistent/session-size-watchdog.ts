/**
 * session-size-watchdog.ts — warm/persistent session-size watchdog + compact
 * affordance (Vajra port row #13, docs/research/vajra-terminal-detection-
 * keystroke-port-2026-06-25.md).
 *
 * THE INCIDENT (Vajra 2026-04-16): a long-lived topic's turn JSONL grew
 * unbounded (the "tax topic" hit 11.8 MB). Past a CC-internal ceiling, `claude
 * --resume <id>` is REFUSED — the session can no longer be resumed, the
 * supervisor respawns it, the respawn `--resume` fails again, and the topic
 * falls into an infinite restart loop. Neutron's `reset_context_per_turn`
 * (`/clear`) mode caps growth for the reset-per-turn import path, but a
 * WARM/persistent conversational REPL has NO size monitor — it can grow until
 * `--resume` wedges. This watchdog watches the post-compact JSONL size on a
 * cadence and surfaces a Reset/Compact affordance BEFORE it wedges.
 *
 * ── THE ONE LESSON THAT MUST NOT BE LOST ──────────────────────────────────
 * MEASURE POST-COMPACT SIZE, never raw `stat().size`. The "size" that matters
 * is the bytes in the JSONL AFTER the last record carrying the compact-summary
 * marker (`"isCompactSummary":true`). Why: when the user runs `/compact`, the
 * file does NOT shrink on disk — CC appends a compact-summary record and keeps
 * writing; the raw byte size stays huge. If the watchdog measured raw size, the
 * warn would fire, the user would Compact, the raw size would barely move, and
 * the warn would RE-FIRE forever ("Compact does nothing" loop). The bytes after
 * the last compact-summary marker ARE the live, post-compaction context — that
 * is the only signal that drops when a compaction actually helps.
 *
 * ── THE PRECOMPACT LOCK ───────────────────────────────────────────────────
 * A compaction in progress momentarily looks HUGE: CC keeps appending the
 * pre-summary turn before the `"isCompactSummary":true` marker lands, so for a
 * brief window post-compact size == raw size (no marker yet at the tail). Tick
 * during that window and you get a spurious warn on every compaction. The
 * watchdog therefore holds a mid-compact LOCK from the moment IT actuates a
 * compaction until the new summary marker lands (post-compact size drops back
 * below the warn band), and skips all alerting while the lock is held.
 *
 * ── INVARIANTS (verbatim from the port brief) ─────────────────────────────
 *   • POST-COMPACT size only (bytes after the last `"isCompactSummary":true`).
 *     Never raw `stat.size`.
 *   • PreCompact lock: skip the check while a compact is mid-flight (the
 *     grow-before-marker window).
 *   • Edge-triggered / TIERED latch per severity: warn fires once on entering
 *     the warn band, critical once on entering the critical band; the latch
 *     clears when the size drops back. Never time-dedupe (the stale-banner
 *     hourly-re-fire bug — cross-cutting invariant §1).
 *   • Compact action = `writeKey('escape')` THEN `child.write('/compact\r')`,
 *     fire-once per affordance press (the debounce/lock is stamped BEFORE the
 *     writes so a transport failure can't double-actuate — invariant §4).
 *   • JSONL / disk is the source of truth (invariant §5).
 *
 * Pure + DI-driven so the measurement, the tiered latch, and the compact
 * actuator are all unit-testable without a PTY or a real `claude` process; the
 * substrate wires the fs read + the live PTY child + the surface callback.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { dashifyCwd } from './session-validation.ts'
import type { Key } from './keystrokes.ts'

/** Post-compact size at/above which we WARN (5 MB). */
export const SIZE_WARN_BYTES = 5 * 1024 * 1024
/** Post-compact size at/above which we go CRITICAL (10 MB). `--resume` starts to
 *  be at risk above here — the 2026-04-16 wedge was at 11.8 MB. */
export const SIZE_CRITICAL_BYTES = 10 * 1024 * 1024
/** Default cadence: measure every 5 min. The check is a single bounded fs read,
 *  so it stays well off the hot path. */
export const DEFAULT_SIZE_CHECK_INTERVAL_MS = 5 * 60 * 1000
/** Min ms between successive Compact actuations on one session — a floor on top
 *  of the mid-compact lock so a rapid double-press can't double-send. */
export const DEFAULT_COMPACT_DEBOUNCE_MS = 30 * 1000

/**
 * The compact-summary record marker, as CC serializes it. CC writes its
 * transcript JSONL with `JSON.stringify` (NO spaces), so the canonical on-disk
 * byte sequence is `"isCompactSummary":true`. We match the canonical form as a
 * raw byte needle (so `measurePostCompactBytes` never has to utf8-decode a
 * multi-MB file just to find an ASCII marker).
 */
export const COMPACT_SUMMARY_MARKER = '"isCompactSummary":true'

/** Severity bands. Ordered: none < warn < critical. */
export type SizeSeverity = 'warn' | 'critical'

const NEWLINE = 0x0a // '\n'

/**
 * POST-COMPACT byte size of a transcript buffer: the number of bytes AFTER the
 * record that carries the last `"isCompactSummary":true` marker. This is the
 * load-bearing measurement (see the file header) — it is what DROPS when a
 * compaction actually reduces live context, whereas the raw byte length does
 * not.
 *
 *   • No marker present  → the whole file is live context → full byte length.
 *   • Marker present     → bytes after the newline terminating that record.
 *   • Marker on the final (unterminated) line → 0 (nothing after it yet).
 *
 * Operates on a Buffer for byte accuracy (a transcript can hold multi-byte
 * UTF-8; a `string.length` would over/under-count) and to avoid decoding a
 * multi-MB file. Pure — the fs read lives in {@link measurePostCompactSize}.
 */
export function measurePostCompactBytes(buf: Buffer): number {
  const markerBytes = Buffer.from(COMPACT_SUMMARY_MARKER, 'utf8')
  const markerIdx = buf.lastIndexOf(markerBytes)
  if (markerIdx === -1) return buf.length
  // End of the record line that holds the marker = the next newline after it.
  const nlIdx = buf.indexOf(NEWLINE, markerIdx + markerBytes.length)
  if (nlIdx === -1) return 0 // marker is in the final, not-yet-terminated record
  return buf.length - (nlIdx + 1)
}

/**
 * Read a transcript JSONL and return its post-compact byte size, or `null` when
 * the file is absent/unreadable (the watchdog then SKIPS the tick rather than
 * firing on a phantom size). Never throws — a watchdog tick must not crash on a
 * transient fs error.
 */
export function measurePostCompactSize(jsonlPath: string): number | null {
  try {
    if (!existsSync(jsonlPath)) return null
    return measurePostCompactBytes(readFileSync(jsonlPath))
  } catch {
    return null
  }
}

/**
 * Resolve a session's transcript JSONL path, matching CC's on-disk layout
 * `<projectsDir>/<cwd-dashed>/<sessionId>.jsonl` (the same convention
 * `session-validation.ts` uses for the ghost-session gate).
 */
export function sessionJsonlPath(
  sessionId: string,
  cwd: string,
  projectsDir: string = join(homedir(), '.claude', 'projects'),
): string {
  return join(projectsDir, dashifyCwd(cwd), `${sessionId}.jsonl`)
}

/** Map a post-compact size to its severity tier rank (0 none / 1 warn / 2 crit). */
function tierRank(size: number): 0 | 1 | 2 {
  if (size >= SIZE_CRITICAL_BYTES) return 2
  if (size >= SIZE_WARN_BYTES) return 1
  return 0
}

/**
 * The TIERED edge-latch (cross-cutting invariant §1). `evaluate(size)` returns
 * the severity that fired on THIS scan's rising edge, or `null`:
 *
 *   • Entering the warn band from none      → 'warn' (once).
 *   • Entering the critical band            → 'critical' (once) — including a
 *     warn→critical escalation (tiered re-fire).
 *   • Staying in the same band              → null (no re-fire — the bug a pure
 *     time-dedupe would reproduce).
 *   • Dropping to a lower band (incl. none) → null, and the latch de-escalates
 *     so re-entering a band fires it again.
 *
 * A jump straight to critical fires 'critical' only (it is already past warn).
 */
export class SessionSizeTracker {
  private tier: 0 | 1 | 2 = 0

  /** Current latched tier (0 none / 1 warn / 2 critical) — test introspection. */
  get latchedTier(): 0 | 1 | 2 {
    return this.tier
  }

  evaluate(size: number): SizeSeverity | null {
    const next = tierRank(size)
    const prev = this.tier
    this.tier = next
    if (next > prev) return next === 2 ? 'critical' : 'warn'
    return null
  }

  /** Force the latch back to none (used when the mid-compact lock clears, so the
   *  post-compaction size can re-fire cleanly if it climbs again). */
  reset(): void {
    this.tier = 0
  }
}

export interface SessionSizeWatchdogDeps {
  /** Read the session's POST-COMPACT JSONL byte size, or null if unreadable.
   *  Production wraps `measurePostCompactSize(sessionJsonlPath(...))`. */
  readSize: () => number | null
  /** Surface the warn/critical affordance (Reset / Compact / Snooze). Called
   *  ONLY on a rising edge into a band. The substrate routes this to the active
   *  turn channel + an operator log; a gateway can wire a richer affordance. */
  surface: (severity: SizeSeverity, sizeBytes: number) => void
  /** Send one structured key to the PTY child (the `escape` of the Compact
   *  action). Production: `(k) => child.writeKey?.(k) ?? child.write(encodeKey(k))`. */
  writeKey: (key: Key) => void
  /** Raw write to the PTY child (the `/compact\r` of the Compact action). */
  write: (data: string) => void
  /** Cadence in ms. Default {@link DEFAULT_SIZE_CHECK_INTERVAL_MS} (5 min). */
  intervalMs?: number
  /** Min ms between Compact actuations. Default {@link DEFAULT_COMPACT_DEBOUNCE_MS}. */
  compactDebounceMs?: number
  /** DI: setInterval shim (tests advance the clock manually). */
  setIntervalFn?: (cb: () => void, ms: number) => unknown
  /** DI: clearInterval shim; accepts whatever setIntervalFn returned. */
  clearIntervalFn?: (handle: unknown) => void
  /** DI: monotonic-ish clock (ms). Default Date.now. */
  now?: () => number
  /** Called if a tick body throws (it shouldn't — readSize swallows). Default
   *  logs to stderr. */
  onError?: (err: unknown) => void
}

export interface SessionSizeWatchdog {
  /** Stop the cadence tick. Idempotent. */
  stop(): void
  /**
   * Actuate the Compact affordance: `writeKey('escape')` THEN `write('/compact\r')`,
   * fire-once. Sets the mid-compact LOCK (stamped BEFORE the writes — invariant
   * §4) so the tick skips alerting until the new summary marker lands and the
   * post-compact size drops below the warn band. Returns true iff it fired
   * (false if a compaction is already mid-flight or within the debounce floor).
   */
  requestCompact(): boolean
  /** True while the mid-compact lock is held (test/introspection). */
  isCompacting(): boolean
  /** Run one tick synchronously (test/introspection — the cadence calls this). */
  tick(): void
}

/**
 * Start the session-size watchdog. Every `intervalMs` it measures the
 * post-compact JSONL size and, on a rising edge into the warn/critical band,
 * calls `surface`. While a compaction it actuated is mid-flight (the lock),
 * alerting is suppressed (the grow-before-marker window); the lock clears once
 * the post-compact size drops back below the warn band (the summary marker
 * landed), and the tiered latch resets so a fresh climb re-fires cleanly.
 */
export function startSessionSizeWatchdog(deps: SessionSizeWatchdogDeps): SessionSizeWatchdog {
  const intervalMs = deps.intervalMs ?? DEFAULT_SIZE_CHECK_INTERVAL_MS
  const compactDebounceMs = deps.compactDebounceMs ?? DEFAULT_COMPACT_DEBOUNCE_MS
  const now = deps.now ?? Date.now
  const setIntervalFn =
    deps.setIntervalFn ?? ((cb: () => void, ms: number) => globalThis.setInterval(cb, ms))
  const clearIntervalFn =
    deps.clearIntervalFn ??
    ((h: unknown) => globalThis.clearInterval(h as Parameters<typeof globalThis.clearInterval>[0]))
  const onError =
    deps.onError ??
    ((err: unknown) =>
      process.stderr.write(
        `[session-size] tick error: ${err instanceof Error ? err.message : String(err)}\n`,
      ))

  const tracker = new SessionSizeTracker()
  let compacting = false
  let lastCompactAt = -Infinity

  const tick = (): void => {
    try {
      const size = deps.readSize()
      if (size === null) return // no transcript yet / unreadable → skip (truth-on-disk)
      if (compacting) {
        // PreCompact lock held: a compaction we actuated is mid-flight. Skip
        // alerting during the grow-before-marker window. Clear the lock once the
        // post-compact region has shrunk below the warn band — that means the
        // new `"isCompactSummary":true` marker landed and the live context is
        // small again. Reset the tiered latch so a subsequent climb re-fires.
        if (size < SIZE_WARN_BYTES) {
          compacting = false
          tracker.reset()
        }
        return
      }
      const fired = tracker.evaluate(size)
      if (fired !== null) deps.surface(fired, size)
    } catch (err) {
      onError(err)
    }
  }

  const requestCompact = (): boolean => {
    if (compacting) return false // a compaction is already mid-flight
    const t = now()
    if (t - lastCompactAt < compactDebounceMs) return false
    // STAMP THE LOCK + DEBOUNCE BEFORE THE WRITES (invariant §4): a transport-
    // level write failure must NOT leave us un-locked and able to re-actuate
    // next press, double-sending `/compact` into the REPL.
    compacting = true
    lastCompactAt = t
    deps.writeKey('escape')
    deps.write('/compact\r')
    return true
  }

  const handle = setIntervalFn(tick, intervalMs)
  // Don't let the cadence timer keep the Bun event loop alive on its own — the
  // session it watches owns its lifetime; `stop()` (session death/teardown) is
  // the authoritative clear. Mirrors the supervision timers' lifecycle.
  ;(handle as { unref?: () => void })?.unref?.()

  let stopped = false
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      clearIntervalFn(handle)
    },
    requestCompact,
    isCompacting: () => compacting,
    tick,
  }
}
