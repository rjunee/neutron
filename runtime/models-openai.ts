/**
 * @neutronai/runtime — central OpenAI model resolver.
 *
 * Mirrors `runtime/models.ts` (the Claude registry) for the OpenAI-family
 * adapters. Single source of truth for every OpenAI model id Neutron dispatches,
 * so a project that opts into `provider:'openai'` never carries a hardcoded model
 * id outside this file.
 *
 * **Rule:** never hardcode an OpenAI model id outside this file. Add an alias
 * here if you need one. Same discipline as `runtime/models.ts`.
 *
 * The gpt-5-5-api adapter does adapter-internal rotation over
 * `AgentSpec.model_preference: string[]`; the composer's OpenAI path remaps the
 * caller's (Claude-shaped) `model_preference` to {@link getOpenAiModelPreference}
 * before dispatch. GPT-5.6 is the current top-tier default with GPT-5.5 as the
 * rotation fallback (separate rate-limit consideration, same shape).
 */

/**
 * The best OpenAI conversational model. Override via `NEUTRON_OPENAI_BEST_MODEL`.
 * Defaults to GPT-5.6.
 */
export const OPENAI_BEST_MODEL: string =
  process.env['NEUTRON_OPENAI_BEST_MODEL'] ?? 'gpt-5.6'

/**
 * Rotation fallback drawn after {@link OPENAI_BEST_MODEL} exhausts retryable
 * errors (429/5xx). Override via `NEUTRON_OPENAI_FALLBACK_MODEL`. Defaults to
 * GPT-5.5.
 */
export const OPENAI_FALLBACK_MODEL: string =
  process.env['NEUTRON_OPENAI_FALLBACK_MODEL'] ?? 'gpt-5.5'

/**
 * The fast/cheap OpenAI model — lightweight utility turns. Override via
 * `NEUTRON_OPENAI_FAST_MODEL`. Defaults to GPT-5.6-mini.
 */
export const OPENAI_FAST_MODEL: string =
  process.env['NEUTRON_OPENAI_FAST_MODEL'] ?? 'gpt-5.6-mini'

/**
 * The `model_preference` list for an OpenAI-family conversational turn: best model
 * first, then the rotation fallback. The gpt-5-5-api adapter tries these in order,
 * advancing on retryable errors. Returns a FRESH array (caller can't mutate the
 * default).
 *
 * OPERATOR-CORRECTABLE (audit round 10) — the ids are resolved DYNAMICALLY from
 * `env` so an operator can correct them WITHOUT a code change if OpenAI's GA id
 * ever firms up slightly differently from `gpt-5.6`, in precedence order:
 *
 *   1. `NEUTRON_OPENAI_MODEL_PREFERENCE` — a comma-separated list that REPLACES the
 *      whole preference (e.g. `gpt-5.6-ga,gpt-5.5`). Blank entries dropped.
 *   2. else `[ NEUTRON_OPENAI_MODEL ?? NEUTRON_OPENAI_BEST_MODEL ?? 'gpt-5.6',
 *             NEUTRON_OPENAI_FALLBACK_MODEL ?? 'gpt-5.5' ]`.
 *
 * Default (nothing set) ⇒ `['gpt-5.6','gpt-5.5']` — the user's explicitly-requested
 * models, unchanged. NB: `NEUTRON_OPENAI_MODEL` is the ergonomic single-primary
 * override; `NEUTRON_OPENAI_BEST_MODEL` remains as the module-const seed's override.
 */
export function getOpenAiModelPreference(
  env: NodeJS.ProcessEnv = typeof process !== 'undefined' ? process.env : ({} as NodeJS.ProcessEnv),
): string[] {
  const listOverride = env['NEUTRON_OPENAI_MODEL_PREFERENCE']
  if (typeof listOverride === 'string' && listOverride.trim() !== '') {
    const ids = listOverride
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (ids.length > 0) return ids
  }
  const primary =
    env['NEUTRON_OPENAI_MODEL'] ?? env['NEUTRON_OPENAI_BEST_MODEL'] ?? 'gpt-5.6'
  const fallback = env['NEUTRON_OPENAI_FALLBACK_MODEL'] ?? 'gpt-5.5'
  return [primary, fallback]
}
