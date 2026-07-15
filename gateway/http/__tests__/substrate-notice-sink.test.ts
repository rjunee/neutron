/**
 * O6 — `makeSubstrateNoticeSinks` unit coverage.
 *
 * Each notice callback must (a) journal exactly one `system_events` row and (b)
 * deliver ONE owner-topic system bubble (a transient `durability: 'none'`
 * live-only pill) with the expected human copy, through the SAME F5 `deliver`
 * seam the reminder / proactive paths use. Also pins: the size warn→critical
 * escalation surfaces distinct copy (the sink does NOT re-latch), and a
 * closed-socket / offline deliver never throws out of the tick.
 */

import { describe, expect, test } from 'bun:test'

import type { SystemEventInput, SystemEventSink } from '@neutronai/persistence/index.ts'
import type { Topic } from '@neutronai/channels/types.ts'
import { AppWsAdapter } from '@neutronai/channels/adapters/app-ws/adapter.ts'
import { InMemoryAppWsSessionRegistry } from '@neutronai/channels/adapters/app-ws/session-registry.ts'
import type { Deliver, DeliveryEnvelope, DeliveryResult } from '../deliver.ts'
import { makeSubstrateNoticeSinks } from '../substrate-notice-sink.ts'

const OWNER_TOPIC = 'app:owner'

interface Sent {
  topic_id: string
  envelope: DeliveryEnvelope
}

/** A fake deliver that records every call synchronously (mirrors the real seam's
 *  synchronous 'none' push) and reports live delivery. */
function fakeDeliver(): { deliver: Deliver; sent: Sent[] } {
  const sent: Sent[] = []
  const deliver: Deliver = (topic_id, envelope): Promise<DeliveryResult> => {
    sent.push({ topic_id, envelope })
    return Promise.resolve({ prompt_id: null, persisted: true, delivered_live: true })
  }
  return { deliver, sent }
}

/** A synchronous recording journal sink. */
function fakeSink(): { sink: SystemEventSink; rows: SystemEventInput[] } {
  const rows: SystemEventInput[] = []
  return {
    rows,
    sink: {
      record: (input) => {
        rows.push(input)
        return { id: `row-${rows.length}` }
      },
    },
  }
}

