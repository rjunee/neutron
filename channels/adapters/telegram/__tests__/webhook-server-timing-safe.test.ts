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

/**
 * The failure mode the timing-safe compare INTRODUCES if the expected secret is
 * ever empty, and the guard that closes it (2026-08-02).
 *
 * `timingSafeEqual` is only reached when the two buffers have equal length. A
 * request that sends NO header produces `Buffer.from('')`. If the configured
 * secret is also `''`, the lengths match, the contents match, and the compare
 * returns TRUE — the endpoint authenticates the entire public internet while
 * every line of it still looks like careful constant-time security code. This
 * is reachable state, not theory: `SecretsStore.put` places no constraint on
 * plaintext, so an empty webhook secret is storable.
 *
 * `gateway/wiring/build-telegram-webhook.ts` refuses to build a surface around
 * an empty secret, so in the composed product the route is simply absent. These
 * tests pin the SECOND, independent gate — the handler fails closed on its own,
 * so no other caller of this factory can inherit the hole.
 *
 * MUTATION TEST: remove the `opts.secret_token.length === 0` guard from
 * `buildWebhookHandler` and both tests below red (403 → 200, and the receiver
 * sees a forged event). Verified.
 */
describe('empty expected secret_token fails closed', () => {
  test('an empty secret_token rejects a request sending NO header', async () => {
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({ bot_user_id: 1, secret_token: '', receiver: recv })
    const res = await handler(reqWith({}))
    expect(res.status).toBe(403)
    // The load-bearing half: nothing was dispatched. A 403 that still delivered
    // the event would be theatre.
    expect(recv.events.length).toBe(0)
  })

  test('an empty secret_token rejects a request sending an empty header', async () => {
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({ bot_user_id: 1, secret_token: '', receiver: recv })
    const res = await handler(reqWith({ 'x-telegram-bot-api-secret-token': '' }))
    expect(res.status).toBe(403)
    expect(recv.events.length).toBe(0)
  })
})

/**
 * Valid JSON that is not an object (2026-08-02). `req.json()` only throws on
 * UNPARSEABLE input, so `null` sails past the try/catch and the next line
 * dereferences it — a TypeError, a 500, and the hours-long Telegram retry storm
 * the catch exists to prevent. Found by driving a literal `null` body through
 * the composed router in `open/__tests__/telegram-webhook-served.test.ts`.
 *
 * MUTATION TEST: remove the non-object guard from `buildWebhookHandler` and the
 * `null` case throws instead of answering 200. Verified.
 */
describe('non-object JSON bodies are absorbed, not crashed on', () => {
  for (const raw of ['null', '[]', '3', '"a string"', 'true']) {
    test(`body ${raw} → 200, no dispatch`, async () => {
      const recv = recordingReceiver()
      const handler = buildWebhookHandler({
        bot_user_id: 1,
        secret_token: 'super-secret-token-abc123',
        receiver: recv,
      })
      const res = await handler(
        new Request('http://x/webhook', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-telegram-bot-api-secret-token': 'super-secret-token-abc123',
          },
          body: raw,
        }),
      )
      expect(res.status).toBe(200)
      expect(recv.events.length).toBe(0)
    })
  }
})
