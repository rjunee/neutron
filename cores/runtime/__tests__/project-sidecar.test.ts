/**
 * Refactor X4 (item 2) — the UNIVERSAL path-traversal guard + shared
 * `ProjectSidecarResolver`. This is the canonical guard test: it proves the
 * hoisted `safeResolveProjectRoot` rejects every escape vector and accepts
 * every legitimate `project_id`, and that the generic resolver's
 * cache/dedup/mkdir/close mechanics are preserved.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CorePathTraversalError,
  ProjectSidecarResolver,
  safeResolveProjectRoot,
  type ProjectSidecarInit,
} from '../index.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'project-sidecar-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('safeResolveProjectRoot — traversal guard', () => {
  test('rejects ../-style traversal', () => {
    expect(() =>
      safeResolveProjectRoot({ owner_home: tmp, project_id: '../../../etc/passwd' }),
    ).toThrow(CorePathTraversalError)
  })

  test('rejects nested traversal that climbs out via repeated parents', () => {
    expect(() =>
      safeResolveProjectRoot({ owner_home: tmp, project_id: 'proj-1/../../../../tmp/pwn' }),
    ).toThrow(CorePathTraversalError)
  })

  test('rejects bare ".." and "." (escape / Projects-dir-itself)', () => {
    expect(() =>
      safeResolveProjectRoot({ owner_home: tmp, project_id: '..' }),
    ).toThrow(CorePathTraversalError)
    expect(() =>
      safeResolveProjectRoot({ owner_home: tmp, project_id: '.' }),
    ).toThrow(CorePathTraversalError)
  })

  test('rejects empty project_id', () => {
    expect(() =>
      safeResolveProjectRoot({ owner_home: tmp, project_id: '' }),
    ).toThrow(CorePathTraversalError)
  })

  test('rejects project_id containing a NUL byte', () => {
    expect(() =>
      safeResolveProjectRoot({ owner_home: tmp, project_id: 'proj\0evil' }),
    ).toThrow(CorePathTraversalError)
  })

  test('default error carries the stable name + code contract', () => {
    let caught: unknown
    try {
      safeResolveProjectRoot({ owner_home: tmp, project_id: '..' })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(CorePathTraversalError)
    const err = caught as CorePathTraversalError
    expect(err.name).toBe('CorePathTraversalError')
    expect(err.code).toBe('core_path_traversal')
    expect(err.project_id).toBe('..')
  })

  test('a Core-supplied makeError subclass is thrown instead (contract-preserving)', () => {
    class CustomTraversalError extends CorePathTraversalError {
      constructor(pid: string, rp: string, opd: string) {
        super(pid, rp, opd, 'CustomTraversalError', 'custom_code')
      }
    }
    let caught: unknown
    try {
      safeResolveProjectRoot({
        owner_home: tmp,
        project_id: '..',
        makeError: (pid, rp, opd) => new CustomTraversalError(pid, rp, opd),
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(CustomTraversalError)
    expect(caught).toBeInstanceOf(CorePathTraversalError) // still the base
    expect((caught as CustomTraversalError).name).toBe('CustomTraversalError')
    expect((caught as CustomTraversalError).code).toBe('custom_code')
  })

  test('rejects an absolute-path escape supplied via a resolveProjectRoot override', () => {
    // A `resolveProjectRoot` override that mishandles the id and returns an
    // absolute path OUTSIDE the boundary is still caught — the guard checks
    // the RESOLVED path, so an override cannot defeat it.
    expect(() =>
      safeResolveProjectRoot({
        owner_home: tmp,
        project_id: 'anything',
        resolveProjectRoot: () => '/etc',
      }),
    ).toThrow(CorePathTraversalError)
  })

  test('rejects a sibling prefix-collision dir (Projects-evil)', () => {
    expect(() =>
      safeResolveProjectRoot({
        owner_home: tmp,
        project_id: 'x',
        resolveProjectRoot: () => join(tmp, 'Projects-evil', 'x'),
      }),
    ).toThrow(CorePathTraversalError)
  })

  test('accepts a legit slug', () => {
    const resolved = safeResolveProjectRoot({ owner_home: tmp, project_id: 'proj-a' })
    expect(resolved).toBe(join(tmp, 'Projects', 'proj-a'))
  })

  test('accepts a legit uuid', () => {
    const uuid = '5f2c9e8a-2b1d-4c3e-9a7f-0b1c2d3e4f50'
    const resolved = safeResolveProjectRoot({ owner_home: tmp, project_id: uuid })
    expect(resolved).toBe(join(tmp, 'Projects', uuid))
  })

  test('accepts a legit nested subpath under Projects/', () => {
    const resolved = safeResolveProjectRoot({
      owner_home: tmp,
      project_id: 'nested/group/proj-7',
    })
    expect(resolved).toBe(join(tmp, 'Projects', 'nested', 'group', 'proj-7'))
  })

  test('rejects a bare absolute project_id outright (never valid input)', () => {
    expect(() =>
      safeResolveProjectRoot({ owner_home: tmp, project_id: '/etc/passwd' }),
    ).toThrow(CorePathTraversalError)
  })
})

describe('ProjectSidecarResolver — mechanics + guard', () => {
  interface FakeHandle {
    project_id: string
    db_path: string
    closed: boolean
  }
  function makeResolver(): {
    resolver: ProjectSidecarResolver<FakeHandle>
    state: { builds: number }
  } {
    const state = { builds: 0 }
    const resolver = new ProjectSidecarResolver<FakeHandle>({
      owner_home: tmp,
      sidecar_dir: 'fake',
      db_filename: 'fake.db',
      buildHandle: async (init: ProjectSidecarInit) => {
        state.builds += 1
        return { project_id: init.project_id, db_path: init.db_path, closed: false }
      },
      closeHandle: (h) => {
        h.closed = true
      },
    })
    return { resolver, state }
  }

  test('resolve() guards the project_id before any FS op', async () => {
    const { resolver } = makeResolver()
    await expect(resolver.resolve('../../../etc')).rejects.toThrow(
      CorePathTraversalError,
    )
    // No sidecar dir created for the evil id.
    expect(existsSync(join(tmp, 'Projects', '..', 'fake'))).toBe(false)
  })

  test('pathFor() + dirFor() also enforce the guard', () => {
    const { resolver } = makeResolver()
    expect(() => resolver.pathFor('../../../etc/passwd')).toThrow(
      CorePathTraversalError,
    )
    expect(() => resolver.dirFor('../../../etc/passwd')).toThrow(
      CorePathTraversalError,
    )
  })

  test('resolve() creates the sidecar dir, caches the handle, and dedups concurrent first-resolves', async () => {
    const { resolver, state } = makeResolver()
    const [a, b] = await Promise.all([
      resolver.resolve('proj-a'),
      resolver.resolve('proj-a'),
    ])
    expect(a).toBe(b) // same cached handle
    expect(state.builds).toBe(1) // built exactly once
    expect(existsSync(join(tmp, 'Projects', 'proj-a', 'fake'))).toBe(true)
    // Distinct project → distinct handle.
    const c = await resolver.resolve('proj-b')
    expect(c).not.toBe(a)
    expect(state.builds).toBe(2)
  })

  test('pathFor / dirFor compose the sidecar_dir + db_filename', () => {
    const { resolver } = makeResolver()
    expect(resolver.pathFor('proj-a')).toBe(
      join(tmp, 'Projects', 'proj-a', 'fake', 'fake.db'),
    )
    expect(resolver.dirFor('proj-a')).toBe(join(tmp, 'Projects', 'proj-a', 'fake'))
  })

  test('closeAll() closes every cached handle and clears the cache', async () => {
    const { resolver } = makeResolver()
    const a = await resolver.resolve('proj-a')
    await resolver.resolve('proj-b')
    resolver.closeAll()
    expect(a.closed).toBe(true)
  })

  test('rejects a SYMLINK escape (lexically-valid project dir that links outside the boundary), no outside write', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'sidecar-outside-'))
    try {
      // `Projects/proj-a` is lexically inside the boundary but is a symlink
      // pointing OUTSIDE it — the lexical check passes, the realpath check
      // must reject.
      mkdirSync(join(tmp, 'Projects'), { recursive: true })
      symlinkSync(outside, join(tmp, 'Projects', 'proj-a'), 'dir')

      expect(() =>
        safeResolveProjectRoot({ owner_home: tmp, project_id: 'proj-a' }),
      ).toThrow(CorePathTraversalError)

      const { resolver, state } = makeResolver()
      await expect(resolver.resolve('proj-a')).rejects.toThrow(
        CorePathTraversalError,
      )
      // Nothing was built and nothing was written under the escape target.
      expect(state.builds).toBe(0)
      expect(existsSync(join(outside, 'fake'))).toBe(false)
      resolver.closeAll()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('ACCEPTS a relocated (symlinked) Projects boundary — legit self-host config, valid slug resolves', async () => {
    // A self-hoster keeps projects on an external volume and points
    // `<owner_home>/Projects` at it via a symlink. The boundary dir is
    // OPERATOR-controlled, not attacker-controlled — this is a trusted
    // relocation, NOT an escape. A valid slug must resolve (regression from
    // X4 #320, which mis-rejected this with a misleading CorePathTraversalError).
    const relocated = mkdtempSync(join(tmpdir(), 'relocated-projects-'))
    try {
      symlinkSync(relocated, join(tmp, 'Projects'), 'dir')

      // Guard does not throw for a valid slug through the relocated boundary.
      const resolved = safeResolveProjectRoot({ owner_home: tmp, project_id: 'proj-a' })
      expect(resolved).toBe(join(tmp, 'Projects', 'proj-a'))

      // And the resolver builds + writes the sidecar (through the symlink).
      const { resolver, state } = makeResolver()
      const handle = await resolver.resolve('proj-a')
      expect(handle.project_id).toBe('proj-a')
      expect(state.builds).toBe(1)
      // The real sidecar dir landed under the RELOCATED target.
      expect(existsSync(join(relocated, 'proj-a', 'fake'))).toBe(true)
      resolver.closeAll()
    } finally {
      rmSync(relocated, { recursive: true, force: true })
    }
  })

  test('accepts a nested valid subpath through a relocated (symlinked) Projects boundary', () => {
    const relocated = mkdtempSync(join(tmpdir(), 'relocated-nested-'))
    try {
      symlinkSync(relocated, join(tmp, 'Projects'), 'dir')
      const resolved = safeResolveProjectRoot({
        owner_home: tmp,
        project_id: 'nested/group/proj-7',
      })
      expect(resolved).toBe(join(tmp, 'Projects', 'nested', 'group', 'proj-7'))
    } finally {
      rmSync(relocated, { recursive: true, force: true })
    }
  })

  test('STILL rejects a symlink escape placed INSIDE a relocated Projects boundary, no outside write', async () => {
    // Even when Projects is a legitimately-relocated symlink, a symlink at
    // `Projects/<slug>` (i.e. inside the real boundary) pointing FURTHER out
    // must still be rejected — its realpath leaves the real boundary.
    const relocated = mkdtempSync(join(tmpdir(), 'relocated-escape-'))
    const outside = mkdtempSync(join(tmpdir(), 'relocated-escape-target-'))
    try {
      symlinkSync(relocated, join(tmp, 'Projects'), 'dir')
      // `Projects/proj-a` (which lands in `relocated/proj-a`) is itself a
      // symlink to an unrelated outside dir → genuine escape.
      symlinkSync(outside, join(relocated, 'proj-a'), 'dir')

      expect(() =>
        safeResolveProjectRoot({ owner_home: tmp, project_id: 'proj-a' }),
      ).toThrow(CorePathTraversalError)

      const { resolver, state } = makeResolver()
      await expect(resolver.resolve('proj-a')).rejects.toThrow(
        CorePathTraversalError,
      )
      expect(state.builds).toBe(0)
      expect(existsSync(join(outside, 'fake'))).toBe(false)
      resolver.closeAll()
    } finally {
      rmSync(relocated, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('rejects a symlink at the FINAL sidecar dir (below a real project root), no outside DB', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'sidecar-deep-outside-'))
    try {
      // Project root is a REAL dir, but `<root>/fake` (the sidecar dir) is a
      // symlink pointing outside. The root-level guard passes; the FINAL-dir
      // check must reject before the DB is opened.
      mkdirSync(join(tmp, 'Projects', 'proj-a'), { recursive: true })
      symlinkSync(outside, join(tmp, 'Projects', 'proj-a', 'fake'), 'dir')

      const { resolver, state } = makeResolver()
      await expect(resolver.resolve('proj-a')).rejects.toThrow(
        CorePathTraversalError,
      )
      expect(state.builds).toBe(0)
      // buildHandle never ran, so no `fake.db` was opened under the target.
      expect(existsSync(join(outside, 'fake.db'))).toBe(false)
      resolver.closeAll()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
