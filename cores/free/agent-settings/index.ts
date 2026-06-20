/**
 * agent-settings Core — public barrel (v0.1.0).
 *
 * Tier 1 free Core implementing the "tweak later" promise the
 * onboarding final-handoff makes ("you can rename / delete / merge
 * projects, switch personality, update my name later — just ask me").
 *
 * Seven MCP tools:
 *   - list_projects      — current (non-deleted) projects
 *   - rename_project     — rename + retitle the Telegram forum topic
 *   - delete_project     — soft-delete + close/archive the topic
 *   - merge_projects     — move context + soft-delete `from` + archive
 *   - update_personality — agent archetype / description phrase
 *   - update_agent_name  — agent display name
 *   - connect_telegram   — mint a fresh one-time Telegram bind deep link
 *                          (Item 3 resumable connect, 2026-06-10)
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
 * `gateway/index.ts:buildCoresBackendFactories`). The six tool names are
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
  type BuiltTools,
  type ConnectTelegramOutput,
  type DeleteProjectInput,
  type DeleteProjectOutput,
  type ListProjectsOutput,
  type MergeProjectsInput,
  type MergeProjectsOutput,
  type RenameProjectInput,
  type RenameProjectOutput,
  type ToolDeps,
  type UpdateAgentNameInput,
  type UpdateAgentNameOutput,
  type UpdatePersonalityInput,
  type UpdatePersonalityOutput,
} from './src/tools.ts'
