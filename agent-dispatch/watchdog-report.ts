/**
 * @neutronai/agent-dispatch — watchdog → report-back adapter.
 *
 * The already-ported agent-aware watchdog (`runtime/subagent/watchdog.ts`)
 * reaps a stuck/dead LIVE record, marks it `crashed`, and SURFACES a structured
 * `AgentWatchdogEvent` through an injected `notify` sink. This adapter turns
 * that event into a dispatch `report` so a supervised failure reaches the SAME
 * report-back surface a clean completion does — a dispatched agent that wedges
 * or dies never just silently vanishes from `live()`.
 *
 * It only handles the three kinds THIS dispatcher owns (`atlas`/`sentinel`/
 * `core` → research/review/adhoc). A `forge`/`argus` watchdog event belongs to
 * the Trident loop and is skipped (returns without reporting), so wiring this
 * notifier alongside Trident's own supervision does not double-report a build
 * agent.
 */

import type {
  AgentWatchdogEvent,
  AgentWatchdogNotifier,
  WatchdogReason,
} from '@neutronai/runtime/subagent/watchdog.ts'
import type { AgentKind, SubagentRecord, SubagentRegistry } from '@neutronai/runtime/subagent/registry.ts'
import type { ControlState } from '@neutronai/runtime/subagent/control.ts'
import type { BootSweepReport } from '@neutronai/runtime/subagent/boot-sweep.ts'
import { runLifecycleTick } from '@neutronai/runtime/subagent/lifecycle.ts'
import { SupervisedLoop } from '@neutronai/loop'
import { DISPATCH_KIND_BY_AGENT_KIND } from './prompts.ts'
import type { DeliveryTarget, DispatchReport, DispatchReporter } from './service.ts'

/** Build a watchdog notifier that forwards dispatch failures to `report`. */
export function buildDispatchWatchdogNotifier(report: DispatchReporter): AgentWatchdogNotifier {
  return async (event: AgentWatchdogEvent): Promise<void> => {
    const kind = DISPATCH_KIND_BY_AGENT_KIND[event.agent_kind]
    if (kind === undefined) return // forge/argus — Trident's, not ours

    const reasonText =
      event.reason === 'process_dead'
        ? 'the agent process died before reporting a result'
        : 'the agent made no progress past its inactivity threshold and was reaped'
    const markdown = [
      `### Subagent ${event.agent_kind} (crashed — ${event.reason})`,
      `- run_id: \`${event.run_id}\``,
      `- age at reap: ${event.age_ms}ms`,
      '',
      `Supervisor reaped this dispatch: ${reasonText}. No result was delivered.`,
    ].join('\n')

    const out: DispatchReport = {
      run_id: event.run_id,
      kind,
      agent_kind: event.agent_kind,
      status: 'crashed',
      markdown,
      payload: {
        run_id: event.run_id,
        agent_kind: event.agent_kind,
        status: 'crashed',
        summary: `Dispatch reaped by the supervisor (${event.reason}).`,
        deliverables: [],
      },
      result: '',
    }
    if (event.delivery_target !== undefined) out.delivery_target = event.delivery_target

    // SWALLOW is CORRECT here (round-4 sweep, audited): this notifier's ONLY
    // caller is the BOOT SWEEP (`buildBootSweepReport`), where the durable
    // `crashed` row is ALREADY committed (`markCrashed`) BEFORE this report fires,
    // and the sweep is a one-shot at boot with no dedup ledger / retry. So the
    // report is a best-effort notification ON TOP of an already-durable commit —
    // there is no un-latch-on-failure logic that a propagated error would feed
    // (unlike `buildDispatchSuspectedStuckNotifier`, whose `notified`-ledger
    // commit DOES depend on delivery, so it re-throws).
    try {
      await report(out)
    } catch {
      // Best-effort — the crash is already durably recorded by the boot sweep.
    }
  }
}

