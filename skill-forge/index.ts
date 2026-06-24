/**
 * @neutronai/skill-forge — Skill Forge runtime (auto-skillify, WAVE 4).
 *
 * Audits a completed multi-step workflow and, gated by a propose-then-approve
 * step, distills it into a saved, re-invokable skill written under
 * `<owner_data_dir>/skills/conventions/` — the directory the realmode composer
 * already splices into every LLM turn, so an approved skill is immediately
 * agent-discoverable and survives a fresh session. Never auto-creates a skill:
 * a skill file only ever appears via an explicit `approve`.
 */

export { SkillForge } from './forge.ts'
export type { ProposalNotifier, ApproveResult } from './forge.ts'
export { SkillForgeProposalsStore } from './proposals-store.ts'
export type { CreateProposalInput } from './proposals-store.ts'
export { auditWorkflow, MIN_DISTINCT_STEPS } from './detector.ts'
export type { AuditResult } from './detector.ts'
export { distillSkill, renderSkillMarkdown, slugify, deriveTriggers } from './distiller.ts'
export { workflowSignature, normalizeAction } from './signature.ts'
export { composeProposalMessage } from './proposal-message.ts'
export { registerSkillFile, resolveSkillsDir } from './registrar.ts'
export type { RegisterSkillResult } from './registrar.ts'
export {
  completedWorkflowFromTridentRun,
  type TridentRunLike,
} from './trident-adapter.ts'
export type {
  CompletedWorkflow,
  WorkflowStep,
  SkillDraft,
  ProposalEdits,
  ProposalStatus,
  ProposalRecord,
} from './types.ts'
