/**
 * THE ACCEPTED-UPDATE CAP (ISSUES #442).
 *
 * WHAT IT BOUNDS, AND WHAT IT DOES NOT. An unauthenticated caller is already
 * cheap to refuse: the secret compare runs before any body parse, so a stranger
 * costs a constant-time comparison. The unbounded party is whoever HOLDS the
 * secret — every accepted update drives a real agent turn that spends tokens and
 * wall-clock, so a compromised or careless bot token is an uncapped bill. The cap
 * turns that into a bounded one.
 *
 * WHY OVER-LIMIT ANSWERS 200 AND NOT 429 — the assertion this file exists for.
 * Telegram re-sends non-2xx for hours. `webhook-server.ts` already returns 200
 * for malformed JSON and for dropped callback queries for exactly that reason,
 * and its own comment names the failure: "precisely the retry storm the catch was
 * written to prevent". A 429 would convert a SPEND problem into a RETRY problem
 * and make the limiter the cause of the load it exists to cap. So the test does
 * not merely assert "not 429" — it asserts 200 AND that nothing was dispatched,
 * because those two together are the property: the sender is satisfied, and we
 * spent nothing.
 *
 * The clock is injected, so these assertions are about the window's SHAPE rather
 * than about how fast the machine ran them.
 */

import { describe, expect, test } from 'bun:test'

import { buildWebhookHandler } from '../webhook-server.ts'
import type { IncomingEventReceiver } from '../../../types.ts'

const SECRET = 'webhook-secret-for-rate-limit-tests'
const BOT_ID = 4242

function harness(over: { maxRequests?: number; windowMs?: number } = {}): {
  post: (body?: unknown) => Promise<Response>
  dispatched: () => number
  advance: (ms: number) => void
} {
  let clock = 1_800_000_000_000
  let count = 0
  const receiver: IncomingEventReceiver = {
    receive: async (): Promise<void> => {
      count += 1
    },
  }
  const handler = buildWebhookHandler({
    bot_user_id: BOT_ID,
    secret_token: SECRET,
    receiver,
    rate_limit: {
      windowMs: over.windowMs ?? 60_000,
      maxRequests: over.maxRequests ?? 3,
    },
    now: () => clock,
  })
  const post = async (body?: unknown): Promise<Response> =>
    handler(
      new Request('https://instance.example.com/webhook/telegram', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': SECRET,
        },
        body: JSON.stringify(
          body ?? {
            update_id: 1,
            message: {
              message_id: 1,
              date: 1,
              chat: { id: 7, type: 'private' },
              from: { id: 9, is_bot: false, first_name: 'Owner' },
              text: 'hello',
            },
          },
        ),
      }),
    )
  return { post, dispatched: () => count, advance: (ms) => (clock += ms) }
}

describe('telegram webhook — accepted-update cap', () => {
  test('updates under the cap are dispatched normally', async () => {
    const h = harness({ maxRequests: 3 })
    for (let i = 0; i < 3; i++) expect((await h.post()).status).toBe(200)
    expect(h.dispatched()).toBe(3)
  })

  test('OVER the cap answers 200 and dispatches NOTHING — never a retry-triggering status', async () => {
    const h = harness({ maxRequests: 3 })
    for (let i = 0; i < 3; i++) await h.post()
    expect(h.dispatched()).toBe(3)

    const limited = await h.post()
    // 200 is the load-bearing half: Telegram re-sends non-2xx for HOURS, so a
    // 429 here would turn a spend problem into a retry storm — the limiter
    // causing the load it exists to cap.
    expect(limited.status).toBe(200)
    // And the other half: satisfied sender, zero spend.
    expect(h.dispatched()).toBe(3)
  })

  test('the window SLIDES — a quiet period restores the full budget', async () => {
    const h = harness({ maxRequests: 3, windowMs: 60_000 })
    for (let i = 0; i < 3; i++) await h.post()
    expect((await h.post()).status).toBe(200)
    expect(h.dispatched()).toBe(3)

    // Past the window, the old hits expire and the budget is whole again. This
    // is what makes the cap a RATE limit rather than a lifetime quota.
    h.advance(60_001)
    for (let i = 0; i < 3; i++) expect((await h.post()).status).toBe(200)
    expect(h.dispatched()).toBe(6)
  })

  test('partial expiry frees exactly the elapsed slots, not the whole bucket', async () => {
    const h = harness({ maxRequests: 3, windowMs: 60_000 })
    await h.post()
    h.advance(30_000)
    await h.post()
    await h.post()
    expect(h.dispatched()).toBe(3)

    // Only the FIRST hit has aged out, so exactly one slot reopens.
    h.advance(30_001)
    expect((await h.post()).status).toBe(200)
    expect(h.dispatched()).toBe(4)
    expect((await h.post()).status).toBe(200)
    expect(h.dispatched()).toBe(4)
  })

  test('a rejected request never consumes budget — the cap counts ACCEPTED updates', async () => {
    const h = harness({ maxRequests: 3 })
    // Wrong secret: refused before the cap, so it must not spend a slot.
    const bad = await buildWebhookHandler({
      bot_user_id: BOT_ID,
      secret_token: SECRET,
      receiver: { receive: async (): Promise<void> => {} },
      rate_limit: { windowMs: 60_000, maxRequests: 3 },
    })(
      new Request('https://instance.example.com/webhook/telegram', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
        body: '{}',
      }),
    )
    expect(bad.status).toBe(403)

    // The real surface still has its whole budget.
    for (let i = 0; i < 3; i++) expect((await h.post()).status).toBe(200)
    expect(h.dispatched()).toBe(3)
  })

  test('two mounted surfaces do NOT share a window', async () => {
    // One process, two gateways: exhausting one must not silence the other.
    const a = harness({ maxRequests: 2 })
    const b = harness({ maxRequests: 2 })
    for (let i = 0; i < 3; i++) await a.post()
    expect(a.dispatched()).toBe(2)

    for (let i = 0; i < 2; i++) await b.post()
    expect(b.dispatched()).toBe(2)
  })
})
