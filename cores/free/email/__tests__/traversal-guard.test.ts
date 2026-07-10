/**
 * Refactor X4 (item 2 — `[BEHAVIOR]` security fix). Before X4 the
 * Email-Managed Core did a BARE `join()` on the tool-supplied `project_id`,
 * so a crafted `..`/NUL/absolute-escape value could read/write
 * `email-cache.db` outside `<owner_home>/Projects/`. It now routes through
 * the universal `safeResolveProjectRoot` guard (via the shared
 * `ProjectSidecarResolver`). These tests prove the guard reached this Core:
 * malicious ids are rejected BEFORE any FS op; legit ids still resolve
 * identically.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CorePathTraversalError } from '@neutronai/cores-runtime'

import { EmailProjectCacheResolver } from '../src/cache.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'email-traversal-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('EmailProjectCacheResolver — path-traversal guard (X4 [BEHAVIOR])', () => {
  test('rejects ../-style traversal before creating any sidecar', async () => {
    const r = new EmailProjectCacheResolver({ owner_home: home })
    await expect(r.resolve('../../../etc/passwd')).rejects.toThrow(
      CorePathTraversalError,
    )
    expect(existsSync(join(home, 'Projects', '..', 'email'))).toBe(false)
    r.closeAll()
  })

  test('rejects bare ".." and "."', async () => {
    const r = new EmailProjectCacheResolver({ owner_home: home })
    await expect(r.resolve('..')).rejects.toThrow(CorePathTraversalError)
    await expect(r.resolve('.')).rejects.toThrow(CorePathTraversalError)
    r.closeAll()
  })

  test('rejects a NUL-byte project_id', async () => {
    const r = new EmailProjectCacheResolver({ owner_home: home })
    await expect(r.resolve('proj\0evil')).rejects.toThrow(CorePathTraversalError)
    r.closeAll()
  })

  test('rejects an absolute-path escape via a resolveProjectRoot override', async () => {
    const r = new EmailProjectCacheResolver({
      owner_home: home,
      resolveProjectRoot: () => '/etc',
    })
    await expect(r.resolve('anything')).rejects.toThrow(CorePathTraversalError)
    r.closeAll()
  })

  test('pathFor() enforces the guard too', () => {
    const r = new EmailProjectCacheResolver({ owner_home: home })
    expect(() => r.pathFor('../../../etc/passwd')).toThrow(CorePathTraversalError)
    r.closeAll()
  })

  test('rejects a symlink at the FINAL email dir (below a real project root), no outside DB', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'email-deep-outside-'))
    try {
      // `proj-a` is a real dir but `proj-a/email` symlinks outside.
      mkdirSync(join(home, 'Projects', 'proj-a'), { recursive: true })
      symlinkSync(outside, join(home, 'Projects', 'proj-a', 'email'), 'dir')
      const r = new EmailProjectCacheResolver({ owner_home: home })
      await expect(r.resolve('proj-a')).rejects.toThrow(CorePathTraversalError)
      expect(existsSync(join(outside, 'email-cache.db'))).toBe(false)
      r.closeAll()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('accepts legit slugs + uuids (resolve identically, dir created)', async () => {
    const r = new EmailProjectCacheResolver({ owner_home: home })
    for (const id of ['alpha', 'proj-a', '5f2c9e8a-2b1d-4c3e-9a7f-0b1c2d3e4f50']) {
      expect(r.pathFor(id)).toBe(join(home, 'Projects', id, 'email', 'email-cache.db'))
      await r.resolve(id)
      expect(existsSync(join(home, 'Projects', id, 'email'))).toBe(true)
    }
    r.closeAll()
  })
})
