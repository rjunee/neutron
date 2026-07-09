import { describe, expect, test } from 'bun:test'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
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

  test('dispatch binds the bound topic context project_id into ToolCallContext.project_id', async () => {
    const reg = new ToolRegistry()
    let seenProjectId: string | null | undefined
    reg.register({
      name: 'peek',
      description: '',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'read:project_data',
      approval_policy: 'auto',
      handler: async (_args, ctx) => {
        seenProjectId = ctx.project_id
        return { ok: true }
      },
    })
    const server = new McpServer({ project_slug: 'owner-slug', registry: reg })
    const ctx: TopicContext = {
      topic_id: 'topic-1',
      project_id: 'acme',
      speaker_user_id: 'user-1',
      call_id: 'call-1',
    }
    await withTopicContext(ctx, async () =>
      server.dispatch({ tool_name: 'peek', args: {}, call_id: 'call-1' }),
    )
    // A per-project tool sees the ACTIVE project, while project_slug stays the owner.
    expect(seenProjectId).toBe('acme')
  })

  test('dispatch uses the caller-threaded project_id when NO topic context is bound (warm-REPL sink path)', async () => {
    const reg = new ToolRegistry()
    let seen: { project_slug: string; project_id: string | null } | undefined
    reg.register({
      name: 'peek',
      description: '',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'read:project_data',
      approval_policy: 'auto',
      handler: async (_args, ctx) => {
        seen = { project_slug: ctx.project_slug, project_id: ctx.project_id }
        return { ok: true }
      },
    })
    const server = new McpServer({ project_slug: 'owner-slug', registry: reg })
    // No withTopicContext — the topic-agnostic sink threads the active project directly.
    await server.dispatch({ tool_name: 'peek', args: {}, call_id: 'c', project_id: 'acme' })
    expect(seen?.project_slug).toBe('owner-slug')
    expect(seen?.project_id).toBe('acme')
  })

  test('dispatch with neither a bound context NOR a threaded project_id → project_id null (General/system)', async () => {
    const reg = new ToolRegistry()
    let seenProjectId: string | null | undefined = 'sentinel'
    reg.register({
      name: 'peek',
      description: '',
      input_schema: sampleSchema,
      output_schema: sampleSchema,
      capability_required: 'read:project_data',
      approval_policy: 'auto',
      handler: async (_args, ctx) => {
        seenProjectId = ctx.project_id
        return { ok: true }
      },
    })
    const server = new McpServer({ project_slug: 'owner-slug', registry: reg })
    await server.dispatch({ tool_name: 'peek', args: {}, call_id: 'c' })
    expect(seenProjectId).toBeNull()
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
