/**
 * @neutronai/trident — the autonomous-build state machine.
 *
 * `advanceTridentRun(run, deps)` is the pure-ish transition function the
 * tick loop calls for every non-terminal run. It is the SQLite-row port
 * of the legacy harness's `/trident` skill loop (SKILL.md "## Subcommand: /trident
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
 * SHIPPED-ARCHITECTURE NOTE (Trident v2 exec-model): production no longer
 * drives this per-phase graph for the inner loop. The live Forge→Argus→fix
 * loop is one native CC Dynamic Workflow (`inner-workflow.mjs`), and the
 * Ralph plan→task→repeat cycle (`ralph-plan`/`ralph-task` below) is driven
 * by the OUTER `orchestrator.ts` via the `remaining_tasks` re-fire
 * (`refireNextRalphTask`, #362) — NOT by `computeTransition`. This module is
 * RETAINED for: the `stubAdvanceDeps` restart-safe no-op fallback (wired when
 * the exec-model orchestrator is absent), one-commit revertibility, and its
 * role as the executable cross-repo parity anchor for the legacy harness's `/trident` skill
 * loop (`legacy-fixes.test.ts`). Its `ralph-plan`/`ralph-task`/`forge-fix`
 * branches are therefore not reached in the shipped exec-model path.
 * ─────────────────────────────────────────────────────────────────────
 */

