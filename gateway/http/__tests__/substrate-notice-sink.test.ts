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

  test('onModelFloorApplied → model_floor_applied event + a bubble naming session, request and floor', () => {
    const { deliver, sent } = fakeDeliver()
    const { sink, rows } = fakeSink()
    const sinks = makeSubstrateNoticeSinks({
      deliver: () => deliver,
      owner_topic_id: OWNER_TOPIC,
      project_slug: 'owner',
      sink,
    })
    sinks.onModelFloorApplied({
      sessionKey: 'cc-agent-owner/u-1',
      source: 'resume',
      requested: 'claude-haiku-4-5-20251001',
      floor: 'claude-opus-5',
    })
    expect(rows.length).toBe(1)
    expect(rows[0]!.event).toBe('model_floor_applied')
    expect(rows[0]!.level).toBe('warn')
    expect(rows[0]!.payload).toEqual({
      session_key: 'cc-agent-owner/u-1',
      source: 'resume',
      requested_model: 'claude-haiku-4-5-20251001',
      floor_model: 'claude-opus-5',
    })
    expect(sent.length).toBe(1)
    expect(sent[0]!.topic_id).toBe(OWNER_TOPIC)
    expect(sent[0]!.envelope.durability).toBe('none')
    const body = String(sent[0]!.envelope.body)
    // BOTH MODELS BY NAME. The owner's only symptom last time was worse answers,
    // and the explanation he was given was wrong; a bubble that says only "a model
    // was corrected" leaves the same guessing game in place.
    expect(body).toContain('claude-haiku-4-5-20251001')
    expect(body).toContain('claude-opus-5')
    // AND THE SESSION BY NAME, because the pill lands on the owner's pinned topic
    // rather than the degraded project chat — copy saying "this chat" would be
    // pointing at the wrong one.
    expect(body).toContain('cc-agent-owner/u-1')
  })

  test('a hostile registry value cannot break the bubble out of its code span or run long', () => {
    // `repl-registry.ts:74` declares `model?: string` and never schema-checks it,
    // and this bubble is the one place that value is RENDERED to the owner. A
    // backtick would close the span early and a 400-character row would bury the
    // sentence — neither dangerous (chat markdown, not HTML), both enough to make
    // a notice unreadable, which for a notice is the same as not firing.
    const { deliver, sent } = fakeDeliver()
    const { sink } = fakeSink()
    const sinks = makeSubstrateNoticeSinks({
      deliver: () => deliver,
      owner_topic_id: OWNER_TOPIC,
      sink,
    })
    sinks.onModelFloorApplied({
      sessionKey: 'k',
      source: 'spawn',
      requested: '`x` **bold**\nsecond line',
      floor: 'z'.repeat(400),
    })
    const body = String(sent[0]!.envelope.body)
    // Exactly the three spans the copy opens — no fourth from an injected backtick.
    expect((body.match(/`/g) ?? []).length).toBe(6)
    expect(body).not.toContain('\n')
    // Truncation is MARKED, so a clipped id is never mistaken for a complete one.
    expect(body).toContain('…')
    expect(body).not.toContain('z'.repeat(65))

    // …and an unusable value is SAID rather than rendered as an empty span, so a
    // blank never reads as "no problem here".
    sinks.onModelFloorApplied({ sessionKey: 'k', source: 'spawn', requested: '   ', floor: 'f' })
    expect(String(sent[1]!.envelope.body)).toContain('(empty)')
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

  test('THE JOURNAL-ONLY CONFIGURATION, on the callback that actually uses it', () => {
    // `open/wiring/substrates.ts` gives the timer-driven nudge lane a sink built
    // with `deliver: () => undefined` so a model-floor clamp on that lane is
    // RECORDED without a background timer pushing a bubble into the owner's chat.
    // The test above proves the no-bubble path for `onDeadTurnNotice`; this pins it
    // for `onModelFloorApplied`, which is the ONE callback that wiring consumes.
    // Sharing the `bubble` helper is a reason to expect the property, not evidence
    // that the callback has it — and the clamp is the only notice on that lane, so
    // if it ever bubbled there would be nothing else to notice the change.
    const { sink, rows } = fakeSink()
    const { deliver, sent } = fakeDeliver()

    const journalOnly = makeSubstrateNoticeSinks({
      deliver: () => undefined,
      owner_topic_id: OWNER_TOPIC,
      sink,
    })
    journalOnly.onModelFloorApplied({
      sessionKey: 'cc-nudge-owner',
      source: 'spawn',
      requested: 'fast-tier',
      floor: 'frontier-tier',
    })

    // The clamp REACHES THE JOURNAL — NOT a stderr line, which is the silence the
    // floor notice exists to end. "Reaches", not "is durably recorded": this test
    // injects the sink, and in production the same call is best-effort at both ends
    // (an unregistered ambient sink is a no-op, `emitSystemEventSafe` swallows a
    // write failure). What is pinned is that the callback ATTEMPTS the row with the
    // right event name and level, which is what makes a clamp findable afterwards.
    expect(rows.length).toBe(1)
    expect(rows[0]!.event).toBe('model_floor_applied')
    expect(rows[0]!.level).toBe('warn')
    // …and nothing reached a chat surface.
    expect(sent.length).toBe(0)

    // POSITIVE CONTROL — the same callback with a deliver resolved DOES bubble, so
    // the zero above is the missing deliver and not a callback that never delivers.
    const { sink: sink3, rows: rows3 } = fakeSink()
    const bubbling = makeSubstrateNoticeSinks({
      deliver: () => deliver,
      owner_topic_id: OWNER_TOPIC,
      sink: sink3,
    })
    bubbling.onModelFloorApplied({
      sessionKey: 'cc-agent-owner',
      source: 'spawn',
      requested: 'fast-tier',
      floor: 'frontier-tier',
    })
    expect(rows3.length).toBe(1)
    expect(sent.length).toBe(1)
  })
})
