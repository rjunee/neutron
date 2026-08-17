/**
 * @neutronai/trident — how many builds are sharing this box's cores right now.
 *
 * THE LIVE FAN-OUT the TEST EXECUTION budget divides the box by, when it exceeds the
 * planned fan-out (`DEFAULT_BUILD_FANOUT` in `./test-strategy.ts`, which is the constant
 * that carries the guarantee). The composer supplies it to the orchestrator as
 * `resolve_active_runs`; the orchestrator hands the count to `computeTestJobs`.
 *
 * IT LIVES HERE, NOT INLINE IN THE COMPOSER CLOSURE, so it can be tested BEHAVIOURALLY —
 * zero / one / four / over-limit / non-build phases — instead of by asserting on the
 * composer's source text, which is all round 3 shipped.
 */

/** The row shape this count needs — nothing but the phase. */
export interface ActiveRunPhaseRow {
  readonly phase: string
}

/** The store seam, narrowed to the one method this reads. */
export interface NonTerminalRunSource {
  listNonTerminal(limit: number): ActiveRunPhaseRow[]
}

/**
 * How many non-terminal rows are scanned. Deliberately generous: a cap that CLIPPED the
 * count would silently pin every build's budget at its floor, and a budget that is wrong
 * in the quiet direction is the hardest kind to notice.
 */
export const ACTIVE_BUILD_RUN_SCAN_LIMIT = 200

/** The phases that actually run a test suite. */
const BUILD_PHASES = new Set(['forge-init', 'forge-fix'])

/**
 * Count the runs currently in a BUILD phase, INCLUDING the one asking. The divisor is
 * "builds sharing these cores", and the launching run is one of them.
 *
 * ONLY THE BUILD PHASES COUNT. A run parked in `ralph-plan`/`ralph-task` (planning) or
 * `argus` (review) is burning tokens, not cores; counting it would raise the divisor and
 * starve the one build that IS running tests.
 *
 * IT OVER-COUNTS, AND THAT IS THE SAFE DIRECTION — round-3 review, correctly. A phase is
 * a RUN-LIFETIME marker, not a suite window: in pr mode `orchestrator.ts`'s
 * publish-requested branch returns without touching `phase`, so a run stays `forge-init`
 * through publish, the review re-fire and its fix rounds until `state-machine.ts` moves
 * it at harvest. This therefore reads "runs somewhere in their build lifetime", which is
 * ≥ the number executing a suite right now. The consequence is a LARGER divisor, i.e.
 * FEWER jobs — degradation toward the runner's own sequential default, never
 * oversubscription — and it cannot bite at all below `DEFAULT_BUILD_FANOUT`, because the
 * divisor is `max(FANOUT, active_runs)`. Narrowing it needs a phase that moves on
 * publish, which is a state-machine change and not a budgeting one.
 *
 * What round 4 DOES fix is the invisibility: the launcher now logs `active_runs`, the
 * `divisor` and the chosen `jobs` on every fire (`buildTestStrategyDetail`), so a box
 * pinned at the floor says so instead of looking healthy.
 *
 * NEVER SWALLOWS A STORE FAILURE. `orchestrator.launch()` catches it and falls back to
 * `active = 1` (which still divides by the constant fan-out); catching it in two places
 * would mean neither obviously owns the degradation.
 */
export function countActiveBuildRuns(store: NonTerminalRunSource): number {
  return store.listNonTerminal(ACTIVE_BUILD_RUN_SCAN_LIMIT).filter((run) => BUILD_PHASES.has(run.phase)).length
}
