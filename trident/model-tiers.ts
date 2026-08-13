/**
 * @neutronai/trident — THE ONE MODEL-TIER REGISTRY: what a tier resolves to, who
 * provides it, and HOW the workflow reaches it.
 *
 * ── Why tiers rather than model ids ─────────────────────────────────────────
 * The owner picks a TIER (`opus`, `sol`, `k3`), never a vendor id. A tier resolves at
 * RUNTIME, so the pane survives model turnover: when a vendor retires an id, the
 * registry entry changes and every phase pinned to that tier follows it. A pane full
 * of literal ids would need an edit — and a settings screen nobody edits is a settings
 * screen that lies.
 *
 * ── Why a tier also carries a TRANSPORT ─────────────────────────────────────
 * The workflow CANNOT reach a non-Anthropic model through `agent({model})` — that
 * resolves against Claude Code's own endpoint (`trident/kimi-review-cli.ts:4-8`). A
 * GPT or Kimi model is reachable ONLY as a CLI subprocess. So "which model" is not a
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
 * A cli tier needs a credential (a Codex connection, a Kimi key). An install without
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
  'k3',
] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

/**
 * THE DELIBERATE EMPTY SEAT — not a tier, and deliberately not in {@link MODEL_TIERS}.
 *
 * A cross-model review slot set to `none` is an owner saying "run no second-family
 * reviewer here". That is a CHOICE, and it must stay distinguishable from "a reviewer
 * was configured and failed" all the way to the merge gate — the two look identical if
 * you only ask whether a verdict arrived, and collapsing them would let a run report
 * that a cross-model review happened when the panel was single-family (ISSUES #566).
 *
 * It lives here rather than as a ninth `MODEL_TIERS` entry because everything that
 * consumes a tier — `modelTier()`, the pricing lookup, the dispatch — would then have
 * to special-case a member that resolves to no model, no provider and no transport.
 * A separate sentinel makes "is this a model?" a total question again.
 */
export const NO_MODEL = 'none'

/** The credential a `cli` tier needs before it can run. `null` → nothing to set up. */
export type TierRequirement = 'codex' | 'kimi'

/**
 * The EXECUTOR a tier runs on — the partition that decides what can substitute for
 * what. Transport alone is too coarse (codex and kimi are both `cli`, and
 * `CODEX_REVIEW_MODEL=kimi-k3` is not a review, it is an error), so the group is
 * stated once here and every "can this phase take that tier" question — in the
 * validator, in the workflow, in the pane — answers from it.
 */
export const TIER_GROUPS = ['claude', 'codex', 'kimi'] as const
export type TierGroup = (typeof TIER_GROUPS)[number]

