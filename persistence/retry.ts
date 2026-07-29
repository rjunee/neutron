import { BusyRetryExhaustedError } from './errors.ts'

// Algorithmic shape ports from Hermes' hermes_state.py:118-130 concurrency
// tuning: short SQLite-internal busy_timeout + jittered application-level
// retries to avoid the convoy effect SQLite's deterministic busy handler
// causes under contention.
//
// Two adaptations from Hermes (rationale on each):
//
// 1. busy_timeout = 100 ms (Hermes used 1000 ms). SQLite's busy_timeout is a
//    SYNCHRONOUS C-level sleep — it pins the Bun event loop while it waits.
//    Per-instance Neutron processes have one project DB each, so contention is
//    much lighter than Hermes' multi-process Python case where the GIL plus
//    long-running CLI workers justified a longer wait. With a 5-second
//    gateway watchdog tick (and a 10 s WatchdogSec on the systemd unit), a
//    1-second busy_timeout pinned per attempt is enough to starve the tick
//    under heavy contention. 100 ms keeps each attempt's blocked window
//    bounded; the jittered retry layer below absorbs longer real outages.
//
// 2. `withBusyRetry` is ASYNC, sleeping with `await Bun.sleep` instead of
//    `Bun.sleepSync`. Hermes is synchronous Python with multi-process
//    contention; Bun is single-process async-first. `Bun.sleepSync` blocks
//    the event loop, which would prevent the gateway's setInterval-driven
//    watchdog tick from firing during a contention window — systemd would
//    then kill a healthy gateway. `await Bun.sleep` yields to the event
//    loop between attempts so the watchdog tick keeps firing.
//
// Worst-case retry-loop wall time:
//   15 attempts × (100 ms busy_timeout + 100 ms jitter) ≈ 3 s,
//   of which the BLOCKING portion is at most 100 ms per attempt.
// That fits comfortably inside the 10 s WatchdogSec budget while still
// letting the watchdog tick fire at its 5 s cadence (the tick lands during
// one of the async sleep yields).

export const WRITE_MAX_RETRIES = 15 as const
export const WRITE_RETRY_MIN_MS = 20 as const
export const WRITE_RETRY_MAX_MS = 100 as const
export const BUSY_TIMEOUT_MS = 100 as const

const SQLITE_BUSY_PATTERNS: ReadonlyArray<RegExp> = [
  /SQLITE_BUSY/i,
  /database is locked/i,
  /\bbusy\b/i,
]

export function isBusyError(err: unknown): boolean {
  // Reject our own exhaustion wrapper so an outer `withBusyRetry` (e.g. the
  // one around `ProjectDb.transaction`'s BEGIN/COMMIT) does NOT replay a body
  // whose inner `ProjectDb.run` already burned its full retry budget. Without
  // this guard the message-substring regex below would match
  // `BusyRetryExhaustedError`'s "SQLITE_BUSY: exhausted N retries" and the
  // outer loop would re-run the callback up to 15 more times.
  if (err instanceof BusyRetryExhaustedError) return false
  if (err === null || typeof err !== 'object') return false
  const message = (err as { message?: unknown }).message
  if (typeof message !== 'string') return false
  return SQLITE_BUSY_PATTERNS.some((re) => re.test(message))
}

function jitterMs(): number {
  const span = WRITE_RETRY_MAX_MS - WRITE_RETRY_MIN_MS
  return WRITE_RETRY_MIN_MS + Math.random() * span
}

// F4 — process-wide count of busy-retry EXHAUSTIONS (a `withBusyRetry` that
// burned its full budget and threw). This is the source the watchdog's
// `db_lock_contention` detector reads (`watchdog/detectors.ts` `BusyRetryCounter`
// via a monotonic-count delta over a window): a rising exhaustion count means
// SQLite write contention is starving the write path. It is a pure observability
// counter — it never changes the retry decision or throws.
let busyRetryExhaustionTotal = 0

/** Monotonic count of busy-retry exhaustions since process start (F4 watchdog). */
export function busyRetryExhaustionCount(): number {
  return busyRetryExhaustionTotal
}

/**
 * Run a synchronous DB operation with jittered retry on SQLITE_BUSY. The
 * callback itself is sync (`bun:sqlite` is sync), but the retry loop yields
 * to the event loop between attempts via `await Bun.sleep` so concurrent
 * timers — most importantly the gateway's watchdog tick — keep firing
 * during a contention window.
 *
 * Throws `BusyRetryExhaustedError` after `WRITE_MAX_RETRIES` attempts,
 * preserving the original error as `cause`. Non-busy errors propagate
 * immediately on first throw.
 */
export async function withBusyRetry<T>(fn: () => T): Promise<T> {
  let lastErr: unknown = undefined
  for (let attempt = 0; attempt <= WRITE_MAX_RETRIES; attempt++) {
    try {
      return fn()
    } catch (err) {
      if (!isBusyError(err)) throw err
      lastErr = err
      if (attempt < WRITE_MAX_RETRIES) {
        await Bun.sleep(jitterMs())
      }
    }
  }
  busyRetryExhaustionTotal++
  throw new BusyRetryExhaustedError(WRITE_MAX_RETRIES, lastErr)
}
