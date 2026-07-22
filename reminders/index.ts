/**
 * @neutronai/reminders — public barrel.
 *
 * Instance-scoped reminders persisted in the per-project SQLite `reminders`
 * table (migration 0004).
 * The gateway module-graph wires the store + tick loop at boot and stops
 * them on graceful shutdown.
 */

export const __MODULE__ = '@neutronai/reminders' as const

export { ReminderStore, ALL_REMINDER_RECURRENCES } from './store.ts'
export type {
  Reminder,
  CreateReminderInput,
  CreateRecurringReminderInput,
  ReminderRecurrence,
} from './store.ts'

export { ReminderTickLoop } from './tick.ts'
export type {
  ReminderDispatcher,
  ReminderFiredHook,
  ReminderTickOptions,
} from './tick.ts'

// Executor-mode reminders — the ritual EXECUTOR + its durable run-history writer
// (plan task 4). The tick dispatch branch routes ritual rows to `fire()`; the
// composer builds the executor + passes the shared subagent registry / substrate
// turn / approval manager.
export { createRitualExecutor } from './ritual-executor.ts'
export type {
  RitualExecutor,
  RitualExecutorDeps,
  RitualTurn,
  RitualTurnInput,
  RitualTurnResult,
} from './ritual-executor.ts'
export { RITUAL_AGENT_BASE_PROMPT } from './prompt-path.ts'
export {
  createRitualRunStore,
  MAX_RITUAL_OUTPUT_SUMMARY_CHARS,
  RITUAL_RUN_RETENTION_MS,
} from './ritual-runs.ts'
export type {
  RitualRunStore,
  RitualRunRow,
  RitualRunStatus,
  RitualRunTerminalStatus,
} from './ritual-runs.ts'

// Completion delivery + failure surfacing (plan task 5): terminal-event notice
// formatters, the once-per-streak escalation rule, and the boot-reap driver.
export {
  reapOrphanRitualRuns,
  shouldEscalate,
  formatRitualFailureNotice,
  formatRitualCompletionFallback,
  formatRitualEscalationNotice,
  formatRitualBootReapNotice,
  RITUAL_ESCALATION_CONSECUTIVE_FAILURES,
} from './ritual-delivery.ts'

export {
  buildReminderDispatcher,
  buildSubstrateReminderLlm,
} from './dispatcher.ts'
export type {
  ReminderOutbound,
  ReminderOutboundInput,
  ReminderContextSource,
  ReminderTopicResolver,
  ReminderLlm,
  BuildReminderDispatcherInput,
} from './dispatcher.ts'
// `buildButtonStoreReminderOutbound` moved UP to
// `gateway/proactive/reminder-outbound.ts` (L3, 2026-07): the concrete delivery
// impl reaches the gateway WebChatSenderRegistry + landing chat protocol, so it
// belongs at the composition root. `reminders` keeps only the `ReminderOutbound`
// SEAM (exported above from ./dispatcher.ts). An upward move gets no re-export
// shim here — that would recreate the reminders→gateway edge this cut removes.
// Executor-mode reminders — the ritual layer (migration 0106). Schema + pure
// registry/validation only; the tick dispatch branch + approval gate + run-history
// writer land in plan tasks 3-5.
export {
  createRitualRegistry,
  validateRitualFire,
  RITUAL_ID_RE,
  RITUAL_MODEL_TIER,
  RITUAL_TIMEOUT_MS,
  MAX_RITUAL_PROMPT_BYTES,
} from './rituals.ts'
export type {
  RitualDef,
  RitualRegistry,
  RitualScope,
  RitualEgress,
  RitualApprovalCheck,
  RitualFireValidation,
  RitualFireSkipReason,
} from './rituals.ts'

// Content-hash-bound ritual approval gate (migration-0004 tool_approvals rows;
// plan task 3). The request path + the RitualApprovalCheck implementation.
export {
  computeRitualContentHash,
  ritualCadenceString,
  ritualApprovalToolName,
  ritualEgressApprovalToolName,
  requestRitualApproval,
  createRitualApprovalCheck,
} from './ritual-approval.ts'
export type {
  RitualContentHashInput,
  RitualApprovalRequestResult,
} from './ritual-approval.ts'

// Bundled generic read-only example rituals (plan task 7) — ENGINE seeds. The
// composer factory seeds these copy-if-absent into `<owner_home>/rituals/` and
// registers them, UNAPPROVED, at boot.
export {
  BUNDLED_RITUAL_DEFS,
  BUNDLED_RITUAL_TEMPLATES_DIR,
  bundledTemplatePathFor,
  seedBundledRituals,
  registerBundledRituals,
} from './bundled-rituals.ts'

// Extracted register-time def validation (plan task 8) — shared by the registry
// and the agent-callable registration service.
export { validateRitualDef } from './rituals.ts'

// Agent-callable ritual registration + in-chat approval (plan task 8, overturn 3).
// The engine service the reminders-Core's `rituals_propose` / `rituals_status`
// tools deref via a late-bound getter, plus the boot re-registration of
// agent-persisted `<id>.def.json` defs.
export {
  createRitualRegistrationService,
  loadPersistedRitualDefs,
  renderRitualApprovalBody,
  uuidToToken,
  tokenToUuid,
  RitualProposalError,
  RITUAL_PROPOSAL_MAX_PROMPT_BYTES,
  RITUAL_APPROVAL_VALUE_PREFIX,
  RITUAL_APPROVAL_VALUE_RE,
  RITUAL_PROPOSAL_BANNED_CHARS_RE,
} from './ritual-registration.ts'
export type {
  RitualRegistrationService,
  RitualRegistrationServiceOptions,
  RitualRegistrationEmit,
  RitualProposalInput,
  RitualEnableInput,
  RitualProposalSchedule,
  RitualProposalResult,
  RitualStatusRow,
  RitualOwnerAnswerInput,
  RitualProposalErrorCode,
} from './ritual-registration.ts'

export { buildStatusMdContextSource } from './context.ts'
export {
  classifyReminderMessage,
  literalFallback,
  KNOWN_REMINDER_PATTERNS,
} from './message-shape.ts'
export type { ReminderShape } from './message-shape.ts'
