/**
 * @neutronai/trident — persona-agent system-prompt loader.
 *
 * Bridges the dispatch layer to the lifted `prompts/{atlas,sentinel}.md`
 * persona contracts — and ONLY those two.
 *
 * SCOPE — atlas/sentinel only, deliberately. This module loads a persona
 * as the dispatched agent's SYSTEM prompt. Forge and Argus do NOT take a
 * persona system prompt: their parser-locked execution contract rides the
 * dispatch's `user_message`, rendered by `trident/prompts.ts`
 * (`renderForgePrompt` / `renderArgusPrompt`) and depended on by
 * `parseForgeOutput` / `parseArgusVerdict` — Forge emits
 * `PR_NUMBER=`/`BRANCH=`/`WORKTREE=`; Argus emits `APPROVE` / `REQUEST
 * CHANGES`. So a build-loop agent is never handed a *system* persona here.
 *
 * NOTE (P1-3 reconciliation): all four roles now read their prompt from the
 * SAME on-disk source — `prompts/{forge,argus,atlas,sentinel}.md` via
 * `@neutronai/prompts` `loadPrompt`. The earlier drift landmine (the on-disk
 * `forge.md`/`argus.md` being dead code that "would FIGHT the parse contract")
 * is closed: those two files were rewritten from the legacy Nova
 * `/forge/delivered` model to the NATIVE substrate contract, and
 * `trident/prompts.ts` `loadForgeTemplate()` / `loadArgusTemplate()` load them
 * as the build agents' user-message body. The forge/argus disk read therefore
 * happens in `trident/prompts.ts` (user-message template), while THIS module
 * stays scoped to the atlas/sentinel SYSTEM personas — a real role split, not
 * the old "never loaded" claim.
 *
 * Atlas (research / analysis / ops / strategy / writing) and Sentinel
 * (review of NON-code work) have NO pre-existing parse contract — they are
 * the genuinely-new dispatch path, so loading their persona from disk is
 * safe. `loadAgentSystemPrompt` reads the on-disk file through
 * `@neutronai/prompts` — the canonical, path-traversal-safe reader that
 * substitutes the platform `{{OWNER_HOME}}` / `{{TELEGRAM_CHAT_ID}}`
 * template tokens — and uses it as the dispatched agent's SYSTEM prompt.
 *
 * It NEVER throws into the dispatch path: a missing or empty prompt file
 * (bare checkout, partial deploy) falls back to a minimal inline identity
 * line so an agent is never dispatched with no role at all.
 */

import { buildPromptVars, loadPrompt } from '@neutronai/prompts/index.ts'
import type { AgentKind } from '@neutronai/runtime/subagent/registry.ts'

/**
 * Every kind the substrate dispatch closure can serve — `AgentKind` minus
 * the generic `'core'` and the reminders-tick `'ritual'` kind. The
 * Forge→Argus state machine spawns `'forge'` / `'argus'`; the phase-less
 * `dispatchAgent` path serves `'atlas'` / `'sentinel'`. A `'ritual'` is NOT
 * a trident persona agent — it is spawned by the reminders fire-time tick
 * (`reminders/rituals.ts`) with its own on-disk `rituals/<id>.md` prompt,
 * never through this loader — so it is excluded here. Used for the `kind`
 * field on a dispatch input.
 */
export type DispatchAgentKind = Exclude<AgentKind, 'core' | 'ritual'>

/**
 * The persona agents whose SYSTEM prompt is loaded from `prompts/<kind>.md`
 * — `DispatchAgentKind` minus the build-loop agents `'forge'` / `'argus'`,
 * which keep their NATIVE `trident/prompts.ts` contract (see module docs).
 * Disk-prompt loading is scoped to exactly these two at the type level so a
 * build-loop agent can never accidentally be handed a cross-runtime legacy
 * prompt.
 */
export type PersonaAgentKind = Exclude<DispatchAgentKind, 'forge' | 'argus'>

/** Every persona agent, in a stable order (tests iterate it). */
export const PERSONA_AGENT_KINDS: readonly PersonaAgentKind[] = ['atlas', 'sentinel']

export interface AgentSystemPrompt {
  kind: PersonaAgentKind
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
export const AGENT_PROMPT_FALLBACK: Readonly<Record<PersonaAgentKind, string>> = {
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
  kind: PersonaAgentKind,
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
