import { createPublicKey, verify } from 'node:crypto'
import { isCapRearmRequest, type CapRearmRequest } from '@neutronai/runtime/adapters/claude-code/persistent/operator-cap-rearm.ts'
import type { NativeHostRecoveryAuthority } from '@neutronai/runtime/workers/native-host-termination.ts'

export const CAP_REARM_AUTHORIZATION_MS = 300_000
export interface CapRearmAuthorization {
  version: 1
  kind: 'operator-repl-cap-rearm'
  hostId: string
  instanceId: string
  issuedAt: number
  expiresAt: number
  request: CapRearmRequest
}

/** A distinct operator instruction, never evidence that native work terminated.
 * The verifier's pin comes only from protected host configuration. */
export function verifyCapRearmAuthorization(envelope: unknown, authority: NativeHostRecoveryAuthority | undefined,
  now = Date.now()): CapRearmRequest | undefined {
  try {
    if (!authority || !envelope || typeof envelope !== 'object') return undefined
    const { body, signature } = envelope as { body: CapRearmAuthorization; signature: string }
    if (!body || body.version !== 1 || body.kind !== 'operator-repl-cap-rearm'
      || body.hostId !== authority.hostId || body.instanceId !== authority.instanceId
      || !Number.isSafeInteger(body.issuedAt) || !Number.isSafeInteger(body.expiresAt)
      || body.issuedAt > now || body.expiresAt <= now || body.expiresAt <= body.issuedAt
      || body.expiresAt - body.issuedAt > CAP_REARM_AUTHORIZATION_MS
      || !isCapRearmRequest(body.request) || typeof signature !== 'string') return undefined
    const key = createPublicKey(authority.publicKey)
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(JSON.stringify(body)), key,
      Buffer.from(signature, 'base64'))) return undefined
    return structuredClone(body.request)
  } catch { return undefined }
}
