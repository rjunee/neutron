import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from './store.ts'
import { dispatchBoardBoundBuild, type TridentBoardBinder } from './board-dispatch.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-board-dispatch-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const board: TridentBoardBinder = {
  get: () => ({
    id: 'ready',
    title: 'wire the CSV export button to the new endpoint with tests',
    design_doc_ref: null,
  }),
  attachRun: async () => {},
}

function makeRepo(withOrigin: boolean): string {
  const dir = join(tmp, withOrigin ? 'repo-with-origin' : 'repo-local')
  mkdirSync(dir)
  expect(Bun.spawnSync(['git', 'init'], { cwd: dir }).exitCode).toBe(0)
  if (withOrigin) {
    expect(
      Bun.spawnSync(['git', '-C', dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git']).exitCode,
    ).toBe(0)
  }
  return dir
}

function installGhShim(): string {
  const shimDir = join(tmp, 'shim')
  mkdirSync(shimDir)
  const ghPath = join(shimDir, 'gh')
  writeFileSync(ghPath, `#!/bin/sh\nprintf '%s' "\${GH_TOKEN:-ABSENT}" > "${join(tmp, 'gh-observed')}"\nexit 0\n`)
  chmodSync(ghPath, 0o755)
  return shimDir
}

function dispatch(repoDir: string, secretsStore: { get: () => Promise<string | null> }, resolveMergeMode?: () => Promise<'local'>) {
  return dispatchBoardBoundBuild(
    { task: 'build the thing', board_item_id: 'ready' },
    {
      store,
      board,
      project_slug: 'proj-1',
      repo_path: tmp,
      owner_handle: 'owner',
      secretsStore,
      resolveBuildRepo: async () => repoDir,
      resolveRalph: async () => false,
      ...(resolveMergeMode === undefined ? {} : { resolveMergeMode }),
    },
  )
}

describe('dispatchBoardBoundBuild credentialed merge-mode probe', () => {
  test("unauthenticated repository without an origin resolves to 'local'", async () => {
    let getCalls = 0
    const result = await dispatch(makeRepo(false), { get: async () => (getCalls++, null) })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.merge_mode).toBe('local')
    expect(getCalls).toBeGreaterThanOrEqual(1)
  })

  test("authenticated GitHub repository resolves to 'pr' and passes GH_TOKEN to gh", async () => {
    const repo = makeRepo(true)
    const shimDir = installGhShim()
    const oldPath = process.env['PATH']
    process.env['PATH'] = `${shimDir}:${oldPath ?? ''}`
    try {
      const result = await dispatch(repo, { get: async () => 'test-sentinel-token-abc' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.merge_mode).toBe('pr')
      expect(readFileSync(join(tmp, 'gh-observed'), 'utf8')).toBe('test-sentinel-token-abc')
    } finally {
      process.env['PATH'] = oldPath
    }
  })

  test('resolves the credential once per host command', async () => {
    const repo = makeRepo(true)
    const shimDir = installGhShim()
    let getCalls = 0
    const oldPath = process.env['PATH']
    process.env['PATH'] = `${shimDir}:${oldPath ?? ''}`
    try {
      const result = await dispatch(repo, { get: async () => (getCalls++, 'test-sentinel-token-abc') })
      expect(result.ok).toBe(true)
      expect(getCalls).toBe(2)
    } finally {
      process.env['PATH'] = oldPath
    }
  })

  test('an injected resolveMergeMode takes precedence without reading the store', async () => {
    let getCalls = 0
    const result = await dispatch(
      makeRepo(false),
      { get: async () => (getCalls++, 'test-sentinel-token-abc') },
      async () => 'local' as const,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.merge_mode).toBe('local')
    expect(getCalls).toBe(0)
  })

  test('a secrets-store failure degrades and does not brick local dispatch', async () => {
    const result = await dispatch(makeRepo(false), {
      get: async () => {
        throw new Error('secrets store unavailable')
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.merge_mode).toBe('local')
  })
})
