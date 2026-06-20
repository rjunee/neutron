/**
 * @neutronai/runtime — subagent lifecycle watchdog.
 *
 * Cleanup pass for the subagent registry. Lifted from OpenClaw's
 * `subagent-lifecycle.ts`. Runs on a periodic tick (default 60s), driven by
 * the gateway's main interval. Three responsibilities:
 *
 *   1. Stale-`running` reaping: any record `running` with no `last_event_at`
 *      update for `STALE_THRESHOLD_MS` is force-cancelled — likely the
 *      subagent crashed without emitting a terminal event.
 *
 *   2. PID-gone reaping: any record with a `pid` whose process is no longer
 *      alive AND whose status is still `running` is marked `crashed`.
 *
 *   3. Cleanup-after pruning: records past `cleanup_after` are deleted.
 *
 * Pure orchestration — actual cancellation goes through `cancelRun` in
 * `control.ts`, which calls the registered canceller.
 */

import { cancelRun, type ControlState } from './control.ts'
import type { SubagentRegistry } from './registry.ts'

export const STALE_THRESHOLD_MS = 5 * 60_000

export interface LifecycleDeps {
  control: ControlState
  registry: SubagentRegistry
  /**
   * Probe whether a pid is still alive. Default: `process.kill(pid, 0)`
   * (signal 0 throws ESRCH if the process is gone). Tests inject a stub.
   */
  pid_alive?: (pid: number) => boolean
  /** Now-injection for tests. */
  now?: () => number
}

/**
 * Run one tick of the watchdog. Returns the number of records affected
 * (cancelled / marked crashed / deleted). Safe to call concurrently — each
 * sub-action is idempotent.
 */
export async function runLifecycleTick(deps: LifecycleDeps): Promise<number> {
  const now = (deps.now ?? Date.now)()
  const isAlive = deps.pid_alive ?? defaultPidAlive
  let affected = 0

  // (1) Stale-`running` reaping.
  for (const rec of deps.registry.live()) {
    if (rec.status !== 'running') continue
    if (now - rec.last_event_at > STALE_THRESHOLD_MS) {
      await cancelRun(deps.control, rec.run_id, 'lifecycle_cleanup')
      affected++
    }
  }

  // (2) PID-gone reaping.
  for (const rec of deps.registry.live()) {
    if (rec.status !== 'running') continue
    if (rec.pid !== undefined && !isAlive(rec.pid)) {
      deps.registry.update(rec.run_id, { status: 'crashed', ended_at: now })
      affected++
    }
  }

  // (3) Cleanup-after pruning.
  for (const rec of deps.registry.pruneCandidates(now)) {
    deps.registry.delete(rec.run_id)
    affected++
  }

  return affected
}

function defaultPidAlive(pid: number): boolean {
  try {
    // Signal 0 is the standard "is this process alive" probe.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
