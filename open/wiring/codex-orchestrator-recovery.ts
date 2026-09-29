import { mintProjectChatOrchestratorAuthority, type ProjectChatOrchestratorAuthority } from '@neutronai/tools/orchestrator-authority.ts'
import { OWNER_INSTALLED_GATEWAY_TOOL, type CodexOwnerToolRequest } from '@neutronai/runtime/adapters/codex-cli/persistent/owner-installed-gateway.ts'

const RECOVERY_TOOL = 'work_board_replan_build'
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export interface CodexOrchestratorRecoveryTransport {
  projectScopeFor(projectId: string): string
  dispatch(input: { tool_name: string; args: unknown; call_id: string; project_id: string;
    orchestratorAuthority: ProjectChatOrchestratorAuthority }): Promise<unknown>
}

/** Fixed host route; it does not grant access to another registry tool or project. */
export async function dispatchCodexOrchestratorRecovery(input: {
  request: CodexOwnerToolRequest
  projectId: string | null
  sessionId: string
  threadId: string
  generation: string
  leaseId: string
  assertCurrent(): void
  transport: CodexOrchestratorRecoveryTransport | undefined
}): Promise<unknown> {
  input.assertCurrent()
  const { request, transport } = input
  const args = request.params.arguments
  if (!transport || !input.projectId || request.method !== 'item/tool/call'
    || request.params.tool !== OWNER_INSTALLED_GATEWAY_TOOL.name || request.params.threadId !== input.threadId
    || typeof request.params.callId !== 'string' || !request.params.callId.trim()
    || !record(args) || args.action !== 'replan_build' || !record(args.params)
    || Object.keys(args).some(key => key !== 'action' && key !== 'params')) {
    throw new Error('Authenticated project-chat recovery invocation required')
  }
  const params = structuredClone(args.params)
  let active = true
  const assertCurrent = () => {
    if (!active) throw new Error('Project-chat recovery invocation has ended')
    input.assertCurrent()
  }
  const authority = mintProjectChatOrchestratorAuthority({
    facts: { project_scope: transport.projectScopeFor(input.projectId), project_id: input.projectId,
      call_id: request.params.callId, chat_id: input.threadId, session_id: input.sessionId,
      thread_id: input.threadId, generation: input.generation, lease_id: input.leaseId },
    toolName: RECOVERY_TOOL, args: params, assertCurrent,
  })
  try {
    return await transport.dispatch({ tool_name: RECOVERY_TOOL, args: params,
      call_id: request.params.callId, project_id: input.projectId, orchestratorAuthority: authority })
  } finally { active = false }
}
