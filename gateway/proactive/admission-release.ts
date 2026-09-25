/**
 * gateway/proactive/admission-release.ts — release a build's project lease on its
 * terminal event (#1237).
 *
 * A board-bound build admits a durable `build` lease at dispatch
 * (`trident/board-dispatch.ts`) and keeps it for the life of its run. This
 * observer is the other half: composed FIRST in every terminal chain — before the
 * board reconcile and the hold sweep — so a dependent card the sweep re-dispatches
 * observes the released lease, and a maintenance fence can advance once the
 * project's last build is over.
 *
 * Idempotent (a second fire releases 0) and it never throws: a failed release is
 * logged, and restart reconciliation (`gateway/project-admission-reconcile.ts`)
 * releases whatever it missed. A stuck lease blocks maintenance, never builds.
 */
import { createLogger } from '@neutronai/logger'
import type { TridentRun } from '@neutronai/trident/store.ts'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'

const log = createLogger('project-admission')

export interface AdmissionReleaseDeps {
  /** Release every `build` lease naming this run; returns the count removed. */
  releaseBuild(run: TridentRun): Promise<number>
}

export function buildAdmissionReleaseObserver(deps: AdmissionReleaseDeps): (run: TridentRun) => Promise<void> {
  return async (run) => {
    // Only a TERMINAL run's activity is over; a non-terminal fire keeps its lease.
    if (!isTerminalPhase(run.phase)) return
    try {
      const released = await deps.releaseBuild(run)
      if (released > 0) log.info('project_admission_build_released', { run_id: run.id, released })
    } catch (err) {
      log.warn('project_admission_build_release_failed', {
        run_id: run.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
