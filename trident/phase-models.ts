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
 * A phase may only take a tier one of its OWN dispatches can reach. `agent({model})`
 * resolves against Claude Code's own endpoint, so a GPT/Kimi tier cannot run a step that
 * has only that dispatch; the codex review wrapper reads `CODEX_REVIEW_MODEL`, so a Kimi
 * tier cannot run it either. Choosing a tier no dispatch can reach is refused HERE,
 * where the owner is present to read why, rather than being discovered as a run that
 * used the wrong model.
 *
 * ── A PHASE MAY HAVE MORE THAN ONE DISPATCH ({@link TridentPhase.alsoRunsOn}) ─
 * The rule above used to be stated as "every phase has exactly one executor, derived
 * from its default tier", which was true only because nothing had ever been wired to a
 * second one. The BUILD phase now has two: the Claude `agent()` builder it defaults to,
 * and the codex executor (`trident/codex-build.sh`, dispatched by the workflow's
 * `forge:*` bridge). So the phase DECLARES the extra groups its dispatch can reach and
 * `phaseAcceptsTier` answers from that list.
 *
 * THE LIST IS A CLAIM ABOUT WIRING, NOT A WISH. Adding a group here un-greys those
 * tiers in the settings pane, so a group listed without a dispatch behind it ships a
 * control that silently does nothing — strictly worse than a greyed one, and the exact
 * defect this module exists to prevent. `__tests__/cross-model-dispatch.test.ts` runs
 * the production launcher into the real workflow and asserts the dispatch for every
 * group listed here, which is what keeps the claim honest.
 */

