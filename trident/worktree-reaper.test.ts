import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { spawnCapture } from './git-mode.ts'
import type { TridentRun } from './store.ts'
import {
  buildWorktreeReaperLoop,
  DEFAULT_REAP_INTERVAL_MS,
  DEFAULT_WORKTREE_RETENTION_MS,
  sweepTridentWorktrees,
  type WorktreeReaperStore,
} from './worktree-reaper.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnCapture(['git', '-C', cwd, ...args], cwd)
  expect(result.ok, `git ${args.join(' ')}\n${result.stderr || result.stdout}`).toBe(true)
  return result.stdout.trim()
}

async function makeRepo(): Promise<{ root: string; repo: string }> {
  const root = mkdtempSync(join(tmpdir(), 'trident-worktree-reaper-'))
  roots.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  await git(repo, 'init', '-b', 'main')
  await git(repo, 'config', 'user.email', 'trident@example.test')
  await git(repo, 'config', 'user.name', 'Trident Test')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  await git(repo, 'add', 'README.md')
  await git(repo, 'commit', '-m', 'base')
  return { root, repo }
}

async function addWorktree(
  repo: string,
  name: string,
  branch?: string,
): Promise<string> {
  const worktree = join(repo, '.claude', 'worktrees', name)
  mkdirSync(dirname(worktree), { recursive: true })
  if (branch === undefined) await git(repo, 'worktree', 'add', '--detach', worktree)
  else await git(repo, 'worktree', 'add', '-b', branch, worktree)
  return worktree
}

function makeProc(root: string): string {
  const proc = join(root, 'proc')
  mkdirSync(proc)
  return proc
}

function addProcCwd(proc: string, pid: number, cwd: string): void {
  const pidDir = join(proc, String(pid))
  mkdirSync(pidDir)
  symlinkSync(cwd, join(pidDir, 'cwd'), 'dir')
}

function backdate(worktree: string, now: number): void {
  const old = new Date(now - DEFAULT_WORKTREE_RETENTION_MS - 60_000)
  utimesSync(worktree, old, old)
  utimesSync(join(worktree, '.git'), old, old)
}

type NonTerminalRun = Pick<
  TridentRun,
  'worktree' | 'branch' | 'repo_path' | 'workflow_run_id'
>

function stubStore(repo: string, runs: NonTerminalRun[] = []): WorktreeReaperStore {
  return {
    listRepoPaths: () => [repo],
    listNonTerminal: () => runs,
  }
}

async function listedWorktrees(repo: string): Promise<string[]> {
  return (await git(repo, 'worktree', 'list', '--porcelain'))
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}

