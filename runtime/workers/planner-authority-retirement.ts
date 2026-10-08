import { createHash, createPublicKey, verify } from 'node:crypto'
import type { NativeDispatchParent } from './claude-native-dispatch-receipt.ts'
import type { HostTerminationLease, NativeHostRecoveryAuthority, SignedHostEvidence } from './native-host-termination.ts'

/** Independent operator judgment about scoped workflow authority. This is never
 * a native exit observation or a replacement for the original dispatch signer. */
export interface PlannerAuthorityRetirement {
  version: 1
  kind: 'planner-authority-retired'
  policy: 'expired-closed-planner-v1'
  operationId: string
  hostId: string
  instanceId: string
  bootId: string
  evidenceDigest: string
  lease: HostTerminationLease
  requestDigest: string
  dispatchDigest: string
  parent: NativeDispatchParent
  nativeAgentId: string
  observation: {
    producer: string
    observedAt: number
    profile: 'neutron-planner-v1'
    soleTool: 'mcp__neutron__planner_work'
    invocationDigest: string
    nativeEnforcementDigest: string
    noPostDispatchToolCalls: true
    originalExecutor: { pid: number; bootId: string; death: 'observed'; evidenceDigest: string }
  }
}
export const plannerRetirementDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

/** The caller supplies the protected pin; an envelope cannot nominate a key. */
export function verifyPlannerAuthorityRetirement(value: unknown, authority: NativeHostRecoveryAuthority): value is SignedHostEvidence<PlannerAuthorityRetirement> {
  try {
    if (!value || typeof value !== 'object') return false
    const { body: b, signature } = value as SignedHostEvidence<PlannerAuthorityRetirement>
    const l = b?.lease, o = b?.observation, e = o?.originalExecutor
    if (!b || b.version !== 1 || b.kind !== 'planner-authority-retired' || b.policy !== 'expired-closed-planner-v1'
      || b.hostId !== authority.hostId || b.instanceId !== authority.instanceId
      || !nonempty(b.operationId) || !nonempty(b.bootId) || !nonempty(signature)
      || !digest(b.evidenceDigest) || !digest(b.requestDigest) || !digest(b.dispatchDigest)
      || !l || l.reason !== 'liveChild' || !l.scope || !nonempty(l.scope.ownerHandle)
      || !(l.scope.projectId === null || nonempty(l.scope.projectId))
      || !Number.isSafeInteger(l.generation) || l.generation < 0 || !nonempty(l.token) || !nonempty(l.producer) || !nonempty(l.workRef)
      || !b.parent || !nonempty(b.parent.sessionId) || !nonempty(b.parent.childGeneration)
      || !Number.isSafeInteger(b.parent.pid) || b.parent.pid <= 0 || !nonempty(b.nativeAgentId)
      || !o || !nonempty(o.producer) || !Number.isSafeInteger(o.observedAt) || o.observedAt <= 0 || o.observedAt > Date.now()
      || o.profile !== 'neutron-planner-v1' || o.soleTool !== 'mcp__neutron__planner_work'
      || !digest(o.invocationDigest) || !digest(o.nativeEnforcementDigest) || o.noPostDispatchToolCalls !== true
      || !e || !Number.isSafeInteger(e.pid) || e.pid <= 0 || !nonempty(e.bootId) || e.death !== 'observed' || !digest(e.evidenceDigest)) return false
    const key = createPublicKey(authority.publicKey)
    return key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(JSON.stringify(b)), key, Buffer.from(signature, 'base64'))
  } catch { return false }
}