/**
 * A NON-TERMINAL "this dispatch LOOKS stuck/dead" alert (F4 Blocker-A fix). The
 * notify-only lifecycle watchdog emits THIS — never a terminal `crashed`
 * DispatchReport. The dispatch record is still `running` and alive: it has NOT
 * been reaped, stopped, or transitioned. Reusing the terminal `crashed`
 * report/status (which real completions AND the boot-sweep of a genuinely-dead
 * orphan use) would push contradictory lifecycle facts through the completion
 * surface. This is an ALERT, not a lifecycle event.
 */
export interface DispatchSuspectedStuckAlert {
  run_id: string
  agent_kind: AgentKind
  /** Why it looks stuck. `stuck` = no progress past threshold; `process_dead` = pid gone. */
  reason: WatchdogReason
  /** Staleness at detection (ms). */
  age_ms: number
  /** Human-readable NON-terminal notice (explicitly states nothing was stopped). */
  markdown: string
  delivery_target?: DeliveryTarget
}

/** Sink for the non-terminal suspected-stuck alert (O4 journal + app-ws in prod). */
export type DispatchSuspectedStuckSink = (alert: DispatchSuspectedStuckAlert) => void | Promise<void>

/** The two effects a dispatch-alert sink performs, split so the ORDERING between
 *  them is enforced (and tested) in one place. */
export interface DispatchStuckAlertSinkEffects {
  /**
   * The DURABLE surfacing (the O4 `watchdog_alert` journal in prod) — the DELIVERY
   * GATE. Awaited FIRST; a rejection PROPAGATES so the watchdog leaves the run
   * un-latched and retries cleanly. A no-op resolve (no durable target, e.g. an
   * LLM-less box) is a success.
   */
  journal: (alert: DispatchSuspectedStuckAlert) => Promise<void>
  /**
   * The USER-VISIBLE ephemeral push (app-ws in prod). Fired ONLY after `journal`
   * resolves, and best-effort (a throw is swallowed) — a dead socket must not
   * un-latch an already-journaled alert.
   */
  push: (alert: DispatchSuspectedStuckAlert) => void
}

/**
 * Build the dispatch suspected-stuck sink with PERSIST-BEFORE-DELIVER ordering.
 *
 * The durable `journal` commits BEFORE the user-visible `push`. This is the whole
 * point of the split: if the visible push ran first and the journal then rejected,
 * the watchdog would leave the run un-latched and RE-PUSH the same visible alert
 * every tick (a duplicate the user sees). Journaling first means a persist failure
 * is "not delivered" — no push has happened, so the retry is clean and the visible
 * alert lands EXACTLY ONCE (on the tick whose journal finally commits).
 */
export function buildDispatchStuckAlertSink(
  fx: DispatchStuckAlertSinkEffects,
): DispatchSuspectedStuckSink {
  return async (alert: DispatchSuspectedStuckAlert): Promise<void> => {
    await fx.journal(alert) // durable gate — rejection propagates (clean retry)
    try {
      fx.push(alert) // user-visible, ONLY after the durable commit; best-effort
    } catch {
      // ephemeral push is best-effort — never un-latch an already-journaled alert
    }
  }
}

/**
 * Build a notify-only watchdog notifier that emits a NON-TERMINAL
 * {@link DispatchSuspectedStuckAlert} (F4 Blocker-A fix) instead of the terminal
 * `crashed` DispatchReport. It states plainly that the dispatch has NOT been
 * stopped and may still complete — it never claims a terminal crash for a run
 * the notify-only watchdog leaves live. Skips forge/argus (Trident's own loop).
 */
