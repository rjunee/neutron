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

import type { Capability, JsonSchemaDocument } from '@neutronai/core-sdk/types.ts'

export type ApprovalPolicy = 'auto' | 'prompt-user' | 'prompt-admin'

/**
 * X1 — where a registered tool comes from. The dispatch-time capability gate
 * (`McpServer.dispatch`) reads this to attribute each capability verdict. A
 * discriminated union so a tool with NO Core installation record is EXPLICITLY
 * classified as a first-class `platform` tool, never left unclassified / silently
 * allow-all:
 *
 *   - `platform` — a first-party, gateway-composed tool (work_board, dispatch_agent,
 *     doc_search, skill_forge, memory_search, message_search, create_project, …).
 *     No Core install record exists for these (the gap the plan calls out); this is
 *     their explicit policy class. Their HITL policy travels on
 *     {@link ToolRegistration.approval_policy}.
 *   - `core` — a tool contributed by a bundled / third-party Core, carrying the
 *     Core's `slug` (from `defineCore()`) AND the Core's manifest-declared
 *     capability grant list (`declared_capabilities`), both stamped at the single
 *     install chokepoint (`install-bundled.ts`). Carrying the declared grant on the
 *     registration lets the dispatch-time gate consult a REAL per-Core capability
 *     source (the same `manifest.capabilities` the cores runtime enforces on) with
 *     NO gateway↔cores wiring — the grant rides the registration. NOTE: this is the
 *     Core's DECLARED grant, not an owner-resolved allow/deny set — an owner-level
 *     resolved capability grant does not exist yet and is decision D-9 (enforcement).
 */
export type ToolProvenance =
  | { readonly kind: 'platform' }
  | { readonly kind: 'core'; readonly slug: string; readonly declared_capabilities: readonly string[] }

/**
 * The provenance stamped on any registration that declares none: an explicit
 * platform-tool marker. Exported so dispatch + tests reference the exact value
 * the registry normalizes to.
 */
export const PLATFORM_TOOL_PROVENANCE: ToolProvenance = { kind: 'platform' }

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
  /**
   * The capability this tool exercises — the validated-open-string form
   * (`<verb>:<resource>`, `Capability`). The registry gates on STRING
   * EQUALITY against the owner's resolved capability set, so it accepts the
   * open shape: first-party sidecar + third-party Cores legitimately declare
   * capabilities outside the platform-known set (`read:notes.db`,
   * `connect:google-ads`). Use `isKnownCapability()` from
   * `@neutronai/cores-sdk` where you need the platform-known subset.
   */
  capability_required: Capability
  approval_policy: ApprovalPolicy
  handler: ToolHandler
  /**
   * X1 — where this tool comes from, for the dispatch-time capability gate.
   * OPTIONAL at the call site: a registration that omits it is normalized by
   * {@link ToolRegistry.register} to {@link PLATFORM_TOOL_PROVENANCE} (an explicit
   * platform-tool classification — the 19 first-party sidecar surfaces all take
   * this default). The bundled-Core install path sets `{ kind: 'core', slug }` so
   * a Core tool's verdict is attributed to its Core. After registration this is
   * always present (the registry stamps it), so `registry.get(name).provenance`
   * is concrete.
   */
  provenance?: ToolProvenance
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
    // X1 — every stored registration carries a CONCRETE provenance so the
    // dispatch-time capability gate can attribute its verdict without a fallback.
    // A registration that declares none is EXPLICITLY classified as a platform
    // tool (not left unclassified / silently allow-all); the bundled-Core install
    // path passes `{ kind: 'core', slug }` at its single chokepoint.
    const normalized: ToolRegistration =
      reg.provenance === undefined ? { ...reg, provenance: PLATFORM_TOOL_PROVENANCE } : reg
    this.tools.set(reg.name, normalized)
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
