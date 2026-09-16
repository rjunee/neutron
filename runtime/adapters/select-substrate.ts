/**
 * @neutronai/runtime/adapters — provider → Substrate-factory selector.
 *
 * The ONE place that maps a `Provider` string onto its concrete adapter
 * factory. Claude Code (`anthropic`) is the DEFAULT and primary orchestration
 * backend; `openai` (Responses API) and `openai-codex` are alternates a
 * project can opt into behind the SAME locked `Substrate` interface.
 *
 * LAYERING — platform band. This module imports ONLY the three adapter
 * factories + `../substrate.ts` (the locked contract). It MUST NOT import from
 * `gateway/` / `open/` / `onboarding/` / `mcp/` / `connect/` / cores — the
 * per-provider OPTION-BAG mapping (credential pool, `mcpResolver`, model
 * preference) is the COMPOSER's job (gateway band), not the selector's. The
 * selector only answers "which factory", never "with what options".
 *
 * Each adapter's `create*` factory takes a DIFFERENT options type
 * (`ClaudeCodeSubstrateOptions` / `GptResponsesApiSubstrateOptions` /
 * `CodexCliSubstrateOptions`), so the selector returns a DISCRIMINATED result
 * (`{ provider, create }`) rather than a single unified factory signature. The
 * composer switches on `.provider` and builds the matching option bag.
 *
 * This selector owns the conversational/headless `Substrate` factory seam. A
 * project build's persistent in-REPL acting turn is selected separately by the
 * project composition (`open/wiring/project-build.ts`); selecting Codex here is
 * not evidence that bounded work can enter the live project conversation.
 */

import type { Substrate } from '../substrate.ts'
import { PROVIDERS, type Provider } from '../provider.ts'
import {
  createClaudeCodeSubstrateAuto,
  type ClaudeCodeSubstrateOptions,
} from './claude-code/index.ts'
import {
  createGptResponsesApiSubstrate,
  type GptResponsesApiSubstrateOptions,
} from './openai-responses/index.ts'
import {
  createCodexCliSubstrate,
  type CodexCliSubstrateOptions,
} from './codex-cli/index.ts'

/**
 * The conversational/utility model provider a project can select. `anthropic`
 * (Claude Code) is the untouched default; `openai` is the OpenAI Responses API
 * adapter (BYO `OPENAI_API_KEY`); `openai-codex` shells out to the Codex CLI.
 * `pi` is part of the stored/build vocabulary but has no conversational adapter;
 * selecting its factory therefore fails loudly below.
 */
export type { Provider } from '../provider.ts'

/**
 * Discriminated factory result. The `create` function is the adapter factory
 * VERBATIM (`selectSubstrateFactory('anthropic').create === createClaudeCodeSubstrateAuto`),
 * so the composer can call it with the exact option bag it builds today.
 */
export type SelectedSubstrateFactory =
  | { provider: 'anthropic'; create: (opts: ClaudeCodeSubstrateOptions) => Substrate }
  | { provider: 'openai'; create: (opts: GptResponsesApiSubstrateOptions) => Substrate }
  | { provider: 'openai-codex'; create: (opts?: CodexCliSubstrateOptions) => Substrate }

/**
 * Capability descriptor for a provider — lets callers ask what a backend can do
 * BEFORE routing work to it, so degradation is surfaced LOUDLY instead of a
 * silent no-op. `runtime/substrate.ts` (the locked contract) carries no
 * capability field; this is the composition-layer companion the audit flagged as
 * missing (high finding: "Substrate interface has no capability discovery").
 *
 *  - `continuity` — how cross-turn continuity is achieved. Claude Code keeps it
 *    IMPLICITLY in the warm REPL transcript keyed by the pool key, so it ignores
 *    `spec.session` (`'pool-key'`). The OpenAI-family adapters are STATELESS
 *    between turns and require the caller to thread `spec.session.id`
 *    (`previous_response_id` / `--resume`) — a `'session-id'` provider that is
 *    NOT given a session ledger is AMNESIAC every turn.
 *  - `nativeToolBridge` — exposes Neutron tools via the native REPL tool bridge
 *    (`setReplToolBridge`). ONLY Claude Code; OpenAI-family adapters resolve
 *    tools through the neutral `AgentSpec.tools` + `mcpResolver` contract, so a
 *    caller relying on the bridge must populate `spec.tools` instead.
 */
export interface ProviderCapabilities {
  continuity: 'pool-key' | 'session-id'
  nativeToolBridge: boolean
}

/**
 * Static capability table for conversational continuity and tool wiring.
 */
