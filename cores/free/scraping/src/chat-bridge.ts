/**
 * @neutronai/scraping-core — chat-bridge wiring.
 *
 * Adapts the pure `parseScrapeCommand` + `executeScrapeCommand` into the
 * gateway's `ChatCommandFilter` contract (the same shape Research /
 * Calendar Cores use — see `gateway/boot-helpers.ts`
 * `buildChainedChatCommandFilter`). Returns `null` for any inbound that
 * doesn't start with `/scrape` so the chain falls through to the LLM
 * dispatch path.
 *
 * The filter shares the SAME `ScrapingBackend` instance the MCP tools
 * use, so `/scrape` and `scrape_instagram`/`scrape_x` read the one
 * token-resolution path (agent-native parity).
 */

import {
  executeScrapeCommand,
  parseScrapeCommand,
  type ScrapeCommandResponse,
} from './chat-commands.ts'
import type { ScrapingBackend } from './backend.ts'

export interface ScrapingChatCommandFilterInput {
  user_id: string
  project_slug: string
  channel_topic_id: string
  project_id?: string
  body: string
}

export interface ScrapingChatCommandFilterResult {
  text: string
  data?: unknown
  error?: { code: string; message: string }
}

export interface ScrapingChatCommandFilter {
  match(
    input: ScrapingChatCommandFilterInput,
  ): Promise<ScrapingChatCommandFilterResult | null>
}

export interface CreateScrapingChatCommandFilterOptions {
  backend: ScrapingBackend
}

export function createScrapingChatCommandFilter(
  opts: CreateScrapingChatCommandFilterOptions,
): ScrapingChatCommandFilter {
  return {
    async match(input) {
      const trimmed = input.body.trimStart()
      if (!trimmed.toLowerCase().startsWith('/scrape')) return null
      const cmd = parseScrapeCommand(trimmed)
      const response: ScrapeCommandResponse = await executeScrapeCommand(cmd, {
        backend: opts.backend,
      })
      const out: ScrapingChatCommandFilterResult = { text: response.text }
      if (response.data !== undefined) out.data = response.data
      if (response.error !== undefined) out.error = response.error
      return out
    },
  }
}
