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
 * Deliberate skips are first-class: the `runObservers:false` option suppresses the
 * WHOLE chain for a caller that wants a bare terminal write. `/code stop` does NOT
 * use it — it replies to the user synchronously (so a delivery post would
 * DOUBLE-notify), yet its bound board card must still be reconciled, so it composes
 * a NO-OP delivery hook + the real board-reconcile observer instead (Codex r6). The
 * board delete path fires the full chain (delivery + reconcile + skill-forge) — the
 * original F6a fix.
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
  /**
   * ATOMIC conditional terminal write: flip the run to `patch.phase` ONLY when it
   * is currently non-terminal, reporting `won` iff THIS call landed the
   * transition. A loser (`won:false`) means the run was already terminal — its
   * winning writer already ran the observer chain, so this caller must NOT.
   * `TridentRunStore.terminalTransition` satisfies it structurally.
   */
  terminalTransition(
    id: string,
    patch: { phase: TridentPhase; failure_reason?: string | null },
  ): Promise<{ run: TridentRun | null; won: boolean }>
}

/** Why the observer chain did NOT run (or the write itself did not land). */
export type TerminateSkipReason =
  | 'not_terminal_phase'
  | 'run_not_found'
  | 'already_terminal'
  | 'caller_notifies'
  | 'no_observer'
  | 'observer_error'

export interface TerminateResult {
  /** The reloaded terminal row, or `null` when the write did not land. */
  run: TridentRun | null
  /**
   * True IFF THIS call landed the terminal transition (the atomic
   * `terminalTransition` won). False when the phase was non-terminal (defensive
   * reject), the run was gone, or it was ALREADY terminal (a concurrent tick /
   * cancel won the race). Callers that report a user-visible "cancelled" outcome
   * MUST gate on this — a lost race cancelled nothing.
   */
  won: boolean
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
        return { run: null, won: false, observed: false, skipped_reason: 'not_terminal_phase' }
      }
      const patch: { phase: TridentPhase; failure_reason?: string | null } = { phase }
      if (opts?.reason !== undefined) patch.failure_reason = opts.reason
      // ATOMIC: win the transition only if the run is still non-terminal. This
      // closes the read-then-terminate race (the DELETE path reads a non-terminal
      // row, then in the await gap the tick loop can persist `done` + deliver) —
      // an unconditional write here would clobber that result AND re-fire the
      // observer chain (double-notify). A loser leaves the terminal row intact.
      const { run, won } = await deps.store.terminalTransition(id, patch)
      if (run === null) return { run: null, won: false, observed: false, skipped_reason: 'run_not_found' }
      // Already terminal (the tick loop or another cancel won): the WINNER ran the
      // observers, so running them again here would double-deliver. Skip, explicitly.
      if (!won) return { run, won: false, observed: false, skipped_reason: 'already_terminal' }

      const runObservers = opts?.runObservers ?? true
      if (!runObservers) return { run, won: true, observed: false, skipped_reason: 'caller_notifies' }
      if (observer === null) return { run, won: true, observed: false, skipped_reason: 'no_observer' }

      try {
        await observer.onTerminal(run)
        return { run, won: true, observed: true }
      } catch (err) {
        // Best-effort: the row is already committed terminal, so an observer
        // outage must not block the caller's cancel/stop. Log + record — never
        // propagate (mirrors the tick loop's on_terminal try/catch).
        console.warn(
          `[trident] terminate observer failed for run ${run.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        return { run, won: true, observed: false, skipped_reason: 'observer_error' }
      }
    },
  }
}
