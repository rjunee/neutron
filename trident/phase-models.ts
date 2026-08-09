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
 * ── A tier name and a literal id are both allowed, on purpose ────────────────
 * `model` accepts either a TIER name (`opus`, `fable`, …), which resolves through the
 * threaded registry and therefore follows a model upgrade automatically, or a literal
 * model id, which does not. The tier is the better answer almost always and is what
 * the UI should offer first; the literal escape hatch exists because pinning an exact
 * id is sometimes the whole point (a specific snapshot, a model the registry does not
 * know yet) and the alternative is editing code again.
 *
 * NOTE ON SUBSTRATES. Every phase here dispatches a CLAUDE agent. Pointing a phase at
 * a non-Claude model id will not reach that model — a Codex or Kimi model runs as a
 * separate subprocess, which is a different execution path, not a different id in the
 * same one. Validation therefore accepts any well-formed string (it cannot know every
 * valid id) and this limitation is stated where the UI can quote it, rather than being
 * discovered as a run that quietly used the wrong model.
 */

/** The model TIERS the workflow resolves through the threaded registry. */
export const MODEL_TIERS = ['fable', 'opus', 'sonnet', 'fast'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

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
      'The mechanical steps — checkpoints, reading a branch sha, writing the result, cleaning up the worktree.',
    labels: [
      { label: 'checkpoint:', dynamic: true },
      { label: 'terminal-result' },
      { label: 'cleanup:worktree' },
      { label: 'head-probe-round-', dynamic: true },
    ],
    default: { tier: 'fast', effort: 'low' },
  },
])

/**
 * Agent labels that are deliberately NOT model-configurable, with the reason.
 *
 * The cross-model reviewers dispatch an external CLI in a subprocess; the Claude agent
 * wrapping them only runs a command and maps an exit code, so "which model reviews"
 * for those lanes is decided by the CLI's own configuration, not here. Offering a
 * model control that could not affect the review would be a lie in the UI.
 *
 * The coverage test requires every workflow label to be either claimed by a phase or
 * listed here, so adding a lane forces a decision instead of allowing a silent
 * fallthrough.
 */
export const UNROUTED_LABELS: ReadonlyArray<{ label: string; dynamic?: boolean; why: string }> =
  Object.freeze([
    {
      label: 'argus:codex',
      why: 'dispatches the codex CLI in a subprocess; the reviewing model is the CLI’s own configuration.',
    },
    {
      label: 'argus:codex-retry',
      why: 'the retry of the same subprocess lane.',
    },
    {
      label: 'argus:kimi',
      why: 'dispatches the Kimi review CLI in a subprocess; the reviewing model is that CLI’s.',
    },
    {
      label: 'argus:kimi-retry',
      why: 'the retry of the same subprocess lane.',
    },
  ])

/** An owner's override for one phase. Either field may be set alone. */
export interface PhaseModelOverride {
  /** A {@link ModelTier} name, or a literal model id. */
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

/** True iff `value` names a {@link MODEL_TIERS} tier (rather than a literal id). */
export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as ReadonlyArray<string>).includes(value)
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
 * The maximum length accepted for a literal model id.
 *
 * A bound rather than a pattern: model ids are vendor strings whose shape changes
 * (`claude-opus-5`, `gpt-5.6-sol`), so a regex would reject valid future ids and send
 * the owner back to editing code — the exact problem this module exists to remove. A
 * length cap plus a control-character check is enough to keep a pathological value out
 * of a spawn argument without pretending to know the vendor's naming.
 */
const MODEL_ID_MAX = 128

/**
 * Validate owner-supplied phase configuration.
 *
 * Rejects, with a message naming the offending key: an unknown phase, a non-object
 * entry, an unknown field, an empty/oversized/control-character model id, and an
 * effort outside {@link EFFORTS}. An entry that validates but sets nothing is dropped
 * rather than stored, so `{}` never reads as "configured".
 */
export function parsePhaseModelConfig(raw: unknown): ParsedPhaseModelConfig {
  const errors: string[] = []
  const config: Record<string, PhaseModelOverride> = {}

  if (raw === null || raw === undefined) return { config: {}, errors: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: {}, errors: ['phase model config must be an object of phase → { model, effort }'] }
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
        entry.effort = fieldValue
        continue
      }
      errors.push(`phase '${key}': unknown field '${field}' — only 'model' and 'effort' are settable`)
    }
    // Drop an entry that set nothing, so an empty object never persists as config.
    if (entry.model !== undefined || entry.effort !== undefined) config[key] = entry
  }

  return { config, errors }
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
