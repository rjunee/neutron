/**
 * @neutronai/logger — `fireAndForget` + the process-level safety net (refactor F3).
 *
 * The repo had ~30 bare `void somePromise(…)` fire-and-forget sites and NO
 * process-level rejection/exception handler anywhere. A voided promise that
 * rejects is SILENTLY swallowed — the failure never surfaces. These two
 * helpers make those failures VISIBLE without changing the fire-and-forget
 * SEMANTICS (the rejection is still not propagated to the caller — it is only
 * LOGGED, and a counter is bumped).
 *
 * `fireAndForget(name, p)` — attach a `.catch` that LOGS `name` + the error and
 * increments a process-wide counter, then swallows. It NEVER rethrows, so it is
 * safe to wrap the "principled" voids the refactor plan calls out — prewarm
 * paths (which never reject) and scribe hot-path isolation (where a rejection
 * must NOT propagate into the hot path). Wrapping them only adds visibility.
 *
 * `installProcessSafetyNet()` — install ONE `unhandledRejection` +
 * `uncaughtException` logger per process (idempotent). See its doc for the
 * uncaughtException log-then-crash policy.
 */

import { createLogger, type Logger } from './index'

/**
 * Render an unknown thrown/rejected value for a log field. An `Error` yields
 * its stack (falling back to the message) so the failure is diagnosable; any
 * other value is stringified. Kept defensive — a thrown non-Error (or an
 * object whose `String()` itself throws) must never break the logger.
 */
export function describeRejection(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
  try {
    return String(err)
  } catch {
    return '<unstringifiable rejection>'
  }
}

// Process-wide count of fire-and-forget rejections observed. A monotonic
// visibility metric (the refactor plan's "increments a counter"); anything
// wanting a real gauge can read it via `fireAndForgetRejectionCount()`.
let rejectionCount = 0

// Lazily constructed on first rejection. Must NOT call `createLogger` at
// module-eval time: `./index` re-exports this file from ABOVE its
// `createLogger` definition, so a top-level call here would hit `createLogger`
// in its temporal dead zone during the circular init.
let fafLogger: Logger | undefined
function getFafLogger(): Logger {
  return (fafLogger ??= createLogger('fire-and-forget'))
}

/**
 * Log a fire-and-forget rejection WITHOUT ever throwing. The primary sink is the
 * structured logger; if IT throws (a broken/exhausted/DI-swapped sink), fall
 * back to a raw `console.error`, and if even that throws, swallow. The safety
 * guarantee of `fireAndForget` — "the attached `.catch` never rejects" — must
 * hold regardless of the log sink's behavior, or the wrapper would itself become
 * the unhandled rejection it exists to prevent.
 */
function logRejectionSafely(name: string, err: unknown): void {
  try {
    getFafLogger().error('rejected', { name, error: describeRejection(err) })
  } catch (logErr) {
    try {
      console.error('[fire-and-forget] log sink threw', {
        name,
        error: describeRejection(err),
        logError: describeRejection(logErr),
      })
    } catch {
      /* even console.error threw — nothing safe left to do; swallow */
    }
  }
}

/**
 * Run a promise fire-and-forget with its rejection made VISIBLE. Attaches a
 * `.catch` that logs `name` + the error at `error` level and bumps the
 * process-wide rejection counter. The attached handler NEVER rethrows, so the
 * returned-and-ignored promise can never itself become an unhandled rejection
 * and the caller's control flow is unaffected — identical fire-and-forget
 * semantics to a bare `void p`, minus the silent swallow.
 *
 * @param name  a short, descriptive site name (e.g. `'scribe.persistDaily'`) —
 *              logged verbatim so a rejection is traceable to its origin.
 * @param p     the promise to run and forget. `null` / `undefined` are accepted
 *              and no-op — mirroring the `void maybePromise` idiom this replaces
 *              (a maybe-absent promise has nothing to forget).
 */
export function fireAndForget(name: string, p: Promise<unknown> | null | undefined): void {
  if (p == null) return
  // The ONE sanctioned `void <promise>` in the repo: this file is the wrapper
  // the F3 lint rule allowlists. The `.catch(...)` handler is GUARDED
  // (`logRejectionSafely` never throws — even a broken log sink is contained),
  // so the returned promise ALWAYS resolves and voiding it can never itself
  // become an unhandled rejection. That is the whole point of the wrapper.
  void p.catch((err: unknown) => {
    rejectionCount += 1
    logRejectionSafely(name, err)
  })
}

/** Process-wide count of fire-and-forget rejections observed so far. */
export function fireAndForgetRejectionCount(): number {
  return rejectionCount
}

/** TEST-ONLY: reset the fire-and-forget rejection counter. */
export function resetFireAndForgetCountForTests(): void {
  rejectionCount = 0
}

/**
 * Neutralize the late settle of a DELIBERATELY-ABANDONED promise so it can
 * never become an unhandled rejection — WITHOUT logging or counting.
 *
 * This is NOT fire-and-forget: use it ONLY where the caller has already moved
 * on (a watchdog won a race, a ceiling aborted the pull, teardown after the
 * terminal outcome was captured) so the promise's eventual resolve/reject is
 * by definition irrelevant. Routing these through `fireAndForget` would spam
 * the error log with EXPECTED abort settles on a hot path; a genuine bug in an
 * abandoned computation is moot because nothing consumes its result. The ONLY
 * job here is to attach a handler so V8 doesn't report an unhandled rejection.
 *
 * Distinct from `fireAndForget`, which is for a fire-and-forget op whose
 * failure IS worth surfacing (logged + counted).
 */
