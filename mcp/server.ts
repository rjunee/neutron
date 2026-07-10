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

import {
  PLATFORM_TOOL_PROVENANCE,
  type ToolRegistration,
  type ToolRegistry,
} from '@neutronai/tools/registry.ts'
import { currentTopicContext, type TopicContext, withTopicContext } from './topic-context.ts'
import type { McpToolResolver } from '@neutronai/contracts/mcp-tool-resolver.ts'
import { emitSystemEvent } from '@neutronai/persistence/index.ts'

/**
 * X1 — the capability verdict the dispatch-time gate WOULD reach under
 * enforcement (decision D-9). In X1 this is LOG-ONLY: computed + journaled to
 * O4's `system_events`, NEVER acted on. Dispatch always proceeds exactly as it
 * did before this unit.
 *
 *   - `allow`              — capability granted AND `approval_policy: 'auto'`.
 *   - `gated-approval`     — capability granted but the tool's `approval_policy`
 *                            names a HITL surface ('prompt-user' / 'prompt-admin');
 *                            enforcement would request approval (D-9).
 *   - `denied-capability`  — the resolved capability gate does not grant the tool's
 *                            `capability_required`; enforcement would BLOCK.
 */
export type CapabilityVerdict = 'allow' | 'gated-approval' | 'denied-capability'

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
  async dispatch(input: {
    tool_name: string
    args: unknown
    call_id: string
    /**
     * The ACTIVE project of the composing turn. The topic-AGNOSTIC warm-REPL
     * `/tool-call` sink has no bound `TopicContext`, so it passes the active
     * project here (resolved from the session's per-project scope) — without it,
     * `currentTopicContextOrSystem` falls back to the owner/instance slug and
     * every named-project work-board write lands on General (the bug this fixes).
     * The `resolveBound` path leaves it undefined and reads the bound context's
     * own `project_id` instead.
     */
    project_id?: string | null
  }): Promise<unknown> {
    const reg = this.registry.get(input.tool_name)
    if (!reg) {
      throw new Error(`mcp: unknown tool '${input.tool_name}'`)
    }
    // X1 — evaluate the capability gate ONCE (as before), then compute + journal
    // this dispatch's verdict (LOG-ONLY). Pure observability: it does NOT gate
    // dispatch. Everything below stays byte-identical — the SAME `granted` boolean
    // drives the existing throw, and real enforcement (block / 'prompt-user') is
    // decision D-9 in a separate flagged PR.
    const granted = this.capability_gate(reg.capability_required)
    this.emitCapabilityVerdict(reg, this.verdictFor(reg, granted))
    if (!granted) {
      throw new Error(
        `mcp: tool '${input.tool_name}' requires capability '${reg.capability_required}' which the project has not granted`,
      )
    }
    const ctx = currentTopicContextOrSystem(input.call_id, this.project_slug, input.project_id)
    return reg.handler(input.args, {
      project_slug: ctx.project_slug,
      project_id: ctx.project_id,
      topic_id: ctx.topic_id,
      call_id: ctx.call_id,
      speaker_user_id: ctx.speaker_user_id,
    })
  }

  /**
   * X1 — the LOG-ONLY capability verdict for a tool: what the gate WOULD decide
   * under enforcement (D-9). Consults TWO real sources, without touching dispatch:
   *
   *   1. the enforcing `capability_gate` (`granted`, already evaluated once in
   *      `dispatch` — the predicate is NOT invoked an extra time). Allow-all in
   *      production today; a wired denying gate would also deny here.
   *   2. the tool's provenance: a CORE tool must have its `capability_required`
   *      in its Core's manifest-declared grant (`declared_capabilities`, stamped
   *      at install). This makes the verdict consult a REAL per-Core capability
   *      source in production (not just the allow-all default), so a Core tool
   *      whose capability was never declared journals `denied-capability`. Platform
   *      tools have no Core install record — they are granted as platform-builtin
   *      (their HITL policy is `approval_policy`).
   *
   * Pure function of the registration + that boolean; it does not touch dispatch.
   */
  private verdictFor(reg: ToolRegistration, granted: boolean): CapabilityVerdict {
    if (!granted) return 'denied-capability'
    const provenance = reg.provenance ?? PLATFORM_TOOL_PROVENANCE
    if (
      provenance.kind === 'core' &&
      !provenance.declared_capabilities.includes(reg.capability_required)
    ) {
      return 'denied-capability'
    }
    if (reg.approval_policy !== 'auto') return 'gated-approval'
    return 'allow'
  }

  /**
   * X1 — journal a dispatch's capability verdict to O4's `system_events`.
   * Fire-and-forget and fully guarded: this is observability on the dispatch
   * edge and MUST NEVER throw, reject, or otherwise perturb the dispatch it
   * observes (same never-throw contract O4 established for degrade sites —
   * `emitSystemEvent` already swallows sink throws/rejections; the try/catch
   * additionally covers payload construction). Collapses to a no-op when no
   * `system_events` sink is registered (unit tests / non-gateway contexts).
   */
  private emitCapabilityVerdict(reg: ToolRegistration, verdict: CapabilityVerdict): void {
    try {
      const provenance = reg.provenance ?? PLATFORM_TOOL_PROVENANCE
      void emitSystemEvent({
        event: 'capability_verdict',
        module: 'capability-gate',
        level: verdict === 'denied-capability' ? 'warn' : 'info',
        project_slug: this.project_slug,
        payload: {
          tool_name: reg.name,
          verdict,
          capability: reg.capability_required,
          approval_policy: reg.approval_policy,
          provenance,
          // Marks X1's mode; D-9 flips this to real enforcement.
          enforcement: 'log-only',
        },
      })
    } catch {
      // Observability must never perturb dispatch. Swallow.
    }
  }

  /** Snapshot of registered tools — surfaces the registry through the server boundary. */
  listTools(): { name: string; description: string }[] {
    return this.registry.list().map((r) => ({ name: r.name, description: r.description }))
  }

  /**
   * Full tool schemas for the native-MCP stdio bridge (P0-1). The persistent
   * REPL substrate enumerates these to write the per-session tools manifest the
   * `tools-bridge` advertises to the spawned `claude`, so the model emits a
   * structured `tool_use` whose args validate against the registered
   * `input_schema`. Mirrors `listTools()` but carries the input schema — this is
   * the discovery half; `dispatch()` is the invocation half.
   */
  listToolSchemas(): { name: string; description: string; input_schema: unknown }[] {
    return this.registry
      .list()
      .filter((r) => r.agent_hidden !== true)
      .map((r) => ({ name: r.name, description: r.description, input_schema: r.input_schema }))
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
  fallbackProjectId?: string | null,
): {
  project_slug: string
  project_id: string | null
  topic_id: string | null
  call_id: string
  speaker_user_id: string | null
} {
  const ctx = currentTopicContext()
  if (ctx) {
    // A bound TopicContext (the `resolveBound` adapter path) already knows the
    // originating topic's project — prefer it over any caller-supplied fallback.
    return {
      project_slug,
      project_id: ctx.project_id,
      topic_id: ctx.topic_id,
      call_id: ctx.call_id || call_id,
      speaker_user_id: ctx.speaker_user_id,
    }
  }
  // No bound context (the warm-REPL `/tool-call` sink path): use the active
  // project the caller threaded in. `project_slug` stays the owner/instance slug
  // (unchanged for owner-scoped tools); `project_id` carries the per-project
  // dimension the work-board / build tools scope on.
  return {
    project_slug,
    project_id: fallbackProjectId ?? null,
    topic_id: null,
    call_id,
    speaker_user_id: null,
  }
}
