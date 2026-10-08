import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, isAbsolute } from 'node:path'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { readProcessIdentity } from '../adapters/claude-code/persistent/process-identity.ts'

/** Independently provisioned public material; never accepted from a worker. */
export interface ClaudeCapacityPin {
  version: 1; publicKey: string; hostId: string; instanceId: string; socketPath: string; claudeConfigDir: string
}
export interface NativeRelayParent { parentSessionId: string; parentPid: number; parentStartTicks: number; bootId: string }
interface RelayIdentity extends NativeRelayParent { version: 2; instanceId: string; challenge: string; hostId: string; scopeDigest: string }
export interface NativeRelayRegistration { body: RelayIdentity & { kind: 'claude-native-registered' }; signature: string }
/** Capability for one exact parent lifetime, containing no account credential. */
export interface NativeRelayScope { scopeToken: string; registration: NativeRelayRegistration }
export interface NativeRelayObservation {
  scopeDigest: string; sessionId: string; nativeAgentId: string; parentAgentId: string | null
  modelId: string; bodyDigest: string; status: 'available' | 'all-full' | 'unknown'
  accountGeneration: string | null; observedAtMs: number; retryAtMs: number | null
  episodeId: string; predecessorToolUseId: string | null; intentId: string | null
}
interface Correlations { nativeAgentId: string; childId: string; requestDigest: string; leaseId: string; eventDigest: string
  deadlineMs: number; budgetDigest: string; fenceDigest: string }
export interface ClaudeCapacityReceipt {
  body: RelayIdentity & Correlations & { kind: 'claude-native-observation'; observations: NativeRelayObservation[]
    capacity: { status: 'available' | 'all-full' | 'unknown'; modelId: string | null; accountGeneration: string | null; observedAtMs: number; retryAtMs: number | null } }
  signature: string
}
export interface ClaudeCapacityInput {
  request: BoundedWorkRequest; leaseId: string; childId: string; eventDigest: string; relay: NativeRelayScope
  deadlineMs: number; budgetDigest: string; fenceDigest: string
  signal: AbortSignal; deadline: number
}
export type ClaudeCapacityOutcome = { kind: 'available'; receipt: ClaudeCapacityReceipt; current(): boolean; release(): void }
  | { kind: 'waiting'; receipt: ClaudeCapacityReceipt } | { kind: 'unknown' }
export type AcquireClaudeCapacity = (input: ClaudeCapacityInput) => Promise<ClaudeCapacityOutcome>
export interface ClaudeContinuationIntent {
  episodeId: string; intentId: string; hostMessage: string; deadlineMs: number; budgetDigest: string; fenceDigest: string
}
export type ClaudeContinuationControlInput = ClaudeCapacityInput & ClaudeContinuationIntent &
  ({ action: 'prepare' | 'cancel' } | { action: 'promote'; toolUseId: string; resumedAgentId: string })
export type ControlClaudeContinuation = (input: ClaudeContinuationControlInput) => Promise<boolean>
export function nativeQuotaEpisodeId(leaseId: string, eventDigest: string, predecessorToolUseId: string | null): string {
  return hash(JSON.stringify(['native-quota-episode-v1', leaseId,
    predecessorToolUseId === null ? ['original', eventDigest] : ['send-message', predecessorToolUseId]]))
}
export class NativeRelayUnavailable extends Error { readonly substrateErrorClass = 'repl_unreconciled' as const }
const text = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(v)
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const MAX_AGE_MS = 30_000

export const NATIVE_RELAY_BASE_URL = 'http://127.0.0.1:0'

/** Stable across account rotation; host route AND local wire protocol bind warm reuse. */
export function nativeRelayRouteFingerprint(pin: ClaudeCapacityPin | undefined = loadClaudeCapacityPin()): string | undefined {
  if (!pin) return undefined
  if (!validPin(pin)) throw new NativeRelayUnavailable('Native quota relay pin is invalid')
  return `native-relay-v3:${hash(JSON.stringify([pin.hostId, pin.instanceId, pin.socketPath, pin.publicKey, NATIVE_RELAY_BASE_URL]))}`
}

