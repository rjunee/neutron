/**
 * @neutronai/tasks-core — capability-guarded MCP tool wiring.
 *
 * Five tools the manifest declares (tasks_create / tasks_list /
 * tasks_update / tasks_complete / tasks_delete). Each is wrapped by
 * the Sprint 31 `CapabilityGuard.wrapToolHandler` so every dispatch:
 *   - records `op='tool_call' outcome='ok'` on success
 *   - records `op='tool_call' outcome='capability_denied'` + throws
 *     `CapabilityDeniedError` when the manifest's tool/capability
 *     declarations don't match
 *   - records `op='tool_call' outcome='error'` if the inner handler
 *     throws (e.g. `TaskNotFoundError`) and re-throws the original
 *
 * The runtime composer (P3+) registers `buildTools(deps)` output with
 * the MCP host at install time; for tests, the helpers are directly
 * callable. Capability strings are imported from `manifest.ts` so a
 * stray edit to the manifest body that drifts from the locked
 * read:/write:tasks_core.db pair surfaces as a tool-mismatch the guard
 * rejects at the first dispatch.
 */

import {
  CapabilityGuard,
  type SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import {
  CORE_SLUG,
  READ_CAPABILITY,
  WRITE_CAPABILITY,
} from './manifest.ts'
import type {
  TaskCreateInput,
  TaskListInput,
  TaskRow,
  TaskStore,
  TaskUpdateFields,
} from './backend.ts'
import {
  buildExtraTools,
  type TasksPickNextInput,
  type TasksPickNextOutput,
} from './mcp-tools-extra.ts'
import type { PickNextService } from './pick-next.ts'

export interface TasksCreateInput extends TaskCreateInput {}

export interface TasksCreateOutput {
  id: string
  task: TaskRow
}

export interface TasksListInput extends TaskListInput {}

export interface TasksListOutput {
  results: TaskRow[]
}

export interface TasksUpdateInput {
  task_id: string
  fields: TaskUpdateFields
}

export interface TasksUpdateOutput {
  task: TaskRow
}

export interface TasksCompleteInput {
  task_id: string
}

export interface TasksCompleteOutput {
  task: TaskRow
}

export interface TasksDeleteInput {
  task_id: string
}

export interface TasksDeleteOutput {
  ok: true
  task_id: string
}

export type { TaskRow } from './backend.ts'

/**
 * Bundle of dependencies the tools dispatch against. The runtime
 * composer (P3+) constructs this at install time and passes it into
 * `buildTools` — tests pass mocks directly.
 *
 * `pickNext` is optional — when present, `buildTools` ALSO registers
 * the `tasks_pick_next` handler. When absent (legacy composer path
 * pre-Tasks-Core-S1, or a Core install without an LLM client wired),
 * only the 5 legacy handlers are returned.
 */
export interface ToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  store: TaskStore
  pickNext?: PickNextService
  /** User id threaded to pick-next for audit. Defaults to instance slug. */
  user_id?: string
}

export interface BuiltTools {
  tasks_create: (input: TasksCreateInput) => Promise<TasksCreateOutput>
  tasks_list: (input: TasksListInput) => Promise<TasksListOutput>
  tasks_update: (input: TasksUpdateInput) => Promise<TasksUpdateOutput>
  tasks_complete: (input: TasksCompleteInput) => Promise<TasksCompleteOutput>
  tasks_delete: (input: TasksDeleteInput) => Promise<TasksDeleteOutput>
  /** Present when `deps.pickNext` is supplied at construction time. */
  tasks_pick_next?: (input: TasksPickNextInput) => Promise<TasksPickNextOutput>
}

/**
 * Construct the five tool handlers, each wrapped by the Sprint 31
 * `CapabilityGuard.wrapToolHandler` so every dispatch is audited.
 *
 * The capability strings match the manifest's `tools[]` declarations
 * exactly — wrapping with a different `capability_required` value
 * trips the guard's `capability_mismatch` check at the FIRST call.
 */
export function buildTools(deps: ToolDeps): BuiltTools {
  const guard = new CapabilityGuard({
    manifest: deps.manifest,
    core_slug: CORE_SLUG,
    owner_slug: deps.project_slug,
    audit: deps.audit,
  })

  const tasks_create = guard.wrapToolHandler<TasksCreateInput, TasksCreateOutput>({
    tool_name: 'tasks_create',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: TasksCreateInput): Promise<TasksCreateOutput> => {
      const task = await deps.store.create(input)
      return { id: task.id, task }
    },
  })

  const tasks_list = guard.wrapToolHandler<TasksListInput, TasksListOutput>({
    tool_name: 'tasks_list',
    capability_required: READ_CAPABILITY,
    fn: async (input: TasksListInput): Promise<TasksListOutput> => {
      const results = await deps.store.list(input)
      return { results }
    },
  })

  const tasks_update = guard.wrapToolHandler<TasksUpdateInput, TasksUpdateOutput>({
    tool_name: 'tasks_update',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: TasksUpdateInput): Promise<TasksUpdateOutput> => {
      const task = await deps.store.update(input.task_id, input.fields)
      return { task }
    },
  })

  const tasks_complete = guard.wrapToolHandler<TasksCompleteInput, TasksCompleteOutput>({
    tool_name: 'tasks_complete',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: TasksCompleteInput): Promise<TasksCompleteOutput> => {
      const task = await deps.store.complete(input.task_id)
      return { task }
    },
  })

  const tasks_delete = guard.wrapToolHandler<TasksDeleteInput, TasksDeleteOutput>({
    tool_name: 'tasks_delete',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: TasksDeleteInput): Promise<TasksDeleteOutput> => {
      await deps.store.delete(input.task_id)
      return { ok: true, task_id: input.task_id }
    },
  })

  const built: BuiltTools = {
    tasks_create,
    tasks_list,
    tasks_update,
    tasks_complete,
    tasks_delete,
  }

  if (deps.pickNext !== undefined) {
    const extraDeps: Parameters<typeof buildExtraTools>[0] = {
      manifest: deps.manifest,
      project_slug: deps.project_slug,
      audit: deps.audit,
      pickNext: deps.pickNext,
    }
    if (deps.user_id !== undefined) extraDeps.user_id = deps.user_id
    const extra = buildExtraTools(extraDeps)
    built.tasks_pick_next = extra.tasks_pick_next
  }

  return built
}
