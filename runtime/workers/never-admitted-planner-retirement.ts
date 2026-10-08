import { createHash, createPublicKey, verify } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ClaudeCapacityPin, NativeRelayRegistration } from './claude-capacity-client.ts'
import type { NativeDispatchParent } from './claude-native-dispatch-receipt.ts'
import type { HostTerminationLease, NativeHostRecoveryAuthority, SignedHostEvidence } from './native-host-termination.ts'
import { plannerRetirementDigest } from './planner-authority-retirement.ts'

/** The capacity owner attests its durable admission fence, not native exit. */
export interface NativeConversationQuarantined {
  version: 1
  kind: 'claude-native-conversation-quarantined'
  operationId: string
  hostId: string
  instanceId: string
  bootId: string
  parentSessionId: string
  originalScopeDigest: string
  parentPid: number
  parentStartTicks: number
  quarantinedAt: number
  admissionCount: 0
  historyComplete: true
  relayDrained: true
  historyDigest: string
  /** Operator-supplied historical source custody; not measured daemon code. */
  sourceDigest: string
  /** SHA256 of UTF-8 JSON.stringify(originalRegistration). */
  routingDigest: string
}

/** Separate eligibility version. The original child-bound policy is unchanged. */
export interface NeverAdmittedPlannerAuthority {
  version: 1
  policy: 'never-admitted-conversation-v1'
  operationId: string
  hostId: string
  instanceId: string
  bootId: string
  evidenceDigest: string
  lease: HostTerminationLease
  requestDigest: string
  dispatchDigest: string
  parent: NativeDispatchParent
  nativeAgentId: null
  /** Dead host-queue authority, not an assertion about historical native dispatch. */
  conversationLeases: Array<{
    lease: Omit<HostTerminationLease, 'reason'> & { reason: 'conversation' }
    retirementOperationId: string
  }>
  conversationReset?: { topicKey: string; ownerAuthorized: true; censusDigest: string }
  observation: {
    producer: string
    observedAt: number
    consumedInputDigest: string
    relaySourceDigest: string
    originalExecutor: { pid: number; bootId: string; death: 'observed'; evidenceDigest: string }
  }
}
export interface NeverAdmittedPlannerPreparation extends NeverAdmittedPlannerAuthority {
  kind: 'planner-conversation-quarantine-preparation'
}
export interface NeverAdmittedPlannerRetirement extends NeverAdmittedPlannerAuthority {
  kind: 'planner-authority-retired'
  preparation: SignedHostEvidence<NeverAdmittedPlannerPreparation>
  quarantine: SignedHostEvidence<NativeConversationQuarantined>
}

const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim()
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0
function authenticated(value: unknown, publicKey: string): value is SignedHostEvidence<Record<string, unknown>> {
  try {
    if (!value || typeof value !== 'object') return false
    const envelope = value as SignedHostEvidence<Record<string, unknown>>
    const key = createPublicKey(publicKey)
    return !!envelope.body && typeof envelope.body === 'object' && typeof envelope.signature === 'string'
      && key.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(JSON.stringify(envelope.body)), key, Buffer.from(envelope.signature, 'base64'))
  } catch { return false }
}

/** Each authority has its own independently pinned identifier namespace.
 * Parent/session/boot and operation evidence bind them; request bodies cannot
 * nominate a key or require the two protected namespaces to be equal. */
