/**
 * @neutronai/gateway/push — ExpoPushClient tests.
 *
 * The client is a thin HTTP wrapper. Tests verify:
 *   - the request body shape Expo expects
 *   - bearer-auth is attached when access_token is configured
 *   - chunking caps each request at batch_size
 *   - per-ticket errors surface in the result without throwing
 *   - non-200 HTTP from Expo throws ExpoPushError
 *   - empty message list short-circuits without an HTTP call
 *
 * No real network — every test injects a fake fetch.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_EXPO_PUSH_ENDPOINT,
  EXPO_PUSH_BATCH_SIZE,
  ExpoPushError,
  createExpoPushClient,
  type ExpoFetch,
  type ExpoPushMessage,
  type ExpoPushTicket,
} from './expo-push-client.ts'

interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: ExpoPushMessage[]
}

function makeFetch(
  responses: Array<{
    status?: number
    ok?: boolean
    body: { data?: ExpoPushTicket[] } | string
  }>,
): { fetch: ExpoFetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = []
  let i = 0
  const fetchImpl: ExpoFetch = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: JSON.parse(init.body ?? '[]'),
    })
    const r = responses[i++] ?? responses[responses.length - 1]
    if (r === undefined) {
      throw new Error('makeFetch: no responses queued')
    }
    const status = r.status ?? 200
    const ok = r.ok ?? (status >= 200 && status < 300)
    return {
      ok,
      status,
      text: async () =>
        typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      json: async () => r.body,
    }
  }
  return { fetch: fetchImpl, calls }
}

describe('ExpoPushClient.send', () => {
  test('empty messages → no HTTP, ok=true', async () => {
    const { fetch, calls } = makeFetch([{ body: { data: [] } }])
    const client = createExpoPushClient({ fetch })
    const result = await client.send([])
    expect(result.ok).toBe(true)
    expect(result.tickets.length).toBe(0)
    expect(calls.length).toBe(0)
  })

  test('single-message POST hits default Expo endpoint with JSON body', async () => {
    const { fetch, calls } = makeFetch([
      { body: { data: [{ status: 'ok', id: 'tick-1' }] } },
    ])
    const client = createExpoPushClient({ fetch })
    const messages: ExpoPushMessage[] = [
      {
        to: 'ExponentPushToken[abc]',
        title: 'Reminder',
        body: 'walk the dog',
        sound: 'default',
        data: { kind: 'reminder', reminder_id: 'r-1' },
      },
    ]
    const result = await client.send(messages)
    expect(result.ok).toBe(true)
    expect(result.tickets[0]?.status).toBe('ok')
    expect(calls.length).toBe(1)
    const c = calls[0]
    expect(c?.url).toBe(DEFAULT_EXPO_PUSH_ENDPOINT)
    expect(c?.method).toBe('POST')
    expect(c?.headers['content-type']).toBe('application/json')
    expect(c?.headers['authorization']).toBeUndefined()
    expect(c?.body.length).toBe(1)
    expect(c?.body[0]?.to).toBe('ExponentPushToken[abc]')
    expect(c?.body[0]?.body).toBe('walk the dog')
  })

  test('access_token attaches Authorization: Bearer header', async () => {
    const { fetch, calls } = makeFetch([{ body: { data: [{ status: 'ok' }] } }])
    const client = createExpoPushClient({
      fetch,
      access_token: 'super-secret-token',
    })
    await client.send([{ to: 'tok', body: 'hi' }])
    expect(calls[0]?.headers['authorization']).toBe('Bearer super-secret-token')
  })

  test('chunks at batch_size and preserves ticket order across batches', async () => {
    const { fetch, calls } = makeFetch([
      { body: { data: [{ status: 'ok', id: 't1' }, { status: 'ok', id: 't2' }] } },
      { body: { data: [{ status: 'ok', id: 't3' }] } },
    ])
    const client = createExpoPushClient({ fetch, batch_size: 2 })
    const msgs: ExpoPushMessage[] = [
      { to: 'tok-1', body: 'm1' },
      { to: 'tok-2', body: 'm2' },
      { to: 'tok-3', body: 'm3' },
    ]
    const result = await client.send(msgs)
    expect(result.tickets.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
    expect(calls.length).toBe(2)
    expect(calls[0]?.body.length).toBe(2)
    expect(calls[1]?.body.length).toBe(1)
  })

  test('mix of ok + error tickets returns ok=false but does NOT throw', async () => {
    const { fetch } = makeFetch([
      {
        body: {
          data: [
            { status: 'ok', id: 't1' },
            {
              status: 'error',
              message: 'DeviceNotRegistered',
              details: { error: 'DeviceNotRegistered' },
            },
          ],
        },
      },
    ])
    const client = createExpoPushClient({ fetch })
    const result = await client.send([
      { to: 'tok-a', body: 'a' },
      { to: 'tok-b', body: 'b' },
    ])
    expect(result.ok).toBe(false)
    expect(result.tickets.length).toBe(2)
    expect(result.tickets[1]?.status).toBe('error')
    expect(result.tickets[1]?.details?.error).toBe('DeviceNotRegistered')
  })

  test('non-200 HTTP from Expo throws ExpoPushError with status', async () => {
    const { fetch } = makeFetch([
      { status: 500, ok: false, body: 'upstream offline' },
    ])
    const client = createExpoPushClient({ fetch })
    let err: unknown = null
    try {
      await client.send([{ to: 't', body: 'x' }])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ExpoPushError)
    expect((err as ExpoPushError).status).toBe(500)
  })

  test('non-array .data payload from Expo throws ExpoPushError', async () => {
    const { fetch } = makeFetch([{ body: { data: 'not-an-array' as unknown as ExpoPushTicket[] } }])
    const client = createExpoPushClient({ fetch })
    await expect(client.send([{ to: 't', body: 'x' }])).rejects.toThrow(ExpoPushError)
  })

  test('default batch size equals the documented Expo cap', () => {
    expect(EXPO_PUSH_BATCH_SIZE).toBe(100)
  })

  test('custom endpoint overrides the default', async () => {
    const { fetch, calls } = makeFetch([{ body: { data: [{ status: 'ok' }] } }])
    const client = createExpoPushClient({ fetch, endpoint: 'https://test.example/push' })
    await client.send([{ to: 'tok', body: 'hi' }])
    expect(calls[0]?.url).toBe('https://test.example/push')
  })

  test('invalid batch_size rejects at construction', () => {
    expect(() => createExpoPushClient({ batch_size: 0 })).toThrow(/batch_size/)
    expect(() => createExpoPushClient({ batch_size: -5 })).toThrow(/batch_size/)
  })
})
