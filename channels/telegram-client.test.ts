import { describe, expect, test } from 'bun:test'
import {
  TelegramClient,
  TelegramRetryAfterError,
} from './adapters/telegram/client.ts'

interface FakeFetchEntry {
  match: (url: string, init?: RequestInit) => boolean
  response: () => Response
}

const fakeFetch = (entries: FakeFetchEntry[]): typeof fetch => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString()
    calls.push({ url: u, ...(init !== undefined ? { init } : {}) })
    for (const e of entries) {
      if (e.match(u, init)) return e.response()
    }
    throw new Error(`unmatched fetch ${u}`)
  }) as typeof fetch
  ;(fetcher as unknown as { calls: typeof calls }).calls = calls
  return fetcher
}

describe('TelegramClient', () => {
  test('sendMessage POSTs JSON body and returns parsed result', async () => {
    const fetcher = fakeFetch([
      {
        match: (u) => u.endsWith('/botABC/sendMessage'),
        response: () =>
          new Response(
            JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 1 }, date: 999 } }),
            { headers: { 'content-type': 'application/json' } },
          ),
      },
    ])
    const client = new TelegramClient('ABC', { fetcher })
    const out = await client.sendMessage({ chat_id: 1, text: 'hi' })
    expect(out.message_id).toBe(42)
  })

  test('429 with retry_after parameter throws TelegramRetryAfterError', async () => {
    const fetcher = fakeFetch([
      {
        match: () => true,
        response: () =>
          new Response(
            JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 5 } }),
            { status: 429, headers: { 'content-type': 'application/json' } },
          ),
      },
    ])
    const client = new TelegramClient('ABC', { fetcher })
    await expect(client.sendMessage({ chat_id: 1, text: 'x' })).rejects.toBeInstanceOf(
      TelegramRetryAfterError,
    )
  })

  test('non-OK response without retry_after surfaces description in error message', async () => {
    const fetcher = fakeFetch([
      {
        match: () => true,
        response: () =>
          new Response(
            JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
      },
    ])
    const client = new TelegramClient('ABC', { fetcher })
    await expect(client.sendMessage({ chat_id: 1, text: 'x' })).rejects.toThrow(
      /chat not found/,
    )
  })

  test('non-empty token is required', () => {
    expect(() => new TelegramClient('')).toThrow(/non-empty token/)
  })
})

describe('TelegramClient.downloadFile — streaming cap', () => {
  test('stops reading once the body passes the cap, even with no Content-Length', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1024))
        if (pulled > 1000) controller.close()
      },
    })
    const fetcher = (async () => new Response(body)) as unknown as typeof fetch
    const client = new TelegramClient('t', { fetcher })
    await expect(client.downloadFile('a/b.jpg', 4096)).rejects.toThrow('cap')
    expect(pulled).toBeLessThan(20)
  })

  test('returns the bytes when under the cap', async () => {
    const fetcher = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch
    const client = new TelegramClient('t', { fetcher })
    expect(Array.from(await client.downloadFile('a/b.jpg', 10))).toEqual([1, 2, 3])
  })
})
