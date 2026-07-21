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

export { buildStatusMdContextSource } from './context.ts'
export {
  classifyReminderMessage,
  literalFallback,
  KNOWN_REMINDER_PATTERNS,
} from './message-shape.ts'
export type { ReminderShape } from './message-shape.ts'
