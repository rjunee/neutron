/**
 * @neutronai/open — the trident terminal-run → agent-nexus observer assembly
 * (RC2 · [BEHAVIOR]).
 *
 * The composer wires the tick loop's `on_run_terminal` from THIS builder, so the
 * production assembly is one tested unit: it composes the caller's terminal
 * observers (e.g. the skill-forge auto-skillify audit) with the flag-gated RC2
 * nexus producer, each ISOLATED so a throwing observer never suppresses another.
 *
 * The nexus producer fires from the tick's POST-COMMIT `on_terminal` seam (after
 * `saveIfActive` commits) — so a discarded/retried transition can neither orphan
 * nor duplicate events — and gates on `isTridentHarvestTerminal`, which keys on
 * the durable `harvested_at` marker that ONLY the outer loop's `applyResult`
 * sets. So a stopped / garbled / reaped / FORCE-TERMINATED row (which may carry
 * an inner-written `inner_verdict` + a stale `inner_result`, but was never
 * harvested by the outer loop, so `harvested_at` is null) emits nothing — an
 * out-of-band board cancel / `/code stop` is not a harvest. Delivery is
 * best-effort at-most-once, matching the sibling `on_terminal` observers (see
 * `emitTridentTerminalEvents`). When the perfect-recall flag is off
 * (`nexus === null`) the producer is simply absent and the observer runs only
 * the caller's observers.
 */

import { createLogger } from '@neutronai/logger'
import type { NexusStore } from '@neutronai/gateway/nexus/nexus-store.ts'
import { emitTridentTerminalEvents } from '@neutronai/gateway/nexus/nexus-emit.ts'
import { isTridentHarvestTerminal } from '@neutronai/trident/orchestrator.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'

const log = createLogger('trident-nexus')

export interface TridentTerminalObserverDeps {
  /** The flag-gated per-project nexus store, or null when perfect-recall is off. */
  nexus: NexusStore | null
  /** The caller's terminal observers (skill-forge audit, …), run before the
   *  nexus producer, each isolated. */
  observers: Array<(run: TridentRun) => Promise<void>>
}

/**
 * Build the composed `on_run_terminal` observer. Runs every observer + (when the
 * flag is on) the RC2 nexus producer, each in its own try/catch so one failing
 * observer never skips the rest. Returns a single `(run) => Promise<void>`.
 */
export function buildTridentTerminalObserver(
  deps: TridentTerminalObserverDeps,
): (run: TridentRun) => Promise<void> {
  const nexus = deps.nexus
  const nexusObserver: ((run: TridentRun) => Promise<void>) | null =
    nexus !== null
      ? async (run: TridentRun): Promise<void> => {
          // AWAITED so the events are persisted before this post-commit hook
          // resolves (a graceful drain won't lose them). `harvested` gates out a
          // stopped/garbled/reaped row that only carries an inner-written verdict
          // (no genuine outer→inner handoff).
          await emitTridentTerminalEvents(nexus, run, {
            harvested: isTridentHarvestTerminal(run),
          })
        }
      : null
  const all =
    nexusObserver !== null ? [...deps.observers, nexusObserver] : deps.observers
  return async (run: TridentRun): Promise<void> => {
    for (const obs of all) {
      try {
        await obs(run)
      } catch (err) {
        log.warn('trident_terminal_observer_failed', {
          run: run.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
}
