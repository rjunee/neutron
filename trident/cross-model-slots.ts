/**
 * @neutronai/trident — THE TWO CROSS-MODEL REVIEW SLOTS, RESOLVED BEFORE THE RUN.
 *
 * ── What this module is defending ────────────────────────────────────────────
 * The cross-model seats exist so the review panel is not one model family marking its
 * own homework. `trident/kimi-review.ts` states the invariant they buy: a deferred
 * cross-model review can NEVER become an APPROVE, enforced deterministically by
 * `enforceCrossModelGate` in the workflow rather than left to a synthesis LLM, and
 * there is no fallback to a Claude-family model, ever.
 *
 * Making the seats configurable (ISSUES #566) introduces a THIRD state, and it is the
 * one that can quietly destroy the feature:
 *
 *   • `configured`     — a model is selected and a credential exists. If it fails, it
 *                        MUST still bar the APPROVE, exactly as today.
 *   • `none`           — the owner deliberately emptied the seat. It must NOT block.
 *   • `not_configured` — a model is selected but this install has no credential for
 *                        it. Also does not block (the pre-existing graceful path), but
 *                        it is NOT the same as `none` and the panel says which it was.
 *
 * THE FIRST TWO ARE BOTH "NO VERDICT ARRIVED". If the gate distinguishes them by
 * looking at emptiness — a null slot, a missing status — then a deliberate opt-out and
 * a dead reviewer become the same thing, and the run reports a cross-model review that
 * never happened while merging on a single-family panel. That is strictly worse than
 * either state alone, because the report is what an operator trusts. So the
 * DISPOSITION is computed HERE, once, from the owner's configuration, and travels with
 * the seat as data. The gate reads the field; it never infers.
 *
 * ── Why resolution happens in TypeScript, ahead of the workflow ──────────────
 * `trident/inner-workflow.mjs` is a CC Dynamic Workflow script with no module
 * resolution, so it cannot import the registry or the settings validator. Everything it
 * needs about a seat therefore has to arrive as an argument — and everything that
 * arrives as an argument can be unit-tested without spawning an agent, which is the
 * only way a rule this load-bearing gets a test at all.
 */

import {
  NO_MODEL,
  type ModelTier,
  type TierRequirement,
  isModelTier,
  modelTier,
} from './model-tiers.ts'
import { TRIDENT_PHASES, type PhaseModelConfig, phaseAcceptsTier, phaseByKey } from './phase-models.ts'

/** The phase keys of the two slots, in panel order. Stable — persisted in owner config. */
export const CROSS_MODEL_SLOT_KEYS = ['review_cross_1', 'review_cross_2'] as const
export type CrossModelSlotKey = (typeof CROSS_MODEL_SLOT_KEYS)[number]

/**
 * Why a seat will or will not produce a verdict. See the header — this is the field the
 * merge gate reads, and the reason it is a field.
 */
export type SlotDisposition = 'configured' | 'none' | 'not_configured'

/** One resolved cross-model seat, ready to thread into the workflow. */
export interface ResolvedCrossModelSlot {
  /** The settings key, and the workflow's label prefix suffix (`argus:cross-1`). */
  key: CrossModelSlotKey
  /** `argus:cross-1` / `argus:cross-2` — the workflow agent label this seat dispatches. */
  label: string
  /** What the owner sees, e.g. `Cross-model review ONE`. */
  title: string
  disposition: SlotDisposition
  /** The chosen tier, or null when the disposition is `none`. */
  tier: ModelTier | null
  /** The model the subprocess will run, or null. Re-resolved every launch. */
  model_id: string | null
  /** The wrapper this seat shells into, repo-relative, or null. */
  wrapper: string | null
  /** The env knob that carries `model_id` into the wrapper, or null. */
  env_var: string | null
  /** The credential the seat needs, or null. */
  requires: TierRequirement | null
  /**
   * One line naming WHY this seat will not run, for the panel text and the run log.
   * Null when it will run. Never a stack trace and never a credential.
   */
  reason: string | null
}

/** Which credentials this install actually holds. Booleans, never the secrets. */
export interface CredentialAvailability {
  codex: boolean
  kimi: boolean
}

