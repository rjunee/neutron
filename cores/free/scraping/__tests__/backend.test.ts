import { describe, expect, test } from 'bun:test'

import {
  buildScrapingBackend,
  NO_TOKEN_GUIDANCE,
  type TokenProvider,
} from '../src/backend.ts'
import {
  INSTAGRAM_ACTOR,
  X_ARTICLE_ACTOR,
  X_TWEET_ACTOR,
  type FetchLike,
} from '../src/apify-client.ts'

interface Recorded {
  url: string
  body: unknown
}

/** A mock fetcher that records every call + returns a canned dataset. */
function mockFetcher(dataset: unknown): {
  fetcher: FetchLike
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const fetcher: FetchLike = async (url, init) => {
    calls.push({
      url,
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response(JSON.stringify(dataset), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetcher, calls }
}

const tokenAlways: TokenProvider = async () => 'apify_token_xyz'
const tokenNever: TokenProvider = async () => null

describe('backend — optional-until-credentialed (the core invariant)', () => {
  test('NO token → scrapeInstagram no-ops with guidance and NEVER calls Apify', async () => {
    const { fetcher, calls } = mockFetcher([])
    const backend = buildScrapingBackend({ tokenProvider: tokenNever, fetcher })
    const r = await backend.scrapeInstagram({
      url: 'https://instagram.com/p/abc/',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('no_token')
      expect(r.guidance).toBe(NO_TOKEN_GUIDANCE)
    }
    expect(calls.length).toBe(0) // hard invariant: no outbound call
  })

  test('NO token → scrapeX also no-ops, no Apify call', async () => {
    const { fetcher, calls } = mockFetcher([])
    const backend = buildScrapingBackend({ tokenProvider: tokenNever, fetcher })
    const r = await backend.scrapeX({ url: 'https://x.com/a/status/1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('no_token')
    expect(calls.length).toBe(0)
  })

  test('whitespace-only token is treated as absent', async () => {
    const { fetcher, calls } = mockFetcher([])
    const backend = buildScrapingBackend({
      tokenProvider: async () => '   ',
      fetcher,
    })
    const r = await backend.scrapeInstagram({ url: 'https://instagram.com/p/x/' })
    expect(r.ok).toBe(false)
    expect(calls.length).toBe(0)
  })

  test('isCredentialed reflects the live token provider', async () => {
    const fetcher = mockFetcher([]).fetcher
    expect(
      await buildScrapingBackend({ tokenProvider: tokenAlways, fetcher }).isCredentialed(),
    ).toBe(true)
    expect(
      await buildScrapingBackend({ tokenProvider: tokenNever, fetcher }).isCredentialed(),
    ).toBe(false)
  })
})

describe('backend — Instagram scrape call construction', () => {
  test('token present → posts to the instagram actor with directUrls + token', async () => {
    const item = {
      type: 'Image',
      ownerUsername: 'gary',
      caption: 'hello world',
      likesCount: 5,
      commentsCount: 2,
      hashtags: ['a'],
      mentions: ['b'],
    }
    const { fetcher, calls } = mockFetcher([item])
    const backend = buildScrapingBackend({ tokenProvider: tokenAlways, fetcher })
    const r = await backend.scrapeInstagram({
      url: 'https://instagram.com/p/abc/',
      mode: 'caption',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.platform).toBe('instagram')
      expect(r.mode).toBe('caption')
      expect(r.text).toBe('hello world')
    }
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toContain(INSTAGRAM_ACTOR)
    expect(calls[0]?.url).toContain('token=apify_token_xyz')
    expect(calls[0]?.body).toMatchObject({
      directUrls: ['https://instagram.com/p/abc/'],
      resultsType: 'details',
    })
  })

  test('summary mode renders a digest', async () => {
    const item = {
      type: 'Sidecar',
      ownerUsername: 'gary',
      url: 'https://instagram.com/p/abc/',
      caption: 'cap',
      likesCount: 9,
      commentsCount: 1,
    }
    const { fetcher } = mockFetcher([item])
    const backend = buildScrapingBackend({ tokenProvider: tokenAlways, fetcher })
    const r = await backend.scrapeInstagram({
      url: 'https://instagram.com/p/abc/',
      mode: 'summary',
    })
    expect(r.ok && r.text.includes('owner:    @gary')).toBe(true)
    expect(r.ok && r.text.includes('likes:    9')).toBe(true)
  })

  test('empty dataset → empty_result', async () => {
    const { fetcher } = mockFetcher([])
    const backend = buildScrapingBackend({ tokenProvider: tokenAlways, fetcher })
    const r = await backend.scrapeInstagram({ url: 'https://instagram.com/p/x/' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('empty_result')
  })

  test('non-instagram URL → invalid_url, no call', async () => {
    const { fetcher, calls } = mockFetcher([])
    const backend = buildScrapingBackend({ tokenProvider: tokenAlways, fetcher })
    const r = await backend.scrapeInstagram({ url: 'https://x.com/a/status/1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid_url')
    expect(calls.length).toBe(0)
  })
})

describe('backend — X scrape call construction', () => {
  test('single tweet text mode → kaitoeasyapi actor with tweetIDs', async () => {
    const tweet = {
      author: { userName: 'bob' },
      text: 'hi there',
      createdAt: '2024-01-01',
    }
    const { fetcher, calls } = mockFetcher([tweet])
    const backend = buildScrapingBackend({ tokenProvider: tokenAlways, fetcher })
    const r = await backend.scrapeX({
      url: 'https://x.com/bob/status/777',
      mode: 'text',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.platform).toBe('x')
      expect(r.text).toBe('@bob [2024-01-01]:\nhi there')
    }
    expect(calls[0]?.url).toContain(X_TWEET_ACTOR)
    expect(calls[0]?.body).toMatchObject({ tweetIDs: ['777'], maxItems: 1 })
  })

  test('thread mode → conversationIDs + includeReplies, author-filtered output', async () => {
    const dataset = [
      { author: { userName: 'bob' }, text: 'one', createdAt: '2024-01-01' },
      { author: { userName: 'replier' }, text: 'noise', createdAt: '2024-01-01' },
      { author: { userName: 'bob' }, text: 'two', createdAt: '2024-01-02' },
    ]
    const { fetcher, calls } = mockFetcher(dataset)
    const backend = buildScrapingBackend({ tokenProvider: tokenAlways, fetcher })
    const r = await backend.scrapeX({
      url: 'https://x.com/bob/status/777',
      mode: 'text',
      thread: true,
    })
    expect(calls[0]?.body).toMatchObject({
      tweetIDs: ['777'],
      conversationIDs: ['777'],
      includeReplies: true,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toContain('one')
      expect(r.text).toContain('two')
      expect(r.text).not.toContain('noise') // replier filtered out
    }
  })

  test('article mode → fastcrawler actor, returns the markdown body', async () => {
    const dataset = [{ md: '' }, { md: '# Title\n\nBody' }]
    const { fetcher, calls } = mockFetcher(dataset)
    const backend = buildScrapingBackend({ tokenProvider: tokenAlways, fetcher })
    const r = await backend.scrapeX({
      url: 'https://x.com/garrytan/status/2061454423034110372',
      mode: 'article',
    })
    expect(calls[0]?.url).toContain(X_ARTICLE_ACTOR)
    expect(calls[0]?.body).toMatchObject({ tweetIds: ['2061454423034110372'] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe('# Title\n\nBody')
  })

  test('bare /i/article/<id> → article_needs_share_tweet, no Apify call', async () => {
    const { fetcher, calls } = mockFetcher([])
    const backend = buildScrapingBackend({ tokenProvider: tokenAlways, fetcher })
    const r = await backend.scrapeX({ url: 'https://x.com/i/article/555' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('article_needs_share_tweet')
    expect(calls.length).toBe(0)
  })

  test('Apify {error} envelope → apify_error', async () => {
    const { fetcher } = mockFetcher({ error: { message: 'rate limited' } })
    const backend = buildScrapingBackend({ tokenProvider: tokenAlways, fetcher })
    const r = await backend.scrapeX({ url: 'https://x.com/a/status/1' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('apify_error')
      expect(r.message).toContain('rate limited')
    }
  })
})

describe('backend — scrapeUrl auto-routing (the /scrape path)', () => {
  test('routes instagram + x URLs to the right platform', async () => {
    const { fetcher } = mockFetcher([{ caption: 'c', author: { userName: 'z' }, text: 't' }])
    const backend = buildScrapingBackend({ tokenProvider: tokenAlways, fetcher })
    const ig = await backend.scrapeUrl({ url: 'https://instagram.com/p/x/' })
    expect(ig.ok && ig.platform).toBe('instagram')
    const x = await backend.scrapeUrl({ url: 'https://x.com/a/status/1' })
    expect(x.ok && x.platform).toBe('x')
  })

  test('unsupported URL → invalid_url, no call', async () => {
    const { fetcher, calls } = mockFetcher([])
    const backend = buildScrapingBackend({ tokenProvider: tokenAlways, fetcher })
    const r = await backend.scrapeUrl({ url: 'https://youtube.com/watch?v=1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid_url')
    expect(calls.length).toBe(0)
  })
})
