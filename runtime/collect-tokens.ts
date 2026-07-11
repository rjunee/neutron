/**
 * @neutronai/runtime — SessionHandle token-drain helper (L3 leaf).
 *
 * L3 (2026-07) — `collectTokensToString` moved VERBATIM out of
 * `gateway/realmode-composer/build-llm-call-substrate.ts` into this runtime
 * (platform-band) leaf so services-band consumers (`reminders/dispatcher.ts`)
 * can drain a substrate stream WITHOUT importing UP into the gateway
 * composition band (the `services-below-product` / `nobody-imports-composition`
 * violation this cut removes). `build-llm-call-substrate.ts` re-exports it so
 * every existing gateway import specifier stays valid (test-policy §2.2 barrel
 * rule).
 *
 * O8 (2026-07) — the drain LOOP itself now lives in the ONE drain,
 * `./substrate-text.ts` (`drainToText`). This function is a thin, behaviour-
 * preserving adapter over it: same `(handle, signal?, onFirstToken?)` signature,
 * byte-identical `cc-llm-call:` error/abort prose, the same return-on-completion +
 * onFirstToken semantics, and the same O3 `SubstrateCallError` throw shapes
 * (message preserved so the gateway's message-regex classifiers stay green).
 * `keepAliveExempt` preserves this drain's historical cancel-on-abort watchdog
 * (the reminders / live-agent callers pass a signal and expect the turn abandoned).
 */

import type { SessionHandle } from './session-handle.ts'
import { drainToText } from './substrate-text.ts'

/**
 * Accumulate `token` events from a SessionHandle into a single string, throwing a
 * `SubstrateCallError` on the first `error` event. Returns when the `completion`
 * event is observed (or the iterator naturally ends).
 *
 * Used by every per-consumer adapter that converts the substrate's event stream
 * into a string-returning closure (LlmCallFn, AnthropicMessagesClient,
 * AgentWatcherLlmCall).
 *
 * If a `signal: AbortSignal` is supplied, the handle is cancelled when it fires
 * and a `SubstrateCallError('cc-llm-call: aborted', code:'aborted')` is thrown.
 *
 * `onFirstToken` (FIX #347) is invoked once, the moment the FIRST reply token
 * arrives — lets a caller cancel the delayed cold-start "Waking up…" ack as soon
 * as the reply is actually streaming (not only when the whole turn settles).
 */
export async function collectTokensToString(
  handle: SessionHandle,
  signal?: AbortSignal,
  onFirstToken?: () => void,
): Promise<string> {
  return drainToText(handle, {
    ...(signal !== undefined ? { signal } : {}),
    ...(onFirstToken !== undefined ? { onFirstToken } : {}),
    errorPrefix: 'cc-llm-call: ',
    abortMessage: 'cc-llm-call: aborted',
    abortBeforeDispatchMessage: 'cc-llm-call: aborted before dispatch',
    // Preserve the pre-O8 watchdog: a fired signal cancels the handle so the turn
    // is actually abandoned (the reminders / live-agent callers rely on this).
    keepAliveExempt: true,
  })
}
