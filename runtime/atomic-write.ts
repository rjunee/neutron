/**
 * runtime/atomic-write.ts — the ONE crash-safe file-write leaf.
 *
 * Every atomic file write in the Open tree routes through this module so the
 * durability sequence is defined in exactly one place:
 *
 *   write temp → fsync(file) → rename(temp, dest) → fsync(dir)
 *
 * The fsync on the file flushes its bytes before the rename; the rename is
 * atomic on the same filesystem (the temp staging file is created as a sibling
 * of the destination so the rename never crosses a mount boundary); the
 * directory fsync makes the rename itself durable across a power loss. A crash
 * at any point leaves either the OLD file fully intact or the NEW file fully
 * written — never a truncated document.
 *
 * Consolidation history (audit P2-7): four divergent copies existed
 * (`runtime/adapters/claude-code/persistent/atomic-write.ts`, `build-settings.ts`,
 * `tasks/projection/write.ts`, `scribe/scribe-budget.ts`); only the first
 * fsync'd, and `build-settings.ts` used a fixed `${path}.tmp` that two
 * concurrent same-path writers could clobber. This leaf unifies all four on the
 * fsync-durable sequence AND a per-process monotonic staging suffix so two
 * concurrent writes to the SAME destination never share a staging file.
 *
 * Both a sync (`atomicWriteFileSync`) and an async (`atomicWriteFile`) variant
 * are provided so hot-path callers (the gateway event loop) can avoid blocking
 * disk I/O while still getting the identical durability guarantee.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Options accepted by both write variants. */
export interface AtomicWriteOptions {
  /** File mode for the destination. Default 0o600 (owner-only). */
  mode?: number
}

const DEFAULT_MODE = 0o600

/**
 * Per-process monotonic counter for staging-file uniqueness. Combined with the
 * pid it guarantees two concurrent writes to the SAME destination path stage
 * through DIFFERENT temp files, so neither can rename a file the other is still
 * writing (the collision the former fixed `${path}.tmp` allowed).
 */
let tmpCounter = 0

/** Unique staging path: a hidden sibling of `path` in the same directory (so
 *  the eventual rename stays on one filesystem and is therefore atomic). */
function stagingPathFor(path: string): string {
  const dir = dirname(path)
  return join(dir, `.${basename(path)}.tmp-${process.pid}-${tmpCounter++}`)
}

/**
 * Atomically write `contents` to `path` (synchronous). Creates the parent dir
 * if needed. Durability sequence: temp → fsync(file) → rename → fsync(dir).
 */
export function atomicWriteFileSync(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {},
): void {
  const mode = options.mode ?? DEFAULT_MODE
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = stagingPathFor(path)
  const fd = openSync(tmp, 'w', mode)
  try {
    // `writeSync` is a single `write(2)` syscall and may short-write (return
    // fewer bytes than supplied). Loop until the WHOLE buffer is on disk before
    // fsync+rename, or a short write would publish a truncated document via the
    // rename — defeating the "never a truncated document" guarantee. (The async
    // path's `fh.writeFile` loops internally; this matches it.)
    const buf = Buffer.from(contents, 'utf8')
    let offset = 0
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  fsyncDirSync(dir)
  // Clean up a stale temp if the rename somehow left one behind (best-effort).
  try {
    if (existsSync(tmp)) unlinkSync(tmp)
  } catch {
    /* ignore */
  }
}

/**
 * Atomically write `contents` to `path` (asynchronous, via `fs/promises`).
 * Same durability sequence as the sync variant; used on hot paths so the event
 * loop is never blocked on multi-MB writes.
 */
export async function atomicWriteFile(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const mode = options.mode ?? DEFAULT_MODE
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmp = stagingPathFor(path)
  const fh = await open(tmp, 'w', mode)
  try {
    await fh.writeFile(contents)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmp, path)
  await fsyncDir(dir)
  try {
    await unlink(tmp)
  } catch {
    /* already gone (the normal case) — ignore */
  }
}

/** Best-effort directory fsync (sync). Some filesystems don't support it; the
 *  rename's atomicity still holds, so a failure here is non-fatal. */
function fsyncDirSync(dir: string): void {
  try {
    const dfd = openSync(dir, 'r')
    try {
      fsyncSync(dfd)
    } finally {
      closeSync(dfd)
    }
  } catch {
    /* directory fsync unsupported on some FS — rename atomicity still holds */
  }
}

/** Best-effort directory fsync (async). */
async function fsyncDir(dir: string): Promise<void> {
  try {
    const dh = await open(dir, 'r')
    try {
      await dh.sync()
    } finally {
      await dh.close()
    }
  } catch {
    /* directory fsync unsupported on some FS — rename atomicity still holds */
  }
}
