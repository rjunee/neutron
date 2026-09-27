import { createPublicKey } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type Stats } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { NativeHostRecoveryAuthority } from '@neutronai/runtime/workers/native-host-termination.ts'

export const NATIVE_HOST_RECOVERY_CONFIG_ROOT = '/etc/neutron/native-host-recovery'
const MAX_BYTES = 65_536

/** Fixed operator-owned location. No environment variable, receipt field, or
 * application configuration selects the authority. Each effective UID has one install. */
export function nativeHostRecoveryConfigPath(uid: number): string {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('Host recovery requires an effective Unix user identity')
  return join(NATIVE_HOST_RECOVERY_CONFIG_ROOT, `${uid}.json`)
}

/** Includes EVERY ancestor, refusing symlinks and writable directories. A
 * root-owned leaf beneath a worker-writable directory is not a trust anchor. */
export function assertRootProtectedPath(path: string, kind: 'file' | 'socket', stat: (path: string) => Stats = lstatSync): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Host recovery path must be canonical and absolute')
  let cursor = path
  while (true) {
    const entry = stat(cursor)
    const leaf = cursor === path
    if (entry.uid !== 0 || entry.isSymbolicLink() || (!leaf || kind === 'file') && (entry.mode & 0o022) !== 0
      || (leaf ? kind === 'file' ? !entry.isFile() : !entry.isSocket() : !entry.isDirectory())) {
      throw new Error('Host recovery requires root-owned protected configuration and socket ancestry')
    }
    if (cursor === '/') break
    cursor = dirname(cursor)
  }
}

export function readNativeHostRecoveryConfig(path: string): unknown | undefined {
  try { lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  assertRootProtectedPath(path, 'file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const entry = fstatSync(fd)
    if (!entry.isFile() || entry.uid !== 0 || (entry.mode & 0o022) !== 0 || entry.size > MAX_BYTES) {
      throw new Error('Host recovery configuration is unsafe or too large')
    }
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally { closeSync(fd) }
}

/** One bounded newline-delimited JSON request/response. The supervisor must
 * authenticate the peer's UID and authorize it for instanceId. The socket may
 * permit connections, but only root may own/replace it and its ancestors. */
export function requestNativeHostBoot(socketPath: string, instanceId: string, challenge: string, signal: AbortSignal,
  deps: { connect?: (path: string) => Socket; check?: (path: string) => void } = {}): Promise<unknown> {
  signal.throwIfAborted()
  ;(deps.check ?? (path => assertRootProtectedPath(path, 'socket')))(socketPath)
  return new Promise((resolveReply, reject) => {
    const socket = (deps.connect ?? (path => createConnection(path)))(socketPath)
    let bytes = Buffer.alloc(0)
    let finished = false
    const finish = (error?: unknown, value?: unknown) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error)
      else resolveReply(value)
    }
    const abort = () => finish(new Error('Host boot attestation interrupted'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    socket.on('error', () => finish(new Error('Host boot attestation transport unavailable')))
    socket.on('end', () => finish(new Error('Host boot attestation response incomplete')))
    socket.on('close', () => { if (!finished) finish(new Error('Host boot attestation connection closed')) })
    socket.on('connect', () => socket.write(`${JSON.stringify({ version: 1, kind: 'host-boot-request', instanceId, challenge })}\n`))
    socket.on('data', (chunk: Buffer) => {
      if (finished) return
      if (bytes.length + chunk.length > MAX_BYTES) { finish(new Error('Host boot attestation response too large')); return }
      bytes = Buffer.concat([bytes, chunk])
      const boundary = bytes.indexOf(10)
      if (boundary < 0) return
      try {
        if (boundary !== bytes.length - 1) throw new Error('Multiple host boot attestation responses')
        finish(undefined, JSON.parse(bytes.subarray(0, boundary).toString('utf8')))
      } catch { finish(new Error('Invalid host boot attestation response')) }
    })
  })
}

/** Loading failures are fatal boot configuration errors, not fallback selection.
 * Optional deps are offline test seams; the server passes no overrides. */
export function loadNativeHostRecoveryAuthority(deps: {
  uid?: () => number | undefined
  read?: (path: string) => unknown | undefined
  request?: typeof requestNativeHostBoot
} = {}): NativeHostRecoveryAuthority | undefined {
  const uid = (deps.uid ?? (() => process.geteuid?.()))()
  // Non-Unix installations cannot furnish this Unix supervisor capability.
  if (uid === undefined) return undefined
  const config = (deps.read ?? readNativeHostRecoveryConfig)(nativeHostRecoveryConfigPath(uid))
  if (config === undefined) return undefined
  if (!config || typeof config !== 'object') throw new Error('Invalid host recovery operator configuration')
  const value = config as Record<string, unknown>
  if (value.version !== 1 || ['publicKey', 'hostId', 'instanceId', 'socketPath'].some(key => typeof value[key] !== 'string' || !(value[key] as string).trim())
    || !isAbsolute(value.socketPath as string) || resolve(value.socketPath as string) !== value.socketPath) {
    throw new Error('Invalid host recovery operator configuration')
  }
  const { publicKey, hostId, instanceId, socketPath } = value as { publicKey: string; hostId: string; instanceId: string; socketPath: string }
  if (createPublicKey(publicKey).asymmetricKeyType !== 'ed25519') throw new Error('Host recovery pin must be Ed25519')
  const request = deps.request ?? requestNativeHostBoot
  return Object.freeze({ publicKey, hostId, instanceId,
    attestBoot: (challenge: string, signal: AbortSignal) => request(socketPath, instanceId, challenge, signal) })
}
