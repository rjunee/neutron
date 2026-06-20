/**
 * @neutronai/watchdog — public barrel.
 *
 * Six logical watchdog detectors + a supervisor that runs them on a tick
 * + persists + notifies.
 */

export const __MODULE__ = '@neutronai/watchdog' as const

export type {
  WatchdogKind,
  WatchdogAlert,
  WatchdogDetector,
  WatchdogNotifier,
} from './types.ts'

export { AlertStore } from './alert-store.ts'

export {
  HeartbeatDetector,
  StuckAgentDetector,
  CrashedAgentDetector,
  OverrunCronDetector,
  DbLockContentionDetector,
  SubstrateCooldownDetector,
  DefaultPidLivenessProbe,
  type HeartbeatTracker,
  type HeartbeatDetectorOptions,
  type StuckAgentDetectorOptions,
  type CrashedAgentDetectorOptions,
  type OverrunCronDetectorOptions,
  type DbLockDetectorOptions,
  type SubstrateCooldownDetectorOptions,
  type PidLivenessProbe,
  type BusyRetryCounter,
} from './detectors.ts'

export { WatchdogSupervisor, type SupervisorOptions } from './supervisor.ts'
