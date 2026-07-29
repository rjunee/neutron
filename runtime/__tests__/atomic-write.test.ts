/**
 * Tests for the unified atomic-write leaf (`runtime/atomic-write.ts`, audit P2-7).
 *
 * Locks the NEW behavior introduced by the R6 unification:
 *   1. Round-trip durability — content persists, mode honored, no staging temp left.
 *   2. The fsync-durable SEQUENCE: write → fsync(file) → rename → fsync(dir).
 *   3. Concurrent same-path writes never share a staging file (collision fix that
 *      formerly lived in build-settings.ts `nextSettingsTmpPath`).
 *   4. A meta-guard that every known atomic-write caller routes through THIS leaf
 *      and no longer carries a divergent local copy.
 */
import { describe, test, expect, afterEach, spyOn } from 'bun:test'
import * as nodefs from 'node:fs'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteFile, atomicWriteFileSync } from '../atomic-write.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')

const dirs: string[] = []
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'atomic-write-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('atomicWriteFileSync — round-trip durability', () => {
  test('writes content and leaves no staging temp behind', () => {
    const dir = freshDir()
    const path = join(dir, 'state.json')
    atomicWriteFileSync(path, '{"a":1}')
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}')
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([])
    expect(readdirSync(dir)).toEqual(['state.json'])
  })

  test('honors a custom mode', () => {
    const dir = freshDir()
    const path = join(dir, 'settings.json')
    atomicWriteFileSync(path, 'x', { mode: 0o644 })
    // Low 9 perm bits.
    expect(statSync(path).mode & 0o777).toBe(0o644)
  })

  test('defaults to owner-only 0o600', () => {
    const dir = freshDir()
    const path = join(dir, 'secret.json')
    atomicWriteFileSync(path, 'x')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('overwrites an existing file atomically', () => {
    const dir = freshDir()
    const path = join(dir, 'state.json')
    atomicWriteFileSync(path, 'first')
    atomicWriteFileSync(path, 'second')
    expect(readFileSync(path, 'utf8')).toBe('second')
  })
})

describe('atomicWriteFileSync — short-write safety (never publishes a truncated doc)', () => {
  test('writes the COMPLETE contents even when writeSync short-writes', () => {
    const dir = freshDir()
    const path = join(dir, 'state.json')
    // A payload large enough that a real short write is plausible; the value is
    // reconstructed exactly only if every byte is looped to disk.
    const contents = 'x'.repeat(1024 * 256) + '-END'
    const realWrite = nodefs.writeSync
    let firstCall = true
    // Force a partial write on the first syscall (1 byte), full progress after,
    // exactly the failure mode the raw single-syscall path silently truncated.
    const writeSpy = spyOn(nodefs, 'writeSync').mockImplementation(
      ((fd: number, buf: never, offset: never, length: number) => {
        if (firstCall) {
          firstCall = false
          return realWrite(fd, buf, offset, 1 as never)
        }
        return realWrite(fd, buf, offset, length as never)
      }) as typeof nodefs.writeSync,
    )
    try {
      atomicWriteFileSync(path, contents)
    } finally {
      writeSpy.mockRestore()
    }
    expect(firstCall).toBe(false) // the short-write branch actually fired
    expect(readFileSync(path, 'utf8')).toBe(contents)
  })

  test('round-trips multi-byte UTF-8 content without truncation', () => {
    const dir = freshDir()
    const path = join(dir, 'state.json')
    const contents = JSON.stringify({ emoji: '😀'.repeat(2000), txt: 'café'.repeat(2000) })
    atomicWriteFileSync(path, contents)
    expect(readFileSync(path, 'utf8')).toBe(contents)
  })
})

describe('atomicWriteFileSync — durability sequence (fsync before rename)', () => {
  test('fsyncs the file, then renames, then fsyncs the dir', () => {
    const dir = freshDir()
    const path = join(dir, 'state.json')
    const order: string[] = []
    const realFsync = nodefs.fsyncSync
    const realRename = nodefs.renameSync
    const fsyncSpy = spyOn(nodefs, 'fsyncSync').mockImplementation((fd: number) => {
      order.push('fsync')
      return realFsync(fd)
    })
    const renameSpy = spyOn(nodefs, 'renameSync').mockImplementation(
      (from: nodefs.PathLike, to: nodefs.PathLike) => {
        order.push('rename')
        return realRename(from, to)
      },
    )
    try {
      atomicWriteFileSync(path, 'durable')
    } finally {
      fsyncSpy.mockRestore()
      renameSpy.mockRestore()
    }
    // At minimum: a file fsync precedes the rename. The trailing dir fsync is
    // best-effort and may be absent on filesystems that reject a dir-handle
    // fsync, so we assert the load-bearing ordering, not an exact count.
    const firstFsync = order.indexOf('fsync')
    const renameAt = order.indexOf('rename')
    expect(firstFsync).toBeGreaterThanOrEqual(0)
    expect(renameAt).toBeGreaterThan(firstFsync)
    expect(readFileSync(path, 'utf8')).toBe('durable')
  })
})

describe('atomicWriteFile (async) — round-trip durability', () => {
  test('writes content and leaves no staging temp behind', async () => {
    const dir = freshDir()
    const path = join(dir, 'state.json')
    await atomicWriteFile(path, 'async-body', { mode: 0o600 })
    expect(await readFile(path, 'utf8')).toBe('async-body')
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  test('concurrent writes to the SAME path do not collide on a staging file', async () => {
    const dir = freshDir()
    const path = join(dir, 'state.json')
    // Fire many concurrent writes at the same destination. The per-process
    // monotonic staging suffix guarantees each stages through a distinct temp,
    // so none rejects/ENOENTs and the final content is one of the payloads.
    const payloads = Array.from({ length: 25 }, (_v, i) => `payload-${i}`)
    await Promise.all(payloads.map((p) => atomicWriteFile(path, p)))
    const final = await readFile(path, 'utf8')
    expect(payloads).toContain(final)
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([])
  })
})

describe('caller convergence (audit P2-7 — no divergent copies)', () => {
  // Every former atomic-write site must import the shared leaf and carry NO
  // local `writeFileSync(tmp) + renameSync` re-implementation.
  const CALLERS = [
    'runtime/adapters/claude-code/persistent/build-settings.ts',
    'runtime/adapters/claude-code/persistent/repl-registry.ts',
    'runtime/adapters/claude-code/persistent/pending-respawns-queue.ts',
    'scribe/scribe-budget.ts',
    'tasks/projection/write.ts',
  ]

  for (const rel of CALLERS) {
    test(`${rel} routes through runtime/atomic-write.ts`, () => {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8')
      expect(src).toContain('atomic-write.ts')
      // No re-introduced local helper named like the old divergent copies.
      expect(src).not.toMatch(/function\s+writeAtomic(Sync|Async)\b/)
      expect(src).not.toMatch(/function\s+nextSettingsTmpPath\b/)
    })
  }

  test('the old per-adapter atomic-write copy is gone', () => {
    expect(
      nodefs.existsSync(
        join(REPO_ROOT, 'runtime/adapters/claude-code/persistent/atomic-write.ts'),
      ),
    ).toBe(false)
  })
})
