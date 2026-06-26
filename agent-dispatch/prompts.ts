/**
 * @neutronai/agent-dispatch — kind mapping + the ad-hoc system prompt.
 *
 * The dispatch surface exposes THREE owner/agent-facing kinds that mirror
 * Vajra's named-specialist + ad-hoc spawn model (`spawn-agent.sh` →
 * `~/vajra/docs/reference/agents.md`):
 *
 *   - `research` — a named research/analysis/ops/strategy/writing specialist.
 *     Backed by the lifted Atlas persona (`prompts/atlas.md`).
 *   - `review`   — a named independent quality checker for NON-code work.
 *     Backed by the lifted Sentinel persona (`prompts/sentinel.md`).
 *   - `adhoc`    — a one-shot "just run this task" background agent with no
 *     pre-baked persona. Mirrors Vajra's bare `spawn-agent.sh "<task>"`.
 *
 * Each maps onto a registry `AgentKind` (`runtime/subagent/registry.ts`) so the
 * dispatch records share ONE registry, ONE concurrency cap, and ONE watchdog
 * with the Trident build loop — we build ON the existing primitive, we do not
 * fork a parallel one. `research → atlas`, `review → sentinel`, `adhoc → core`
 * (the generic kind reserved for exactly this "no named persona" case).
 *
 * Forge/Argus are intentionally NOT dispatchable here: they are the Trident
 * build-loop agents driven by the orchestrator with their NATIVE
 * `trident/prompts.ts` contract (the one `parseForgeOutput`/`parseArgusVerdict`
 * depend on). A general dispatch must never hand a build agent a different
 * contract — see `trident/agent-prompts.ts` for the same fence at the type
 * level.
 */

import type { AgentKind } from '../runtime/subagent/registry.ts'

/** Owner/agent-facing dispatch kinds. */
export type DispatchKind = 'research' | 'review' | 'adhoc'

/** Stable order — tools enumerate it for the input enum + tests iterate it. */
export const DISPATCH_KINDS: readonly DispatchKind[] = ['research', 'review', 'adhoc']

/**
 * Map a dispatch kind onto the registry `AgentKind` it records under. Keeping
 * this a total map (every `DispatchKind` present) means a new kind is a
 * compile error here rather than a silent fallthrough at the call site.
 */
export const AGENT_KIND_BY_DISPATCH_KIND: Readonly<Record<DispatchKind, AgentKind>> = {
  research: 'atlas',
  review: 'sentinel',
  adhoc: 'core',
}

/**
 * Reverse map — the watchdog surfaces failures keyed by `AgentKind`, and the
 * dispatch report-back needs to translate back to the owner-facing kind. Only
 * the three kinds THIS surface owns are present; `forge`/`argus` resolve to
 * `undefined` (they belong to Trident, not this dispatcher) so a watchdog
 * notifier can cheaply skip a build-loop agent's failure.
 */
export const DISPATCH_KIND_BY_AGENT_KIND: Readonly<
  Partial<Record<AgentKind, DispatchKind>>
> = {
  atlas: 'research',
  sentinel: 'review',
  core: 'adhoc',
}

/**
 * Persona kinds whose SYSTEM role is loaded from `prompts/<kind>.md`. The
 * ad-hoc kind has no persona file — its role is the inline prompt below.
 */
export type DispatchPersonaKind = 'atlas' | 'sentinel'

/**
 * Inline role for the ad-hoc kind. Deliberately terse: an ad-hoc dispatch is
 * "do exactly this, write the result, exit". Mirrors the spirit of a bare
 * `spawn-agent.sh "<task>"` with no named specialist persona.
 */
export const ADHOC_SYSTEM_PROMPT =
  'You are a Neutron background agent dispatched to complete one specific task ' +
  'autonomously. Read whatever context you need first, do the work in this ' +
  'session, write the result where it belongs, and end your turn with a concise ' +
  'summary of what you did and where the output lives. You have no human to ask — ' +
  'make the best judgment call and note any assumptions in your summary.'