function protectedDirectory(path: string): void {
  const info = lstatSync(path)
  if (!isAbsolute(path) || !info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path
    || info.uid !== 0 || (info.mode & 0o022) !== 0) throw Error('Untrusted relay path')
  const parent = dirname(path)
  if (parent !== path) protectedDirectory(parent)
}

/** Absence selects native self-host authentication. A present broken pin never falls back. */
export function loadClaudeCapacityPin(): ClaudeCapacityPin | undefined {
  const uid = process.geteuid?.()
  if (!Number.isSafeInteger(uid)) return undefined
  const path = `/etc/neutron/claude-capacity/${uid}.json`
  try { lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new NativeRelayUnavailable('Native quota relay registration is unreadable')
  }
  try {
    protectedDirectory(dirname(path))
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0 || info.nlink !== 1 || info.size > 16384) throw Error('Invalid pin')
      const pin = JSON.parse(readFileSync(fd, 'utf8')) as ClaudeCapacityPin
      if (!validPin(pin)) throw Error('Invalid pin')
      protectedDirectory(dirname(pin.socketPath))
      const socket = lstatSync(pin.socketPath)
      if (!socket.isSocket() || socket.uid !== 0) throw Error('Invalid socket')
      return pin
    } finally { closeSync(fd) }
  } catch { throw new NativeRelayUnavailable('Native quota relay registration is unavailable') }
}
function validPin(pin: ClaudeCapacityPin): boolean {
  return pin?.version === 1 && text(pin.hostId) && text(pin.instanceId) && typeof pin.publicKey === 'string'
    && isAbsolute(pin.socketPath) && Buffer.byteLength(pin.socketPath) < 104 && isAbsolute(pin.claudeConfigDir)
    && createPublicKey(pin.publicKey).asymmetricKeyType === 'ed25519'
}
function exactKeys(value: object, keys: readonly string[]): boolean { return Object.keys(value).sort().join(',') === [...keys].sort().join(',') }
function signed(pin: ClaudeCapacityPin, value: unknown): value is { body: Record<string, unknown>; signature: string } {
  return object(value) && exactKeys(value, ['body', 'signature']) && object(value.body)
    && typeof value.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(value.signature)
    && verify(null, Buffer.from(JSON.stringify(value.body)), createPublicKey(pin.publicKey), Buffer.from(value.signature, 'base64'))
}
function parentCurrent(parent: NativeRelayParent): boolean {
  const identity = readProcessIdentity(parent.parentPid)
  return identity?.start_ticks === parent.parentStartTicks && identity.boot_id === parent.bootId
}
export function nativeRelayScopeCurrent(scope: NativeRelayScope): boolean {
  try { return /^[A-Za-z0-9_-]{43}$/.test(scope.scopeToken) && scope.registration.body.scopeDigest === hash(scope.scopeToken)
    && parentCurrent(scope.registration.body) } catch { return false }
}
function verifiedScope(pin: ClaudeCapacityPin, scope: NativeRelayScope): boolean {
  return nativeRelayScopeCurrent(scope) && signed(pin, scope.registration)
    && scope.registration.body.kind === 'claude-native-registered' && scope.registration.body.version === 2
    && scope.registration.body.instanceId === pin.instanceId && scope.registration.body.hostId === pin.hostId
}

