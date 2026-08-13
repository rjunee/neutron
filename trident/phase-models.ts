/**
 * @neutronai/trident — WHICH MODEL RUNS WHICH PHASE, as owner-editable configuration.
 *
 * WHAT THIS REPLACES. The routing table lived only inside `inner-workflow.mjs` as a
 * hardcoded `label → {model, effort}` map. It was a good table, but it was reachable
 * only by editing the workflow script — so the owner could not put the build on a
 * different model, or raise one phase's reasoning effort, without a code change. The
 * model TIER ids were already threaded in as a workflow argument, which proved the
 * seam; this extends that same seam to carry the per-phase assignment too.
 *
 * ── Why a PHASE vocabulary rather than the raw agent labels ──────────────────
 * The workflow's labels are internal and some are dynamic — `forge:fix-round-3`,
 * `checkpoint:argus-approved`, `head-probe-round-2`. Exposing them as settings keys
 * would make the configuration surface change shape whenever the workflow's internals
 * did, and would ask the owner to know that "the thing that reviews adversarially" is
 * spelled `argus:adversarial`. So the settings vocabulary is a small, STABLE set of
 * named phases, and the label → phase mapping lives here next to it.
 *
 * ── The mapping is the part that rots, so a test WALKS it ────────────────────
 * A phase that covers no labels is dead configuration: the owner sets it, nothing
 * changes, and the feature looks broken. A label covered by no phase silently keeps
 * whatever default it fell into — which is not hypothetical. `head-probe-round-N`
 * (a step whose entire job is to run one `git` command and report the sha it printed)
 * had escaped the routing table and was therefore resolving to the DEFAULT, which is
 * the most expensive tier at high effort. It had been that way since the step was
 * introduced, and nothing could have noticed, because a missing entry and a
 * deliberate entry are indistinguishable when the fallback is silent.
 *
 * `__tests__/phase-model-coverage.test.ts` now walks every `label:` literal in the
 * workflow source and requires each one to be either claimed by a phase or listed in
 * {@link UNROUTED_LABELS} with a reason. That is the check that turns "we think the
 * table is complete" into "the table is complete or CI is red".
 *
 * ── Validation fails LOUD here, and degrades quietly in the workflow ─────────
 * These two need opposite behaviour and the split is deliberate:
 *
 *   • AT THE SETTINGS BOUNDARY (this module, called from the write path) an unknown
 *     phase key or a bogus effort is an ERROR the owner sees. Silently dropping it is
 *     the worst outcome available — they would set `xhigh`, observe no change, and
 *     reasonably conclude the whole feature is broken.
 *   • INSIDE THE WORKFLOW a bad entry must never abort a build that is otherwise
 *     fine, so the workflow logs it loudly and uses the default. The run continues;
 *     the log says exactly what was ignored.
 *
 * ── A TIER, and only a tier ──────────────────────────────────────────────────
 * `model` must name a tier in {@link modelTierRegistry}. It used to also accept a
 * literal vendor id as an escape hatch, and that hatch is now CLOSED, because the
 * registry made it unsafe rather than merely redundant: a tier carries a TRANSPORT,
 * and a bare id does not. `gpt-5.6-terra` typed into the old text field looked like a
 * pin and was really a Claude-endpoint lookup for a model that is only reachable as a
 * subprocess — a build that quietly ran on the wrong model. A tier cannot be
 * ambiguous that way, and adding one is a single edit in `model-tiers.ts`, which is
 * what the hatch existed to avoid.
 *
 * A stored value that is NOT a tier (an older build's literal pin, or a tier since
 * retired) is therefore invalid — and it degrades VISIBLY: it is rejected here, the
 * phase falls back to its default, and {@link ParsedPhaseModelConfig.rejected} carries
 * the offending value so the pane can show it struck through and say so.
 *
 * ── TRANSPORT IS A CAPABILITY, so a phase cannot take just any tier ──────────
 * Every phase here dispatches through ONE executor. `agent({model})` resolves against
 * Claude Code's own endpoint, so a GPT/Kimi tier cannot run a Claude phase; the codex
 * wrapper reads `CODEX_REVIEW_MODEL`, so a Kimi tier cannot run it either. Moving a
 * phase across transports is refused HERE, where the owner is present to read why,
 * rather than being discovered as a run that used the wrong model.
 */

