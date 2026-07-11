/**
 * @neutronai/runtime — the shared substrate-stream drain-to-text (O8 leaf).
 *
 * O8 (2026-07, lane substrate) — before this file the "iterate the SessionHandle
 * event stream, accumulate token text, classify a terminal error" loop was
 * copy-pasted across the codebase and each copy had drifted (a different error
 * prose, a watchdog abort, a throw-vs-capture split, an onFirstToken ack). This
 * leaf holds the shared loop (`drainToOutcome`) plus its ergonomic throwing
 * wrapper (`drainToText`); each surviving divergence is a POLICY FLAG.
 *
 * WHAT CONVERGED onto this drain (the string / capture consumers):
 *   - `runtime/collect-tokens.ts` `collectTokensToString` — thin wrapper; prose,
 *     signature, onFirstToken, and O3 `SubstrateCallError` throw shapes preserved.
 *   - `scribe/extract.ts`            — was a local `drainToString`.
 *   - `reflection/detector.ts`       — was a local `drainToString`.
 *   - `agent-dispatch/substrate-turn.ts` — capture mode → its terminal status.
 *
 * WHAT DELIBERATELY DID **NOT** converge (stated honestly so this comment never
 * overclaims a total fold-in — these loops still exist in the tree, by design):
 *   - `cores/free/email/src/substrate-llm.ts` — a bundled Core may not import a
 *     runtime VALUE (`cores-use-sdk-only` depcruise boundary); its stub-throw-on-
 *     missing-completion stays a local loop.
 *   - the gateway substrate builders (`build-llm-call-substrate.ts:682`/`:1076`,
 *     `build-import-substrate.ts:438`) — these are event→event TRANSFORM
 *     generators with credential-pool side effects (reportSuccess/reportFailure)
 *     + session-ledger bookkeeping; they `yield ev`, they never drain to text.
 *   - `trident/conflict-resolver.ts` + `trident/inner-loop.ts` — capture-mode
 *     drains that draw a bespoke error-EVENT vs iterator-THROW message
 *     distinction this helper intentionally collapses. Converging them would buy
 *     no shared flag (the throw-vs-capture choice is the FUNCTION you call, not a
 *     flag `drainToOutcome` reads), so they stay as domain-specific loops.
 *   - `onboarding/synthesis/synthesis-session.ts` `drainWithHeartbeat` — a
 *     per-pull idle/ceiling timer-race + `isAlive` primitive; a different contract.
 *   - `runtime/adapters/claude-code/persistent/pool.ts` recovered-reply drain —
 *     adapter-internal (delivers on completion inside the CC adapter itself).
 *
 * THROW vs CAPTURE is the function you pick, not a flag: `drainToText` throws a
 * `SubstrateCallError` on a terminal error / watchdog abort; `drainToOutcome`
 * returns the error on the outcome so a caller can map it onto its own terminal
 * status (agent-dispatch does this).
 *
 * Error classification REUSES O3's typed taxonomy (`SubstrateCallError` /
 * `SUBSTRATE_ERROR_CODES` in `./errors.ts`): a terminal `error` event becomes a
 * `SubstrateCallError` carrying the event's `code` / `retryable` / `retry_after_ms`
 * VERBATIM, with the message prose preserved byte-identical (via `errorPrefix`) so
 * the one-release message-regex fallbacks in the gateway classifiers stay green.
 * No new classifier is invented here.
 *
 * ── The load-bearing correctness invariant (do not break) ────────────────────
 * The Claude-Code persistent-REPL adapter poisons a WARM session if `cancel()` is
 * called on an UNSETTLED turn (`pool.ts` `cancel()` — the `if (… && !t.settled)
 * session.poisoned = true` branch). So the DEFAULT drain path here iterates to a
 * TERMINAL event and never early-cancels a live turn. Two consequences:
 *
 *  1. Teardown (`iterator.return()` → the adapter's `cancel()`) runs ONLY after a
 *     terminal `completion`/`error` event. By then the driver has ALREADY set
 *     `t.settled = true` — it does so BEFORE it pushes the completion event and
 *     closes the channel (`repl-session.ts` `onReply`: `t.settled = true` →
 *     push(token) → push(completion) → channel.close()). So the teardown
 *     `cancel()` hits the `!t.settled` guard and is a poison-flag no-op; and the
 *     channel is already closed, so `iterator.return()` completes immediately.
 *     It is therefore fire-and-forget on purpose (below): the turn is settled by
 *     the DRIVER at terminal-event time, not by our `return()`, so awaiting the
 *     `return()` would add zero poison-safety (session release + the poison flag
 *     are decided server-side before we ever observe completion) while adding a
 *     hang risk on a misbehaving adapter whose `return()` never settles.
 *
 *  2. The only path that cancels a still-running turn is an EXPLICIT
 *     `keepAliveExempt` watchdog abort (scribe/reflection/collect-tokens), which
 *     WANTS the abandon-poison so the next dispatch respawns a clean REPL. A
 *     default drain (`keepAliveExempt` unset) aborts WITHOUT cancelling.
 */

import type { Event } from './events.ts'
import type { SessionHandle } from './session-handle.ts'
import { SubstrateCallError } from './errors.ts'

