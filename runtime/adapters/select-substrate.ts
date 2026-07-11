/**
 * @neutronai/runtime/adapters — provider → Substrate-factory selector.
 *
 * The ONE place that maps a `Provider` string onto its concrete adapter
 * factory. Claude Code (`anthropic`) is the DEFAULT and primary orchestration
 * backend; `openai` (Responses API) and `openai-codex-cli` are alternates a
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
 * TRIDENT NOTE: this selector is for CONVERSATIONAL / utility LLM turns ONLY.
 * Trident's autonomous build loop drives the native `Workflow` tool, which has
 * NO OpenAI analogue — trident's fire substrate stays the Claude-Code warm-fire
 * singleton regardless of a project's conversational provider. Callers wiring
 * trident MUST NOT route it through this selector.
 */

import type { Substrate } from '../substrate.ts'
import {
  createClaudeCodeSubstrateAuto,
  type ClaudeCodeSubstrateOptions,
} from './claude-code/index.ts'
import {
  createGptResponsesApiSubstrate,
  type GptResponsesApiSubstrateOptions,
} from './gpt-5-5-api/index.ts'
import {
  createCodexCliSubstrate,
  type CodexCliSubstrateOptions,
} from './gpt-5-5-codex-cli/index.ts'

/**
 * The conversational/utility model provider a project can select. `anthropic`
 * (Claude Code) is the untouched default; `openai` is the OpenAI Responses API
 * adapter (BYO `OPENAI_API_KEY`); `openai-codex-cli` shells out to the Codex CLI.
 */
export type Provider = 'anthropic' | 'openai' | 'openai-codex-cli'

/**
 * Discriminated factory result. The `create` function is the adapter factory
 * VERBATIM (`selectSubstrateFactory('anthropic').create === createClaudeCodeSubstrateAuto`),
 * so the composer can call it with the exact option bag it builds today.
 */
export type SelectedSubstrateFactory =
  | { provider: 'anthropic'; create: (opts: ClaudeCodeSubstrateOptions) => Substrate }
  | { provider: 'openai'; create: (opts: GptResponsesApiSubstrateOptions) => Substrate }
  | { provider: 'openai-codex-cli'; create: (opts?: CodexCliSubstrateOptions) => Substrate }

/**
 * Normalize an arbitrary (possibly absent / unknown) provider string to a known
 * `Provider`. Absent OR unrecognized ⇒ `'anthropic'` — Claude Code is always the
 * safe default so a mis-set / stale config can never silently strand a project
 * on a half-wired alternate backend.
 */
export function normalizeProvider(provider: string | undefined | null): Provider {
  if (provider === 'openai' || provider === 'openai-codex-cli') return provider
  return 'anthropic'
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
  switch (provider) {
    case 'openai':
      return { provider: 'openai', create: createGptResponsesApiSubstrate }
    case 'openai-codex-cli':
      return { provider: 'openai-codex-cli', create: createCodexCliSubstrate }
    case 'anthropic':
      return { provider: 'anthropic', create: createClaudeCodeSubstrateAuto }
    default: {
      // Exhaustiveness guard: a new Provider variant that forgets a case is a
      // compile error here. At runtime an unknown value degrades to anthropic.
      const _exhaustive: never = provider
      void _exhaustive
      return { provider: 'anthropic', create: createClaudeCodeSubstrateAuto }
    }
  }
}
