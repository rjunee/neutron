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

    try {
      await report(out)
    } catch {
      // Best-effort — a report failure must not abort the watchdog tick.
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

    try {
      await sink(alert)
    } catch {
      // Best-effort — an alert-sink failure must not abort the watchdog tick.
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
 * stays live (it is never transitioned, so it keeps being detected). A tick
 * failure is swallowed so the interval keeps firing. Returns a `stop()` the
 * caller wires into shutdown cleanup.
 */
export function scheduleDispatchLifecycleWatchdog(
  deps: ScheduleDispatchLifecycleWatchdogDeps,
): { stop: () => void } {
  const notify = buildDispatchSuspectedStuckNotifier(deps.alert_sink)
  const notified = new Set<string>()
  const setIv = deps.set_interval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clearIv = deps.clear_interval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  const handle = setIv(() => {
    void runLifecycleTick({
      registry: deps.registry,
      watchdog: {
        control: deps.control,
        notify,
        notify_only: true,
        notified,
      },
    }).catch((err: unknown) => {
      console.warn(
        `[subagent-lifecycle] tick failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }, deps.interval_ms ?? LIFECYCLE_WATCHDOG_TICK_MS)
  return {
    stop: () => clearIv(handle),
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
