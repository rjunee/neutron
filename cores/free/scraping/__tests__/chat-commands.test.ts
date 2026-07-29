import { describe, expect, test } from 'bun:test'

import {
  executeScrapeCommand,
  parseScrapeCommand,
} from '../src/chat-commands.ts'
import { createScrapingChatCommandFilter } from '../src/chat-bridge.ts'
import { buildScrapingBackend, type TokenProvider } from '../src/backend.ts'
import type { FetchLike } from '../src/apify-client.ts'

const okFetcher: FetchLike = async () =>
  new Response(
    JSON.stringify([{ author: { userName: 'bob' }, text: 'hi', createdAt: '2024' }]),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

function backendWith(token: TokenProvider, fetcher: FetchLike = okFetcher) {
  return buildScrapingBackend({ tokenProvider: token, fetcher })
}

describe('parseScrapeCommand', () => {
  test('bare /scrape and /scrape help → help', () => {
    expect(parseScrapeCommand('/scrape').kind).toBe('help')
    expect(parseScrapeCommand('/scrape help').kind).toBe('help')
  })

  test('parses url + mode + --thread in any order', () => {
    const c = parseScrapeCommand('/scrape text https://x.com/a/status/1 --thread')
    expect(c).toEqual({
      kind: 'scrape',
      url: 'https://x.com/a/status/1',
      mode: 'text',
      thread: true,
    })
  })

  test('url only → default mode, no thread', () => {
    const c = parseScrapeCommand('/scrape https://instagram.com/p/x/')
    expect(c).toMatchObject({ kind: 'scrape', thread: false })
    expect(c).not.toHaveProperty('mode')
  })

  test('missing url → unrecognized with usage', () => {
    const c = parseScrapeCommand('/scrape summary')
    expect(c.kind).toBe('unrecognized')
  })

  test('not a /scrape command → unrecognized', () => {
    expect(parseScrapeCommand('/research foo').kind).toBe('unrecognized')
    expect(parseScrapeCommand('/scrapex http://x').kind).toBe('unrecognized')
  })
})

describe('executeScrapeCommand', () => {
  test('no token → returns the admin guidance (optional-until-credentialed)', async () => {
    const backend = backendWith(async () => null)
    const res = await executeScrapeCommand(
      parseScrapeCommand('/scrape https://instagram.com/p/x/'),
      { backend },
    )
    expect(res.error?.code).toBe('no_token')
    expect(res.text.toLowerCase()).toContain('apify api token')
  })

  test('token present → renders the scraped text', async () => {
    const backend = backendWith(async () => 'tok')
    const res = await executeScrapeCommand(
      parseScrapeCommand('/scrape https://x.com/bob/status/1 text'),
      { backend },
    )
    expect(res.error).toBeUndefined()
    expect(res.text).toContain('@bob')
  })

  test('help describes both platforms', async () => {
    const backend = backendWith(async () => null)
    const res = await executeScrapeCommand(parseScrapeCommand('/scrape'), { backend })
    expect(res.text.toLowerCase()).toContain('instagram')
  })
})

describe('createScrapingChatCommandFilter', () => {
  test('returns null for non-/scrape bodies (falls through to LLM)', async () => {
    const filter = createScrapingChatCommandFilter({
      backend: backendWith(async () => 'tok'),
    })
    const r = await filter.match({
      user_id: 'u',
      project_slug: 'p',
      channel_topic_id: 't',
      body: 'just chatting',
    })
    expect(r).toBeNull()
  })

  test('handles /scrape and shares the backend token path (no-token guidance)', async () => {
    const filter = createScrapingChatCommandFilter({
      backend: backendWith(async () => null),
    })
    const r = await filter.match({
      user_id: 'u',
      project_slug: 'p',
      channel_topic_id: 't',
      body: '/scrape https://instagram.com/p/x/',
    })
    expect(r).not.toBeNull()
    expect(r?.error?.code).toBe('no_token')
  })
})
