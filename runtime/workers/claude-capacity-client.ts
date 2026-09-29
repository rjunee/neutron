import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { BoundedWorkRequest } from '../bounded-work.ts'

/** Public verification material only. Provisioned outside instance-writable ancestry. */
export interface ClaudeCapacityPin {
  version: 1; publicKey: string; hostId: string; instanceId: string; socketPath: string; claudeConfigDir: string
}
export interface ClaudeCapacityInput {
  request: BoundedWorkRequest; leaseId: string; childId: string; eventDigest: string
  configDir: string; env: Record<string, string | undefined>; signal: AbortSignal; deadline: number
}
interface CapacityRequest {
  version: 1; kind: 'claude-capacity-request'; instanceId: string; challenge: string
  modelId: string; requestDigest: string; leaseId: string; childId: string; eventDigest: string
}
export interface ClaudeCapacityReceipt {
  body: Omit<CapacityRequest, 'kind'> & { kind: 'claude-capacity'; hostId: string; bootId: string
    status: 'available' | 'all-full' | 'unknown'; accountGeneration: string | null; observedAtMs: number; retryAtMs: number | null }
  signature: string
}
export type ClaudeCapacityOutcome = { kind: 'available'; receipt: ClaudeCapacityReceipt; current(): boolean; release(): void }
  | { kind: 'waiting'; receipt: ClaudeCapacityReceipt } | { kind: 'unknown' }
export type AcquireClaudeCapacity = (input: ClaudeCapacityInput) => Promise<ClaudeCapacityOutcome>
const unknown = (): ClaudeCapacityOutcome => ({ kind: 'unknown' })
const text = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(v)
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const MAX_AGE_MS = 30_000

function protectedDirectory(path: string): void {
  const info = lstatSync(path)
  if (!isAbsolute(path) || !info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path
    || info.uid !== 0 || (info.mode & 0o022) !== 0) throw Error('Untrusted capacity path')
  const parent = dirname(path)
  if (parent !== path) protectedDirectory(parent)
}

export function loadClaudeCapacityPin(): ClaudeCapacityPin | undefined {
  try {
    const uid = process.geteuid?.()
    if (!Number.isSafeInteger(uid)) return undefined
    const path = `/etc/neutron/claude-capacity/${uid}.json`
    protectedDirectory(dirname(path))
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0 || info.nlink !== 1 || info.size > 16384) return undefined
      const pin = JSON.parse(readFileSync(fd, 'utf8')) as ClaudeCapacityPin
      if (!validPin(pin)) return undefined
      protectedDirectory(dirname(pin.socketPath))
      const socket = lstatSync(pin.socketPath)
      return socket.isSocket() && socket.uid === 0 ? pin : undefined
    } finally { closeSync(fd) }
  } catch { return undefined }
}

function validPin(pin: ClaudeCapacityPin): boolean {
  return pin?.version === 1 && text(pin.hostId) && text(pin.instanceId) && typeof pin.publicKey === 'string'
    && isAbsolute(pin.socketPath) && Buffer.byteLength(pin.socketPath) < 104 && isAbsolute(pin.claudeConfigDir)
    && createPublicKey(pin.publicKey).asymmetricKeyType === 'ed25519'
}

/** Reject immutable, descriptor, helper and alternate-provider auth routes.
 * Only canonical file authentication is eligible; this reads no credentials. */
export function claudeCapacityFileAuth(pin: ClaudeCapacityPin, input: Pick<ClaudeCapacityInput, 'configDir' | 'env'>): boolean {
  try {
    const competing = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CCR_OAUTH_TOKEN_FILE',
      'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
      'CLAUDE_CODE_API_KEY_HELPER', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
    if (competing.some(key => Boolean(input.env[key]))) return false
    if (input.env.CLAUDE_CONFIG_DIR && resolve(input.env.CLAUDE_CONFIG_DIR) !== pin.claudeConfigDir) return false
    return resolve(input.configDir) === pin.claudeConfigDir && realpathSync(input.configDir) === pin.claudeConfigDir
  } catch { return false }
}

/** The pin is supplied by the trusted host, never by a worker or receipt.
 * Exported separately from provisioning for real-socket consuming tests. */
