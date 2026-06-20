import type { ReminderDispatcher } from '../../../reminders/tick.ts'
import type { ApprovalNotifier } from '../../../tools/approval.ts'
import type {
  HeartbeatTracker,
  PidLivenessProbe,
} from '../../../watchdog/detectors.ts'
import type { WatchdogNotifier } from '../../../watchdog/types.ts'

export interface NotifierCompositionInput {
  /** Approval surface (Telegram inline-keyboard) — supplied by the boot shell. */
  approval_notifier: ApprovalNotifier
  /** Watchdog alert surface — Telegram for production. */
  watchdog_notifier: WatchdogNotifier
  /** Reminder dispatcher — substrate-spawn for production, stub for dev. */
  reminder_dispatcher: ReminderDispatcher
  /** Heartbeat tracker — typically a small in-process pulse counter. */
  heartbeat_tracker: HeartbeatTracker
  /** Optional pid-liveness probe override (used by tests). */
  pid_probe?: PidLivenessProbe
}
