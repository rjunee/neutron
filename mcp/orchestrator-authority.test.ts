import { expect, test } from 'bun:test'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { mintProjectChatOrchestratorAuthority, validateProjectChatOrchestratorAuthority } from '@neutronai/tools/orchestrator-authority.ts'
import { McpServer } from './server.ts'

test('ordinary resolver, Core/cron, and Claude session-only dispatch cannot manufacture recovery authority', async () => {
  const registry = new ToolRegistry()
  const server = new McpServer({ project_slug: 'owner', registry })
  const tool_name = 'work_board_replan_build'
  const facts = { project_scope: 'owner', project_id: 'project', call_id: 'call', chat_id: 'chat',
    session_id: 'session', thread_id: 'thread', generation: 'generation', lease_id: 'lease' }
  const args = { source_event_id: 1 }
  let accepted = 0
  registry.register({ name: tool_name, description: '', input_schema: {}, output_schema: {},
    capability_required: 'write:project_data', approval_policy: 'auto', handler: async (params, ctx) => {
      validateProjectChatOrchestratorAuthority(ctx.orchestratorAuthority, { project_scope: ctx.project_slug,
        project_id: ctx.project_id!, call_id: ctx.call_id, tool_name, args: params })
      accepted++
      return 'accepted'
    } })
  for (const project_id of [null, 'project', 'foreign']) {
    await expect(server.dispatch({ tool_name, args: { ...args, orchestratorAuthority: facts }, call_id: 'call', project_id })).rejects.toThrow()
  }
  await expect(server.resolveBound({ project_id: 'project', topic_id: 'chat', speaker_user_id: 'owner', call_id: 'call' })({
    tool_name, call_id: 'call', args: { ...args, orchestratorAuthority: facts },
  })).rejects.toThrow()
  const authority = mintProjectChatOrchestratorAuthority({ facts, toolName: tool_name, args, assertCurrent() {} })
  expect(await server.dispatch({ tool_name, args, call_id: 'call', project_id: 'project', orchestratorAuthority: authority })).toBe('accepted')
  await expect(server.dispatch({ tool_name, args, call_id: 'call', project_id: 'foreign', orchestratorAuthority: authority })).rejects.toThrow()
  expect(accepted).toBe(1)
})
