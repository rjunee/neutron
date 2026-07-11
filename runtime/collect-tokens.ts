/**
 * @neutronai/runtime — SessionHandle token-drain helper (L3 leaf).
 *
 * L3 (2026-07, pairs with O8) — `collectTokensToString` moved VERBATIM out of
 * `gateway/realmode-composer/build-llm-call-substrate.ts` into this runtime
 * (platform-band) leaf so services-band consumers (`reminders/dispatcher.ts`)
 * can drain a substrate stream WITHOUT importing UP into the gateway
 * composition band (the `services-below-product` / `nobody-imports-composition`
 * violation this cut removes). `build-llm-call-substrate.ts` re-exports it so
 * every existing gateway import specifier stays valid (test-policy §2.2 barrel
 * rule). Its only dependency is the `SessionHandle` type, which already lives
 * here in `runtime/`.
 */

import { SubstrateCallError } from './errors.ts'
import type { SessionHandle } from './session-handle.ts'

/**
 * Accumulate `token` events from a SessionHandle into a single string,
 * throwing on the first `error` event. Returns when the `completion`
 * event is observed (or the iterator naturally ends).
 *
 * Used by every per-consumer adapter that converts the substrate's
 * event stream into a string-returning closure (LlmCallFn,
 * AnthropicMessagesClient, AgentWatcherLlmCall).
 *
 * If a `signal: AbortSignal` is supplied, the handle is cancelled when
 * it fires + the iterator throws an AbortError to the caller.
 */
export async function collectTokensToString(
  handle: SessionHandle,
  signal?: AbortSignal,
  /** FIX #347 — invoked once, the moment the FIRST reply token arrives. Lets a
   *  caller cancel the delayed cold-start "Waking up…" ack as soon as the reply
   *  is actually streaming (not only when the whole turn settles), so a fast-
   *  after-slow turn never fires a spurious pill. Optional + fired at most once. */
  onFirstToken?: () => void,
): Promise<string> {
  let abortListener: (() => void) | undefined
  let aborted = false
  let firstTokenSeen = false
  if (signal !== undefined) {
    if (signal.aborted) {
      // Best-effort cancellation: the typed `aborted` error is the CONTRACT here,
      // so a rejecting `cancel()` must NOT escape and mask it (mirrors the
      // mid-stream abort listener's `.catch(() => undefined)`). Swallow any
      // cancel rejection, THEN throw the promised typed error.
      await handle.cancel().catch(() => undefined)
      // O3 — a caller-signalled cancellation is the `aborted` class. Message
      // text preserved verbatim so the freeze-timeout classifier still matches.
      throw new SubstrateCallError('cc-llm-call: aborted before dispatch', {
        code: 'aborted',
        retryable: false,
      })
    }
    abortListener = (): void => {
      aborted = true
      void handle.cancel().catch(() => undefined)
    }
    signal.addEventListener('abort', abortListener, { once: true })
  }
  try {
    let buf = ''
    for await (const ev of handle.events) {
      if (aborted) {
        throw new SubstrateCallError('cc-llm-call: aborted', { code: 'aborted', retryable: false })
      }
      if (ev.kind === 'token') {
        // FIX #347 — signal the first real token exactly once so the caller can
        // cancel the pending cold-start ack before it fires.
        if (!firstTokenSeen && ev.text.length > 0) {
          firstTokenSeen = true
          try {
            onFirstToken?.()
          } catch {
            /* an ack-cancel callback must never break token collection */
          }
        }
        buf += ev.text
        continue
      }
      if (ev.kind === 'completion') {
        return buf
      }
      if (ev.kind === 'error') {
        // O3 — surface a TYPED error carrying the event's failure `code` +
        // recovery hints so callers can classify on `.code` instead of regexing
        // prose. The `message` text is preserved EXACTLY (`cc-llm-call: <prose>`)
        // so the freeze-timeout / 429 / cooldown classifiers that still read
        // prose stay green mid-migration (SubstrateCallError extends Error, so
        // every `instanceof Error` / `.message` consumer is unaffected).
        throw new SubstrateCallError(`cc-llm-call: ${ev.message}`, {
          retryable: ev.retryable,
          ...(ev.code !== undefined ? { code: ev.code } : {}),
          ...(ev.retry_after_ms !== undefined ? { retry_after_ms: ev.retry_after_ms } : {}),
        })
      }
      // thinking / tool_call / tool_result_ack / status — informational
    }
    // Argus r1 IMPORTANT #2 (2026-05-31) — if the abort fired AFTER the
    // loop's last `if (aborted)` check but BEFORE the iterator yielded
    // another event, the iterator can end naturally (because cancel()
    // closed it) without us throwing. The pre-fix `return buf` silently
    // returned whatever partial tokens accumulated, surfacing as a
    // SUCCESSFUL result instead of an aborted error. Caller can't tell
    // the difference between "LLM finished early" and "we aborted",
    // which breaks the router's timeout-then-escalate-to-Sonnet contract
    // (it might never escalate if we return a truncated Pass-1 response).
    if (aborted) {
      throw new SubstrateCallError('cc-llm-call: aborted', { code: 'aborted', retryable: false })
    }
    // Iterator ended without an explicit completion event AND no abort.
    // Treat the accumulated buffer as the final response (defensive —
    // the CC adapter always emits a terminal completion or error event,
    // but we shouldn't throw here if a substrate stub-out in a test
    // omits the terminal event).
    return buf
  } finally {
    if (signal !== undefined && abortListener !== undefined) {
      signal.removeEventListener('abort', abortListener)
    }
  }
}
