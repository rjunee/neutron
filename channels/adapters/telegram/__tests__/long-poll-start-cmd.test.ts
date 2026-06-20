/**
 * long-poll `/start onboard_<correlator>` dispatch test
 * (Codex r2 P2 follow-up).
 *
 * Mirrors the webhook-server `/start` dispatch test for the long-poll
 * fallback path so solo-dev / DR-fallback deployments stay consistent
 * with production webhook deployments.
 */

import { describe, expect, test } from 'bun:test'
import { runLongPoll } from '../long-poll.ts'
import type { TelegramClient } from '../client.ts'
import type { TelegramUpdate } from '../webhook-server.ts'
import type { IncomingEvent, IncomingEventReceiver } from '../../../types.ts'

const recordingReceiver = (): IncomingEventReceiver & { events: IncomingEvent[] } => {
  const events: IncomingEvent[] = []
  return { events, receive: async (event) => { events.push(event) } }
}

/** Stub TelegramClient.call that returns a fixed batch of updates on
 *  the FIRST `getUpdates` call, then aborts the loop. */
function makeClient(updates: TelegramUpdate[], onAbort: () => void): TelegramClient {
  let served = false
  return {
    async call(method: string): Promise<unknown> {
      if (method !== 'getUpdates') throw new Error(`unexpected method ${method}`)
      if (served) {
        // Abort on the second poll so the test loop exits.
        onAbort()
        return []
      }
      served = true
      return updates
    },
  } as unknown as TelegramClient
}

describe('runLongPoll /start dispatch', () => {
  test('Codex r2 P2: /start onboard_<correlator> in a private chat dispatches to handler', async () => {
    const calls: Array<{ payload: string; from_user_id: string; chat_id: string }> = []
    const recv = recordingReceiver()
    const controller = new AbortController()
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 42, first_name: 'Tester' },
        chat: { id: 99, type: 'private' },
        date: 1700000000,
        text: '/start onboard_corr-XYZ',
      },
    }
    const client = makeClient([update], () => controller.abort())
    await runLongPoll(client, controller.signal, {
      bot_user_id: 1,
      receiver: recv,
      long_poll_timeout_s: 0,
      on_start_command: async ({ payload, from_user_id, chat_id }) => {
        calls.push({ payload, from_user_id, chat_id })
      },
    })
    expect(calls.length).toBe(1)
    expect(calls[0]?.payload).toBe('corr-XYZ')
    expect(calls[0]?.from_user_id).toBe('42')
    expect(calls[0]?.chat_id).toBe('99')
    // The text receiver MUST NOT have been invoked — `/start` was
    // dispatched and consumed.
    expect(recv.events.length).toBe(0)
  })

  test('Codex r2 P2: /start onboard_<correlator> pasted into a group falls through to receiver', async () => {
    const calls: Array<{ payload: string }> = []
    const recv = recordingReceiver()
    const controller = new AbortController()
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 42, first_name: 'Tester' },
        chat: { id: -100123, type: 'supergroup' },
        date: 1700000000,
        text: '/start onboard_x',
        message_thread_id: 7,
      },
    }
    const client = makeClient([update], () => controller.abort())
    await runLongPoll(client, controller.signal, {
      bot_user_id: 1,
      receiver: recv,
      long_poll_timeout_s: 0,
      on_start_command: async ({ payload }) => {
        calls.push({ payload })
      },
    })
    expect(calls.length).toBe(0)
    // Falls through; lands on the text receiver.
    expect(recv.events.length).toBe(1)
    expect(recv.events[0]?.body.text).toBe('/start onboard_x')
  })

  test('non-onboarding /start <something> falls through in long-poll too', async () => {
    const calls: Array<{ payload: string }> = []
    const recv = recordingReceiver()
    const controller = new AbortController()
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 42, first_name: 'Tester' },
        chat: { id: 99, type: 'private' },
        date: 1700000000,
        text: '/start help',
      },
    }
    const client = makeClient([update], () => controller.abort())
    await runLongPoll(client, controller.signal, {
      bot_user_id: 1,
      receiver: recv,
      long_poll_timeout_s: 0,
      on_start_command: async ({ payload }) => {
        calls.push({ payload })
      },
    })
    expect(calls.length).toBe(0)
    expect(recv.events.length).toBe(1)
    expect(recv.events[0]?.body.text).toBe('/start help')
  })
})
