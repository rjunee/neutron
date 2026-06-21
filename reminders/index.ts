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
export { buildButtonStoreReminderOutbound } from './outbound.ts'
export { buildStatusMdContextSource } from './context.ts'
export {
  classifyReminderMessage,
  literalFallback,
  KNOWN_REMINDER_PATTERNS,
} from './message-shape.ts'
export type { ReminderShape } from './message-shape.ts'
