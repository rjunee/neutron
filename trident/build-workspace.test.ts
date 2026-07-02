/**
 * Per-project build workspace resolver (`ensureProjectBuildWorkspace`) + its
 * wiring through the dispatch chokepoint.
 *
 * THE new-project bug: the run row's `repo_path` was the owner HOME dir (not a
 * git repo), so the inner workflow's `git worktree add` failed at forge-init
 * before Forge ran. These tests prove the chokepoint now resolves + git-inits
 * (WITH an initial commit) a per-project `Projects/<slug>/code` workspace, so a
 * brand-new project is buildable.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import { WorkBoardStore } from '../work-board/store.ts'
import { dispatchBoardBoundBuild } from './board-dispatch.ts'
import {
  ensureProjectBuildWorkspace,
  defaultBuildWorkspaceProbe,
  PROJECT_CODE_DIRNAME,
  type BuildWorkspaceProbe,
} from './build-workspace.ts'
import { spawnCapture, type HostCommandResult } from './git-mode.ts'
import { TridentRunStore } from './store.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neutron-build-ws-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

// ── Pure-probe unit tests (no real fs/git) ────────────────────────────────────

/** A recording stub probe over an in-memory set of "existing" paths. */
function stubProbe(
  existing: Set<string>,
  gitResults: (args: string[]) => HostCommandResult,
): { probe: BuildWorkspaceProbe; calls: string[][]; made: string[] } {
  const calls: string[][] = []
  const made: string[] = []
  return {
    calls,
    made,
    probe: {
      exists: (p) => existing.has(p),
      mkdirp: (p) => {
        made.push(p)
        existing.add(p)
      },
      git: async (args, _cwd) => {
        calls.push(args)
        return gitResults(args)
      },
    },
  }
}

const ok: HostCommandResult = { ok: true, stdout: '', stderr: '', exit_code: 0 }
const fail: HostCommandResult = { ok: false, stdout: '', stderr: 'boom', exit_code: 1 }

describe('ensureProjectBuildWorkspace (pure probe)', () => {
  test('fresh project → mkdir + git init + --allow-empty initial commit', async () => {
    const { probe, calls, made } = stubProbe(new Set(), () => ok)
    const res = await ensureProjectBuildWorkspace('/home', 'litewal', probe)

    const expected = join('/home', 'Projects', 'litewal', PROJECT_CODE_DIRNAME)
    expect(res.build_repo_path).toBe(expected)
    expect(res.created).toBe(true)
    expect(made).toContain(expected)
    // init then commit (with --allow-empty so a fileless new project still gets a HEAD).
    expect(calls[0]).toEqual(['init', '-q', '--initial-branch=main'])
    const commit = calls.find((c) => c.includes('commit'))!
    expect(commit).toContain('--allow-empty')
  })

  test('existing repo WITH a commit → idempotent no-op (never re-commits)', async () => {
    const workspace = join('/home', 'Projects', 'meditation', PROJECT_CODE_DIRNAME)
    const existing = new Set([workspace, join(workspace, '.git')])
    const { probe, calls } = stubProbe(existing, (args) =>
      args[0] === 'rev-parse' ? ok : fail,
    )
    const res = await ensureProjectBuildWorkspace('/home', 'meditation', probe)

    expect(res.created).toBe(false)
    // Only the HEAD probe ran — no init, no commit against a healthy workspace.
    expect(calls).toEqual([['rev-parse', '--verify', 'HEAD']])
  })

  test('repo dir exists but has NO commit → makes the initial commit (no re-init)', async () => {
    const workspace = join('/home', 'Projects', 'half', PROJECT_CODE_DIRNAME)
    const existing = new Set([workspace, join(workspace, '.git')])
    const { probe, calls } = stubProbe(existing, (args) =>
      args[0] === 'rev-parse' ? fail : ok,
    )
    const res = await ensureProjectBuildWorkspace('/home', 'half', probe)

    expect(res.created).toBe(true)
    expect(calls.some((c) => c[0] === 'init')).toBe(false) // never re-inits an existing .git
    expect(calls.some((c) => c.includes('commit') && c.includes('--allow-empty'))).toBe(true)
  })

  test('git init failure → throws (chokepoint maps to backend_error)', async () => {
    const { probe } = stubProbe(new Set(), (args) => (args[0] === 'init' ? fail : ok))
    await expect(ensureProjectBuildWorkspace('/home', 'x', probe)).rejects.toThrow(/git init failed/)
  })
})

// ── Real fs + git integration ─────────────────────────────────────────────────

async function git(cwd: string, ...args: string[]): Promise<HostCommandResult> {
  return spawnCapture(['git', '-C', cwd, ...args], cwd)
}

