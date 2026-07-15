/**
 * O6 — `makeSubstrateNoticeSinks` unit coverage.
 *
 * Each notice callback must (a) journal exactly one `system_events` row and (b)
 * deliver ONE owner-topic system bubble (transient `system_notice` pill) with the
 * expected human copy, on the SAME `WebChatSenderRegistry` the live client binds.
 * Also pins: the size warn→critical escalation surfaces distinct copy (the sink
 * does NOT re-latch), and a closed-socket send never throws out of the tick.
 */

import { describe, expect, test } from 'bun:test'

import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'
import type { SystemEventInput, SystemEventSink } from '@neutronai/persistence/index.ts'
import type { Topic } from '@neutronai/channels/types.ts'
import { AppWsAdapter } from '@neutronai/channels/adapters/app-ws/adapter.ts'
import { InMemoryAppWsSessionRegistry } from '@neutronai/channels/adapters/app-ws/session-registry.ts'
import type { WebChatSenderRegistry } from '../chat-sender-registry.ts'
import { makeSubstrateNoticeSinks } from '../substrate-notice-sink.ts'

const OWNER_TOPIC = 'app:owner'

// The notice bubbles are always `agent_message` system pills — narrow to that
// variant so the assertions can read its `topic_id` / `system_notice` / `body`.
type AgentMessageOut = Extract<ChatOutbound, { type: 'agent_message' }>
interface Sent {
  topic_id: string
  event: AgentMessageOut
}

/** A fake registry that records every send and reports the owner topic online. */
function fakeRegistry(): { reg: WebChatSenderRegistry; sent: Sent[] } {
  const sent: Sent[] = []
  const reg: WebChatSenderRegistry = {
    register: () => {},
    unregister: () => {},
    has: (topic_id) => topic_id === OWNER_TOPIC,
    send: (topic_id, event) => {
      sent.push({ topic_id, event: event as AgentMessageOut })
      return true
    },
  }
  return { reg, sent }
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
  test('onDeadTurnNotice → dead_turn_notice event + a resend-your-message bubble', async () => {
    const { reg, sent } = fakeRegistry()
    const { sink, rows } = fakeSink()
    const sinks = makeSubstrateNoticeSinks({
      registry: () => reg,
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
    // Bubble: one transient system pill on the owner topic with resend copy.
    expect(sent.length).toBe(1)
    expect(sent[0]!.topic_id).toBe(OWNER_TOPIC)
    expect(sent[0]!.event.type).toBe('agent_message')
    expect(sent[0]!.event.topic_id).toBe(OWNER_TOPIC)
    expect(sent[0]!.event.system_notice).toBe(true)
    expect(sent[0]!.event.body).toContain('send your message again')
  })

  test('onRateLimitBanner usage-cap → rate_limit_banner event + a usage-limit bubble', () => {
    const { reg, sent } = fakeRegistry()
    const { sink, rows } = fakeSink()
    const sinks = makeSubstrateNoticeSinks({ registry: () => reg, owner_topic_id: OWNER_TOPIC, sink })
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
    expect(sent[0]!.event.system_notice).toBe(true)
    expect(sent[0]!.event.body).toContain('usage limit reached')
  })

  test('onRateLimitBanner temporary → a briefly-rate-limited bubble (distinct copy)', () => {
    const { reg, sent } = fakeRegistry()
    const { sink } = fakeSink()
    const sinks = makeSubstrateNoticeSinks({ registry: () => reg, owner_topic_id: OWNER_TOPIC, sink })
    sinks.onRateLimitBanner({ reason: 'rate_limit_banner', sessionId: 's1', severity: 'temporary', matched: '429' })
    expect(sent.length).toBe(1)
    expect(sent[0]!.event.body).toContain('retry on its own')
    expect(sent[0]!.event.body).not.toContain('usage limit reached')
  })

  test('onSizeAlert warn vs critical → distinct events level + distinct copy (no re-latch)', () => {
    const { reg, sent } = fakeRegistry()
    const { sink, rows } = fakeSink()
    const sinks = makeSubstrateNoticeSinks({ registry: () => reg, owner_topic_id: OWNER_TOPIC, sink })
    sinks.onSizeAlert({ sessionKey: 'k', severity: 'warn', sizeBytes: 5_000_000 })
    sinks.onSizeAlert({ sessionKey: 'k', severity: 'critical', sizeBytes: 10_000_000 })
    // Both rising edges surface — the sink relies on the substrate's upstream latch
    // and must NOT suppress the warn→critical escalation.
    expect(rows.length).toBe(2)
    expect(rows[0]!.level).toBe('info')
    expect(rows[1]!.level).toBe('warn')
    expect(sent.length).toBe(2)
    expect(sent[0]!.event.body).toContain('gotten large')
    expect(sent[1]!.event.body).toContain('very large')
  })

  test('DURABLE-SAFE: a notice bubble routed through the REAL AppWsAdapter is fanned live but NEVER persisted', async () => {
    // In production the sink delivers via the raw WebChatSenderRegistry (a socket
    // fan, not the durable adapter), so a notice is inherently non-durable. This
    // pins the STRONGER guarantee at the real adapter boundary: even if a notice
    // envelope reached `AppWsAdapter.send`, its `system_notice:true` marks it
    // live-only, so the adapter fans it WITHOUT a chat_log row (no seq, no receipt)
    // — a reload can never re-hydrate a stale state pill as a stray chat bubble.
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
    // A registry whose sender routes the sink's ChatOutbound through the durable
    // adapter (the worst case) — translating the `system_notice` flag.
    let pending: Promise<unknown> = Promise.resolve()
    const bridge: WebChatSenderRegistry = {
      register: () => {},
      unregister: () => {},
      has: () => true,
      send: (_topic_id, event) => {
        pending = adapter.send({
          topic,
          text: event.type === 'agent_message' ? event.body : '',
          ...(event.type === 'agent_message' && event.system_notice === true
            ? { adapter_options: { system_notice: true } }
            : {}),
        })
        return true
      },
    }
    const { sink } = fakeSink()
    const sinks = makeSubstrateNoticeSinks({ registry: () => bridge, owner_topic_id: OWNER_TOPIC, sink })

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

  test('an offline owner (no registry) journals but sends no bubble; a throwing send is swallowed', () => {
    // No registry resolved → journal only, no throw.
    const { sink, rows } = fakeSink()
    const offline = makeSubstrateNoticeSinks({ registry: () => undefined, owner_topic_id: OWNER_TOPIC, sink })
    expect(() =>
      offline.onDeadTurnNotice({ reason: 'api_5xx_dead_turn', matched: 'x', record: 'y' }),
    ).not.toThrow()
    expect(rows.length).toBe(1)

    // A registry whose send throws (closed socket) must not crash the tick.
    const throwing: WebChatSenderRegistry = {
      register: () => {},
      unregister: () => {},
      has: () => true,
      send: () => {
        throw new Error('socket closed')
      },
    }
    const { sink: sink2 } = fakeSink()
    const sinks = makeSubstrateNoticeSinks({ registry: () => throwing, owner_topic_id: OWNER_TOPIC, sink: sink2 })
    expect(() =>
      sinks.onRateLimitBanner({ reason: 'rate_limit_banner', sessionId: 's', severity: 'temporary', matched: 'm' }),
    ).not.toThrow()
  })
})
