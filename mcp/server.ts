/**
 * @neutronai/mcp — per-instance MCP server.
 *
 * One MCP server per instance, multiplexed across topics. P1 S4 ships the
 * in-process resolver shape that the GPT-5.5 API mcp-shim and CC-internal MCP
 * both consume; the stdio / Unix-socket transport layer ports in P1 S5+ when
 * production-tier instances spawn external Cores.
 *
 * The 3-surface factoring (`neutron-tools`, `core-tools`, `channel-tools`)
 * lives in `surfaces/`. The server is the multiplexer + dispatch layer.
 */

import type { ToolRegistry } from '../tools/registry.ts'
import { currentTopicContext, type TopicContext, withTopicContext } from './topic-context.ts'
import type { McpToolResolver } from '../runtime/adapters/gpt-5-5-api/mcp-shim.ts'

export interface McpServerOptions {
  project_slug: string
  registry: ToolRegistry
  /**
   * Capability gate hook. The dispatcher consults the instance's resolved
   * capability set before invoking a tool. Defaults to "always allow" —
   * P1 S4 wires the real per-instance capability source in the gateway
   * module-graph; this default keeps the tests + standalone use simple.
   */
  capability_gate?: (capability: string) => boolean
}

/**
 * The MCP server consumed by every substrate adapter. The shape mirrors
 * `McpToolResolver` so the gpt-5-5-api adapter can use it directly via the
 * mcp-shim — `server.resolve` IS a McpToolResolver.
 */
export class McpServer {
  private readonly project_slug: string
  private readonly registry: ToolRegistry
  private readonly capability_gate: (capability: string) => boolean

  constructor(options: McpServerOptions) {
    this.project_slug = options.project_slug
    this.registry = options.registry
    this.capability_gate = options.capability_gate ?? (() => true)
  }

  /**
   * Bind a topic context for a request and resolve a tool call. The
   * resolver shape is exactly what the GPT-5.5 mcp-shim expects, so the
   * adapter can pass `server.resolveBound(ctx)` directly.
   */
  resolveBound(ctx: TopicContext): McpToolResolver {
    return async (call) => {
      return withTopicContext(ctx, async () => {
        return this.dispatch({
          tool_name: call.tool_name,
          args: call.args,
          call_id: call.call_id,
        })
      })
    }
  }

  /**
   * Dispatch without binding context. Used by tests + by callers that
   * already bound a context frame. Throws on unknown tool, capability
   * gate fail, or handler error.
   */
  async dispatch(input: { tool_name: string; args: unknown; call_id: string }): Promise<unknown> {
    const reg = this.registry.get(input.tool_name)
    if (!reg) {
      throw new Error(`mcp: unknown tool '${input.tool_name}'`)
    }
    if (!this.capability_gate(reg.capability_required)) {
      throw new Error(
        `mcp: tool '${input.tool_name}' requires capability '${reg.capability_required}' which the project has not granted`,
      )
    }
    const ctx = currentTopicContextOrSystem(input.call_id, this.project_slug)
    return reg.handler(input.args, {
      project_slug: ctx.project_slug,
      topic_id: ctx.topic_id,
      call_id: ctx.call_id,
      speaker_user_id: ctx.speaker_user_id,
    })
  }

  /** Snapshot of registered tools — surfaces the registry through the server boundary. */
  listTools(): { name: string; description: string }[] {
    return this.registry.list().map((r) => ({ name: r.name, description: r.description }))
  }

  ownerSlug(): string {
    return this.project_slug
  }
}

/**
 * Resolve a per-call `ToolCallContext` shape: read the AsyncLocalStorage-
 * bound TopicContext if present, otherwise emit a system-call shape with
 * topic_id=null. The system-call path covers cron-spawned dispatches and
 * gateway-internal callers that aren't tied to a user topic.
 */
function currentTopicContextOrSystem(
  call_id: string,
  project_slug: string,
): {
  project_slug: string
  topic_id: string | null
  call_id: string
  speaker_user_id: string | null
} {
  const ctx = currentTopicContext()
  if (ctx) {
    return {
      project_slug,
      topic_id: ctx.topic_id,
      call_id: ctx.call_id || call_id,
      speaker_user_id: ctx.speaker_user_id,
    }
  }
  return { project_slug, topic_id: null, call_id, speaker_user_id: null }
}
