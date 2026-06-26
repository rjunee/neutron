/**
 * @neutronai/scraping-core — Apify actor client.
 *
 * Direct TS port of `~/vajra/scripts/ig-scrape.sh` + `tx-scrape.sh`.
 * Each function takes the Apify token + a `fetch` impl (injectable for
 * tests) and calls the actor's `run-sync-get-dataset-items` endpoint —
 * which blocks until the run finishes and returns the dataset items.
 *
 * Actors (same ones the Vajra scripts use, no per-actor approval needed):
 *   - Instagram:        apify/instagram-scraper
 *   - X tweets/threads: kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest
 *   - X long articles:  fastcrawler/x-twitter-article-to-markdown
 *
 * This module NEVER reads the token itself — the caller resolves it via
 * the capability-gated `SecretsAccessor`. A function here is only ever
 * invoked once a non-empty token is in hand (the backend guards that),
 * so these helpers assume `token` is present.
 */

import type { XTarget } from './url-detect.ts'

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

const APIFY_BASE = 'https://api.apify.com/v2/acts'

export const INSTAGRAM_ACTOR = 'apify~instagram-scraper'
export const X_TWEET_ACTOR =
  'kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest'
export const X_ARTICLE_ACTOR = 'fastcrawler~x-twitter-article-to-markdown'

export type ApifyErrorCode =
  | 'apify_error'
  | 'empty_result'
  | 'article_needs_share_tweet'

export class ApifyScrapeError extends Error {
  override readonly name = 'ApifyScrapeError'
  constructor(
    readonly code: ApifyErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface ScrapeOutput {
  /** The raw dataset item(s) — shape varies by actor. */
  data: unknown
  /** Human-readable rendering for the requested mode. */
  text: string
}

function endpoint(actor: string, token: string): string {
  return `${APIFY_BASE}/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`
}

async function postActor(
  actor: string,
  token: string,
  payload: unknown,
  fetcher: FetchLike,
): Promise<unknown[]> {
  const res = await fetcher(endpoint(actor, token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new ApifyScrapeError(
      'apify_error',
      `Apify returned non-JSON (HTTP ${res.status})`,
    )
  }
  // Apify error shape: {"error": {...}}.
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const err = (body as Record<string, unknown>)['error']
    if (err !== undefined) {
      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as Record<string, unknown>)['message'])
          : JSON.stringify(err)
      throw new ApifyScrapeError('apify_error', `Apify error: ${msg}`)
    }
  }
  if (!res.ok) {
    throw new ApifyScrapeError('apify_error', `Apify HTTP ${res.status}`)
  }
  if (!Array.isArray(body)) {
    throw new ApifyScrapeError(
      'apify_error',
      'Apify response was not a dataset array',
    )
  }
  return body
}

// ── Instagram ──────────────────────────────────────────────────────────

export type InstagramMode = 'json' | 'caption' | 'summary'

export async function scrapeInstagram(opts: {
  url: string
  mode: InstagramMode
  token: string
  fetcher: FetchLike
}): Promise<ScrapeOutput> {
  const items = await postActor(
    INSTAGRAM_ACTOR,
    opts.token,
    {
      directUrls: [opts.url],
      resultsType: 'details',
      resultsLimit: 1,
      addParentData: false,
    },
    opts.fetcher,
  )
  const first = items[0]
  if (first === undefined || first === null) {
    throw new ApifyScrapeError('empty_result', 'empty result from Apify')
  }
  const item = first as Record<string, unknown>
  if (opts.mode === 'caption') {
    return { data: item, text: str(item['caption']) }
  }
  if (opts.mode === 'summary') {
    return { data: item, text: renderInstagramSummary(item) }
  }
  return { data: item, text: JSON.stringify(item, null, 2) }
}

function renderInstagramSummary(item: Record<string, unknown>): string {
  const hashtags = arr(item['hashtags']).join(' ')
  const mentions = arr(item['mentions']).join(' ')
  return [
    `type:     ${str(item['type']) || '?'}`,
    `owner:    @${str(item['ownerUsername']) || '?'}`,
    `url:      ${str(item['url']) || '?'}`,
    `posted:   ${str(item['timestamp']) || '?'}`,
    `likes:    ${num(item['likesCount'])}`,
    `comments: ${num(item['commentsCount'])}`,
    '',
    'CAPTION:',
    str(item['caption']) || '(none)',
    '',
    `HASHTAGS: ${hashtags}`,
    `MENTIONS: ${mentions}`,
  ].join('\n')
}

// ── X / Twitter ────────────────────────────────────────────────────────

export type XMode = 'json' | 'text' | 'summary' | 'article'

