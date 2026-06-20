/**
 * @neutronai/trident — the autonomous-build state machine.
 *
 * `advanceTridentRun(run, deps)` is the pure-ish transition function the
 * tick loop calls for every non-terminal run. It is the SQLite-row port
 * of Vajra's `/trident` skill loop (SKILL.md "## Subcommand: /trident
 * check"): each phase, on its in-flight sub-agent completing, advances to
 * the next phase per the skill's transition graph.
 *
 * ─────────────────────────────────────────────────────────────────────
 * SCOPE — PR-2 lands the SKELETON: the phase enum, the transition graph,
 * the round / ralph-round caps, and terminal handling. The two seams the
 * graph hangs off of are PR-3 and PR-4:
 *
 *   • PR-3 (Forge/Argus spawning) — owns `deps.classify`: reading the
 *     in-flight sub-agent's registry status + result log and turning it
 *     into a `SubagentOutcome` (running / crashed / completed-with-result),
 *     AND spawning the NEXT phase's sub-agent after a transition. PR-2
 *     ships `stubAdvanceDeps`, whose `classify` always reports `running`,
 *     so the loop is wired + restart-safe but never advances on its own.
 *
 *   • PR-4 (Ralph) — the `forge-init → ralph-plan → ralph-task` cycle is
 *     fully wired HERE (the transition graph + the `max_ralph_rounds`
 *     cap), but the planner / one-task Forge spawns those phases drive
 *     are PR-4's job via the same `deps.classify` seam.
 *
 * The transition graph itself (`computeTransition`) is pure + fully unit
 * tested now so PR-3/PR-4 only wire I/O, never re-derive control flow.
 * ─────────────────────────────────────────────────────────────────────
 */

import type { TridentPhase, TridentRun } from './store.ts'

/** The phases the loop never advances out of. */
export const TERMINAL_PHASES: readonly TridentPhase[] = ['done', 'failed', 'stopped']

export function isTerminalPhase(phase: TridentPhase): boolean {
  return TERMINAL_PHASES.includes(phase)
}

/**
 * The parsed result of a COMPLETED sub-agent, produced by `deps.classify`
 * (PR-3). Which fields are meaningful depends on the phase that completed:
 *
 *   • forge-init / ralph-plan → `remaining`: count of unchecked tasks in
 *     IMPLEMENTATION_PLAN.md. `null`/`undefined` from a LEGACY one-shot
 *     forge-init (no Ralph) is fine — it routes straight to Argus. But a
 *     `null`/`undefined` from a RALPH bootstrap or a planner is a hard
 *     fail (the skill's "missing REMAINING_TASKS fails loudly" rule):
 *     reviewing a partial governed build as if it were done is the exact
 *     danger the Ralph loop exists to prevent.
 *
 *   • argus → `approved`: true for APPROVE, false for REQUEST CHANGES.
 */
export interface PhaseResult {
  remaining?: number | null
  approved?: boolean
}

export type SubagentOutcome =
  | { status: 'running' }
  | { status: 'crashed'; reason?: string }
  | { status: 'completed'; result: PhaseResult }

export interface AdvanceDeps {
  /** ISO-8601 UTC clock; stamped into `last_advanced_at` on transition. */
  now(): string
  /**
   * PR-3/PR-4 seam — inspect the run's in-flight sub-agent and report its
   * outcome. The state machine never reads the registry / logs itself; it
   * only applies the transition the outcome implies.
   */
  classify(run: TridentRun): Promise<SubagentOutcome>
}

export interface AdvanceOutcome {
  /** The next-state run to persist (unchanged object when `changed` is false). */
  run: TridentRun
  /** Whether the phase / counters changed (i.e. caller should persist). */
  changed: boolean
  /** True when the sub-agent is still running — re-check on the next tick. */
  waiting: boolean
  /** Human-readable description of what happened (for logs / status posts). */
  note: string
}

/**
 * Pure transition: given a run + its completed sub-agent's result, compute
 * the next phase + round/ralph-round counters + any failure reason. NO I/O.
 * Exported for direct unit testing of the control flow.
 *
 * Precondition: `run.phase` is non-terminal (the caller short-circuits
 * terminals). A terminal phase here returns a no-op for defensiveness.
 */
