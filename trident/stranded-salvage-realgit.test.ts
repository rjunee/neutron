/**
 * REAL-git falsification tests for the terminal-failure salvage. A failing inner workflow never
 * returns an InnerResult here: the outer step must discover committed work from the branch ref,
 * publish it, and still persist the run honestly as failed and unreviewed.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import { spawnCapture, type HostCommandResult } from './git-mode.ts'
import type { RunHostCommand } from './merge.ts'
import { buildTridentOrchestrator, TRIDENT_SALVAGE_MARKER } from './orchestrator.ts'
import { TridentRunStore, type TridentRun } from './store.ts'
import { TridentTickLoop } from './tick.ts'

const BRANCH = 'trident/salvage-card'
const FAILURE = 'inner workflow fire failed: fire turn raised an error before settling'
const NOW = '2026-08-17T00:00:00.000Z'
const GIT_ID = ['-c', 'user.name=Trident Test', '-c', 'user.email=trident-test@neutron.local', '-c', 'commit.gpgsign=false']
const created: string[] = []

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

async function git(repo: string, ...args: string[]): Promise<void> {
  const res = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
}

async function gitOut(repo: string, ...args: string[]): Promise<string> {
  const res = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  return res.stdout.trim()
}

interface World {
  root: string
  origin: string
  checkout: string
  branchHead: string | null
}

async function seedWorld(kind: 'ahead' | 'missing' | 'not-ahead'): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'trident-stranded-salvage-'))
  created.push(root)
  const origin = join(root, 'origin.git')
  const checkout = join(root, 'checkout')

  const bare = await spawnCapture(['git', 'init', '--bare', '-q', '--initial-branch=main', origin], root)
  if (!bare.ok) throw new Error(`bare init failed: ${bare.stderr}`)
  const init = await spawnCapture(['git', 'init', '-q', '--initial-branch=main', checkout], root)
  if (!init.ok) throw new Error(`checkout init failed: ${init.stderr}`)
  await git(checkout, 'config', 'user.name', 'Trident Test')
  await git(checkout, 'config', 'user.email', 'trident-test@neutron.local')
  await git(checkout, 'config', 'commit.gpgsign', 'false')
  await git(checkout, 'remote', 'add', 'origin', `file://${origin}`)
  writeFileSync(join(checkout, 'README.md'), 'base\n')
  await git(checkout, 'add', 'README.md')
  await git(checkout, ...GIT_ID, 'commit', '-q', '-m', 'base')
  await git(checkout, 'push', '-q', 'origin', 'main')

  if (kind === 'missing') return { root, origin, checkout, branchHead: null }

  await git(checkout, 'branch', BRANCH, 'main')
  if (kind === 'not-ahead') {
    return { root, origin, checkout, branchHead: await gitOut(checkout, 'rev-parse', BRANCH) }
  }

  const worktree = join(root, 'builder')
  await git(checkout, 'worktree', 'add', '-q', worktree, BRANCH)
  writeFileSync(join(worktree, 'work.txt'), 'finished work\n')
  await git(worktree, 'add', 'work.txt')
  await git(worktree, ...GIT_ID, 'commit', '-q', '-m', 'finished build')
  const branchHead = await gitOut(worktree, 'rev-parse', 'HEAD')
  await git(checkout, 'worktree', 'remove', '--force', worktree)
  return { root, origin, checkout, branchHead }
}

function makeRun(checkout: string, overrides: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'salvage-run',
    slug: 'salvage-card',
    project_slug: 'project',
    phase: 'forge-init',
    round: 0,
    max_rounds: 10,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: BRANCH,
    base_sha: null,
    base_behind: null,
    pr: null,
    merge_mode: 'pr',
    subagent_run_id: null,
    subagent_status: null,
    repo_path: checkout,
    worktree: null,
    task: 'salvage card',
    chat_id: null,
    thread_id: null,
    channel_kind: 'telegram',
    failure_reason: null,
    workflow_run_id: null,
    inner_checkpoint: null,
    inner_checkpoint_head: null,
    inner_checkpoint_findings: null,
    inner_verdict: null,
    inner_result: null,
    started_at: NOW,
    last_advanced_at: NOW,
    harvested_at: null,
    crash_recoveries: 0,
    infra_retries: 0,
    reviewed_head: null,
    bound_pr: null,
    fenced_paths: null,
    // These three became required on TridentRun while this branch sat stranded:
    // brief_alert with #431, parent_run_id/wave_task_id with #439's wave children.
    // The fixture predates all of them, which is what the typecheck caught.
    brief_alert: null,
    parent_run_id: null,
    wave_task_id: null,
    ...overrides,
  }
}

function buildHybridHost(failPush = false): { run: RunHostCommand; calls: string[][] } {
  const calls: string[][] = []
  let opened = false
  const run: RunHostCommand = async (cmd, cwd) => {
    calls.push([...cmd])
    if (cmd[0] === 'git') {
      if (failPush && cmd.includes('push')) {
        return {
          ok: false,
          stdout: '',
          stderr: 'fatal: could not read Username for https://github.com',
          exit_code: 128,
        }
      }
      return spawnCapture(cmd, cwd)
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'list') return ok(opened ? '7\n' : '')
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'create') {
      opened = true
      return ok()
    }
    throw new Error(`unexpected host command: ${cmd.join(' ')}`)
  }
  return { run, calls }
}

function orchestrator(world: World, host: RunHostCommand) {
  return buildTridentOrchestrator({
    fire_workflow: async () => ({
      status: 'failed',
      error: 'fire turn raised an error before settling',
    }),
    db_path: join(world.root, 'unused.db'),
    base_branch: 'main',
    sleep: async () => {},
    now: () => NOW,
    run_host: host,
  })
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

describe('REAL git — stranded terminal-failure salvage', () => {
  test('a committed branch survives a fire failure: pushed, linked to a PR, and still failed', async () => {
    const world = await seedWorld('ahead')
    const harness = buildHybridHost()
    const run = makeRun(world.checkout)
    const db = ProjectDb.open(join(world.root, 'project.db'))
    // Workspace package aliases resolve the runner through the shared repo-of-record; pin the
    // migration tree to this isolated worktree so concurrent lanes cannot change this fixture.
    applyMigrations(db.raw(), join(import.meta.dir, '..', 'migrations'))
    const store = new TridentRunStore(db, () => NOW)

    try {
      await store.create({
        id: run.id,
        slug: run.slug,
        project_slug: run.project_slug,
        repo_path: run.repo_path,
        task: run.task,
        phase: run.phase,
        max_rounds: run.max_rounds,
        ralph: run.ralph,
        max_ralph_rounds: run.max_ralph_rounds,
        merge_mode: run.merge_mode,
        branch: null,
        channel_kind: run.channel_kind,
      })
      await store.update(run.id, { branch: run.branch, round: run.round })

      const orch = orchestrator(world, harness.run)
      const loop = new TridentTickLoop({ store, step: orch.step })
      await loop.runOnce()

      const row = store.get(run.id)
      expect(row).not.toBeNull()
      if (row === null) return
      expect(row.phase).toBe('failed')
      expect(row.pr).toBe(7)
      expect(row.failure_reason).toStartWith(FAILURE)
      expect(row.failure_reason).toContain(TRIDENT_SALVAGE_MARKER)
      expect(row.failure_reason).toContain('#7')
      expect(row.failure_reason!.indexOf(TRIDENT_SALVAGE_MARKER)).toBeGreaterThan(
        row.failure_reason!.indexOf(FAILURE),
      )
      expect(row.inner_verdict).toBeNull()
      expect(row.harvested_at).toBeNull()

      const remote = await spawnCapture(
        ['git', '-C', world.checkout, 'ls-remote', '--heads', 'origin', `refs/heads/${BRANCH}`],
        world.checkout,
      )
      expect(remote.ok).toBe(true)
      if (world.branchHead === null) throw new Error('ahead fixture did not create a branch head')
      expect(remote.stdout.trim().split(/\s+/)[0]).toBe(world.branchHead)
      expect(harness.calls.some((cmd) => cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'create')).toBe(true)
    } finally {
      db.close()
    }
  }, 60_000)

  test('a slug-derived branch that does not exist leaves the terminal failure untouched', async () => {
    const world = await seedWorld('missing')
    const harness = buildHybridHost()
    const out = await orchestrator(world, harness.run).step(makeRun(world.checkout, { branch: null }))

    expect(out.run.phase).toBe('failed')
    expect(out.run.failure_reason).toBe(FAILURE)
    expect(out.run.pr).toBeNull()
    expect(
      harness.calls.some((cmd) => cmd.includes(`refs/heads/${BRANCH}`) && cmd.includes('rev-parse')),
    ).toBe(true)
    // A fresh launch already performs a read-only existing-PR probe. Silence here means the
    // salvage adds no publishing mutation: no create and no push.
    expect(harness.calls.some((cmd) => cmd[0] === 'gh' && cmd[2] === 'create')).toBe(false)
    expect(harness.calls.some((cmd) => cmd[0] === 'git' && cmd.includes('push'))).toBe(false)
  })

  test('a branch at base with zero commits ahead is silently ignored', async () => {
    const world = await seedWorld('not-ahead')
    const harness = buildHybridHost()
    const out = await orchestrator(world, harness.run).step(makeRun(world.checkout))

    expect(out.run.phase).toBe('failed')
    expect(out.run.failure_reason).toBe(FAILURE)
    expect(out.run.pr).toBeNull()
    expect(harness.calls.some((cmd) => cmd[0] === 'gh' && cmd[2] === 'create')).toBe(false)
    expect(harness.calls.some((cmd) => cmd[0] === 'git' && cmd.includes('push'))).toBe(false)
  })

  test('a failed rescue leaves the failure row byte-identical and the origin untouched', async () => {
    const world = await seedWorld('ahead')
    const harness = buildHybridHost(true)
    const run = makeRun(world.checkout)
    const out = await orchestrator(world, harness.run).step(run)

    expect(out.run).toEqual({
      ...run,
      phase: 'failed',
      subagent_status: 'failed',
      subagent_run_id: null,
      failure_reason: FAILURE,
      last_advanced_at: NOW,
    })
    expect(out.note).toContain('stranded build salvage failed')
    expect(out.run.failure_reason).not.toContain(TRIDENT_SALVAGE_MARKER)
    expect(harness.calls.filter((cmd) => cmd[0] === 'git' && cmd.includes('push'))).toHaveLength(3)
    expect(harness.calls.some((cmd) => cmd[0] === 'gh' && cmd[2] === 'create')).toBe(false)

    const remote = await spawnCapture(
      ['git', '-C', world.checkout, 'ls-remote', '--heads', 'origin', `refs/heads/${BRANCH}`],
      world.checkout,
    )
    expect(remote.ok).toBe(true)
    expect(remote.stdout.trim()).toBe('')
  }, 60_000)
})
