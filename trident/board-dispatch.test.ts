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
import type { BranchHolderProbe } from './fire-evidence-probes.ts'

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

describe('branch liveness refusal (branch_live)', () => {
  const TASK = 'build the thing'
  const BRANCH = 'trident/build-the-thing' // pinned by the 'creates the expected card branch' test above

  function makeCommittedRepo(name: string): string {
    const dir = join(tmp, name)
    mkdirSync(dir)
    expect(Bun.spawnSync(['git', 'init'], { cwd: dir }).exitCode).toBe(0)
    expect(
      Bun.spawnSync([
        'git',
        '-C',
        dir,
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit',
        '--allow-empty',
        '-m',
        'init',
      ]).exitCode,
    ).toBe(0)
    return dir
  }

  function addLockedWorktree(repoDir: string, wtName: string, reason: string | null): string {
    const wt = join(tmp, wtName)
    expect(Bun.spawnSync(['git', '-C', repoDir, 'worktree', 'add', wt, '-b', BRANCH]).exitCode).toBe(0)
    if (reason !== null) {
      expect(Bun.spawnSync(['git', '-C', repoDir, 'worktree', 'lock', wt, '--reason', reason]).exitCode).toBe(0)
    }
    return wt
  }

  function livenessDeps(repoDir: string, over: Partial<BoardBoundBuildDeps> = {}): BoardBoundBuildDeps {
    return {
      store,
      board,
      project_slug: 'proj-1',
      repo_path: tmp,
      resolveBuildRepo: async () => repoDir,
      resolveMergeMode: async () => 'local',
      resolveRalph: async () => false,
      ...over,
    }
  }

  test('a live worktree lock on the card branch REFUSES dispatch via the REAL default probe, creating no run', async () => {
    const repoDir = makeCommittedRepo('repo-live')
    // No `start` in the reason → signal-0 alone decides, and this process is alive.
    addLockedWorktree(repoDir, 'wt-live-holder', `claude agent test (pid ${process.pid})`)
    let attachCalls = 0
    const recordingBoard: TridentBoardBinder = {
      ...board,
      attachRun: async () => {
        attachCalls += 1
      },
    }

    const result = await dispatchBoardBoundBuild(
      { task: TASK, board_item_id: 'ready' },
      livenessDeps(repoDir, { board: recordingBoard }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('branch_live')
    expect(result.message).toContain('wt-live-holder')
    expect(result.message).toContain(String(process.pid))
    expect(result.message).toContain(BRANCH)
    expect(result.message).toContain('never delete the branch')
    expect(result.message).toContain('Nothing was dispatched')
    expect(store.listNonTerminalByRepo(repoDir)).toEqual([])
    expect(attachCalls).toBe(0)
  })

  test('a NON-terminal run row on the same repo+branch refuses a second dispatch of the same slug (combined control for the launched hold)', async () => {
    const repoDir = makeCommittedRepo('repo-row')
    const live = await store.create({
      slug: 'build-the-thing',
      project_slug: 'proj-1',
      repo_path: repoDir,
      task: TASK,
      merge_mode: 'local',
      ralph: false,
      branch: BRANCH,
    })

    const result = await dispatchBoardBoundBuild({ task: TASK, board_item_id: 'ready' }, livenessDeps(repoDir))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('branch_live')
    expect(result.message).toContain(live.id.slice(0, 8))
    expect(result.message).toContain(BRANCH)
    expect(store.listNonTerminalByRepo(repoDir)).toHaveLength(1)
  })

  // ARGUS r4 (minor): the refusal said "Nothing was dispatched … Re-dispatch only
  // once nothing live holds the branch" while the SAME block upserted a hold row
  // and the sweep re-asks automatically — the sentence contradicted the
  // behaviour — and it returned no `hold` field, unlike the two other refusals
  // that queue. Both halves are pinned here.
  test('the branch_live refusal SAYS it is queued and carries the hold, for a worktree-only holder', async () => {
    const repoDir = makeCommittedRepo('repo-queued-wt')
    addLockedWorktree(repoDir, 'wt-queued', `claude agent test (pid ${process.pid})`)

    const result = await dispatchBoardBoundBuild({ task: TASK, board_item_id: 'ready' }, livenessDeps(repoDir))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('branch_live')
    expect(result.message).toContain('QUEUED')
    // The old sentence told the operator to re-dispatch by hand. The sweep does it.
    expect(result.message).not.toContain('Re-dispatch only once')
    expect('hold' in result).toBe(true)
    if (!('hold' in result)) return
    expect(result.hold).toEqual({ kind: 'branch', branch: BRANCH })
  })

  test('the branch_live hold names the holding RUN when there is one', async () => {
    const repoDir = makeCommittedRepo('repo-queued-row')
    const live = await store.create({
      slug: 'build-the-thing',
      project_slug: 'proj-1',
      repo_path: repoDir,
      task: TASK,
      merge_mode: 'local',
      ralph: false,
      branch: BRANCH,
    })

    const result = await dispatchBoardBoundBuild({ task: TASK, board_item_id: 'ready' }, livenessDeps(repoDir))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('branch_live')
    expect('hold' in result).toBe(true)
    if (!('hold' in result)) return
    expect(result.hold).toEqual({ kind: 'branch', branch: BRANCH, holding_run_id: live.id })
    expect(result.message).toContain('QUEUED')
  })

  test('an injected probe reporting a live pid refuses (seam shape)', async () => {
    const repoDir = makeCommittedRepo('repo-stub')

    const result = await dispatchBoardBoundBuild(
      { task: TASK, board_item_id: 'ready' },
      livenessDeps(repoDir, {
        branchHolderProbe: async (): Promise<BranchHolderProbe> => ({
          worktree_basename: 'wt-x',
          lock_reason: 'claude agent wf (pid 4242 start 1)',
          pid: 4242,
          pid_live: true,
          mtime_ms: null,
        }),
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('branch_live')
    expect(result.message).toContain('wt-x')
    expect(result.message).toContain('4242')
  })

  test('a recycled-pid lock (live pid, starttime mismatch) does NOT refuse — and neither does the fresh mtime', async () => {
    const repoDir = makeCommittedRepo('repo-recycled')
    // pid alive but the RECORDED starttime cannot match the real one, so the
    // holder is gone. The worktree was cut milliseconds ago, so this also pins
    // that dispatch consults no mtime freshness.
    addLockedWorktree(repoDir, 'wt-recycled', `claude agent test (pid ${process.pid} start 1)`)

    const result = await dispatchBoardBoundBuild({ task: TASK, board_item_id: 'ready' }, livenessDeps(repoDir))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.branch).toBe(BRANCH)
  })

  test('an unparseable lock reason does NOT refuse', async () => {
    const repoDir = makeCommittedRepo('repo-manual')
    addLockedWorktree(repoDir, 'wt-manual', 'manual hold, do not prune')

    const result = await dispatchBoardBoundBuild({ task: TASK, board_item_id: 'ready' }, livenessDeps(repoDir))

    expect(result.ok).toBe(true)
  })

  test('no worktree and no live row proceeds exactly as before', async () => {
    const repoDir = makeCommittedRepo('repo-plain')

    const result = await dispatchBoardBoundBuild({ task: TASK, board_item_id: 'ready' }, livenessDeps(repoDir))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.branch).toBe(BRANCH)
  })

  test('a TERMINAL run row on the same branch does not refuse', async () => {
    const repoDir = makeCommittedRepo('repo-terminal')
    await store.create({
      slug: 'build-the-thing',
      project_slug: 'proj-1',
      repo_path: repoDir,
      task: TASK,
      merge_mode: 'local',
      ralph: false,
      branch: BRANCH,
      phase: 'failed',
    })

    const result = await dispatchBoardBoundBuild({ task: TASK, board_item_id: 'ready' }, livenessDeps(repoDir))

    expect(result.ok).toBe(true)
  })

  test('a throwing probe never blocks dispatch', async () => {
    const repoDir = makeCommittedRepo('repo-throws')

    const result = await dispatchBoardBoundBuild(
      { task: TASK, board_item_id: 'ready' },
      livenessDeps(repoDir, {
        branchHolderProbe: async () => {
          throw new Error('boom')
        },
      }),
    )

    expect(result.ok).toBe(true)
  })

  // MINOR (round 2): the liveness gate used to run BEFORE the merged-PR gate, so
  // a card whose work had already shipped — but whose branch still had a live
  // worktree lock or a non-terminal run row — was told "a lane is building this
  // branch right now" instead of "already merged as #N, verify the card". Both
  // refuse and neither dispatches, so the whole cost is the diagnosis; the
  // merged-PR sentence is the one the 2026-08-17 incidents were about.
  test('a MERGED PR wins over branch liveness — the clearer refusal is the one the operator reads', async () => {
    const repoDir = makeCommittedRepo('repo-landed-and-live')
    // Both conditions true at once: a merged PR AND a live lock on the branch.
    addLockedWorktree(repoDir, 'wt-landed-live', `claude agent test (pid ${process.pid})`)

    const result = await dispatchBoardBoundBuild(
      { task: TASK, board_item_id: 'ready' },
      livenessDeps(repoDir, {
        resolveMergeMode: async () => 'pr',
        landedProbe: async () => ({
          pr: 336,
          merged_at: '2026-08-16T23:27:00Z',
          head_on_base: true,
          base: 'main',
        }),
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('already_landed')
    expect(result.message).toContain('already merged as #336')
    // Still nothing dispatched — the reorder changes the words, not the outcome.
    expect(store.listNonTerminalByRepo(repoDir)).toEqual([])
  })

  test('branch liveness still refuses when the PR did NOT merge', async () => {
    const repoDir = makeCommittedRepo('repo-live-not-landed')
    addLockedWorktree(repoDir, 'wt-live-not-landed', `claude agent test (pid ${process.pid})`)

    const result = await dispatchBoardBoundBuild(
      { task: TASK, board_item_id: 'ready' },
      livenessDeps(repoDir, {
        resolveMergeMode: async () => 'pr',
        landedProbe: async () => null,
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('branch_live')
    expect(result.message).toContain('wt-live-not-landed')
  })
})
