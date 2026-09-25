/**
 * @neutronai/trident — the PROJECT ADMISSION seam of the build dispatch chokepoint (#1237).
 *
 * A board-bound build is work in a project conversation's scope: it runs for
 * minutes to hours, its terminal wake composes on that project's session, and a
 * maintenance fence that advanced to `quiesced` underneath it would declare a
 * project idle that is not. So every dispatch admits here BEFORE it does any git,
 * gh or row work, and the admitted lease lives for the life of the run: it is
 * released when the run goes terminal (the gateway's terminal observer) and
 * reconciled against the run table on restart.
 *
 * This interface is trident-owned and names no gateway type, because trident
 * SOURCE never imports gateway. The gateway's `ProjectAdmission.forDispatch`
 * implements it over the durable admission store; there is deliberately no
 * permissive implementation exported from source — an unwired gate is a
 * composition bug, so `BoardBoundBuildDeps.projectAdmission` is required.
 */

/** A granted lease. `release` is idempotent; only the first call can report true. */
export interface DispatchAdmitted {
  status: 'admitted'
  generation: number
  release(): Promise<boolean>
}

/**
 * `fenced`: the project is under maintenance — the dispatch is QUEUED and the hold
 * sweep re-asks. `phase` is null when the fence lifted between the refusal and
 * the read. `unknown`: the scope is not a live project — nothing is queued.
 */
export type DispatchRefusal = { status: 'fenced'; phase: string | null } | { status: 'unknown' }

/** Admission for ONE project scope, bound to one producer by the composition root. */
export interface DispatchAdmission {
  /**
   * Admit the dispatch whose run row WILL be created with `runId`, so the durable
   * lease names the run from before the row exists (no rebind, no second write).
   */
  admit(runId: string): Promise<DispatchAdmitted | DispatchRefusal>
}