import {
  MODEL_TIERS,
  NO_MODEL,
  type ModelTier,
  type TierGroup,
  type Transport,
  isModelTier,
  modelTier,
  tierRunsOn,
} from './model-tiers.ts'

export { MODEL_TIERS, NO_MODEL, isModelTier }
export type { ModelTier }

/**
 * Reasoning-effort levels, lowest to highest.
 *
 * Ordered rather than a bare set so a UI can render a slider and a test can assert
 * that a phase's default is not above what the owner chose.
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

/** One phase's owner-facing definition. */
export interface TridentPhase {
  /** Stable settings key. Never renamed — it is persisted in owner config. */
  key: string
  /** What the owner sees. */
  label: string
  /** One line on what this phase does, for the settings row's subtitle. */
  description: string
  /**
   * The workflow agent labels this phase governs.
   *
   * `dynamic: true` entries are PREFIXES (`forge:fix-round-` matches
   * `forge:fix-round-3`), because those labels carry a round number.
   */
  labels: ReadonlyArray<{ label: string; dynamic?: boolean }>
  /** The tier + effort used when the owner has set no override. */
  default: { tier: ModelTier; effort: Effort }
  /**
   * THE EXECUTOR GROUPS THIS STEP'S DISPATCH CAN ACTUALLY REACH — the list is a claim
   * about wiring that exists, not about wiring that would be nice.
   *
   * This replaces deriving the answer from `default.tier`'s group, which was the bug:
   * it locked every row to one executor forever, so a build could never be moved to
   * Codex even after the route was built (ISSUES #565). It is also the reason this is a
   * LIST rather than a second tier field — `build` genuinely dispatches two ways now,
   * and a settings row has to be able to say so.
   *
   * THE RULE FOR EDITING IT: add a group here ONLY once a test asserts the production
   * composer routes this step's label to that executor. A selectable option that does
   * not dispatch is worse than a greyed one, because the owner believes the run used
   * the model they picked.
   */
  executors: ReadonlyArray<TierGroup>
  /**
   * True for the cross-model REVIEW SLOTS, which accept `none` as well as a tier.
   *
   * Only these rows may be emptied. Emptying `build` would mean a run with no builder;
   * emptying a Claude reviewer would silently shrink the merge gate. Emptying a
   * cross-model slot is a knowing opt-out of a second model family, and the pane says
   * so rather than implying a diverse panel (ISSUES #566).
   */
  cross_model_slot?: boolean
}

/**
 * THE PHASES, in the order a run executes them.
 *
 * Execution order rather than alphabetical, because the settings pane reads as an
 * explanation of the pipeline as much as a set of controls — an owner scanning it
 * should be able to see what a build actually does.
 */
