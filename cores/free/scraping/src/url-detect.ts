/**
 * @neutronai/scraping-core — URL classification + ID extraction.
 *
 * Pure, side-effect-free port of the host/path detection logic in
 * `~/vajra/scripts/ig-scrape.sh` + `tx-scrape.sh`. Used by both the
 * MCP tools (to pick the right Apify actor) and the `/scrape`
 * chat-command (to route a pasted URL to the IG vs X backend).
 */

export type ScrapePlatform = 'instagram' | 'x'

export interface InstagramTarget {
  platform: 'instagram'
  url: string
}

export interface XTarget {
  platform: 'x'
  /** Canonicalised URL passed to the actor. */
  url: string
  /** Numeric tweet/status id when the URL is a /status/<id> form. */
  tweet_id: string | null
  /** Numeric article id when the URL is the bare /i/article/<id> form
   *  (NOT resolvable to a body — the article actor needs the share-tweet
   *  id). */
  article_id: string | null
}

export type ScrapeTarget = InstagramTarget | XTarget

/** Mirror of `ig-scrape.sh`'s `^https?://(www\.)?instagram\.com/` guard. */
const INSTAGRAM_RE = /^https?:\/\/(www\.)?instagram\.com\//i

/** Mirror of `tx-scrape.sh`'s `^https?://(www\.)?(x|twitter)\.com/(.+)$`. */
const X_RE = /^https?:\/\/(www\.)?(x|twitter)\.com\/(.+)$/i

const STATUS_ID_RE = /status\/(\d+)/
const ARTICLE_ID_RE = /^i\/article\/(\d+)/

export function isInstagramUrl(url: string): boolean {
  return INSTAGRAM_RE.test(url.trim())
}

export function isXUrl(url: string): boolean {
  return X_RE.test(url.trim())
}

/**
 * Classify a URL into a typed scrape target, or `null` when it is
 * neither an Instagram nor an X/Twitter URL. Extracts the tweet/article
 * id for X URLs (mirrors `tx-scrape.sh`'s `BASH_REMATCH` parsing).
 */
export function classifyScrapeUrl(rawUrl: string): ScrapeTarget | null {
  const url = rawUrl.trim()
  if (isInstagramUrl(url)) {
    return { platform: 'instagram', url }
  }
  const xMatch = X_RE.exec(url)
  if (xMatch !== null) {
    const pathTail = xMatch[3] ?? ''
    const statusMatch = STATUS_ID_RE.exec(pathTail)
    const articleMatch = ARTICLE_ID_RE.exec(pathTail)
    return {
      platform: 'x',
      url,
      tweet_id: statusMatch?.[1] ?? null,
      article_id: articleMatch?.[1] ?? null,
    }
  }
  return null
}
