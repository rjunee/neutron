/**
 * @neutronai/runtime — central model resolver.
 *
 * Single source of truth for every Claude model class used in Neutron. The
 * Claude CLI resolves these class aliases to the latest model in each tier.
 *
 * **Rule:** defaults pin a model CLASS, never a version. Explicit environment
 * overrides may still select a concrete model for an operator-controlled pin.
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
 * Defaults to the latest Claude Opus model.
 *
 * This constant is bound once at module load. The default stays current because
 * the CLI resolves `opus` at each spawn; {@link getBestModel} additionally
 * exposes an operator's process-local concrete override when one is configured.
 */
export const BEST_MODEL: string =
  process.env['NEUTRON_BEST_MODEL'] ?? 'opus'

/**
 * FABLE_MODEL — the ORCHESTRATOR / max-reasoning planning model (Ryan-locked
 * doctrine, SPEC Decisions Log 2026-07-02). Fable 5 is the smartest THINKER: it
 * does the high-value work — implementation-planning, spec-building,
 * decomposition, and verdict synthesis — while `BEST_MODEL` (Opus) and
 * `SONNET_MODEL` are demoted to SUBORDINATE EXECUTION models carrying out Fable's
 * specs. There is deliberately NO "escalate to Opus": Opus is an executor, never
 * a fallback target above Fable. Used by trident's inner workflow to route the
 * `plan:fable` planner + `argus:synthesis` steps (threaded in via `args.models`
 * — the CC Dynamic Workflow script has no module resolution, so it can't import
 * this registry; keep the id here, the single source of truth, not a literal in
 * the workflow). Verified routable 2026-07-02 (`claude-fable-5` returns cleanly).
 *
 * Override via `NEUTRON_FABLE_MODEL`. Defaults to the latest Claude Fable model.
 */
export const FABLE_MODEL: string =
  process.env['NEUTRON_FABLE_MODEL'] ?? 'fable'

/**
 * The mid-tier model. Override via `NEUTRON_SONNET_MODEL`. Defaults to the
 * latest Claude Sonnet model.
 *
 * WHY THE TIER EXISTS (P2-v2 S21, 2026-05-17): it draws on a different
 * Anthropic rate-limit bucket from `BEST_MODEL`, and Pass-2 synthesis was
 * cumulatively exhausting the top tier's 429s even behind the retry schedule —
 * backoff smooths a transient burst, it does not solve sustained quota
 * exhaustion on a subscription. Sonnet keeps the same prompt body, schema and
 * parser, and trades a stylistically-different result for one that arrives.
 *
 * The class alias is deliberately version-free: the CLI, rather than a source
 * edit, resolves the newest model available in this tier.
 */
export const SONNET_MODEL: string =
  process.env['NEUTRON_SONNET_MODEL'] ?? 'sonnet'

/**
 * The fast/cheap model. Override via `NEUTRON_FAST_MODEL`. Defaults to the
 * latest Claude Haiku model.
 */
export const FAST_MODEL: string =
  process.env['NEUTRON_FAST_MODEL'] ?? 'haiku'

/**
 * Probe model — alias of `FAST_MODEL`. Used by `auth/max-oauth.ts` for the
 * Anthropic Messages API auth-tier probe. Must be a model the user's Max
 * subscription always exposes; Haiku is the safest choice.
 */
export const PROBE_MODEL: string = FAST_MODEL

// ---------------------------------------------------------------------------
// Runtime BEST_MODEL override — the model-update watchdog's "real config path"
// (the legacy harness port row #16, docs/research/legacy-terminal-detection-keystroke-port-
// 2026-06-25.md).
// ---------------------------------------------------------------------------

/**
 * Process-local override for an explicitly version-pinned {@link BEST_MODEL}.
 * Version-free class defaults remain classes when the watchdog detects a new id.
 */
let runtimeBestModel: string | undefined

/**
 * The effective best model selector: a concrete watchdog override for an
 * explicitly pinned install, otherwise the env/default {@link BEST_MODEL} class.
 * Fresh persistent-REPL spawns resolve their `--model` through this accessor.
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
 * `--fallback-model` trap (the legacy harness 2026-04-16): during an Opus outage a CLI
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
