/**
 * @neutronai/reminders-core — capability-guarded MCP tool wiring.
 *
 * Four tools the manifest declares (reminders_create / reminders_list /
 * reminders_snooze / reminders_cancel). Each is wrapped by the
 * Sprint 31 `CapabilityGuard.wrapToolHandler` so every dispatch:
 *   - records `op='tool_call' outcome='ok'` on success
 *   - records `op='tool_call' outcome='capability_denied'` + throws
 *     `CapabilityDeniedError` when the manifest's tool/capability
 *     declarations don't match
 *   - records `op='tool_call' outcome='error'` if the inner handler
 *     throws (and re-throws the error)
 *
 * The runtime composer (P3+) registers `buildTools(deps)` output with
 * the MCP host at install time; for tests, the helpers are directly
 * callable. Capability strings are imported from `manifest.ts` so a
 * stray edit to the manifest body that drifts from the locked
 * read:/write:reminders.db pair surfaces as a tool-mismatch the guard
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
import {
  ReminderConvertUnsupportedError,
  type ReminderRow,
  type RemindersBackend,
  type RemindersCancelInput,
  type RemindersCancelResult,
  type RemindersConvertToTaskInput,
  type RemindersConvertToTaskResult,
  type RemindersCreateInput,
  type RemindersCreateResult,
  type RemindersListInput,
  type RemindersSnoozeInput,
  type RemindersSnoozeResult,
} from './backend.ts'

export interface RemindersListOutput {
  results: ReminderRow[]
}

export type {
  ReminderRow,
  RemindersCancelInput,
  RemindersCancelResult,
  RemindersConvertToTaskInput,
  RemindersConvertToTaskResult,
  RemindersCreateInput,
  RemindersCreateResult,
  RemindersListInput,
  RemindersSnoozeInput,
  RemindersSnoozeResult,
} from './backend.ts'

/**
 * Bundle of dependencies the tools dispatch against. The runtime
 * composer (P3+) constructs this at install time and passes it into
 * `buildTools` — tests pass mocks directly.
 */
export interface ToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  backend: RemindersBackend
}

export interface BuiltTools {
  reminders_create: (input: RemindersCreateInput) => Promise<RemindersCreateResult>
  reminders_list: (input: RemindersListInput) => Promise<RemindersListOutput>
  reminders_snooze: (input: RemindersSnoozeInput) => Promise<RemindersSnoozeResult>
  reminders_cancel: (input: RemindersCancelInput) => Promise<RemindersCancelResult>
  reminders_convert_to_task: (
    input: RemindersConvertToTaskInput,
  ) => Promise<RemindersConvertToTaskResult>
}

/**
 * Construct the four tool handlers, each wrapped by the Sprint 31
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

  const reminders_create = guard.wrapToolHandler<RemindersCreateInput, RemindersCreateResult>({
    tool_name: 'reminders_create',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: RemindersCreateInput): Promise<RemindersCreateResult> => {
      return deps.backend.create(input)
    },
  })

  const reminders_list = guard.wrapToolHandler<RemindersListInput, RemindersListOutput>({
    tool_name: 'reminders_list',
    capability_required: READ_CAPABILITY,
    fn: async (input: RemindersListInput): Promise<RemindersListOutput> => {
      const results = await deps.backend.list(input)
      return { results }
    },
  })

  const reminders_snooze = guard.wrapToolHandler<RemindersSnoozeInput, RemindersSnoozeResult>({
    tool_name: 'reminders_snooze',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: RemindersSnoozeInput): Promise<RemindersSnoozeResult> => {
      return deps.backend.snooze(input)
    },
  })

  const reminders_cancel = guard.wrapToolHandler<RemindersCancelInput, RemindersCancelResult>({
    tool_name: 'reminders_cancel',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: RemindersCancelInput): Promise<RemindersCancelResult> => {
      return deps.backend.cancel(input)
    },
  })

  const reminders_convert_to_task = guard.wrapToolHandler<
    RemindersConvertToTaskInput,
    RemindersConvertToTaskResult
  >({
    tool_name: 'reminders_convert_to_task',
    capability_required: WRITE_CAPABILITY,
    fn: async (
      input: RemindersConvertToTaskInput,
    ): Promise<RemindersConvertToTaskResult> => {
      if (deps.backend.convertToTask === undefined) {
        throw new ReminderConvertUnsupportedError(
          'reminders_convert_to_task: backend has no convertToTask wired',
        )
      }
      return deps.backend.convertToTask(input)
    },
  })

  return {
    reminders_create,
    reminders_list,
    reminders_snooze,
    reminders_cancel,
    reminders_convert_to_task,
  }
}
