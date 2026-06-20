/**
 * @neutronai/research-core — capability-guarded MCP tool wiring.
 *
 * Three tools the manifest declares (research_start / research_status /
 * research_fetch). Each is wrapped by the Sprint 31
 * `CapabilityGuard.wrapToolHandler` so every dispatch:
 *   - records `op='tool_call' outcome='ok'` on success
 *   - records `op='tool_call' outcome='capability_denied'` + throws
 *     `CapabilityDeniedError` when the manifest's tool/capability
 *     declarations don't match
 *   - records `op='tool_call' outcome='error'` if the inner handler
 *     throws (e.g. `ResearchTaskNotFoundError`) and re-throws the
 *     original error
 *
 * The runtime composer (P3+) registers `buildTools(deps)` output with
 * the MCP host at install time; for tests, the helpers are directly
 * callable. Capability strings are imported from `manifest.ts` so a
 * stray edit to the manifest body that drifts from the locked
 * read:/write:research_core.db pair surfaces as a tool-mismatch the
 * guard rejects at the first dispatch.
 */

import {
  CapabilityGuard,
  type SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import {
  CORE_SLUG,
  READ_CAPABILITY,
  WRITE_CAPABILITY,
} from './manifest.ts'
import type {
  ResearchBackend,
  ResearchFetchInput,
  ResearchFetchResult,
  ResearchStartInput,
  ResearchStartResult,
  ResearchStatusInput,
  ResearchStatusResult,
} from './backend.ts'

export type {
  ResearchBrief,
  ResearchFetchInput,
  ResearchFetchResult,
  ResearchSource,
  ResearchStartInput,
  ResearchStartResult,
  ResearchStatusInput,
  ResearchStatusResult,
  ConfidenceLevel,
  ResearchDepth,
  ResearchStatus,
} from './backend.ts'

/**
 * Bundle of dependencies the tools dispatch against. The runtime
 * composer (P3+) constructs this at install time and passes it into
 * `buildTools` — tests pass mocks directly.
 */
export interface ToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  backend: ResearchBackend
}

export interface BuiltTools {
  research_start: (input: ResearchStartInput) => Promise<ResearchStartResult>
  research_status: (input: ResearchStatusInput) => Promise<ResearchStatusResult>
  research_fetch: (input: ResearchFetchInput) => Promise<ResearchFetchResult>
}

/**
 * Construct the three tool handlers, each wrapped by the Sprint 31
 * `CapabilityGuard.wrapToolHandler` so every dispatch is audited.
 *
 * Capability split:
 *   - `research_start`  → `write:research_core.db` (writes a task row)
 *   - `research_status` → `read:research_core.db` (read-only lookup)
 *   - `research_fetch`  → `read:research_core.db` (read-only lookup)
 */
export function buildTools(deps: ToolDeps): BuiltTools {
  const guard = new CapabilityGuard({
    manifest: deps.manifest,
    core_slug: CORE_SLUG,
    project_slug: deps.project_slug,
    audit: deps.audit,
  })

  const research_start = guard.wrapToolHandler<
    ResearchStartInput,
    ResearchStartResult
  >({
    tool_name: 'research_start',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: ResearchStartInput): Promise<ResearchStartResult> => {
      return deps.backend.start(input)
    },
  })

  const research_status = guard.wrapToolHandler<
    ResearchStatusInput,
    ResearchStatusResult
  >({
    tool_name: 'research_status',
    capability_required: READ_CAPABILITY,
    fn: async (input: ResearchStatusInput): Promise<ResearchStatusResult> => {
      return deps.backend.status(input)
    },
  })

  const research_fetch = guard.wrapToolHandler<
    ResearchFetchInput,
    ResearchFetchResult
  >({
    tool_name: 'research_fetch',
    capability_required: READ_CAPABILITY,
    fn: async (input: ResearchFetchInput): Promise<ResearchFetchResult> => {
      return deps.backend.fetch(input)
    },
  })

  return { research_start, research_status, research_fetch }
}
