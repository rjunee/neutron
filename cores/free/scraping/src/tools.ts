/**
 * @neutronai/scraping-core — capability-guarded MCP tool wiring.
 *
 * Two tools the manifest declares (`scrape_instagram` / `scrape_x`),
 * each wrapped by `CapabilityGuard.wrapToolHandler` so every dispatch
 * records an audit row + enforces the manifest's
 * tool↔capability declaration (`network:browse`). Mirrors
 * `cores/free/research/src/tools.ts`.
 *
 * The runtime composer (`registerCoreTools` in
 * `gateway/cores/install-bundled.ts`) calls `buildTools(deps)` at
 * install time with the per-Core `backend` resolved by the backend
 * factory; tests call it directly with a stub backend.
 */

import {
  CapabilityGuard,
  type SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import { BROWSE_CAPABILITY, CORE_SLUG } from './manifest.ts'
import type { ScrapeInput, ScrapeResult, ScrapingBackend } from './backend.ts'

export type { ScrapeInput, ScrapeResult, ScrapingBackend } from './backend.ts'

/**
 * Dependency bundle the runtime composer assembles at install time.
 * Same triple every Core carries (`manifest` / `project_slug` /
 * `audit`) plus the per-Core `backend`.
 */
export interface ToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  backend: ScrapingBackend
}

export interface BuiltTools {
  scrape_instagram: (input: ScrapeInput) => Promise<ScrapeResult>
  scrape_x: (input: ScrapeInput) => Promise<ScrapeResult>
}

export function buildTools(deps: ToolDeps): BuiltTools {
  const guard = new CapabilityGuard({
    manifest: deps.manifest,
    core_slug: CORE_SLUG,
    owner_slug: deps.project_slug,
    audit: deps.audit,
  })

  const scrape_instagram = guard.wrapToolHandler<ScrapeInput, ScrapeResult>({
    tool_name: 'scrape_instagram',
    capability_required: BROWSE_CAPABILITY,
    fn: (input) => deps.backend.scrapeInstagram(input),
  })

  const scrape_x = guard.wrapToolHandler<ScrapeInput, ScrapeResult>({
    tool_name: 'scrape_x',
    capability_required: BROWSE_CAPABILITY,
    fn: (input) => deps.backend.scrapeX(input),
  })

  return { scrape_instagram, scrape_x }
}
