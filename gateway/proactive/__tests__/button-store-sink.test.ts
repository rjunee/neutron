/**
 * Durable web OutboundSink tests. Open's proactive posts (brief + nudge) fire
 * from a timer onto `app_socket` topics, so they MUST persist a durable history
 * row (survives a disconnected socket) and best-effort live-push — never route
 * through the live-only AppWsAdapter.
 *
 * F5 (2026-07) — the durable-row-first + push mechanics moved into the shared
 * `deliver` seam; this sink is now a thin adapter from the `OutboundSink` shape
 * onto `deliver` with `durability: 'inert'` (an already-resolved history turn).
 * So these tests fake `deliver` and pin: the sink forwards the message body +
 * topic under `durability: 'inert'`, returns the durable id, and PROPAGATES a
 * persist failure (so the brief/nudge retries, no ledger write).
 */

import { describe, expect, it } from 'bun:test'
import type { Deliver, DeliveryEnvelope, DeliveryResult } from '../../http/deliver.ts'
import { buildButtonStoreProactiveSink } from '../button-store-sink.ts'
import { proactiveTopic, type OutgoingMessage } from '../sink.ts'

interface DeliverCall {
  topic_id: string
  envelope: DeliveryEnvelope
}

function fakeDeliver(
  over: { throwOnPersist?: boolean; prompt_id?: string } = {},
): { deliver: Deliver; calls: DeliverCall[] } {
  const calls: DeliverCall[] = []
  const deliver: Deliver = async (topic_id, envelope): Promise<DeliveryResult> => {
    calls.push({ topic_id, envelope })
    // 'inert' durability surfaces a persist failure (the proactive contract
    // retries on a throw) — mirror that here.
    if (over.throwOnPersist === true) throw new Error('db locked')
    return { prompt_id: over.prompt_id ?? 'prompt-123', persisted: true, delivered_live: true }
  }
  return { deliver, calls }
}

const MSG = (text: string): OutgoingMessage => ({
  topic: proactiveTopic('web:owner', 'app_socket'),
  text,
})

describe('buildButtonStoreProactiveSink', () => {
  it('forwards the post to deliver as an inert durable turn + returns the durable id', async () => {
    const d = fakeDeliver()
    const sink = buildButtonStoreProactiveSink({ deliver: d.deliver })

    const id = await sink.send(MSG('🌅 Morning brief — clear day.'))

    expect(id).toBe('prompt-123')
    // One delivery, on the message's channel_topic_id, as an inert history turn.
    expect(d.calls).toEqual([
      {
        topic_id: 'web:owner',
        envelope: { body: '🌅 Morning brief — clear day.', durability: 'inert' },
      },
    ])
  })

  it('propagates a durable-persist failure (so the brief/nudge retries, no ledger write)', async () => {
    const d = fakeDeliver({ throwOnPersist: true })
    const sink = buildButtonStoreProactiveSink({ deliver: d.deliver })
    await expect(sink.send(MSG('brief'))).rejects.toThrow('db locked')
  })
})
