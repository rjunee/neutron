import type { CredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { ReminderDispatcher } from '@neutronai/reminders/tick.ts'
import type { RitualExecutor } from '@neutronai/reminders/ritual-executor.ts'
import type { ApprovalManager, ApprovalNotifier } from '@neutronai/tools/approval.ts'
import type {
  HeartbeatTracker,
  PidLivenessProbe,
} from '@neutronai/watchdog/detectors.ts'
import type { WatchdogNotifier } from '@neutronai/watchdog/types.ts'

export interface NotifierCompositionInput {
  /** Approval surface (Telegram inline-keyboard) — supplied by the boot shell. */
  approval_notifier: ApprovalNotifier
  /** Watchdog alert surface — app-ws + `system_events` for production (F4). */
  watchdog_notifier: WatchdogNotifier
  /** Reminder dispatcher — substrate-spawn for production, stub for dev. */
  reminder_dispatcher: ReminderDispatcher
  /**
   * Executor-mode reminders (plan task 4) — a FACTORY that builds the ritual
   * executor from the graph's `ApprovalManager` (the approval checker source).
   * `build-core-modules`' `remindersModule` invokes it (when present) with the
   * composed `approval` module and wires the result as the tick loop's
   * `ritual_executor`. The composer owns the rest of the executor's wiring
   * (subagent registry, `cc-ritual-*` substrate turn, run store, model, scope).
   * Omitted on an LLM-less box → no ritual surface (ritual rows are consumed +
   * logged by the tick, never dispatched as nudges).
   */
  ritual_executor_factory?: (deps: { approvals: ApprovalManager }) => RitualExecutor
  /** Heartbeat tracker — typically a small in-process pulse counter. */
  heartbeat_tracker: HeartbeatTracker
  /** Optional pid-liveness probe override (used by tests). */
  pid_probe?: PidLivenessProbe
  /**
   * F4 — the substrate credential pool the `substrate_cooldown_saturation`
   * detector watches (fires when EVERY credential is in cooldown). The Open
   * composer passes its resolved LLM pool; omitting it (or a box with no
   * credential pool) leaves the detector watching an empty pool, which never
   * fires — the detector is still REGISTERED (all six always wired) but silent.
   */
  watchdog_credential_pool?: CredentialPool
}
