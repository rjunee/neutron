/**
 * @neutronai/runtime — the SINGLE substrate-stream drain-to-text (O8 leaf).
 *
 * O8 (2026-07, lane substrate) — before this file there were ~8 near-duplicate
 * copies of the `for await (const ev of handle.events) { …classify… }` loop
 * scattered across the codebase (`collectTokensToString`, scribe/reflection's
 * `drainToString`, the agent-dispatch turn runner, the email Core caller, the
 * trident closures, the gateway substrate builders). Each had drifted a little:
 * a different error-prose prefix, a watchdog abort, a "throw vs. capture" split,
 * an email STUB-THROW on a missing completion. O8 folds the ONE drain loop into
 * `drainToOutcome` here and preserves every divergence as a POLICY FLAG rather
 * than a fork, so there is exactly one place to reason about iterator semantics.
 *
 * Error classification REUSES O3's typed taxonomy (`SubstrateCallError` /
 * `SUBSTRATE_ERROR_CODES` in `./errors.ts`): a terminal `error` event is turned
 * into a `SubstrateCallError` carrying the event's `code` / `retryable` /
 * `retry_after_ms` VERBATIM, with the message prose preserved byte-identical (via
 * `errorPrefix`) so the one-release message-regex fallbacks in the gateway
 * classifiers stay green. No new classifier is invented here.
 *
 * ── The load-bearing correctness invariant (do not break) ────────────────────
 * The Claude-Code persistent-REPL adapter's EventChannel has NO finally/cancel
 * hookup: calling `handle.cancel()` on an UNSETTLED turn POISONS the warm session
 * (see `runtime/adapters/claude-code/persistent/pool.ts` `cancel()` — the
 * `if (… && !t.settled) session.poisoned = true` branch). So the DEFAULT drain
 * path here iterates to a TERMINAL event (completion/error) and never early-
 * cancels a live turn. Teardown (`iterator.return()` → the adapter's `cancel()`)
 * runs ONLY after a terminal event was observed — i.e. once the adapter has
 * marked the turn `settled`, at which point `cancel()`'s `!t.settled` guard makes
 * it a no-op for the poison flag. The only path that cancels a still-running turn
 * is an EXPLICIT `keepAliveExempt` watchdog abort (scribe/reflection/collect-
 * tokens), which WANTS the abandon-poison so the next dispatch respawns a clean
 * REPL. That divergence is opt-in via a flag, never the default.
 */

import type { Event } from './events.ts'
import type { SessionHandle } from './session-handle.ts'
import { SubstrateCallError } from './errors.ts'

/** How a terminal `error` event (or a mid-drain watchdog abort) is surfaced. */
export type DrainErrorMode =
  /** Throw a `SubstrateCallError` (the string-returning `drainToText` default). */
  | 'throw'
  /** Never throw for a substrate error/abort — return it on the outcome so the
   *  caller maps it onto its own terminal status (agent-dispatch, trident). */
  | 'capture'

/** Why the drain stopped. */
export type DrainStatus =
  /** A terminal `completion` event was observed (the turn settled cleanly). */
  | 'completed'
  /** The iterator ended WITHOUT a terminal completion (paused / stubbed stream). */
  | 'exhausted'
  /** A terminal `error` event, or the iterator threw (transport/cancel). */
  | 'error'
  /** The `signal` fired mid-drain (watchdog abort). */
  | 'aborted'

/**
 * Policy flags for {@link drainToOutcome} / {@link drainToText}. Every historical
 * per-site divergence maps to exactly one flag here (a flag, not a fork):
 *
 * - watchdog abort  → `signal` + `onAbort` + `keepAliveExempt`
 * - throw vs capture → `treatErrorAs`
 * - email stub-throw → `requireCompletion` (+ `exhaustedMessage`)
 * - onFirstToken ack → `onFirstToken`
 * - per-site prose   → `errorPrefix` / `abortMessage` / `abortBeforeDispatchMessage`
 */
