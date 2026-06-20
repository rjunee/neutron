/**
 * @neutronai/cron — public barrel.
 *
 * Three primitives ship in
 * P1 S4: declarative job registry (`jobs.ts`), handler registry
 * (`handlers.ts`), in-process scheduler (`scheduler.ts`) + last-run state
 * (`state.ts`), and systemd timer-unit emission (`timer-emit.ts`).
 */

export const __MODULE__ = '@neutronai/cron' as const

export {
  CronJobRegistry,
  validateJobName,
  type CronJobDef,
  type CronSchedule,
} from './jobs.ts'
export {
  CronHandlerRegistry,
  type CronHandler,
  type CronHandlerContext,
  type CronHandlerResult,
  type CronHandlerStatus,
} from './handlers.ts'
export { CronStateStore, type CronStateRow } from './state.ts'
export { CronScheduler, type SchedulerOptions } from './scheduler.ts'
export {
  parseOnCalendar,
  nextFireAfter,
  previousFireAtOrBefore,
  wallClockToEpoch,
  zonedParts,
  hostTimeZone,
  type CalendarSpec,
} from './calendar.ts'
export {
  emitTimerUnits,
  type EmitInput,
  type EmittedUnits,
} from './timer-emit.ts'
