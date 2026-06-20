/**
 * webhook-server `/start onboard_<correlator>` dispatch tests
 * (Argus follow-up to PR #19, post-Codex hardening).
 *
 * Pins:
 *  - `/start onboard_<correlator>` strips the prefix and dispatches to
 *    `on_start_command` with `payload=<correlator>`.
 *  - `/start <payload-without-onboard-prefix>` falls through to
 *    `decodeUpdate` so non-onboarding `/start` flows (`/start help`,
 *    future deeplink schemas, freeform text) still surface as normal
 *    user messages.
 *  - `/start` with no payload falls through to `decodeUpdate`.
 *  - Handler `throw` is swallowed at the boundary; webhook still returns
 *    200 OK so Telegram does not retry.
 *  - When `on_start_command` is undefined, `/start onboard_<x>` also
 *    falls through to `decodeUpdate` (no special handling).
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

function makeStartUpdate(text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 100,
      from: { id: 42, first_name: 'Tester', username: 'tester' },
      chat: { id: 99, type: 'private' },
      date: 1700000000,
      text,
    },
  }
}

function startReq(update: TelegramUpdate): Request {
  return new Request('http://x/webhook', {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'sec', 'content-type': 'application/json' },
    body: JSON.stringify(update),
  })
}

describe('buildWebhookHandler /start dispatch', () => {
  test('/start onboard_<correlator> strips prefix + dispatches with bare correlator', async () => {
    const calls: Array<{ payload: string; from_user_id: string; chat_id: string }> = []
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'sec',
      receiver: recv,
      on_start_command: async ({ payload, from_user_id, chat_id }) => {
        calls.push({ payload, from_user_id, chat_id })
      },
    })
    const res = await handler(startReq(makeStartUpdate('/start onboard_abc123XYZ')))
    expect(res.status).toBe(200)
    expect(calls.length).toBe(1)
    expect(calls[0]?.payload).toBe('abc123XYZ')
    expect(calls[0]?.from_user_id).toBe('42')
    expect(calls[0]?.chat_id).toBe('99')
    // The text receiver must NOT have been invoked — `/start <payload>`
    // is a bot-command, not a user message.
    expect(recv.events.length).toBe(0)
  })

  test('/start <non-onboard payload> falls through to decodeUpdate (Codex r1 P2)', async () => {
    // `/start help` and similar non-onboarding flows must NOT be
    // intercepted by the onboarding handler — they should land on the
    // normal text receiver so existing or future bot-command flows
    // keep working alongside onboarding deeplinks.
    const calls: Array<{ payload: string }> = []
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'sec',
      receiver: recv,
      on_start_command: async ({ payload }) => {
        calls.push({ payload })
      },
    })
    const res = await handler(startReq(makeStartUpdate('/start help')))
    expect(res.status).toBe(200)
    // Onboarding handler MUST NOT be invoked for non-onboarding payloads.
    expect(calls.length).toBe(0)
    // The text receiver picks it up as a normal user message.
    expect(recv.events.length).toBe(1)
    expect(recv.events[0]?.body.text).toBe('/start help')
  })

  test('/start (no payload) falls through to decodeUpdate', async () => {
    const calls: Array<{ payload: string }> = []
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'sec',
      receiver: recv,
      on_start_command: async ({ payload }) => {
        calls.push({ payload })
      },
    })
    const res = await handler(startReq(makeStartUpdate('/start')))
    expect(res.status).toBe(200)
    // Empty payload → no dispatch to start handler.
    expect(calls.length).toBe(0)
    // The text path runs — the message lands on the receiver as a
    // normal user message.
    expect(recv.events.length).toBe(1)
    expect(recv.events[0]?.body.text).toBe('/start')
  })

  test('on_start_command throw is swallowed; webhook still returns 200', async () => {
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'sec',
      receiver: recordingReceiver(),
      on_start_command: async () => {
        throw new Error('synthetic')
      },
    })
    const res = await handler(startReq(makeStartUpdate('/start onboard_x')))
    expect(res.status).toBe(200)
  })

  test('when on_start_command is undefined, /start onboard_<x> falls through to decodeUpdate', async () => {
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'sec',
      receiver: recv,
    })
    const res = await handler(startReq(makeStartUpdate('/start onboard_x')))
    expect(res.status).toBe(200)
    // Falls through to the normal text path.
    expect(recv.events.length).toBe(1)
    expect(recv.events[0]?.body.text).toBe('/start onboard_x')
  })

  test('Codex r2 P2: /start onboard_<x> in a group chat falls through (does NOT burn correlator)', async () => {
    // The deeplink is single-use; consuming it from anything other than
    // the user's intended 1:1 bot DM would lock them out before they
    // could use it. Pasted-into-group must stay a normal text message.
    const calls: Array<{ payload: string }> = []
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'sec',
      receiver: recv,
      on_start_command: async ({ payload }) => {
        calls.push({ payload })
      },
    })
    const groupUpdate: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 42, first_name: 'Tester' },
        chat: { id: -100123, type: 'supergroup' },
        date: 1700000000,
        text: '/start onboard_abc',
        message_thread_id: 7,
      },
    }
    const res = await handler(startReq(groupUpdate))
    expect(res.status).toBe(200)
    expect(calls.length).toBe(0)
    // Falls through to decodeUpdate — receiver picks it up.
    expect(recv.events.length).toBe(1)
    expect(recv.events[0]?.body.text).toBe('/start onboard_abc')
  })

  test('/start with leading/trailing whitespace in payload is trimmed', async () => {
    const calls: Array<{ payload: string }> = []
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'sec',
      receiver: recordingReceiver(),
      on_start_command: async ({ payload }) => {
        calls.push({ payload })
      },
    })
    const res = await handler(startReq(makeStartUpdate('/start    onboard_xyz   ')))
    expect(res.status).toBe(200)
    expect(calls.length).toBe(1)
    expect(calls[0]?.payload).toBe('xyz')
  })
})
