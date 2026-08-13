/**
 * @neutronai/runtime — central model-pricing registry.
 *
 * Single source of truth for Anthropic per-million-token list prices used to
 * estimate `dollars_billed` from a substrate completion's `TokenUsage`.
 *
 * **Rule:** never hardcode `$X / MTok` numbers outside this file. Code that
 * needs to bill against a model id MUST call `resolveModelPricing(model_id)`
 * — the registry is the only place where pricing constants live.
 *
 * History:
 *   - Pre-S23 the constants lived inline in
 *     `onboarding/history-import/substrate-callers.ts` as four `const
 *     <MODEL>_INPUT_USD_PER_M = X` lines. That shape had two related bugs:
 *       1. The Pass-2 Sonnet fallback resolved `pricing` once before the
 *          model switch, so a Sonnet completion was billed at Opus's table.
 *          Fixed in S21 R2 by adding a second `fallback_pricing` constant.
 *       2. The fallback pricing was itself hard-coded to Sonnet 4.6 rates,
 *          so a `NEUTRON_SONNET_MODEL` env override (e.g. piloting Sonnet
 *          4.7) would silently bill at the wrong rate. S21 R2 left that as
 *          a P2 follow-up — closed here by deriving pricing from the
 *          fallback model id, NOT from a separate constant.
 *       3. Codex GPT-5 also flagged Haiku 4.5 pricing as unverified (S22
 *          fixed Opus 4.7 from the legacy $15/$75 to the verified $5/$25,
 *          but Haiku 4.5 was left at $0.8/$4.0 — those are Haiku 3.5
 *          rates, not Haiku 4.5). Closed here.
 *
 * Pricing verified 2026-05-17 from
 * https://docs.claude.com/en/docs/about-claude/pricing (the page redirects
 * to platform.claude.com). Snapshot from the "Model pricing" table:
 *
 *   | Model              | Base Input | Output |
 *   |--------------------|-----------:|-------:|
 *   | Claude Opus 4.7    | $5  / MTok | $25   |
 *   | Claude Sonnet 4.6  | $3  / MTok | $15   |
 *   | Claude Haiku 4.5   | $1  / MTok | $5    |
 *
 * Cache columns intentionally omitted — Pass-1 chunks are unique (no cache
 * hits) and the Pass-2 aggregated summary is per-import. The simple
 * input+output model under-estimates only when the owner reruns the same
 * import (Pass-1 dedup short-circuits at $0 anyway).
 */

/** A single registry entry — one row per canonical Anthropic model id. */
export interface ModelPricingEntry {
  /** US dollars per 1,000,000 input tokens (base, not cached). */
  readonly input_usd_per_m: number
  /** US dollars per 1,000,000 output tokens. */
  readonly output_usd_per_m: number
  /** ISO-8601 date the row was last verified against docs.claude.com. */
  readonly verified_at: string
  /** The doc URL used for verification. */
  readonly source_url: string
}

const PRICING_SOURCE_URL = 'https://docs.claude.com/en/docs/about-claude/pricing'
const PRICING_VERIFIED_AT = '2026-05-17'

/** Opus 5 rates, read off Anthropic's launch post on the date below. */
const OPUS_5_PRICING_SOURCE_URL = 'https://www.anthropic.com/news/claude-opus-5'
const OPUS_5_PRICING_VERIFIED_AT = '2026-08-03'

const SONNET_5_PRICING_SOURCE_URL = 'https://platform.claude.com/docs/en/about-claude/models/overview'
const SONNET_5_PRICING_VERIFIED_AT = '2026-08-13'

const FABLE_5_PRICING_SOURCE_URL = 'https://platform.claude.com/docs/en/about-claude/models/overview'
const FABLE_5_PRICING_VERIFIED_AT = '2026-08-13'

/**
 * The pricing registry. Keys are canonical Anthropic model ids. The
 * date-suffixed snapshot id (e.g. `claude-haiku-4-5-20251001`) is registered
 * alongside its un-suffixed alias because both forms appear in production:
 * `runtime/models.ts:FAST_MODEL` defaults to the date-suffixed form while
 * `BEST_MODEL` and `SONNET_MODEL` default to the un-suffixed alias.
 *
 * When Anthropic publishes a new snapshot, add the new key here with the
 * same numbers as the alias entry. Pricing only diverges across model
 * generations (Opus 4.x vs 4.1, Haiku 3.5 vs 4.5), not across snapshots
 * within a generation.
 *
 * **Deep-freeze.** The outer `Object.freeze` blocks key replacement on the
 * table itself; each row is ALSO wrapped in `Object.freeze` so a caller that
 * retains a returned `ModelPricingEntry` reference cannot mutate its fields
 * (e.g. `entry.input_usd_per_m = 999`) and poison the registry process-wide.
 * The row type is `Readonly<ModelPricingEntry>` to express that contract at
 * the type level too. Codex GPT-5 flagged the shallow freeze as a P3
 * follow-up on S23 R1 — closed here.
 */