export function providerCapabilities(provider: Provider): ProviderCapabilities {
  switch (provider) {
    case 'anthropic':
      return { continuity: 'pool-key', nativeToolBridge: true }
    case 'openai':
      return { continuity: 'session-id', nativeToolBridge: false }
    case 'openai-codex':
      return { continuity: 'session-id', nativeToolBridge: false }
    case 'pi':
      return { continuity: 'session-id', nativeToolBridge: false }
    default: {
      const _exhaustive: never = provider
      void _exhaustive
      return { continuity: 'pool-key', nativeToolBridge: true }
    }
  }
}

/** The known provider values, for validation + actionable error messages. */
export const KNOWN_PROVIDERS: readonly Provider[] = PROVIDERS

export function assertConversationalProviderWired(
  provider: Provider,
  source?: ProviderSelectionSource,
): asserts provider is Exclude<Provider, 'pi'> {
  if (provider === 'pi') {
    throw new Error(`Provider 'pi' has no conversational substrate adapter. Selection source: ${source ?? 'unspecified'}.`)
  }
}

export type ProviderSelectionSource = 'application' | 'instance' | 'project'

export interface ProviderSelection {
  provider: Provider
  source: ProviderSelectionSource
}

/** Resolve the three-level provider hierarchy without collapsing an absent
 * project override into an explicit choice. Most-specific non-empty value wins. */
export function resolveProviderSelection(input: {
  instance?: string | null
  project?: string | null
}): ProviderSelection {
  if (input.project !== undefined && input.project !== null && input.project.trim() !== '') {
    return { provider: normalizeProvider(input.project), source: 'project' }
  }
  if (input.instance !== undefined && input.instance !== null && input.instance.trim() !== '') {
    return { provider: normalizeProvider(input.instance), source: 'instance' }
  }
  return { provider: 'anthropic', source: 'application' }
}

/**
 * Normalize a provider string to a known `Provider` — the single chokepoint that
 * decides "which backend" from raw config (`NEUTRON_MODEL_PROVIDER`).
 *
 *   - ABSENT / empty / whitespace-only ⇒ `'anthropic'` (the default, Claude Code).
 *     This is the ONLY coercion — the normal Claude case stays byte-identical.
 *   - A KNOWN value ⇒ itself.
 *   - An UNKNOWN non-empty value ⇒ a LOUD, actionable THROW.
 *
 * The throw is the ROOT-CAUSE fix for the silent-fallback class: a typo
 * (`'openaii'`), an un-wired value, or a future provider not yet wired must FAIL
 * LOUD rather than silently coerce to `'anthropic'` and route an operator's data
 * to Claude when they selected something else. Callers that read this from config
 * (composer boot) surface it as a boot error; the substrate seam only ever passes
 * a compile-time `Provider` or `undefined`, so it never trips the throw in
 * production.
 */
export function normalizeProvider(provider: string | undefined | null): Provider {
  if (provider === undefined || provider === null || provider.trim() === '') return 'anthropic'
  const v = provider.trim()
  if (PROVIDERS.some((known) => known === v)) return v as Provider
  throw new Error(
    `Unknown model provider '${provider}'. Valid values: ${KNOWN_PROVIDERS.map((p) => `'${p}'`).join(
      ', ',
    )} (or leave NEUTRON_MODEL_PROVIDER unset for the default, Claude Code). ` +
      'Refusing to coerce an unrecognized value to Claude — set a valid provider or unset it.',
  )
}

/**
 * Map a `Provider` onto its adapter factory. Returns a discriminated
 * `{ provider, create }` so the caller keeps full type information on the
 * option bag each factory expects.
 *
 * `'anthropic'` (the DEFAULT) returns `createClaudeCodeSubstrateAuto` verbatim —
 * the resolved factory is byte-identical to what every production construction
 * site hardcodes today, so an absent/`'anthropic'` provider is a no-op.
 */
export function selectSubstrateFactory(provider: Provider): SelectedSubstrateFactory {
  assertConversationalProviderWired(provider)
  switch (provider) {
    case 'openai':
      return { provider: 'openai', create: createGptResponsesApiSubstrate }
    case 'openai-codex':
      return { provider: 'openai-codex', create: createCodexCliSubstrate }
    case 'anthropic':
      return { provider: 'anthropic', create: createClaudeCodeSubstrateAuto }
    default: {
      // Exhaustiveness guard: a new Provider variant that forgets a case is a
      // compile error here. Raw runtime values are rejected by normalizeProvider.
      const _exhaustive: never = provider
      void _exhaustive
      throw new Error(`Unknown model provider '${String(_exhaustive)}'`)
    }
  }
}