export async function scrapeX(opts: {
  target: XTarget
  mode: XMode
  thread: boolean
  token: string
  fetcher: FetchLike
}): Promise<ScrapeOutput> {
  const { target } = opts

  // /i/article/<id> URLs are not resolvable to an article body — the
  // fastcrawler actor needs the SHARE-tweet id, not the article id.
  // Mirror tx-scrape.sh's hard bail.
  if (target.article_id !== null && target.tweet_id === null) {
    throw new ApifyScrapeError(
      'article_needs_share_tweet',
      `got an /i/article/<id> URL (${target.article_id}). The article-to-markdown actor needs the SHARE-tweet URL (the tweet that links to the article), not the article id itself. Find the share-tweet URL (e.g. https://x.com/<author>/status/<id>) and rerun.`,
    )
  }

  if (opts.mode === 'article') {
    if (target.tweet_id === null) {
      throw new ApifyScrapeError(
        'article_needs_share_tweet',
        'article mode requires a share-tweet URL (e.g. https://x.com/<author>/status/<id>)',
      )
    }
    const items = await postActor(
      X_ARTICLE_ACTOR,
      opts.token,
      { tweetIds: [target.tweet_id] },
      opts.fetcher,
    )
    // Filter KaitoEasyAPI mock-data filler rows; require non-empty md.
    const md = items
      .map((it) =>
        it !== null && typeof it === 'object'
          ? str((it as Record<string, unknown>)['md'])
          : '',
      )
      .find((m) => m.length > 0)
    if (md === undefined) {
      throw new ApifyScrapeError(
        'empty_result',
        `fastcrawler returned empty markdown for tweet ${target.tweet_id}. The tweet may not link to an X Article.`,
      )
    }
    return { data: items, text: md }
  }

  // Tweet / thread / profile path.
  let payload: Record<string, unknown>
  if (target.tweet_id !== null) {
    payload = opts.thread
      ? {
          tweetIDs: [target.tweet_id],
          conversationIDs: [target.tweet_id],
          maxItems: 200,
          includeReplies: true,
        }
      : { tweetIDs: [target.tweet_id], maxItems: 1 }
  } else {
    payload = { startUrls: [target.url], maxItems: 25 }
  }
  const items = await postActor(X_TWEET_ACTOR, opts.token, payload, opts.fetcher)
  if (items.length === 0) {
    throw new ApifyScrapeError(
      'empty_result',
      'empty result from Apify (tweet may be deleted, age-gated, or actor schema changed)',
    )
  }

  if (opts.mode === 'json') {
    return { data: items, text: JSON.stringify(items, null, 2) }
  }

  const records = items.filter(
    (it): it is Record<string, unknown> =>
      it !== null && typeof it === 'object',
  )
  if (opts.thread) {
    const rootAuthor = authorOf(records[0] ?? {})
    const authored = records
      .filter((r) => authorOf(r) === rootAuthor)
      .sort((a, b) => createdMs(a) - createdMs(b))
    if (opts.mode === 'summary') {
      const header = `Author: @${rootAuthor}\nThread: ${authored.length} author-tweets\n`
      const lines = authored.map(
        (r) => `[${tweetTs(r)}] ${oneLine(tweetText(r)).slice(0, 280)}`,
      )
      return { data: items, text: `${header}\n${lines.join('\n')}` }
    }
    // text
    const lines = authored.map(
      (r) => `@${authorOf(r)} [${tweetTs(r)}]:\n${tweetText(r)}\n---`,
    )
    return { data: items, text: lines.join('\n') }
  }

  const first = records[0] ?? {}
  if (opts.mode === 'summary') {
    return {
      data: items,
      text: [
        `Author: @${authorOf(first)}`,
        `Date: ${tweetTs(first)}`,
        `Likes: ${num(first['likeCount'] ?? first['favoriteCount'])} | Retweets: ${num(first['retweetCount'])} | Replies: ${num(first['replyCount'])}`,
        '',
        tweetText(first),
      ].join('\n'),
    }
  }
  // text
  return {
    data: items,
    text: `@${authorOf(first)} [${tweetTs(first)}]:\n${tweetText(first)}`,
  }
}

// ── field extraction helpers (port of tx-scrape.sh jq fallbacks) ─────────

function authorOf(r: Record<string, unknown>): string {
  const author = obj(r['author'])
  const user = obj(r['user'])
  return (
    str(author['userName']) ||
    str(author['username']) ||
    str(author['handle']) ||
    str(user['username']) ||
    ''
  )
}

function tweetText(r: Record<string, unknown>): string {
  return str(r['text']) || str(r['full_text']) || str(r['fullText'])
}

function tweetTs(r: Record<string, unknown>): string {
  return str(r['createdAt']) || str(r['timestamp'])
}

function createdMs(r: Record<string, unknown>): number {
  const raw = r['createdAt'] ?? r['timestamp']
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const t = Date.parse(raw)
    if (!Number.isNaN(t)) return t
  }
  return 0
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ')
}

// ── primitive coercions ──────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}
