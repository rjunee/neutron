/**
 * @neutronai/research-core — production wiring helper.
 *
 * Single source of truth for how the production composer assembles
 * the Research Core's runtime: per-instance resolver + concurrency gate
 * + runtime substrate + sub-agent dispatcher + project backend + chat-
 * command filter. Both `gateway/index.ts` AND the composer test in
 * `gateway/__tests__/research-core-production-composer.test.ts`
 * invoke THIS factory so a wireup gap in production is caught by the
 * test on the same code path.
 *
 * The previous Argus r1 PR #256 anti-pattern: the composer test
 * self-constructed the substrate + dispatcher + backend, then claimed
 * to "mirror" the boot path. The self-construction masked
 * `buildCannedResearchSubstrate({responses: []})` shipping in
 * production (BLOCKER #4) and the missing `sub_agent_dispatcher`
 * (BLOCKER #3) — both fixed in PR #256 r2 by routing both call sites
 * through this helper.
 */

import type { NeutronManifest } from '@neutronai/cores-sdk'

import {
  buildProjectResearchOrchestrator,
  type ResearchProjectBackend,
} from './research-orchestrator.ts'
import { loadManifest } from './manifest.ts'
import { ResearchStoreResolver } from './store-resolver.ts'
import {
  PerOwnerConcurrencyGate,
  type RuntimeSubAgentDispatcher,
} from './sub-agent.ts'
import {
  buildRuntimeResearchSubAgentDispatcher,
  buildRuntimeResearchSubstrate,
  type ResearchLlmCall,
} from './substrate-runtime.ts'
import {
  createResearchChatCommandFilter,
  type ResearchChatCommandFilter,
} from './chat-bridge.ts'
import { SUB_AGENT_DEFAULT_CONCURRENCY_CAP } from './manifest.ts'
import type { ResearchSubstrate } from './backend.ts'

export interface BuildProductionResearchCoreWiringOptions {
  project_slug: string
  owner_home: string
  /** The opaque LLM-call closure the gateway built against its
   *  credential pool. The Research Core stays substrate-agnostic. */
  llm_call: ResearchLlmCall
  /** Default project_id used by the chat-command filter when the
   *  inbound `/research` envelope omits one. */
  default_project_id?: string
  /** Override the per-instance concurrency cap (default 2). */
  concurrency_cap?: number
  /** Override the manifest (tests rarely need this). */
  manifest?: NeutronManifest
}

export interface ProductionResearchCoreWiring {
  resolver: ResearchStoreResolver
  concurrency_gate: PerOwnerConcurrencyGate
  substrate: ResearchSubstrate
  sub_agent_dispatcher: RuntimeSubAgentDispatcher
  manifest: NeutronManifest
  project_backend: ResearchProjectBackend
  chat_command_filter: ResearchChatCommandFilter
}

/**
 * Construct the production Research Core wiring. Returns every
 * primitive the boot path needs; the gateway threads
 * `project_backend` into the `installBundledCores` factory map AND
 * passes `chat_command_filter` into the app-WS surface so the MCP
 * tools and the `/research` chat filter share the SAME backend
 * instance (and therefore the SAME per-project SQLite files + the
 * SAME runtime substrate).
 */
export function buildProductionResearchCoreWiring(
  opts: BuildProductionResearchCoreWiringOptions,
): ProductionResearchCoreWiring {
  const resolver = new ResearchStoreResolver({
    project_slug: opts.project_slug,
    owner_home: opts.owner_home,
  })
  const concurrency_gate = new PerOwnerConcurrencyGate({
    cap: opts.concurrency_cap ?? SUB_AGENT_DEFAULT_CONCURRENCY_CAP,
  })
  const substrate = buildRuntimeResearchSubstrate({ llm_call: opts.llm_call })
  const sub_agent_dispatcher = buildRuntimeResearchSubAgentDispatcher({
    llm_call: opts.llm_call,
  })
  const manifest = opts.manifest ?? loadManifest()
  const project_backend = buildProjectResearchOrchestrator({
    resolver,
    substrate,
    sub_agent_dispatcher,
    concurrency_gate,
    manifest,
    project_slug: opts.project_slug,
  })
  const chat_command_filter = createResearchChatCommandFilter({
    backend: project_backend,
    default_project_id: opts.default_project_id ?? 'default',
  })
  return {
    resolver,
    concurrency_gate,
    substrate,
    sub_agent_dispatcher,
    manifest,
    project_backend,
    chat_command_filter,
  }
}
