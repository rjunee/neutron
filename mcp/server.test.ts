import { describe, expect, test } from 'bun:test'
import { ToolRegistry } from '../tools/registry.ts'
import { McpServer } from './server.ts'
import { withTopicContext, type TopicContext } from './topic-context.ts'

const sampleSchema = { type: 'object', properties: {} }

describe('McpServer', () => {
  test('dispatch invokes the handler with the bound topic context', async () => {
    const reg = new ToolRegistry()
    const seen: Array<{ args: unknown; ctx: { topic_id: string | null; speaker_user_id: string | null } }> = []
    reg.register({
      name: 'echo',
      description: 'echo args back',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'read:project_data',
      approval_policy: 'auto',
      handler: async (args, ctx) => {
        seen.push({ args, ctx: { topic_id: ctx.topic_id, speaker_user_id: ctx.speaker_user_id } })
        return { ok: true }
      },
    })
    const server = new McpServer({ project_slug: 'project-A', registry: reg })
    const ctx: TopicContext = {
      topic_id: 'topic-1',
      project_id: 'proj-1',
      speaker_user_id: 'user-1',
      call_id: 'call-1',
    }
    const result = await withTopicContext(ctx, async () =>
      server.dispatch({ tool_name: 'echo', args: { x: 1 }, call_id: 'call-1' }),
    )
    expect(result).toEqual({ ok: true })
    expect(seen.length).toBe(1)
    expect(seen[0]?.ctx.topic_id).toBe('topic-1')
    expect(seen[0]?.ctx.speaker_user_id).toBe('user-1')
  })

  test('unknown tool throws', async () => {
    const reg = new ToolRegistry()
    const server = new McpServer({ project_slug: 'project-A', registry: reg })
    await expect(
      server.dispatch({ tool_name: 'nope', args: {}, call_id: 'c' }),
    ).rejects.toThrow(/unknown tool 'nope'/)
  })

  test('capability gate refusal throws with capability name in message', async () => {
    const reg = new ToolRegistry()
    reg.register({
      name: 'restricted',
      description: '',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'write:gmail',
      approval_policy: 'auto',
      handler: async () => ({}),
    })
    const server = new McpServer({
      project_slug: 'project-A',
      registry: reg,
      capability_gate: (cap) => cap !== 'write:gmail',
    })
    await expect(
      server.dispatch({ tool_name: 'restricted', args: {}, call_id: 'c' }),
    ).rejects.toThrow(/write:gmail/)
  })

  test('resolveBound returns a McpToolResolver compatible function', async () => {
    const reg = new ToolRegistry()
    reg.register({
      name: 'echo',
      description: '',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'read:project_data',
      approval_policy: 'auto',
      handler: async (args) => ({ got: args }),
    })
    const server = new McpServer({ project_slug: 'project-A', registry: reg })
    const resolver = server.resolveBound({
      topic_id: 'topic-2',
      project_id: 'proj-1',
      speaker_user_id: 'user-1',
      call_id: 'call-2',
    })
    const result = await resolver({ call_id: 'call-2', tool_name: 'echo', args: { y: 2 } })
    expect(result).toEqual({ got: { y: 2 } })
  })

  test('listTools returns name + description for every registered tool', () => {
    const reg = new ToolRegistry()
    reg.register({
      name: 'a',
      description: 'da',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'read:project_data',
      approval_policy: 'auto',
      handler: async () => null,
    })
    const server = new McpServer({ project_slug: 't', registry: reg })
    expect(server.listTools()).toEqual([{ name: 'a', description: 'da' }])
  })
})
