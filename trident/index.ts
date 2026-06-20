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

export {
  buildMergeCleanupDeps,
  detectBaseBranch,
  TridentMergeError,
} from './merge.ts'
export type { RunHostCommand } from './merge.ts'

export {
  buildTridentOrchestrator,
  computeDiffLineCount,
  TridentPhaseNotWiredError,
} from './orchestrator.ts'
export type {
  TridentStep,
  BuildTridentOrchestratorOptions,
} from './orchestrator.ts'

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
