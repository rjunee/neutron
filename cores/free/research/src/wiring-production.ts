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
  type ResearchSubAgentToolExecutors,
} from './substrate-runtime.ts'
import {
  createResearchChatCommandFilter,
  type ResearchChatCommandFilter,
} from './chat-bridge.ts'
import { SUB_AGENT_DEFAULT_CONCURRENCY_CAP } from './manifest.ts'
import type { ResearchSubstrate } from './backend.ts'
import { searchPriorBriefs } from './vault-search.ts'
import { buildTavilyProvider, webSearch } from './web-search.ts'
import { webFetch, type DnsLookupFn } from './web-fetch.ts'

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
  /**
   * Tavily API key getter for the sub-agent's `research_web_search`
   * tool. Re-read PER DISPATCH so a key pasted into Settings lands
   * without a restart (mirrors the credential-freshness doctrine).
   * Returns `null` when no key is configured → the tool degrades
   * gracefully (threads a "web search unavailable" error). Absent
   * entirely = the same no-key degradation.
   */
  tavily_api_key?: () => Promise<string | null>
  /** Override `fetch` for the Tavily search request (test seam). */
  web_search_fetcher?: typeof fetch
  /** Override `fetch` for `research_web_fetch` (test seam). */
  web_fetch_fetcher?: typeof fetch
  /** Override DNS resolution for `research_web_fetch` (test seam). */
  web_fetch_lookup?: DnsLookupFn
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
  const manifest = opts.manifest ?? loadManifest()

  // The three REAL sub-agent tool executors. Each is TOTAL: an outer
  // try/catch converts any thrown error into a threaded `{error}` result
  // (recorded success:false) so a single tool failure never aborts the
  // whole dispatch. Bad-shape inputs return `{error: 'invalid input: ...'}`.
  const default_project_id = opts.default_project_id ?? 'default'
  const tool_executors: ResearchSubAgentToolExecutors = {
    async research_vault_search(args, ctx) {
      try {
        const a = (args ?? {}) as { query?: unknown; limit?: unknown }
        if (typeof a.query !== 'string' || a.query.trim().length === 0) {
          return { error: 'invalid input: `query` must be a non-empty string' }
        }
        const limit =
          typeof a.limit === 'number' && Number.isFinite(a.limit)
            ? a.limit
            : undefined
        const handle = await resolver.resolve(
          ctx.project_id ?? default_project_id,
        )
        return {
          hits: searchPriorBriefs(
            { query: a.query, ...(limit !== undefined ? { limit } : {}) },
            { store: handle.store },
          ),
        }
      } catch (err) {
        return { error: String((err as { message?: unknown })?.message ?? err) }
      }
    },
    async research_web_search(args) {
      try {
        const a = (args ?? {}) as { query?: unknown; max_results?: unknown }
        if (typeof a.query !== 'string' || a.query.trim().length === 0) {
          return { error: 'invalid input: `query` must be a non-empty string' }
        }
        const max_results =
          typeof a.max_results === 'number' && Number.isFinite(a.max_results)
            ? a.max_results
            : undefined
        const key = opts.tavily_api_key ? await opts.tavily_api_key() : null
        const provider = buildTavilyProvider({
          api_key: key,
          ...(opts.web_search_fetcher !== undefined
            ? { fetcher: opts.web_search_fetcher }
            : {}),
        })
        if (!provider.isAvailable()) {
          return {
            error:
              'web search unavailable: no Tavily API key configured. Rely on ' +
              'research_vault_search results and tag externally-sourced claims ' +
              'confidence:"unverified".',
          }
        }
        return {
          hits: await webSearch(
            {
              query: a.query,
              ...(max_results !== undefined ? { max_results } : {}),
            },
            { manifest, provider },
          ),
        }
      } catch (err) {
        return { error: String((err as { message?: unknown })?.message ?? err) }
      }
    },
    async research_web_fetch(args) {
      try {
        const a = (args ?? {}) as { url?: unknown }
        if (typeof a.url !== 'string' || a.url.trim().length === 0) {
          return { error: 'invalid input: `url` must be a non-empty string' }
        }
        return await webFetch(
          { url: a.url },
          {
            manifest,
            ...(opts.web_fetch_fetcher !== undefined
              ? { fetcher: opts.web_fetch_fetcher }
              : {}),
            ...(opts.web_fetch_lookup !== undefined
              ? { lookup: opts.web_fetch_lookup }
              : {}),
          },
        )
      } catch (err) {
        return { error: String((err as { message?: unknown })?.message ?? err) }
      }
    },
  }

  const sub_agent_dispatcher = buildRuntimeResearchSubAgentDispatcher({
    llm_call: opts.llm_call,
    tool_executors,
  })
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
    default_project_id,
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