export async function connectClaudeCapacity(pin: ClaudeCapacityPin, input: ClaudeCapacityInput): Promise<ClaudeCapacityOutcome> {
  try {
    if (!validPin(pin) || !claudeCapacityFileAuth(pin, input) || input.signal.aborted || Date.now() >= input.deadline
      || !/^claude-[a-z0-9][a-z0-9.-]{1,119}$/.test(input.request.model_id)
      || !text(input.leaseId) || !text(input.childId) || !digest(input.eventDigest)) return unknown()
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const request: CapacityRequest = { version: 1, kind: 'claude-capacity-request', instanceId: pin.instanceId,
      challenge: randomBytes(24).toString('base64url'), modelId: input.request.model_id,
      requestDigest: createHash('sha256').update(JSON.stringify(input.request)).digest('hex'),
      leaseId: input.leaseId, childId: input.childId, eventDigest: input.eventDigest }
    const started = Date.now(), deadline = Math.min(input.deadline, started + 85_000)
    return await new Promise<ClaudeCapacityOutcome>(resolveResult => {
      const socket = createConnection(pin.socketPath)
      let bytes = Buffer.alloc(0), settled = false, valid = true
      const release = () => { valid = false; clearTimeout(timer); input.signal.removeEventListener('abort', abort); socket.destroy() }
      const fail = () => { release(); if (!settled) { settled = true; resolveResult(unknown()) } }
      const abort = () => fail()
      const timer = setTimeout(fail, Math.max(1, deadline - Date.now()))
      input.signal.addEventListener('abort', abort, { once: true })
      socket.on('error', fail); socket.on('close', fail); socket.on('end', fail)
      socket.once('connect', () => {
        if (input.signal.aborted) fail()
        else socket.write(JSON.stringify(request) + '\n')
      })
      socket.on('data', chunk => {
        if (settled) { fail(); return }
        bytes = Buffer.concat([bytes, Buffer.from(chunk)])
        if (bytes.length > 16384) { fail(); return }
        if (!bytes.includes(10)) return
        try {
          if (bytes.indexOf(10) !== bytes.length - 1) throw Error('Extra frame')
          const raw = bytes.subarray(0, -1).toString('utf8'), envelope = JSON.parse(raw)
          if (JSON.stringify(envelope) !== raw || !object(envelope) || Object.keys(envelope).sort().join(',') !== 'body,signature'
            || !object(envelope.body) || typeof envelope.signature !== 'string') throw Error('Invalid envelope')
          const body = envelope.body
          const { kind: _kind, ...correlations } = request
          if (Object.keys(body).sort().join(',') !== [...Object.keys(correlations), 'kind', 'hostId', 'bootId', 'status', 'accountGeneration', 'observedAtMs', 'retryAtMs'].sort().join(',')
            || Object.entries(correlations).some(([key, value]) => body[key] !== value)
            || body.kind !== 'claude-capacity' || body.hostId !== pin.hostId || body.bootId !== bootId
            || !Number.isSafeInteger(body.observedAtMs) || Number(body.observedAtMs) < started
            || Number(body.observedAtMs) > Date.now() || Date.now() - Number(body.observedAtMs) > MAX_AGE_MS
            || !['available', 'all-full', 'unknown'].includes(String(body.status))
            || (body.status === 'available' ? !digest(body.accountGeneration) || body.retryAtMs !== null : body.accountGeneration !== null)
            || (body.retryAtMs !== null && (!Number.isSafeInteger(body.retryAtMs) || Number(body.retryAtMs) <= Number(body.observedAtMs)))
            || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)
            || !verify(null, Buffer.from(JSON.stringify(body)), createPublicKey(pin.publicKey), Buffer.from(envelope.signature, 'base64'))) throw Error('Unverified capacity')
          const receipt = envelope as unknown as ClaudeCapacityReceipt
          settled = true
          if (body.status !== 'available') { release(); resolveResult(body.status === 'all-full' ? { kind: 'waiting', receipt } : unknown()); return }
          resolveResult({ kind: 'available', receipt, release, current: () => valid && !socket.destroyed && !input.signal.aborted
            && Date.now() < deadline && Date.now() - receipt.body.observedAtMs <= MAX_AGE_MS })
        } catch { fail() }
      })
    })
  } catch { return unknown() }
}

export const acquireClaudeCapacity: AcquireClaudeCapacity = async input => {
  const pin = loadClaudeCapacityPin()
  return pin ? connectClaudeCapacity(pin, input) : unknown()
}