/**
 * Resolve both seats from the owner's validated phase config plus what this install can
 * actually authenticate.
 *
 * `config` is the output of `parsePhaseModelConfig` — already validated, so an entry
 * here either names a real tier the slot accepts or is `none`. A value that somehow got
 * past that boundary is treated as ABSENT (the seat falls back to its default tier)
 * rather than as `none`: degrading toward a reviewer that runs is the safe direction,
 * because the alternative silently empties a seat the owner never emptied.
 */
export function resolveCrossModelSlots(
  config: PhaseModelConfig,
  credentials: CredentialAvailability,
): ReadonlyArray<ResolvedCrossModelSlot> {
  return CROSS_MODEL_SLOT_KEYS.map((key, index) => {
    const phase = phaseByKey(key)
    const label = `argus:cross-${index + 1}`
    const title = phase?.label ?? key
    const empty = {
      key,
      label,
      title,
      tier: null,
      model_id: null,
      wrapper: null,
      env_var: null,
      requires: null,
    } as const

    const chosen = config[key]?.model
    if (chosen === NO_MODEL) {
      return {
        ...empty,
        disposition: 'none',
        reason: 'turned off by the owner — this seat is deliberately empty',
      }
    }

    // An override that is not a usable tier falls back to the phase default rather than
    // emptying the seat. See the docblock: the safe direction is toward a reviewer.
    const tier: ModelTier | null =
      chosen !== undefined && isModelTier(chosen) && phase !== null && phaseAcceptsTier(phase, chosen)
        ? chosen
        : (phase?.default.tier ?? null)
    const descriptor = tier === null ? null : modelTier(tier)
    if (tier === null || descriptor === null || descriptor.wrapper === null) {
      return {
        ...empty,
        disposition: 'not_configured',
        reason: `no review wrapper is registered for ${key}`,
      }
    }

    const needs = descriptor.requires
    const held = needs === null ? true : credentials[needs]
    if (!held) {
      return {
        key,
        label,
        title,
        disposition: 'not_configured',
        tier,
        model_id: descriptor.model_id,
        wrapper: descriptor.wrapper,
        env_var: descriptor.env_var,
        requires: needs,
        reason: `this install has no ${needs} credential, so ${descriptor.model_id} cannot run`,
      }
    }

    return {
      key,
      label,
      title,
      disposition: 'configured',
      tier,
      model_id: descriptor.model_id,
      wrapper: descriptor.wrapper,
      env_var: descriptor.env_var,
      requires: needs,
      reason: null,
    }
  })
}

/**
 * Is the panel deliberately single-family?
 *
 * Both seats `none` is a legitimate configuration and must not block a merge — but it
 * IS a reduced panel, and the pane and the run should say so plainly rather than let
 * the owner keep believing a second family is checking the work. This is the predicate
 * both surfaces call, so the wording sits in one place and the condition in another.
 */
export function panelIsClaudeOnly(slots: ReadonlyArray<ResolvedCrossModelSlot>): boolean {
  return slots.every((s) => s.disposition !== 'configured')
}

/**
 * The seats that will actually be dispatched, in panel order.
 *
 * Only `configured` seats cost an agent. `none` and `not_configured` are skipped for
 * the same reason the old code skipped an unconfigured codex: there is nothing to call.
 * The difference is what happens if a dispatched seat then fails, and that difference
 * lives in the disposition the skipped ones carry with them.
 */
export function dispatchableSlots(
  slots: ReadonlyArray<ResolvedCrossModelSlot>,
): ReadonlyArray<ResolvedCrossModelSlot> {
  return slots.filter((s) => s.disposition === 'configured')
}

/** Every phase key that names a cross-model slot. Used by the settings surface. */
export function isCrossModelSlotKey(key: string): key is CrossModelSlotKey {
  return (CROSS_MODEL_SLOT_KEYS as ReadonlyArray<string>).includes(key)
}

/** The slot phases, in panel order — for a pane that renders them as a group. */
export function crossModelSlotPhases(): ReadonlyArray<(typeof TRIDENT_PHASES)[number]> {
  return TRIDENT_PHASES.filter((p) => p.cross_model_slot === true)
}
