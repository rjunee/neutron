/**
 * @neutronai/trident — agent system-prompt loader.
 *
 * Bridges the dispatch layer to the lifted `prompts/{forge,atlas,argus,
 * sentinel}.md` execution contracts.
 *
 * BEFORE this module those files were DEAD CODE: `trident/prompts.ts`
 * builds the dispatched agent's prompt INLINE, so the detailed contracts
 * in the `.md` files (Argus's review checklist + cross-model hardening,
 * Forge's delivery mechanics, Atlas's research discipline, Sentinel's
 * QA protocol) never reached the agent. `loadAgentSystemPrompt` reads the
 * on-disk file through `@neutronai/prompts` — the canonical, path-traversal
 * -safe reader that substitutes the platform `{{OWNER_HOME}}` /
 * `{{TELEGRAM_CHAT_ID}}` template tokens — and uses it as the dispatched
 * agent's SYSTEM prompt.
 *
 * It NEVER throws into the dispatch path: a missing or empty prompt file
 * (bare checkout, partial deploy) falls back to a minimal inline identity
 * line so an agent is never dispatched with no role at all.
 */

import { buildPromptVars, loadPrompt } from '../prompts/index.ts'
import type { AgentKind } from '../runtime/subagent/registry.ts'

/**
 * The dispatchable typed agents — every `AgentKind` that carries a
 * `prompts/<kind>.md` execution contract. This is `AgentKind` minus the
 * generic `'core'` (which is not a persona-driven agent and ships no
 * prompt file).
 */
export type DispatchAgentKind = Exclude<AgentKind, 'core'>

/** Every dispatchable typed agent, in a stable order (tests iterate it). */
export const DISPATCH_AGENT_KINDS: readonly DispatchAgentKind[] = [
  'forge',
  'argus',
  'atlas',
  'sentinel',
]

export interface AgentSystemPrompt {
  kind: DispatchAgentKind
  /** The system-prompt text handed to the dispatched agent. */
  content: string
  /**
   * `'file'` when the on-disk `prompts/<kind>.md` loaded cleanly;
   * `'fallback'` when it was missing/empty/unreadable and the inline
   * identity line below was used instead.
   */
  source: 'file' | 'fallback'
}

/**
 * Minimal inline identity used ONLY when `prompts/<kind>.md` cannot be
 * read. Deliberately terse — the real, detailed contract lives in the
 * `.md` file; this is the degraded-but-functional path so a missing file
 * never dispatches an agent with no role.
 */
export const AGENT_PROMPT_FALLBACK: Readonly<Record<DispatchAgentKind, string>> = {
  forge:
    "You are Forge — Neutron's autonomous build sub-agent. Make the smallest correct change for the task, run the tests until green, commit, push, and open a PR. Never block on human input.",
  argus:
    "You are Argus — Neutron's autonomous code-review sub-agent. Review the branch's changes and return an APPROVE or REQUEST CHANGES verdict. Be specific; never exit silently.",
  atlas:
    "You are Atlas — Neutron's research, analysis, ops, strategy, and writing agent (everything that isn't code). Read context first, do the work in this session, write the result, and exit.",
  sentinel:
    "You are Sentinel — Neutron's independent quality checker for non-code work. Verify the artifact against its spec or acceptance criteria — you verify work, you never produce it.",
}

export interface LoadAgentPromptDeps {
  /**
   * Prompt-file reader. Defaults to `@neutronai/prompts`'s `loadPrompt`,
   * which resolves `prompts/<name>` relative to the package (not the cwd)
   * and substitutes template variables. Tests inject a stub.
   */
  load_prompt?: (name: string, vars: Readonly<Record<string, string>>) => string
  /**
   * Template variables for substitution. Defaults to `buildPromptVars()`
   * (the owner env). Tests inject a fixed map.
   */
  vars?: Readonly<Record<string, string>>
}

/**
 * Load the system prompt for a dispatchable agent kind from
 * `prompts/<kind>.md`, substituting the platform template variables.
 *
 * On ANY failure (file missing, empty after trim, read/parse/template
 * error) it returns the inline fallback with `source: 'fallback'` —
 * loading a prompt must never throw into the dispatch path, and a bare
 * checkout must still dispatch a functional agent.
 */
export function loadAgentSystemPrompt(
  kind: DispatchAgentKind,
  deps: LoadAgentPromptDeps = {},
): AgentSystemPrompt {
  const load = deps.load_prompt ?? loadPrompt
  const vars = deps.vars ?? buildPromptVars()
  try {
    const content = load(`${kind}.md`, vars)
    if (typeof content === 'string' && content.trim().length > 0) {
      return { kind, content, source: 'file' }
    }
  } catch {
    // Fall through to the inline fallback — never propagate into dispatch.
  }
  return { kind, content: AGENT_PROMPT_FALLBACK[kind], source: 'fallback' }
}
