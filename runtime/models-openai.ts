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
 * The default `model_preference` list for an OpenAI-family conversational turn:
 * best model first, then the rotation fallback. The gpt-5-5-api adapter tries
 * these in order, advancing on retryable errors. Returns a fresh array so a
 * caller can't mutate the shared default.
 */
export function getOpenAiModelPreference(): string[] {
  return [OPENAI_BEST_MODEL, OPENAI_FALLBACK_MODEL]
}