export interface DrainOptions {
  /** Watchdog signal. When it fires mid-drain the drain stops with `aborted`. */
  signal?: AbortSignal
  /** Fired once when `signal` aborts (before the drain returns/throws). */
  onAbort?: () => void
  /** Fired once, the instant the FIRST non-empty `token` arrives (cold-start ack
   *  cancellation — FIX #347). Never allowed to break the drain if it throws. */
  onFirstToken?: () => void
  /** Prepended to a terminal `error` event's message when building the
   *  `SubstrateCallError` (byte-identical to the pre-O8 per-site prose). */
  errorPrefix?: string
  /** Message for a mid-drain watchdog abort. */
  abortMessage?: string
  /** Message when `signal` was ALREADY aborted at entry (before dispatch).
   *  Defaults to `abortMessage`. */
  abortBeforeDispatchMessage?: string
  /** Message when the iterator ends without a completion AND `requireCompletion`
   *  is set. Prefixed with `errorPrefix`. */
  exhaustedMessage?: string
  /** How to surface a terminal error / abort. Default `'throw'`. */
  treatErrorAs?: DrainErrorMode
  /** When true, a stream that ENDS without a terminal completion is a failure
   *  (the email Core's STUB-THROW-BY-DESIGN). Default `false` → `exhausted`. */
  requireCompletion?: boolean
  /** Return the moment a `completion` event is seen (default `true`). When
   *  `false`, keep pulling until the iterator ends naturally — the email Core's
   *  "let the iterator's finally tear down the fetch" preference. Either way is
   *  poison-safe: `completion` is terminal, so the turn is already settled. */
  stopOnCompletion?: boolean
  /** EXEMPT this drain from the keep-warm default: on a watchdog abort, CALL
   *  `handle.cancel()` (intentionally abandon-poisoning a warm CC session so the
   *  next dispatch respawns clean). Default `false` — a default drain NEVER
   *  cancels a live turn mid-flight (see the file header's poison invariant). */
  keepAliveExempt?: boolean
}

/** Terminal result of a drain. `error` is set for `status` `'error'`/`'aborted'`. */
export interface DrainOutcome {
  /** Accumulated assistant `token` text (partial on a non-`completed` status). */
  text: string
  status: DrainStatus
  error?: SubstrateCallError
}

const abortError = (message: string): SubstrateCallError =>
  new SubstrateCallError(message, { code: 'aborted', retryable: false })

const errorEventError = (
  ev: Extract<Event, { kind: 'error' }>,
  prefix: string,
): SubstrateCallError =>
  new SubstrateCallError(`${prefix}${ev.message}`, {
    ...(ev.code !== undefined ? { code: ev.code } : {}),
    retryable: ev.retryable,
    ...(ev.retry_after_ms !== undefined ? { retry_after_ms: ev.retry_after_ms } : {}),
  })

/**
 * THE drain loop. Pulls the substrate `Event` stream, accumulating `token` text
 * until a terminal event, and returns a {@link DrainOutcome} — it NEVER throws
 * for a substrate error or abort (that policy lives in {@link drainToText}); it
 * throws only for a genuinely unexpected internal fault.
 *
 * Manually drives the async iterator (rather than `for await` + `break`) so the
 * drain fully controls teardown: `iterator.return()` (→ the adapter's `cancel()`)
 * is invoked ONLY after a terminal event settled the turn, keeping the warm-CC
 * poison invariant (file header) intact.
 */
