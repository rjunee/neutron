/**
 * @neutronai/notes — manifest loader + locked constants.
 *
 * Thin layer on top of the Sprint 24 `parseManifest`. Reads
 * `package.json` from a path (default: this Core's own package.json),
 * extracts the `"neutron"` block, and returns the parsed
 * `NeutronManifest`. Throws Zod validation errors on invalid input —
 * the Core's boot path catches and surfaces them as `CoreInstallError`
 * via the runtime loader.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseManifest, type NeutronManifest } from '@neutronai/cores-sdk'

/**
 * Slug derived from the package name. Mirrors Sprint 31
 * `packageNameToSlug('@neutronai/notes')` so the runtime's sidecar
 * allocation lands at `<dataDir>/cores/notes.db`.
 */
export const CORE_SLUG = 'notes' as const

/**
 * Stable package name. Used by the runtime's loader to key the
 * `core_installations` row + by the SDK's accessors as `core_id`.
 */
export const CORE_PACKAGE_NAME = '@neutronai/notes' as const

/**
 * The eight MCP tool names declared in the v0.2.0 manifest. The first
 * four are legacy (write/recall/list/link, kept for back-compat); the
 * second four (Notes Core S1) expose drawer + search + KG-traverse +
 * drawer-listing surfaces. Exposed as a `const` tuple so capability-
 * guard wiring + tests can iterate without re-reading the manifest
 * body.
 */
export const TOOL_NAMES = [
  'notes_write',
  'notes_recall',
  'notes_list',
  'notes_link',
  'notes_create_drawer',
  'notes_drawer_list',
  'notes_search',
  'notes_traverse',
] as const
export type NotesToolName = typeof TOOL_NAMES[number]

/**
 * Capability strings the manifest declares. Same shape lock as
 * `cores/dtc-analytics/src/manifest.ts` — re-exposed so tools.ts can
 * pass the exact-match strings to `CapabilityGuard.wrapToolHandler`.
 *
 * Notes Core S1 (2026-05-20) adds two FTS-specific capabilities so the
 * audit log distinguishes a generic `read:notes.db` row read from a
 * `notes_fts` MATCH query. Sprint 31's `CapabilityGuard` accepts the
 * `<verb>:<resource>` regex shape so no SDK surgery is needed.
 */
export const READ_CAPABILITY = 'read:notes.db' as const
export const WRITE_CAPABILITY = 'write:notes.db' as const
export const FTS_READ_CAPABILITY = 'read:notes.fts' as const
export const FTS_WRITE_CAPABILITY = 'write:notes.fts' as const

function defaultPackageJsonPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'package.json')
}

/**
 * Load + parse the Core's manifest. Defaults to this package's own
 * `package.json`; tests can override via `package_json_path`.
 */
export function loadManifest(options: {
  package_json_path?: string
} = {}): NeutronManifest {
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
