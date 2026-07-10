/**
 * @neutronai/reminders-core — manifest loader + locked constants.
 *
 * Thin layer on top of the Sprint 24 `parseManifest`. Reads
 * `package.json` from a path (default: this Core's own package.json),
 * extracts the `"neutron"` block, and returns the parsed
 * `NeutronManifest`. Throws Zod validation errors on invalid input —
 * the Core's boot path catches and surfaces them as `CoreInstallError`
 * via the runtime loader.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadManifestFromPackageJson } from '@neutronai/cores-runtime'
import { type NeutronManifest } from '@neutronai/cores-sdk'

/**
 * Slug derived from the package name. Mirrors Sprint 31
 * `packageNameToSlug('@neutronai/reminders-core')` so the runtime's
 * sidecar allocation lands at `<dataDir>/cores/reminders_core.db`.
 *
 * The trailing `_core` suffix is forced by the engine workspace
 * already owning `@neutronai/reminders`; see AGENTS.md "Why this
 * package is @neutronai/reminders-core".
 */
export const CORE_SLUG = 'reminders_core' as const

/**
 * Stable package name. Used by the runtime's loader to key the
 * `core_installations` row + by the SDK's accessors as `core_id`.
 */
export const CORE_PACKAGE_NAME = '@neutronai/reminders-core' as const

/**
 * The MCP tool names declared in the manifest. Exposed as a `const`
 * tuple so capability-guard wiring + tests can iterate without
 * re-reading the manifest body. S1 added `reminders_update` (6th)
 * alongside the legacy 5; both writes through the same
 * `write:reminders_core.db` capability.
 */
export const TOOL_NAMES = [
  'reminders_create',
  'reminders_list',
  'reminders_snooze',
  'reminders_cancel',
  'reminders_convert_to_task',
  'reminders_update',
] as const
export type RemindersToolName = typeof TOOL_NAMES[number]

/**
 * Capability strings the manifest declares. Same shape lock as
 * the sibling free-Core manifest — re-exposed so tools.ts can
 * pass the exact-match strings to `CapabilityGuard.wrapToolHandler`.
 *
 * Resource name `reminders_core.db` matches the Core's slug
 * (`reminders_core`) — the runtime's `decideDataLayout` checks for
 * exact `read:<slug>.db` / `write:<slug>.db` strings to choose
 * `sidecar` over `tables` layout. The sidecar is allocated at
 * `<dataDir>/cores/reminders_core.db` but kept unused in v1; the
 * Core routes through the engine's shared `reminders` table
 * so the existing tick loop keeps firing rows the Core creates.
 */
export const READ_CAPABILITY = 'read:reminders_core.db' as const
export const WRITE_CAPABILITY = 'write:reminders_core.db' as const

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
  return loadManifestFromPackageJson(
    options.package_json_path ?? defaultPackageJsonPath(),
  )
}
