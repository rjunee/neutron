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
 * Run a promise fire-and-forget with its rejection made VISIBLE + NON-FATAL.
 * Attaches a `.catch` that logs `name` + the error at `error` level and bumps
 * the process-wide rejection counter, then swallows. The handler NEVER rethrows,
 * so the returned-and-ignored promise can never itself become an unhandled
 * rejection and the caller's control flow is unaffected.
 *
 * POLICY — this is DELIBERATELY non-fatal, and is NOT semantically identical to
 * a bare `void p`: in Bun a bare `void Promise.reject()` is an unhandled
 * rejection that EXITS the process (fatal), whereas `fireAndForget` logs +
 * counts + swallows (the process survives). That is the intended design — a
 * promise a developer EXPLICITLY voided is genuine fire-and-forget work that
 * should be made visible, not tear down a long-lived server. The complementary
 * fatal backstop is the process-level safety net
 * ({@link installProcessSafetyNet}, log-then-crash): it catches any rejection
 * that ESCAPES a wrap — i.e. genuinely unexpected. So: KNOWN fire-and-forget
 * work → visible + soft (here); UNKNOWN / escaped rejection → fatal (the net).
 * If a specific site's failure breaks an invariant such that continuing is
 * dangerous, it is NOT fire-and-forget — either don't wrap it, or pass `onError`
 * to escalate (e.g. trigger a supervised restart / `process.exit`).
 *
 * @param name    a short, descriptive site name (e.g. `'scribe.persistDaily'`) —
 *                logged verbatim so a rejection is traceable to its origin.
 * @param p       the promise (or any `PromiseLike`/thenable) to run and forget.
 *                `null` / `undefined` are accepted and no-op — mirroring the
 *                `void maybePromise` idiom this replaces. Accepting `PromiseLike`
 *                (not just `Promise`) reconciles the wrapper with the lint gate,
 *                which flags ANY promise-typed void including a `.catch`-less
 *                standards thenable.
 * @param onError OPTIONAL per-site handler for contextual logging / cleanup on
 *                rejection. Runs AFTER the structured count+log, so a site never
 *                needs a pre-wrapper `.catch` (which would swallow the rejection
 *                before the wrapper could count it — the F3 "pre-swallow" bug the
 *                gate now bans). GUARDED: a throwing `onError` is contained, so
 *                it can never turn the safety path into an unhandled rejection.
 *                It must be synchronous-safe — a returned promise is NOT awaited,
 *                so do async cleanup via a nested `fireAndForget`.
 */
export function fireAndForget(
  name: string,
  p: PromiseLike<unknown> | null | undefined,
  onError?: (err: unknown) => unknown,
): void {
  if (p == null) return
  // The ONE sanctioned `void <promise>` in the repo: this file is the wrapper
  // the F3 lint rule allowlists. `Promise.resolve(p)` normalizes ANY thenable —
  // including a `PromiseLike` with no `.catch` — to a real Promise, so `.catch`
  // is always callable (a bare `p.catch` would throw on such a thenable). The
  // handler is GUARDED (`logRejectionSafely` never throws — even a broken log
  // sink is contained), so the returned promise ALWAYS resolves and voiding it
  // can never itself become an unhandled rejection. That is the whole point.
  void Promise.resolve(p).catch((err: unknown) => {
    rejectionCount += 1
    logRejectionSafely(name, err)
    if (onError !== undefined) runOnErrorSafely(onError, err)
  })
}

/**
 * Invoke a best-effort `onError` callback so it can NEVER break the safety path:
 * a SYNC throw is caught, and — because `onError` may be `async` (returning a
 * promise even against a `void`-return-typed slot) — a returned thenable's
 * REJECTION is swallowed too. `onError` is contextual side-effect only, NOT part
 * of the reliability guarantee; its own failures are intentionally dropped.
 */
function runOnErrorSafely(onError: (err: unknown) => unknown, err: unknown): void {
  try {
    const r = onError(err)
    if (r != null && typeof (r as { then?: unknown }).then === 'function') {
      void Promise.resolve(r as PromiseLike<unknown>).catch(() => undefined)
    }
  } catch {
    /* GUARDED — a sync-throwing onError must never break the safety path */
  }
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
export function neutralizeAbandonedSettle(p: PromiseLike<unknown> | null | undefined): void {
  if (p == null) return
  // Sanctioned `void <promise>` (this is the allowlisted wrapper file).
  // `Promise.resolve(p)` normalizes ANY thenable (incl. a `.catch`-less
  // `PromiseLike`) to a real Promise; the `.catch` swallows the abandoned settle
  // and never throws, so voiding the returned always-resolved promise is safe.
  void Promise.resolve(p).catch(() => undefined)
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
 *
 * STATIC-IMPORT COVERAGE (F3) — a module's `import` statements RESOLVE +
 * EVALUATE before any BODY statement runs, so calling this as the first body
 * statement of an entrypoint covers everything from the body onward but NOT a
 * failure in THAT entry module's OWN static-import evaluation (a missing
 * dependency / throwing module-init in its top-level `import` graph). Where the
 * import graph warrants it — the SPAWNED MCP processes, whose static graph
 * includes an external SDK — the entry uses BOOTSTRAP-INDIRECTION: a thin loader
 * (`runtime/adapters/claude-code/persistent/{tools-bridge,dev-channel}.ts`)
 * whose only static import is this stable logger leaf arms the net, then
 * DYNAMICALLY imports the real body (`*-impl.ts`), so the body's whole static
 * graph evaluates AFTER the net is armed. For the DUAL library-export + entry
 * modules (`gateway/index.ts`, `open/server.ts`, and the CLIs
 * `landing/boot.ts`, `gbrain-doctor.ts`, `diagnostics-cli.ts`,
 * `migrations/runner.ts`) a bootstrap split would churn their exporters, and
 * their failure-prone loads (composer/config/db) already run in the BODY (after
 * this install) — only their own top-level imports of STABLE INTERNAL modules
 * are the residual, an accepted inherent limitation of in-module installation.
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
