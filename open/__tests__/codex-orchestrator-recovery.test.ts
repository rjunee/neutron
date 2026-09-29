import { expect, test } from 'bun:test'
import { dispatchCodexOrchestratorRecovery, type CodexOrchestratorRecoveryTransport } from '../wiring/codex-orchestrator-recovery.ts'
import { validateProjectChatOrchestratorAuthority } from '@neutronai/tools/orchestrator-authority.ts'
import { OWNER_INSTALLED_GATEWAY_TOOL } from '@neutronai/runtime/adapters/codex-cli/persistent/owner-installed-gateway.ts'

function fixture() {
  let current = true
  let calls = 0
  let validate!: () => unknown
  const args = { source_run_id: 'rejected', source_event_id: 4, direction: 'Revise the plan' }
  const transport: CodexOrchestratorRecoveryTransport = {
    projectScopeFor: projectId => `owner/${projectId}`,
    async dispatch(input) {
      calls++
      validate = () => validateProjectChatOrchestratorAuthority(input.orchestratorAuthority, {
        project_scope: `owner/${input.project_id}`, project_id: input.project_id, call_id: input.call_id,
        tool_name: input.tool_name, args: input.args,
      })
      expect(validate()).toEqual(expect.objectContaining({ project_id: 'project', thread_id: 'thread', lease_id: 'lease' }))
      return { accepted: true }
    },
  }
  const input = { projectId: 'project' as string | null, sessionId: 'session', threadId: 'thread', generation: 'generation', leaseId: 'lease',
    assertCurrent() { if (!current) throw new Error('Native owner lease is stale') }, transport,
    request: { id: 'request', method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId: 'call',
      tool: OWNER_INSTALLED_GATEWAY_TOOL.name, arguments: { action: 'replan_build', params: args } } },
  }
  return { input, calls: () => calls, revoke: () => { current = false }, validate: () => validate() }
}

test('exact Codex owner invocation reaches only the recovery tool; its authority expires after dispatch', async () => {
  const f = fixture()
  expect(await dispatchCodexOrchestratorRecovery(f.input)).toEqual({ accepted: true })
  expect(f.calls()).toBe(1)
  expect(() => f.validate()).toThrow('ended')
})

test('General, foreign native thread, forged envelope, and expired lease never reach recovery', async () => {
  const f = fixture()
  const attempts = [
    { ...f.input, projectId: null },
    { ...f.input, transport: undefined },
    { ...f.input, request: { ...f.input.request, params: { ...f.input.request.params, threadId: 'child-thread' } } },
    { ...f.input, request: { ...f.input.request, params: { ...f.input.request.params, tool: 'foreign' } } },
    { ...f.input, request: { ...f.input.request, params: { ...f.input.request.params, arguments: { ...f.input.request.params.arguments, authority: 'forged' } } } },
  ]
  for (const input of attempts) await expect(dispatchCodexOrchestratorRecovery(input)).rejects.toThrow()
  f.revoke()
  await expect(dispatchCodexOrchestratorRecovery(f.input)).rejects.toThrow('stale')
  expect(f.calls()).toBe(0)
})

test('generation loss during asynchronous evidence work invalidates the captured grant before claim', async () => {
  const f = fixture()
  const dispatch = f.input.transport.dispatch
  f.input.transport.dispatch = async input => {
    await dispatch(input)
    await Promise.resolve()
    f.revoke()
    f.validate()
  }
  await expect(dispatchCodexOrchestratorRecovery(f.input)).rejects.toThrow('stale')
})
