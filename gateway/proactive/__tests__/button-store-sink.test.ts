/**
 * Durable web OutboundSink tests. Open's proactive posts (brief + nudge) fire
 * from a timer onto `app_socket` topics, so they MUST persist a ButtonStore
 * history row (survives a disconnected socket) and best-effort live-push —
 * never route through the live-only AppWsAdapter. Mirrors the fired-reminder
 * outbound (`reminders/outbound.ts`): persist-before-send.
 */

import { describe, expect, it } from 'bun:test'
import type { ButtonStore } from '../../../channels/button-store.ts'
import type { WebChatSenderRegistry } from '../../http/chat-bridge.ts'
import { buildButtonStoreProactiveSink } from '../button-store-sink.ts'
import { proactiveTopic, type OutgoingMessage } from '../sink.ts'

interface EmitCall {
  body: string
  topic_id: string
}
interface PushCall {
  topic_id: string
  body: string
  prompt_id: string | undefined
}

function fakeButtonStore(over: { throwOnEmit?: boolean } = {}): {
  store: ButtonStore
  emits: EmitCall[]
} {
  const emits: EmitCall[] = []
  const store = {
    async emit(prompt: { body: string }, opts: { topic_id: string }) {
      if (over.throwOnEmit === true) throw new Error('db locked')
      emits.push({ body: prompt.body, topic_id: opts.topic_id })
      return { prompt_id: 'prompt-123' }
    },
  } as unknown as ButtonStore
  return { store, emits }
}

function fakeRegistry(over: { throwOnSend?: boolean } = {}): {
  registry: WebChatSenderRegistry
  pushes: PushCall[]
} {
  const pushes: PushCall[] = []
  const registry = {
    send(topic_id: string, env: { body: string; prompt_id?: string }) {
      if (over.throwOnSend === true) throw new Error('socket closed')
      pushes.push({ topic_id, body: env.body, prompt_id: env.prompt_id })
      return true
    },
  } as unknown as WebChatSenderRegistry
  return { registry, pushes }
}

const MSG = (text: string): OutgoingMessage => ({
  topic: proactiveTopic('web:owner', 'app_socket'),
  text,
})

describe('buildButtonStoreProactiveSink', () => {
  it('persists a durable history row AND best-effort live-pushes', async () => {
    const bs = fakeButtonStore()
    const reg = fakeRegistry()
    const sink = buildButtonStoreProactiveSink({ buttonStore: bs.store, registry: reg.registry })

    const id = await sink.send(MSG('🌅 Morning brief — clear day.'))

    expect(id).toBe('prompt-123')
    // Durable row first, on the owner's web topic.
    expect(bs.emits).toEqual([{ body: '🌅 Morning brief — clear day.', topic_id: 'web:owner' }])
    // Live push carries the same body + the durable prompt_id.
    expect(reg.pushes).toEqual([
      { topic_id: 'web:owner', body: '🌅 Morning brief — clear day.', prompt_id: 'prompt-123' },
    ])
  })

  it('still returns after a live-push failure (durable row is the guarantee)', async () => {
    const bs = fakeButtonStore()
    const reg = fakeRegistry({ throwOnSend: true })
    const sink = buildButtonStoreProactiveSink({
      buttonStore: bs.store,
      registry: reg.registry,
      log: () => {},
    })
    const id = await sink.send(MSG('nudge'))
    expect(id).toBe('prompt-123')
    expect(bs.emits).toHaveLength(1)
  })

  it('throws when the durable persist fails (so the brief/nudge retries, no ledger write)', async () => {
    const bs = fakeButtonStore({ throwOnEmit: true })
    const sink = buildButtonStoreProactiveSink({ buttonStore: bs.store, log: () => {} })
    await expect(sink.send(MSG('brief'))).rejects.toThrow('db locked')
  })

  it('works without a registry (durable-persist only)', async () => {
    const bs = fakeButtonStore()
    const sink = buildButtonStoreProactiveSink({ buttonStore: bs.store })
    const id = await sink.send(MSG('brief'))
    expect(id).toBe('prompt-123')
    expect(bs.emits).toHaveLength(1)
  })
})
