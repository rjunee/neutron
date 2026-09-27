import { createPublicKey, verify } from 'node:crypto'

/** An independent operator/supervisor owns this key and measures the kernel.
 * Neither the pin nor its private key may come from worker-writable state.
 * instanceId binds the canonical database installation, not its file basename.
 * Implementations authenticate the hosting machine independently of machine-id
 * (which can be cloned), and never select an authority from a submitted record. */
export interface NativeHostRecoveryAuthority {
  publicKey: string
  hostId: string
  instanceId: string
  attestBoot(challenge: string, signal: AbortSignal): Promise<unknown>
}

export interface HostTerminationLease {
  scope: { ownerHandle: string; projectId: string | null }
  generation: number
  token: string
  reason: 'liveChild'
  producer: string
  workRef: string
}

/** The independent host verifies historical LOCAL placement before signing.
 * evidenceDigest binds its retained journal/observer/source evidence bundle;
 * this is not an assertion that the child finished or input was unsubmitted. */
export interface NativeHostTerminationPreparation {
  version: 1
  kind: 'native-host-termination-preparation'
  operationId: string
  hostId: string
  instanceId: string
  bootId: string
  evidenceDigest: string
  lease: HostTerminationLease
}

export interface HostBootObservation {
  version: 1
  kind: 'host-boot'
  hostId: string
  instanceId: string
  bootId: string
  challenge: string
}

/** Sign UTF-8 JSON.stringify(body), with an Ed25519 signature encoded as base64.
 * The envelope never carries a key. Preserve the body property order in transit. */
export interface SignedHostEvidence<T> { body: T; signature: string }

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function authenticated(value: unknown, authority: NativeHostRecoveryAuthority): value is SignedHostEvidence<Record<string, unknown>> {
  try {
    if (!value || typeof value !== 'object') return false
    const { body, signature } = value as SignedHostEvidence<Record<string, unknown>>
    if (!body || typeof body !== 'object' || !nonempty(signature)
      || !nonempty(authority.hostId) || !nonempty(authority.instanceId)
      || body.version !== 1 || body.hostId !== authority.hostId || body.instanceId !== authority.instanceId) return false
    const key = createPublicKey(authority.publicKey)
    return key.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(JSON.stringify(body)), key, Buffer.from(signature, 'base64'))
  } catch { return false }
}

export function verifyHostTerminationPreparation(value: unknown, authority: NativeHostRecoveryAuthority): value is SignedHostEvidence<NativeHostTerminationPreparation> {
  if (!authenticated(value, authority)) return false
  const body = value.body as unknown as NativeHostTerminationPreparation
  const lease = body.lease
  return body.kind === 'native-host-termination-preparation'
    && nonempty(body.operationId) && nonempty(body.bootId)
    && typeof body.evidenceDigest === 'string' && /^[a-f0-9]{64}$/.test(body.evidenceDigest)
    && !!lease && lease.reason === 'liveChild' && !!lease.scope && nonempty(lease.scope.ownerHandle)
    && (lease.scope.projectId === null || nonempty(lease.scope.projectId))
    && Number.isSafeInteger(lease.generation) && lease.generation >= 0
    && nonempty(lease.token) && nonempty(lease.producer) && nonempty(lease.workRef)
}

export function verifyHostBootObservation(value: unknown, authority: NativeHostRecoveryAuthority, challenge: string, localBoot: string): value is SignedHostEvidence<HostBootObservation> {
  return authenticated(value, authority) && value.body.kind === 'host-boot'
    && nonempty(localBoot) && value.body.bootId === localBoot && value.body.challenge === challenge
}
