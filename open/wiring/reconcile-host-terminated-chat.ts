import type { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import type { MaintenanceFence, ProjectAdmissionStore } from '@neutronai/gateway/project-admission-store.ts'
import type { NativeHostRecoveryAuthority } from '@neutronai/runtime/workers/native-host-termination.ts'
import type { ReplRegistryRecord } from '@neutronai/runtime/adapters/claude-code/persistent/repl-registry.ts'
import type { DeadChatReconciliation } from '@neutronai/runtime/adapters/claude-code/persistent/host-terminated-chat.ts'
import { verifyHostTerminatedChatProof, type HostTerminatedChatRequest } from './host-terminated-chat-proof.ts'

/** Retry a transient release or lost acknowledgement, never acquire somebody
 * else's maintenance epoch. Persistent failure leaves the durable fence held. */
export async function releaseReconciliationFence(store: Pick<ProjectAdmissionStore, 'abandon' | 'resume' | 'inspect'>,
  fence: MaintenanceFence): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { if (await store.abandon(fence)) return true } catch { /* Read back our exact epoch before retrying. */ }
    try {
      const current = store.resume(fence.scope)
      if (!current) {
        const observed = store.inspect(fence.scope)
        return observed?.phase === 'open' && observed.generation === fence.generation
      }
      if (current.generation !== fence.generation || current.token !== fence.token || current.phase !== fence.phase) return false
    } catch { return false }
  }
  return false
}

/** Called only after the installed owner's HTTP authentication. Admission is
 * fenced across both ownership journals, never across a subsequent model turn. */
export async function reconcileTerminatedProjectChat(raw: unknown, deps: {
  admission: ProjectAdmission
  projectIds: () => string[]
  authority: NativeHostRecoveryAuthority | undefined
  reconcile: (captured: ReplRegistryRecord, authorized: () => boolean) => Promise<DeadChatReconciliation>
  kernelBoot?: () => string | undefined
}): Promise<DeadChatReconciliation> {
  const refuse = (reason: string): DeadChatReconciliation => ({ status: 'refused', reason })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('invalid request')
  const request = raw as HostTerminatedChatRequest
  if (typeof request.operationId !== 'string' || !(request.projectId === null || typeof request.projectId === 'string')
    || request.projectId !== null && !deps.projectIds().includes(request.projectId)) return refuse('unknown scope or operation')
  const scope = deps.admission.scopeFor(request.projectId)
  const store = deps.admission.maintenance
  const row = store.listHostTerminations().find(item => item.operationId === request.operationId)
  const captured = await verifyHostTerminatedChatProof(request, row, deps.authority, deps.kernelBoot)
  if (!captured || row?.scope.ownerHandle !== scope.ownerHandle) return refuse('authenticated historical parent proof unavailable')
  const noWork = () => (request.projectId === null || deps.projectIds().includes(request.projectId))
    && !store.hasPreparedHostTermination(scope)
    && !deps.admission.listLeases().some(lease => lease.scope.projectId === request.projectId)
  const observed = store.inspect(scope)
  const preparation = JSON.parse(row.preparation)
  // Failed reconciliation may have opened a newer maintenance generation. The
  // captured parent remains bound to its own epoch; acquire today's exact fence.
  if (!observed || observed.phase !== 'open' || captured.admission_generation !== preparation.body.lease.generation
    || observed.generation < preparation.body.lease.generation || !noWork()) {
    return refuse('scope admission is not the terminated generation or still has work')
  }
  const fence = await store.beginMaintenance(scope)
  if (!fence) return refuse('scope admission changed')
  let result: DeadChatReconciliation
  try {
    result = await deps.reconcile(captured, () => {
      const current = store.inspect(scope)
      return current?.phase === 'draining' && current.generation === fence.generation && noWork()
    })
  } catch { result = refuse('ownership reconciliation unavailable') }
  if (!await releaseReconciliationFence(store, fence)) return refuse('scope admission could not reopen')
  return result
}
