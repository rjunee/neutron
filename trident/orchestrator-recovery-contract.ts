import type { ProjectChatOrchestratorAuthority, ProjectChatOrchestratorAuditFacts } from '@neutronai/tools/orchestrator-authority.ts'

/** An explicit project-chat decision; ordinary retry never accepts these fields. */
export interface OrchestratorRecoveryRequest {
  board_item_id: string
  source_run_id: string
  source_event_id: number
  expected_head: string
  expected_base: string
  published_pr: number
  direction: string
}

/** Supplied by the authenticated tool transport, never decoded from tool arguments. */
export interface OrchestratorRecoveryInvocation {
  authority: ProjectChatOrchestratorAuthority
  project_id: string
  call_id: string
}

/** Durable authorization, atomically consumed when its sole successor is admitted. */
export interface OrchestratorRecoveryDecision {
  request: OrchestratorRecoveryRequest
  authority: Readonly<ProjectChatOrchestratorAuditFacts>
  current_run_id: string | null
  card_status: string
  card_updated_at: string
  source_meta: string
  repo_path: string
  repository: string
  base_branch: string
  branch: string
  task: string
  max_rounds: number
  task_iteration: number
  max_task_iterations: number
}

export const ORCHESTRATOR_RECOVERY_STAGE = 'build-orchestrator-recovery'
export const WORK_BOARD_REPLAN_BUILD_TOOL = 'work_board_replan_build'