export const TRIDENT_PHASES: ReadonlyArray<TridentPhase> = Object.freeze([
  {
    key: 'decomposition',
    label: 'Decomposition',
    description: 'Reads the task and the spec, then breaks the work into ordered steps.',
    labels: [{ label: 'plan:fable' }],
    default: { tier: 'fable', effort: 'max' },
    // Claude-only, and honestly so: the planner returns PLAN_SCHEMA (a regenerated plan
    // body, one top task, an execution spec, a complexity tag) through the workflow's
    // own structured-output contract. The codex build wrapper returns a transcript, not
    // a schema, so there is no route to assert against yet.
    executors: ['claude'],
  },
  {
    key: 'build',
    label: 'Build',
    description: 'Writes the code and the tests, and re-writes them against review findings.',
    labels: [{ label: 'forge:build' }, { label: 'forge:fix-round-', dynamic: true }],
    default: { tier: 'opus', effort: 'high' },
    // WIRED, NOT ASPIRATIONAL. `trident/inner-workflow.mjs` routes `forge:build` and
    // every `forge:fix-round-*` through `trident/codex-build.sh` when this phase
    // resolves to a codex tier, and `__tests__/codex-build-dispatch.test.ts` runs the
    // shipped workflow body and asserts the bridge command it actually emits.
    executors: ['claude', 'codex'],
  },
  {
    key: 'build_mechanical',
    label: 'Build (mechanical tasks)',
    description:
      'The same build step when the planner tags the work boilerplate — a single-file edit, a test, a rename.',
    // Deliberately the SAME labels as `build`. The two are distinguished at
    // resolution time by the planner's complexity tag, not by the label, which is
    // why `phaseForLabel` returns `build` for both and the tag decides.
    labels: [{ label: 'forge:build' }, { label: 'forge:fix-round-', dynamic: true }],
    default: { tier: 'sonnet', effort: 'medium' },
    executors: ['claude', 'codex'],
  },
  {
    key: 'review_rubric',
    label: 'Rubric review',
    description: 'Reviews the diff against the fixed criteria — correctness, security, test quality.',
    labels: [{ label: 'argus:claude' }],
    default: { tier: 'opus', effort: 'high' },
    executors: ['claude'],
  },
  {
    key: 'review_adversarial',
    label: 'Adversarial review',
    description: 'Independently tries to REFUTE the change rather than to approve it.',
    labels: [{ label: 'argus:adversarial' }],
    default: { tier: 'opus', effort: 'high' },
    executors: ['claude'],
  },
  {
    // ── THE TWO CROSS-MODEL SEATS ARE SLOTS, NOT VENDORS ──────────────────────
    // They were `review_codex` and `review_kimi`, which named the occupant in the
    // settings key, the label and the description — so "point this seat at a different
    // model" had no expressible form and the owner asked, reasonably, how he was
    // supposed to change it (ISSUES #566). The seat is now a POSITION on the panel;
    // which model sits in it is the setting. The stable keys below are the ones a
    // migration maps the old two onto — see `migratePhaseModelConfig`.
    key: 'review_cross_1',
    label: 'Cross-model review ONE',
    description:
      'A second opinion from OUTSIDE the Claude family, so the panel is not one model marking its own homework. Any non-Claude tier, or NONE to turn this seat off.',
    labels: [{ label: 'argus:cross-1' }, { label: 'argus:cross-1-retry' }],
    // `sol` is the flagship GPT 5.6 tier and matches the codex wrapper's own standing
    // pin, so an install that never opens the pane dispatches exactly what it
    // dispatched when this seat was called "Codex". The effort below is INERT — a CLI
    // chooses its own reasoning effort, and no dispatch reads it (`phaseSupportsEffort`).
    default: { tier: 'sol', effort: 'high' },
    executors: ['codex', 'kimi'],
    cross_model_slot: true,
  },
  {
    key: 'review_cross_2',
    label: 'Cross-model review TWO',
    description:
      'A THIRD model family alongside the first slot — its disagreements are the signal, because it does not share the others\u2019 blind spots. Any non-Claude tier, or NONE.',
    labels: [{ label: 'argus:cross-2' }, { label: 'argus:cross-2-retry' }],
    default: { tier: 'k3', effort: 'high' },
    executors: ['codex', 'kimi'],
    cross_model_slot: true,
  },
  {
    key: 'synthesis',
    label: 'Synthesis / arbitration',
    description: 'Merges every reviewer\u2019s verdict into one, and decides what blocks a merge.',
    labels: [{ label: 'argus:synthesis' }],
    default: { tier: 'fable', effort: 'high' },
    executors: ['claude'],
  },
  {
    key: 'bookkeeping',
    label: 'Bookkeeping',
    description:
      'The mechanical steps — checkpoints, reading a branch sha, checking CI, writing the result, cleaning up the worktree.',
    labels: [
      { label: 'checkpoint:', dynamic: true },
      { label: 'terminal-result' },
      { label: 'cleanup:worktree' },
      { label: 'head-probe-round-', dynamic: true },
      { label: 'ci-probe-round-', dynamic: true },
    ],
    default: { tier: 'fast', effort: 'low' },
    executors: ['claude'],
  },
])

