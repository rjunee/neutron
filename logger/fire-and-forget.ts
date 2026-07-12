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
  // the F3 lint rule allowlists. `.catch(...)` returns a promise that always
  // resolves (the handler never throws), so voiding it is safe.
  void p.catch((err: unknown) => {
    rejectionCount += 1
    getFafLogger().error('rejected', { name, error: describeRejection(err) })
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

// ---------------------------------------------------------------------------
// Process-level safety net — one unhandledRejection + uncaughtException logger.
// ---------------------------------------------------------------------------

type RejectionHandler = (reason: unknown) => void
type ExceptionHandler = (err: Error) => void

let installedRejectionHandler: RejectionHandler | undefined
let installedExceptionHandler: ExceptionHandler | undefined

export interface ProcessSafetyNetOptions {
  /**
   * Called after logging an `uncaughtException` to end the process. Injectable
   * for tests. Defaults to `() => process.exit(1)` — EXCEPT under
   * `NODE_ENV === 'test'`, where the default is a no-op so a boot inside the
   * test runner cannot kill the whole suite.
   */
  onUncaught?: (err: Error) => void
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
 * POLICY:
 *   - `unhandledRejection` → LOG at `error` level, do NOT exit. A single stray
 *     rejected promise should not tear down a long-lived server; visibility is
 *     the win. (This is the last-resort net for any rejection that escaped a
 *     `fireAndForget` wrap.)
 *   - `uncaughtException` → LOG at `error` level, then CRASH via `onUncaught`
 *     (default `process.exit(1)`, suppressed under NODE_ENV=test). Never
 *     swallowed.
 */
export function installProcessSafetyNet(options?: ProcessSafetyNetOptions): void {
  if (installedRejectionHandler !== undefined) return

  const log = createLogger('process')
  const onUncaught = options?.onUncaught ?? defaultOnUncaught

  const onRejection: RejectionHandler = (reason) => {
    log.error('unhandled_rejection', { error: describeRejection(reason) })
  }
  const onException: ExceptionHandler = (err) => {
    log.error('uncaught_exception', { error: describeRejection(err) })
    onUncaught(err)
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
