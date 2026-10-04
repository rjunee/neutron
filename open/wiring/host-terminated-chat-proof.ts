import { createHash, randomUUID } from 'node:crypto'
import type { NativeHostRecoveryAuthority } from '@neutronai/runtime/workers/native-host-termination.ts'
import { verifyHostBootObservation, verifyHostTerminationPreparation } from '@neutronai/runtime/workers/native-host-termination.ts'
import { currentBootId } from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'
import type { ReplRegistryRecord } from '@neutronai/runtime/adapters/claude-code/persistent/repl-registry.ts'
import type { NativeHostTerminationRow } from '@neutronai/gateway/project-admission-store.ts'

export interface HostTerminatedChatRequest {
  operationId: string
  projectId: string | null
  /** Exact original UTF-8 JSON bytes, never reserialized by the verifier. */
  bundle: string
  registry: string
}

/** The digest's preimage is supplied as data. Descriptor paths are never opened. */
export async function verifyHostTerminatedChatProof(request: HostTerminatedChatRequest,
  row: NativeHostTerminationRow | undefined, authority: NativeHostRecoveryAuthority | undefined,
  kernelBoot: () => string | undefined = currentBootId): Promise<ReplRegistryRecord | undefined> {
  try {
    if (!authority || !row?.termination || row.operationId !== request.operationId
      || row.scope.projectId !== request.projectId || typeof request.bundle !== 'string'
      || typeof request.registry !== 'string') return undefined
    const preparation = JSON.parse(row.preparation)
    const termination = JSON.parse(row.termination)
    const boot = kernelBoot()
    if (!boot || !verifyHostTerminationPreparation(preparation, authority)
      || preparation.body.operationId !== row.operationId
      || JSON.stringify(preparation.body.lease.scope) !== JSON.stringify(row.scope)
      || termination.kind !== 'terminated-by-host-reboot' || termination.operationId !== row.operationId
      || JSON.stringify(termination.preparation) !== JSON.stringify(preparation)
      || !verifyHostBootObservation(termination.observation, authority, termination.observation?.body?.challenge, boot)
      || preparation.body.bootId === boot
      || createHash('sha256').update(request.bundle).digest('hex') !== preparation.body.evidenceDigest) return undefined
    const bundle = JSON.parse(request.bundle)
    if (!['historical-local-repl-v1', 'retained-quota-local-repl-v1'].includes(bundle.policy)
      || bundle.identity?.hostId !== authority.hostId || bundle.identity?.instanceId !== authority.instanceId
      || bundle.identity?.bootId !== preparation.body.bootId
      || createHash('sha256').update(request.registry).digest('hex') !== bundle.registry?.sha256) return undefined
    const matches = Object.values(JSON.parse(request.registry) as Record<string, ReplRegistryRecord>)
      .filter(record => record.sessionId === bundle.identity.sessionId)
    const captured = matches[0]
    if (matches.length !== 1 || !captured || captured.child_generation !== bundle.identity.childGeneration
      || captured.pid !== bundle.identity.nativePid || captured.adoption_claim_pid !== bundle.identity.gatewayPid
      || captured.conversationProjectId !== request.projectId) return undefined
    const challenge = randomUUID()
    const observation = await authority.attestBoot(challenge, AbortSignal.timeout(5_000))
    if (!verifyHostBootObservation(observation, authority, challenge, boot) || kernelBoot() !== boot) return undefined
    return structuredClone(captured)
  } catch { return undefined }
}
