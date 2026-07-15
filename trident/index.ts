/**
 * @neutronai/trident — public barrel.
 *
 * Foundational runtime (NOT a Core): the autonomous Forge→Argus→merge
 * state machine ported from Vajra's `/trident` skill. One row per pipeline
 * in the per-project `code_trident_runs` table (migration 0077), advanced
 * by an in-process tick loop.
 *
 * PR-2 of ~5: the state machine + tick driver + git-mode auto-detect. The
 * Forge/Argus spawning (PR-3) and the Ralph plan↔task loop (PR-4) build on
 * these via the `AdvanceDeps` / `MergeCleanupDeps` seams.
 */

export const __MODULE__ = '@neutronai/trident' as const

export { TridentRunStore } from './store.ts'
export type {
  TridentRun,
  TridentPhase,
  MergeMode,
  SubagentStatus,
  CreateTridentRunInput,
  TridentRunUpdate,
} from './store.ts'

export {
  advanceTridentRun,
  computeTransition,
  isTerminalPhase,
  stubAdvanceDeps,
  TERMINAL_PHASES,
} from './state-machine.ts'
export type {
  AdvanceDeps,
  AdvanceOutcome,
  PhaseResult,
  SubagentOutcome,
} from './state-machine.ts'

export { TridentTickLoop } from './tick.ts'
export type { TridentTickOptions, TridentStepFn } from './tick.ts'

// §F6a — the terminal-write chokepoint used by the out-of-band terminal writers
// (`/code stop`, board X-cancel/delete) + the shared observer-chain assembly.
export { buildTridentTerminator } from './terminate.ts'
export type {
  TridentTerminator,
  TridentTerminateStore,
  TridentTerminateOptions,
  TerminateResult,
  TerminateSkipReason,
} from './terminate.ts'
export { withTerminalObserver, composeTerminalHook } from './terminal-observer.ts'

export {
  detectMergeMode,
  defaultGitModeProbe,
  detectRalphMode,
  defaultRalphModeProbe,
  isGithubRemoteUrl,
  cleanupAfterMerge,
  spawnCapture,
} from './git-mode.ts'
export type {
  GitModeProbe,
  RalphModeProbe,
  HostCommandResult,
  MergeCleanupDeps,
  MergeCleanupResult,
} from './git-mode.ts'

// The one surviving Forge/Argus prompt constant. The v1 render/parse half of
// `prompts.ts` (and its `session.ts` / `substrate-dispatch.ts` consumers) was
// deleted — the live Forge/Argus contract is inlined in `inner-workflow.mjs`.
export { ARGUS_DIFF_LINE_LIMIT } from './prompts.ts'

// Persona agent system-prompt loader (Atlas/Sentinel) — LIVE: consumed by the
// general `agent-dispatch/` dispatch service (the `dispatch_agent` tool) via
// `defaultPersonaLoader`. Forge/Argus take no persona system prompt; their
// contract is the inlined `inner-workflow.mjs` build loop.
export {
  loadAgentSystemPrompt,
  AGENT_PROMPT_FALLBACK,
  PERSONA_AGENT_KINDS,
} from './agent-prompts.ts'
export type {
  DispatchAgentKind,
  PersonaAgentKind,
  AgentSystemPrompt,
  LoadAgentPromptDeps,
} from './agent-prompts.ts'

export {
  buildMergeCleanupDeps,
  detectBaseBranch,
  recoverStaleGitState,
  runWorktreePath,
  TridentMergeError,
  TridentMergeConflictEscalation,
} from './merge.ts'
export type { RunHostCommand, MergeConflictResolver } from './merge.ts'

export {
  buildTridentOrchestrator,
  computeDiffLineCount,
} from './orchestrator.ts'
export type {
  TridentStep,
  BuildTridentOrchestratorOptions,
} from './orchestrator.ts'

// Trident v2 (Work Board Phase 2a exec-model) — the inner Forge→Argus→fix loop as
// ONE native CC Dynamic Workflow (`inner-workflow.mjs`), FIRED per run by
// `buildWorkflowFirer` on a warm substrate (`buildSubstrateWorkflowFire`); the
// launching turn settles immediately + the typed result is harvested from the DB.
export {
  buildWorkflowFirer,
  buildSubstrateWorkflowFire,
  buildFireWorkflowPrompt,
  buildWorkflowArgs,
  parseInnerResult,
  DEFAULT_INNER_WORKFLOW_PATH,
  WORKFLOW_FIRE_TOOL_NAMES,
} from './inner-loop.ts'
export type {
  TridentWorkflowFirer,
  InnerLoopInput,
  InnerResult,
  FireOutcome,
  FireInnerWorkflow,
  FireInnerWorkflowInput,
  BuildWorkflowFirerOptions,
  BuildSubstrateWorkflowFireOptions,
} from './inner-loop.ts'

// PR-5 — the thin `/code` entry into foundational Trident (retires the
// Code-Gen Core wrapper's separate orchestration path).
export {
  parseCodeCommand,
  parseAndExecuteCodeCommand,
  executeCodeCommand,
  slugifyTask,
} from './code-command.ts'
export type {
  CodeCommand,
  CodeCommandResponse,
  CodeCommandErrorCode,
  TridentCodeContext,
} from './code-command.ts'
export { dispatchBoardBoundBuild } from './board-dispatch.ts'
export type {
  TridentBoardBinder,
  BoardBoundBuildInput,
  BoardBoundBuildDeps,
  BoardBoundBuildResult,
  BoardBoundBuildRejectionCode,
} from './board-dispatch.ts'
export {
  registerTridentBuildToolSurface,
  WORK_BOARD_DISPATCH_BUILD_TOOL,
} from './work-board-build-tool.ts'
export type { TridentBuildToolDeps } from './work-board-build-tool.ts'
export { buildBoardReconcileObserver } from './board-reconcile.ts'
export type { TridentBoardReconciler } from './board-reconcile.ts'
