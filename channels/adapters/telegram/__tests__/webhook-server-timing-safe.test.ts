/**
 * webhook-server timing-safe secret_token compare tests
 * (Sprint 19 Phase 4 — security hardening).
 *
 * The previous implementation used a plain `provided !== secret_token`
 * compare, which is variable-time. Replaced with a length-check + node
 * `crypto.timingSafeEqual`. These tests pin the contract:
 *
 *  - Correct secret_token → 200 (delegates to receiver).
 *  - Wrong-length secret_token → 403 (length mismatch short-circuits).
 *  - Same-length but content-mismatched secret_token → 403 (timingSafeEqual).
 *  - No secret_token header at all → 403 (provided becomes empty buffer).
 */

import { describe, expect, test } from 'bun:test'
import {
  buildWebhookHandler,
  type TelegramUpdate,
} from '../webhook-server.ts'
import type { IncomingEvent, IncomingEventReceiver } from '../../../types.ts'

const recordingReceiver = (): IncomingEventReceiver & { events: IncomingEvent[] } => {
  const events: IncomingEvent[] = []
  return { events, receive: async (event) => { events.push(event) } }
}

function makeUpdate(): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 100,
      from: { id: 42, first_name: 'Tester', username: 'tester' },
      chat: { id: 99, type: 'private' },
      date: 1700000000,
      text: 'hello',
    },
  }
}

function reqWith(headers: Record<string, string>): Request {
  return new Request('http://x/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(makeUpdate()),
  })
}

describe('buildWebhookHandler timing-safe secret_token compare', () => {
  test('correct secret_token → 200 + delegates to receiver', async () => {
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'super-secret-token-abc123',
      receiver: recv,
    })
    const res = await handler(
      reqWith({ 'x-telegram-bot-api-secret-token': 'super-secret-token-abc123' }),
    )
    expect(res.status).toBe(200)
    expect(recv.events.length).toBe(1)
  })

  test('wrong-length secret_token → 403 (length-check short-circuits)', async () => {
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'super-secret-token-abc123',
      receiver: recv,
    })
    // Different length — hits the length-check arm before timingSafeEqual.
    const res = await handler(
      reqWith({ 'x-telegram-bot-api-secret-token': 'short' }),
    )
    expect(res.status).toBe(403)
    expect(recv.events.length).toBe(0)
  })

  test('same-length, content-mismatched secret_token → 403 (timingSafeEqual)', async () => {
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'super-secret-token-abc123',
      receiver: recv,
    })
    // Same byte length as the expected token, different content.
    const wrong = 'XXXXX-XXXXXX-XXXXX-XXXXXX'
    expect(wrong.length).toBe('super-secret-token-abc123'.length)
    const res = await handler(
      reqWith({ 'x-telegram-bot-api-secret-token': wrong }),
    )
    expect(res.status).toBe(403)
    expect(recv.events.length).toBe(0)
  })

  test('missing secret_token header → 403 (provided becomes empty buffer)', async () => {
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'super-secret-token-abc123',
      receiver: recv,
    })
    const res = await handler(reqWith({}))
    expect(res.status).toBe(403)
    expect(recv.events.length).toBe(0)
  })
})
