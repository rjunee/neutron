/**
 * @neutronai/runtime — agent-aware subagent watchdog.
 *
 * Closes gap-audit §(b) #8 ("Watchdog is generic, not agent-aware"). The
 * generic `lifecycle.ts` reaper silently cancels stale `running` records and
 * marks pid-gone ones `crashed`, but it never SURFACES the failure — a crashed
 * or stuck dispatched agent just disappears from `live()` and the caller that
 * was awaiting it hangs forever with no signal.
 *
 * This watchdog is agent-aware: it walks the dispatched-agent registry, and for
 * every LIVE (`pending`|`running`) record it detects one of two terminal
 * conditions and SURFACES it (marks the run failed via `failRun` + emits a
 * structured event through an injected `notify` sink — Telegram / the
 * `watchdog/` AlertStore / a log):
 *
 *   1. process_dead — the record carries a `pid` whose OS process is gone, yet
 *      it never reached a terminal status. The agent crashed without emitting a
 *      completion. (Takes precedence over `stuck`.)
 *   2. stuck — no progress: `last_event_at` is older than the per-agent-kind
 *      inactivity threshold. The process may still be alive (wedged), so
 *      `failRun` kills it via the registered canceller before surfacing.
 *
 * It deliberately does NOT auto-respawn (out of scope) — but each surfaced
 * event carries enough context (`run_id`, `agent_kind`, `instance_key`,
 * `delivery_target`) for a caller to retry/notify as policy dictates.
 *
 * Pure + injectable (now / pid_alive / notify) so the tests are hermetic. Safe
 * to run alongside `runLifecycleTick`: both transition only live records and
 * the registry's terminal-state checks make every transition idempotent.
 */

import { failRun, type ControlState } from './control.ts'
import type { AgentKind, SubagentRegistry } from './registry.ts'

/** Default inactivity window before a `running` agent is judged stuck. */
export const DEFAULT_STUCK_THRESHOLD_MS = 5 * 60_000

export type WatchdogReason = 'process_dead' | 'stuck'

/** A surfaced liveness failure — handed to the notifier + returned to callers. */
export interface AgentWatchdogEvent {
  run_id: string
  agent_kind: AgentKind
  instance_key: string
  reason: WatchdogReason
  /** Where a notice about this agent should be delivered, if the record had one. */
  delivery_target?: { channel: string; binding_id: string }
  /** The record's last-progress timestamp at detection. */
  last_event_at: number
  /** Wall-clock at detection. */
  detected_at: number
  /** `detected_at - last_event_at` — staleness at the moment of reaping. */
  age_ms: number
  /** The pid that was found dead (process_dead only). */
  pid?: number
}

export interface AgentWatchdogNotifier {
  /** Surface a fired event. Best-effort — a throw is swallowed by the tick. */
  (event: AgentWatchdogEvent): void | Promise<void>
}

/**
 * Per-agent-kind stuck thresholds (ms). A bare number applies one threshold to
 * every kind; a partial map overrides per kind and falls back to
 * `DEFAULT_STUCK_THRESHOLD_MS` for unlisted kinds.
 */
export type StuckThresholdConfig = number | Partial<Record<AgentKind, number>>

export interface AgentWatchdogDeps {
  control: ControlState
  registry: SubagentRegistry
  /** Surface sink for fired events (Telegram / AlertStore / log). Optional. */
  notify?: AgentWatchdogNotifier
  /**
   * Probe whether a pid is still alive. Default: `process.kill(pid, 0)` (signal
   * 0 throws ESRCH if gone; EPERM means alive-but-not-ours). Tests inject a stub.
   */
  pid_alive?: (pid: number) => boolean
  /** Now-injection for tests. */
  now?: () => number
  /** Stuck threshold(s). Default `DEFAULT_STUCK_THRESHOLD_MS` for every kind. */
  stuck_threshold_ms?: StuckThresholdConfig
}

export interface AgentWatchdogResult {
  /** Events surfaced this tick, in detection order. */
  surfaced: AgentWatchdogEvent[]
}

function thresholdFor(kind: AgentKind, cfg: StuckThresholdConfig | undefined): number {
  if (cfg === undefined) return DEFAULT_STUCK_THRESHOLD_MS
  if (typeof cfg === 'number') return cfg
  return cfg[kind] ?? DEFAULT_STUCK_THRESHOLD_MS
}

/**
 * Run one agent-aware watchdog tick. Returns the events it surfaced. Each
 * surfaced run is marked `crashed` with a `failure_reason`, its process is
 * killed (stuck) or already gone (dead), and the `notify` sink is invoked.
 */
export async function runAgentWatchdog(deps: AgentWatchdogDeps): Promise<AgentWatchdogResult> {
  const now = (deps.now ?? Date.now)()
  const isAlive = deps.pid_alive ?? defaultPidAlive
  const surfaced: AgentWatchdogEvent[] = []

  // Snapshot the live set up-front: `failRun` mutates statuses out of `live()`,
  // so iterating a frozen list keeps the pass deterministic.
  for (const rec of deps.registry.live()) {
    let reason: WatchdogReason | undefined
    if (rec.pid !== undefined && !isAlive(rec.pid)) {
      // process_dead takes precedence — a gone process is gone regardless of
      // how recently it last reported progress.
      reason = 'process_dead'
    } else if (now - rec.last_event_at > thresholdFor(rec.agent_kind, deps.stuck_threshold_ms)) {
      reason = 'stuck'
    }
    if (reason === undefined) continue

    // eslint-disable-next-line no-await-in-loop
    const transitioned = await failRun(deps.control, rec.run_id, reason, now)
    if (!transitioned) continue // raced to terminal already; don't double-surface

    const event: AgentWatchdogEvent = {
      run_id: rec.run_id,
      agent_kind: rec.agent_kind,
      instance_key: rec.instance_key,
      reason,
      last_event_at: rec.last_event_at,
      detected_at: now,
      age_ms: now - rec.last_event_at,
    }
    if (rec.delivery_target !== undefined) event.delivery_target = rec.delivery_target
    if (reason === 'process_dead' && rec.pid !== undefined) event.pid = rec.pid
    surfaced.push(event)

    if (deps.notify) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await deps.notify(event)
      } catch {
        // Notifier is best-effort; a sink failure must not abort the tick or
        // un-fail the run (it is already terminal + recorded).
      }
    }
  }

  return { surfaced }
}

function defaultPidAlive(pid: number): boolean {
  try {
    // Signal 0 is the standard "is this process alive" probe.
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = process exists but isn't ours; still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