export function neutralizeAbandonedSettle(p: Promise<unknown> | null | undefined): void {
  if (p == null) return
  // Sanctioned `void <promise>` (this is the allowlisted wrapper file): the
  // `.catch` swallows the abandoned settle and never throws, so voiding the
  // returned always-resolved promise is safe.
  void p.catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Process-level safety net — one unhandledRejection + uncaughtException logger.
// ---------------------------------------------------------------------------

type RejectionHandler = (reason: unknown) => void
type ExceptionHandler = (err: Error) => void

let installedRejectionHandler: RejectionHandler | undefined
let installedExceptionHandler: ExceptionHandler | undefined

export interface ProcessSafetyNetOptions {
  /**
   * Called after logging an `uncaughtException` OR an `unhandledRejection` to
   * end the process. Injectable for tests. Defaults to `() => process.exit(1)`
   * — EXCEPT under `NODE_ENV === 'test'`, where the default is a no-op so a boot
   * inside the test runner cannot kill the whole suite. Receives the raw
   * exception / rejection reason (which may not be an `Error`).
   */
  onUncaught?: (err: unknown) => void
}

function defaultOnUncaught(): void {
  // Log-then-CRASH. An uncaught exception leaves the process in an undefined
  // state (partially-mutated globals, half-open resources); continuing would
  // be worse than restarting, and swallowing it silently is exactly the bug
  // this unit removes. Exiting non-zero matches Node's own default crash
  // behavior — we only add a loud, structured log first, so a systemd
  // Restart=always brings the process back clean. Suppressed under
  // NODE_ENV=test (bun test sets this) so a boot in-process during the suite
  // logs but does not tear the runner down.
  if (process.env['NODE_ENV'] !== 'test') process.exit(1)
}

/**
 * Install the process-level `unhandledRejection` + `uncaughtException` loggers
 * ONCE. Idempotent: a second call (e.g. a second `boot()` in tests) is a no-op,
 * so the process never accumulates duplicate listeners.
 *
 * POLICY — both handlers LOG-THEN-CRASH, preserving the runtime's fatal
 * default while adding a loud, structured log first:
 *   - `unhandledRejection` → LOG at `error`, then CRASH via `onUncaught`
 *     (default `process.exit(1)`, suppressed under NODE_ENV=test). This is
 *     deliberately fail-fast: EVERY known-benign fire-and-forget is already
 *     wrapped (`fireAndForget` / `neutralizeAbandonedSettle` swallow before the
 *     global handler can ever see them), so a rejection that reaches THIS
 *     handler is genuinely unexpected and leaves the process in an unknown
 *     state — exiting non-zero matches the runtime's own default (an unhandled
 *     rejection exits 1) and a systemd Restart=always brings it back clean.
 *   - `uncaughtException` → LOG at `error`, then CRASH via `onUncaught`. Same
 *     policy; an uncaught exception likewise leaves the process undefined.
 *   Neither is ever swallowed, and the crash decision sits in a `finally` so a
 *   throwing log sink can never skip it.
 */
export function installProcessSafetyNet(options?: ProcessSafetyNetOptions): void {
  if (installedRejectionHandler !== undefined) return

  const log = createLogger('process')
  const onUncaught = options?.onUncaught ?? defaultOnUncaught

  // Both handlers guard their logging: a throwing log sink must never turn the
  // safety net into a new fault. The crash decision sits in a `finally`, so a
  // logging failure can NEVER skip the log-then-crash policy (`onUncaught` —
  // default `process.exit(1)`).
  const logSafely = (event: string, err: unknown): void => {
    try {
      log.error(event, { error: describeRejection(err) })
    } catch (logErr) {
      try {
        console.error(`[process] ${event} (log sink threw)`, {
          error: describeRejection(err),
          logError: describeRejection(logErr),
        })
      } catch {
        /* swallow — nothing safe left to do */
      }
    }
  }

  const onRejection: RejectionHandler = (reason) => {
    try {
      logSafely('unhandled_rejection', reason)
    } finally {
      onUncaught(reason)
    }
  }
  const onException: ExceptionHandler = (err) => {
    try {
      logSafely('uncaught_exception', err)
    } finally {
      onUncaught(err)
    }
  }

  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)
  installedRejectionHandler = onRejection
  installedExceptionHandler = onException
}

/** Whether {@link installProcessSafetyNet} has installed its handlers. */
export function isProcessSafetyNetInstalled(): boolean {
  return installedRejectionHandler !== undefined
}

/** TEST-ONLY: remove the installed handlers so the guard can be re-armed. */
export function resetProcessSafetyNetForTests(): void {
  if (installedRejectionHandler !== undefined) {
    process.off('unhandledRejection', installedRejectionHandler)
    installedRejectionHandler = undefined
  }
  if (installedExceptionHandler !== undefined) {
    process.off('uncaughtException', installedExceptionHandler)
    installedExceptionHandler = undefined
  }
}
