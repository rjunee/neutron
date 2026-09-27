import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import type { ProcessIdentity } from '../adapters/claude-code/persistent/process-identity.ts'

export interface NativeDispatchLease {
  scope: { ownerHandle: string; projectId: string | null }
  generation: number
  token: string
  reason: 'liveChild'
  producer: string
  workRef: string
}
export interface NativeDispatchParent {
  sessionId: string
  childGeneration: string
  pid: number
  processIdentity: ProcessIdentity | null
}
export type NativeDispatchEvidence =
  | { kind: 'parent-bound'; parent: NativeDispatchParent }
  | { kind: 'submission-started' }
  | { kind: 'child-bound'; nativeAgentId: string }
  | { kind: 'not-submitted' }
type Phase = 'prepared' | NativeDispatchEvidence['kind']
interface RecordBody {
  version: 1
  lease: NativeDispatchLease
  request: BoundedWorkRequest
  phase: Phase
  parent: NativeDispatchParent | null
  nativeAgentId: string | null
}
export interface SignedNativeDispatchRecord { body: RecordBody; publicKey: string; signature: string }
export interface NativeDispatchAuthority {
  prepare(): SignedNativeDispatchRecord
  record(evidence: NativeDispatchEvidence): SignedNativeDispatchRecord
}

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')

/** Private key never leaves this closure or enters files, child env, or prompts.
 * The caller pins digest in the durable admission producer BEFORE beginning.
 * A receipt is not proof of native completion, process death, or cancellation. */
export function createNativeDispatchSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const keyDigest = digest(der)
  const begun = new Set<string>()
  return {
    keyDigest,
    begin(lease: NativeDispatchLease, request: BoundedWorkRequest): NativeDispatchAuthority {
      if (!lease.producer.endsWith(`:${keyDigest}`) || lease.reason !== 'liveChild'
        || lease.workRef !== JSON.stringify([request.run_id, request.step_id]) || begun.has(lease.token)) {
        throw new Error('Native dispatch signing authority does not match a fresh lease')
      }
      begun.add(lease.token)
      const body: RecordBody = structuredClone({ version: 1, lease, request, phase: 'prepared', parent: null, nativeAgentId: null })
      let prepared = false
      const signed = (): SignedNativeDispatchRecord => {
        const snapshot = structuredClone(body)
        return { body: snapshot, publicKey: der.toString('base64'),
          signature: sign(null, Buffer.from(JSON.stringify(snapshot)), privateKey).toString('base64') }
      }
      return {
        prepare() {
          if (prepared) throw new Error('Native dispatch receipt already prepared')
          prepared = true
          return signed()
        },
        record(evidence) {
          if (!prepared || body.phase === 'not-submitted') throw new Error('Native dispatch actor is not open')
          if (evidence.kind === 'parent-bound') {
            if (body.phase !== 'prepared' || !evidence.parent.sessionId || !evidence.parent.childGeneration
              || !Number.isSafeInteger(evidence.parent.pid) || evidence.parent.pid <= 0) throw new Error('Invalid original native parent')
            body.parent = structuredClone(evidence.parent)
          } else if (evidence.kind === 'submission-started') {
            if (body.phase !== 'parent-bound') throw new Error('Native dispatch requires its original parent')
          } else if (evidence.kind === 'child-bound') {
            if (body.phase !== 'submission-started' || !evidence.nativeAgentId.trim()) throw new Error('Native child is not uniquely bound')
            body.nativeAgentId = evidence.nativeAgentId
          } else if (body.phase !== 'prepared' && body.phase !== 'parent-bound') {
            throw new Error('Possibly submitted input cannot become not-submitted')
          }
          // Advance before signing/writing: any error remains conservative.
          body.phase = evidence.kind
          return signed()
        },
      }
    },
  }
}

export function nativeDispatchReceiptPath(directory: string, request: Pick<BoundedWorkRequest, 'run_id' | 'step_id'>): string {
  const key = createHash('sha256').update(JSON.stringify([request.run_id, request.step_id])).digest('hex')
  return join(directory, `claude-native-dispatch-${key}.jsonl`)
}

/** Exclusive original writer. A crash or existing file never opens another actor.
 * Synchronous fsync is required before the acting turn can call submitLine. */
export function createClaudeNativeDispatchReceipt(directory: string, request: BoundedWorkRequest, authority: NativeDispatchAuthority) {
  const fd = openSync(nativeDispatchReceiptPath(directory, request), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let closed = false
  const append = (record: SignedNativeDispatchRecord) => {
    if (closed) throw new Error('Native dispatch receipt is closed')
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('Incomplete native dispatch receipt')
    fsyncSync(fd)
  }
  const close = () => { if (!closed) { closed = true; closeSync(fd) } }
  try {
    append(authority.prepare())
    const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(parent) } finally { closeSync(parent) }
  } catch (error) { close(); throw error }
  return {
    record(evidence: NativeDispatchEvidence) {
      try { append(authority.record(evidence)) } catch (error) { close(); throw error }
      if (evidence.kind === 'not-submitted' || evidence.kind === 'child-bound') close()
    },
    close,
  }
}

/** Worker-readable storage is NOT authority. Consumers must verify against the
 * still-stored lease's pinned public key, never a key selected by the file. */
export function readClaudeNativeDispatchReceipt(directory: string, request: Pick<BoundedWorkRequest, 'run_id' | 'step_id'>): unknown {
  let fd: number | undefined
  try {
    fd = openSync(nativeDispatchReceiptPath(directory, request), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > 1024 * 1024) return undefined
    const bytes = Buffer.alloc(1024 * 1024 + 1)
    let count = 0
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, count)
      if (n === 0) break
      count += n
    }
    if (count > 1024 * 1024) return undefined
    const text = bytes.subarray(0, count).toString('utf8')
    const after = fstatSync(fd)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || !text.endsWith('\n')) return undefined
    const rows = text.trimEnd().split('\n')
    if (rows.length < 2 || rows.length > 4) return undefined
    return JSON.parse(rows.at(-1)!)
  } catch { return undefined } finally { if (fd !== undefined) closeSync(fd) }
}

export function verifyNativeDispatchNotSubmitted(receipt: unknown, request: BoundedWorkRequest, lease: NativeDispatchLease): boolean {
  try {
    if (typeof receipt !== 'object' || receipt === null) return false
    const signed = receipt as SignedNativeDispatchRecord
    if (signed.body?.version !== 1 || signed.body.phase !== 'not-submitted' || signed.body.nativeAgentId !== null
      || !isDeepStrictEqual(signed.body.request, request) || !isDeepStrictEqual(signed.body.lease, lease)
      || lease.workRef !== JSON.stringify([request.run_id, request.step_id]) || lease.reason !== 'liveChild'
      || !/^native-child:.+:[a-f0-9]{64}$/.test(lease.producer)
      || typeof signed.publicKey !== 'string' || typeof signed.signature !== 'string') return false
    const der = Buffer.from(signed.publicKey, 'base64')
    if (!lease.producer.endsWith(`:${digest(der)}`)) return false
    const key = createPublicKey({ key: der, type: 'spki', format: 'der' })
    return key.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(JSON.stringify(signed.body)), key, Buffer.from(signed.signature, 'base64'))
  } catch { return false }
}