export function computeTransition(
  run: TridentRun,
  result: PhaseResult,
): { phase: TridentPhase; round: number; ralph_round: number; failure_reason: string | null; note: string } {
  const keep = { round: run.round, ralph_round: run.ralph_round, failure_reason: null as string | null }

  switch (run.phase) {
    case 'forge-init': {
      // Legacy single-context build (no Ralph) → straight to review.
      if (!run.ralph) {
        return { phase: 'argus', ...keep, note: 'forge-init → argus (one-shot build)' }
      }
      const remaining = result.remaining
      if (remaining === null || remaining === undefined) {
        // Skill rule: a Ralph bootstrap that omits REMAINING_TASKS fails
        // loudly — never fall through to reviewing a partial governed build.
        return {
          phase: 'failed',
          round: run.round,
          ralph_round: run.ralph_round,
          failure_reason: 'ralph bootstrap emitted no valid REMAINING_TASKS',
          note: 'forge-init → failed (missing REMAINING_TASKS)',
        }
      }
      if (remaining <= 0) {
        return { phase: 'argus', ...keep, note: 'forge-init → argus (ralph build complete)' }
      }
      return enterRalphPlan(run, `forge-init → ralph-plan (${remaining} task(s) remain)`)
    }

    case 'ralph-plan': {
      const remaining = result.remaining
      if (remaining === null || remaining === undefined) {
        return {
          phase: 'failed',
          round: run.round,
          ralph_round: run.ralph_round,
          failure_reason: 'ralph planner emitted no valid REMAINING_TASKS',
          note: 'ralph-plan → failed (missing REMAINING_TASKS)',
        }
      }
      if (remaining <= 0) {
        return { phase: 'argus', ...keep, note: 'ralph-plan → argus (0 tasks remain)' }
      }
      return { phase: 'ralph-task', ...keep, note: `ralph-plan → ralph-task (${remaining} task(s) remain)` }
    }

    case 'ralph-task':
      // Every task is followed by a fresh planning pass (the active
      // drift-catch). The ralph-round increment + cap lives in
      // enterRalphPlan so the loop is bounded from both the task path and
      // the planner path by the single counter.
      return enterRalphPlan(run, 'ralph-task → ralph-plan (re-plan after task)')

    case 'argus': {
      if (result.approved === true) {
        return { phase: 'done', ...keep, note: 'argus APPROVE → done (merge + cleanup)' }
      }
      const nextRound = run.round + 1
      if (nextRound > run.max_rounds) {
        return {
          phase: 'failed',
          round: run.round,
          ralph_round: run.ralph_round,
          failure_reason: `reached max_rounds (${run.max_rounds}) without Argus APPROVE`,
          note: 'argus → failed (max rounds reached)',
        }
      }
      return {
        phase: 'forge-fix',
        round: nextRound,
        ralph_round: run.ralph_round,
        failure_reason: null,
        note: `argus REQUEST CHANGES → forge-fix (round ${nextRound}/${run.max_rounds})`,
      }
    }

    case 'forge-fix':
      return { phase: 'argus', ...keep, note: 'forge-fix → argus (re-review)' }

    default:
      // Terminal — defensive no-op (the caller short-circuits these).
      return { phase: run.phase, ...keep, note: 'no-op (terminal phase)' }
  }
}

/**
 * Enter a Ralph planning pass: increment `ralph_round` and enforce the
 * `max_ralph_rounds` cap. This is the SINGLE place the ralph-round
 * counter advances (mirrors the skill's "Spawn a Ralph planner" shared
 * block) so a non-converging plan↔task loop fails loudly rather than
 * spinning forever.
 */
function enterRalphPlan(
  run: TridentRun,
  note: string,
): { phase: TridentPhase; round: number; ralph_round: number; failure_reason: string | null; note: string } {
  const nextRalphRound = run.ralph_round + 1
  if (nextRalphRound > run.max_ralph_rounds) {
    return {
      phase: 'failed',
      round: run.round,
      ralph_round: run.ralph_round,
      failure_reason: `Ralph loop hit max_ralph_rounds (${run.max_ralph_rounds}) without converging`,
      note: 'ralph loop → failed (max ralph rounds reached)',
    }
  }
  return { phase: 'ralph-plan', round: run.round, ralph_round: nextRalphRound, failure_reason: null, note }
}

/**
 * Advance one run by one step. Reads the in-flight sub-agent's outcome via
 * `deps.classify`, then applies `computeTransition`. Returns the next-state
 * run for the caller (the tick loop) to persist when `changed`.
 *
 * On a live-phase transition the in-flight sub-agent fields
 * (`subagent_run_id` / `subagent_status`) are CLEARED — PR-3's spawn layer
 * sets them when it launches the next phase's agent. Terminal transitions
 * preserve the last sub-agent's status for the audit trail.
 */
export async function advanceTridentRun(
  run: TridentRun,
  deps: AdvanceDeps,
): Promise<AdvanceOutcome> {
  if (isTerminalPhase(run.phase)) {
    return { run, changed: false, waiting: false, note: `no-op (already ${run.phase})` }
  }

  const outcome = await deps.classify(run)

  if (outcome.status === 'running') {
    return { run, changed: false, waiting: true, note: `waiting on ${run.phase} sub-agent` }
  }

  if (outcome.status === 'crashed') {
    const next: TridentRun = {
      ...run,
      phase: 'failed',
      subagent_status: 'crashed',
      failure_reason: outcome.reason ?? 'sub-agent crashed without a completed result',
      last_advanced_at: deps.now(),
    }
    return { run: next, changed: true, waiting: false, note: `${run.phase} → failed (sub-agent crashed)` }
  }

  // completed
  const t = computeTransition(run, outcome.result)
  const terminal = isTerminalPhase(t.phase)
  const next: TridentRun = {
    ...run,
    phase: t.phase,
    round: t.round,
    ralph_round: t.ralph_round,
    failure_reason: t.failure_reason,
    // Live phase → fresh slot for PR-3 to spawn into. Terminal → keep the
    // completing agent's id, mark its status terminal for the audit trail.
    subagent_run_id: terminal ? run.subagent_run_id : null,
    subagent_status: terminal ? (t.phase === 'failed' ? 'failed' : 'completed') : null,
    last_advanced_at: deps.now(),
  }
  const changed =
    next.phase !== run.phase ||
    next.round !== run.round ||
    next.ralph_round !== run.ralph_round
  return { run: next, changed, waiting: false, note: t.note }
}

/**
 * PR-2 production seam: deps whose `classify` always reports `running`, so
 * the registered tick loop runs (idempotent, restart-safe) but never
 * advances a run on its own. PR-3 replaces this with a real
 * registry/log-reading classifier.
 */
export function stubAdvanceDeps(now: () => string = () => new Date().toISOString()): AdvanceDeps {
  return {
    now,
    classify: async () => ({ status: 'running' }),
  }
}
