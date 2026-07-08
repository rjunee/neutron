/**
 * @neutronai/contracts — onboarding phase enum + full phase list (L2 leaf).
 *
 * L2 (2026-07) — `OnboardingPhase` + `ALL_PHASES` extracted VERBATIM out of
 * `onboarding/interview/phase.ts` into this node-free leaf so cross-package
 * consumers (`runtime/platform-adapter.ts`, `runtime/platform-adapter-local.ts`)
 * can depend on the phase vocabulary WITHOUT importing the `onboarding`
 * package (critic-layering.md §2.1 edge #1: `runtime → onboarding`).
 * `onboarding/interview/phase.ts` re-exports both symbols so existing import
 * specifiers stay valid (test-policy §2.2 barrel rule); the rest of that
 * file (`TERMINAL_PHASES`, `LEGAL_TRANSITIONS`, `OnboardingDeploymentMode`,
 * `OPEN_MODE_EXTRA_TRANSITIONS`, `isLegalTransition`) is untouched — that's
 * transition-table LOGIC, not a stranded contract type, and stays in
 * `onboarding`.
 */

export type OnboardingPhase =
  | 'signup'
  | 'identity_oauth'
  | 'instance_provisioned'
  | 'ai_substrate_offered'
  | 'import_upload_pending'
  | 'import_running'
  | 'import_analysis_presented'
  | 'work_interview_gap_fill'
  | 'personality_offered'
  | 'agent_name_chosen'
  | 'slug_chosen'
  | 'projects_proposed'
  | 'persona_synthesizing'
  | 'persona_reviewed'
  | 'completed'
  | 'failed'

/** Full ordered list — useful for tests / UI / observability. */
export const ALL_PHASES: ReadonlyArray<OnboardingPhase> = [
  'signup',
  'identity_oauth',
  'instance_provisioned',
  'ai_substrate_offered',
  'import_upload_pending',
  'import_running',
  'import_analysis_presented',
  'work_interview_gap_fill',
  'personality_offered',
  'agent_name_chosen',
  'slug_chosen',
  'projects_proposed',
  'persona_synthesizing',
  'persona_reviewed',
  'completed',
  'failed',
]
