/**
 * K11a6-completion survivor — `WowChannelAdapter.emitPrompt` undelivered
 * contract (retained-live `gateway/realmode-composer/build-wow-dispatcher.ts`).
 *
 * Ported from the dying `wow-fired-composer.test.ts` Test 9 (engine-driven;
 * co-deletes with K11b1), re-anchored at the adapter seam. The invariants:
 *
 *   1. PEEK-BEFORE-PERSIST: with no active WS for the topic
 *      (`webRegistry.has() === false`), `emitPrompt` throws
 *      "undelivered" WITHOUT calling `buttonStore.emit` — no dead
 *      `button_prompts` row is ever persisted (build-wow-dispatcher.ts
 *      :405-408). Pre-fix, a persisted-but-undelivered row made the
 *      dispatcher's ButtonStoreResolutionProbe spin for the full 30-min
 *      serialize timeout and the user landed at `completed` having seen
 *      nothing.
 *   2. MID-SEND RACE: if the WS drops between `has()` and `send()`
 *      (`send` returns false), `emitPrompt` still throws so the action
 *      lands in `outcome.failed[]`; `markDelivered` is NOT called (the
 *      orphan row is swept by the cron `sweepExpired` at `expires_at`).
 *   3. The parallel `sendText` throw-on-undelivered (same failure policy)
 *      is already pinned by `open/__tests__/wow-brief-history-persist.test.ts`;
 *      asserted here at the adapter seam for the no-WS peek case.
 */

import { describe, expect, test } from 'bun:test'

import type { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import type { ChatOutbound } from '../../../landing/server.ts'
import { buildWowChannelAdapter } from '../build-wow-dispatcher.ts'
import type { WebChatSenderRegistry } from '../../http/chat-bridge.ts'

const TOPIC = 'web:owner:project-x'

const PROMPT: ButtonPrompt = {
  prompt_id: 'p-wow-1',
  body: 'pick one',
  options: [{ label: 'A', body: 'A', value: 'a' }],
  allow_freeform: false,
} as unknown as ButtonPrompt

interface StoreCalls {
  emits: number
  delivered: number
  store: ButtonStore
}

function trackingStore(): StoreCalls {
  const calls: StoreCalls = {
    emits: 0,
    delivered: 0,
    store: undefined as unknown as ButtonStore,
  }
  calls.store = {
    emit: async (p: ButtonPrompt) => {
      calls.emits += 1
      return { prompt: p, prompt_id: p.prompt_id }
    },
    markDelivered: async () => {
      calls.delivered += 1
    },
    persistInertAgentTurn: async () => undefined,
  } as unknown as ButtonStore
  return calls
}

function registry(opts: { has: boolean; sendOk: boolean }): WebChatSenderRegistry {
  return {
    register: () => {},
    unregister: () => {},
    has: () => opts.has,
    send: (_topic: string, _event: ChatOutbound): boolean => opts.sendOk,
  } as unknown as WebChatSenderRegistry
}

describe('WowChannelAdapter.emitPrompt — undelivered contract', () => {
  test('no active WS: throws undelivered BEFORE persisting — zero button_prompts rows', async () => {
    const calls = trackingStore()
    const adapter = buildWowChannelAdapter({
      webRegistry: registry({ has: false, sendOk: false }),
      buttonStore: calls.store,
    })
    await expect(
      adapter.emitPrompt({ prompt: PROMPT, topic_id: TOPIC }),
    ).rejects.toThrow(/undelivered/)
    // The peek-before-persist invariant: emit was never reached.
    expect(calls.emits).toBe(0)
    expect(calls.delivered).toBe(0)
  })

  test('WS drops between has() and send(): throws undelivered, markDelivered never called', async () => {
    const calls = trackingStore()
    const adapter = buildWowChannelAdapter({
      webRegistry: registry({ has: true, sendOk: false }),
      buttonStore: calls.store,
    })
    await expect(
      adapter.emitPrompt({ prompt: PROMPT, topic_id: TOPIC }),
    ).rejects.toThrow(/undelivered/)
    // The row was persisted (race window) but never marked delivered —
    // it is left for the cron sweepExpired, and the prompt_id never
    // escapes to a caller.
    expect(calls.emits).toBe(1)
    expect(calls.delivered).toBe(0)
  })

  test('happy path unchanged: delivered send persists + marks delivered', async () => {
    const calls = trackingStore()
    const adapter = buildWowChannelAdapter({
      webRegistry: registry({ has: true, sendOk: true }),
      buttonStore: calls.store,
    })
    const out = await adapter.emitPrompt({ prompt: PROMPT, topic_id: TOPIC })
    expect(out.prompt_id).toBe('p-wow-1')
    expect(calls.emits).toBe(1)
    expect(calls.delivered).toBe(1)
  })

  test('sendText with no active WS throws undelivered (failure-policy parity)', async () => {
    const calls = trackingStore()
    const adapter = buildWowChannelAdapter({
      webRegistry: registry({ has: false, sendOk: false }),
      buttonStore: calls.store,
    })
    await expect(
      adapter.sendText({ topic_id: TOPIC, body: 'your first-week brief' }),
    ).rejects.toThrow(/undelivered/)
  })
})
