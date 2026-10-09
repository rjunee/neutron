import type { AdmissionLeaseRow } from '@neutronai/gateway/project-admission-store.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'
import type { PublishedRetrySettlement } from '@neutronai/trident/published-retry-handoff.ts'
import { evidenceReader } from '@neutronai/trident/settled-review-recovery.ts'
import { decodeProjectTrailer } from '@neutronai/runtime/workers/project-runners.ts'
import { projectBuildTrailerDecoder } from './project-build.ts'

export interface PublishedRetrySettlementDeps {
  admission: { listLeases(): readonly AdmissionLeaseRow[] }
  runs: { get(id: string): TridentRun | null }
}

/** A lease names a run by its producer work reference: a bare run id, or the
 * `[run, step]` pair a native child holds. Unparseable text that mentions the
 * run is treated as naming it, so an unknown shape keeps ownership. */
function leaseNamesRun(workRef: string, runId: string): boolean {
  if (workRef === runId) return true
  try {
    const parsed: unknown = JSON.parse(workRef)
    if (Array.isArray(parsed)) return parsed.includes(runId)
  } catch { /* fall through to the conservative text test */ }
  return workRef.includes(runId)
}

/**
 * The host half of owned published retry settlement (#1476). Trident's
 * authority has already matched the original request, journal, armed
 * reservation, attempt row and result. This adds the facts only the host can
 * observe: the LIVE project-build trailer validator accepts the original result
 * bytes for that exact request, and no admission lease of any reason still
 * names the predecessor (an active native writer or unreleased child
 * ownership). Any read failure answers false.
 */
export function publishedRetrySettlement(deps: PublishedRetrySettlementDeps): PublishedRetrySettlement {
  return handoff => {
    try {
      if (deps.admission.listLeases().some(lease => leaseNamesRun(lease.workRef, handoff.prior.id))) return false
      const evidence = evidenceReader()
      const bytes = evidence.read(handoff.resultPath)
      const decoded = decodeProjectTrailer(bytes, handoff.request,
        projectBuildTrailerDecoder(() => deps.runs.get(handoff.prior.id)))
      return decoded.kind === 'completed' && evidence.stable()
        && !deps.admission.listLeases().some(lease => leaseNamesRun(lease.workRef, handoff.prior.id))
    } catch { return false }
  }
}