import {
  MODEL_TIERS,
  type ModelTier,
  type TierGroup,
  type Transport,
  isModelTier,
  modelTier,
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
  /**
   * Executor groups this phase can dispatch on BESIDES the one its default tier
   * implies — the phases that have more than one wired executor.
   *
   * Absent (the common case) means the single derived group and nothing else. See the
   * header: an entry here un-greys those tiers in the pane, so it is a statement that
   * the dispatch exists and is tested, not that it would be nice to have.
   */
  alsoRunsOn?: ReadonlyArray<TierGroup>
  /**
   * This phase takes another phase's setting when it has none of its own — and is
   * therefore NOT an owner-facing row.
   *
   * A FOLLOWER IS NOT RENDERED. The settings surface omits it (`vocabulary`), because a
   * row that displays its own default while the dispatch quietly uses another row's
   * override is the pane/run disagreement this module's header forbids — and the two
   * rows here are one step split by an internal cost tag, which is not a distinction
   * the owner has any way to act on.
   *
   * THE KEY IS NOT A BACK DOOR. A stored entry naming the follower does NOT win — it
   * is refused at the boundary (`parsePhaseModelConfig` below rejects it, and the read
   * path drops one stored before that rule existed) and the workflow's
   * `phaseOverrideFor` ignores it unconditionally. The reason is the same one that
   * hides the row: a value the pane cannot display is a value the owner cannot clear,
   * so honouring it would pin the mechanical build to a model nothing on screen
   * mentions — which on this phase means invisible Anthropic spend after a move to
   * codex. The key still exists only to route labels for the coverage test;
   * `__tests__/phase-model-coverage.test.ts` asserts the declaration and
   * `phaseOverrideFor` match, so the two cannot drift.
   */
  follows?: string
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
    // THE BUILD RUNS ON CODEX WHEN THE OWNER PICKS A GPT TIER. The workflow's forge
    // dispatch hands the assembled build brief to `trident/codex-build.sh` instead of
    // to `agent({model})`, and NO ANTHROPIC MODEL ID IS REQUESTED FOR THE PHASE — the
    // build's tokens are spent at OpenAI, which is the point: the reason to move a
    // build off Claude is the Anthropic quota. (The subprocess is still LAUNCHED by a
    // thin bridge agent running on the launcher's own default, because a workflow step
    // has no other way to reach a shell; that agent runs one command and copies six
    // measured values, and the build itself never touches Anthropic.)
    alsoRunsOn: ['codex'],
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
    // The SAME dispatch as `build` — same labels, same forge bridge — so it reaches
    // the codex executor for free.
    alsoRunsOn: ['codex'],
    // …AND IT IS NOT A SEPARATE ROW. The owner moves "Build" to codex; a task the
    // planner happened to tag `[mechanical]` must not stay on Claude and keep spending
    // the quota the move existed to protect. So this key follows `build`, and the pane
    // does not render it — a visible row showing `sonnet` while the run dispatched
    // `gpt-5.6-terra` is exactly the pane/run disagreement the header forbids, and
    // "which of my two Build rows applies" is not a question the owner can answer.
    follows: 'build',
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
    // The adversarial contract is passed explicitly to `trident/codex-review.sh`;
    // selecting this executor changes the model family, not the review's purpose.
    alsoRunsOn: ['codex'],
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
      'The mechanical steps — checkpoints, reading a branch sha, checking CI, asking whether the PR merged, writing the result, cleaning up the worktree.',
    labels: [
      { label: 'checkpoint:', dynamic: true },
      { label: 'terminal-result' },
      { label: 'cleanup:worktree' },
      { label: 'head-probe-round-', dynamic: true },
      { label: 'ci-probe-round-', dynamic: true },
      { label: 'merge-probe-round-', dynamic: true },
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
 * The executor group a phase runs on BY DEFAULT — `claude`, `codex`, `kimi`.
 *
 * Derived from the phase's default tier, so the pane and the run cannot disagree. This
 * is the group a row names when it explains why an option is greyed ("…it runs on
 * Claude"); {@link phaseGroups} is the set it may actually offer.
 */
export function phaseGroup(phase: TridentPhase): TierGroup {
  return modelTier(phase.default.tier)?.group ?? 'claude'
}

/**
 * EVERY executor group this phase can dispatch on, default first.
 *
 * The one question a settings row needs answered: a row may offer exactly the tiers in
 * these groups, because those are the only ones its dispatch can reach. Most phases
 * have one; see {@link TridentPhase.alsoRunsOn} for why `build` has two.
 */
export function phaseGroups(phase: TridentPhase): ReadonlyArray<TierGroup> {
  const primary = phaseGroup(phase)
  const extra = (phase.alsoRunsOn ?? []).filter((g) => g !== primary)
  return [primary, ...extra]
}

/**
 * Can this phase be moved to this tier?
 *
 * Asked of the PHASE, not of two tiers, because "what can substitute for what" depends
 * on which dispatches the phase has — and that is a property of the workflow's wiring,
 * not of the tier registry. THE ONLY form of this question in the codebase: the
 * tier-to-tier version it replaced (`tiersAreInterchangeable`) was deleted rather than
 * left beside it, because two answers to one question is how the pane and the run drift.
 */
export function phaseAcceptsTier(phase: TridentPhase, tier: ModelTier): boolean {
  const group = modelTier(tier)?.group
  return group !== undefined && phaseGroups(phase).includes(group)
}

/**
 * Does the effort control mean anything for this phase?
 *
 * Only for `agent` transport. A `cli` lane's reasoning effort is the CLI's own
 * setting, which the wrapper does not expose — so the pane renders that cell disabled
 * with the reason instead of offering a dropdown that changes nothing. (A phase's
 * stored `default.effort` is inert for those rows and never reaches a dispatch.)
 *
 * THIS ANSWERS FOR THE PHASE'S DEFAULT TIER — "could this row ever have an effort
 * control", not "does it have one right now". A phase with a second executor
 * ({@link TridentPhase.alsoRunsOn}) can be moved to a tier whose effort is inert while
 * this still returns true, so a pane must ALSO ask the chosen tier (the surface ships
 * `effort_supported` per tier for exactly that) and `parsePhaseModelConfig` drops the
 * effort when the chosen tier cannot use it.
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
 *
 * ONE THING IS DROPPED RATHER THAN REJECTED: an effort paired with a CLI tier on a
 * phase that DOES have an effort control (the build moved to codex). It lands in
 * {@link ParsedPhaseModelConfig.rejected} and the write succeeds. Note that the WRITE
 * path's caller never sees that field — see the comment at the end of the loop for
 * where it is read and why the drop is still visible to the owner.
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
    const followed = phaseByKey(key)!.follows
    if (followed !== undefined) {
      // A FOLLOWER PHASE IS NOT SETTABLE, AND A STORED ONE IS DROPPED RIGHT HERE.
      // `build_mechanical` is the build step under the planner's internal complexity
      // tag; it takes `build`'s setting and the pane deliberately does not render it
      // (`TridentPhase.follows`). An entry for it therefore has no row to appear on
      // and no way to be cleared — an owner who moved Build to codex would keep
      // dispatching mechanical tasks on Anthropic, spending the quota the move existed
      // to protect, with nothing on screen saying so. Rejecting it here covers both
      // directions at once: the WRITE path 400s and names the key, and the READ path
      // (which drops what it cannot use and continues) discards a value stored before
      // this rule existed — which is the migration, applied on the next read.
      errors.push(
        `phase '${key}' is not settable — it is the '${followed}' step under an internal complexity tag and always takes '${followed}'s setting`,
      )
      // …AND IT IS *NOT* PUT IN `rejected`, which is the one deliberate exception to
      // "never revert a choice silently" in this file. `rejected` exists so a ROW can
      // show what was dropped, struck through — both clients look it up BY PHASE KEY
      // (`rejectedModel(phase, rejected)`), and a follower has no row for them to look
      // it up from. Sending it would add a key to the payload nothing can render,
      // while re-opening the round-trip this rule closed: the pane echoes the payload
      // back on the next PUT, which is how a stored `build_mechanical` kept the
      // mechanical build on Anthropic after the owner moved Build to codex.
      // `gateway/__tests__/trident-phase-models-producer.test.ts` pins the key out of
      // the payload entirely. The owner is not left uninformed either: the WRITE path
      // 400s and names the key, and the only silent case left is a value stored before
      // this rule existed — which no pane has ever displayed, so there is no control
      // that appears to revert.
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
        if (!phaseAcceptsTier(phase, model)) {
          // Not a preference — a capability. See `phaseAcceptsTier`.
          //
          // NAMES THE EXECUTOR GROUP, NOT A SCRIPT. A tier's `wrapper` is the CROSS-MODEL
          // REVIEW wrapper it was registered with, and the build lane reaches the same
          // codex tiers through a different script — so interpolating it here told a
          // BUILD-row owner their tier "runs as a trident/codex-review.sh subprocess",
          // which is a sentence about a phase they were not configuring. The group is
          // true for every phase that can reach the tier.
          const got = modelTier(model)
          errors.push(
            `phase '${key}': '${model}' runs on the ${got?.group ?? 'unknown'} executor, which cannot run this step — ${key} dispatches on ${phaseGroups(phase).join(' or ')}`,
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
    // AN EFFORT IS INERT ONCE THE CHOSEN TIER IS A SUBPROCESS, even on a phase whose
    // DEFAULT tier has an effort control. `build` defaults to a Claude agent (effort
    // settable) but may now be moved to the codex executor, which picks its own
    // reasoning effort — so the pair `{model: 'sol', effort: 'max'}` would store a
    // number no dispatch reads. Checked AFTER the field loop because the two fields
    // arrive in whatever order the JSON had them, and the model is what decides.
    //
    // DROPPED, NOT AN ERROR, and this is the one place in this function that does not
    // fail the write. The pair is not a bad value, it is a LEFTOVER: the row had a
    // live effort control until the same save moved it to a subprocess. Rejecting it
    // would 400 the whole PUT — every other row's pending edit with it — and make the
    // codex tiers unpickable for any owner who had ever touched the effort control,
    // which is a settable option that cannot be set.
    //
    // NOTHING IS HIDDEN BY THE DROP, and the reason is the pane, NOT a field on the
    // response. A current pane never sends this pair at all (the effort cell is
    // answered by the chosen tier, and `applyRowEdit` clears what that tier cannot
    // use); a client that does send it renders the same disabled cell — "set by the
    // CLI" — the moment the response comes back, because the response is a fresh read
    // and the chosen tier is what decides that cell.
    //
    // BE PRECISE ABOUT WHAT THE CALLER IS TOLD: `rejected` is populated here and it is
    // NOT threaded to the PUT's caller. `writeTridentPhaseModels`
    // (`gateway/storage/owner-metadata.ts`) returns `{ok, errors}` and discards it, and
    // the surface's response body is a re-read of storage — whose re-parse finds
    // nothing to reject, because the pair is already gone. `rejected` earns its keep on
    // the READ path (`rejectedModel(phase, rejected)`), where it explains a STORED value
    // the dispatch could not use. Here it is a local record of what this pass dropped.
    if (entry.effort !== undefined && entry.model !== undefined) {
      const chosen = modelTier(entry.model)
      if (chosen?.transport === 'cli') {
        reject(key, { effort: entry.effort })
        delete entry.effort
      }
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
 *
 * A FOLLOWER PHASE IS NOT IN HERE, for the same reason it is not a row: its default is
 * not the value that runs. `build_mechanical` reads `sonnet` from the table and
 * dispatches whatever `build` was set to, so a `defaults` map that carried it would
 * hand every client a key with no row, no override it can ever hold, and a value the
 * run contradicts. The keys of this map and the phases in the payload are the same
 * set, deliberately.
 */
export function phaseModelDefaults(): Readonly<Record<string, { model: ModelTier; effort: Effort }>> {
  const out: Record<string, { model: ModelTier; effort: Effort }> = {}
  for (const phase of TRIDENT_PHASES) {
    if (phase.follows !== undefined) continue
    out[phase.key] = { model: phase.default.tier, effort: phase.default.effort }
  }
  return out
}
