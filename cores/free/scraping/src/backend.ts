/**
 * @neutronai/scraping-core — backend (shared by MCP tools + /scrape).
 *
 * Owns the optional-until-credentialed contract: it resolves the user's
 * Apify token via an injected `tokenProvider` closure on EVERY call
 * (so a token pasted in admin after boot takes effect with no restart),
 * and:
 *   - token present  → calls the matching Apify actor, returns the result
 *   - token absent   → returns `{ok:false, code:'no_token'}` with guidance.
 *                      NEVER calls Apify without a token.
 *
 * The same `ScrapingBackend` instance backs both surfaces so they share
 * one token-read path + one `fetch` impl (agent-native parity).
 *
 * `tokenProvider` is the only credential seam. Production wires it to
 * `() => secretsAccessor.get('byo_api_key', 'apify')`; tests inject a
 * stub returning a fixed token (or null) so the no-token path is
 * exercised without touching a real SecretsStore.
 */

import {
  ApifyScrapeError,
  scrapeInstagram,
  scrapeX,
  type FetchLike,
  type InstagramMode,
  type XMode,
} from './apify-client.ts'
import { classifyScrapeUrl, type ScrapeTarget } from './url-detect.ts'

/** Guidance surfaced whenever the Apify token is missing — the literal
 *  "add your Apify token in admin" message the brief requires. */
export const NO_TOKEN_GUIDANCE =
  'Instagram/X scraping needs an Apify API token. Add one under admin → ' +
  'Integrations → Apify (free tier ~2000 results/month, no card). Get it ' +
  'from Apify Console → Settings → Integrations → API token.'

export type ScrapeResultCode =
  | 'no_token'
  | 'invalid_url'
  | 'empty_result'
  | 'apify_error'
  | 'article_needs_share_tweet'

export type ScrapeOk = {
  ok: true
  platform: 'instagram' | 'x'
  mode: string
  url: string
  /** Human-readable rendering for the requested mode. */
  text: string
  /** Raw Apify dataset item(s). */
  data: unknown
}

export type ScrapeErr = {
  ok: false
  code: ScrapeResultCode
  message: string
  /** Set on `no_token` — the actionable admin guidance. */
  guidance?: string
  /** Echoed back when known. */
  url?: string
}

export type ScrapeResult = ScrapeOk | ScrapeErr

export interface ScrapeInput {
  url: string
  /** Output shape; defaults to `json`. IG accepts json|caption|summary;
   *  X accepts json|text|summary|article. An out-of-domain mode falls
   *  back to `json`. */
  mode?: string
  /** X only — fetch the full thread (author-filtered). Ignored for IG. */
  thread?: boolean
}

/** A `() => Promise<string | null>` resolving the current Apify token,
 *  or `null` when the user hasn't stored one. Called on every scrape. */
export type TokenProvider = () => Promise<string | null>

export interface ScrapingBackend {
  /** Scrape an Instagram URL. */
  scrapeInstagram(input: ScrapeInput): Promise<ScrapeResult>
  /** Scrape an X/Twitter URL. */
  scrapeX(input: ScrapeInput): Promise<ScrapeResult>
  /** Route a pasted URL to the matching platform (the `/scrape` path). */
  scrapeUrl(input: ScrapeInput): Promise<ScrapeResult>
  /** Whether a token is currently stored (drives capability visibility). */
  isCredentialed(): Promise<boolean>
}

export interface BuildScrapingBackendOptions {
  tokenProvider: TokenProvider
  /** Injectable `fetch` (tests pass a mock; prod omits → global fetch). */
  fetcher?: FetchLike
}

const IG_MODES = new Set<InstagramMode>(['json', 'caption', 'summary'])
const X_MODES = new Set<XMode>(['json', 'text', 'summary', 'article'])

export function buildScrapingBackend(
  opts: BuildScrapingBackendOptions,
): ScrapingBackend {
  const fetcher: FetchLike =
    opts.fetcher ?? ((input, init) => fetch(input, init))

  async function resolveToken(): Promise<string | null> {
    const t = await opts.tokenProvider()
    return t !== null && t.trim().length > 0 ? t.trim() : null
  }

  function noToken(url: string): ScrapeErr {
    return {
      ok: false,
      code: 'no_token',
      message: 'no Apify token configured',
      guidance: NO_TOKEN_GUIDANCE,
      url,
    }
  }

  function fromApifyError(err: unknown, url: string): ScrapeErr {
    if (err instanceof ApifyScrapeError) {
      return { ok: false, code: err.code, message: err.message, url }
    }
    return {
      ok: false,
      code: 'apify_error',
      message: err instanceof Error ? err.message : 'unknown scrape error',
      url,
    }
  }

  async function runInstagram(input: ScrapeInput): Promise<ScrapeResult> {
    const token = await resolveToken()
    if (token === null) return noToken(input.url)
    const mode: InstagramMode = IG_MODES.has(input.mode as InstagramMode)
      ? (input.mode as InstagramMode)
      : 'json'
    try {
      const out = await scrapeInstagram({ url: input.url, mode, token, fetcher })
      return {
        ok: true,
        platform: 'instagram',
        mode,
        url: input.url,
        text: out.text,
        data: out.data,
      }
    } catch (err) {
      return fromApifyError(err, input.url)
    }
  }

  async function runX(
    input: ScrapeInput,
    target: ScrapeTarget & { platform: 'x' },
  ): Promise<ScrapeResult> {
    const token = await resolveToken()
    if (token === null) return noToken(input.url)
    const mode: XMode = X_MODES.has(input.mode as XMode)
      ? (input.mode as XMode)
      : 'json'
    try {
      const out = await scrapeX({
        target,
        mode,
        thread: input.thread === true,
        token,
        fetcher,
      })
      return {
        ok: true,
        platform: 'x',
        mode,
        url: input.url,
        text: out.text,
        data: out.data,
      }
    } catch (err) {
      return fromApifyError(err, input.url)
    }
  }

  return {
    async isCredentialed() {
      return (await resolveToken()) !== null
    },

    async scrapeInstagram(input) {
      const target = classifyScrapeUrl(input.url)
      if (target === null || target.platform !== 'instagram') {
        return {
          ok: false,
          code: 'invalid_url',
          message: `not an Instagram URL: ${input.url}`,
          url: input.url,
        }
      }
      return runInstagram(input)
    },

    async scrapeX(input) {
      const target = classifyScrapeUrl(input.url)
      if (target === null || target.platform !== 'x') {
        return {
          ok: false,
          code: 'invalid_url',
          message: `not an X/Twitter URL: ${input.url}`,
          url: input.url,
        }
      }
      return runX(input, target)
    },

    async scrapeUrl(input) {
      const target = classifyScrapeUrl(input.url)
      if (target === null) {
        return {
          ok: false,
          code: 'invalid_url',
          message: `not a supported URL (need instagram.com or x.com/twitter.com): ${input.url}`,
          url: input.url,
        }
      }
      return target.platform === 'instagram'
        ? runInstagram(input)
        : runX(input, target)
    },
  }
}
