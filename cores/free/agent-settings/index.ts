/**
 * agent-settings Core — public barrel (v0.1.0).
 *
 * Tier 1 free Core implementing the "tweak later" promise the
 * onboarding final-handoff makes ("you can rename / delete / merge
 * projects, switch personality, update my name later — just ask me").
 *
 * Eleven MCP tools:
 *   - list_projects       — current (non-deleted, non-archived) projects
 *   - rename_project      — rename + retitle the Telegram forum topic
 *   - delete_project      — soft-delete + close/archive the topic
 *   - archive_project     — reversible archive (0095): leave the rail, keep in
 *                           the Admin tab; close the topic
 *   - restore_project     — clear archived_at → back to the rail
 *   - merge_projects      — move context + soft-delete `from` + archive
 *   - update_personality  — agent archetype / description phrase
 *   - update_agent_name   — agent display name
 *   - connect_telegram    — mint a fresh one-time Telegram bind deep link
 *                           (Item 3 resumable connect, 2026-06-10)
 *   - get_engagement_mode — read a shared project's agent engagement mode
 *   - set_engagement_mode — set tag_gated / all_messages (Connect §1.5)
 *
 * Projects mutate the canonical per-project `projects` table (migration
 * 0038 + soft-delete columns from 0053). Personality + agent name
 * mutate the platform instance registry row via an injected
 * `AgentProfileBackend` (the per-instance gateway opens registry.db RO at
 * boot, so writes route through the RW seam the persona-sync onboarding
 * hook already uses). Every successful mutation emits a plain-text
 * Telegram confirmation.
 *
 * Wiring: registered by `gateway/cores/install-bundled.ts` via the
 * `agent_settings` `CoreBackendFactory` (built in
 * `gateway/index.ts:buildCoresBackendFactories`). The tool names are
 * surfaced to the owner's CC subprocess via the tool-mention fragment in
 * `runtime/system-prompt.ts` (AGENT_SETTINGS_TOOLS_FRAGMENT).
 */

export const __MODULE__ = '@neutronai/agent-settings' as const

export {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  READ_CAPABILITY,
  TELEGRAM_CAPABILITY,
  TOOL_NAMES,
  WRITE_CAPABILITY,
  loadManifest,
  type AgentSettingsToolName,
} from './src/manifest.ts'

export {
  CONNECT_TELEGRAM_UNAVAILABLE_ERROR,
  SETTINGS_BACKEND_UNAVAILABLE_ERROR,
  buildAgentSettingsBackend,
  composePersonality,
  parsePersonality,
  type AgentProfileBackend,
  type PersonalityView,
  type ProjectView,
  type TelegramBindLinkMinter,
  type AgentSettingsBackend,
  type AgentSettingsBackendOptions,
  type AgentSettingsTelegram,
} from './src/backend.ts'

export {
  buildTools,
  type ArchiveProjectInput,
  type ArchiveProjectOutput,
  type BuiltTools,
  type ConnectTelegramOutput,
  type DeleteProjectInput,
  type DeleteProjectOutput,
  type RestoreProjectInput,
  type RestoreProjectOutput,
  type GetEngagementModeInput,
  type GetEngagementModeOutput,
  type ListProjectsOutput,
  type MergeProjectsInput,
  type MergeProjectsOutput,
  type RenameProjectInput,
  type RenameProjectOutput,
  type SetEngagementModeInput,
  type SetEngagementModeOutput,
  type ToolDeps,
  type UpdateAgentNameInput,
  type UpdateAgentNameOutput,
  type UpdatePersonalityInput,
  type UpdatePersonalityOutput,
} from './src/tools.ts'

// ── X2: typed Core module contract ──────────────────────────────────────
// The ONE declaration the install composer (`gateway/cores/install-bundled.ts`)
// reads instead of duck-typing barrel exports + a hardcoded backend-key table.
// `backendKey` is the `ToolDeps` key a bare backend primitive maps onto; when
// the backend factory returns an already-shaped object it is passed through
// verbatim. Conformance: cores/runtime/__tests__/define-core-conformance.test.ts.
import { defineCore } from '@neutronai/cores-sdk'
import { CORE_SLUG as CORE_SLUG_X2, TOOL_NAMES as TOOL_NAMES_X2 } from './src/manifest.ts'
import { buildTools as buildTools_X2 } from './src/tools.ts'

export const core = defineCore({
  slug: CORE_SLUG_X2,
  backendKey: 'backend',
  toolNames: TOOL_NAMES_X2,
  buildTools: buildTools_X2,
})
