/**
 * @neutronai/code-gen-core — manifest loader + locked constants.
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
 * `packageNameToSlug('@neutronai/codegen-core')` so the runtime's
 * namespace allocator keys all on-disk state under `codegen_core`.
 */
export const CORE_SLUG = 'codegen_core' as const

/** Stable package name. */
export const CORE_PACKAGE_NAME = '@neutronai/codegen-core' as const

/**
 * The four MCP tool names declared in the manifest. S2 narrowed the
 * surface from 8 → 4 tools — the autonomous Forge → Argus → merge loop
 * subsumes the review/merge/judge/history extras (see § Phase 2 of
 * docs/plans/2026-05-22-002-feat-code-gen-core-s2-autonomous-plan.md).
 * Cancel survives because emergency-stop is the one user-driven escape
 * hatch the autonomous loop preserves.
 */
export const TOOL_NAMES = [
  'codegen_dispatch',
  'codegen_status',
  'codegen_fetch',
  'codegen_cancel',
] as const
export type CodegenToolName = (typeof TOOL_NAMES)[number]

/**
 * Capability strings the manifest declares. The `<verb>:<slug>.tasks`
 * pair mirrors Calendar's `.events` shape because the Core's primary
 * state is a task tracker (per-project sidecar `code_tasks` table;
 * see § 6.2 of the brief). Three additional capabilities are declared:
 *
 *   - `agent:dispatch_subagent` (already in core-sdk closed enum;
 *     Code-Gen is the FIRST production caller via `runtime/subagent/`).
 *   - `host:gh` (NEW — gates `gh` CLI invocation by the gateway host).
 *   - `network:github` (NEW — gates github.com REST calls; composed
 *     ON TOP of network:external).
 */
export const READ_CAPABILITY = 'read:codegen_core.tasks' as const
export const WRITE_CAPABILITY = 'write:codegen_core.tasks' as const
export const DISPATCH_SUBAGENT_CAPABILITY = 'agent:dispatch_subagent' as const
export const HOST_GH_CAPABILITY = 'host:gh' as const
export const NETWORK_GITHUB_CAPABILITY = 'network:github' as const

/**
 * The per-project worktree directory slug (sibling to the per-project
 * `code-gen/` sidecar dir). The resolver creates
 * `<OWNER_HOME>/Projects/<project_id>/code/` and runs `git init` +
 * `gh repo create` if the dir is fresh.
 */
export const PROJECT_WORKTREE_DIRNAME = 'code' as const

/**
 * Sidecar directory name (sibling to PROJECT_WORKTREE_DIRNAME). The
 * sidecar SQLite lives at
 * `<OWNER_HOME>/Projects/<project_id>/code-gen/code-gen.db`.
 */
export const PROJECT_SIDECAR_DIRNAME = 'code-gen' as const

/** Sidecar SQLite filename. */
export const PROJECT_SIDECAR_DB_FILENAME = 'code-gen.db' as const

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