export const MODEL_PRICING_TABLE: Readonly<
  Record<string, Readonly<ModelPricingEntry>>
> = Object.freeze({
  // The current `runtime/models.ts:BEST_MODEL` default. Opus is priced
  // identically across the 4.x generation ($5 in / $25 out per MTok), so this
  // matches the 4-7 row; it MUST exist because `resolvePricingFor(getBestModel())`
  // is called at import-job build time and throws on an unregistered id.
  // The current `runtime/models.ts:BEST_MODEL` default. Opus stays $5 in / $25
  // out across the generation boundary, so this matches the 4.x rows — verified
  // against Anthropic's own Opus 5 announcement rather than assumed from the
  // pattern, because this table carries a `verified_at` and a guess in a field
  // named "verified" is worse than a missing row.
  'claude-opus-5': Object.freeze({
    input_usd_per_m: 5,
    output_usd_per_m: 25,
    verified_at: OPUS_5_PRICING_VERIFIED_AT,
    source_url: OPUS_5_PRICING_SOURCE_URL,
  }),
  // Retained: the BEST_MODEL default before the 2026-08-03 Opus 5 bump, and
  // still the id on any install pinning `NEUTRON_BEST_MODEL`.
  'claude-opus-4-8': Object.freeze({
    input_usd_per_m: 5,
    output_usd_per_m: 25,
    verified_at: PRICING_VERIFIED_AT,
    source_url: PRICING_SOURCE_URL,
  }),
  // Retained for historical billing + the snapshot-fallback contract; was the
  // BEST_MODEL default before the 2026-06-30 always-latest bump.
  'claude-opus-4-7': Object.freeze({
    input_usd_per_m: 5,
    output_usd_per_m: 25,
    verified_at: PRICING_VERIFIED_AT,
    source_url: PRICING_SOURCE_URL,
  }),
  // ── A PRE-EXISTING GAP, FOUND BY THE #564 CHECK RATHER THAN BY A DISPATCH ──
  // `runtime/models.ts:FABLE_MODEL` has been the orchestrator tier since 2026-07-02
  // (it routes `plan:fable` and `argus:synthesis` on every trident run) and it has
  // never had a row here. `resolveModelPricing` THROWS on an unregistered id rather
  // than defaulting — which is the right behaviour and why this was not a silent
  // mis-bill — but it means every attempt to price a Fable completion has been an
  // exception at the call site. The new tier-default walk
  // (`runtime/__tests__/tier-default-staleness.test.ts`) asserts that every tier
  // constant can be priced, which is what surfaced it; the fix is one row.
  //
  // Fable-tier pricing EXCEEDS Opus-tier and is not derivable from it, so it is read
  // from the models overview rather than patterned off the neighbouring rows.
  'claude-fable-5': Object.freeze({
    input_usd_per_m: 10,
    output_usd_per_m: 50,
    verified_at: FABLE_5_PRICING_VERIFIED_AT,
    source_url: FABLE_5_PRICING_SOURCE_URL,
  }),
  // The current `runtime/models.ts:SONNET_MODEL` default (ISSUES #564). LIST price,
  // read from the models-overview table rather than inferred from the 4.6 row it
  // replaces — the pattern would have given the right answer here and the wrong one
  // across a generation boundary, and a guess in a field named `verified_at` is worse
  // than a missing row (see `resolveModelPricing`, which throws rather than defaulting).
  //
  // ⚠️ AN INTRODUCTORY DISCOUNT IS IN EFFECT AND IS DELIBERATELY NOT ENCODED HERE.
  // Sonnet 5 is $2/$10 per MTok through 2026-08-31, reverting to the $3/$15 below. This
  // table has no notion of a time-varying rate, and inventing one for a two-week window
  // would put a date comparison in the billing path of every model. The consequence is
  // stated rather than hidden: until 2026-08-31 this row OVER-estimates Sonnet 5 spend
  // by a third. Over-estimating is the safe direction for a spend dashboard — it cannot
  // talk an owner into a call he could not afford — and the row becomes exactly correct
  // when the window closes. If a time-varying rate is ever wanted, it belongs in the
  // entry shape, not in a second table.
  'claude-sonnet-5': Object.freeze({
    input_usd_per_m: 3,
    output_usd_per_m: 15,
    verified_at: SONNET_5_PRICING_VERIFIED_AT,
    source_url: SONNET_5_PRICING_SOURCE_URL,
  }),
  // Retained: the SONNET_MODEL default before the 2026-08-13 Sonnet 5 bump, and still
  // the id on any install pinning `NEUTRON_SONNET_MODEL`.
  'claude-sonnet-4-6': Object.freeze({
    input_usd_per_m: 3,
    output_usd_per_m: 15,
    verified_at: PRICING_VERIFIED_AT,
    source_url: PRICING_SOURCE_URL,
  }),
  'claude-haiku-4-5': Object.freeze({
    input_usd_per_m: 1,
    output_usd_per_m: 5,
    verified_at: PRICING_VERIFIED_AT,
    source_url: PRICING_SOURCE_URL,
  }),
  // The current production snapshot id used by `runtime/models.ts:FAST_MODEL`.
  // Same numbers as the alias — Anthropic prices a model generation
  // identically across snapshots.
  'claude-haiku-4-5-20251001': Object.freeze({
    input_usd_per_m: 1,
    output_usd_per_m: 5,
    verified_at: PRICING_VERIFIED_AT,
    source_url: PRICING_SOURCE_URL,
  }),
})

