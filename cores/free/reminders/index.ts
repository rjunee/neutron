/**
 * @neutronai/reminders-core — public barrel.
 *
 * Tier 1 free Reminders Core. Wraps the existing `@neutronai/reminders`
 * engine (per-project SQLite `reminders` table from migration 0004) and
 * surfaces four MCP tools to the launcher: create, list, snooze, and
 * cancel reminders. Bundled into the public OSS repo at
 * `cores/free/reminders/` per the locked 2-tier Cores model (see
 * `docs/research/neutron-cores-marketplace-split-2026-05-17.md`).
 *
 * Initial scaffold (Sprint cores-free-reminders-tier1, 2026-05-17):
 * manifest, ReminderStore-adapter backend, capability-gated tools,
 * and unit tests are in place. UI surfacing (launcher icon) is purely
 * manifest metadata — the actual launcher tab lands in P5.3.
 *
 * Cross-refs:
 * - SPEC.md § Phases→Steps (Tier 1 Cores buildout; TODO(K10): root SPEC.md not yet in this repo)
 * - docs/research/neutron-cores-marketplace-split-2026-05-17.md (2-tier model)
 * - cores/sdk/SDK-CONTRACT.md (the API surface this Core consumes)
 * - cores/runtime (install / capability gate / audit log)
 * - reminders/ (the reminders engine this Core wraps)
 */

export const __MODULE__ = '@neutronai/reminders-core' as const

export {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  READ_CAPABILITY,
  TOOL_NAMES,
  WRITE_CAPABILITY,
  loadManifest,
  type RemindersToolName,
} from './src/manifest.ts'

export {
  CORE_SOURCE_TAG,
  ReminderConvertUnsupportedError,
  buildReminderStoreBackend,
  cancelOwnedReminders,
  type CancelOwnedRemindersInput,
  type CancelOwnedRemindersResult,
  type ReminderRow,
  type ReminderStoreBackendOptions,
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
  type RemindersUpdateInput,
  type RemindersUpdateResult,
} from './src/backend.ts'

export {
  REMINDER_PATTERN_NAMES,
  SMART_WRAP_PRELUDE,
  UnknownReminderPatternError,
  buildSmartWrapComposer,
  isReminderPatternName,
  type ReminderMode,
  type ReminderPatternName,
  type SmartWrapComposer,
  type SmartWrapDeps,
  type SmartWrapInput,
  type SmartWrapResult,
} from './src/smart-wrap.ts'

export {
  MAX_FUTURE_DRIFT_SECONDS,
  MAX_PAST_DRIFT_SECONDS,
  executeRemindCommand,
  parseAndExecuteRemindCommand,
  parseRemindCommand,
  resolveTimeSpec,
  type RemindCommand,
  type RemindCommandErrorCode,
  type RemindCommandResponse,
  type RemindExecuteContext,
  type ResolvedTimeSpec,
} from './src/chat-commands.ts'

export {
  buildExtraTools,
  type BuiltExtraTools,
  type ExtraToolDeps,
} from './src/mcp-tools-extra.ts'

export { LAUNCHER_ICON, type LauncherIconMeta } from './src/ui/launcher-icon.ts'
export { APP_TAB_SURFACE, type AppTabSurfaceMeta } from './src/ui/app-tab-surface.ts'

// Re-export for advanced callers that want to construct their own
// store explicitly (e.g. tests that need to inspect raw engine rows).
// The default integration path uses `buildReminderStoreBackend({...})`
// which constructs the store internally.
export { ReminderStore } from '@neutronai/reminders'

export {
  buildTools,
  type BuiltTools,
  type RemindersListOutput,
  type ToolDeps,
} from './src/tools.ts'
