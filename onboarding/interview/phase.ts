/**
 * @neutronai/onboarding — phase enum + legal-transition table (P2 v2).
 *
 * Per docs/plans/P2-onboarding-v2.md § 2.8. This file is the pure-v2
 * rewrite of the phase enum: v1 names (`import_offered`,
 * `archetype_picked`, `name_chosen`, `profile_pic_generating`,
 * `time_style_picked`, `work_pattern_captured`, `rituals_captured`) are
 * gone. The S1 migrations/0025_p2_v2_phase_rename.sql rewrites live in-
 * flight onboarding_state rows so this enum is the only label set the
 * engine sees post-deploy.
 *
 * Renames (v1 → v2):
 *   import_offered            → ai_substrate_offered
 *   archetype_picked          → personality_offered
 *   name_chosen               → agent_name_chosen
 *   profile_pic_generating    → work_interview_gap_fill (rows absorbed)
 *   time_style_picked         → work_interview_gap_fill (rows absorbed)
 *   work_pattern_captured     → work_interview_gap_fill (rows absorbed)
 *   rituals_captured          → work_interview_gap_fill (rows absorbed)
 *
 * Net adds (v2 only): `import_upload_pending`, `import_analysis_presented`,
 * `work_interview_gap_fill`.
 *
 * Net drops (v1 only — entries removed): the four absorbed phases above.
 *
 * L2 (2026-07) — `OnboardingPhase` + `ALL_PHASES` moved to
 * `../../contracts/onboarding-phase.ts` (a node-free leaf so cross-package
 * consumers can depend on the phase vocabulary without importing this
 * package — critic-layering.md §2.1 edge #1). This file re-exports both so
 * existing import specifiers stay valid; everything below (the transition
 * table) is untouched.
 */

import type { OnboardingPhase } from '../../contracts/onboarding-phase.ts'
export type { OnboardingPhase }

/** Terminal phases — cannot transition further. */
export const TERMINAL_PHASES: ReadonlySet<OnboardingPhase> = new Set([
  'completed',
  'failed',
])

/**
 * Legal forward transitions per § 2.8.
 *
 * Notes:
 *   - Every non-terminal phase can advance to `failed` (unrecoverable
 *     engine error). Recoverable errors keep the engine on the same
 *     phase and re-emit the prompt.
 *   - `ai_substrate_offered` branches to `import_upload_pending`
 *     (import accepted) OR `work_interview_gap_fill` (declined).
 *   - `import_upload_pending` branches to `import_running` (upload
 *     landed) OR `work_interview_gap_fill` (user declined mid-step).
 *   - `import_analysis_presented` branches to `personality_offered`
 *     (all required fields filled by import) OR
 *     `work_interview_gap_fill` (gaps remain).
 *   - `work_interview_gap_fill` may self-loop while the auditor reports
 *     missing required fields; cap enforced inside the handler.
 *   - `persona_reviewed` keeps the v1 redo edges back to
 *     `personality_offered` / `agent_name_chosen` / `slug_chosen` per
 *     § 2.12 revisit semantics.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<OnboardingPhase, ReadonlyArray<OnboardingPhase>>> = {
  signup: ['identity_oauth', 'instance_provisioned', 'failed'],
  identity_oauth: ['instance_provisioned', 'failed'],
  instance_provisioned: ['ai_substrate_offered', 'failed'],
  ai_substrate_offered: ['import_upload_pending', 'work_interview_gap_fill', 'failed'],
  import_upload_pending: ['import_running', 'work_interview_gap_fill', 'failed'],
  import_running: ['import_analysis_presented', 'failed'],
  import_analysis_presented: ['work_interview_gap_fill', 'personality_offered', 'failed'],
  work_interview_gap_fill: ['personality_offered', 'work_interview_gap_fill', 'failed'],
  personality_offered: ['agent_name_chosen', 'failed'],
  agent_name_chosen: ['slug_chosen', 'failed'],
  slug_chosen: ['projects_proposed', 'failed'],
  projects_proposed: ['persona_synthesizing', 'failed'],
  persona_synthesizing: ['persona_reviewed', 'failed'],
  persona_reviewed: [
    'completed',
    'failed',
    'personality_offered',
    'agent_name_chosen',
    'slug_chosen',
  ],
  completed: [],
  failed: [],
} as const

/**
 * Deployment mode that shapes the onboarding phase sequence.
 *
 * `managed` (hosted) runs the full sequence above (the default — every
 * existing caller and test that omits the mode argument gets byte-
 * identical behaviour). `open` (self-host) cuts the managed-only
 * provisioning + URL phases and reaches `ai_substrate_offered` /
 * `projects_proposed` directly. See
 * docs/plans/onboarding-open-vs-managed-framing-2026-06-11.md and
 * docs/NEUTRON.md § 1 (deployment tiers). The third tier, `connect`
 * (public-relay), is deferred (B2) and onboards as `managed` until that
 * affordance ships.
 */
export type OnboardingDeploymentMode = 'open' | 'managed'

/**
 * Open-mode-only forward edges, layered ON TOP of `LEGAL_TRANSITIONS`.
 *
 * Open self-host cuts `identity_oauth` / `instance_provisioned` (no fleet
 * provisioning locally) and `slug_chosen` (no subdomain to pick), so the
 * engine routes `signup → ai_substrate_offered` and
 * `agent_name_chosen → projects_proposed` directly. These edges are NEVER
 * consulted in managed mode, so the managed table — and every test that
 * pins it — is unchanged. The targets they cut TO are reachable in the
 * managed table only via the now-skipped intermediate phases; the open
 * routing in the engine (`nextPhaseForMode`) guarantees the cut phases
 * are never selected as a `next_phase` in open mode.
 */
export const OPEN_MODE_EXTRA_TRANSITIONS: Readonly<
  Partial<Record<OnboardingPhase, ReadonlyArray<OnboardingPhase>>>
> = {
  signup: ['ai_substrate_offered'],
  agent_name_chosen: ['projects_proposed'],
} as const

/**
 * True when transitioning from `from` → `to` is on the legal table.
 * Returns false on terminal `from` (no outgoing edges), on a self-edge
 * NOT explicitly listed (e.g. `work_interview_gap_fill` IS allowed to
 * self-loop), and on any pair not enumerated above.
 *
 * `mode` defaults to `managed` so existing call sites (and the v2 phase-
 * walk test matrix) see the canonical table unchanged. In `open` mode the
 * `OPEN_MODE_EXTRA_TRANSITIONS` edges are additionally legal.
 */
export function isLegalTransition(
  from: OnboardingPhase,
  to: OnboardingPhase,
  mode: OnboardingDeploymentMode = 'managed',
): boolean {
  const legal = LEGAL_TRANSITIONS[from]
  if (legal.includes(to)) return true
  if (mode === 'open') {
    const extra = OPEN_MODE_EXTRA_TRANSITIONS[from]
    if (extra !== undefined && extra.includes(to)) return true
  }
  return false
}

/** Full ordered list — useful for tests / UI / observability. */
export { ALL_PHASES } from '../../contracts/onboarding-phase.ts'
