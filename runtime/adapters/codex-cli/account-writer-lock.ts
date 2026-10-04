import { spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dlopen, FFIType, toArrayBuffer } from 'bun:ffi'

const libc = dlopen('libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
})

export const codexAccountWriterLauncher = fileURLToPath(new URL('./account-writer.py', import.meta.url))
export class CodexAccountWriterError extends Error {
  constructor(readonly code: 'accountBusy' | 'accountAdmissionUnknown', message: string) {
    super(`${code}: ${message}`)
    this.name = 'CodexAccountWriterError'
  }
}

export interface CodexAccountWriteLease { readonly fd: number; close(): void }

/** The inode is permanent. Closing a parent copy must never unlock a native
 * writer's inherited open-file description. No LOCK_UN, unlink or stale reaping. */
export function acquireCodexAccountWriteLease(canonicalHome: string): CodexAccountWriteLease {
  let fd: number | undefined
  try {
    if (!isAbsolute(canonicalHome)) throw new Error('Account home must be absolute')
    mkdirSync(canonicalHome, { recursive: true, mode: 0o700 })
    if (realpathSync(canonicalHome) !== canonicalHome) throw new Error('Account home must be canonical')
    fd = openSync(join(canonicalHome, '.neutron-account-writer.lock'),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error('Account lock is not an owned private regular file')
    }
    if (libc.symbols.flock(fd, 2 | 4) !== 0) {
      const location = libc.symbols.__errno_location()
      const errno = location ? new Int32Array(toArrayBuffer(location, 0, 4))[0] : undefined
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
    const acquired = fd
    let closed = false
    return { fd: acquired, close() { if (!closed) { closed = true; closeSync(acquired) } } }
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
  return ['python3', '-B', codexAccountWriterLauncher, ...(home ? ['--home', home] : []), '--', binary, ...args]
}
