/**
 * @neutronai/codegen-core — public barrel.
 *
 * Tier 1 free Code-Gen Core. Productizes the trident/forge/argus
 * surface for non-technical chat-driven users via an in-process Forge
 * → Argus → autonomous merge orchestrator. See
 * docs/plans/2026-05-22-002-feat-code-gen-core-s2-autonomous-plan.md
 * (supersedes the S1 brief).
 *
 * S2 (this iteration, 2026-05-22):
 *   - Two chat commands ONLY: `/code <task>` (autonomous) +
 *     `/code stop` (alias `/code cancel`) escape hatch.
 *   - Four MCP tools: codegen_dispatch / codegen_status / codegen_fetch
 *     / codegen_cancel. The S1 extras (review / merge / judge / history)
 *     are removed — the autonomous loop subsumes them.
 *   - Per-project worktree at `<OWNER_HOME>/Projects/<id>/code/`.
 *   - Per-project sidecar at `<OWNER_HOME>/Projects/<id>/code-gen/`.
 *   - Sub-agent dispatch via the opaque `CodegenLlmCall` closure +
 *     `buildRuntimeSubagentDispatch` adapter (the multi-turn tool loop
 *     lives inside this Core; the gateway-side factory builds the
 *     closure against the owner's Max OAuth credential or BYO API key).
 *   - Auto-merge default ON; the S1 per-project gate column was
 *     dropped via migration 0002.
 *   - P5.3 launcher tile binding + `app_tab` UI component (unchanged).
 *
 * Cross-refs:
 * - docs/plans/2026-05-22-002-feat-code-gen-core-s2-autonomous-plan.md
 * - docs/plans/code-gen-core-tier1-brief.md (S1 reference; superseded)
 * - cores/free/research/src/substrate-runtime.ts (canonical opaque-LlmCall pattern)
 * - runtime/subagent/ (substrate-agnostic registry; bookkeeping only)
 */

export const __MODULE__ = '@neutronai/codegen-core' as const

export {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  DISPATCH_SUBAGENT_CAPABILITY,
  HOST_GH_CAPABILITY,
  NETWORK_GITHUB_CAPABILITY,
  PROJECT_SIDECAR_DB_FILENAME,
  PROJECT_SIDECAR_DIRNAME,
  PROJECT_WORKTREE_DIRNAME,
  READ_CAPABILITY,
  TOOL_NAMES,
  WRITE_CAPABILITY,
  loadManifest,
  type CodegenToolName,
} from './src/manifest.ts'

export {
  CodegenInputError,
  CodegenMaxRoundsReachedError,
  CodegenNotConfiguredError,
  CodegenOrchestrator,
  CodegenRunError,
  CodegenSubagentTimeoutError,
  CodegenTaskFailedError,
  CodegenTaskNotFoundError,
  CodegenTaskPendingError,
  CodegenTaskTracker,
  CodegenWorktreeNotResolvedError,
  buildSkeletonCodegenRunner,
  nextMacrotaskTick,
  validateDispatchInput,
  validateFetchInput,
  validateStatusInput,
  type CodegenDispatchInput,
  type CodegenFetchInput,
  type CodegenOrchestratorOptions,
  type CodegenRunInput,
  type CodegenRunResult,
  type CodegenRunner,
  type CodegenSettings,
  type CodegenStatusInput,
  type CodegenTaskRecord,
  type CodegenTaskRow,
  type CodegenTaskStatus,
  type InMemoryCodegenRunnerOptions,
} from './src/backend.ts'

export {
  buildTools,
  type BuiltTools,
  type CodegenCancelToolInput,
  type CodegenCancelToolOutput,
  type CodegenDispatchToolInput,
  type CodegenDispatchToolOutput,
  type CodegenFetchToolInput,
  type CodegenFetchToolOutput,
  type CodegenStatusToolInput,
  type CodegenStatusToolOutput,
  type ToolDeps,
} from './src/tools.ts'

