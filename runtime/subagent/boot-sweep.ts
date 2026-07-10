/**
 * @neutronai/runtime — subagent boot reap (plan §P7, decision D-6).
 *
 * On startup, every persisted registry row still in a LIVE (`pending`|`running`)
 * status was left in-flight by a PRIOR process that has since died — the gateway
 * restarted mid-dispatch. Without this sweep those rows were silently orphaned:
 * the in-memory registry started empty, the awaiting caller was already gone,
 * and the dispatch just vanished with no signal.
 *
 * This sweep SURFACES each orphan instead of vanishing it:
 *   1. mark the row terminal-`crashed` in the store (`markCrashed`), and
 *   2. FIRE THE REPORT SINK for it — the SAME report-back surface a clean
 *      completion uses — so a restart reports "this dispatch crashed" rather
 *      than hanging forever.
 *
 * It does NOT re-hydrate the record into the in-memory registry (the spec is
 * "surface, don't resume") — the process that was awaiting it is gone.
 *
 * EXACTLY ONCE. `markCrashed` guards on the row still being live (`WHERE status
 * IN (pending, running)`), so it transitions — and this sweep fires the sink —
 * only on the FIRST boot that sees the orphan. The persisted `crashed` status
 * makes every later boot a no-op for that row. The report is fired only when the
 * store transition actually happened, so a report is never emitted for an
 * already-terminal row.
 *
 * ORPHAN-DETECTION SETS STAY VOLATILE. This sweep reads the persisted REGISTRY
 * only. It neither reads nor writes the Trident orchestrator's per-process
 * `fired`/`redispatched` sets (`trident/orchestrator.ts`) — those are closure
 * locals with no column in `code_subagent_registry`, so a restart still
 * re-detects Trident orphans the intended (volatile) way.
 */

import type { SubagentRecord } from './registry.ts'
import type { SubagentRegistryStore } from './store.ts'

/** The report-back sink fired for each surfaced orphan (the crashed record). */
export interface BootSweepReport {
  (rec: SubagentRecord): void | Promise<void>
}

export interface BootSweepDeps {
  store: SubagentRegistryStore
  /**
   * Report-back sink — fired once per surfaced orphan with the now-`crashed`
   * record. Best-effort: a throw is swallowed (a sink failure must not abort the
   * sweep or un-terminal a row that is already recorded crashed).
   */
  report?: BootSweepReport
  /** Now-injection for tests. Default `Date.now`. */
  now?: () => number
}

/**
 * Reap orphaned dispatches left in-flight by a prior process. Marks each live
 * persisted row `crashed` and fires the report sink exactly once per orphan.
 * Returns the records it surfaced (in store order). Idempotent across boots.
 */
export async function sweepOrphanedDispatchesOnBoot(
  deps: BootSweepDeps,
): Promise<SubagentRecord[]> {
  const now = (deps.now ?? Date.now)()
  const surfaced: SubagentRecord[] = []

  for (const rec of deps.store.loadLive()) {
    // Transition in the store FIRST (idempotent guard): only the boot that wins
    // the live→crashed race proceeds to fire the sink, so the report is exactly
    // once and never for an already-terminal row.
    const transitioned = deps.store.markCrashed(rec.run_id, 'process_dead', now)
    if (!transitioned) continue

    const crashed: SubagentRecord = {
      ...rec,
      status: 'crashed',
      failure_reason: 'process_dead',
      ended_at: now,
      last_event_at: now,
    }
    surfaced.push(crashed)

    if (deps.report) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await deps.report(crashed)
      } catch {
        // Best-effort — a report failure must not abort the sweep or un-crash a
        // row already recorded terminal (mirrors the watchdog's notify contract).
      }
    }
  }

  return surfaced
}
