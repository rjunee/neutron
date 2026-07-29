/**
 * Refactor X4 (item 2 — `[BEHAVIOR]` security fix). Before X4 the Code-Gen
 * Core did a BARE `join()` on the tool-supplied `project_id` in BOTH its
 * sidecar resolver AND its git-worktree resolver, so a crafted
 * `..`/NUL/absolute-escape value could create a sidecar DB or a git worktree
 * outside `<owner_home>/Projects/`. Both now route through the universal
 * `safeResolveProjectRoot` guard. These tests prove the guard reached both
 * surfaces.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CorePathTraversalError } from '@neutronai/cores-runtime'

import type { HostGhRunner, HostGitRunner } from '../src/host-runners.ts'
import { CodegenSidecarResolver, type CodegenSidecar } from '../src/sidecar/store.ts'
import { resolveWorktree } from '../src/worktree-resolver.ts'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'codegen-traversal-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('CodegenSidecarResolver — path-traversal guard (X4 [BEHAVIOR])', () => {
  test('rejects ../, bare .., NUL, absolute-escape', async () => {
    const r = new CodegenSidecarResolver({ owner_home: tmp })
    await expect(r.resolve('../../../etc/passwd')).rejects.toThrow(
      CorePathTraversalError,
    )
    await expect(r.resolve('..')).rejects.toThrow(CorePathTraversalError)
    await expect(r.resolve('proj\0evil')).rejects.toThrow(CorePathTraversalError)
    const escape = new CodegenSidecarResolver({
      owner_home: tmp,
      resolveProjectRoot: () => '/etc',
    })
    await expect(escape.resolve('x')).rejects.toThrow(CorePathTraversalError)
    expect(existsSync(join(tmp, 'Projects', '..', 'code-gen'))).toBe(false)
    r.closeAll()
    escape.closeAll()
  })

  test('pathFor() enforces the guard; legit ids resolve identically', () => {
    const r = new CodegenSidecarResolver({ owner_home: tmp })
    expect(() => r.pathFor('../../../etc')).toThrow(CorePathTraversalError)
    expect(r.pathFor('proj-a')).toBe(
      join(tmp, 'Projects', 'proj-a', 'code-gen', 'code-gen.db'),
    )
    r.closeAll()
  })
})

describe('resolveWorktree — path-traversal guard (X4 [BEHAVIOR])', () => {
  // The guard throws BEFORE any git/gh/sidecar op runs, so these stubs are
  // never dereferenced.
  const stubGit = {} as unknown as HostGitRunner
  const stubGh = {} as unknown as HostGhRunner
  const stubSidecar = {} as unknown as CodegenSidecar

  test('rejects ../, bare .., NUL before touching the filesystem or git', async () => {
    for (const evil of ['../../../etc/passwd', '..', 'proj\0evil']) {
      await expect(
        resolveWorktree({
          owner_home: tmp,
          project_id: evil,
          gh_runner: stubGh,
          git_runner: stubGit,
          sidecar: stubSidecar,
        }),
      ).rejects.toThrow(CorePathTraversalError)
    }
    expect(existsSync(join(tmp, 'Projects', '..', 'code'))).toBe(false)
  })

  test('rejects an absolute-path escape supplied via a resolveProjectRoot override', async () => {
    await expect(
      resolveWorktree({
        owner_home: tmp,
        project_id: 'x',
        gh_runner: stubGh,
        git_runner: stubGit,
        sidecar: stubSidecar,
        resolveProjectRoot: () => '/etc',
      }),
    ).rejects.toThrow(CorePathTraversalError)
  })

  test('rejects a symlink at the FINAL worktree dir (below a real project root), no git op', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'codegen-worktree-outside-'))
    try {
      // `proj-a` is real but `proj-a/code` symlinks outside — the root guard
      // passes; the final-dir check must reject before git touches it.
      mkdirSync(join(tmp, 'Projects', 'proj-a'), { recursive: true })
      symlinkSync(outside, join(tmp, 'Projects', 'proj-a', 'code'), 'dir')
      await expect(
        resolveWorktree({
          owner_home: tmp,
          project_id: 'proj-a',
          gh_runner: stubGh,
          git_runner: stubGit,
          sidecar: stubSidecar,
        }),
      ).rejects.toThrow(CorePathTraversalError)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
