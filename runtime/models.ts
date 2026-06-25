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

// ---------------------------------------------------------------------------
// Runtime BEST_MODEL override — the model-update watchdog's "real config path"
// (Vajra port row #16, docs/research/vajra-terminal-detection-keystroke-port-
// 2026-06-25.md).
// ---------------------------------------------------------------------------

/**
 * Process-local override for {@link BEST_MODEL}, flipped by the model-update
 * watchdog's graceful upgrade when Anthropic ships a newer top-tier model.
 * `undefined` until an upgrade adopts a new id.
 */
let runtimeBestModel: string | undefined

/**
 * The effective best model id: the watchdog override when one has been adopted,
 * else the env/default {@link BEST_MODEL}. This is the ONE accessor fresh
 * persistent-REPL spawns resolve their `--model` through, so once the watchdog
 * flips the override (via {@link setBestModelOverride}) every NEW session comes
 * up on the new model with no redeploy and no env change — the "auto-upgrade
 * like Claude Code, applied to the model" capability. Existing warm sessions are
 * moved separately by the idle-gated graceful respawn (which rewrites each
 * registry record's `model`), so a brand-new session and a just-respawned one
 * agree on the model.
 *
 * Why an accessor and not a re-export of `BEST_MODEL`: `BEST_MODEL` is bound
 * ONCE at module load from `process.env`; a runtime upgrade cannot mutate a
 * `const`. Code that wants the live value must call `getBestModel()`.
 */
export function getBestModel(): string {
  return runtimeBestModel ?? BEST_MODEL
}

/**
 * Adopt (or clear, with `undefined`/empty) the runtime BEST_MODEL override.
 * Idempotent. Called by the model-update watchdog after it detects a genuine new
 * top-tier model and posts the upgrade notice.
 */
export function setBestModelOverride(model: string | undefined): void {
  runtimeBestModel = model !== undefined && model.trim() !== '' ? model : undefined
}

/**
 * Models the model-update probe must NEVER treat as a "new default" — the
 * `--fallback-model` trap (Vajra 2026-04-16): during an Opus outage a CLI
 * configured with `--fallback-model` returns the HAIKU/SONNET id, and a naive
 * "new id → upgrade" would then SILENTLY DOWNGRADE every session to the fallback
 * tier. Our probe passes NO `--fallback-model` (so the CLI errors during an
 * outage instead of lying), and this set is defense-in-depth: if a lower-tier id
 * ever reaches the parser it is rejected as an outage, not adopted. Sourced from
 * the lower-tier aliases (+ their base, snapshot-stripped forms) so a future
 * FAST/SONNET model change keeps the guard correct for free.
 */
export function getKnownFallbackModels(): ReadonlySet<string> {
  return new Set<string>([
    FAST_MODEL,
    SONNET_MODEL,
    'claude-haiku-4-5',
    'claude-sonnet-4-6',
  ])
}
