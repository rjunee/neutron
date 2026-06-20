/**
 * @neutronai/research-core — public barrel (v0.2.0, Research Core S1).
 *
 * Tier 1 free Research Core. Atlas-shape research workflow in-process,
 * per-project structured-brief storage at
 * `<OWNER_HOME>/Projects/<project_id>/research/research.db`, with the
 * claim-evidence-citation triple data model + the sources-cited
 * invariant + Haiku-4.5 sub-agent for `/research deep` (web browse +
 * lex/vec hybrid search over prior briefs).
 *
 * Surfaces:
 *  - 8 MCP tools (3 legacy + 5 new — deep / list / find / cite / claims_list)
 *  - chat-command parser + dispatcher
 *    (`/research <topic>`, `/research deep <topic>`, `/research list`,
 *    `/research find <q>`)
 *  - launcher tile + app-tab UI components (P5.3 / P5.x)
 *
 * Per docs/plans/research-core-tier1-brief.md.
 */

export const __MODULE__ = '@neutronai/research-core' as const

export {
  BROWSE_CAPABILITY,
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  PROJECT_ID_EXTENDED_PROPERTY,
  READ_CAPABILITY,
  SUBAGENT_CAPABILITY,
  SUB_AGENT_DEFAULT_BUDGET_MS,
  SUB_AGENT_DEFAULT_CONCURRENCY_CAP,
  TOOL_NAMES,
  WRITE_CAPABILITY,
  loadManifest,
  type ResearchToolName,
} from './src/manifest.ts'

export {
  DEFAULT_DEPTH,
  ResearchInputError,
  ResearchStore,
  ResearchTaskNotFoundError,
  applyResearchSchema,
  buildCannedResearchSubstrate,
  buildResearchOrchestrator,
  buildSynthesisPrompt,
  extractJson,
  validateResearchBrief,
  type BuildOrchestratorOptions,
  type BuildPromptInput,
  type CannedResponse,
  type CannedSubstrate,
  type CannedSubstrateOptions,
  type ConfidenceLevel,
  type ResearchBackend,
  type ResearchBrief,
  type ResearchClaimEntry,
  type ResearchDepth,
  type ResearchFetchInput,
  type ResearchFetchResult,
  type ResearchSource,
  type ResearchStartInput,
  type ResearchStartResult,
  type ResearchStatus,
  type ResearchStatusInput,
  type ResearchStatusResult,
  type ResearchStoreOptions,
  type ResearchSubstrate,
  type ResearchSubstrateInput,
  type ResearchSubstrateResult,
  type ResearchTaskRow,
} from './src/backend.ts'

export {
  buildTools,
  type BuiltTools,
  type ToolDeps,
} from './src/tools.ts'

// S1 — claim store + sources-cited invariant.
export {
  ResearchClaimStore,
  RESEARCH_CLAIM_CONFIDENCES,
  type InsertClaimInput,
  type ResearchClaim,
  type ResearchClaimConfidence,
  type ResearchClaimStoreOptions,
} from './src/claim-store.ts'

export {
  SourcesCitedViolationError,
  assertSourcesCited,
} from './src/claim-validator.ts'

// S1 — per-project sidecar resolver + project-scoped store.
export {
  DEFAULT_MIGRATIONS_DIR,
  RESEARCH_SCHEMA_VERSION,
  RESEARCH_SIDECAR_DB,
  RESEARCH_SIDECAR_DIR,
  ResearchPathTraversalError,
  ResearchSidecarMismatchError,
  ResearchStoreResolver,
  type ResearchProjectHandle,
  type ResearchStoreResolverOptions,
} from './src/store-resolver.ts'

export {
  ResearchProjectStore,
  type ResearchProjectStoreOptions,
  type ResearchProjectTaskRow,
} from './src/research-store.ts'

// S1 — project-scoped orchestrator (deep / list / find / cite / claims).
export {
  buildProjectResearchOrchestrator,
  type ResearchCiteInput,
  type ResearchCiteResult,
  type ResearchClaimsListInput,
  type ResearchClaimsListResult,
  type ResearchDeepInput,
  type ResearchFindInput,
  type ResearchFindResult,
  type ResearchListInput,
  type ResearchListResult,
  type ResearchOrchestratorOptions,
  type ResearchProjectBackend,
  type ResearchProjectHandleResolver,
  type ResearchStartInputV2,
} from './src/research-orchestrator.ts'

