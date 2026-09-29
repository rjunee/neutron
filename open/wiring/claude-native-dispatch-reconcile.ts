import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import type { AdmissionLeaseRow } from '@neutronai/gateway/project-admission-store.ts'
import type { TridentRunStore, TridentRun } from '@neutronai/trident/store.ts'
import type { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { readClaudeNativeDispatchReceipt, verifyNativeDispatchNotSubmitted, verifyNativeDispatchChildBound } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'
import { readArmedTrailerReservation } from '@neutronai/runtime/workers/trailer-slot.ts'
import { decodeProjectTrailer } from '@neutronai/runtime/workers/project-runners.ts'
import { completeNativeChildWorkspaceRequest } from '@neutronai/runtime/workers/native-child-workspace.ts'
import { resolveLiveProjectSessions } from '@neutronai/runtime/adapters/claude-code/persistent/live-project-sessions.ts'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import { projectReviewArtifacts, projectReviewStepIdentity } from '@neutronai/trident/project-review-artifacts.ts'
import { readReviewReceipt, readReviewJson } from '@neutronai/trident/project-review-receipt.ts'
import { projectBuildTrailerDecoder } from './project-build.ts'

export interface ClaudeNativeDispatchReconcileOptions {
  /** Canonical host state root, never a path from a request or receipt. */
  stateRoot: string
  admission: Pick<ProjectAdmission, 'listLeases' | 'forNativeChild' | 'maintenance'>
  runs: Pick<TridentRunStore, 'get'>
  attempts: Pick<TridentAttemptLedger, 'get'>
  projectIdForRun(run: TridentRun): string | null
  listProjectIds(): readonly string[]
}

/** No native actor is constructed. A terminal run is eligible for inspection,
 * never evidence by itself. The signed ORIGINAL request supplies full request
 * authority; the canonical DB independently binds the run, scope and attempt.
 * Submitted terminal runs additionally require the exact armed reservation and
 * a host-validated late result. Missing evidence keeps ownership. */
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
      if (!request) continue
      const refused = verifyNativeDispatchNotSubmitted(receipt, request, { ...lease, reason: 'liveChild' })
      const submitted = verifyNativeDispatchChildBound(receipt, request, { ...lease, reason: 'liveChild' })
      if (!refused && !submitted) continue
      if (request.run_id !== runId || request.step_id !== stepId) continue
      const attempt = options.attempts.get({ run_id: runId, step_id: stepId, attempt_id: 'dispatch' })
      if (!attempt || attempt.provider !== 'anthropic' || attempt.placement !== 'in-repl'
        || attempt.role !== request.role || attempt.resolved_model !== request.model_id
        || attempt.prepared_at === null || attempt.started_at === null
        || attempt.outcome === 'completed' || attempt.outcome === 'blocked') continue
      if (refused) {
        if (await options.admission.forNativeChild(lease.scope.projectId).releaseUnsubmitted?.(request, receipt)) released++
        continue
      }
      // Failed observation does not kill the native child. Inspect terminal runs
      // without reconstructing an actor, changing outcome, or dispatching again.
      if (!isTerminalPhase(run.phase)) continue
      const state = join(options.stateRoot, encodeURIComponent(runId))
      if (!await canonicalResultPath(state, request)) continue
      const key = createHash('sha256').update(JSON.stringify([runId, stepId])).digest('hex')
      const held = await readArmedTrailerReservation(join(state, `claude-step-${key}.json`), JSON.stringify(request))
      if (held.kind !== 'resume') continue
      const bytes = await readLateResult(request.result.path)
      if (bytes === undefined) continue
      const outcome = decodeProjectTrailer(bytes, request, projectBuildTrailerDecoder(() => options.runs.get(runId)))
      if (outcome.kind !== 'completed' && outcome.kind !== 'blocked') continue
      if (!await options.admission.maintenance.release(lease)) continue
      released++
      const sessions = await resolveLiveProjectSessions(lease.scope.projectId === null ? ['general', undefined] : [lease.scope.projectId])
      for (const { session } of sessions.live) completeNativeChildWorkspaceRequest(session, request)
    } catch { /* Unknown DB, request or artifact authority never releases this child. */ }
  }
  return { status: 'observed', released, kept: leases.length - released }
}

async function canonicalResultPath(state: string, request: BoundedWorkRequest): Promise<boolean> {
  if (['plan', 'build', 'fix', 'review'].includes(request.role)
    && request.result.path === join(state, `${request.role}.result`)) return true
  if (!['review', 'synthesis'].includes(request.role) || request.result.schema !== 'verdict') return false
  const identity = projectReviewStepIdentity(request.step_id)
  if (!identity) return false
  const paths = projectReviewArtifacts(state, identity)
  if (request.result.path !== paths.result || request.brief.path !== paths.brief) return false
  const receipt = await readReviewReceipt(paths.directory, identity)
  if (!receipt || receipt.invalidated
    || receipt.requestHash !== createHash('sha256').update(JSON.stringify(request)).digest('hex')) return false
  return JSON.stringify(await readReviewJson(join(paths.directory, 'request.json'))) === JSON.stringify(request)
}

/** Passive recovery must not block on a FIFO or accept a changing snapshot. */
async function readLateResult(path: string): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > 16 * 1024 * 1024) return undefined
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (offset !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return undefined
    return bytes.subarray(0, offset).toString('utf8')
  } finally { await file.close() }
}
