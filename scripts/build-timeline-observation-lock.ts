/** Shared observation-journal mutex for the recorder and dashboard refresh.
 * The named inode is permanent; the kernel releases its flock on process death.
 * A pre-existing empty/foreign marker from the old wx protocol is refused until
 * an operator can prove that no old writer is live and remove it. */
import { constants, closeSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dlopen, FFIType } from 'bun:ffi'

const marker = 'neutron-observation-lock-v2\n'
function tryFlock(fd: number): boolean {
  const library = process.platform === 'linux' ? 'libc.so.6'
    : process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : undefined
  if (!library) throw new Error('Observation journal locking unsupported on this platform')
  const native = dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
  try { return native.symbols.flock(fd, 2 | 4) === 0 }
  finally { native.close() }
}

export function acquireObservationJournalLock(file: string): () => void {
  const name = `${file}.lock`
  let fd: number
  try {
    fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Publish a complete marker with an atomic hard link; a creator crash before
    // publication leaves only an unreferenced temporary file, never an empty lock.
    const temporary = `${name}.${randomUUID()}.tmp`
    const created = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(created, marker) } finally { closeSync(created) }
    try {
      try { linkSync(temporary, name) }
      catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') throw linkError }
    } finally { unlinkSync(temporary) }
    fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW)
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.uid !== process.getuid?.() || (opened.mode & 0o777) !== 0o600 ||
        opened.size !== Buffer.byteLength(marker) || readFileSync(fd, 'utf8') !== marker ||
        !tryFlock(fd)) throw new Error('Observation journal lock unavailable')
    // Verify the named inode after obtaining ownership. A replacement between
    // open and flock must not grant a lock on a now-orphaned inode.
    const named = lstatSync(name)
    const held = fstatSync(fd)
    if (!named.isFile() || named.isSymbolicLink() || named.dev !== held.dev || named.ino !== held.ino) {
      throw new Error('Observation journal lock changed')
    }
    // A crash after linkSync but before unlinkSync leaves the publication temp
    // as a second hard link to this same inode. It does not split the flock;
    // rejecting nlink > 1 would make that recoverable crash a permanent outage.
    return () => closeSync(fd)
  } catch (error) {
    closeSync(fd)
    throw error
  }
}
