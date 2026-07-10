/**
 * @neutronai/google-workspace-core — manifest loader + locked constants.
 *
 * Mirrors the Tier 1 Calendar / Email-Managed Cores: a thin wrapper on
 * top of the Sprint 24 `parseManifest`. Reads `package.json` from a
 * path (default: this Core's own `package.json`), extracts the
 * `"neutron"` block, and returns the parsed `NeutronManifest`. The
 * runtime loader catches Zod validation errors and surfaces them as
 * `CoreInstallError`.
 *
 * Per the gap-audit external-tool floor (P0-6 / §(b) cat 9,
 * `docs/research/vajra-neutron-daily-driver-gap-audit-2026-06-20.md`):
 * Drive/Sheets/Docs read+write as a single Tier 1 free Core, reusing
 * the same per-Core Google OAuth plumbing the Calendar + Email Cores
 * already depend on (NOT a global registry). The Core's three Google
 * APIs (Drive v3 / Sheets v4 / Docs v1) share ONE OAuth grant under
 * the stable storage label `google_workspace`.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadManifestFromPackageJson } from '@neutronai/cores-runtime'
import { type NeutronManifest } from '@neutronai/cores-sdk'

/**
 * Slug derived from the package name. Mirrors Sprint 31
 * `packageNameToSlug('@neutronai/google-workspace-core')` so the
 * runtime's namespace allocator keys all on-disk state under
 * `google_workspace_core`.
 */
export const CORE_SLUG = 'google_workspace_core' as const

/** Stable package name. */
export const CORE_PACKAGE_NAME = '@neutronai/google-workspace-core' as const

/**
 * Manifest secret label — the storage key the runtime store +
 * capability gate use to address the user's Google OAuth
 * refresh/access token row. ONE grant covers all three APIs:
 *
 *   - `drive`        — Drive file read + create (list/read/upload)
 *   - `spreadsheets` — Sheets read/append/update
 *   - `documents`    — Docs read/create/update
 *
 * The label is DISTINCT from the Calendar Core's `google_calendar` +
 * the Email Core's `gmail_compose` so audit attribution stays clean
 * and each Core's grant can be connected / disconnected independently
 * (per-Core OAuth, NOT a shared global token).
 */
export const OAUTH_SECRET_LABEL = 'google_workspace' as const

/**
 * MCP tool names declared in the manifest. Exposed as a `const` tuple
 * so capability-guard wiring + tests iterate without re-reading the
 * manifest body. Nine tools across three Google services.
 */
export const TOOL_NAMES = [
  'drive_list',
  'drive_read',
  'drive_upload',
  'sheets_read',
  'sheets_append',
  'sheets_update',
  'docs_read',
  'docs_create',
  'docs_update',
] as const
export type GoogleWorkspaceToolName = typeof TOOL_NAMES[number]

/**
 * Capability strings the manifest declares — per-service read/write
 * pairs. Each tool's `capability_required` is gated against this set
 * by the runtime `CapabilityGuard`.
 */
export const DRIVE_READ_CAPABILITY = 'read:google_workspace_core.drive' as const
export const DRIVE_WRITE_CAPABILITY = 'write:google_workspace_core.drive' as const
export const SHEETS_READ_CAPABILITY = 'read:google_workspace_core.sheets' as const
export const SHEETS_WRITE_CAPABILITY = 'write:google_workspace_core.sheets' as const
export const DOCS_READ_CAPABILITY = 'read:google_workspace_core.docs' as const
export const DOCS_WRITE_CAPABILITY = 'write:google_workspace_core.docs' as const

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
