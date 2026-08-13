/**
 * @neutronai/trident — THE ONE MODEL-TIER REGISTRY: what a tier resolves to, who
 * provides it, and HOW the workflow reaches it.
 *
 * ── Why tiers rather than model ids ─────────────────────────────────────────
 * The owner picks a TIER (`opus`, `sol`), never a vendor id. A tier resolves at
 * RUNTIME, so the pane survives model turnover: when a vendor retires an id, the
 * registry entry changes and every phase pinned to that tier follows it. A pane full
 * of literal ids would need an edit — and a settings screen nobody edits is a settings
 * screen that lies.
 *
 * ── Why a tier also carries a TRANSPORT ─────────────────────────────────────
 * The workflow CANNOT reach a non-Anthropic model through `agent({model})` — that
 * resolves against Claude Code's own endpoint. A GPT model is reachable ONLY as a CLI
 * subprocess (`codex exec`). So "which model" is not a
 * complete answer: the transport is the difference between a model the workflow can
 * call and one it must shell out to, and a tier that did not carry it would let the
 * settings pane offer a choice the dispatch cannot honour.
 *
 *   • `transport: 'agent'` — an Anthropic model, dispatched as `agent({model})`.
 *   • `transport: 'cli'`   — a subprocess. The entry NAMES the wrapper the workflow
 *     shells into and the ENV KNOB that wrapper reads, because those two facts are
 *     what the dispatch needs and nothing else in the repo holds them together.
 *
 * ── ONE registry is the point ───────────────────────────────────────────────
 * Retiring a model must be a SINGLE edit here, not a hunt through a settings
 * component, a workflow router and a shell script. `codex-review.sh` keeps its own
 * `${CODEX_REVIEW_MODEL-gpt-5.6-sol}` default for a direct human invocation, and
 * `model-tiers.test.ts` asserts that default and the `sol` entry below are the SAME
 * string — a drift between them is a red test, not a surprise in a review.
 *
 * ── Availability is reported, never hidden ──────────────────────────────────
 * A cli tier needs a credential (a Codex connection). An install without
 * one still SEES the tier, disabled, with the reason — `requires` is what the surface
 * turns into "needs a Codex connection". An option that silently disappears is how a
 * missing capability stays invisible for weeks (ISSUES #551).
 */

import { FABLE_MODEL, FAST_MODEL, SONNET_MODEL, getBestModel } from '@neutronai/runtime/models.ts'

/** How the workflow reaches a model. See the header — this is not cosmetic. */
export const TRANSPORTS = ['agent', 'cli'] as const
export type Transport = (typeof TRANSPORTS)[number]

/** Every tier the owner may choose, in the order a pane should offer them. */
export const MODEL_TIERS = [
  'fable',
  'opus',
  'sonnet',
  'fast',
  'sol',
  'terra',
  'luna',
] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

/** The credential a `cli` tier needs before it can run. `null` → nothing to set up. */
export type TierRequirement = 'codex'

/**
 * The EXECUTOR a tier runs on — the partition that decides what can substitute for
 * what. Transport alone is too coarse: it says a tier is reached by a subprocess, not
 * WHICH subprocess, and a second cli executor would be indistinguishable from this
 * one. So the group is stated once here and every "can this phase take that tier"
 * question — in the validator, in the workflow, in the pane — answers from it.
 */
export const TIER_GROUPS = ['claude', 'codex'] as const
export type TierGroup = (typeof TIER_GROUPS)[number]

/** One tier, fully resolved. */
export interface ModelTierDescriptor {
  tier: ModelTier
  /** Who makes the model. Shown in the pane so a cross-model peer is obviously one. */
  provider: 'anthropic' | 'openai'
  group: TierGroup
  /** What the tier resolves to RIGHT NOW. Never persisted — always re-resolved. */
  model_id: string
  transport: Transport
  /**
   * `cli` only: the CROSS-MODEL REVIEW wrapper this tier is reached through,
   * repo-relative.
   *
   * SCOPED TO THE REVIEW LANE ON PURPOSE. A tier is not owned by one script: the codex
   * tiers are also reachable from the BUILD phase, which shells into
   * `trident/codex-build.sh` with its own knob (`CODEX_BUILD_MODEL`). So this pair
   * answers "how does the review panel reach this tier", and anything that must speak
   * about a tier phase-independently — an owner-facing message, a greying rule — uses
   * {@link ModelTierDescriptor.group} instead.
   */
  wrapper: string | null
  /** `cli` only: the env knob that REVIEW wrapper reads to pick its model. */
  env_var: string | null
  /** `cli` only: the credential this tier needs. */
  requires: TierRequirement | null
}

