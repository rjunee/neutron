/**
 * @neutronai/runtime — subagent registry pruning pass.
 *
 * Runs on a periodic tick (default 60s), driven by the gateway's main interval.
 * Single responsibility: **cleanup-after pruning** — delete terminal records
 * (`finished`|`crashed`|`cancelled`) whose `cleanup_after` has elapsed.
 *
 * Liveness reaping — detecting a `running` record that went stale or whose
 * process died — USED to live here too (it silently `cancelRun`'d stale records
 * and marked pid-gone ones `crashed`). That responsibility moved to the
 * **agent-aware watchdog** (`watchdog.ts`), which SURFACES each failure (marks
 * it failed + notifies) instead of silently reaping it. Keeping both reaping the
 * same `running` records at the same threshold raced: whichever ran first won,
 * and if this pass won it swallowed the failure the watchdog was meant to
 * surface. Splitting the duties makes them disjoint, so tick order is
 * irrelevant — the watchdog owns live→terminal transitions; this pass only
 * prunes already-terminal records.
 */

import type { SubagentRegistry } from './registry.ts'

/**
 * @deprecated The stale-`running` threshold now lives on the agent-aware
 * watchdog as `DEFAULT_STUCK_THRESHOLD_MS` (`watchdog.ts`). Retained as a
 * back-compat alias; this pruning pass no longer uses it.
 */
export const STALE_THRESHOLD_MS = 5 * 60_000

export interface LifecycleDeps {
  registry: SubagentRegistry
  /** Now-injection for tests. */
  now?: () => number
}

/**
 * Run one prune tick: delete terminal records past their `cleanup_after`.
 * Returns the number deleted. Idempotent + safe to call concurrently with the
 * agent-aware watchdog (disjoint responsibilities — see module header).
 */
export async function runLifecycleTick(deps: LifecycleDeps): Promise<number> {
  const now = (deps.now ?? Date.now)()
  let affected = 0
  for (const rec of deps.registry.pruneCandidates(now)) {
    deps.registry.delete(rec.run_id)
    affected++
  }
  return affected
}
