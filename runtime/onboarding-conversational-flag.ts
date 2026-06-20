/**
 * @neutronai/runtime — `NEUTRON_ONBOARDING_CONVERSATIONAL` env-flag parser.
 *
 * P2-v3 S2 (2026-05-18). Both platform adapters read the same env var
 * and parse via this single helper so Open + Managed never drift.
 *
 * Tri-state semantics (mirrors `phase-spec-resolver.ts:resolveEnabledPhases`):
 *
 *   - Unset / `0` / `false` / `off` / `none` / `""`
 *       → flag off; router never fires.
 *   - `1` / `true` / `yes` / `on` / `enabled` / `all`
 *       → flag on for every phase with a non-null PHASE_KNOWLEDGE pack.
 *   - Comma-separated phase list (e.g. `signup,import_upload_pending`)
 *       → flag on for ONLY the listed phases. Invalid phase names are
 *         silently dropped (mirrors `parseEnabledPhasesEnv`).
 *   - Unrecognised token (e.g. `'maybe'`)
 *       → flag off (fail-closed; operator typo should not silently
 *         enable a feature globally).
 */

import { ALL_PHASES, type OnboardingPhase } from '../onboarding/interview/phase.ts'
import { OPTIN_TOKENS, OPTOUT_TOKENS } from './env-flag-tokens.ts'

export interface ConversationalFlagResolution {
  /** True when the router should be allowed to fire at all. */
  enabled: boolean
  /**
   * `'all'` when the env var is a bool-on token; a Set when it's a
   * comma-separated phase list; an empty Set when the flag is off.
   */
  phases: ReadonlySet<OnboardingPhase> | 'all'
}

const ALL_PHASES_SET = new Set<OnboardingPhase>(ALL_PHASES)

/**
 * Resolve the env var into a structured shape. Pure function — no
 * `process.env` read inside; callers pass the raw value (typically
 * `process.env['NEUTRON_ONBOARDING_CONVERSATIONAL']`) so tests can
 * exercise every branch without mutating ambient state.
 */
export function resolveOnboardingConversational(
  raw: string | undefined,
): ConversationalFlagResolution {
  if (typeof raw !== 'string') {
    return { enabled: false, phases: new Set<OnboardingPhase>() }
  }
  const trimmed = raw.trim()
  const lowered = trimmed.toLowerCase()
  if (OPTOUT_TOKENS.has(lowered)) {
    return { enabled: false, phases: new Set<OnboardingPhase>() }
  }
  if (OPTIN_TOKENS.has(lowered)) {
    return { enabled: true, phases: 'all' }
  }
  // Treat as a comma-separated phase list. Unknown phase names dropped.
  const parts = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const phases = new Set<OnboardingPhase>()
  for (const part of parts) {
    if (ALL_PHASES_SET.has(part as OnboardingPhase)) {
      phases.add(part as OnboardingPhase)
    }
  }
  // Empty phase set after filtering invalid tokens → fail-closed.
  if (phases.size === 0) {
    return { enabled: false, phases: new Set<OnboardingPhase>() }
  }
  return { enabled: true, phases }
}