/** Why the drain stopped. */
export type DrainStatus =
  /** A terminal `completion` event was observed (the turn settled cleanly). */
  | 'completed'
  /** The iterator ended WITHOUT a terminal completion (paused / stubbed stream). */
  | 'exhausted'
  /** A terminal `error` event, or the iterator threw (transport/external cancel). */
  | 'error'
  /** The `signal` fired mid-drain (watchdog abort). */
  | 'aborted'

/**
 * Policy flags for {@link drainToOutcome} / {@link drainToText}. Every flag here
 * has a real consumer (no speculative flags): the watchdog set
 * (`signal`/`keepAliveExempt`), the cold-start ack (`onFirstToken`), and the
 * per-site prose (`errorPrefix`/`abortMessage`/`abortBeforeDispatchMessage`).
 */
export interface DrainOptions {
  /** Watchdog signal. When it fires mid-drain the drain stops with `aborted`. */
  signal?: AbortSignal
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
 * Fire-and-forget a teardown side effect (`iter.return()` / `handle.cancel()`) so
 * a teardown failure can NEVER mask the terminal {@link DrainOutcome}. Wrapping
 * `Promise.resolve(fn())` alone only guards a REJECTING promise — the invocation
 * `fn()` itself must sit inside the `try` to also swallow a SYNCHRONOUS throw (a
 * substrate whose `return()`/`cancel()` throws inline). Both must be swallowed:
 * the completed / error-captured / aborted outcome is what the caller depends on.
 */
function swallowTeardown(fn: () => unknown): void {
  try {
    const r = fn()
    if (r !== undefined && r !== null && typeof (r as { then?: unknown }).then === 'function') {
      void (r as Promise<unknown>).catch(() => undefined)
    }
  } catch {
    /* teardown threw synchronously — ignored; the terminal outcome must survive it */
  }
}

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
    onFirstToken,
    errorPrefix = '',
    abortMessage = 'substrate drain: aborted',
    abortBeforeDispatchMessage = abortMessage,
    keepAliveExempt = false,
  } = opts

  // Already aborted before we pulled a single event: never even start iterating.
  if (signal?.aborted === true) {
    // Await the cancel so it lands before we return, but guard BOTH a sync throw
    // and an async rejection — a failed teardown must not mask the aborted outcome.
    if (keepAliveExempt) {
      try {
        await handle.cancel()
      } catch {
        /* best-effort teardown — the aborted outcome must survive a cancel throw */
      }
    }
    return { text: '', status: 'aborted', error: abortError(abortBeforeDispatchMessage) }
  }

  const iter = handle.events[Symbol.asyncIterator]()
  let text = ''
  let firstTokenSeen = false
  // `settled` = a TERMINAL event (completion/error) was observed from the stream,
  // so `iterator.return()` in the finally is a poison-free teardown of a session
  // the driver has already marked settled. It stays false on an abort/external-
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
    // swallowTeardown guards a SYNC throw here too (this runs inside the abort
    // event dispatch, where an escaping throw would surface as unhandled).
    if (keepAliveExempt) swallowTeardown(() => handle.cancel())
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
        // `completion` is the terminal, already-settled event → return the text.
        // (No "keep draining past completion" mode exists: it had no consumer and
        // its only theoretical use — the un-converged email Core — is blocked by
        // the cores→runtime import boundary. YAGNI: removing the flag also removes
        // the "completed-then-misclassified-as-exhausted" hazard by construction.)
        settled = true
        return { text, status: 'completed' }
      }
      if (ev.kind === 'error') {
        settled = true
        return { text, status: 'error', error: errorEventError(ev, errorPrefix) }
      }
      // thinking / tool_call / tool_result_ack / status — informational, ignored.
    }
  } finally {
    if (signal !== undefined) signal.removeEventListener('abort', onSignalAbort)
    // Fire-and-forget teardown of a SETTLED turn (see the file header, point 1):
    // the driver already set `t.settled` + closed the channel before it pushed the
    // terminal event, so this `return()`→`cancel()` is a poison-flag no-op and
    // completes immediately. NOT awaited — the poison flag + session release are
    // decided server-side at settle time, so awaiting buys no poison-safety and
    // only risks a hang on a misbehaving adapter `return()`. `swallowTeardown`
    // guards BOTH a synchronous `return()` throw and an async rejection so a
    // teardown failure never masks the terminal outcome. A NON-settled exit
    // (abort / external cancel) is left alone.
    if (settled) swallowTeardown(() => iter.return?.())
  }
}

/**
 * The ergonomic, string-returning drain: accumulate `token` text and RETURN it on
 * a clean completion (or a stubbed stream that ends without one — the defensive
 * "return the buffer" behaviour the pre-O8 `collectTokensToString` / scribe /
 * reflection drains all had), THROWING a `SubstrateCallError` on a terminal error
 * or a watchdog abort. The string-returning callers delegate to this; the
 * throw-vs-capture policy is this function (throws) versus {@link drainToOutcome}
 * (returns the error on the outcome).
 */
export async function drainToText(handle: SessionHandle, opts: DrainOptions = {}): Promise<string> {
  const outcome = await drainToOutcome(handle, opts)
  if (outcome.status === 'error' || outcome.status === 'aborted') {
    throw outcome.error ?? new SubstrateCallError(`${opts.errorPrefix ?? ''}drain failed`, { retryable: false })
  }
  // 'completed' and 'exhausted' both return the accumulated text.
  return outcome.text
}
