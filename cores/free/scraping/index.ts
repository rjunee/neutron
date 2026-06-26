/**
 * @neutronai/scraping-core — public barrel.
 *
 * Tier 1 free Scraping Core. Ports Vajra's `ig-scrape.sh` + `tx-scrape.sh`
 * (Apify Instagram + X/Twitter scraping) to an in-process Core.
 *
 * Surfaces:
 *  - 2 MCP tools (`scrape_instagram`, `scrape_x`)
 *  - chat-command parser + dispatcher (`/scrape <url> [mode] [--thread]`)
 *  - an `apify` `byo_api_key` admin slot (declared in the manifest →
 *    auto-surfaced by the registry-driven Integrations admin surface +
 *    agent-native `integrations_*` tools)
 *
 * Optional-until-credentialed: with no Apify token the capability
 * no-ops with guidance and NEVER calls Apify.
 *
 * Mirrors `cores/free/research/index.ts`.
 */

export const __MODULE__ = '@neutronai/scraping-core' as const

export {
  APIFY_SECRET_KIND,
  APIFY_SECRET_LABEL,
  BROWSE_CAPABILITY,
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  TOOL_NAMES,
  loadManifest,
  type ScrapingToolName,
} from './src/manifest.ts'

export {
  classifyScrapeUrl,
  isInstagramUrl,
  isXUrl,
  type InstagramTarget,
  type ScrapePlatform,
  type ScrapeTarget,
  type XTarget,
} from './src/url-detect.ts'

export {
  ApifyScrapeError,
  INSTAGRAM_ACTOR,
  X_ARTICLE_ACTOR,
  X_TWEET_ACTOR,
  scrapeInstagram,
  scrapeX,
  type ApifyErrorCode,
  type FetchLike,
  type InstagramMode,
  type ScrapeOutput,
  type XMode,
} from './src/apify-client.ts'

export {
  NO_TOKEN_GUIDANCE,
  buildScrapingBackend,
  type BuildScrapingBackendOptions,
  type ScrapeErr,
  type ScrapeInput,
  type ScrapeOk,
  type ScrapeResult,
  type ScrapeResultCode,
  type ScrapingBackend,
  type TokenProvider,
} from './src/backend.ts'

export {
  buildTools,
  type BuiltTools,
  type ToolDeps,
} from './src/tools.ts'

export {
  executeScrapeCommand,
  parseScrapeCommand,
  type ScrapeCommand,
  type ScrapeCommandContext,
  type ScrapeCommandResponse,
} from './src/chat-commands.ts'

export {
  createScrapingChatCommandFilter,
  type CreateScrapingChatCommandFilterOptions,
  type ScrapingChatCommandFilter,
  type ScrapingChatCommandFilterInput,
  type ScrapingChatCommandFilterResult,
} from './src/chat-bridge.ts'

export {
  buildProductionScrapingCoreWiring,
  tokenProviderFromAccessor,
  type BuildProductionScrapingCoreWiringOptions,
  type ProductionScrapingCoreWiring,
} from './src/wiring-production.ts'