export function buildDispatchSuspectedStuckNotifier(
  sink: DispatchSuspectedStuckSink,
): AgentWatchdogNotifier {
  return async (event: AgentWatchdogEvent): Promise<void> => {
    const kind = DISPATCH_KIND_BY_AGENT_KIND[event.agent_kind]
    if (kind === undefined) return // forge/argus — Trident's, not ours

    const reasonText =
      event.reason === 'process_dead'
        ? 'its process appears to be gone'
        : 'it has made no progress past its inactivity threshold'
    const markdown = [
      `### Supervisor alert: dispatched ${event.agent_kind} looks stuck (${event.reason})`,
      `- run_id: \`${event.run_id}\``,
      `- age: ${event.age_ms}ms`,
      '',
      `A dispatched ${event.agent_kind} subagent ${reasonText}. This is a NOTIFICATION only —` +
        ` the dispatch has NOT been stopped and remains live; it may still complete on its own.`,
    ].join('\n')

    const alert: DispatchSuspectedStuckAlert = {
      run_id: event.run_id,
      agent_kind: event.agent_kind,
      reason: event.reason,
      age_ms: event.age_ms,
      markdown,
    }
    if (event.delivery_target !== undefined) alert.delivery_target = event.delivery_target

    // PROPAGATE a sink failure (round-4 sweep, Blocker-1). This wrapper must NOT
    // swallow the rejection: `runAgentWatchdog` adds the run to `notified` only
    // when notify() RESOLVES, so swallowing here would make a FAILED delivery look
    // successful → the run latches → permanent suppression. Log for
    // self-observability, then re-throw so the watchdog leaves the run un-latched
    // and retries next tick. (The watchdog's own try/catch keeps the tick alive.)
    try {
      await sink(alert)
    } catch (err) {
      console.error(
        `[dispatch-watchdog] alert delivery FAILING for ${event.run_id} ` +
          `(will retry next tick):`,
        err,
      )
      throw err
    }
  }
}

/** Default cadence for the scheduled lifecycle watchdog tick (60 s). */
export const LIFECYCLE_WATCHDOG_TICK_MS = 60_000

export interface ScheduleDispatchLifecycleWatchdogDeps {
  registry: SubagentRegistry
  control: ControlState
  /**
   * NON-TERMINAL alert sink (F4 Blocker-A fix). A suspected-stuck dispatch is
   * surfaced HERE — NOT through the terminal `DispatchReporter` completions use.
   * Production wires it to O4 `system_events` + app-ws (composer).
   */
  alert_sink: DispatchSuspectedStuckSink
  /** Tick cadence. Default {@link LIFECYCLE_WATCHDOG_TICK_MS}. */
  interval_ms?: number
  /** setInterval seam (tests inject a synchronous driver). Default `setInterval`. */
  set_interval?: (fn: () => void, ms: number) => unknown
  clear_interval?: (handle: unknown) => void
}

/**
 * Schedule the subagent lifecycle watchdog (F4) — the tick that was NEVER
 * scheduled. Runs `runLifecycleTick` on an interval in NOTIFY-ONLY mode: it
 * DETECTS a stuck/dead dispatch and emits a NON-TERMINAL
 * {@link DispatchSuspectedStuckAlert} through `alert_sink`, but reaps NOTHING —
 * no canceller runs (nothing killed), no record is transitioned (no control-flow
 * change), and it does NOT push a terminal `crashed` report (Blocker-A fix).
 * Enforcement (killing a wedged dispatch after a VERIFIED threshold) is a
 * separate flagged PR; the 5-min default stuck threshold is unverified for
 * killing and here only gates a NOTIFICATION.
 *
 * The per-run `notified` ledger suppresses the every-tick repeat for a run that
 * stays live (it is never transitioned, so it keeps being detected). Returns an
 * ASYNC, QUIESCING `stop()` the caller wires into shutdown cleanup.
 *
 * Driven by {@link SupervisedLoop} (@neutronai/loop), the same primitive F1
 * adopted for the other tick loops, for TWO guarantees this watchdog needs:
 *   • SINGLE-FLIGHT (round-5 High B): the tick is async and — because the dedup
 *     check reads `notified` BEFORE awaiting the sink and writes it only AFTER
 *     delivery — two overlapping ticks would both see a still-live run as
 *     un-notified and BOTH fire the sink → a duplicate alert. SupervisedLoop skips
 *     a fire while a prior tick is still in flight.
 *   • QUIESCING STOP (round-7 High 2): `stop()` clears the interval AND awaits the
 *     in-flight tick before resolving, so registry pruning / persistence can never
 *     resume against a closing database. A bare `clearInterval` cannot drain an
 *     already-running tick; the gateway registers this async stop and AWAITS it
 *     before `db.close()`.
 * A tick failure is routed to SupervisedLoop's `onError` (logged + counted) so the
 * loop keeps firing.
 *
 * Returns `stop()` (async, quiescing) plus `runOnce()` — an AWAITABLE single tick
 * (SupervisedLoop's own single-flight-guarded runner). `runOnce()` lets tests drive
 * ticks DETERMINISTICALLY (await settlement) instead of firing the interval seam
 * and guessing at a `sleep`; production ignores it and relies on the timer.
 */
