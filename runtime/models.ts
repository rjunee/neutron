/**
 * @neutronai/runtime — central model resolver.
 *
 * Single source of truth for every Claude model id used in Neutron. When
 * Anthropic releases a new top-tier model, update the alias here and the
 * entire codebase picks it up.
 *
 * **Rule:** never hardcode a Claude model id outside this file. Add a new
 * alias here if you need one. Mirrors Nova's `gateway/models.ts` pattern.
 *
 * Aliases:
 *   - `BEST_MODEL`   — the user's Max-subscription best model. Used for
 *                      high-quality runtime work that benefits from
 *                      richer reasoning (the actual chat agent, persona
 *                      synthesis, archetype LLM, etc.).
 *   - `SONNET_MODEL` — lower-tier quota model for the Pass-2 fallback
 *                      after `BEST_MODEL` exhausts 429s. Sonnet 4.6 keeps
 *                      Pass-2 synthesis quality high (same prompt body)
 *                      while drawing from a separate rate-limit bucket,
 *                      so a Max-tier Opus 4.7 cumulative-exhaustion event
 *                      still produces a successful synthesis. Per P2-v2
 *                      S21 spec § Pass-2 fallback. Override via
 *                      `NEUTRON_SONNET_MODEL`.
 *   - `FAST_MODEL`   — the fast/cheap model. Used for prompt-generation,
 *                      lightweight rephrase tasks, API probes — places
 *                      where Haiku-class quality is sufficient and
 *                      latency / rate-limit budget matters.
 *   - `PROBE_MODEL`  — alias of `FAST_MODEL`. Used by the Max-OAuth probe
 *                      (`auth/max-oauth.ts`) which only needs an
 *                      always-available cheap model to validate auth
 *                      tier (200 vs 401 vs 403 vs 400).
 *
 * Each alias supports an env override so operators can test new models
 * without a redeploy.
 */

/**
 * The user's Max-subscription best model. Override via `NEUTRON_BEST_MODEL`.
 * Defaults to Claude Opus 4.7.
 */
export const BEST_MODEL: string =
  process.env['NEUTRON_BEST_MODEL'] ?? 'claude-opus-4-7'

/**
 * P2-v2 S21 (2026-05-17) — Pass-2 Sonnet fallback model.
 *
 * Drawn from a separate Anthropic rate-limit bucket from `BEST_MODEL`
 * (Opus 4.7). Live walkthrough failures during P2 v2 development showed
 * Pass-2 cumulatively exhausting Opus 4.7 429s even after S13's
 * `[0, 5s, 15s, 45s]` retry-on-429 schedule was applied — backoff
 * smooths transient bursts but does not solve sustained quota
 * exhaustion on the Max subscription. Sonnet 4.6 keeps Pass-2
 * synthesis quality (same prompt body, same JSON schema, same
 * defensive parser) and trades a stylistically-different result for a
 * successful one.
 *
 * Override via `NEUTRON_SONNET_MODEL`. Defaults to Claude Sonnet 4.6.
 */
export const SONNET_MODEL: string =
  process.env['NEUTRON_SONNET_MODEL'] ?? 'claude-sonnet-4-6'

/**
 * The fast/cheap model. Override via `NEUTRON_FAST_MODEL`. Defaults to
 * Claude Haiku 4.5.
 */
export const FAST_MODEL: string =
  process.env['NEUTRON_FAST_MODEL'] ?? 'claude-haiku-4-5-20251001'

/**
 * Probe model — alias of `FAST_MODEL`. Used by `auth/max-oauth.ts` for the
 * Anthropic Messages API auth-tier probe. Must be a model the user's Max
 * subscription always exposes; Haiku is the safest choice.
 */
export const PROBE_MODEL: string = FAST_MODEL