describe('sweepTridentWorktrees — real git', () => {
  test('frees a dead holder so the branch is switchable again', async () => {
    const { root, repo } = await makeRepo()
    const holder = await addWorktree(repo, 'wf_dead-1', 'trident/x')
    const second = await addWorktree(repo, 'wf_second-2')
    const proc = makeProc(root)
    const unrelated = join(root, 'unrelated')
    mkdirSync(unrelated)
    addProcCwd(proc, 101, unrelated)

    const report = await sweepTridentWorktrees({
      store: stubStore(repo),
      run_host: spawnCapture,
      proc_root: proc,
    })

    expect(report.detached).toContain(holder)
    expect(await git(holder, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(existsSync(holder)).toBe(true)
    await git(second, 'switch', 'trident/x')
    expect(await git(second, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trident/x')
    expect(await git(repo, 'show-ref', '--verify', 'refs/heads/trident/x')).not.toBe('')
  }, 30_000)

  test('a live worktree is completely untouched', async () => {
    const { root, repo } = await makeRepo()
    const worktree = await addWorktree(repo, 'wf_live-1', 'trident/x')
    const nested = join(worktree, 'nested')
    mkdirSync(nested)
    const now = Date.now()
    backdate(worktree, now)
    const proc = makeProc(root)
    addProcCwd(proc, 201, worktree)
    addProcCwd(proc, 202, nested)

    const report = await sweepTridentWorktrees({
      store: stubStore(repo),
      run_host: spawnCapture,
      proc_root: proc,
      now: () => now,
    })

    expect(report.live_skipped).toBeGreaterThanOrEqual(1)
    expect(report.detached).toEqual([])
    expect(report.removed).toEqual([])
    expect(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trident/x')
    expect(await listedWorktrees(repo)).toContain(worktree)
  }, 30_000)

  test('the shared main checkout is never detached or removed', async () => {
    const { root, repo } = await makeRepo()
    await git(repo, 'switch', '-c', 'trident/y')
    const candidate = await addWorktree(repo, 'wf_old-1')
    const now = Date.now()
    backdate(repo, now)
    backdate(candidate, now)

    const report = await sweepTridentWorktrees({
      store: stubStore(repo),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      now: () => now,
    })

    expect(await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trident/y')
    expect((await listedWorktrees(repo))[0]).toBe(repo)
    expect(report.detached).not.toContain(repo)
    expect(report.removed).not.toContain(repo)
    expect(existsSync(repo)).toBe(true)
  }, 30_000)

  test("a non-terminal run's worktree survives even process-free and old", async () => {
    const { root, repo } = await makeRepo()
    const exact = await addWorktree(repo, 'wf_active-1', 'trident/z')
    const branchOnly = await addWorktree(repo, 'wf_branch-2', 'trident/branch-only')
    const now = Date.now()
    backdate(exact, now)
    backdate(branchOnly, now)
    const runs: NonTerminalRun[] = [
      { worktree: exact, branch: 'trident/z', repo_path: repo, workflow_run_id: null },
      {
        worktree: null,
        branch: 'trident/branch-only',
        repo_path: repo,
        workflow_run_id: null,
      },
    ]

    const report = await sweepTridentWorktrees({
      store: stubStore(repo, runs),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      now: () => now,
    })

    expect(report.detached).toEqual(expect.arrayContaining([exact, branchOnly]))
    expect(report.protected_nonterminal).toEqual(expect.arrayContaining([exact, branchOnly]))
    expect(await git(exact, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(await git(branchOnly, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(await listedWorktrees(repo)).toEqual(expect.arrayContaining([exact, branchOnly]))
    expect(existsSync(exact)).toBe(true)
    expect(existsSync(branchOnly)).toBe(true)
  }, 30_000)

  test('retention removes only old, clean, unclaimed trees', async () => {
    const { root, repo } = await makeRepo()
    const old = await addWorktree(repo, 'wf_old-1')
    const young = await addWorktree(repo, 'wf_new-1')
    const dirty = await addWorktree(repo, 'wf_dirty-1')
    writeFileSync(join(dirty, 'untracked.txt'), 'rescue me\n')
    const now = Date.now()
    backdate(old, now)
    backdate(dirty, now)

    const report = await sweepTridentWorktrees({
      store: stubStore(repo),
      run_host: spawnCapture,
      proc_root: makeProc(root),
      now: () => now,
    })

    expect(report.removed).toContain(old)
    expect(existsSync(old)).toBe(false)
    expect(await listedWorktrees(repo)).not.toContain(old)
    expect(existsSync(young)).toBe(true)
    expect(await listedWorktrees(repo)).toContain(young)
    expect(existsSync(dirty)).toBe(true)
    expect(readFileSync(join(dirty, 'untracked.txt'), 'utf8')).toBe('rescue me\n')
    expect(report.preserved.some((entry) => entry.path === dirty)).toBe(true)
  }, 30_000)

  test('no /proc means no action', async () => {
    const { root, repo } = await makeRepo()
    const worktree = await addWorktree(repo, 'wf_unverified-1', 'trident/unverified')
    const now = Date.now()
    backdate(worktree, now)
    let storeCalls = 0
    const store: WorktreeReaperStore = {
      listRepoPaths: () => {
        storeCalls += 1
        return [repo]
      },
      listNonTerminal: () => [],
    }

    const report = await sweepTridentWorktrees({
      store,
      run_host: spawnCapture,
      proc_root: join(root, 'missing-proc'),
      now: () => now,
    })

    expect(report.skipped_no_liveness).toBe(true)
    expect(report.detached).toEqual([])
    expect(report.removed).toEqual([])
    expect(report.preserved).toEqual([])
    expect(report.protected_nonterminal).toEqual([])
    expect(storeCalls).toBe(0)
    expect(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'trident/unverified',
    )
    expect(existsSync(worktree)).toBe(true)
  }, 30_000)
})

test('the reaper can never force, delete a branch, or kill', () => {
  const source = readFileSync(new URL('./worktree-reaper.ts', import.meta.url), 'utf8')
  expect(source).not.toContain('--force')
  expect(source).not.toContain("'-D'")
  expect(source).not.toContain('--delete')
  expect(source).not.toContain("'kill'")
})

test('buildWorktreeReaperLoop is immediate and uses the default descriptor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trident-worktree-reaper-loop-'))
  roots.push(root)
  const proc = makeProc(root)
  let repoCalls = 0
  let timerMs = 0
  let cleared = false
  const options = {
    store: {
      listRepoPaths: () => {
        repoCalls += 1
        return []
      },
      listNonTerminal: () => [],
    },
    run_host: spawnCapture,
    proc_root: proc,
    setTimer: (_fn: () => void, ms: number) => {
      timerMs = ms
      return 17
    },
    clearTimer: (handle: unknown) => {
      expect(handle).toBe(17)
      cleared = true
    },
  }
  const loop = buildWorktreeReaperLoop(options)

  expect(loop.describe().name).toBe('trident-worktree-reaper')
  expect(loop.describe().cadenceMs).toBe(DEFAULT_REAP_INTERVAL_MS)
  loop.start()
  const deadline = Date.now() + 1_000
  while (repoCalls === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(repoCalls).toBe(1)
  expect(timerMs).toBe(DEFAULT_REAP_INTERVAL_MS)
  await loop.stop()
  expect(cleared).toBe(true)
})

test('workflow generation claims a matching worktree basename', async () => {
  const { root, repo } = await makeRepo()
  const generation = '37d8c538'
  const worktree = await addWorktree(repo, `wf_${generation}-2`)
  const now = Date.now()
  backdate(worktree, now)

  const report = await sweepTridentWorktrees({
    store: stubStore(repo, [
      { worktree: null, branch: null, repo_path: '/elsewhere', workflow_run_id: generation },
    ]),
    run_host: spawnCapture,
    proc_root: makeProc(root),
    now: () => now,
  })

  expect(report.protected_nonterminal).toContain(worktree)
  expect(existsSync(worktree)).toBe(true)
  expect(basename(worktree)).toContain(generation)
}, 30_000)