describe('ensureProjectBuildWorkspace (real git)', () => {
  test('creates a git repo with a commit that `git worktree add` can branch from', async () => {
    const res = await ensureProjectBuildWorkspace(home, 'dagrunner', defaultBuildWorkspaceProbe())
    const expected = join(home, 'Projects', 'dagrunner', 'code')
    expect(res.build_repo_path).toBe(expected)
    expect(res.created).toBe(true)
    expect(existsSync(join(expected, '.git'))).toBe(true)

    // A valid HEAD commit exists (the thing `git worktree add` requires).
    const head = await git(expected, 'rev-parse', '--verify', 'HEAD')
    expect(head.ok).toBe(true)
    const log = await git(expected, 'log', '--oneline')
    expect(log.stdout).toContain('initialize dagrunner build workspace')

    // The real proof: a worktree + build branch can be created off it.
    const wt = join(home, 'wt')
    const added = await git(expected, 'worktree', 'add', '-b', 'trident/x', wt)
    expect(added.ok).toBe(true)
    expect(existsSync(wt)).toBe(true)

    // No GitHub origin → a fresh local project has no remote (merge mode 'local').
    const origin = await git(expected, 'remote', 'get-url', 'origin')
    expect(origin.ok).toBe(false)
  })

  test('idempotent on a second call — same path, created=false, no new commit', async () => {
    const first = await ensureProjectBuildWorkspace(home, 'again', defaultBuildWorkspaceProbe())
    const countBefore = (await git(first.build_repo_path, 'rev-list', '--count', 'HEAD')).stdout
    const second = await ensureProjectBuildWorkspace(home, 'again', defaultBuildWorkspaceProbe())
    expect(second.build_repo_path).toBe(first.build_repo_path)
    expect(second.created).toBe(false)
    const countAfter = (await git(first.build_repo_path, 'rev-list', '--count', 'HEAD')).stdout
    expect(countAfter).toBe(countBefore) // no surprise re-commit
  })
})

// ── Dispatch chokepoint: a project with no workspace gets one, per-project ─────

describe('dispatchBoardBoundBuild resolves a per-project git workspace', () => {
  let db: ProjectDb
  let store: TridentRunStore
  let board: WorkBoardStore
  beforeEach(() => {
    db = ProjectDb.open(join(home, 'project.db'))
    applyMigrations(db.raw())
    store = new TridentRunStore(db)
    board = new WorkBoardStore(db)
  })
  afterEach(() => {
    db.close()
  })

  test('brand-new project → run.repo_path is Projects/<slug>/code, git-initialized WITH a commit', async () => {
    const item = await board.create('litewal', {
      title: 'wire the export button to the new CSV endpoint with tests',
    })
    const res = await dispatchBoardBoundBuild(
      { board_item_id: item.id, task: 'build the export' },
      {
        store,
        board,
        project_slug: 'litewal',
        // The owner HOME base — NO pre-existing code repo for this project.
        repo_path: home,
        // Use the REAL resolver (default) — the whole point of this test.
        resolveMergeMode: async () => 'local',
        resolveRalph: async () => false,
      },
    )
    expect(res.ok).toBe(true)
    const run = res.ok ? store.get(res.run.id)! : null
    const expectedWorkspace = join(home, 'Projects', 'litewal', 'code')

    // repo_path is the PER-PROJECT workspace, not the HOME base.
    expect(run!.repo_path).toBe(expectedWorkspace)
    expect(run!.repo_path).not.toBe(home)
    // …and it is a real git repo WITH a commit (so `git worktree add` will work).
    expect(existsSync(join(expectedWorkspace, '.git'))).toBe(true)
    expect((await git(expectedWorkspace, 'rev-parse', '--verify', 'HEAD')).ok).toBe(true)
  })

  test('two projects get DISTINCT workspaces (no shared repo / branch collision)', async () => {
    const a = await board.create('alpha', { title: 'wire the export button to the new CSV endpoint with tests' })
    const b = await board.create('beta', { title: 'wire the import button to the new CSV endpoint with tests' })
    const base = {
      store,
      board,
      repo_path: home,
      resolveMergeMode: async () => 'local' as const,
      resolveRalph: async () => false,
    }
    const ra = await dispatchBoardBoundBuild({ board_item_id: a.id, task: 'x' }, { ...base, project_slug: 'alpha' })
    const rb = await dispatchBoardBoundBuild({ board_item_id: b.id, task: 'y' }, { ...base, project_slug: 'beta' })
    expect(ra.ok && rb.ok).toBe(true)
    const pa = ra.ok ? store.get(ra.run.id)!.repo_path : ''
    const pb = rb.ok ? store.get(rb.run.id)!.repo_path : ''
    expect(pa).toBe(join(home, 'Projects', 'alpha', 'code'))
    expect(pb).toBe(join(home, 'Projects', 'beta', 'code'))
    expect(pa).not.toBe(pb)
  })
})
