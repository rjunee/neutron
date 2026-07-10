/**
 * @neutronai/runtime — subagent lifecycle tick.
 *
 * Runs on a periodic tick (default 60s), driven by the gateway's main interval.
 * One ordered tick with two phases:
 *
 *   1. **Liveness surfacing** (when `watchdog` deps are supplied): runs the
 *      agent-aware watchdog (`watchdog.ts`) — detects stale/dead `running`
 *      records, marks them failed, and NOTIFIES — then …
 *   2. **Cleanup-after pruning**: deletes terminal records
 *      (`finished`|`crashed`|`cancelled`) past their `cleanup_after`.
 *
 * The watchdog runs BEFORE the prune so the single tick both surfaces a failing
 * agent and reaps already-terminal ones, in a defined order, with no second
 * independent reaper to race. Liveness reaping USED to live in this file as a
 * SILENT pass (it `cancelRun`'d stale records / marked pid-gone ones `crashed`
 * with no notification); that logic moved into the watchdog so failures are
 * surfaced, and this tick now COMPOSES the watchdog rather than duplicating it.
 *
 * Omit the `watchdog` deps to run a prune-only tick (e.g. a cleanup-only
 * scheduler); the watchdog can also be driven standalone via `runAgentWatchdog`.
 */

import type { SubagentRegistry } from './registry.ts'
import { runAgentWatchdog, type AgentWatchdogDeps } from './watchdog.ts'

/**
 * @deprecated The stale-`running` threshold now lives on the agent-aware
 * watchdog as `DEFAULT_STUCK_THRESHOLD_MS` (`watchdog.ts`). Retained as a
 * back-compat alias.
 */
export const STALE_THRESHOLD_MS = 5 * 60_000

export interface LifecycleDeps {
  registry: SubagentRegistry
  /** Now-injection for tests. */
  now?: () => number
  /**
   * Liveness-surfacing deps. When present, the tick runs the agent-aware
   * watchdog first (surfacing stale/dead live agents) and then prunes. Omit for
   * a prune-only tick. `registry` + `now` are threaded from above, so this is
   * the watchdog's deps minus those two (`control`, optional `notify` /
   * `pid_alive` / `stuck_threshold_ms`).
   */
  watchdog?: Omit<AgentWatchdogDeps, 'registry' | 'now'>
}

/**
 * Run one lifecycle tick. Returns the number of records affected (agents
 * surfaced-as-failed + terminal records pruned). Idempotent.
 */
export async function runLifecycleTick(deps: LifecycleDeps): Promise<number> {
  const now = (deps.now ?? Date.now)()
  let affected = 0

  // (1) Liveness surfacing — the watchdog owns all live→terminal transitions.
  if (deps.watchdog) {
    const { surfaced } = await runAgentWatchdog({
      ...deps.watchdog,
      registry: deps.registry,
      now: () => now,
    })
    affected += surfaced.length
  }

  // (2) Cleanup-after pruning of already-terminal records.
  for (const rec of deps.registry.pruneCandidates(now)) {
    // eslint-disable-next-line no-await-in-loop
    await deps.registry.delete(rec.run_id)
    affected++
  }

  return affected
}
