/**
 * @neutronai/runtime — subagent boot reap (plan §P7, decision D-6).
 *
 * On startup, every persisted registry row still in a LIVE (`pending`|`running`)
 * status was left in-flight by a PRIOR process that has since died — the gateway
 * restarted mid-dispatch. Without this sweep those rows were silently orphaned:
 * the in-memory registry started empty (no persistence at all), so the dispatch
 * just vanished with no record and no signal.
 *
 * This sweep SURFACES each orphan instead of vanishing it, per the P7 spec
 * ("mark rows left by a prior process as `crashed`, and fire the report sink"):
 *   1. CLAIM the row — an ATOMIC, mutex-serialized `live → crashed` transition
 *      (`markCrashed`, a `db.transaction` guard-reading `status IN
 *      (pending,running)`). This durable row is the surfacing that never
 *      vanishes: it is persisted, queryable (`store.get`/`loadAll`), and returned
 *      from this sweep. The claim is also the concurrency + idempotency point —
 *      of any number of overlapping sweeps (or repeated boots), EXACTLY ONE wins
 *      each row's transition, so an orphan is claimed and reported once, never
 *      twice, and never after it is terminal.
 *   2. FIRE THE REPORT SINK for the claimed row — the SAME report-back surface a
 *      clean completion uses — as a best-effort NOTIFICATION on top of the
 *      durable row. Only the claim winner reports.
 *
 * BEST-EFFORT REPORT — the durable row is the source of truth. The report sink is
 * a notification, not the record. A sink failure does NOT un-claim the row (the
 * crash is already durably recorded + returned here), exactly as the live
 * agent-aware watchdog treats its own `notify` (`watchdog.ts`: `failRun` commits,
 * then `notify` is best-effort). Indeed the production report path
 * (`buildDispatchWatchdogNotifier`) already swallows sink rejections internally,
 * so "commit then best-effort notify" is the only self-consistent contract: the
 * orphan is never lost (the row persists), and a duplicate notification is
 * structurally impossible (the atomic claim already fired).
 *
 * It does NOT re-hydrate the record into the in-memory registry (the spec is
 * "surface, don't resume") — the process that was awaiting it is gone.
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
   * Report-back sink — invoked once per CLAIMED orphan with the now-`crashed`
   * record, AFTER the atomic store claim. Best-effort: a throw is caught and
   * swallowed (the crash is already durably recorded + returned), and a sink
   * failure never aborts the sweep or re-opens the already-committed row.
   */
  report?: BootSweepReport
  /** Now-injection for tests. Default `Date.now`. */
  now?: () => number
}

/**
 * Reap orphaned dispatches left in-flight by a prior process. Atomically claims
 * each live persisted row `crashed` (the durable surfacing) and fires the report
 * sink once per claimed orphan. Returns the records it claimed this sweep.
 * Concurrency- and restart-idempotent: the guarded claim admits exactly one
 * winner per row.
 */
export async function sweepOrphanedDispatchesOnBoot(
  deps: BootSweepDeps,
): Promise<SubagentRecord[]> {
  const now = (deps.now ?? Date.now)()
  const surfaced: SubagentRecord[] = []

  for (const rec of deps.store.loadLive()) {
    // ATOMIC CLAIM first — a mutex-serialized `db.transaction` that guard-reads
    // the status and transitions `live → crashed` in one atomic step. Its truthy
    // result means THIS sweep won the transition; a concurrent sweep (its claim
    // transaction serializes after) reads `crashed` and loses (returns false), as
    // does a later boot — so the orphan is claimed + reported EXACTLY ONCE and
    // never re-fired once terminal. Claiming before the report is what closes the
    // double-report race.
    // eslint-disable-next-line no-await-in-loop
    const claimed = await deps.store.markCrashed(rec.run_id, 'process_dead', now)
    if (!claimed) continue

    const crashed: SubagentRecord = {
      ...rec,
      status: 'crashed',
      failure_reason: 'process_dead',
      ended_at: now,
      last_event_at: now,
    }
    surfaced.push(crashed)

    // Best-effort NOTIFICATION on top of the durable claimed row. A sink failure
    // does not vanish the orphan (the row persists + is returned here) nor
    // re-open it — mirrors the live watchdog's `notify` contract, and the
    // production reporter (`buildDispatchWatchdogNotifier`) swallows rejections
    // internally anyway.
    if (deps.report) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await deps.report(crashed)
      } catch {
        // Durable row already records the crash; the notification is best-effort.
      }
    }
  }

  return surfaced
}