/**
 * The registry, as resolvers.
 *
 * The Anthropic ids come from `runtime/models.ts` — the single source of truth for
 * every Claude id in Neutron — and are read through FUNCTIONS rather than captured at
 * module load, so the model-update watchdog's adopted id (`getBestModel()`) reaches a
 * pane rendered later in the same process. A frozen literal here would show the owner
 * the model this process booted with rather than the one their next build will use.
 */
const RESOLVERS: Readonly<
  Record<ModelTier, Omit<ModelTierDescriptor, 'tier' | 'model_id'> & { resolve: () => string }>
> = Object.freeze({
  fable: {
    provider: 'anthropic',
    group: 'claude',
    resolve: () => FABLE_MODEL,
    transport: 'agent',
    wrapper: null,
    env_var: null,
    requires: null,
  },
  opus: {
    provider: 'anthropic',
    group: 'claude',
    resolve: () => getBestModel(),
    transport: 'agent',
    wrapper: null,
    env_var: null,
    requires: null,
  },
  sonnet: {
    provider: 'anthropic',
    group: 'claude',
    resolve: () => SONNET_MODEL,
    transport: 'agent',
    wrapper: null,
    env_var: null,
    requires: null,
  },
  fast: {
    provider: 'anthropic',
    group: 'claude',
    resolve: () => FAST_MODEL,
    transport: 'agent',
    wrapper: null,
    env_var: null,
    requires: null,
  },
  // ── The GPT 5.6 family, reached through the Codex CLI ─────────────────────
  // `sol` is the flagship tier and the standing default for the codex panelist:
  // unpinned, `codex exec` takes the CLI's own default, which OpenAI moved to the
  // cheapest 5.6 tier — so the "independent GPT-5 second opinion" was quietly being
  // served by the weakest model available. The pin lives in the wrapper too, for a
  // direct human invocation; the test pins the two together.
  sol: {
    provider: 'openai',
    group: 'codex',
    resolve: () => 'gpt-5.6-sol',
    transport: 'cli',
    wrapper: 'trident/codex-review.sh',
    env_var: 'CODEX_REVIEW_MODEL',
    requires: 'codex',
  },
  terra: {
    provider: 'openai',
    group: 'codex',
    resolve: () => 'gpt-5.6-terra',
    transport: 'cli',
    wrapper: 'trident/codex-review.sh',
    env_var: 'CODEX_REVIEW_MODEL',
    requires: 'codex',
  },
  luna: {
    provider: 'openai',
    group: 'codex',
    resolve: () => 'gpt-5.6-luna',
    transport: 'cli',
    wrapper: 'trident/codex-review.sh',
    env_var: 'CODEX_REVIEW_MODEL',
    requires: 'codex',
  },
})

/** True iff `value` names a tier in the registry. */
export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as ReadonlyArray<string>).includes(value)
}

/** One tier, resolved as of NOW, or null when the tier is unknown/retired. */
export function modelTier(tier: string): ModelTierDescriptor | null {
  if (!isModelTier(tier)) return null
  const entry = RESOLVERS[tier]
  return {
    tier,
    provider: entry.provider,
    group: entry.group,
    model_id: entry.resolve(),
    transport: entry.transport,
    wrapper: entry.wrapper,
    env_var: entry.env_var,
    requires: entry.requires,
  }
}

/** Every tier, resolved as of NOW, in pane order. */
export function modelTierRegistry(): ReadonlyArray<ModelTierDescriptor> {
  return MODEL_TIERS.map((tier) => modelTier(tier)!)
}
