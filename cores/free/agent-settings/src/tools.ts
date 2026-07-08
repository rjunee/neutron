/**
 * @neutronai/agent-settings — capability-guarded MCP tool wiring.
 *
 * Eleven tools the manifest declares (list_projects / rename_project /
 * delete_project / archive_project / restore_project / merge_projects /
 * update_personality / update_agent_name / connect_telegram /
 * get_engagement_mode / set_engagement_mode). Each is wrapped by the Sprint 31
 * `CapabilityGuard.wrapToolHandler` so every dispatch:
 *   - records `op='tool_call' outcome='ok'` on success
 *   - records `op='tool_call' outcome='capability_denied'` + throws
 *     `CapabilityDeniedError` when the manifest's tool/capability
 *     declarations don't match
 *   - records `op='tool_call' outcome='error'` if the inner handler
 *     throws (and re-throws)
 *
 * The handlers delegate to a `AgentSettingsBackend` (backend.ts) that
 * mutates the canonical per-project `projects` table + the platform
 * registry agent profile, and emits a Telegram confirmation on every
 * successful mutation.
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
  PersonalityView,
  ProjectView,
  AgentSettingsBackend,
} from './backend.ts'
// L3 (2026-07) — the mode vocabulary lives in the node-free `contracts` leaf.
import type { AgentEngagementMode } from '../../../../contracts/agent-engagement.ts'

export interface ListProjectsOutput {
  projects: ProjectView[]
}
export interface RenameProjectInput {
  old_name: string
  new_name: string
}
export interface RenameProjectOutput {
  success: boolean
  project?: ProjectView
}
export interface DeleteProjectInput {
  name: string
}
export interface DeleteProjectOutput {
  success: boolean
  removed?: { name: string; context_archived_at: string | null }
}
export interface ArchiveProjectInput {
  name: string
}
export interface ArchiveProjectOutput {
  success: boolean
  archived?: { name: string; archived_at: string }
}
export interface RestoreProjectInput {
  name: string
}
export interface RestoreProjectOutput {
  success: boolean
  restored?: { name: string }
}
export interface MergeProjectsInput {
  from_name: string
  into_name: string
}
export interface MergeProjectsOutput {
  success: boolean
  merged_project?: ProjectView
}
export interface UpdatePersonalityInput {
  new_archetype?: string
  new_description?: string
}
export interface UpdatePersonalityOutput {
  success: boolean
  personality?: PersonalityView
  /** Honest failure reason when the registry writer is unavailable
   *  (Argus r5 IMPORTANT). Relayed verbatim to the owner CC / user. */
  error?: string
}
export interface UpdateAgentNameInput {
  new_name: string
}
export interface UpdateAgentNameOutput {
  success: boolean
  agent_name?: string | null
  /** Honest failure reason when the registry writer is unavailable
   *  (Argus r5 IMPORTANT). Relayed verbatim to the owner CC / user. */
  error?: string
}
export interface GetEngagementModeInput {
  project_name: string
}
export interface GetEngagementModeOutput {
  success: boolean
  project_name?: string
  mode?: AgentEngagementMode
  /** Honest failure reason (e.g. unknown project). */
  error?: string
}
export interface SetEngagementModeInput {
  project_name: string
  mode: AgentEngagementMode
}
export interface SetEngagementModeOutput {
  success: boolean
  project_name?: string
  mode?: AgentEngagementMode
  /** Honest failure reason (unknown project / invalid mode). */
  error?: string
}
export interface ConnectTelegramOutput {
  success: boolean
  /** Fresh one-time `https://t.me/<bot>?start=bind_<token>` deep link. */
  deep_link?: string
  /** Link TTL the agent should mention to the user (60 per spec). */
  expires_in_minutes?: number
  /** Honest failure reason when bind-link minting is unwired / failed.
   *  Relayed verbatim to the owner CC / user. */
  error?: string
}

/**
 * Dependencies the tools dispatch against. The runtime composer
 * constructs this at install time via the install-bundled backend
 * factory and passes it into `buildTools`; tests pass mocks directly.
 */
export interface ToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  backend: AgentSettingsBackend
}

export interface BuiltTools {
  list_projects: (input: Record<string, never>) => Promise<ListProjectsOutput>
  rename_project: (input: RenameProjectInput) => Promise<RenameProjectOutput>
  delete_project: (input: DeleteProjectInput) => Promise<DeleteProjectOutput>
  archive_project: (input: ArchiveProjectInput) => Promise<ArchiveProjectOutput>
  restore_project: (input: RestoreProjectInput) => Promise<RestoreProjectOutput>
  merge_projects: (input: MergeProjectsInput) => Promise<MergeProjectsOutput>
  update_personality: (
    input: UpdatePersonalityInput,
  ) => Promise<UpdatePersonalityOutput>
  update_agent_name: (
    input: UpdateAgentNameInput,
  ) => Promise<UpdateAgentNameOutput>
  connect_telegram: (
    input: Record<string, never>,
  ) => Promise<ConnectTelegramOutput>
  get_engagement_mode: (
    input: GetEngagementModeInput,
  ) => Promise<GetEngagementModeOutput>
  set_engagement_mode: (
    input: SetEngagementModeInput,
  ) => Promise<SetEngagementModeOutput>
}

