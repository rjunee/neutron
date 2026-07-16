/**
 * @neutronai/research-core — capability-guarded MCP tool wiring for the
 * 5 new S1 tools (research_deep / research_list / research_find /
 * research_cite / research_claims_list).
 *
 * Mirrors `src/tools.ts` for the legacy 3 tools. Each handler is
 * wrapped by `CapabilityGuard.wrapToolHandler` so every dispatch is
 * audited.
 *
 * Per docs/plans/research-core-tier1-brief.md § 3.6.
 */

import {
  CapabilityGuard,
  type SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import {
  BROWSE_CAPABILITY,
  CORE_SLUG,
  READ_CAPABILITY,
  SUBAGENT_CAPABILITY,
  WRITE_CAPABILITY,
} from './manifest.ts'
import type {
  ResearchCiteInput,
  ResearchCiteResult,
  ResearchClaimsListInput,
  ResearchClaimsListResult,
  ResearchDeepInput,
  ResearchFindInput,
  ResearchFindResult,
  ResearchListInput,
  ResearchListResult,
  ResearchProjectBackend,
  ResearchStartResult,
} from './research-orchestrator.ts'

export interface ExtraToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  backend: ResearchProjectBackend
}

export interface BuiltExtraTools {
  research_deep: (input: ResearchDeepInput) => Promise<ResearchStartResult>
  research_list: (input: ResearchListInput) => Promise<ResearchListResult>
  research_find: (input: ResearchFindInput) => Promise<ResearchFindResult>
  research_cite: (input: ResearchCiteInput) => Promise<ResearchCiteResult>
  research_claims_list: (
    input: ResearchClaimsListInput,
  ) => Promise<ResearchClaimsListResult>
}

/**
 * Construct the five new tool handlers, each wrapped by
 * `CapabilityGuard.wrapToolHandler`.
 *
 * Capability split:
 *   - `research_deep`        → write + network:browse + agent:dispatch_subagent
 *   - `research_list`        → read
 *   - `research_find`        → read
 *   - `research_cite`        → write
 *   - `research_claims_list` → read
 *
 * The capability guard checks ONE capability per handler. For the
 * deep tool we choose `WRITE_CAPABILITY` as the primary gate (it
 * writes to research_tasks + research_claims + research_sub_agent_runs);
 * the `network:browse` + `agent:dispatch_subagent` capabilities are
 * declared in the manifest body for discoverability + future use by
 * a multi-capability guard variant. Tests can switch the primary gate
 * via the `primary_capability` override (advanced).
 */
export function buildExtraTools(deps: ExtraToolDeps): BuiltExtraTools {
  const guard = new CapabilityGuard({
    manifest: deps.manifest,
    core_slug: CORE_SLUG,
    owner_slug: deps.project_slug,
    audit: deps.audit,
  })

  const research_deep = guard.wrapToolHandler<ResearchDeepInput, ResearchStartResult>({
    tool_name: 'research_deep',
    capability_required: WRITE_CAPABILITY,
    fn: async (input) => deps.backend.deep(input),
  })

  const research_list = guard.wrapToolHandler<ResearchListInput, ResearchListResult>({
    tool_name: 'research_list',
    capability_required: READ_CAPABILITY,
    fn: async (input) => deps.backend.list(input),
  })

  const research_find = guard.wrapToolHandler<ResearchFindInput, ResearchFindResult>({
    tool_name: 'research_find',
    capability_required: READ_CAPABILITY,
    fn: async (input) => deps.backend.find(input),
  })

  const research_cite = guard.wrapToolHandler<ResearchCiteInput, ResearchCiteResult>({
    tool_name: 'research_cite',
    capability_required: WRITE_CAPABILITY,
    fn: async (input) => deps.backend.cite(input),
  })

  const research_claims_list = guard.wrapToolHandler<
    ResearchClaimsListInput,
    ResearchClaimsListResult
  >({
    tool_name: 'research_claims_list',
    capability_required: READ_CAPABILITY,
    fn: async (input) => deps.backend.claimsForTask(input),
  })

  return {
    research_deep,
    research_list,
    research_find,
    research_cite,
    research_claims_list,
  }
}

/** Re-exported capability strings so callers don't need to import the
 *  manifest module to reference the deep-tool's full capability set. */
export const RESEARCH_DEEP_CAPABILITIES = [
  WRITE_CAPABILITY,
  BROWSE_CAPABILITY,
  SUBAGENT_CAPABILITY,
] as const
