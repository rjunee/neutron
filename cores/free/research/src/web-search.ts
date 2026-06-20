/**
 * @neutronai/research-core — web-search wrapper.
 *
 * Per docs/plans/research-core-tier1-brief.md § 5.
 *
 * v1 wraps Tavily (https://tavily.com — paid API; key in the owner's
 * `secrets` table via SecretsStore). Pluggable interface
 * `WebSearchProvider` so Brave / Serper / SerpAPI can land in S2.
 *
 * Honors the `network:browse` capability — the wrapper refuses calls
 * when the manifest doesn't declare it. The actual outbound request
 * goes through whatever fetcher the caller passes (the wrapper does
 * NOT enforce the allow-list itself for the SEARCH API surface; the
 * domain allow-list lives in `web-fetch.ts` for fetched URL bodies).
 *
 * The wrapper gracefully degrades when no API key is configured —
 * `search()` returns an empty array + emits a `no_api_key` outcome so
 * the sub-agent can switch to vault-search-only mode.
 */

import type { NeutronManifest } from '@neutronai/cores-sdk'

import { BROWSE_CAPABILITY } from './manifest.ts'

export interface WebSearchHit {
  title: string
  url: string
  snippet: string
  /** Provider-specific score; not normalised across providers. */
  score?: number
}

export interface WebSearchInput {
  query: string
  /** Max hits to return. Default 5; cap 20. */
  max_results?: number
}

export interface WebSearchProvider {
  readonly id: string
  search(input: WebSearchInput): Promise<WebSearchHit[]>
  /** Whether the provider has an API key / can serve live requests. */
  isAvailable(): boolean
}

export class WebSearchCapabilityDeniedError extends Error {
  readonly code = 'capability_denied' as const
  constructor() {
    super(
      `web-search requires capability '${BROWSE_CAPABILITY}' to be declared in the Core's manifest`,
    )
    this.name = 'WebSearchCapabilityDeniedError'
  }
}

export class WebSearchAuthMissingError extends Error {
  readonly code = 'auth_missing' as const
  constructor(provider_id: string) {
    super(`web-search provider '${provider_id}' has no API key configured`)
    this.name = 'WebSearchAuthMissingError'
  }
}

export class WebSearchRateLimitedError extends Error {
  readonly code = 'rate_limited' as const
  readonly provider_id: string
  constructor(provider_id: string) {
    super(`web-search provider '${provider_id}' is rate-limited`)
    this.name = 'WebSearchRateLimitedError'
    this.provider_id = provider_id
  }
}

export interface TavilyProviderOptions {
  api_key: string | null
  /** Override `fetch` for tests. */
  fetcher?: typeof fetch
}

/**
 * Tavily search provider. v1 implementation.
 *
 * API docs: https://docs.tavily.com/docs/rest-api/api-reference
 *
 * Returns an empty array (with `isAvailable()=false`) when `api_key`
 * is `null` — the sub-agent falls back to vault-search-only mode.
 */
export function buildTavilyProvider(opts: TavilyProviderOptions): WebSearchProvider {
  const fetcher = opts.fetcher ?? fetch
  const api_key = opts.api_key
  return {
    id: 'tavily',
    isAvailable(): boolean {
      return api_key !== null && api_key.length > 0
    },
    async search(input: WebSearchInput): Promise<WebSearchHit[]> {
      if (api_key === null || api_key.length === 0) {
        throw new WebSearchAuthMissingError('tavily')
      }
      const max_results = Math.min(Math.max(input.max_results ?? 5, 1), 20)
      const res = await fetcher('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key,
          query: input.query,
          max_results,
          search_depth: 'advanced',
          include_answer: false,
        }),
      })
      if (res.status === 429) throw new WebSearchRateLimitedError('tavily')
      if (!res.ok) {
        throw new Error(`tavily search failed: HTTP ${res.status}`)
      }
      const body = (await res.json()) as {
        results?: Array<{
          title?: string
          url?: string
          content?: string
          score?: number
        }>
      }
      const results = body.results ?? []
      return results.map((r) => {
        const hit: WebSearchHit = {
          title: r.title ?? '',
          url: r.url ?? '',
          snippet: r.content ?? '',
        }
        if (typeof r.score === 'number') hit.score = r.score
        return hit
      })
    },
  }
}

export function manifestDeclaresBrowse(manifest: NeutronManifest): boolean {
  return manifest.capabilities.includes(BROWSE_CAPABILITY)
}

/**
 * Capability-guarded search. Verifies the manifest declares
 * `network:browse` before delegating to the provider.
 */
export async function webSearch(
  input: WebSearchInput,
  deps: { manifest: NeutronManifest; provider: WebSearchProvider },
): Promise<WebSearchHit[]> {
  if (!manifestDeclaresBrowse(deps.manifest)) {
    throw new WebSearchCapabilityDeniedError()
  }
  return deps.provider.search(input)
}

/**
 * Build a stub provider for tests. Returns canned hits keyed by query.
 */
export interface CannedWebSearchProviderInput {
  responses: ReadonlyArray<{ query_match: RegExp | string; hits: readonly WebSearchHit[] }>
  available?: boolean
}

export function buildCannedWebSearchProvider(
  opts: CannedWebSearchProviderInput,
): WebSearchProvider {
  return {
    id: 'canned',
    isAvailable(): boolean {
      return opts.available ?? true
    },
    async search(input: WebSearchInput): Promise<WebSearchHit[]> {
      for (const r of opts.responses) {
        const matches =
          r.query_match instanceof RegExp
            ? r.query_match.test(input.query)
            : input.query.includes(r.query_match)
        if (matches) return [...r.hits]
      }
      return []
    },
  }
}
