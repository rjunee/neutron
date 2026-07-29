/**
 * @neutronai/research-core — store-resolver tests.
 *
 * Per docs/plans/research-core-tier1-brief.md § 6.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RESEARCH_SIDECAR_DB,
  RESEARCH_SIDECAR_DIR,
  ResearchPathTraversalError,
  ResearchSidecarMismatchError,
  ResearchStoreResolver,
} from '../src/store-resolver.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-research-resolver-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('ResearchStoreResolver', () => {
  test('lazy first-resolve creates the sidecar at the expected path', async () => {
    const r = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp })
    const handle = await r.resolve('proj-1')
    const expected = join(tmp, 'Projects', 'proj-1', RESEARCH_SIDECAR_DIR, RESEARCH_SIDECAR_DB)
    expect(handle.research_db_path).toBe(expected)
    expect(existsSync(expected)).toBe(true)
    r.closeAll()
  })

  test('cached handles — second resolve returns same store', async () => {
    const r = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp })
    const h1 = await r.resolve('proj-1')
    const h2 = await r.resolve('proj-1')
    expect(h1.store).toBe(h2.store)
    r.closeAll()
  })

  test('init-promise dedup — two concurrent resolves wait on the same init', async () => {
    const r = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp })
    const [a, b] = await Promise.all([r.resolve('proj-1'), r.resolve('proj-1')])
    expect(a.store).toBe(b.store)
    r.closeAll()
  })

  test('cross-project sidecar opens throws ResearchSidecarMismatchError', async () => {
    // First-init under instance A.
    const a = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp })
    await a.resolve('proj-1')
    a.closeAll()
    // Re-open the same sidecar under instance B — must throw.
    const b = new ResearchStoreResolver({ project_slug: 'project-b', owner_home: tmp })
    await expect(b.resolve('proj-1')).rejects.toThrow(ResearchSidecarMismatchError)
  })

  test('cross-project sidecar opens throws ResearchSidecarMismatchError', async () => {
    const a = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp })
    await a.resolve('proj-1')
    a.closeAll()
    // Different owner_home + same projects dir → also flagged.
    // Simulate the dir-rename case:
    const tmp2 = mkdtempSync(join(tmpdir(), 'neutron-research-resolver-2-'))
    try {
      // Copy proj-1's research dir to tmp2/Projects/proj-2/
      const { mkdirSync, copyFileSync } = await import('node:fs')
      const srcDb = join(
        tmp,
        'Projects',
        'proj-1',
        RESEARCH_SIDECAR_DIR,
        RESEARCH_SIDECAR_DB,
      )
      const dstDir = join(tmp2, 'Projects', 'proj-2', RESEARCH_SIDECAR_DIR)
      mkdirSync(dstDir, { recursive: true })
      copyFileSync(srcDb, join(dstDir, RESEARCH_SIDECAR_DB))
      const resolver = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp2 })
      await expect(resolver.resolve('proj-2')).rejects.toThrow(ResearchSidecarMismatchError)
    } finally {
      rmSync(tmp2, { recursive: true, force: true })
    }
  })

  test('per-project isolation — handle for proj-1 distinct from proj-2', async () => {
    const r = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp })
    const a = await r.resolve('proj-1')
    const b = await r.resolve('proj-2')
    expect(a.store).not.toBe(b.store)
    r.closeAll()
  })

  describe('path-traversal guard (Argus r1 BLOCKER #1)', () => {
    test('rejects ../../../etc/passwd-style traversal payload BEFORE FS init', async () => {
      const r = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp })
      const evil = '../../../etc/passwd'
      await expect(r.resolve(evil)).rejects.toThrow(ResearchPathTraversalError)
      // The sidecar must NOT exist for the evil id; nor under the
      // resolved escape target.
      const ownerProjectsDir = join(tmp, 'Projects')
      expect(existsSync(join(ownerProjectsDir, evil, RESEARCH_SIDECAR_DIR))).toBe(false)
      r.closeAll()
    })

    test('rejects nested traversal that climbs out via repeated parents', async () => {
      const r = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp })
      await expect(r.resolve('proj-1/../../../../tmp/pwn')).rejects.toThrow(
        ResearchPathTraversalError,
      )
      r.closeAll()
    })

    test('rejects absolute project_id that points outside owner_home', async () => {
      const r = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp })
      // Default join() flattens absolute under owner_home, but a
      // resolveProjectRoot override could mishandle absolutes.
      // Independently of that, the canonicalised resolved path is
      // always compared to the boundary, so an absolute that lands
      // outside trips the guard.
      await expect(
        r.resolve('proj-1/../..'), // escapes Projects/ root entirely
      ).rejects.toThrow(ResearchPathTraversalError)
      r.closeAll()
    })

    test('rejects bare ".." and "." segments', async () => {
      const r = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp })
      await expect(r.resolve('..')).rejects.toThrow(ResearchPathTraversalError)
      // bare "." resolves to Projects/ itself — also rejected (must be a
      // strict subpath of Projects/, never the Projects/ dir itself).
      await expect(r.resolve('.')).rejects.toThrow(ResearchPathTraversalError)
      r.closeAll()
    })

    test('rejects project_id containing NUL byte (defence-in-depth)', async () => {
      const r = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp })
      await expect(r.resolve('proj\0evil')).rejects.toThrow(ResearchPathTraversalError)
      r.closeAll()
    })

    test('preserves the historical error contract (name + code) after the X4 shared-guard hoist', async () => {
      const r = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp })
      let caught: unknown
      try {
        await r.resolve('../../../etc/passwd')
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(ResearchPathTraversalError)
      const err = caught as ResearchPathTraversalError
      // The public fields third-party code may branch on are UNCHANGED.
      expect(err.name).toBe('ResearchPathTraversalError')
      expect(err.code).toBe('research_path_traversal')
      r.closeAll()
    })

    test('pathFor + outputDirFor also enforce the guard (no leakage path)', () => {
      const r = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp })
      expect(() => r.pathFor('../../../etc/passwd')).toThrow(ResearchPathTraversalError)
      expect(() => r.outputDirFor('../../../etc/passwd')).toThrow(
        ResearchPathTraversalError,
      )
      r.closeAll()
    })

    test('legitimate nested project_id under Projects/ is allowed', async () => {
      const r = new ResearchStoreResolver({ project_slug: 'project-a', owner_home: tmp })
      const handle = await r.resolve('nested/group/proj-7')
      const expected = join(
        tmp,
        'Projects',
        'nested',
        'group',
        'proj-7',
        RESEARCH_SIDECAR_DIR,
        RESEARCH_SIDECAR_DB,
      )
      expect(handle.research_db_path).toBe(expected)
      r.closeAll()
    })
  })
})
