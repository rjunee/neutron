import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import type { AdmissionLeaseRow } from '@neutronai/gateway/project-admission-store.ts'
import type { TridentRun, TridentRunStore } from '@neutronai/trident/store.ts'
import type { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import { currentBootId } from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'
import {
  verifyHostBootObservation, verifyHostTerminationPreparation,
  type NativeHostRecoveryAuthority, type NativeHostTerminationPreparation,
} from '@neutronai/runtime/workers/native-host-termination.ts'

export interface NativeHostTerminationOptions {
  /** Trusted composition capability, never resolved from a receipt or worker file.
   * No authority means no recovery; existing durable holds remain effective. */
  authority?: NativeHostRecoveryAuthority | undefined
  admission: ProjectAdmission
  runs: Pick<TridentRunStore, 'get'>
  attempts: Pick<TridentAttemptLedger, 'get'>
  projectIdForRun(run: TridentRun): string | null
  listProjectIds(): readonly string[]
  /** Test seam only. Production always measures this kernel directly. */
  kernelBootId?: () => string | undefined
}

function eligible(options: NativeHostTerminationOptions, body: NativeHostTerminationPreparation): boolean {
  try {
    const lease = body.lease
    if (lease.scope.ownerHandle !== options.admission.ownerHandle
      || (lease.scope.projectId !== null && !options.listProjectIds().includes(lease.scope.projectId))) return false
    const identity: unknown = JSON.parse(lease.workRef)
    if (!Array.isArray(identity) || identity.length !== 2 || identity.some(value => typeof value !== 'string' || !value.trim())) return false
    const [runId, stepId] = identity as [string, string]
    const run = options.runs.get(runId)
    if (!run || !isTerminalPhase(run.phase) || options.projectIdForRun(run) !== lease.scope.projectId) return false
    const attempt = options.attempts.get({ run_id: runId, step_id: stepId, attempt_id: 'dispatch' })
    return !!attempt && attempt.provider === 'anthropic' && attempt.placement === 'in-repl'
      && attempt.prepared_at !== null && attempt.started_at !== null
  } catch { return false }
}

async function observeBoot(options: NativeHostTerminationOptions) {
  const authority = options.authority
  const kernelBoot = options.kernelBootId ?? currentBootId
  const before = kernelBoot()
  if (!authority || !before) throw new Error('Independent host recovery authority or kernel boot unavailable')
  const challenge = randomUUID()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Host boot attestation timed out')) }, 5_000)
    })
    const observation = await Promise.race([authority.attestBoot(challenge, controller.signal), timeout])
    if (!verifyHostBootObservation(observation, authority, challenge, before) || kernelBoot() !== before) {
      throw new Error('Host boot attestation is unavailable or does not match this kernel')
    }
    return observation
  } finally { clearTimeout(timer) }
}

/** Operator preparation happens on the OLD kernel, after independent historical
 * placement verification. It records a durable admission gate, never termination.
 * An identical retry is allowed only while the exact lease remains prepared. */
export async function prepareNativeHostTermination(options: NativeHostTerminationOptions, evidence: unknown): Promise<boolean> {
  try {
    if (!options.authority || !verifyHostTerminationPreparation(evidence, options.authority)) return false
    // Snapshot before awaiting an external authority: callers cannot replace fields
    // between signature verification and the durable write.
    const preparation = JSON.stringify(evidence)
    const body = structuredClone(evidence.body)
    const observed = await observeBoot(options)
    if (body.bootId !== observed.body.bootId || !eligible(options, body)) return false
    return await options.admission.maintenance.prepareHostTermination(body.operationId, body.lease, preparation,
      () => (options.kernelBootId ?? currentBootId)() === body.bootId && eligible(options, body))
  } catch { return false }
}

/** Always invoked before construction/replay of native actors. Only a preparation
 * committed on the old kernel is eligible. Startup cannot prepare retrospectively.
 * Restored chat readiness, old gateway death, and run status are never death proof. */
export async function reconcileNativeHostTerminations(options: NativeHostTerminationOptions): Promise<{
  status: 'observed'; released: number; kept: number
} | { status: 'unavailable' }> {
  try {
    const pending = options.admission.maintenance.listHostTerminations()
      .filter(row => row.scope.ownerHandle === options.admission.ownerHandle && row.termination === null)
    if (pending.length === 0) return { status: 'observed', released: 0, kept: 0 }
    if (!options.authority) return { status: 'unavailable' }
    const observation = await observeBoot(options)
    let released = 0
    for (const row of pending) {
      try {
        const preparation: unknown = JSON.parse(row.preparation)
        if (!verifyHostTerminationPreparation(preparation, options.authority)) continue
        const body = preparation.body
        if (body.operationId !== row.operationId || !isDeepStrictEqual(body.lease.scope, row.scope)
          || body.bootId === observation.body.bootId || !eligible(options, body)) continue
        const lease: AdmissionLeaseRow = body.lease
        const termination = JSON.stringify({ version: 1, kind: 'terminated-by-host-reboot',
          operationId: body.operationId, preparation, observation })
        if (await options.admission.maintenance.consumeHostTermination(body.operationId, lease, row.preparation, termination,
          () => (options.kernelBootId ?? currentBootId)() === observation.body.bootId && eligible(options, body))) released++
      } catch { /* Corrupt or interrupted recovery keeps its exact durable hold. */ }
    }
    return { status: 'observed', released, kept: pending.length - released }
  } catch { return { status: 'unavailable' } }
}
