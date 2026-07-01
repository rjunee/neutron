/**
 * @neutronai/agent-settings — manifest loader + locked constants.
 *
 * Mirrors `cores/free/notes/src/manifest.ts`: reads `package.json` from
 * a path (default: this Core's own package.json), extracts the
 * `"neutron"` block, and returns the parsed `NeutronManifest` via the
 * Sprint 24 `parseManifest`. Throws Zod validation errors on invalid
 * input — the Core's boot path catches and surfaces them as
 * `CoreInstallError` via the runtime loader.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseManifest, type NeutronManifest } from '@neutronai/cores-sdk'

/**
 * Slug derived from the package name. Mirrors `packageNameToSlug` on
 * this package so the runtime's loader keys the
 * `core_installations` row + the install-bundled backend factory map
 * at `agent_settings`.
 */
export const CORE_SLUG = 'agent_settings' as const

/** Stable package name — keys the `core_installations` row. */
export const CORE_PACKAGE_NAME = '@neutronai/agent-settings' as const

/**
 * The eleven tool names declared in the manifest. Exposed as a `const`
 * tuple so capability-guard wiring, the system-prompt fragment, and
 * tests can iterate without re-reading the manifest body.
 */
export const TOOL_NAMES = [
  'list_projects',
  'rename_project',
  'delete_project',
  'archive_project',
  'restore_project',
  'merge_projects',
  'update_personality',
  'update_agent_name',
  'connect_telegram',
  'get_engagement_mode',
  'set_engagement_mode',
] as const
export type AgentSettingsToolName = (typeof TOOL_NAMES)[number]

/**
 * Capability strings the manifest declares. Same `<verb>:<resource>`
 * shape the SDK's `CapabilitySchema` enforces — passed verbatim to
 * `CapabilityGuard.wrapToolHandler` so a wrap with a different value
 * trips the guard's `capability_mismatch` check at the first call.
 */
export const READ_CAPABILITY = 'read:agent_settings' as const
export const WRITE_CAPABILITY = 'write:agent_settings' as const
export const TELEGRAM_CAPABILITY = 'write:telegram_topics' as const

function defaultPackageJsonPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'package.json')
}

/**
 * Load + parse the Core's manifest. Defaults to this package's own
 * `package.json`; tests can override via `package_json_path`.
 */
export function loadManifest(
  options: {
    package_json_path?: string
  } = {},
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