// S1 — sub-agent harness + Atlas-shape prompt.
export {
  DEFAULT_SUB_AGENT_MODEL,
  PerOwnerConcurrencyGate,
  SubAgentConcurrencyExceededError,
  SubAgentTimeoutError,
  buildCannedSubAgentDispatcher,
  dispatchResearchSubAgent,
  type CannedSubAgentDispatcher,
  type CannedSubAgentDispatcherInput,
  type DispatchResearchSubAgentDeps,
  type ResearchSubAgentInput,
  type ResearchSubAgentResult,
  type ResearchSubAgentToolCall,
  type RuntimeSubAgentDispatcher,
  type RuntimeSubAgentDispatchInput,
  type RuntimeSubAgentDispatchResult,
} from './src/sub-agent.ts'

export {
  RESEARCH_SUB_AGENT_TOOL_WHITELIST,
  buildSubAgentSystemPrompt,
  isEngineeringShapeQuery,
} from './src/sub-agent-prompt.ts'

// S1 — web search + fetch + allowlist.
export {
  BlockedDestinationError,
  WebFetchCapabilityDeniedError,
  isAllowlisted,
  isUnconditionallyBlocked,
  manifestDeclaresBrowse as manifestDeclaresBrowseForFetch,
  webFetch,
  type WebFetchDeps,
  type WebFetchInput,
  type WebFetchResult,
} from './src/web-fetch.ts'

export {
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_WEB_FETCH_ALLOWLIST,
  HOSTNAME_BLOCKLIST,
} from './src/web-fetch-allowlist.ts'

export {
  WebSearchAuthMissingError,
  WebSearchCapabilityDeniedError,
  WebSearchRateLimitedError,
  buildCannedWebSearchProvider,
  buildTavilyProvider,
  manifestDeclaresBrowse as manifestDeclaresBrowseForSearch,
  webSearch,
  type CannedWebSearchProviderInput,
  type TavilyProviderOptions,
  type WebSearchHit,
  type WebSearchInput,
  type WebSearchProvider,
} from './src/web-search.ts'

// S1 — vault search (lex+vec hybrid over prior briefs).
export {
  sanitizeFtsQuery,
  searchPriorBriefs,
  type ResearchMatchedIn,
  type ResearchSearchHit,
  type SearchInput,
} from './src/vault-search.ts'

// S1 — chat-command parser + dispatcher + chat-bridge filter.
export {
  executeResearchCommand,
  parseResearchCommand,
  type ResearchCommand,
  type ResearchCommandCard,
  type ResearchCommandCardButton,
  type ResearchCommandContext,
  type ResearchCommandResponse,
} from './src/chat-commands.ts'

export {
  createResearchChatCommandFilter,
  type CreateResearchChatCommandFilterOptions,
  type ResearchChatCommandFilter,
  type ResearchChatCommandFilterInput,
  type ResearchChatCommandFilterResult,
} from './src/chat-bridge.ts'

// S1 — 5 new MCP tools.
export {
  RESEARCH_DEEP_CAPABILITIES,
  buildExtraTools,
  type BuiltExtraTools,
  type ExtraToolDeps,
} from './src/mcp-tools-extra.ts'

// S1 — runtime LLM substrate + sub-agent dispatcher adapters.
export {
  buildRuntimeResearchSubAgentDispatcher,
  buildRuntimeResearchSubstrate,
  type BuildRuntimeResearchSubAgentDispatcherOptions,
  type BuildRuntimeResearchSubstrateOptions,
  type ResearchLlmCall,
} from './src/substrate-runtime.ts'

// S1 — production wiring helper.
export {
  buildProductionResearchCoreWiring,
  type BuildProductionResearchCoreWiringOptions,
  type ProductionResearchCoreWiring,
} from './src/wiring-production.ts'

// S1 — markdown render.
export {
  renderBriefMarkdown,
  type RenderOptions,
} from './src/render-markdown.ts'

// S1 — UI components.
export {
  LAUNCHER_ICON,
  type ResearchLauncherIcon,
  type LauncherIconMeta,
} from './src/ui/launcher-icon.ts'

export {
  APP_TAB_SURFACE,
  type ResearchAppTabSurface,
} from './src/ui/app-tab-surface.ts'
