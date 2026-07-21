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
 * - SPEC.md § Phases→Steps (Tier 1 free-Core inventory)
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
  RitualsUnavailableError,
  buildReminderStoreBackend,
  cancelOwnedReminders,
  type CancelOwnedRemindersInput,
  type CancelOwnedRemindersResult,
  type ReminderRow,
  type ReminderStoreBackendOptions,
  type RemindersBackend,
  type RemindersRitualService,
  type RitualProposeInput,
  type RitualProposeResult,
  type RitualStatusRowResult,
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
  SMART_WRAP_SENTINEL,
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
  type RitualsStatusOutput,
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

// ── X2: typed Core module contract ──────────────────────────────────────
// The ONE declaration the install composer (`gateway/cores/install-bundled.ts`)
// reads instead of duck-typing barrel exports + a hardcoded backend-key table.
// `backendKey` is the `ToolDeps` key a bare backend primitive maps onto; when
// the backend factory returns an already-shaped object it is passed through
// verbatim. Conformance: cores/runtime/__tests__/define-core-conformance.test.ts.
import { defineCore } from '@neutronai/cores-sdk'
import { CORE_SLUG as CORE_SLUG_X2, TOOL_NAMES as TOOL_NAMES_X2 } from './src/manifest.ts'
import { buildTools as buildTools_X2 } from './src/tools.ts'
import { buildExtraTools as buildExtraTools_X2 } from './src/mcp-tools-extra.ts'

export const core = defineCore({
  slug: CORE_SLUG_X2,
  backendKey: 'backend',
  toolNames: TOOL_NAMES_X2,
  buildTools: buildTools_X2,
  buildExtraTools: buildExtraTools_X2,
})