/**
 * Construct the eleven tool handlers, each wrapped by the Sprint 31
 * `CapabilityGuard.wrapToolHandler` so every dispatch is audited. The
 * capability strings match the manifest's `tools[]` declarations
 * exactly — wrapping with a different `capability_required` value trips
 * the guard's `capability_mismatch` check at the FIRST call.
 */
export function buildTools(deps: ToolDeps): BuiltTools {
  const guard = new CapabilityGuard({
    manifest: deps.manifest,
    core_slug: CORE_SLUG,
    project_slug: deps.project_slug,
    audit: deps.audit,
  })

  const list_projects = guard.wrapToolHandler<
    Record<string, never>,
    ListProjectsOutput
  >({
    tool_name: 'list_projects',
    capability_required: READ_CAPABILITY,
    fn: async (): Promise<ListProjectsOutput> => {
      return deps.backend.listProjects()
    },
  })

  const rename_project = guard.wrapToolHandler<
    RenameProjectInput,
    RenameProjectOutput
  >({
    tool_name: 'rename_project',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: RenameProjectInput): Promise<RenameProjectOutput> => {
      return deps.backend.renameProject(input.old_name, input.new_name)
    },
  })

  const delete_project = guard.wrapToolHandler<
    DeleteProjectInput,
    DeleteProjectOutput
  >({
    tool_name: 'delete_project',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: DeleteProjectInput): Promise<DeleteProjectOutput> => {
      return deps.backend.deleteProject(input.name)
    },
  })

  const archive_project = guard.wrapToolHandler<
    ArchiveProjectInput,
    ArchiveProjectOutput
  >({
    tool_name: 'archive_project',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: ArchiveProjectInput): Promise<ArchiveProjectOutput> => {
      return deps.backend.archiveProject(input.name)
    },
  })

  const restore_project = guard.wrapToolHandler<
    RestoreProjectInput,
    RestoreProjectOutput
  >({
    tool_name: 'restore_project',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: RestoreProjectInput): Promise<RestoreProjectOutput> => {
      return deps.backend.restoreProject(input.name)
    },
  })

  const merge_projects = guard.wrapToolHandler<
    MergeProjectsInput,
    MergeProjectsOutput
  >({
    tool_name: 'merge_projects',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: MergeProjectsInput): Promise<MergeProjectsOutput> => {
      return deps.backend.mergeProjects(input.from_name, input.into_name)
    },
  })

  const update_personality = guard.wrapToolHandler<
    UpdatePersonalityInput,
    UpdatePersonalityOutput
  >({
    tool_name: 'update_personality',
    capability_required: WRITE_CAPABILITY,
    fn: async (
      input: UpdatePersonalityInput,
    ): Promise<UpdatePersonalityOutput> => {
      const patch: { new_archetype?: string; new_description?: string } = {}
      if (input.new_archetype !== undefined) patch.new_archetype = input.new_archetype
      if (input.new_description !== undefined) {
        patch.new_description = input.new_description
      }
      return deps.backend.updatePersonality(patch)
    },
  })

  const update_agent_name = guard.wrapToolHandler<
    UpdateAgentNameInput,
    UpdateAgentNameOutput
  >({
    tool_name: 'update_agent_name',
    capability_required: WRITE_CAPABILITY,
    fn: async (
      input: UpdateAgentNameInput,
    ): Promise<UpdateAgentNameOutput> => {
      return deps.backend.updateAgentName(input.new_name)
    },
  })

  const connect_telegram = guard.wrapToolHandler<
    Record<string, never>,
    ConnectTelegramOutput
  >({
    tool_name: 'connect_telegram',
    capability_required: WRITE_CAPABILITY,
    fn: async (): Promise<ConnectTelegramOutput> => {
      return deps.backend.connectTelegram()
    },
  })

  const get_engagement_mode = guard.wrapToolHandler<
    GetEngagementModeInput,
    GetEngagementModeOutput
  >({
    tool_name: 'get_engagement_mode',
    capability_required: READ_CAPABILITY,
    fn: async (
      input: GetEngagementModeInput,
    ): Promise<GetEngagementModeOutput> => {
      return deps.backend.getEngagementMode(input.project_name)
    },
  })

  const set_engagement_mode = guard.wrapToolHandler<
    SetEngagementModeInput,
    SetEngagementModeOutput
  >({
    tool_name: 'set_engagement_mode',
    capability_required: WRITE_CAPABILITY,
    fn: async (
      input: SetEngagementModeInput,
    ): Promise<SetEngagementModeOutput> => {
      return deps.backend.setEngagementMode(input.project_name, input.mode)
    },
  })

  return {
    list_projects,
    rename_project,
    delete_project,
    archive_project,
    restore_project,
    merge_projects,
    update_personality,
    update_agent_name,
    connect_telegram,
    get_engagement_mode,
    set_engagement_mode,
  }
}
