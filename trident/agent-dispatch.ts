/**
 * @neutronai/trident — typed agent dispatch.
 *
 * Dispatches any of the four typed agents (Forge / Argus / Atlas /
 * Sentinel) through the SAME one-turn `TridentDispatch` substrate closure
 * the Forge→Argus loop uses, with the agent's on-disk `prompts/<kind>.md`
 * execution contract loaded as its SYSTEM prompt.
 *
 * Why this exists: the dispatch layer was Forge/Argus-only. The trident
 * state machine spawns only those two (`orchestrator.ts`), and the lifted
 * `prompts/{atlas,sentinel}.md` files were dead code — Atlas (research /
 * analysis / ops / strategy / writing) and Sentinel (review of NON-code
 * work) had no path into the dispatcher at all. `dispatchAgent` is that
 * path: a phase-less, one-shot typed dispatch that REUSES the existing
 * `TridentDispatch` machinery rather than rebuilding trident.
 *
 * It deliberately does NOT run inside the Forge→Argus state machine —
 * Atlas and Sentinel are not build-loop phases. A caller (e.g. a future
 * `/research` chat command, or Sentinel review of an Atlas deliverable)
 * invokes this directly with the per-instance substrate dispatch closure.
 */

import {
  loadAgentSystemPrompt,
  type DispatchAgentKind,
  type LoadAgentPromptDeps,
} from './agent-prompts.ts'
import type { TridentDispatch, TridentDispatchResult } from './session.ts'

export interface DispatchAgentInput {
  /** Which typed agent to dispatch. */
  kind: DispatchAgentKind
  /** The task / artifact instructions handed to the agent (user turn). */
  task: string
  /** Repo / working dir the agent operates in. */
  repo_path: string
  /** Owning run id for audit. Defaults to a freshly-minted id. */
  trident_run_id?: string
  /** Resolved model id. */
  model: string
  /** Wall-clock budget for this dispatch. */
  timeout_ms: number
}

export interface DispatchAgentDeps {
  /** One Forge/Argus/Atlas/Sentinel turn → terminal text. */
  dispatch: TridentDispatch
  /** Prompt-loader override (test seam — inject a stub `load_prompt`). */
  prompt_deps?: LoadAgentPromptDeps
  /** run_id factory for the audit field (test seam). */
  mint_run_id?: () => string
}

export interface DispatchAgentOutcome extends TridentDispatchResult {
  kind: DispatchAgentKind
  /** Whether the system prompt came from `prompts/<kind>.md` or the
   *  inline fallback (observability — a `'fallback'` flags a missing file). */
  prompt_source: 'file' | 'fallback'
}

/**
 * Dispatch a typed agent: load `prompts/<kind>.md` as the SYSTEM prompt
 * (falling back to the inline identity if the file is missing), hand the
 * task as the user turn, and run one substrate turn to terminal text.
 *
 * Returns the dispatch result plus the resolved `kind` and `prompt_source`
 * so a caller / test can assert the loaded contract actually reached the
 * agent config rather than an inline string.
 */
export async function dispatchAgent(
  input: DispatchAgentInput,
  deps: DispatchAgentDeps,
): Promise<DispatchAgentOutcome> {
  const sys = loadAgentSystemPrompt(input.kind, deps.prompt_deps)
  const mint = deps.mint_run_id ?? (() => crypto.randomUUID())
  const res = await deps.dispatch({
    kind: input.kind,
    system: sys.content,
    user_message: input.task,
    repo_path: input.repo_path,
    trident_run_id: input.trident_run_id ?? mint(),
    model: input.model,
    timeout_ms: input.timeout_ms,
  })
  return { ...res, kind: input.kind, prompt_source: sys.source }
}