export function verifyNeverAdmittedPlannerPreparation(value: unknown, authority: NativeHostRecoveryAuthority,
  capacity: ClaudeCapacityPin): value is SignedHostEvidence<NeverAdmittedPlannerPreparation> {
  return verifyBase(value, authority, capacity, 'planner-conversation-quarantine-preparation')
}
function verifyBase(value: unknown, authority: NativeHostRecoveryAuthority, capacity: ClaudeCapacityPin,
  kind: string): boolean {
  try {
    if (!authenticated(value, authority.publicKey)) return false
    const b = value.body as unknown as NeverAdmittedPlannerRetirement, l = b.lease, o = b.observation
    if (b.version !== 1 || b.kind !== kind || b.policy !== 'never-admitted-conversation-v1'
      || b.hostId !== authority.hostId || b.instanceId !== authority.instanceId
      || !/^[a-f0-9-]{36}$/.test(b.operationId) || !text(b.bootId) || !digest(b.evidenceDigest)
      || !digest(b.requestDigest) || !digest(b.dispatchDigest) || b.nativeAgentId !== null
      || !Array.isArray(b.conversationLeases)
      || b.conversationLeases.some(entry => !entry || !text(entry.retirementOperationId)
        || entry.lease?.reason !== 'conversation' || !entry.lease.scope
        || !text(entry.lease.scope.ownerHandle) || !text(entry.lease.scope.projectId)
        || !text(entry.lease.token) || !text(entry.lease.producer) || !text(entry.lease.workRef)
        || !Number.isSafeInteger(entry.lease.generation) || entry.lease.generation < 0)
      || (b.conversationLeases.length > 0 && (!b.conversationReset
        || b.conversationReset.ownerAuthorized !== true || !text(b.conversationReset.topicKey)
        || !digest(b.conversationReset.censusDigest)))
      || !l || l.reason !== 'liveChild' || !l.scope || !text(l.scope.ownerHandle)
      || !(l.scope.projectId === null || text(l.scope.projectId)) || !text(l.token) || !text(l.producer) || !text(l.workRef)
      || !Number.isSafeInteger(l.generation) || l.generation < 0
      || !o || !text(o.producer) || !positive(o.observedAt) || o.observedAt > Date.now()
      || !digest(o.consumedInputDigest) || !digest(o.relaySourceDigest)
      || !o.originalExecutor || !positive(o.originalExecutor.pid) || o.originalExecutor.bootId !== b.bootId
      || o.originalExecutor.death !== 'observed' || !digest(o.originalExecutor.evidenceDigest)) return false
    const parent = b.parent, relay = parent?.launch?.relay, registration = relay?.registration
    if (!parent || !positive(parent.pid) || !text(parent.sessionId) || !text(parent.childGeneration)
      || !parent.processIdentity || parent.processIdentity.boot_id !== b.bootId
      || !positive(parent.processIdentity.start_ticks) || !parent.launch || !relay || !registration
      || !authenticated(registration, capacity.publicKey)) return false
    const r = registration.body as NativeRelayRegistration['body']
    return r.version === 2 && r.kind === 'claude-native-registered' && r.hostId === capacity.hostId && r.instanceId === capacity.instanceId
      && r.bootId === b.bootId && r.parentSessionId === parent.sessionId && r.parentPid === parent.pid
      && r.parentStartTicks === parent.processIdentity.start_ticks && text(r.challenge) && digest(r.scopeDigest)
      && typeof relay.scopeToken === 'string'
      && createHash('sha256').update(relay.scopeToken).digest('hex') === r.scopeDigest
  } catch { return false }
}

export function verifyNeverAdmittedPlannerRetirement(value: unknown, authority: NativeHostRecoveryAuthority,
  capacity: ClaudeCapacityPin): value is SignedHostEvidence<NeverAdmittedPlannerRetirement> {
  try {
    if (!verifyBase(value, authority, capacity, 'planner-authority-retired')) return false
    const b = (value as SignedHostEvidence<NeverAdmittedPlannerRetirement>).body
    if (!verifyNeverAdmittedPlannerPreparation(b.preparation, authority, capacity)
      || !authenticated(b.quarantine, capacity.publicKey)) return false
    const { kind: _finalKind, quarantine: _quarantine, preparation, ...finalBase } = b
    const { kind: _prepareKind, ...prepareBase } = preparation.body
    if (b.observation.observedAt < prepareBase.observation.observedAt
      || !isDeepStrictEqual({ ...finalBase, observation: { ...finalBase.observation, observedAt: 0 } },
        { ...prepareBase, observation: { ...prepareBase.observation, observedAt: 0 } })) return false
    const parent = b.parent, registration = parent.launch!.relay!.registration
    const r = registration.body, q = b.quarantine.body, o = b.observation
    return q.version === 1 && q.kind === 'claude-native-conversation-quarantined'  && q.operationId === b.operationId
      && q.hostId === capacity.hostId && q.instanceId === capacity.instanceId && q.bootId === b.bootId
      && q.parentSessionId === parent.sessionId && q.parentPid === parent.pid && q.parentStartTicks === r.parentStartTicks
      && q.originalScopeDigest === r.scopeDigest && positive(q.quarantinedAt) && q.quarantinedAt <= o.observedAt
      && q.admissionCount === 0 && q.historyComplete === true && q.relayDrained === true
      && digest(q.historyDigest) && q.sourceDigest === o.relaySourceDigest
      && q.routingDigest === plannerRetirementDigest(registration)
  } catch { return false }
}