/**
 * Agent labels that are deliberately NOT model-configurable, with the reason.
 *
 * CURRENTLY EMPTY, and that is a state to keep rather than a list to delete. The four
 * cross-model lanes (`argus:codex`, `argus:kimi` and their retries) lived here on the
 * grounds that "the reviewing model is the CLI's own configuration" — true only for as
 * long as nothing threaded a model INTO the CLI. Both wrappers already read an env
 * knob (`CODEX_REVIEW_MODEL`, `KIMI_MODEL`), so the lanes are now routed by the
 * `review_codex` / `review_kimi` phases and were removed from this list deliberately.
 *
 * The list itself stays because its JOB is unchanged: the coverage test requires every
 * workflow label to be either claimed by a phase or listed here WITH A REASON, so a
 * new lane forces a decision instead of silently falling through to the default.
 */
export const UNROUTED_LABELS: ReadonlyArray<{ label: string; dynamic?: boolean; why: string }> =
  Object.freeze([])

/** An owner's override for one phase. Either field may be set alone. */
export interface PhaseModelOverride {
  /** A {@link ModelTier} name. A literal vendor id is NOT accepted — see the header. */
  model?: string
  effort?: Effort
}

/** phase key → override. Absent keys keep the phase's default. */
export type PhaseModelConfig = Readonly<Record<string, PhaseModelOverride>>

/** Result of validating owner-supplied configuration. */
export interface ParsedPhaseModelConfig {
  /** Only the entries that validated. Safe to thread into a run. */
  config: PhaseModelConfig
  /**
   * One human-readable message per rejected entry. NON-EMPTY MEANS THE WRITE
   * SHOULD FAIL — a partially-applied model config is how an owner ends up
   * believing a phase is pinned when it is not.
   */
  errors: ReadonlyArray<string>
  /**
   * The REJECTED values, per known phase, so a pane can show what was dropped.
   *
   * A stored override naming a retired tier must not just vanish into the default:
   * the owner chose something, and a control that silently reverts is one they cannot
   * trust again. The read path keeps this alongside the surviving config so the row
   * can render the dead value struck through and name the fallback it is using.
   * Unknown PHASE keys are absent here — there is no row to render them on.
   */
  rejected: PhaseModelConfig
}

/**
 * The transport a phase dispatches through, derived from its default tier.
 *
 * Derived, never restated: the phase table names a tier and the registry owns what a
 * tier is, so the two cannot drift into disagreeing about whether a phase is a Claude
 * agent or a subprocess.
 */
export function phaseTransport(phase: TridentPhase): Transport {
  return modelTier(phase.default.tier)?.transport ?? 'agent'
}

/**
 * The EXECUTOR GROUPS a phase can dispatch on.
 *
 * The one question a settings row needs answered: which tiers may this row offer,
 * because those are the only ones its dispatch can reach. It used to be DERIVED from
 * the phase's default tier — one group, forever — which is why the build row could
 * never be moved off Claude even after the codex route existed. It is now DECLARED on
 * the phase, next to a comment stating the test that proves each entry.
 *
 * A phase declaring nothing falls back to its default tier's group, so a new phase that
 * forgets the field is locked down rather than opened up.
 */
export function phaseExecutors(phase: TridentPhase): ReadonlyArray<TierGroup> {
  if (phase.executors.length > 0) return phase.executors
  return [modelTier(phase.default.tier)?.group ?? 'claude']
}

/**
 * Can this phase run this tier — capability, credential aside?
 *
 * A BUILD ROW ALSO NEEDS THE EXECUTOR TO HAVE A BUILD WRAPPER. Being in the right
 * group is necessary and not sufficient: `k3` is a non-Claude tier and the cross-model
 * slots take it, but nothing in the repo can hand Kimi a worktree, so a build row must
 * refuse it. Reading `build_wrapper` off the registry is what keeps that answer true
 * without a second list to forget to update.
 */
export function phaseAcceptsTier(phase: TridentPhase, tier: ModelTier): boolean {
  if (!tierRunsOn(phaseExecutors(phase), tier)) return false
  const descriptor = modelTier(tier)
  if (descriptor === null) return false
  if (descriptor.transport !== 'cli') return true
  // A cli tier on a cross-model REVIEW slot uses `wrapper`; on any other phase the
  // dispatch is a build, which needs `build_wrapper`.
  return phase.cross_model_slot === true
    ? descriptor.wrapper !== null
    : descriptor.build_wrapper !== null
}

