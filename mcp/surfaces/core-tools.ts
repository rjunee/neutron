/**
 * @neutronai/mcp — core-tools surface (per-Core dynamic tools).
 *
 * P1 S4 ships the surface shape — a per-Core registration helper that scopes
 * tool names with a `core_id` prefix to prevent collisions across Cores. P3
 * wires the Cores dispatcher into this; for S4 we expose just the registration
 * primitive + a `registerCoreTool` helper that handles the prefixing.
 */

import type { ToolRegistry, ToolRegistration } from '../../tools/registry.ts'

export interface CoreToolRegistrationInput extends Omit<ToolRegistration, 'name'> {
  /** The unprefixed name as the Core sees it. */
  base_name: string
}

/**
 * Register a Core's tool under a `<core_id>:<base_name>` namespace. The
 * runtime resolver strips the prefix before calling back into the Core's
 * handler — that detail is handled by the Cores dispatcher in P3.
 */
export function registerCoreTool(
  registry: ToolRegistry,
  core_id: string,
  input: CoreToolRegistrationInput,
): string {
  const name = `${core_id}:${input.base_name}`
  const reg: ToolRegistration = {
    name,
    description: input.description,
    input_schema: input.input_schema,
    output_schema: input.output_schema,
    capability_required: input.capability_required,
    approval_policy: input.approval_policy,
    handler: input.handler,
  }
  registry.register(reg)
  return name
}

/**
 * Drop every tool registered under a `<core_id>:` prefix. Used at Core
 * uninstall time. Returns the count removed.
 */
export function unregisterCoreTools(registry: ToolRegistry, core_id: string): number {
  const prefix = `${core_id}:`
  const names = registry.list().map((r) => r.name).filter((n) => n.startsWith(prefix))
  for (const n of names) registry.unregister(n)
  return names.length
}
