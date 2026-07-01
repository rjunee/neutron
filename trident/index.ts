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

// PR-3 — the real Forge/Argus substrate-session wiring.
export {
  FORGE_SYSTEM_PROMPT,
  ARGUS_SYSTEM_PROMPT,
  ARGUS_DIFF_LINE_LIMIT,
  RALPH_BOOTSTRAP_NOTE,
  renderForgePrompt,
  renderForgeFixPrompt,
  renderRalphPlanPrompt,
  renderRalphTaskPrompt,
  renderArgusPrompt,
  chooseArgusScope,
  parseForgeOutput,
  parseRalphPlan,
  parseArgusVerdict,
  parseArgusFindings,
} from './prompts.ts'
export type { ParsedForgeOutput, ParsedRalphPlan } from './prompts.ts'

export { TridentSessionManager } from './session.ts'
export type {
  TridentDispatch,
  TridentDispatchInput,
  TridentDispatchResult,
  TridentSessionManagerOptions,
  ForgeMeta,
} from './session.ts'

// WAVE 2 P1 #7 — persona agent dispatch (Atlas/Sentinel) with the lifted
// `prompts/<kind>.md` personas loaded as the system prompt (previously those
// files were dead code). `dispatchAgent` is the phase-less path that makes
// Atlas + Sentinel dispatchable. Forge/Argus stay on their NATIVE
// `trident/prompts.ts` contract (the parser-locked one) — disk-prompt
// loading is deliberately scoped to the persona agents.
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

export { dispatchAgent } from './agent-dispatch.ts'
export type {
  DispatchAgentInput,
  DispatchAgentDeps,
  DispatchAgentOutcome,
} from './agent-dispatch.ts'

export {
  buildMergeCleanupDeps,
  detectBaseBranch,
  TridentMergeError,
} from './merge.ts'
export type { RunHostCommand } from './merge.ts'

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
