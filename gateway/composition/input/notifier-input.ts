import type { CredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { ReminderDispatcher } from '@neutronai/reminders/tick.ts'
import type { ApprovalManager, ApprovalNotifier } from '@neutronai/tools/approval.ts'
import type {
  HeartbeatTracker,
  PidLivenessProbe,
} from '@neutronai/watchdog/detectors.ts'
import type { WatchdogNotifier } from '@neutronai/watchdog/types.ts'

export interface NotifierCompositionInput {
  /** Approval surface (Telegram inline-keyboard) — supplied by the boot shell. */
  approval_notifier: ApprovalNotifier
  /**
   * The `ApprovalManager` the graph should EXPOSE, when the boot shell already built
   * one. Reused rather than re-constructed, exactly as `channel_router` is: the
   * manager holds an in-memory map of pending decisions alongside the durable
   * `tool_approvals` rows, so two instances over one database would disagree about
   * which requests are still waiting — one would resolve a promise nobody is holding
   * while the other's caller waited for a decision that had already been made.
   *
   * Open supplies it because the MCP-server settings surface
   * (`gateway/http/app-mcp-servers-surface.ts`) needs the SAME manager the graph's
   * tool approvals use — approving an installed server and approving a tool call are
   * the same act on the same table, and a second concept there was explicitly not
   * wanted. Omitted ⇒ the graph builds its own from `db` + `approval_notifier`,
   * unchanged for every existing caller.
   */
  approval_manager?: ApprovalManager
  /** Watchdog alert surface — app-ws + `system_events` for production (F4). */
  watchdog_notifier: WatchdogNotifier
  /** Reminder dispatcher — substrate-spawn for production, stub for dev. */
  reminder_dispatcher: ReminderDispatcher
  /**
   * Install the ritual fire PLANNER (ISSUES #504), called ONCE by
   * `remindersModule` as soon as the graph's `ApprovalManager` — the content-hash
   * approval checker source — exists.
   *
   * WHY AN INSTALL HOOK RATHER THAN A VALUE. The planner needs the graph's
   * `ApprovalManager`, which does not exist when the composer builds
   * `reminder_dispatcher`; and the planner has to reach THAT dispatcher, because a
   * ritual composes and delivers through the SAME dispatcher a nudge does — that
   * sameness is the whole of #504. So the composer passes a late-bound planner
   * seam into the dispatcher at construction and installs the real planner here,
   * the same late-binding shape it already uses for the ritual registration
   * service. Returns void: the composer owns the wiring, this only says "now".
   *
   * Omitted on an LLM-less box → every row composes as an ordinary nudge from its
   * own stored `message`. That is fail-closed: with no planner installed nothing
   * reads, validates, or composes a ritual's approved PROMPT.
   */
  init_ritual_planner?: (deps: { approvals: ApprovalManager }) => void
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