/**
 * Why `tier` is refused on `phase`, or null when it is accepted.
 *
 * ONE SENTENCE, AND IT HAS TO BE TRUE. The string the owner reads is the whole product
 * here: `Codex steps only` named a category he had never heard of and explained
 * nothing, and `Codex is not wired for this step yet` becomes a LIE the moment the step
 * is wired. So the reason is computed from the same registry facts the dispatch reads,
 * and it disappears by construction for a combination that now works.
 */
export function tierRefusalReason(phase: TridentPhase, tier: ModelTier): string | null {
  if (phaseAcceptsTier(phase, tier)) return null
  const descriptor = modelTier(tier)
  if (descriptor === null) return `'${tier}' is not a model tier`
  const executors = phaseExecutors(phase)
  if (!executors.includes(descriptor.group)) {
    // NAMES THE TIER, not just the executors. The same sentence is both the greyed
    // option's tooltip (where the tier is already on screen) and the rejected-save
    // error (where it is the only clue which of eight rows was wrong), and the error
    // is the one that has to stand alone.
    return `'${tier}' (${descriptor.model_id}) runs on ${descriptor.group}, and ${phase.label} runs on ${executors.join(' or ')} — it cannot dispatch a ${descriptor.group} model`
  }
  return `'${tier}' runs on ${descriptor.group}, which has no build wrapper in this repo — it can review, but it cannot run ${phase.label}`
}

/**
 * Does the effort control mean anything for this phase?
 *
 * Only for `agent` transport. A `cli` lane's reasoning effort is the CLI's own
 * setting, which the wrapper does not expose — so the pane renders that cell disabled
 * with the reason instead of offering a dropdown that changes nothing. (A phase's
 * stored `default.effort` is inert for those rows and never reaches a dispatch.)
 */
export function phaseSupportsEffort(phase: TridentPhase): boolean {
  return phaseTransport(phase) === 'agent'
}

const PHASE_KEYS: ReadonlySet<string> = new Set(TRIDENT_PHASES.map((p) => p.key))

/** True iff `key` names a real phase. Exported for the settings surface. */
export function isPhaseKey(key: string): boolean {
  return PHASE_KEYS.has(key)
}

/** True iff `value` is one of the {@link EFFORTS}. */
export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as ReadonlyArray<string>).includes(value)
}

/** Look up a phase by key, or null. */
export function phaseByKey(key: string): TridentPhase | null {
  return TRIDENT_PHASES.find((p) => p.key === key) ?? null
}

/**
 * Which phase governs a workflow agent label, or null when none does.
 *
 * `build` wins over `build_mechanical` for the shared `forge:*` labels: the two are
 * separated by the planner's complexity tag at resolution time, and this function is
 * label-only. The workflow consults the tag itself.
 */
export function phaseForLabel(label: string): TridentPhase | null {
  for (const phase of TRIDENT_PHASES) {
    if (phase.key === 'build_mechanical') continue
    for (const entry of phase.labels) {
      if (entry.dynamic === true ? label.startsWith(entry.label) : label === entry.label) {
        return phase
      }
    }
  }
  return null
}

/** True iff `label` is deliberately excluded from model configuration. */
export function isUnroutedLabel(label: string): boolean {
  return UNROUTED_LABELS.some((e) =>
    e.dynamic === true ? label.startsWith(e.label) : label === e.label,
  )
}

/**
 * The maximum length accepted for a model value.
 *
 * Every accepted value is now a registry tier, so the length cap and the
 * control-character check below are no longer the whole gate — they are the FIRST
 * gate, and they still matter: they keep a hostile or corrupt stored value from being
 * echoed back into an error message (and from there into a log) at arbitrary length.
 */
const MODEL_ID_MAX = 128