import { ralphCapFailureReason } from './ralph-budget.ts'
import type { TridentPhase, TridentRun, WorkflowColumnsSeen } from './store.ts'

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
  /**
   * OPTIONAL lost-update guard for the two workflow-owned columns (see
   * {@link WorkflowColumnsSeen}). Set it when this outcome was computed from a
   * row the step RE-READ mid-flight and whose `inner_checkpoint` /
   * `inner_verdict` it is carrying forward rather than authoring: the caller
   * hands it to `saveIfActive`, which then writes those two columns only while
   * the store still holds what the step saw. Omitted by every step that authors
   * them outright — those saves are unchanged.
   */
  workflow_columns_seen?: WorkflowColumnsSeen
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
    // WHY THE REASON IS TWO REASONS (#519, adversarial review item 3). Since a
    // re-dispatch can INHERIT a card's spent Ralph budget, a row can reach this branch
    // having run no iteration of its own — the measured case: a prior at 20/20 whose
    // spec doc was edited past the slug's 35th character produces a fresh `forge-init`
    // row at 20/20 with no checkpoint, which fails here. Calling that "without
    // converging" is false: nothing was attempted, so nothing failed to converge, and it
    // sends whoever reads the row hunting a planner problem that does not exist. A
    // terminal reason that misdescribes what happened is worse than a vague one.
    //
    // AND THE FIRST FIX FOR IT WAS ALSO A LIE, for the reason this whole lane keeps
    // relearning: it keyed the wording on a PROXY. The discriminator was the same
    // `inner_checkpoint === null` used below, but the CLAIM was "it inherited a spent
    // budget from an earlier run of this card" — and checkpoint-is-null does not mean
    // inheritance happened. Repro (final gate): a BRAND-NEW Ralph run created with
    // `max_ralph_rounds: 0`, transitioned from `forge-init`, has a null checkpoint and
    // round 0 and was reported as inheriting from a predecessor THAT DOES NOT EXIST.
    // That is worse than vague wording, not better: it sends whoever reads the card
    // hunting for an earlier run rather than at the data in front of them.
    //
    // SO THE CLAIM IS NARROWED TO WHAT THE ROW ACTUALLY SHOWS, and provenance is not
    // claimed at all. `inner_checkpoint === null` is kept as the discriminator because
    // for the thing it is now used to say — "this run has no build of its own" — it is
    // a FACT about this row rather than an inference: every Ralph iteration's checkpoint
    // is written by the workflow, so a null one means this row completed no phase.
    //
    // WHY NOT RECORD PROVENANCE INSTEAD, which would let the reason say more. Because
    // every signal available here is another proxy, and one more proxy is the one thing
    // this must not be. `ralph_round > 0` looks like it would work — `create` writes 0
    // for every row that inherits nothing — but THIS function advances the counter
    // without writing a checkpoint, so a run that legitimately spent its rounds through
    // the phase graph reaches the cap at `ralph_round > 0` with a null checkpoint and
    // would be mislabelled in exactly the same way. Real provenance means a new column
    // and a migration, and it buys a better sentence rather than a better decision; the
    // honest cheap answer is to stop making the claim. The two possibilities are NAMED
    // as possibilities, with the row's inability to tell them apart stated, which is
    // strictly more useful than vagueness and strictly more honest than picking one.
    //
    // The `max_ralph_rounds` token is present in both spellings — `delivery.ts` and
    // several tests key on it — so only the explanation changes, never the
    // classification.
    // THE SENTENCE IS OWNED BY `ralphCapFailureReason` (ralph-budget.ts), NOT WRITTEN
    // HERE (final gate). It used to be written here, and `refireNextRalphTask`
    // (orchestrator.ts) went on emitting "without converging" unconditionally — the same
    // rule applied to the site in front of me and not to its sibling, for the fourth time
    // on this change. The derivation of the three arms, and of why there are three rather
    // than four, lives with the function. What remains here is the call.
    //
    // THREE BRANCHES, BECAUSE THE ROW DISTINGUISHES THREE THINGS — and the previous
    // revision collapsed two of them (final gate, round three). Having correctly removed
    // a claim that was NOT determinable (inheritance), it retreated to the most general
    // wording available and thereby asserted something FALSE about the cases that were
    // never ambiguous: a brand-new run configured `max_ralph_rounds: 0` was told "the
    // budget was spent before this run began" when nothing had ever been allocated, let
    // alone spent. Keying on a proxy asserts more than you know; retreating to the most
    // general wording asserts something false about the unambiguous cases. Same error,
    // opposite sides: the message not matching what the row establishes.
    //
    // WHAT IS REACHABLE HERE, derived rather than assumed. The refusal fires iff
    // `ralph_round + 1 > max_ralph_rounds`, i.e. `ralph_round >= max_ralph_rounds`.
    // `max_ralph_rounds` is written ONLY by `TridentRunStore.create` — it is absent from
    // `TridentRunUpdate`, so nothing patches it — and `create` refuses any cap that is
    // not a non-negative safe integer (`isRalphCap`). So `cap >= 0` always, and
    // `ralph_round === 0` at this point IMPLIES `cap === 0`. The fourth combination one
    // might expect — round 0 under a positive cap — cannot reach this branch at all,
    // which is why there are three arms and not four.
    //
    //   (1) A CHECKPOINT EXISTS → this run built something and then ran out. "Without
    //       converging" is accurate for it, and it is the original wording, unchanged.
    //   (2) NO CHECKPOINT AND ralph_round === 0 → therefore cap 0: no Ralph iteration was
    //       ever authorised. Nothing was spent, by this run or any other. Determinable
    //       from the row, so the message says it plainly and claims nothing else.
    //   (3) NO CHECKPOINT AND ralph_round > 0 → the budget HAS been consumed, and that
    //       much is certain whoever consumed it. WHO is not: this row may have advanced
    //       the counter itself through the phase graph (this function bumps it without
    //       writing a checkpoint) or carried the count in from an earlier run of the
    //       card. Only THAT question needs the two-possibility wording, and the row's
    //       inability to answer it is stated rather than resolved by guessing.
    //
    // THE `max_ralph_rounds` TOKEN APPEARS IN ALL THREE, so the classification is
    // unchanged and only the explanation differs. Who actually depends on that, named
    // rather than assumed (an earlier draft of this line credited `delivery.ts`, which
    // does not mention `max_ralph_rounds` anywhere — an asserted consumer that does not
    // exist, found by re-reading the claims in this file against the code behind them):
    // `ported-fixes.test.ts`, `state-machine.test.ts` and `orchestrator.test.ts` all
    // assert the token out of `failure_reason`. No PRODUCTION reader parses it today;
    // `phase: 'failed'` is what production routes on, and that is identical on all three
    // arms.
    const failure_reason = ralphCapFailureReason(run)
    return {
      phase: 'failed',
      round: run.round,
      ralph_round: run.ralph_round,
      failure_reason,
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
