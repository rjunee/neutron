/**
 * @neutronai/scraping-core — manifest loader + locked constants.
 *
 * Thin layer on top of the SDK `parseManifest` (mirrors
 * `cores/free/research/src/manifest.ts`). Reads `package.json` from a
 * path (default: this Core's own package.json), extracts the `"neutron"`
 * block, and returns the parsed `NeutronManifest`. Throws Zod validation
 * errors on invalid input — the Core's boot path catches and surfaces
 * them as `CoreInstallError` via the runtime loader.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseManifest, type NeutronManifest } from '@neutronai/cores-sdk'

/**
 * Slug derived from the package name. Mirrors
 * `packageNameToSlug('@neutronai/scraping-core')` (cores/runtime/loader.ts)
 * so the runtime keys the install row + backend-factory map at
 * `scraping_core`. The trailing `_core` suffix matches the convention
 * every Tier 1 free Core follows.
 */
export const CORE_SLUG = 'scraping_core' as const

/**
 * Stable package name. Used by the runtime's loader to key the
 * `core_installations` row + by the SDK's accessors as `core_id`.
 */
export const CORE_PACKAGE_NAME = '@neutronai/scraping-core' as const

/** The two MCP tool names declared in the manifest. Exposed as a `const`
 *  tuple so capability-guard wiring + tests iterate without re-reading
 *  the manifest body. */
export const TOOL_NAMES = ['scrape_instagram', 'scrape_x'] as const
export type ScrapingToolName = (typeof TOOL_NAMES)[number]

/** Outbound-network capability the scrape tools require. Apify is an
 *  external HTTP call, so both tools declare `network:browse` (the same
 *  capability Research Core's web-fetch uses). */
export const BROWSE_CAPABILITY = 'network:browse' as const

/**
 * The single `byo_api_key` secret the Core declares. The user pastes
 * their Apify token under this label in the admin Integrations surface;
 * the Core reads it via the capability-gated `SecretsAccessor`
 * (`accessor.get('byo_api_key', 'apify')`). Absent ⇒ the capability
 * no-ops with guidance (optional-until-credentialed).
 */
export const APIFY_SECRET_KIND = 'byo_api_key' as const
export const APIFY_SECRET_LABEL = 'apify' as const

function defaultPackageJsonPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'package.json')
}

/**
 * Load + parse the Core's manifest. Defaults to this package's own
 * `package.json`; tests can override via `package_json_path`.
 */
export function loadManifest(
  options: { package_json_path?: string } = {},
): NeutronManifest {
  const path = options.package_json_path ?? defaultPackageJsonPath()
  const raw = readFileSync(path, 'utf8')
  const pkg: unknown = JSON.parse(raw)
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new Error(`package.json at ${path} is not an object`)
  }
  const block = (pkg as Record<string, unknown>)['neutron']
  if (block === undefined) {
    throw new Error(`package.json at ${path} has no "neutron" section`)
  }
  return parseManifest(block)
}