/** One canonical frame per connection on the same Unix listener as native HTTP. */
async function exchange(pin: ClaudeCapacityPin, request: object, signal: AbortSignal, deadline: number): Promise<unknown> {
  if (!validPin(pin) || signal.aborted || Date.now() >= deadline) throw Error('Relay unavailable')
  return new Promise((resolve, reject) => {
    const socket = createConnection(pin.socketPath)
    let bytes = Buffer.alloc(0), settled = false
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true
      clearTimeout(timer); signal.removeEventListener('abort', abort); socket.destroy()
      if (error) reject(error); else resolve(value)
    }
    const abort = () => finish(Error('Relay unavailable'))
    const timer = setTimeout(abort, Math.max(1, Math.min(deadline - Date.now(), 85_000)))
    signal.addEventListener('abort', abort, { once: true })
    socket.on('error', abort); socket.on('end', abort); socket.on('close', abort)
    socket.once('connect', () => signal.aborted ? abort() : socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, Buffer.from(chunk)])
      if (bytes.length > 1024 * 1024) { abort(); return }
      if (!bytes.includes(10)) return
      try {
        if (bytes.indexOf(10) !== bytes.length - 1) throw Error('Extra frame')
        const raw = bytes.subarray(0, -1).toString('utf8'), envelope = JSON.parse(raw)
        if (JSON.stringify(envelope) !== raw || !signed(pin, envelope)) throw Error('Unverified relay')
        finish(undefined, envelope)
      } catch { abort() }
    })
  })
}
export async function registerClaudeNativeRelay(pin: ClaudeCapacityPin, parent: NativeRelayParent, scopeToken: string,
  signal: AbortSignal, deadline: number): Promise<NativeRelayScope> {
  const request = { version: 2, kind: 'claude-native-register', instanceId: pin.instanceId,
    challenge: randomBytes(24).toString('base64url'), ...parent, scopeToken }
  const envelope = await exchange(pin, request, signal, deadline) as NativeRelayRegistration
  const expected = { version: 2, kind: 'claude-native-registered', instanceId: pin.instanceId, challenge: request.challenge,
    ...parent, hostId: pin.hostId, scopeDigest: hash(scopeToken) }
  if (!exactKeys(envelope.body, Object.keys(expected)) || Object.entries(expected).some(([key, value]) => (envelope.body as unknown as Record<string, unknown>)[key] !== value)
    || !parentCurrent(parent)) throw new NativeRelayUnavailable('Native quota relay parent registration was refused')
  return { scopeToken, registration: envelope }
}

/** Read-only freshness proof for an independently authorized permanent fence. */
export async function verifyCurrentConversationQuarantine(pin: ClaudeCapacityPin, proof: {
  operationId: string; parentSessionId: string; originalScopeDigest: string
}, quarantineDigest: string, signal: AbortSignal, deadline: number): Promise<boolean> {
  try {
    const challenge = randomBytes(24).toString('base64url')
    const envelope = await exchange(pin, { version: 2, kind: 'claude-native-conversation-quarantine-status',
      instanceId: pin.instanceId, challenge, ...proof }, signal, deadline) as { body: Record<string, unknown> }
    const expected = { version: 1, kind: 'claude-native-conversation-quarantine-status', hostId: pin.hostId,
      instanceId: pin.instanceId, challenge, ...proof, quarantineDigest, effective: true }
    return exactKeys(envelope.body, Object.keys(expected))
      && Object.entries(expected).every(([key, value]) => envelope.body[key] === value)
  } catch { return false }
}

