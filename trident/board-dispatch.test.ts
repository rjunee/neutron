import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from './store.ts'
import {
  detectReviewIntent,
  dispatchBoardBoundBuild,
  makeDispatchLandedProbe,
  type BoardBoundBuildDeps,
  type TridentBoardBinder,
} from './board-dispatch.ts'
import type { EnvCapableHostRunner, HostCommandResult } from './git-mode.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-board-dispatch-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
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

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

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
  writeFileSync(
    ghPath,
    `#!/bin/sh\nprintf '%s' "\${GH_TOKEN:-ABSENT}" > "${join(tmp, 'gh-observed')}"\nprintf '%s\\n' "$*" >> "${join(tmp, 'gh-argv')}"\nexit 0\n`,
  )
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

function localDeps(boardOverride: TridentBoardBinder = board): BoardBoundBuildDeps {
  return {
    store,
    board: boardOverride,
    project_slug: 'proj-1',
    repo_path: tmp,
    resolveBuildRepo: async () => tmp,
    resolveMergeMode: async () => 'local',
    resolveRalph: async () => false,
  }
}

describe('review-only dispatch contract', () => {
  test('a review-shaped task with no bound_pr is REFUSED at dispatch, naming bound_pr', async () => {
    let createCalls = 0
    let attachCalls = 0
    const originalCreate = store.create.bind(store)
    store.create = async (input) => {
      createCalls += 1
      return originalCreate(input)
    }
    const recordingBoard: TridentBoardBinder = {
      ...board,
      attachRun: async () => {
        attachCalls += 1
      },
    }

    const result = await dispatchBoardBoundBuild(
      { task: 'run a review round on PR #515', board_item_id: 'ready' },
      localDeps(recordingBoard),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('review_needs_bound_pr')
    expect(result.message).toContain('bound_pr')
    expect(result.message).toContain('515')
    expect(createCalls).toBe(0)
    expect(attachCalls).toBe(0)
  })

  test.each([
    ['run a review round on PR #515', 515],
    ['review PR #524', 524],
    ['Re-review PR #515 after the fixes', 515],
    ['please do a review round of PR 542', 542],
    ['Perform a review pass on PR #7', 7],
  ] as const)('detectReviewIntent matches %s', (task, pr) => {
    expect(detectReviewIntent(task)).toBe(pr)
  })

  test.each([
    'fix the review-gate check so the same head always scans the same commits',
    'address the review feedback on PR #515 and fix the failing tests',
    'build the review-evidence poster for bound runs',
    'add tests for the orchestrator publish path',
  ])('detectReviewIntent does not match %s', (task) => {
    expect(detectReviewIntent(task)).toBeNull()
  })

  test('a review dispatch WITH bound_pr populates the column', async () => {
    const result = await dispatchBoardBoundBuild(
      { task: 'review PR #515', board_item_id: 'ready', bound_pr: 515 },
      localDeps(),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(store.get(result.run.id)!.bound_pr).toBe(515)
    const row = db
      .raw()
      .query('select count(*) as n from code_trident_runs where bound_pr is not null and bound_pr != 0')
      .get() as { n: number }
    expect(row.n).toBe(1)
  })

  test('malformed bound_pr is refused with zero state', async () => {
    let createCalls = 0
    let attachCalls = 0
    const originalCreate = store.create.bind(store)
    store.create = async (input) => {
      createCalls += 1
      return originalCreate(input)
    }
    const recordingBoard: TridentBoardBinder = {
      ...board,
      attachRun: async () => {
        attachCalls += 1
      },
    }

    for (const bound_pr of [0, -3, 1.5, Number.NaN]) {
      const result = await dispatchBoardBoundBuild(
        { task: 'review PR #515', board_item_id: 'ready', bound_pr },
        localDeps(recordingBoard),
      )
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.code).toBe('invalid_bound_pr')
    }

    expect(createCalls).toBe(0)
    expect(attachCalls).toBe(0)
    const row = db.raw().query('select count(*) as n from code_trident_runs').get() as { n: number }
    expect(row.n).toBe(0)
  })

  test('bound_pr skips the ask-gate; the gate is otherwise intact', async () => {
    const terseBoard: TridentBoardBinder = {
      get: () => ({ id: 'terse', title: 'auth', design_doc_ref: null }),
      attachRun: async () => {},
    }

    const bound = await dispatchBoardBoundBuild(
      { task: 'review PR #515', board_item_id: 'terse', bound_pr: 515 },
      localDeps(terseBoard),
    )
    expect(bound.ok).toBe(true)

    const build = await dispatchBoardBoundBuild(
      { task: 'build auth', board_item_id: 'terse' },
      localDeps(terseBoard),
    )
    expect(build.ok).toBe(false)
    if (build.ok) return
    expect(build.code).toBe('underspecified')
  })
})

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

  test('resolves credentials for merge-mode auth and the landed probe', async () => {
    const repo = makeRepo(true)
    const shimDir = installGhShim()
    let getCalls = 0
    const oldPath = process.env['PATH']
    process.env['PATH'] = `${shimDir}:${oldPath ?? ''}`
    try {
      const result = await dispatch(repo, { get: async () => (getCalls++, 'test-sentinel-token-abc') })
      expect(result.ok).toBe(true)
      expect(getCalls).toBe(3)
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

describe('dispatch refuses a card whose work already landed', () => {
  const mergedJson = JSON.stringify({
    number: 336,
    headRefOid: 'a'.repeat(40),
    mergedAt: '2026-08-16T23:27:00Z',
  })

  function fakeRunner(
    ghResult: HostCommandResult,
    ancestorResult: HostCommandResult = ok(),
  ): { calls: string[][]; run: EnvCapableHostRunner } {
    const calls: string[][] = []
    const run: EnvCapableHostRunner = async (command) => {
      calls.push(command)
      if (command[0] === 'gh') return ghResult
      if (command.includes('symbolic-ref')) return ok('origin/main\n')
      if (command.includes('fetch')) return ok()
      if (command.includes('--is-ancestor')) return ancestorResult
      return { ok: false, stdout: '', stderr: 'unexpected command', exit_code: 2 }
    }
    return { calls, run }
  }

  function dispatchWith(
    run: EnvCapableHostRunner,
    mergeMode: 'pr' | 'local' = 'pr',
  ): { attached: string[]; result: ReturnType<typeof dispatchBoardBoundBuild> } {
    const attached: string[] = []
    const recordingBoard: TridentBoardBinder = {
      get: board.get,
      attachRun: async (_slug, _id, run_id) => {
        attached.push(run_id)
      },
    }
    return {
      attached,
      result: dispatchBoardBoundBuild(
        { task: 'build the thing', board_item_id: 'ready' },
        {
          store,
          board: recordingBoard,
          project_slug: 'proj-1',
          repo_path: tmp,
          resolveBuildRepo: async () => tmp,
          resolveMergeMode: async () => mergeMode,
          resolveRalph: async () => false,
          landedProbe: makeDispatchLandedProbe(run),
        },
      ),
    }
  }

  test('a merged PR refuses before creating or attaching any state', async () => {
    const fake = fakeRunner(ok(mergedJson))
    const dispatched = dispatchWith(fake.run)
    const result = await dispatched.result

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('already_landed')
    expect(result.message).toContain('already merged as #336')
    expect(result.message).toContain('verify the card instead of rebuilding')
    const row = db.raw().query('SELECT COUNT(*) AS count FROM code_trident_runs').get() as {
      count: number
    }
    expect(row.count).toBe(0)
    expect(dispatched.attached).toEqual([])
  })

  test('no merged PR proceeds and creates the expected card branch', async () => {
    const fake = fakeRunner(ok(''))
    const result = await dispatchWith(fake.run).result

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.branch).toBe('trident/build-the-thing')
  })

  test('a probe that cannot answer degrades open', async () => {
    const fake = fakeRunner({
      ok: false,
      stdout: '',
      stderr: 'connect timeout',
      exit_code: 1,
    })
    const result = await dispatchWith(fake.run).result

    expect(result.ok).toBe(true)
  })

  test('local mode never invokes the GitHub probe', async () => {
    const fake = fakeRunner(ok(mergedJson))
    const result = await dispatchWith(fake.run, 'local').result

    expect(result.ok).toBe(true)
    expect(fake.calls.filter((command) => command[0] === 'gh')).toEqual([])
  })

  test('a squash-merged PR still refuses when its head is not on the base', async () => {
    const fake = fakeRunner(
      ok(mergedJson),
      { ok: false, stdout: '', stderr: '', exit_code: 1 },
    )
    const result = await dispatchWith(fake.run).result

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('already_landed')
    expect(result.message).toContain('already merged as #336')
    expect(result.message).not.toContain('contained in origin/')
  })

  test('the credentialed fallback probe runs when no probe is injected', async () => {
    const repo = makeRepo(false)
    const shimDir = installGhShim()
    const oldPath = process.env['PATH']
    process.env['PATH'] = `${shimDir}:${oldPath ?? ''}`
    try {
      const result = await dispatchBoardBoundBuild(
        { task: 'build the thing', board_item_id: 'ready' },
        {
          store,
          board,
          project_slug: 'proj-1',
          repo_path: tmp,
          resolveBuildRepo: async () => repo,
          resolveMergeMode: async () => 'pr',
          resolveRalph: async () => false,
          owner_handle: 'owner',
          secretsStore: { get: async () => 'test-sentinel-token-abc' },
        },
      )

      expect(result.ok).toBe(true)
      const argv = readFileSync(join(tmp, 'gh-argv'), 'utf8')
      expect(argv).toContain(
        'pr list --head trident/build-the-thing --state merged --json number,headRefOid,mergedAt',
      )
    } finally {
      process.env['PATH'] = oldPath
    }
  })
})
