/**
 * @neutronai/scraping-core — production wiring helper.
 *
 * Single source of truth for assembling the Scraping Core runtime: one
 * `ScrapingBackend` (token resolved per-call via the capability-gated
 * `SecretsAccessor`) shared by BOTH the MCP-tool factory and the
 * `/scrape` chat-command filter, so the two surfaces read the same
 * Apify token + the same `fetch` impl. Mirrors
 * `cores/free/research/src/wiring-production.ts`.
 *
 * The backend factory in `gateway/boot-helpers.ts:buildCoresBackendFactories`
 * builds the backend independently from the per-install `SecretsAccessor`
 * (it has no access to the composer-level wiring), so the MCP path works
 * even when no composer threads this helper. This helper exists so a
 * composer that DOES wire the chat filter gets a backend that shares the
 * exact same token path.
 */

import type { SecretsAccessor } from '@neutronai/cores-sdk'

import {
  buildScrapingBackend,
  type ScrapingBackend,
  type TokenProvider,
} from './backend.ts'
import {
  createScrapingChatCommandFilter,
  type ScrapingChatCommandFilter,
} from './chat-bridge.ts'
import { APIFY_SECRET_KIND, APIFY_SECRET_LABEL } from './manifest.ts'
import type { FetchLike } from './apify-client.ts'

/**
 * Build a `TokenProvider` that reads the Apify token from a Core
 * `SecretsAccessor` on every call. Returns `null` (not throw) when the
 * accessor denies or the secret is absent, so the backend degrades to
 * the no-token no-op rather than erroring hard.
 */
export function tokenProviderFromAccessor(
  accessor: SecretsAccessor,
): TokenProvider {
  return async () => {
    try {
      return await accessor.get(APIFY_SECRET_KIND, APIFY_SECRET_LABEL)
    } catch {
      return null
    }
  }
}

export interface BuildProductionScrapingCoreWiringOptions {
  /** Per-install capability-gated secrets accessor (declares `apify`). */
  secretsAccessor: SecretsAccessor
  /** Injectable fetch (tests); omit → global fetch. */
  fetcher?: FetchLike
}

export interface ProductionScrapingCoreWiring {
  backend: ScrapingBackend
  chat_command_filter: ScrapingChatCommandFilter
}

export function buildProductionScrapingCoreWiring(
  opts: BuildProductionScrapingCoreWiringOptions,
): ProductionScrapingCoreWiring {
  const backendOpts: Parameters<typeof buildScrapingBackend>[0] = {
    tokenProvider: tokenProviderFromAccessor(opts.secretsAccessor),
  }
  if (opts.fetcher !== undefined) backendOpts.fetcher = opts.fetcher
  const backend = buildScrapingBackend(backendOpts)
  const chat_command_filter = createScrapingChatCommandFilter({ backend })
  return { backend, chat_command_filter }
}