/**
 * Resolve a `ModelPricingEntry` for a model id. Throws when no pricing row
 * can be resolved — silently billing at a default rate is the failure mode
 * that gave us the pre-S23 incidents.
 *
 * Lookup order:
 *   1. Exact match against `MODEL_PRICING_TABLE`.
 *   2. Snapshot fallback: if the id matches `<alias>-YYYYMMDD` (Anthropic's
 *      dated-snapshot convention) AND `<alias>` IS registered, use the alias
 *      row. This lets operators set `NEUTRON_BEST_MODEL=claude-opus-4-7-20260101`
 *      without code changes — Anthropic prices a generation identically
 *      across snapshots (the same reason `claude-haiku-4-5` and
 *      `claude-haiku-4-5-20251001` carry identical numbers in the table
 *      above), so the alias row is the correct billing rate.
 *   3. Throws — with the bad id, the known alternatives, and the
 *      docs.claude.com URL so the operator can self-diagnose.
 *
 * The throw covers two real failure modes:
 *   - operator typo (`claude-sonnet-typo`) — the bad id surfaces immediately
 *     at composer construction instead of silently billing at the wrong rate
 *     on the first dispatch.
 *   - cross-generation rollout (`claude-opus-5-0`) — Anthropic generations
 *     have different pricing tables (Opus 4.7 = $5/$25, Opus 4.1 = $15/$75),
 *     so a new alias MUST be added to `MODEL_PRICING_TABLE` with a verified
 *     row before pilot dispatches. Loud-fail beats silent-mis-bill.
 */
export function resolveModelPricing(model_id: string): ModelPricingEntry {
  const exact = MODEL_PRICING_TABLE[model_id]
  if (exact !== undefined) return exact

  // Snapshot fallback. Anthropic snapshot ids end with `-YYYYMMDD` (8
  // digits, optionally preceded by other suffix segments). Strip the
  // trailing date and look up the alias. Only fires when the alias IS
  // registered — a fully unknown id still throws.
  const snapshotMatch = model_id.match(/^(.+)-\d{8}$/)
  if (snapshotMatch !== null && typeof snapshotMatch[1] === 'string') {
    const alias = snapshotMatch[1]
    const aliasEntry = MODEL_PRICING_TABLE[alias]
    if (aliasEntry !== undefined) return aliasEntry
  }

  const known = Object.keys(MODEL_PRICING_TABLE).join(', ')
  throw new Error(
    `[runtime/model-pricing] no pricing registered for model "${model_id}"; ` +
      `known models: ${known}. ` +
      `Add a row to MODEL_PRICING_TABLE in runtime/model-pricing.ts (verified ` +
      `against ${PRICING_SOURCE_URL}) before dispatching against this model.`,
  )
}