describe('makeSubstrateNoticeSinks — journal + owner bubble per state', () => {
  test('onDeadTurnNotice → dead_turn_notice event + a resend-your-message bubble', () => {
    const { deliver, sent } = fakeDeliver()
    const { sink, rows } = fakeSink()
    const sinks = makeSubstrateNoticeSinks({
      deliver: () => deliver,
      owner_topic_id: OWNER_TOPIC,
      project_slug: 'owner',
      sink,
    })
    sinks.onDeadTurnNotice({ reason: 'api_5xx_dead_turn', matched: 'overloaded_error', record: '{…}' })
    // Journal: exactly one row, the right event, scoped + carrying the matched token.
    expect(rows.length).toBe(1)
    expect(rows[0]!.event).toBe('dead_turn_notice')
    expect(rows[0]!.project_slug).toBe('owner')
    expect(rows[0]!.payload).toEqual({ matched: 'overloaded_error' })
    // Bubble: one transient live-only pill (durability 'none') on the owner topic.
    expect(sent.length).toBe(1)
    expect(sent[0]!.topic_id).toBe(OWNER_TOPIC)
    expect(sent[0]!.envelope.durability).toBe('none')
    expect(sent[0]!.envelope.body).toContain('send your message again')
  })

  test('onRateLimitBanner usage-cap → rate_limit_banner event + a usage-limit bubble', () => {
    const { deliver, sent } = fakeDeliver()
    const { sink, rows } = fakeSink()
    const sinks = makeSubstrateNoticeSinks({ deliver: () => deliver, owner_topic_id: OWNER_TOPIC, sink })
    sinks.onRateLimitBanner({
      reason: 'rate_limit_banner',
      sessionId: 's1',
      severity: 'usage-cap',
      matched: '5-hour limit reached',
    })
    expect(rows.length).toBe(1)
    expect(rows[0]!.event).toBe('rate_limit_banner')
    expect(rows[0]!.payload).toEqual({ severity: 'usage-cap', matched: '5-hour limit reached' })
    expect(sent.length).toBe(1)
    expect(sent[0]!.envelope.durability).toBe('none')
    expect(sent[0]!.envelope.body).toContain('usage limit reached')
  })

  test('onRateLimitBanner temporary → a briefly-rate-limited bubble (distinct copy)', () => {
    const { deliver, sent } = fakeDeliver()
    const { sink } = fakeSink()
    const sinks = makeSubstrateNoticeSinks({ deliver: () => deliver, owner_topic_id: OWNER_TOPIC, sink })
    sinks.onRateLimitBanner({ reason: 'rate_limit_banner', sessionId: 's1', severity: 'temporary', matched: '429' })
    expect(sent.length).toBe(1)
    expect(sent[0]!.envelope.body).toContain('retry on its own')
    expect(sent[0]!.envelope.body).not.toContain('usage limit reached')
  })

  test('onSizeAlert warn vs critical → distinct events level + distinct copy (no re-latch)', () => {
    const { deliver, sent } = fakeDeliver()
    const { sink, rows } = fakeSink()
    const sinks = makeSubstrateNoticeSinks({ deliver: () => deliver, owner_topic_id: OWNER_TOPIC, sink })
    sinks.onSizeAlert({ sessionKey: 'k', severity: 'warn', sizeBytes: 5_000_000 })
    sinks.onSizeAlert({ sessionKey: 'k', severity: 'critical', sizeBytes: 10_000_000 })
    // Both rising edges surface — the sink relies on the substrate's upstream latch
    // and must NOT suppress the warn→critical escalation.
    expect(rows.length).toBe(2)
    expect(rows[0]!.level).toBe('info')
    expect(rows[1]!.level).toBe('warn')
    expect(sent.length).toBe(2)
    expect(sent[0]!.envelope.body).toContain('gotten large')
    expect(sent[1]!.envelope.body).toContain('very large')
  })

  test('DURABLE-SAFE: a notice bubble routed through the REAL AppWsAdapter is fanned live but NEVER persisted', async () => {
    // In production the notice is a `durability: 'none'` delivery → a live-only
    // pill. This pins the STRONGER guarantee at the real adapter boundary: even
    // when the deliver seam's app push reaches `AppWsAdapter.send`, the
    // `system_notice` marker (the shape the real app push builds from a
    // `durability: 'none'` delivery) makes the adapter fan WITHOUT a chat_log row
    // (no seq, no receipt) — a reload can never re-hydrate a stale state pill.
    const innerRegistry = new InMemoryAppWsSessionRegistry()
    const appended: string[] = []
    const chat_log = {
      append: async (input: { body: string }) => {
        appended.push(input.body)
        return {
          row: {
            topic_id: OWNER_TOPIC, seq: 1, message_id: 'x', role: 'agent' as const,
            body: input.body, client_msg_id: null, project_id: null, attachments: null,
            created_at: 0,
          },
          was_new: true,
        }
      },
      replayAfter: async () => [],
      maxSeq: async () => 0,
    }
    const adapter = new AppWsAdapter({
      registry: innerRegistry,
      receiver: { receive: async () => {} },
      now: () => 0,
      generate_message_id: () => 'msg-x',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chat_log: chat_log as any,
    })
    const captured: Array<{ body?: string; system_notice?: boolean; seq?: number }> = []
    innerRegistry.register(OWNER_TOPIC, (e) => captured.push(e as { body?: string; system_notice?: boolean; seq?: number }))

    const topic: Topic = {
      topic_id: '', channel_kind: 'app_socket', channel_topic_id: OWNER_TOPIC,
      project_id: null, privacy_mode: 'regular',
    }
    // A deliver whose 'none' path routes through the durable adapter (the worst
    // case) exactly as the real seam's app push does — translating the
    // `durability: 'none'` bubble into the adapter's `system_notice` option.
    let pending: Promise<unknown> = Promise.resolve()
    const deliver: Deliver = (_topic_id, env): Promise<DeliveryResult> => {
      pending = adapter.send({
        topic,
        text: env.body,
        ...(env.durability === 'none' ? { adapter_options: { system_notice: true } } : {}),
      })
      return pending.then(() => ({ prompt_id: null, persisted: true, delivered_live: true }))
    }
    const { sink } = fakeSink()
    const sinks = makeSubstrateNoticeSinks({ deliver: () => deliver, owner_topic_id: OWNER_TOPIC, sink })

    sinks.onDeadTurnNotice({ reason: 'api_5xx_dead_turn', matched: 'x', record: 'y' })
    await pending

    // No durable chat_log row for the notice…
    expect(appended).toEqual([])
    // …but it DID reach the live socket, flagged transient, with no ordering seq.
    expect(captured.length).toBe(1)
    expect(captured[0]!.system_notice).toBe(true)
    expect(captured[0]!.seq).toBeUndefined()
    expect(captured[0]!.body).toContain('send your message again')
  })

  test('an offline owner (no deliver) journals but sends no bubble; a throwing deliver is swallowed', () => {
    // No deliver resolved → journal only, no throw.
    const { sink, rows } = fakeSink()
    const offline = makeSubstrateNoticeSinks({ deliver: () => undefined, owner_topic_id: OWNER_TOPIC, sink })
    expect(() =>
      offline.onDeadTurnNotice({ reason: 'api_5xx_dead_turn', matched: 'x', record: 'y' }),
    ).not.toThrow()
    expect(rows.length).toBe(1)

    // A deliver that throws synchronously (defensive — the real seam never does
    // for 'none') must not crash the tick.
    const throwing: Deliver = () => {
      throw new Error('boom')
    }
    const { sink: sink2 } = fakeSink()
    const sinks = makeSubstrateNoticeSinks({ deliver: () => throwing, owner_topic_id: OWNER_TOPIC, sink: sink2 })
    expect(() =>
      sinks.onRateLimitBanner({ reason: 'rate_limit_banner', sessionId: 's', severity: 'temporary', matched: 'm' }),
    ).not.toThrow()
  })
})