/** One tier, fully resolved. */
export interface ModelTierDescriptor {
  tier: ModelTier
  /** Who makes the model. Shown in the pane so a cross-model peer is obviously one. */
  provider: 'anthropic' | 'openai' | 'moonshot'
  group: TierGroup
  /** What the tier resolves to RIGHT NOW. Never persisted — always re-resolved. */
  model_id: string
  transport: Transport
  /** `cli` only: the REVIEW wrapper the workflow shells into, repo-relative. */
  wrapper: string | null
  /** `cli` only: the env knob that review wrapper reads to pick its model. */
  env_var: string | null
  /**
   * `cli` only: the BUILD wrapper a build/plan/fix step shells into, or null when this
   * executor has none — which is the honest answer for Kimi (ISSUES #565).
   *
   * A SECOND WRAPPER, NOT A SECOND TIER. Reviewing and building are different jobs for
   * the same subprocess executor: the review wrapper streams a diff in and a verdict
   * out, while the build wrapper hands the agent a worktree and expects a commit. The
   * MODEL is the same either way, so it stays one registry entry, and the role-specific
   * facts hang off it. A `build_wrapper` of null is what a settings row turns into
   * "this executor cannot run a build yet" — and, critically, what stops the row
   * offering the tier at all, because an option that cannot dispatch is worse than a
   * greyed one.
   */
  build_wrapper: string | null
  /** `cli` only: the env knob the BUILD wrapper reads to pick its model. */
  build_env_var: string | null
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
    build_wrapper: null,
    build_env_var: null,
    requires: null,
  },
  opus: {
    provider: 'anthropic',
    group: 'claude',
    resolve: () => getBestModel(),
    transport: 'agent',
    wrapper: null,
    env_var: null,
    build_wrapper: null,
    build_env_var: null,
    requires: null,
  },
  sonnet: {
    provider: 'anthropic',
    group: 'claude',
    resolve: () => SONNET_MODEL,
    transport: 'agent',
    wrapper: null,
    env_var: null,
    build_wrapper: null,
    build_env_var: null,
    requires: null,
  },
  fast: {
    provider: 'anthropic',
    group: 'claude',
    resolve: () => FAST_MODEL,
    transport: 'agent',
    wrapper: null,
    env_var: null,
    build_wrapper: null,
    build_env_var: null,
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
    build_wrapper: 'trident/codex-build.sh',
    build_env_var: 'CODEX_BUILD_MODEL',
    requires: 'codex',
  },
  terra: {
    provider: 'openai',
    group: 'codex',
    resolve: () => 'gpt-5.6-terra',
    transport: 'cli',
    wrapper: 'trident/codex-review.sh',
    env_var: 'CODEX_REVIEW_MODEL',
    build_wrapper: 'trident/codex-build.sh',
    build_env_var: 'CODEX_BUILD_MODEL',
    requires: 'codex',
  },
  luna: {
    provider: 'openai',
    group: 'codex',
    resolve: () => 'gpt-5.6-luna',
    transport: 'cli',
    wrapper: 'trident/codex-review.sh',
    env_var: 'CODEX_REVIEW_MODEL',
    build_wrapper: 'trident/codex-build.sh',
    build_env_var: 'CODEX_BUILD_MODEL',
    requires: 'codex',
  },
  // Kimi K3 — a reviewer from a DIFFERENT model family than Claude and GPT alike,
  // which is the entire reason the panel has it. `trident/kimi-review.ts` holds the
  // same id as its own default for a direct call; the test pins the pair.
  k3: {
    provider: 'moonshot',
    group: 'kimi',
    resolve: () => 'kimi-k3',
    transport: 'cli',
    wrapper: 'trident/kimi-review-cli.ts',
    env_var: 'KIMI_MODEL',
    // NO BUILD WRAPPER, AND THAT IS THE VERIFIED ANSWER RATHER THAN A TODO.
    // `grep -ril 'kimi\|moonshot' runtime/adapters/` returns nothing while the same
    // grep for `codex` returns the whole `runtime/adapters/codex-cli/` tree, so there
    // is no Kimi substrate to route a build through and no Kimi CLI that takes a
    // worktree. `trident/kimi-review-cli.ts` is a REVIEW client: it POSTs a diff to
    // Moonshot's messages endpoint and prints the answer. Shipping a selectable Kimi
    // build option on top of that would be a control with no dispatch behind it.
    build_wrapper: null,
    build_env_var: null,
    requires: 'kimi',
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
    build_wrapper: entry.build_wrapper,
    build_env_var: entry.build_env_var,
    requires: entry.requires,
  }
}

/** Every tier, resolved as of NOW, in pane order. */
export function modelTierRegistry(): ReadonlyArray<ModelTierDescriptor> {
  return MODEL_TIERS.map((tier) => modelTier(tier)!)
}

/**
 * Can a step whose dispatch reaches `executors` run `candidate`?
 *
 * IT USED TO TAKE THE PHASE'S DEFAULT TIER AND COMPARE GROUPS, which hard-wired every
 * row to exactly one executor — the defect the owner hit first ("The whole point is I
 * want to be able to switch build to sol"). A step's reachable executors are a property
 * of the DISPATCH that was actually built for it, not of whichever tier its default
 * happens to name, so the caller passes the set and this answers membership.
 *
 * The check is still a capability and not a preference. Handing `sol` to
 * `agent({model})` asks Claude Code's endpoint for a GPT id, and pointing the codex
 * wrapper at `k3` sets `CODEX_BUILD_MODEL=kimi-k3`; both are dispatches that CANNOT
 * work, so they are refused at the settings boundary where the owner is present to be
 * told rather than discovered as a build that ran on the wrong model.
 */
export function tierRunsOn(executors: ReadonlyArray<TierGroup>, candidate: ModelTier): boolean {
  const t = modelTier(candidate)
  if (t === null) return false
  return executors.includes(t.group)
}

/**
 * Every tier that is NOT Claude-family, in pane order.
 *
 * The cross-model review slots exist to break the panel's single-family blind spot
 * (`trident/kimi-review.ts`), so "which tiers may a cross-model slot take" is exactly
 * "which tiers are not Claude". Derived rather than listed, so adding a provider to the
 * registry offers it in both slots without a second edit.
 */
export function crossModelTiers(): ReadonlyArray<ModelTierDescriptor> {
  return modelTierRegistry().filter((t) => t.group !== 'claude')
}