export async function connectClaudeCapacity(pin: ClaudeCapacityPin, input: ClaudeCapacityInput): Promise<ClaudeCapacityOutcome> {
  try {
    if (!validPin(pin) || !verifiedScope(pin, input.relay) || !text(input.leaseId) || !text(input.childId) || !digest(input.eventDigest)
      || !Number.isSafeInteger(input.deadlineMs) || Date.now() >= input.deadlineMs || !digest(input.budgetDigest) || !digest(input.fenceDigest)) return { kind: 'unknown' }
    const parent = input.relay.registration.body
    const correlations: Correlations = { nativeAgentId: input.childId, childId: input.childId,
      requestDigest: hash(JSON.stringify(input.request)), leaseId: input.leaseId, eventDigest: input.eventDigest,
      deadlineMs: input.deadlineMs, budgetDigest: input.budgetDigest, fenceDigest: input.fenceDigest }
    const base = { version: 2, instanceId: pin.instanceId, scopeToken: input.relay.scopeToken, ...correlations }
    const expected = { version: 2, instanceId: pin.instanceId, hostId: pin.hostId, scopeDigest: parent.scopeDigest,
      parentSessionId: parent.parentSessionId, parentPid: parent.parentPid, parentStartTicks: parent.parentStartTicks, bootId: parent.bootId, ...correlations }
    for (const [kind, reply] of [['claude-native-bind-child', 'claude-native-child-bound'], ['claude-native-observe', 'claude-native-observation']] as const) {
      const challenge = randomBytes(24).toString('base64url'), started = Date.now()
      const envelope = await exchange(pin, { ...base, kind, challenge }, input.signal, input.deadline) as ClaudeCapacityReceipt
      const body = envelope.body, match = { ...expected, kind: reply, challenge }
      if (!exactKeys(body, [...Object.keys(match), ...(kind === 'claude-native-observe' ? ['observations', 'capacity'] : [])])
        || Object.entries(match).some(([key, value]) => (body as unknown as Record<string, unknown>)[key] !== value)
        || !nativeRelayScopeCurrent(input.relay)) return { kind: 'unknown' }
      if (kind !== 'claude-native-observe') continue
      if (!Array.isArray(body.observations) || !body.observations.length || !object(body.capacity)) return { kind: 'unknown' }
      for (const row of body.observations) {
        if (!object(row) || !exactKeys(row, ['scopeDigest', 'sessionId', 'nativeAgentId', 'parentAgentId', 'modelId', 'bodyDigest', 'status', 'accountGeneration', 'observedAtMs', 'retryAtMs', 'episodeId', 'predecessorToolUseId', 'intentId'])
          || row.scopeDigest !== parent.scopeDigest || row.sessionId !== parent.parentSessionId || row.nativeAgentId !== input.childId
          || row.parentAgentId !== null || !/^claude-[a-z0-9][a-z0-9.-]{1,119}$/.test(row.modelId) || !digest(row.bodyDigest)
          || !['available', 'all-full', 'unknown'].includes(row.status) || !Number.isSafeInteger(row.observedAtMs) || row.observedAtMs > Date.now()
          || row.accountGeneration !== null && !digest(row.accountGeneration)
          || row.predecessorToolUseId !== null && !text(row.predecessorToolUseId)
          || row.intentId !== null && !text(row.intentId)
          || (row.predecessorToolUseId === null) !== (row.intentId === null)
          || row.episodeId !== nativeQuotaEpisodeId(input.leaseId, input.eventDigest, row.predecessorToolUseId)
          || row.retryAtMs !== null && (!Number.isSafeInteger(row.retryAtMs) || row.retryAtMs <= row.observedAtMs)) return { kind: 'unknown' }
      }
      const latest = body.observations.at(-1)!, capacity = body.capacity
      if (latest.status !== 'all-full' || !exactKeys(capacity, ['status', 'modelId', 'accountGeneration', 'observedAtMs', 'retryAtMs'])
        || capacity.modelId !== latest.modelId || !Number.isSafeInteger(capacity.observedAtMs) || capacity.observedAtMs < started
        || capacity.observedAtMs > Date.now() || Date.now() - capacity.observedAtMs > MAX_AGE_MS
        || !['available', 'all-full', 'unknown'].includes(capacity.status)
        || (capacity.status === 'available' ? !digest(capacity.accountGeneration) || capacity.retryAtMs !== null : capacity.accountGeneration !== null)
        || capacity.retryAtMs !== null && (!Number.isSafeInteger(capacity.retryAtMs) || capacity.retryAtMs <= capacity.observedAtMs)) return { kind: 'unknown' }
      if (capacity.status !== 'available') return capacity.status === 'all-full' ? { kind: 'waiting', receipt: envelope } : { kind: 'unknown' }
      let released = false
      return { kind: 'available', receipt: envelope, release() { released = true }, current: () => !released && !input.signal.aborted
        && Date.now() < input.deadline && Date.now() - capacity.observedAtMs <= MAX_AGE_MS && nativeRelayScopeCurrent(input.relay) }
    }
  } catch { /* Registered route failures preserve unknown. */ }
  return { kind: 'unknown' }
}
export const acquireClaudeCapacity: AcquireClaudeCapacity = async input => {
  try { const pin = loadClaudeCapacityPin(); return pin ? await connectClaudeCapacity(pin, input) : { kind: 'unknown' } }
  catch { return { kind: 'unknown' } }
}

