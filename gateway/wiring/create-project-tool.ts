/**
 * @neutronai/gateway/wiring — `create_project` agent tool surface.
 *
 * Agent-native parity for the project-rail "Create Project" button: any project
 * the owner can create from the rail, the live agent can create too (mid-turn,
 * e.g. "spin up a project for my taxes"). Registered into the SAME `neutron`
 * tools registry the #87 tools-bridge advertises, so the chat REPL reaches it
 * as `mcp__neutron__create_project`.
 *
 * `approval_policy:'auto'` + `write:project_data` (mirrors `work_board_add`):
 * creating a project is a normal owner-scoped write, non-`agent_hidden` so it
 * shows in the manifest.
 *
 * SECURITY: `project_slug` is NEVER an agent-supplied argument — the service
 * binding reads it from the server-injected `ToolCallContext` (the instance
 * slug + the owner's user id), so the model cannot create projects in another
 * scope. The ONLY agent input is the project `name`.
 */

import type { JsonSchemaDocument } from '@neutronai/core-sdk/types.ts'
import type { ToolRegistry } from '@neutronai/tools/registry.ts'

export const CREATE_PROJECT_TOOL = 'create_project'

/**
 * The create-project service the tool drives — bound by the composer to the
 * shared `createProjectRow` + materialize + live-rail-refresh path (one code
 * path with the HTTP surface). `project_slug` / `speaker_user_id` come from the
 * server-injected `ToolCallContext`, never the agent.
 */
export interface CreateProjectToolService {
  create(input: {
    name: string
    project_slug: string
    /** NULL for solo/system turns — the binding defaults the rail-refresh target to the owner. */
    speaker_user_id: string | null
  }): Promise<{
    project_id: string
    name: string
    /** 'created' — new row; 'existing' — idempotent resolve; 'skipped' — the
     *  name maps to a SOFT-DELETED project (never resurrected → not a success). */
    outcome: 'created' | 'existing' | 'skipped'
  }>
}

const inputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'The new project name (1-128 chars). Becomes the project, its rail entry, and its Work Board.',
    },
  },
  required: ['name'],
  additionalProperties: false,
}

const outputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    project_id: { type: 'string' },
    name: { type: 'string' },
    created: { type: 'boolean' },
    error: { type: 'string' },
  },
  required: ['ok'],
}

interface CreateProjectArgs {
  name?: unknown
}

/**
 * Register the `create_project` tool against `registry`, backed by the shared
 * create-project service (the SAME path `POST /api/app/projects` uses). Returns
 * the registered tool name.
 */
export function registerCreateProjectToolSurface(
  registry: ToolRegistry,
  service: CreateProjectToolService,
): string[] {
  registry.register({
    name: CREATE_PROJECT_TOOL,
    description:
      'Create a new project for the owner. The project appears in the project rail and gets its own ' +
      'Chat + Work Board + Documents tabs. Use when the owner asks to start/spin up/track a new ' +
      'area of work as its own project. Returns the new project id. Idempotent on the project name ' +
      '(a name that resolves to an existing project returns it without creating a duplicate).',
    input_schema: inputSchema,
    output_schema: outputSchema,
    capability_required: 'write:project_data',
    approval_policy: 'auto',
    handler: async (args, ctx) => {
      const a = (args ?? {}) as CreateProjectArgs
      const name = (typeof a.name === 'string' ? a.name : '').trim()
      if (name.length === 0) {
        return { ok: false, error: 'name is required' }
      }
      if (name.length > 128) {
        return { ok: false, error: 'name must be 1-128 characters' }
      }
      const result = await service.create({
        name,
        project_slug: ctx.project_slug,
        speaker_user_id: ctx.speaker_user_id,
      })
      if (result.outcome === 'skipped') {
        // The name maps to a soft-deleted project — never resurrected, so this
        // is not a successful create.
        return {
          ok: false,
          error: 'a deleted project already uses this name — restore it or choose another name',
        }
      }
      return {
        ok: true,
        project_id: result.project_id,
        name: result.name,
        created: result.outcome === 'created',
      }
    },
  })
  return [CREATE_PROJECT_TOOL]
}
