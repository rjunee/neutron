/**
 * gateway/project-admission-reconcile.ts — restart reconciliation of BUILD leases (#1237).
 *
 * A board-bound build holds a durable `build` lease for the life of its run
 * (`trident/board-dispatch.ts` admits it; the terminal observer releases it). Two
 * gaps can separate the lease table from the run table, and both only across a
 * crash or a lost acknowledgement:
 *
 *   (a) a run went terminal but its release never landed (the process died
 *       between the terminal commit and the observer) — the lease is STALE, and a
 *       stale lease blocks a maintenance fence forever;
 *   (b) a live run has no lease (it was created before this build shipped, or its
 *       lease was lost) — the run is INVISIBLE to a fence, which could advance to
 *       `quiesced` under it. That is the unsafe direction.
 *
 * So once at boot, before any loop starts: (a) every `build` lease whose work
 * reference names a terminal run, or no run at all, is released; (b) every
 * non-terminal run with no `build` lease is admitted one — when its scope is
 * open. A fenced scope REFUSES that admission (the store's rule), and the run is
 * counted and logged at warn: the maintenance owner's census must read that
 * scope as busy. An unknown scope is counted and logged the same way. Nothing
 * here fences, advances or replaces anything.
 *
 * Native-child (`liveChild`) leases name their RUN too, and step (a) walks them
 * the same way: a terminal or missing run's child lease is released (counted in
 * `released`); a live run's is kept (`children_kept`). A child lease is NEVER
 * re-leased: an unknown child's liveness is not evidence, and its run's kept
 * `build` lease already blocks the fence.
 */
import { createLogger } from '@neutronai/logger';
import type { TridentRun } from '@neutronai/trident/store.ts';
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts';
import type { ProjectAdmission } from './project-admission.ts';

const log = createLogger('project-admission');

/**
 * The non-terminal listing limit. EXPLICIT and large: a truncated list would
 * leave live runs unleased, which is the unsafe direction. The store's default
 * (50) is a tick-sized page, not a census.
 */
export const RECONCILE_NON_TERMINAL_LIMIT = 1_000_000;

export interface BuildLeaseReconcileDeps {
  admission: ProjectAdmission;
  runs: {
    get(id: string): TridentRun | null;
    listNonTerminal(limit: number): TridentRun[];
  };
  /** The admission scope a run belongs to: null = General, else the project id. */
  projectIdForRun(run: TridentRun): string | null;
}

export interface BuildLeaseReconcileResult {
  /** Stale leases released (terminal or missing run). */
  released: number;
  /** Leases kept because their run is live. */
  kept: number;
  /** Native-child leases kept because their run is live. */
  children_kept: number;
  /** Live runs with no lease that were admitted one. */
  leased: number;
  /** Live runs left unleased because their scope is fenced. */
  unleased_fenced: number;
  /** Live runs left unleased because their scope is not a live project. */
  unleased_unknown: number;
}

export async function reconcileBuildLeases(deps: BuildLeaseReconcileDeps): Promise<BuildLeaseReconcileResult> {
  const result: BuildLeaseReconcileResult = {
    released: 0, kept: 0, children_kept: 0, leased: 0, unleased_fenced: 0, unleased_unknown: 0,
  };
  const leasedRuns = new Set<string>();
  const releasedWork = new Set<string>();

  // (a) Stale leases: a terminal run, or no run at all.
  for (const lease of deps.admission.listLeases('build')) {
    const run = deps.runs.get(lease.workRef);
    if (run === null || isTerminalPhase(run.phase)) {
      // One piece of work is released once, whatever number of rows it holds.
      const key = JSON.stringify([lease.scope.projectId, lease.workRef]);
      if (releasedWork.has(key)) continue;
      releasedWork.add(key);
      result.released += await deps.admission.releaseBuild(lease.scope.projectId, lease.workRef);
      continue;
    }
    result.kept += 1;
    leasedRuns.add(JSON.stringify([lease.scope.projectId, run.id]));
  }
  // Native-child leases: released with a terminal or missing run, kept with a live
  // one. `releaseBuild` removes a run's build AND child rows, so a run released
  // above is skipped here (its child rows are already gone).
  for (const lease of deps.admission.listLeases('liveChild')) {
    const run = deps.runs.get(lease.workRef);
    if (run === null || isTerminalPhase(run.phase)) {
      const key = JSON.stringify([lease.scope.projectId, lease.workRef]);
      if (releasedWork.has(key)) continue;
      releasedWork.add(key);
      result.released += await deps.admission.releaseBuild(lease.scope.projectId, lease.workRef);
      continue;
    }
    result.children_kept += 1;
  }

  // (b) Live runs with no lease in their own scope.
  for (const run of deps.runs.listNonTerminal(RECONCILE_NON_TERMINAL_LIMIT)) {
    const projectId = deps.projectIdForRun(run);
    if (leasedRuns.has(JSON.stringify([projectId, run.id]))) continue;
    const outcome = await deps.admission.admit(projectId, 'build', 'work-board', run.id);
    if (outcome.status === 'admitted') {
      // Kept: the lease now belongs to the run, released on its terminal event.
      result.leased += 1;
      continue;
    }
    if (outcome.status === 'fenced') {
      result.unleased_fenced += 1;
      log.warn('admission_reconcile_unleased_live_run', {
        run_id: run.id, project_id: projectId, status: 'fenced', phase: outcome.phase,
      });
      continue;
    }
    result.unleased_unknown += 1;
    log.warn('admission_reconcile_unleased_live_run', { run_id: run.id, project_id: projectId, status: 'unknown' });
  }
  return result;
}