// NOTE: the retired v1 code-gen `/code` pipeline was deleted (K8 refactor):
// `chat-commands.ts` (duplicate `/code` grammar — the LIVE `/code` parser is
// `trident/code-command.ts`), `runtime-runner.ts` + `wiring-production.ts` (the
// dead Forge→Argus runner), and `prompts/{forge,argus}-system.ts` (dead prompt
// forks). The live build loop is `trident/inner-workflow.mjs`. The sub-agent
// dispatch types below moved into `substrate-runtime.ts` (their cohesive owner).

export {
  buildCannedCodegenLlmCall,
  buildRuntimeSubagentDispatch,
  type BuildRuntimeSubagentDispatchOptions,
  type CannedCodegenLlmCall,
  type CannedCodegenLlmCallOptions,
  type CodegenLlmCall,
  type CodegenLlmCallInput,
  type CodegenLlmCallResult,
  type CodegenMessage,
  type CodegenMessageContent,
  type CodegenStopReason,
  type CodegenToolBlock,
  type CodegenToolContext,
  type CodegenToolDefinition,
  type CodegenToolHandler,
  type CodegenToolResultBlock,
  type CodegenSubagentKind,
  type SubagentDispatch,
  type SubagentDispatchInput,
  type SubagentDispatchResult,
} from './src/substrate-runtime.ts'

export {
  ARGUS_TOOL_DEFS,
  ATLAS_TOOL_DEFS,
  BASH_TOOL_DEF,
  DEFAULT_ARGUS_BASH_ALLOWLIST,
  EDIT_TOOL_DEF,
  FORGE_TOOL_DEFS,
  GLOB_TOOL_DEF,
  GREP_TOOL_DEF,
  READ_TOOL_DEF,
  SENTINEL_TOOL_DEFS,
  WRITE_TOOL_DEF,
  bashScopedFactory,
  buildArgusToolHandlers,
  buildAtlasToolHandlers,
  buildForgeToolHandlers,
  buildSentinelToolHandlers,
  editFileScoped,
  globScoped,
  grepScoped,
  readFileScoped,
  writeFileScoped,
} from './src/tool-handlers.ts'

export {
  resolveWorktree,
  sluggifyBranch,
  type ResolveWorktreeInput,
  type ResolvedWorktree,
} from './src/worktree-resolver.ts'

export {
  CODE_GEN_SCHEMA_VERSION,
  CodegenSidecar,
  CodegenSidecarMismatchError,
  CodegenSidecarResolver,
  DEFAULT_MIGRATIONS_DIR,
  type CodegenSidecarOptions,
  type CodegenSidecarResolverOptions,
} from './src/sidecar/store.ts'

export {
  buildStubHostRunners,
  type HostBunTestRunner,
  type HostGhRunner,
  type HostGitRunner,
  type HostRunnerResult,
  type StubHostRunnerCalls,
  type StubHostRunners,
  type StubHostRunnersOverrides,
} from './src/host-runners.ts'

export { LAUNCHER_ICON, type LauncherIconMeta } from './src/ui/launcher-icon.ts'
export { APP_TAB_SURFACE, type CodeGenAppTabMeta } from './src/ui/app-tab-surface.ts'

// ── X2: typed Core module contract ──────────────────────────────────────
// The ONE declaration the install composer (`gateway/cores/install-bundled.ts`)
// reads instead of duck-typing barrel exports + a hardcoded backend-key table.
// `backendKey` is the `ToolDeps` key a bare backend primitive maps onto; when
// the backend factory returns an already-shaped object it is passed through
// verbatim. Conformance: cores/runtime/__tests__/define-core-conformance.test.ts.
import { defineCore } from '@neutronai/cores-sdk'
import { CORE_SLUG as CORE_SLUG_X2, TOOL_NAMES as TOOL_NAMES_X2 } from './src/manifest.ts'
import { buildTools as buildTools_X2 } from './src/tools.ts'

export const core = defineCore({
  slug: CORE_SLUG_X2,
  backendKey: 'orchestrator',
  toolNames: TOOL_NAMES_X2,
  buildTools: buildTools_X2,
})
