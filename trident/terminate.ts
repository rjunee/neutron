/**
 * @neutronai/trident — the terminal-write CHOKEPOINT (§F6a).
 *
 * Before this module three OUT-OF-BAND callers each hand-wrote a terminal phase
 * straight through the store, bypassing the terminal-observer chain the tick
 * loop fires (delivery + board reconcile + skill-forge):
 *
 *   - `/code stop`            (`code-command.ts` executeStop)   → `phase:'stopped'`
 *   - board X-cancel / delete (`work-board-surface.ts`)         → `phase:'stopped'`
 *
 * The tick loop is the IN-BAND terminal writer — a reap / harvest / hang-watchdog
 * transition returns an `AdvanceOutcome`, the loop `save`s it, and fires the same
 * `on_terminal` chain (`tick.ts`). The out-of-band writes never went through the
 * loop, so the observers never fired for them: a cancelled build's bound Plan item
 * was never reconciled and no result was posted.
 *
 * `buildTridentTerminator` is the ONE terminal-write path for those out-of-band
 * callers. It:
 *   1. writes the terminal phase (+ optional `failure_reason`) through the store,
 *   2. runs the SAME terminal-observer chain the loop uses — or RECORDS why it
 *      didn't (`skipped_reason`), so a deliberate skip is explicit, never silent.
 *
 * Deliberate skips are first-class: `/code stop` passes `runObservers:false`
 * because it already replies to the user synchronously, so firing delivery would
 * DOUBLE-notify. The board delete path fires the full chain (`runObservers`
 * defaults true) — that is the F6a fix.
 *
 * Observer failures are caught + logged here (not propagated): these callers are
 * best-effort cancel paths (the row is already committed terminal), so a delivery
 * outage must not block a `/code stop` reply nor a board-card delete. This mirrors
 * the loop's own `on_terminal` try/catch — one observer contract, two entry points.
 */

import { isTerminalPhase } from './state-machine.ts'
import type { TridentPhase, TridentRun } from './store.ts'
import type { TridentTerminalHook } from './tick.ts'

/**
 * The minimal store surface the chokepoint writes through: a partial update by id
 * that returns the reloaded row (or `null` if the id no longer exists).
 * `TridentRunStore` satisfies it structurally.
 */
export interface TridentTerminateStore {
  update(
    id: string,
    patch: { phase: TridentPhase; failure_reason?: string | null },
  ): Promise<TridentRun | null>
}

/** Why the observer chain did NOT run (or the write itself did not land). */
export type TerminateSkipReason =
  | 'not_terminal_phase'
  | 'run_not_found'
  | 'caller_notifies'
  | 'no_observer'
  | 'observer_error'

export interface TerminateResult {
  /** The reloaded terminal row, or `null` when the write did not land. */
  run: TridentRun | null
  /** True IFF the observer chain ran to completion for this run. */
  observed: boolean
  /** Present when `observed` is false — the specific reason. */
  skipped_reason?: TerminateSkipReason
}

export interface TridentTerminateOptions {
  /** Persisted `failure_reason` (drives the delivery copy classification). */
  reason?: string
  /**
   * Run the terminal-observer chain (delivery + reconcile). Defaults to `true`.
   * `/code stop` passes `false`: it replies to the user synchronously, so firing
   * delivery would double-notify.
   */
  runObservers?: boolean
}

export interface TridentTerminator {
  /**
   * Write `phase` (a TERMINAL phase) to run `id`, then run the observer chain
   * unless the caller opted out (or none is wired). Never throws for an observer
   * failure — best-effort by contract.
   */
  terminate(
    id: string,
    phase: TridentPhase,
    opts?: TridentTerminateOptions,
  ): Promise<TerminateResult>
}

export function buildTridentTerminator(deps: {
  store: TridentTerminateStore
  /** The terminal-observer chain (the SAME hook the tick loop fires). Absent →
   *  a write-only terminator (e.g. the `/code stop` path). */
  observer?: TridentTerminalHook | null
}): TridentTerminator {
  const observer = deps.observer ?? null
  return {
    async terminate(id, phase, opts): Promise<TerminateResult> {
      // Defensive: the terminal chokepoint only ever writes a TERMINAL phase.
      if (!isTerminalPhase(phase)) {
        return { run: null, observed: false, skipped_reason: 'not_terminal_phase' }
      }
      const patch: { phase: TridentPhase; failure_reason?: string | null } = { phase }
      if (opts?.reason !== undefined) patch.failure_reason = opts.reason
      const run = await deps.store.update(id, patch)
      if (run === null) return { run: null, observed: false, skipped_reason: 'run_not_found' }

      const runObservers = opts?.runObservers ?? true
      if (!runObservers) return { run, observed: false, skipped_reason: 'caller_notifies' }
      if (observer === null) return { run, observed: false, skipped_reason: 'no_observer' }

      try {
        await observer.onTerminal(run)
        return { run, observed: true }
      } catch (err) {
        // Best-effort: the row is already committed terminal, so an observer
        // outage must not block the caller's cancel/stop. Log + record — never
        // propagate (mirrors the tick loop's on_terminal try/catch).
        console.warn(
          `[trident] terminate observer failed for run ${run.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        return { run, observed: false, skipped_reason: 'observer_error' }
      }
    },
  }
}