/**
 * Validate owner-supplied phase configuration.
 *
 * Rejects, with a message naming the offending key: an unknown phase, a non-object
 * entry, an unknown field, a model that is not a registry TIER, a tier whose transport
 * the phase cannot dispatch, an effort on a phase that has no effort control, and an
 * effort outside {@link EFFORTS}. An entry that validates but sets nothing is dropped
 * rather than stored, so `{}` never reads as "configured".
 */
export function parsePhaseModelConfig(raw: unknown): ParsedPhaseModelConfig {
  const errors: string[] = []
  const config: Record<string, PhaseModelOverride> = {}
  // What was thrown away, per phase, so the pane can show it struck through rather
  // than silently reverting a choice the owner made.
  const rejected: Record<string, PhaseModelOverride> = {}
  const reject = (key: string, patch: PhaseModelOverride): void => {
    rejected[key] = { ...rejected[key], ...patch }
  }

  if (raw === null || raw === undefined) return { config: {}, errors: [], rejected: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      config: {},
      errors: ['phase model config must be an object of phase → { model, effort }'],
      rejected: {},
    }
  }

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPhaseKey(key)) {
      errors.push(
        `unknown phase '${key}' — expected one of: ${TRIDENT_PHASES.map((p) => p.key).join(', ')}`,
      )
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`phase '${key}' must be an object with optional 'model' and 'effort'`)
      continue
    }
    const phase = phaseByKey(key)!
    const entry: PhaseModelOverride = {}
    for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      if (field === 'model') {
        if (typeof fieldValue !== 'string') {
          errors.push(`phase '${key}': 'model' must be a string`)
          continue
        }
        const model = fieldValue.trim()
        if (model.length === 0) {
          // An empty string is how a cleared text input arrives. It means "no
          // override", not "a model called nothing" — but accepting it silently
          // would store a pin that resolves to nothing, so it is rejected here and
          // the caller is expected to omit the key to clear it.
          errors.push(`phase '${key}': 'model' is empty — omit the phase to use its default`)
          continue
        }
        if (model.length > MODEL_ID_MAX) {
          errors.push(`phase '${key}': 'model' is longer than ${MODEL_ID_MAX} characters`)
          continue
        }
        // Explicit \u escapes rather than literal control bytes in the source: a raw
        // 0x00-0x1f in a string literal is invisible in review and mangles on copy.
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001f\u007f]/.test(model)) {
          errors.push(`phase '${key}': 'model' contains control characters`)
          continue
        }
        if (model === NO_MODEL) {
          // NONE IS A VALUE, NOT AN ABSENCE, and only a cross-model slot may hold it.
          // Storing it (rather than omitting the key) is the whole point: the run has
          // to be able to tell "the owner turned this seat off" from "this seat was
          // never touched, so it runs its default". Collapsing those is how a knowing
          // opt-out becomes an invisible one.
          if (phase.cross_model_slot !== true) {
            errors.push(
              `phase '${key}': 'none' is only settable on a cross-model review slot — ${phase.label} must have a model`,
            )
            reject(key, { model })
            continue
          }
          entry.model = NO_MODEL
          continue
        }
        if (!isModelTier(model)) {
          // A retired tier and an older build's literal id land here together, and
          // both mean the same thing to a dispatch: a value nothing can resolve.
          // Named in the message AND kept in `rejected`, so the pane can show what
          // was dropped instead of quietly reverting to the default.
          errors.push(
            `phase '${key}': '${model}' is not a model tier — expected one of: ${MODEL_TIERS.join(', ')}`,
          )
          reject(key, { model })
          continue
        }
        if (!phaseAcceptsTier(phase, model)) {
          // Not a preference — a capability. See `tierRefusalReason`, which is the SAME
          // sentence the settings pane greys the option out with, so the message an
          // owner reads before saving and the message they read after a rejected save
          // cannot drift apart.
          errors.push(`phase '${key}': ${tierRefusalReason(phase, model)}`)
          reject(key, { model })
          continue
        }
        entry.model = model
        continue
      }
      if (field === 'effort') {
        if (!isEffort(fieldValue)) {
          errors.push(
            `phase '${key}': 'effort' must be one of: ${EFFORTS.join(', ')} (got ${JSON.stringify(fieldValue)})`,
          )
          continue
        }
        if (!phaseSupportsEffort(phase)) {
          // Storing an effort no dispatch reads would be a control the owner sets and
          // nothing honours — the exact shape this module exists to prevent.
          errors.push(
            `phase '${key}': 'effort' is not settable — this step runs as a CLI subprocess, which chooses its own reasoning effort`,
          )
          reject(key, { effort: fieldValue })
          continue
        }
        entry.effort = fieldValue
        continue
      }
      errors.push(`phase '${key}': unknown field '${field}' — only 'model' and 'effort' are settable`)
    }
    // Drop an entry that set nothing, so an empty object never persists as config.
    if (entry.model !== undefined || entry.effort !== undefined) config[key] = entry
  }

  return { config, errors, rejected }
}

