/**
 * @neutronai/calendar-core — manifest loader + locked constants.
 *
 * Mirrors the Tier 1 Notes / Tasks Cores: thin wrapper on top of the
 * Sprint 24 `parseManifest`. Reads `package.json` from a path (default:
 * this Core's own `package.json`), extracts the `"neutron"` block, and
 * returns the parsed `NeutronManifest`. The runtime loader catches Zod
 * validation errors and surfaces them as `CoreInstallError`.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadManifestFromPackageJson } from '@neutronai/cores-runtime'
import { type NeutronManifest } from '@neutronai/cores-sdk'

/**
 * Slug derived from the package name. Mirrors Sprint 31
 * `packageNameToSlug('@neutronai/calendar-core')` so the runtime's
 * namespace allocator keys all on-disk state under `calendar_core`.
 *
 * Why `calendar_core` and not `calendar`: same shape as `tasks_core` —
 * the bare slug `calendar` is reserved for the substrate workspace
 * package that would own the canonical calendar mirror DB if/when one
 * lands. The Tier 1 Core owns its capability namespace
 * (`read:/write:calendar_core.events`) which the runtime maps to a
 * sidecar; the substrate-side calendar package can later coexist.
 */
export const CORE_SLUG = 'calendar_core' as const

/** Stable package name. */
export const CORE_PACKAGE_NAME = '@neutronai/calendar-core' as const

/** Manifest secret name + label — the `(kind, label)` pair the runtime
 *  store + capability gate use to address the user's Google OAuth
 *  refresh/access token row. */
export const OAUTH_SECRET_LABEL = 'google_calendar' as const

/**
 * Google `extendedProperties.private.<key>` name the Core uses to tag
 * events with the Neutron project they were created in. Shared by the
 * Google REST wrapper (filter on list, stamp on create), the in-memory
 * client (mirrors the prod path), the chat-command layer, and the
 * per-project SQLite sidecar. Locked here so a stray edit to one
 * surface that drifts from the constant shows up as a tool-mismatch at
 * the first dispatch instead of a silent per-project filter failure.
 */
export const PROJECT_ID_EXTENDED_PROPERTY = 'neutron_project_id' as const

/**
 * Nine MCP tool names declared in the manifest. Exposed as a `const`
 * tuple so capability-guard wiring + tests iterate without re-reading
 * the manifest body. The first five are the v0.1.0 surface; the last
 * four (freebusy / find_time / invite / send_pre_meeting_brief) land
 * with v0.2.0 — the Tier 1 production buildout.
 */
export const TOOL_NAMES = [
  'calendar_list',
  'calendar_create',
  'calendar_update',
  'calendar_cancel',
  'calendar_brief',
  'calendar_freebusy',
  'calendar_find_time',
  'calendar_invite',
  'calendar_send_pre_meeting_brief',
] as const
export type CalendarToolName = typeof TOOL_NAMES[number]

/**
 * Capability strings the manifest declares. The pair gates the Core's
 * Google Calendar surface. We pick the `<verb>:<slug>.events` form
 * because the Core's state is the (cached) event list rather than a
 * SQLite sidecar — the runtime accepts the broader `<verb>:<resource>`
 * shape per `cores/sdk/manifest.ts:CapabilitySchema`. Using a non-`.db`
 * resource also signals to the namespace allocator that no sidecar is
 * required; Calendar Core delegates persistence to Google.
 */
export const READ_CAPABILITY = 'read:calendar_core.events' as const
export const WRITE_CAPABILITY = 'write:calendar_core.events' as const

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
