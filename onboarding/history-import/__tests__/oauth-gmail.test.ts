/**
 * Gmail OAuth importer tests — mocked Gmail API.
 */

import { expect, test } from 'bun:test'
import { fetchGmailThreads, type GmailClient } from '../oauth-gmail.ts'
import { ImportError, type ConversationRecord } from '../types.ts'

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

const mockClient: GmailClient = {
  async *listThreads(input) {
    expect(input.after_ms).toBeGreaterThan(0)
    yield { thread_id: 't1', snippet: 'Subject: hello' }
    yield { thread_id: 't2', snippet: 'Subject: world' }
  },
  async getThread({ thread_id }) {
    return {
      thread_id,
      subject: `Subject for ${thread_id}`,
      messages: [
        {
          message_id: `${thread_id}-m1`,
          from: 'me <user@example.com>',
          to: 'someone@example.com',
          date_ms: 1714521600000,
          body_text: `Body for ${thread_id} m1`,
        },
        {
          message_id: `${thread_id}-m2`,
          from: 'someone@example.com',
          to: 'me <user@example.com>',
          date_ms: 1714521700000,
          body_text: `Reply for ${thread_id} m2`,
        },
      ],
    }
  },
}

test('fetches gmail threads with default 90-day window', async () => {
  const records = await collect(
    fetchGmailThreads({
      oauth: { access_token: 'xyz' },
      client: mockClient,
    }),
  )
  expect(records.length).toBe(2)
  expect(records[0]?.conversation_id).toBe('gmail:t1')
  expect(records[0]?.title).toBe('Subject for t1')
  expect(records[0]?.messages.length).toBe(2)
})

test('marks user-sent messages with role=user', async () => {
  const records = await collect(
    fetchGmailThreads({
      oauth: { access_token: 'xyz' },
      client: mockClient,
    }),
  )
  // First message has from='me ...' -> user (placeholder fallback);
  // second has from=someone -> event
  expect(records[0]?.messages[0]?.role).toBe('user')
  expect(records[0]?.messages[1]?.role).toBe('event')
})

test('user_email_address pin classifies the signed-in address as user', async () => {
  const realFromClient: GmailClient = {
    async *listThreads() {
      yield { thread_id: 't1' }
    },
    async getThread() {
      return {
        thread_id: 't1',
        subject: 'Test',
        messages: [
          {
            message_id: 't1-m1',
            from: 'Sam <user@example.com>',
            date_ms: Date.now(),
            body_text: 'Hi',
          },
          {
            message_id: 't1-m2',
            from: 'Priya <priya@example.com>',
            date_ms: Date.now(),
            body_text: 'Reply',
          },
        ],
      }
    },
  }
  const records = await collect(
    fetchGmailThreads({
      oauth: { access_token: 'xyz' },
      client: realFromClient,
      user_email_address: 'user@example.com',
    }),
  )
  expect(records[0]?.messages[0]?.role).toBe('user')
  expect(records[0]?.messages[1]?.role).toBe('event')
})

test('throws ImportError on empty access_token', async () => {
  await expect(async () => {
    for await (const _ of fetchGmailThreads({
      oauth: { access_token: '' },
      client: mockClient,
    })) {
      // unreachable
    }
  }).toThrow(ImportError)
})

test('respects max_threads cap', async () => {
  const wideClient: GmailClient = {
    async *listThreads() {
      for (let i = 0; i < 100; i++) yield { thread_id: `t-${i}` }
    },
    async getThread({ thread_id }) {
      return {
        thread_id,
        subject: 'x',
        messages: [
          {
            message_id: `${thread_id}-1`,
            date_ms: Date.now(),
            body_text: 'short',
          },
        ],
      }
    },
  }
  const records = await collect(
    fetchGmailThreads({
      oauth: { access_token: 'xyz' },
      client: wideClient,
      max_threads: 3,
    }),
  )
  expect(records.length).toBe(3)
})