/**
 * The phase defaults, as a plain object a settings UI can render beside the overrides.
 *
 * Derived from {@link TRIDENT_PHASES} rather than restated, so the pane and the run
 * can never disagree about what "default" means.
 */
export function phaseModelDefaults(): Readonly<Record<string, { model: ModelTier; effort: Effort }>> {
  const out: Record<string, { model: ModelTier; effort: Effort }> = {}
  for (const phase of TRIDENT_PHASES) {
    out[phase.key] = { model: phase.default.tier, effort: phase.default.effort }
  }
  return out
}

/**
 * THE OLD VENDOR-NAMED SEAT KEYS → THE NEW SLOT KEYS.
 *
 * `review_codex` and `review_kimi` are persisted in owner configuration on every
 * install that opened the pane before ISSUES #566. Renaming a settings key without a
 * migration is indistinguishable, from the owner's side, from the product forgetting
 * what they chose — the row reverts to its default and nothing says why. So the read
 * path runs this first, and a stored `review_codex: { model: 'terra' }` arrives at the
 * new pane as `review_cross_1: { model: 'terra' }`.
 *
 * DIRECTIONAL, AND DELIBERATELY NOT SYMMETRIC. Slot ONE takes the codex seat and slot
 * TWO the kimi seat, matching both the old panel order and the new defaults, so an
 * install that never touched the pane keeps dispatching the same two models in the same
 * two positions.
 */
export const LEGACY_PHASE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  review_codex: 'review_cross_1',
  review_kimi: 'review_cross_2',
})

/**
 * Rewrite a stored config's legacy keys onto the current ones.
 *
 * A NEW KEY ALREADY PRESENT WINS. Both keys can coexist only on a config written by a
 * build straddling the rename; in that case the value the owner set most recently is
 * the one under the NEW key, and silently overwriting it with the legacy value would
 * undo a choice they can see in the pane.
 *
 * Total and pure: a non-object, a null, an array — anything that is not a config — is
 * returned untouched for {@link parsePhaseModelConfig} to reject with its own message.
 */
export function migratePhaseModelConfig(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const source = raw as Record<string, unknown>
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    const renamed = LEGACY_PHASE_KEYS[key]
    if (renamed === undefined) {
      out[key] = value
      continue
    }
    changed = true
    if (!Object.prototype.hasOwnProperty.call(source, renamed)) out[renamed] = value
  }
  return changed ? out : raw
}

/**
 * The tiers a phase may be set to, each with whether it is selectable and why not.
 *
 * SERVER-SIDE, SO BOTH CLIENTS RENDER THE SAME ANSWER. The two settings screens used to
 * compare group strings themselves, which meant the rule "which options does this row
 * offer" lived in three places (validator, mobile, web) and could disagree — and the
 * disagreement is invisible until an owner saves a value one of them offered and the
 * server refuses it. The reason string is a product decision, so it is computed once
 * here, next to the validator that enforces it.
 */
export function phaseTierOptions(
  phase: TridentPhase,
): ReadonlyArray<{ tier: ModelTier; selectable: boolean; reason: string | null }> {
  return MODEL_TIERS.map((tier) => ({
    tier,
    selectable: phaseAcceptsTier(phase, tier),
    reason: tierRefusalReason(phase, tier),
  }))
}
