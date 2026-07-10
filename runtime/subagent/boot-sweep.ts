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
 *   1. FIRE THE REPORT SINK for it — the SAME report-back surface a clean
 *      completion uses — so a restart reports "this dispatch crashed" rather
 *      than hanging forever, THEN
 *   2. mark the row terminal-`crashed` in the store (`markCrashed`) — but ONLY
 *      after the report was delivered (the sink did not throw).
 *
 * It does NOT re-hydrate the record into the in-memory registry (the spec is
 * "surface, don't resume") — the process that was awaiting it is gone.
 *
 * DELIVERY ORDER — report FIRST, commit terminal SECOND (at-least-once, never
 * vanishes). The commit is what excludes a row from every later boot's
 * `loadLive()`, so committing it BEFORE a successful delivery would make a
 * thrown sink (or a crash mid-report) lose the orphan forever — the exact
 * "vanishes" failure P7 exists to prevent. By reporting first and committing
 * only on success, a FAILED delivery leaves the row LIVE, so the next boot
 * RETRIES it. Guarantees:
 *   - happy path: delivered EXACTLY ONCE (the commit hides it from later boots);
 *   - sink failure: retried on the next boot — the orphan is never vanished;
 *   - never fired for an already-terminal row (only `loadLive()` rows are
 *     considered, and a committed row is excluded from every later `loadLive()`).
 * The residual window (a hard crash between a successful delivery and the commit
 * a few microseconds later) can re-deliver on the next boot — at-least-once, not
 * at-most-once, because a duplicate "your dispatch crashed" notice is strictly
 * safer than a silently lost one.
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
   * Report-back sink — invoked once per orphan with the now-`crashed` record
   * BEFORE the store commit. A throw is caught: the sweep leaves that row LIVE
   * (uncommitted) and moves on, so the next boot retries the delivery. A sink
   * failure never aborts the whole sweep.
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
    const crashed: SubagentRecord = {
      ...rec,
      status: 'crashed',
      failure_reason: 'process_dead',
      ended_at: now,
      last_event_at: now,
    }

    // Report FIRST. A throw means the orphan was NOT delivered — leave the row
    // LIVE (skip the commit) so the next boot retries it. The orphan is never
    // vanished by a transient sink failure.
    if (deps.report) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await deps.report(crashed)
      } catch {
        continue // undelivered — retried on the next boot
      }
    }

    // Delivered (or no sink wired) → COMMIT terminal. This is the only write
    // that removes the row from every later boot's `loadLive()`, so a delivered
    // orphan is surfaced exactly once on the happy path. Guarded on the row
    // still being live, so it never re-fires an already-terminal row.
    deps.store.markCrashed(rec.run_id, 'process_dead', now)
    surfaced.push(crashed)
  }

  return surfaced
}