export function scheduleDispatchLifecycleWatchdog(
  deps: ScheduleDispatchLifecycleWatchdogDeps,
): { stop: () => Promise<void>; runOnce: () => Promise<void> } {
  const notify = buildDispatchSuspectedStuckNotifier(deps.alert_sink)
  const notified = new Set<string>()
  const loop = new SupervisedLoop({
    name: 'dispatch-lifecycle-watchdog',
    intervalMs: deps.interval_ms ?? LIFECYCLE_WATCHDOG_TICK_MS,
    tick: async (): Promise<void> => {
      await runLifecycleTick({
        registry: deps.registry,
        watchdog: {
          control: deps.control,
          notify,
          notify_only: true,
          notified,
        },
      })
    },
    onError: (name, err): void => {
      console.warn(
        `[subagent-lifecycle] tick '${name}' failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    },
    ...(deps.set_interval !== undefined ? { setTimer: deps.set_interval } : {}),
    ...(deps.clear_interval !== undefined ? { clearTimer: deps.clear_interval } : {}),
  })
  loop.start()
  return {
    stop: (): Promise<void> => loop.stop(),
    runOnce: async (): Promise<void> => {
      await loop.runOnce()
    },
  }
}

/**
 * Adapt the boot reap's `SubagentRecord` report (`runtime/subagent/boot-sweep.ts`)
 * onto the dispatch report-back surface. Reuses `buildDispatchWatchdogNotifier`,
 * so a boot-reaped orphan surfaces exactly like a live watchdog reap — same
 * `crashed` DispatchReport shape, same forge/argus skip (those belong to the
 * Trident loop's own supervision), same best-effort swallow-on-failure.
 *
 * SHARED production code: `open/composer.ts` wires this as the boot sweep's
 * report sink, and the wiring test exercises this exact function — so the test
 * cannot pass against a different/omitted mapping (Codex test-quality point).
 */
export function buildBootSweepReport(report: DispatchReporter): BootSweepReport {
  const notifier = buildDispatchWatchdogNotifier(report)
  return (rec: SubagentRecord) => {
    const detected_at = rec.ended_at ?? Date.now()
    // Age matches what a LIVE watchdog reap reports for the same record. The live
    // watchdog (`runtime/subagent/watchdog.ts`) computes `age_ms = now - progressAt`
    // where `progressAt` is the last PROGRESS timestamp (`last_event_at`, since a
    // prior-process orphan has no live JSONL probe to override it). Using
    // `started_at` here instead would over-report the age by the whole run duration
    // (e.g. started_at=0, last_event_at=900, detected_at=1000 → 1000ms vs the
    // watchdog's 100ms), contradicting the "surfaces exactly like a live reap"
    // contract. Fall back to `started_at` only if a malformed record lacks a
    // progress timestamp.
    const progress_at = rec.last_event_at ?? rec.started_at
    return notifier({
      run_id: rec.run_id,
      agent_kind: rec.agent_kind,
      instance_key: rec.instance_key,
      reason: 'process_dead',
      last_event_at: rec.last_event_at,
      detected_at,
      age_ms: detected_at - progress_at,
      ...(rec.delivery_target !== undefined ? { delivery_target: rec.delivery_target } : {}),
      ...(rec.pid !== undefined ? { pid: rec.pid } : {}),
    })
  }
}
