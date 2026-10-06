import { spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function loadLibc() {
  if (process.platform !== 'linux') throw new Error('Native account admission requires Linux')
  const { dlopen, FFIType, toArrayBuffer } = require('bun:ffi') as typeof import('bun:ffi')
  const library = dlopen('libc.so.6', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  })
  return { symbols: library.symbols, errno() {
    const location = library.symbols.__errno_location()
    return location ? new Int32Array(toArrayBuffer(location, 0, 4))[0] : undefined
  } }
}
let libc: ReturnType<typeof loadLibc> | undefined

export const codexAccountWriterLauncher = fileURLToPath(new URL('./account-writer.py', import.meta.url))
export class CodexAccountWriterError extends Error {
  constructor(readonly code: 'accountBusy' | 'accountAdmissionUnknown', message: string) {
    super(`${code}: ${message}`)
    this.name = 'CodexAccountWriterError'
  }
}

export interface CodexAccountWriteLease { readonly fd: number; readonly canonicalHome: string; close(): void }

/** Permanent admission reservation, also used for short credential writes.
 * Native launch converts it into its own process-associated lifetime lock.
 * Parents only close; no parent LOCK_UN, unlink or stale reaping. */
export function acquireCodexAccountWriteLease(canonicalHome: string): CodexAccountWriteLease {
  let fd: number | undefined
  try {
    if (!isAbsolute(canonicalHome)) throw new Error('Account home must be absolute')
    mkdirSync(canonicalHome, { recursive: true, mode: 0o700 })
    canonicalHome = realpathSync(canonicalHome)
    const directory = statSync(canonicalHome, { bigint: true })
    if (!directory.isDirectory() || directory.uid !== BigInt(process.getuid!())) throw new Error('Account directory owner is unknown')
    fd = openSync(join(canonicalHome, '.neutron-account-writer.lock'),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    const stat = fstatSync(fd)
    const named = lstatSync(join(canonicalHome, '.neutron-account-writer.lock'))
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error('Account lock is not an owned private regular file')
    }
    if (stat.dev !== named.dev || stat.ino !== named.ino) throw new Error('Account reservation changed')
    libc ??= loadLibc()
    if (libc.symbols.flock(fd, 2 | 4) !== 0) {
      const errno = libc.errno()
      throw new CodexAccountWriterError(errno === 11 ? 'accountBusy' : 'accountAdmissionUnknown',
        errno === 11 ? 'Another native process owns this account; use a distinct account or wait for its exit'
          : 'Account writer admission could not be established')
    }
    const result = spawnSync('python3', ['-B', codexAccountWriterLauncher, '--census', canonicalHome], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    })
    if (result.error || result.status !== 0) {
      throw new CodexAccountWriterError(result.status === 73 ? 'accountBusy' : 'accountAdmissionUnknown',
        result.status === 73 ? 'Another native process owns this account; use a distinct account or wait for its exit'
          : 'Account writer admission could not be established')
    }
    const after = statSync(canonicalHome, { bigint: true })
    const namedAfter = lstatSync(join(canonicalHome, '.neutron-account-writer.lock'))
    if (after.dev !== directory.dev || after.ino !== directory.ino || after.uid !== directory.uid
      || realpathSync(canonicalHome) !== canonicalHome || stat.dev !== namedAfter.dev || stat.ino !== namedAfter.ino) {
      throw new Error('Account directory or reservation changed during observation')
    }
    const acquired = fd
    let closed = false
    return { fd: acquired, canonicalHome, close() { if (!closed) { closed = true; closeSync(acquired) } } }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (error instanceof CodexAccountWriterError) throw error
    throw new CodexAccountWriterError('accountAdmissionUnknown', 'Account writer admission could not be established')
  }
}

/** Use an explicit lease/try/finally for asynchronous credential writes. */
export function withCodexAccountWriteLease<T>(home: string, callback: () => T): T {
  const lease = acquireCodexAccountWriteLease(home)
  try { return callback() } finally { lease.close() }
}

export function codexAccountWriterCommand(binary: string, args: readonly string[], home?: string): string[] {
  return [Bun.which('python3') ?? 'python3', '-B', codexAccountWriterLauncher, ...(home ? ['--home', home] : []), '--', binary, ...args]
}

export function resolveCodexNativeBinary(binary: string, cwd: string, env: Record<string, string | undefined>): string {
  const result = spawnSync(Bun.which('python3') ?? 'python3', ['-B', codexAccountWriterLauncher, '--resolve', binary],
    { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10_000 })
  if (result.error || result.status !== 0) throw new CodexAccountWriterError('accountAdmissionUnknown', 'Native Codex executable could not be resolved')
  const value: unknown = JSON.parse(result.stdout)
  if (typeof value !== 'string' || !isAbsolute(value)) throw new CodexAccountWriterError('accountAdmissionUnknown', 'Native Codex executable is unknown')
  return value
}
