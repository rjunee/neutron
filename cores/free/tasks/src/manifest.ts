/**
 * @neutronai/tasks-core — manifest loader + locked constants.
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
 * `packageNameToSlug('@neutronai/tasks-core')` so the runtime's sidecar
 * allocation lands at `<dataDir>/cores/tasks_core.db`.
 *
 * Why `tasks_core` and not `tasks`: the bare `@neutronai/tasks` package
 * already names the empty P0 substrate placeholder (`tasks/`) that
 * P6's canonical task DB will flesh out. The Tier 1 Core's package
 * name takes the `-core` suffix to avoid the npm name collision; the
 * derived slug carries the suffix through, keeping audit-log rows
 * unambiguous even once P6 lands and the substrate gains a real API.
 */
export const CORE_SLUG = 'tasks_core' as const

/**
 * Stable package name. Used by the runtime's loader to key the
 * `core_installations` row + by the SDK's accessors as `core_id`.
 */
export const CORE_PACKAGE_NAME = '@neutronai/tasks-core' as const

/**
 * The six MCP tool names declared in the manifest. Exposed as a
 * `const` tuple so capability-guard wiring + tests can iterate without
 * re-reading the manifest body.
 *
 * v0.2.0 added `tasks_pick_next` — the LLM-driven pick-next surface.
 */
export const TOOL_NAMES = [
  'tasks_create',
  'tasks_list',
  'tasks_update',
  'tasks_complete',
  'tasks_delete',
  'tasks_pick_next',
] as const
export type TasksToolName = typeof TOOL_NAMES[number]

/**
 * Capability strings the manifest declares. The pair gates a sidecar
 * SQLite at `<dataDir>/cores/tasks_core.db` via Sprint 31
 * `decideDataLayout` — `read:<slug>.db` / `write:<slug>.db` is the
 * locked indirection between the manifest and the on-disk namespace.
 */
export const READ_CAPABILITY = 'read:tasks_core.db' as const
export const WRITE_CAPABILITY = 'write:tasks_core.db' as const

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