/** The signed broker echo binds an immutable intent; Open owns transcript verification. */
export async function connectClaudeContinuation(pin: ClaudeCapacityPin, input: ClaudeContinuationControlInput): Promise<boolean> {
  try {
    if (!verifiedScope(pin, input.relay) || !digest(input.episodeId) || !text(input.intentId)
      || !digest(input.budgetDigest) || !digest(input.fenceDigest) || !input.hostMessage
      || !Number.isSafeInteger(input.deadlineMs)
      || input.action !== 'cancel' && Date.now() >= input.deadlineMs || input.signal.aborted) return false
    const parent = input.relay.registration.body
    const fields = { nativeAgentId: input.childId, childId: input.childId, requestDigest: hash(JSON.stringify(input.request)),
      leaseId: input.leaseId, eventDigest: input.eventDigest, episodeId: input.episodeId, intentId: input.intentId,
      hostMessage: input.hostMessage, deadlineMs: input.deadlineMs, budgetDigest: input.budgetDigest, fenceDigest: input.fenceDigest }
    const challenge = randomBytes(24).toString('base64url')
    const promotion = input.action === 'promote' ? { toolUseId: input.toolUseId, resumedAgentId: input.resumedAgentId } : {}
    if (input.action === 'promote' && (!text(input.toolUseId) || input.resumedAgentId !== input.childId)) return false
    const request = { version: 2, kind: `claude-native-${input.action}-continuation`, instanceId: pin.instanceId,
      scopeToken: input.relay.scopeToken, challenge, ...fields, ...promotion }
    const envelope = await exchange(pin, request, input.signal,
      input.action === 'cancel' ? input.deadline : Math.min(input.deadline, input.deadlineMs)) as { body: Record<string, unknown> }
    const expected = { version: 2, instanceId: pin.instanceId, hostId: pin.hostId, scopeDigest: parent.scopeDigest,
      parentSessionId: parent.parentSessionId, parentPid: parent.parentPid, parentStartTicks: parent.parentStartTicks,
      bootId: parent.bootId, challenge, ...fields, ...promotion,
      kind: `claude-native-continuation-${input.action === 'prepare' ? 'prepared' : input.action === 'cancel' ? 'cancelled' : 'promoted'}`,
      state: input.action === 'prepare' ? 'pending' : input.action === 'cancel' ? 'cancelled' : 'promoted', ...(input.action === 'promote' ? {
        previousEpisodeId: input.episodeId, episodeId: nativeQuotaEpisodeId(input.leaseId, input.eventDigest, input.toolUseId) } : {}) }
    return exactKeys(envelope.body, Object.keys(expected))
      && Object.entries(expected).every(([key, value]) => envelope.body[key] === value)
      && nativeRelayScopeCurrent(input.relay) && !input.signal.aborted && (input.action === 'cancel' || Date.now() < input.deadlineMs)
  } catch { return false }
}
export const controlClaudeContinuation: ControlClaudeContinuation = async input => {
  try { const pin = loadClaudeCapacityPin(); return !!pin && await connectClaudeContinuation(pin, input) }
  catch { return false }
}
