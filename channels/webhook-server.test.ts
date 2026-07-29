import { describe, expect, test } from 'bun:test'
import {
  buildWebhookHandler,
  decodeUpdate,
  type TelegramUpdate,
} from './adapters/telegram/webhook-server.ts'
import {
  SelfEchoFilter,
  hashText,
} from './adapters/telegram/sync-message-filter.ts'
import type { IncomingEvent, IncomingEventReceiver } from './types.ts'

const recordingReceiver = (): IncomingEventReceiver & { events: IncomingEvent[] } => {
  const events: IncomingEvent[] = []
  return { events, receive: async (event) => { events.push(event) } }
}

describe('decodeUpdate', () => {
  test('produces an IncomingEvent with channel_topic_id from chat:thread', () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 999, first_name: 'Sam', username: 'rj' },
        chat: { id: -1001234567, type: 'supergroup' },
        date: 1700000000,
        text: 'hello',
        message_thread_id: 7,
      },
    }
    const event = decodeUpdate(update, {
      bot_user_id: 555,
      secret_token: 'sec',
      receiver: recordingReceiver(),
    })
    expect(event?.channel_topic_id).toBe('-1001234567:7')
    expect(event?.user.display_name).toBe('rj')
    expect(event?.body.text).toBe('hello')
  })

  test('returns null for self bot messages', () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 555, is_bot: true, first_name: 'BotName' },
        chat: { id: 1, type: 'private' },
        date: 1700000000,
        text: 'hi',
      },
    }
    expect(
      decodeUpdate(update, { bot_user_id: 555, secret_token: 'sec', receiver: recordingReceiver() }),
    ).toBeNull()
  })

  test('returns null when message has no text', () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 1, first_name: 'X' },
        chat: { id: 1, type: 'private' },
        date: 1700000000,
      },
    }
    expect(
      decodeUpdate(update, { bot_user_id: 555, secret_token: 'sec', receiver: recordingReceiver() }),
    ).toBeNull()
  })

  test('honors self-echo filter', () => {
    const filter = new SelfEchoFilter({ now: () => 1000 })
    filter.recordSent({
      message_id: 'm1',
      channel_topic_id: '1',
      text_hash: hashText('echo'),
      sent_at: 1000,
    })
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 1, first_name: 'X' },
        chat: { id: 1, type: 'private' },
        date: 1700000000,
        text: 'echo',
      },
    }
    expect(
      decodeUpdate(update, {
        bot_user_id: 555,
        secret_token: 'sec',
        receiver: recordingReceiver(),
        self_echo_filter: filter,
      }),
    ).toBeNull()
  })
})

describe('buildWebhookHandler', () => {
  test('rejects unauthenticated requests', async () => {
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'expected',
      receiver: recordingReceiver(),
    })
    const res = await handler(
      new Request('http://x/webhook', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
      }),
    )
    expect(res.status).toBe(403)
  })

  test('200 + receiver invocation on a well-formed update', async () => {
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'sec',
      receiver: recv,
    })
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 2, first_name: 'X' },
        chat: { id: 1, type: 'private' },
        date: 1700000000,
        text: 'hi',
      },
    }
    const res = await handler(
      new Request('http://x/webhook', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'sec', 'content-type': 'application/json' },
        body: JSON.stringify(update),
      }),
    )
    expect(res.status).toBe(200)
    expect(recv.events.length).toBe(1)
  })

  test('200 + no receiver call on malformed JSON (Telegram-retry shield)', async () => {
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'sec',
      receiver: recv,
    })
    const res = await handler(
      new Request('http://x/webhook', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'sec' },
        body: 'not json',
      }),
    )
    expect(res.status).toBe(200)
    expect(recv.events.length).toBe(0)
  })

  test('rejects non-POST', async () => {
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'sec',
      receiver: recordingReceiver(),
    })
    const res = await handler(new Request('http://x/webhook', { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  test('callback_query dispatches to on_callback_query handler when wired', async () => {
    const recv = recordingReceiver()
    const calls: Array<{ id: string; data: string; from_user_id: string }> = []
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'sec',
      receiver: recv,
      on_callback_query: async ({ id, data, from_user_id }) => {
        calls.push({ id, data, from_user_id })
      },
    })
    const update = {
      update_id: 1,
      callback_query: {
        id: 'cb-1',
        from: { id: 2, first_name: 'X' },
        data: 'btn:abc',
      },
    }
    const res = await handler(
      new Request('http://x/webhook', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'sec', 'content-type': 'application/json' },
        body: JSON.stringify(update),
      }),
    )
    expect(res.status).toBe(200)
    expect(calls.length).toBe(1)
    expect(calls[0]?.id).toBe('cb-1')
    expect(calls[0]?.data).toBe('btn:abc')
    expect(calls[0]?.from_user_id).toBe('2')
    // The text-receiver path should NOT have been invoked.
    expect(recv.events.length).toBe(0)
  })

  test('callback_query is silently dropped when on_callback_query is absent', async () => {
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'sec',
      receiver: recv,
    })
    const update = {
      update_id: 1,
      callback_query: { id: 'cb-1', from: { id: 2, first_name: 'X' }, data: 'btn:abc' },
    }
    const res = await handler(
      new Request('http://x/webhook', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'sec' },
        body: JSON.stringify(update),
      }),
    )
    expect(res.status).toBe(200)
    expect(recv.events.length).toBe(0)
  })

  test('callback_query with empty data still dispatches to handler (Codex r10 P2)', async () => {
    // The button primitive allows option.value=''; the rendered
    // callback_data is `btn:<wire>:` (length 27, not zero). But even
    // if Telegram somehow surfaced data='', the gate must dispatch so
    // the downstream router can return delivered:false rather than
    // silently swallowing the tap.
    const calls: Array<{ data: string }> = []
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'sec',
      receiver: recordingReceiver(),
      on_callback_query: async ({ data }) => {
        calls.push({ data })
      },
    })
    const update = {
      update_id: 1,
      callback_query: { id: 'cb-1', from: { id: 2, first_name: 'X' }, data: '' },
    }
    const res = await handler(
      new Request('http://x/webhook', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'sec' },
        body: JSON.stringify(update),
      }),
    )
    expect(res.status).toBe(200)
    expect(calls.length).toBe(1)
    expect(calls[0]?.data).toBe('')
  })

  test('on_callback_query throw is swallowed; handler still returns 200', async () => {
    const recv = recordingReceiver()
    const handler = buildWebhookHandler({
      bot_user_id: 1,
      secret_token: 'sec',
      receiver: recv,
      on_callback_query: async () => {
        throw new Error('synthetic')
      },
    })
    const update = {
      update_id: 1,
      callback_query: { id: 'cb-1', from: { id: 2, first_name: 'X' }, data: 'btn:abc' },
    }
    const res = await handler(
      new Request('http://x/webhook', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'sec' },
        body: JSON.stringify(update),
      }),
    )
    expect(res.status).toBe(200)
  })
})
