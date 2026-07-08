/**
 * @neutronai/mcp — neutron-tools surface (Hermes 9-tool surface + Neutron extras).
 *
 * Hosts the assistant-primary tool surface that every Core can consume by
 * default. Names + shapes match the Hermes 9-tool inventory plus
 * Neutron-specific additions for the project / instance / topic primitives
 * that didn't exist in Hermes.
 *
 * P1 S4 ships only the registration shape — handler bodies are stubs that
 * throw `not implemented yet` so a tool surface is always discoverable
 * (introspection works) but a real call surfaces a clear error. P3 wires
 * the Cores layer + the production handlers.
 */

import type { ToolRegistry } from '@neutronai/tools/registry.ts'
import type { ToolHandler, ToolRegistration } from '@neutronai/tools/registry.ts'
import type { NeutronCapability } from '@neutronai/core-sdk/types.ts'

const objectSchema = { type: 'object', properties: {}, additionalProperties: true } as const

const stub = (name: string): ToolHandler => async () => {
  throw new Error(
    `mcp: tool '${name}' is registered but its production handler lands in a later sprint`,
  )
}

interface NeutronToolDef {
  name: string
  description: string
  capability_required: NeutronCapability
}

const NEUTRON_TOOLS: ReadonlyArray<NeutronToolDef> = [
  // Hermes 9-tool surface
  { name: 'conversations_list', description: 'List conversations for the current project', capability_required: 'read:project_data' },
  { name: 'conversation_get', description: 'Fetch a single conversation by id', capability_required: 'read:project_data' },
  { name: 'messages_read', description: 'Read messages from a conversation', capability_required: 'read:project_data' },
  { name: 'attachments_fetch', description: 'Fetch attachments by id', capability_required: 'read:project_data' },
  { name: 'events_poll', description: 'Poll for events without blocking', capability_required: 'read:project_data' },
  { name: 'events_wait', description: 'Long-poll for events with timeout', capability_required: 'read:project_data' },
  { name: 'messages_send', description: 'Send a message to a conversation', capability_required: 'write:project_data' },
  { name: 'permissions_list_open', description: 'List open HITL approval requests', capability_required: 'read:project_data' },
  { name: 'permissions_respond', description: 'Respond to an open HITL approval request', capability_required: 'write:project_data' },
  // Hermes channels
  { name: 'channels_list', description: 'List active channels for the current project', capability_required: 'read:project_data' },
  // Neutron-specific
  { name: 'project_list', description: 'List projects for the current instance', capability_required: 'read:project_data' },
  { name: 'project_create_topic', description: 'Create a new topic in a project', capability_required: 'write:project_data' },
  { name: 'instance_metadata_get', description: 'Read public instance metadata', capability_required: 'read:project_data' },
] as const

/**
 * Register the neutron-tools surface with the supplied registry. Returns
 * the array of registered names so the caller can assert against the
 * surface inventory in tests / observability.
 */
export function registerNeutronToolsSurface(registry: ToolRegistry): string[] {
  const registered: string[] = []
  for (const def of NEUTRON_TOOLS) {
    const reg: ToolRegistration = {
      name: def.name,
      description: def.description,
      input_schema: objectSchema,
      output_schema: objectSchema,
      capability_required: def.capability_required,
      approval_policy: 'auto',
      handler: stub(def.name),
      // P0-1 — every handler here is a stub that throws "lands in a later
      // sprint" (P3). Keep them registered for introspection/tests, but HIDE
      // them from the spawned agent's native-MCP tool manifest so the live
      // agent isn't offered always-failing tools to call mid-turn.
      agent_hidden: true,
    }
    registry.register(reg)
    registered.push(def.name)
  }
  return registered
}

export const NEUTRON_TOOL_NAMES = NEUTRON_TOOLS.map((t) => t.name) as readonly string[]
