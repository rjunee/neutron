import { createHash, createPublicKey, verify } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { isProcessIdentity } from '../adapters/claude-code/persistent/process-identity.ts'
import { verifyNativeDispatchChildBound, type NativeDispatchParent, type SignedNativeDispatchRecord } from './claude-native-dispatch-receipt.ts'
import type { HostTerminationLease, NativeHostRecoveryAuthority, SignedHostEvidence } from './native-host-termination.ts'

export interface NativeParentTerminationPreparation {
  version: 1
  kind: 'native-parent-termination-preparation'
  policy: 'expired-signed-reviews-v1' | 'expired-stopped-planner-v1'
  operationId: string
  hostId: string
  instanceId: string
  bootId: string
  ownerAuthorizedReset: true
  parent: NativeDispatchParent
  children: Array<{ lease: HostTerminationLease; dispatch: SignedNativeDispatchRecord }>
  evidenceDigest: string
}

export interface NativeParentTerminationCompletion {
  version: 1
  kind: 'native-parent-terminated'
  operationId: string
  hostId: string
  instanceId: string
  bootId: string
  preparationDigest: string
  parent: NativeDispatchParent
  observation: {
    kind: 'retained-pidfd-exit'
    openedWhileAlive: true
    preparedBeforeSignal: true
    executionTreeTerminated: true
    observedAt: number
    evidenceDigest: string
  }
}

export const nativeParentTerminationDigest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const digest = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

function authenticated(value: unknown, authority: NativeHostRecoveryAuthority): value is SignedHostEvidence<Record<string, unknown>> {
  try {
    if (!value || typeof value !== 'object') return false
    const { body, signature } = value as SignedHostEvidence<Record<string, unknown>>
    if (!body || body.version !== 1 || !nonempty(signature) || !nonempty(authority.hostId) || !nonempty(authority.instanceId)
      || body.hostId !== authority.hostId || body.instanceId !== authority.instanceId) return false
    const key = createPublicKey(authority.publicKey)
    return key.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(JSON.stringify(body)), key, Buffer.from(signature, 'base64'))
  } catch { return false }
}

/** The independent operator signature and original dispatch signatures are both
 * required. The consumer must additionally match the canonical lease multiset. */
export function verifyNativeParentTerminationPreparation(value: unknown, authority: NativeHostRecoveryAuthority):
  value is SignedHostEvidence<NativeParentTerminationPreparation> {
  try {
    if (!authenticated(value, authority)) return false
    const b = value.body as unknown as NativeParentTerminationPreparation
    const p = b.parent, launch = p?.launch
    if (b.kind !== 'native-parent-termination-preparation'
      || !['expired-signed-reviews-v1', 'expired-stopped-planner-v1'].includes(b.policy)
      || !/^[a-f0-9-]{36}$/.test(b.operationId) || !nonempty(b.bootId) || b.ownerAuthorizedReset !== true
      || !digest(b.evidenceDigest) || !p || !nonempty(p.sessionId) || !nonempty(p.childGeneration)
      || !Number.isSafeInteger(p.pid) || p.pid <= 0 || !isProcessIdentity(p.processIdentity)
      || p.processIdentity.boot_id !== b.bootId || !launch || launch.version !== 1
      || launch.sessionId !== p.sessionId || launch.childGeneration !== p.childGeneration
      || !nonempty(launch.projectId) || !digest(launch.executable?.sha256)
      || !nonempty(launch.executable?.realPath) || !nonempty(launch.executable?.version)
      || !Array.isArray(launch.argv) || !launch.argv.every(nonempty)
      || !Array.isArray(launch.tools) || !launch.tools.includes('Agent')
      || !Array.isArray(b.children) || b.children.length === 0 || b.children.length > 64) return false
    const planner = b.policy === 'expired-stopped-planner-v1'
    if (planner && b.children.length !== 1) return false
    // Standalone and panel reviews use different result formats. Their schema
    // does not grant or revoke authority to terminate the original execution.
    const first = b.children[0]!.lease
    const tokens = new Set<string>(), work = new Set<string>(), agents = new Set<string>()
    for (const { lease, dispatch } of b.children) {
      const request = dispatch?.body?.request, child = dispatch?.body?.nativeAgentId
      if (!lease || !request || !child || !verifyNativeDispatchChildBound(dispatch, request, lease)
        || !isDeepStrictEqual(dispatch.body.parent, p) || !isDeepStrictEqual(lease.scope, first.scope)
        || lease.scope.projectId !== launch.projectId || lease.generation !== first.generation
        || (planner
          ? request.role !== 'plan' || request.writable !== true || request.tools !== 'edit' || request.result.schema !== 'project-plan-v2'
          : request.role !== 'review' || request.writable !== false || request.tools !== 'read-only')
        || !Number.isSafeInteger(dispatch.body.deadlineMs)
        || dispatch.body.deadlineMs! <= 0 || tokens.has(lease.token) || work.has(lease.workRef) || agents.has(child)) return false
      tokens.add(lease.token); work.add(lease.workRef); agents.add(child)
    }
    return true
  } catch { return false }
}

/** A later missing PID cannot create this proof: the separate operator must have
 * retained the original live descriptor across preparation and targeted exit. */
export function verifyNativeParentTerminationCompletion(value: unknown, preparation: SignedHostEvidence<NativeParentTerminationPreparation>,
  authority: NativeHostRecoveryAuthority): value is SignedHostEvidence<NativeParentTerminationCompletion> {
  try {
    if (!verifyNativeParentTerminationPreparation(preparation, authority) || !authenticated(value, authority)) return false
    const b = value.body as unknown as NativeParentTerminationCompletion, o = b.observation
    return b.kind === 'native-parent-terminated' && b.operationId === preparation.body.operationId
      && b.bootId === preparation.body.bootId && b.preparationDigest === nativeParentTerminationDigest(preparation)
      && isDeepStrictEqual(b.parent, preparation.body.parent) && !!o && o.kind === 'retained-pidfd-exit'
      && o.openedWhileAlive === true && o.preparedBeforeSignal === true && o.executionTreeTerminated === true
      && Number.isSafeInteger(o.observedAt) && o.observedAt > 0 && o.observedAt <= Date.now() && digest(o.evidenceDigest)
      && preparation.body.children.every(child => child.dispatch.body.deadlineMs! <= o.observedAt)
  } catch { return false }
}
