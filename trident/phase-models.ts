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
  type ModelTier,
  type TierGroup,
  type Transport,
  isModelTier,
  modelTier,
  tiersAreInterchangeable,
} from './model-tiers.ts'

export { MODEL_TIERS, isModelTier }
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
  },
  {
    key: 'build',
    label: 'Build',
    description: 'Writes the code and the tests, and re-writes them against review findings.',
    labels: [{ label: 'forge:build' }, { label: 'forge:fix-round-', dynamic: true }],
    default: { tier: 'opus', effort: 'high' },
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
  },
  {
    key: 'review_rubric',
    label: 'Rubric review',
    description: 'Reviews the diff against the fixed criteria — correctness, security, test quality.',
    labels: [{ label: 'argus:claude' }],
    default: { tier: 'opus', effort: 'high' },
  },
  {
    key: 'review_adversarial',
    label: 'Adversarial review',
    description: 'Independently tries to REFUTE the change rather than to approve it.',
    labels: [{ label: 'argus:adversarial' }],
    default: { tier: 'opus', effort: 'high' },
  },
  {
    key: 'review_codex',
    label: 'Cross-model review (Codex)',
    description:
      'A second opinion from a GPT model, run as a Codex CLI subprocess — a different model family than the rest of the panel.',
    labels: [{ label: 'argus:codex' }, { label: 'argus:codex-retry' }],
    // `sol` is the flagship GPT 5.6 tier and matches the wrapper's own standing pin,
    // so an install that never opens the pane dispatches exactly what it dispatched
    // before this phase existed. The effort below is INERT — a CLI chooses its own
    // reasoning effort, and no dispatch reads this value (see `phaseSupportsEffort`).
    default: { tier: 'sol', effort: 'high' },
  },
  {
    key: 'review_kimi',
    label: 'Cross-model review (Kimi)',
    description:
      'A second opinion from Kimi K3, run as a CLI subprocess — a third model family, so the panel is not two copies of one set of blind spots.',
    labels: [{ label: 'argus:kimi' }, { label: 'argus:kimi-retry' }],
    default: { tier: 'k3', effort: 'high' },
  },
  {
    key: 'synthesis',
    label: 'Synthesis / arbitration',
    description: 'Merges every reviewer’s verdict into one, and decides what blocks a merge.',
    labels: [{ label: 'argus:synthesis' }],
    default: { tier: 'fable', effort: 'high' },
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
 * The EXECUTOR GROUP a phase dispatches on — `claude`, `codex`, `kimi`.
 *
 * The one question a settings row needs answered: a row may offer exactly the tiers in
 * its own group, because those are the only ones its dispatch can reach. Derived from
 * the phase's default tier, so the pane and the run cannot disagree.
 */
export function phaseGroup(phase: TridentPhase): TierGroup {
  return modelTier(phase.default.tier)?.group ?? 'claude'
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
        if (!tiersAreInterchangeable(phase.default.tier, model)) {
          // Not a preference — a capability. See `tiersAreInterchangeable`.
          const want = modelTier(phase.default.tier)
          const got = modelTier(model)
          errors.push(
            `phase '${key}': '${model}' runs ${got?.transport === 'cli' ? `as a ${got.wrapper ?? 'CLI'} subprocess` : 'as a Claude agent'}, which cannot run this step — ${key} dispatches ${want?.transport === 'cli' ? `through ${want.wrapper ?? 'a CLI'}` : 'a Claude agent'}`,
          )
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
