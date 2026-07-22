/**
 * @neutronai/research-core — manifest loader + locked constants.
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
 * `packageNameToSlug('@neutronai/research-core')` so the runtime's
 * sidecar allocation lands at `<dataDir>/cores/research_core.db`.
 *
 * The trailing `_core` suffix matches the convention every Tier 1
 * free Core follows even when there is no current engine workspace
 * holding the unsuffixed name. Keeping the suffix consistent across
 * Tasks / Reminders / Calendar / Research means audit-log rows and
 * sidecar paths land in a predictable shape.
 */
export const CORE_SLUG = 'research_core' as const

/**
 * Stable package name. Used by the runtime's loader to key the
 * `core_installations` row + by the SDK's accessors as `core_id`.
 */
export const CORE_PACKAGE_NAME = '@neutronai/research-core' as const

/**
 * The eight MCP tool names declared in the manifest (3 legacy + 5 new
 * in S1). Exposed as a `const` tuple so capability-guard wiring + tests
 * can iterate without re-reading the manifest body.
 */
export const TOOL_NAMES = [
  'research_start',
  'research_status',
  'research_fetch',
  // S1 — new MCP tools per docs/plans/research-core-tier1-brief.md § 3.6.
  'research_deep',
  'research_list',
  'research_find',
  'research_cite',
  'research_claims_list',
] as const
export type ResearchToolName = typeof TOOL_NAMES[number]

/**
 * Capability strings the manifest declares. The pair gates a sidecar
 * SQLite at `<dataDir>/cores/research_core.db` via Sprint 31
 * `decideDataLayout` — `read:<slug>.db` / `write:<slug>.db` is the
 * locked indirection between the manifest and the on-disk namespace.
 */
export const READ_CAPABILITY = 'read:research_core.db' as const
export const WRITE_CAPABILITY = 'write:research_core.db' as const

/** S1 — web-browsing capability (added to SDK closed enum + manifest
 *  schema in the same sprint; see § 5 of the brief). The Research Core
 *  is the first user. Implies `network:external`; additionally promises
 *  the Core enforces a per-Core domain allow-list — see
 *  `src/web-fetch-allowlist.ts`. */
export const BROWSE_CAPABILITY = 'network:browse' as const

/** S1 — sub-agent dispatch capability (already in the cores-sdk closed enum).
 *  Declared so `/research deep` can spawn the in-process research
 *  sub-agent harness via the runtime sub-agent dispatcher. */
export const SUBAGENT_CAPABILITY = 'agent:dispatch_subagent' as const

/** Mirrors Calendar Core's per-tool meta key — same `'neutron_project_id'`
 *  shape so cross-Core consumers (launcher, app router) can read the
 *  same extended-property without per-Core branching. */
export const PROJECT_ID_EXTENDED_PROPERTY = 'neutron_project_id' as const

/** Default wall-clock budget for a single `/research deep` sub-agent
 *  run. 5 minutes — matches Atlas-side spawn-agent.sh budgets. */
export const SUB_AGENT_DEFAULT_BUDGET_MS = 5 * 60 * 1000

/** Default per-instance concurrency cap for sub-agent runs. Two in-flight
 *  research tasks per instance — the owner's Nova cadence today on the
 *  three-tridents-in-flight rule. */
export const SUB_AGENT_DEFAULT_CONCURRENCY_CAP = 2

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