export async function drainToOutcome(
  handle: SessionHandle,
  opts: DrainOptions = {},
): Promise<DrainOutcome> {
  const {
    signal,
    onAbort,
    onFirstToken,
    errorPrefix = '',
    abortMessage = 'substrate drain: aborted',
    abortBeforeDispatchMessage = abortMessage,
    keepAliveExempt = false,
    stopOnCompletion = true,
  } = opts

  // Already aborted before we pulled a single event: never even start iterating.
  if (signal?.aborted === true) {
    onAbort?.()
    if (keepAliveExempt) await handle.cancel().catch(() => undefined)
    return { text: '', status: 'aborted', error: abortError(abortBeforeDispatchMessage) }
  }

  const iter = handle.events[Symbol.asyncIterator]()
  let text = ''
  let firstTokenSeen = false
  // `settled` = a TERMINAL event (completion/error) was observed from the stream,
  // so `iterator.return()` in the finally is a poison-free teardown of a session
  // the adapter has already marked settled. It stays false on an abort/external-
  // cancel exit, where we must NOT return() (the keepAliveExempt watchdog already
  // issued cancel() if it wanted the abandon-poison; a default drain issues none).
  let settled = false
  let aborted = false

  // Abort plumbing: a sentinel promise so an in-flight `iter.next()` never blocks
  // the drain from noticing the watchdog fired.
  const ABORTED: unique symbol = Symbol('aborted')
  let resolveAbort: ((v: typeof ABORTED) => void) | undefined
  const abortPromise =
    signal !== undefined
      ? new Promise<typeof ABORTED>((resolve) => {
          resolveAbort = resolve
        })
      : undefined
  const onSignalAbort = (): void => {
    aborted = true
    onAbort?.()
    if (keepAliveExempt) void handle.cancel().catch(() => undefined)
    resolveAbort?.(ABORTED)
  }
  if (signal !== undefined) signal.addEventListener('abort', onSignalAbort, { once: true })

  try {
    for (;;) {
      if (aborted) return { text, status: 'aborted', error: abortError(abortMessage) }

      const nextP = iter.next()
      let res: IteratorResult<Event> | typeof ABORTED
      try {
        res =
          abortPromise !== undefined
            ? await Promise.race([nextP, abortPromise])
            : await nextP
      } catch (err) {
        // The iterator threw — an external `cancel()` (timeout timer) or a
        // transport fault. A concurrent watchdog abort wins the classification.
        if (aborted) return { text, status: 'aborted', error: abortError(abortMessage) }
        return {
          text,
          status: 'error',
          error:
            err instanceof SubstrateCallError
              ? err
              : new SubstrateCallError(
                  `${errorPrefix}${err instanceof Error ? err.message : String(err)}`,
                  { retryable: false, cause: err },
                ),
        }
      }

      if (res === ABORTED) {
        // The watchdog won the race against a pending pull. Swallow that pull's
        // eventual settle so a late resolve/reject is never an unhandled rejection.
        // We deliberately do NOT call iter.return() here (see `settled`).
        void nextP.catch(() => undefined)
        return { text, status: 'aborted', error: abortError(abortMessage) }
      }

      if (res.done === true) {
        if (aborted) return { text, status: 'aborted', error: abortError(abortMessage) }
        return { text, status: 'exhausted' }
      }

      const ev = res.value
      if (ev.kind === 'token') {
        if (!firstTokenSeen && ev.text.length > 0) {
          firstTokenSeen = true
          try {
            onFirstToken?.()
          } catch {
            /* an ack-cancel callback must never break token collection */
          }
        }
        text += ev.text
        continue
      }
      if (ev.kind === 'completion') {
        settled = true
        if (stopOnCompletion) return { text, status: 'completed' }
        continue
      }
      if (ev.kind === 'error') {
        settled = true
        return { text, status: 'error', error: errorEventError(ev, errorPrefix) }
      }
      // thinking / tool_call / tool_result_ack / status — informational, ignored.
    }
  } finally {
    if (signal !== undefined) signal.removeEventListener('abort', onSignalAbort)
    // Tear down ONLY a settled turn (poison-free per the file header). A non-
    // settled exit (abort / external cancel) is left alone.
    if (settled) void Promise.resolve(iter.return?.()).catch(() => undefined)
  }
}

/**
 * The ergonomic, string-returning drain: accumulate `token` text and RETURN it on
 * a clean completion, THROWING a `SubstrateCallError` on a terminal error or a
 * watchdog abort. This is the single primitive the string-returning callers
 * (`collectTokensToString`, scribe, reflection) delegate to.
 *
 * `treatErrorAs` (default `'throw'`) is the real, readable throw-vs-capture flag:
 * flip it to `'capture'` and a terminal error is NOT thrown (the partial text is
 * returned instead) — the same policy the {@link drainToOutcome} callers use.
 */
export async function drainToText(handle: SessionHandle, opts: DrainOptions = {}): Promise<string> {
  const outcome = await drainToOutcome(handle, opts)
  const mode: DrainErrorMode = opts.treatErrorAs ?? 'throw'
  if (mode === 'throw') {
    if (outcome.status === 'error' || outcome.status === 'aborted') {
      throw outcome.error ?? new SubstrateCallError(`${opts.errorPrefix ?? ''}drain failed`, { retryable: false })
    }
    if (outcome.status === 'exhausted' && opts.requireCompletion === true) {
      throw new SubstrateCallError(
        `${opts.errorPrefix ?? ''}${opts.exhaustedMessage ?? 'stream ended without a completion event'}`,
        { retryable: false },
      )
    }
  }
  return outcome.text
}
