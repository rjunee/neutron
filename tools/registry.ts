/**
 * @neutronai/tools — tool registry.
 *
 * Lifts the auto-discovery shape from Hermes `tools/registry.py`
 * (zero-config registration) and the capability-required gating from
 * OpenClaw `plugin-sdk/`. Tools register with a name, JSON Schema, handler
 * function, declared `capability_required`, and an `approval_policy` that
 * names the HITL surface (see `approval.ts`).
 *
 * Design notes:
 *
 * - The registry is in-memory + per-process. There is exactly ONE registry
 *   per gateway boot (one instance = one process), instantiated in
 *   `gateway/module-graph.ts` and handed to every consumer via the
 *   ModuleContext.
 *
 * - Names are unique. A second `register` for the same name throws — we
 *   prefer loud-on-boot over silent-overwrite-by-load-order.
 *
 * - Schema validation is JSON-Schema-shaped (loose `Record<string, unknown>`)
 *   per the locked Core SDK contract in `core-sdk/types.ts`. A real
 *   schema-validator (Ajv / similar) is plugged in by callers; the registry
 *   itself is unopinionated about validation engine.
 *
 * - `capability_required` is required at registration time. The dispatcher
 *   in `gateway/` cross-checks against the owner's resolved capability set
 *   before invoking the handler — fails closed on undeclared capability.
 *
 * - Handlers are async and receive the parsed args + a per-call context
 *   that carries `project_slug`, `topic_id`, `call_id`. Handlers return
 *   JSON-serialisable data; throws bubble up as `error` events.
 */

import type { JsonSchemaDocument, NeutronCapability } from '../core-sdk/types.ts'

export type ApprovalPolicy = 'auto' | 'prompt-user' | 'prompt-admin'

/** Per-call context handed to a tool handler at invocation time. */
export interface ToolCallContext {
  project_slug: string
  /**
   * The ACTIVE project of the composing turn (the project the chat/agent turn
   * belongs to), or NULL for the General surface / cron-spawned / system calls.
   * SEPARATE from `project_slug` (the owner/instance boundary, constant on a
   * single-owner Open box): `project_slug` bounds *which owner*, `project_id`
   * selects *which project within it*. A per-project tool (the `work_board_*`
   * board tools + the trident build-dispatch tools) resolves its storage scope
   * from BOTH via `workBoardScopeKey(project_slug, project_id)`, so a build/item
   * created while chatting in project X lands on X's board, not General. Owner-
   * scoped tools (doc_search, reminders, …) keep using `project_slug` alone.
   */
  project_id: string | null
  /** Topic the call originated from. NULL for cron-spawned / system calls. */
  topic_id: string | null
  call_id: string
  /** Speaker user_id for group-project turns. NULL for solo or system. */
  speaker_user_id: string | null
}

export interface ToolHandler {
  (args: unknown, ctx: ToolCallContext): Promise<unknown>
}

export interface ToolRegistration {
  name: string
  description: string
  input_schema: JsonSchemaDocument
  output_schema: JsonSchemaDocument
  capability_required: NeutronCapability
  approval_policy: ApprovalPolicy
  handler: ToolHandler
  /**
   * P0-1 — hide this tool from the spawned agent's native-MCP tool manifest
   * (`McpServer.listToolSchemas`). The tool stays registered (introspection,
   * tests, the in-process resolver), but is NOT advertised to the live agent —
   * used for surfaces whose handlers are still stubs (e.g. the `neutron-tools`
   * Hermes surface deferred to P3), so the agent isn't offered tools that always
   * throw "not implemented yet". Defaults to visible (`undefined`/`false`).
   */
  agent_hidden?: boolean
}

/**
 * In-memory tool registry. One per gateway process. Construct via
 * `new ToolRegistry()`; share via the gateway ModuleContext.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolRegistration>()

  /**
   * Register a tool. Throws if `name` is already registered — registration
   * conflicts at boot are fatal so two modules accidentally claiming the
   * same tool name fail loud rather than silently shadow each other.
   */
  register(reg: ToolRegistration): void {
    if (this.tools.has(reg.name)) {
      throw new Error(`tool '${reg.name}' is already registered`)
    }
    this.tools.set(reg.name, reg)
  }

  /** Look up a tool by name. Returns undefined if not registered. */
  get(name: string): ToolRegistration | undefined {
    return this.tools.get(name)
  }

  /** Snapshot of all registered tools, sorted by name for deterministic output. */
  list(): ToolRegistration[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Number of registered tools. */
  size(): number {
    return this.tools.size
  }

  /**
   * Remove a tool. Used by Cores at uninstall. Returns true if removed,
   * false if it wasn't registered.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name)
  }
}
