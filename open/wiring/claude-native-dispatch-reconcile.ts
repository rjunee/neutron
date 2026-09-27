import { join } from 'node:path'
import type { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import type { AdmissionLeaseRow } from '@neutronai/gateway/project-admission-store.ts'
import type { TridentRunStore, TridentRun } from '@neutronai/trident/store.ts'
import type { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { readClaudeNativeDispatchReceipt, verifyNativeDispatchNotSubmitted } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'

export interface ClaudeNativeDispatchReconcileOptions {
  /** Canonical host state root, never a path from a request or receipt. */
  stateRoot: string
  admission: Pick<ProjectAdmission, 'listLeases' | 'forNativeChild'>
  runs: Pick<TridentRunStore, 'get'>
  attempts: Pick<TridentAttemptLedger, 'get'>
  projectIdForRun(run: TridentRun): string | null
  listProjectIds(): readonly string[]
}

/** No native actor is constructed. A terminal run is eligible for inspection,
 * never evidence by itself. The signed ORIGINAL request supplies full request
 * authority; the canonical DB independently binds the run, scope and attempt.
 * Missing legacy receipts or interrupted writes keep their leases indefinitely. */
export async function reconcileClaudeNativeDispatches(options: ClaudeNativeDispatchReconcileOptions): Promise<{
  status: 'observed'; released: number; kept: number
} | { status: 'unavailable' }> {
  let scopes: Set<string | null>
  let leases: AdmissionLeaseRow[]
  try {
    scopes = new Set<string | null>([null, ...options.listProjectIds()])
    leases = options.admission.listLeases('liveChild')
  } catch { return { status: 'unavailable' } }
  let released = 0
  for (const lease of leases) {
    try {
      if (!scopes.has(lease.scope.projectId)) continue
      const identity: unknown = JSON.parse(lease.workRef)
      if (!Array.isArray(identity) || identity.length !== 2 || identity.some(value => typeof value !== 'string' || !value.trim())) continue
      const [runId, stepId] = identity as [string, string]
      const run = options.runs.get(runId)
      if (!run || options.projectIdForRun(run) !== lease.scope.projectId) continue
      const receipt = readClaudeNativeDispatchReceipt(join(options.stateRoot, encodeURIComponent(runId)), { run_id: runId, step_id: stepId })
      // This untrusted object is used only as signature input until authentication
      // against the actual stored lease succeeds. No body path is ever opened.
      const request = (receipt as { body?: { request?: BoundedWorkRequest } } | undefined)?.body?.request
      if (!request || !verifyNativeDispatchNotSubmitted(receipt, request, { ...lease, reason: 'liveChild' })) continue
      if (request.run_id !== runId || request.step_id !== stepId) continue
      const attempt = options.attempts.get({ run_id: runId, step_id: stepId, attempt_id: 'dispatch' })
      if (!attempt || attempt.provider !== 'anthropic' || attempt.placement !== 'in-repl'
        || attempt.role !== request.role || attempt.resolved_model !== request.model_id
        || attempt.prepared_at === null || attempt.started_at === null
        || attempt.outcome === 'completed' || attempt.outcome === 'blocked') continue
      if (await options.admission.forNativeChild(lease.scope.projectId).releaseUnsubmitted?.(request, receipt)) released++
    } catch { /* Unknown DB, request or artifact authority never releases this child. */ }
  }
  return { status: 'observed', released, kept: leases.length - released }
}
