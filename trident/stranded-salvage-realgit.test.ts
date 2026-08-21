/**
 * REAL-git falsification tests for the terminal-failure salvage. A failing inner workflow never
 * returns an InnerResult here: the outer step must discover committed work from the branch ref,
 * publish it, and still persist the run honestly as failed and unreviewed.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import { composeTerminalDelivery, interpretFailure } from './delivery.ts'
import { spawnCapture, type HostCommandResult } from './git-mode.ts'
import type { RunHostCommand } from './merge.ts'
import {
  buildTridentOrchestrator,
  TRIDENT_SALVAGE_MARKER,
  TRIDENT_SNAPSHOT_FAILURE_MARKER,
  TRIDENT_SNAPSHOT_MARKER,
  TRIDENT_STASH_PARKED_MARKER,
} from './orchestrator.ts'
import { TridentRunStore, type TridentRun } from './store.ts'
import { TridentTickLoop } from './tick.ts'

const BRANCH = 'trident/salvage-card'
const FAILURE = 'inner workflow fire failed: fire turn raised an error before settling'
const STARTED = '2020-01-01T00:00:00.000Z'
const NOW = '2099-01-01T00:00:00.000Z'
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

async function gitRaw(repo: string, ...args: string[]): Promise<string> {
  const res = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  return res.stdout
}

interface World {
  root: string
  origin: string
  checkout: string
  branchHead: string | null
  worktree: string | null
}

async function seedWorld(
  kind:
    | 'ahead'
    | 'missing'
    | 'not-ahead'
    | 'dirty'
    | 'staged-only'
    | 'untracked-only'
    | 'stashed'
    | 'ahead-dirty'
    | 'shared-dirty'
    | 'decoy-stash',
): Promise<World> {
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

  if (kind === 'missing') return { root, origin, checkout, branchHead: null, worktree: null }

  await git(checkout, 'branch', BRANCH, 'main')
  if (kind === 'shared-dirty') {
    await git(checkout, 'switch', BRANCH)
    writeFileSync(join(checkout, 'OPERATOR-PRIVATE.txt'), 'do not capture me\n')
    return {
      root,
      origin,
      checkout,
      branchHead: await gitOut(checkout, 'rev-parse', 'HEAD'),
      worktree: checkout,
    }
  }
  if (kind === 'decoy-stash') {
    await git(checkout, 'branch', 'other', 'main')
    const other = join(root, 'other-builder')
    await git(checkout, 'worktree', 'add', '-q', other, 'other')
    writeFileSync(join(other, 'README.md'), 'base\ndecoy\n')
    await git(other, 'stash', 'push', '-m', `WIP on ${BRANCH}: crafted decoy`)
    await git(checkout, 'worktree', 'remove', other)
    return {
      root,
      origin,
      checkout,
      branchHead: await gitOut(checkout, 'rev-parse', BRANCH),
      worktree: null,
    }
  }
  if (kind === 'not-ahead') {
    return {
      root,
      origin,
      checkout,
      branchHead: await gitOut(checkout, 'rev-parse', BRANCH),
      worktree: null,
    }
  }

  const worktree = join(root, 'builder')
  await git(checkout, 'worktree', 'add', '-q', worktree, BRANCH)
  if (kind === 'dirty') {
    writeFileSync(join(worktree, 'README.md'), 'base\nuncommitted work\n')
    writeFileSync(join(worktree, 'brand-new.txt'), 'untracked work\n')
    return {
      root,
      origin,
      checkout,
      branchHead: await gitOut(worktree, 'rev-parse', 'HEAD'),
      worktree,
    }
  }
  if (kind === 'staged-only') {
    writeFileSync(join(worktree, 'README.md'), 'base\nstaged work\n')
    await git(worktree, 'add', 'README.md')
    await git(worktree, 'restore', '--source=HEAD', '--worktree', 'README.md')
    return {
      root,
      origin,
      checkout,
      branchHead: await gitOut(worktree, 'rev-parse', 'HEAD'),
      worktree,
    }
  }
  if (kind === 'untracked-only') {
    await git(worktree, 'config', 'status.showUntrackedFiles', 'no')
    mkdirSync(join(worktree, 'new', 'nested'), { recursive: true })
    writeFileSync(join(worktree, 'new', 'plan.md'), 'new plan\n')
    writeFileSync(join(worktree, 'new', 'nested', 'feature.test.ts'), 'new test\n')
    return {
      root,
      origin,
      checkout,
      branchHead: await gitOut(worktree, 'rev-parse', 'HEAD'),
      worktree,
    }
  }
  if (kind === 'stashed') {
    writeFileSync(join(worktree, 'README.md'), 'base\nparked work\n')
    await git(worktree, 'stash', 'push', '-m', 'parked-for-comparison')
    return {
      root,
      origin,
      checkout,
      branchHead: await gitOut(worktree, 'rev-parse', 'HEAD'),
      worktree,
    }
  }

  writeFileSync(join(worktree, 'work.txt'), 'finished work\n')
  await git(worktree, 'add', 'work.txt')
  await git(worktree, ...GIT_ID, 'commit', '-q', '-m', 'finished build')
  const branchHead = await gitOut(worktree, 'rev-parse', 'HEAD')
  if (kind === 'ahead-dirty') {
    writeFileSync(join(worktree, 'README.md'), 'base\nuncommitted follow-up\n')
    return { root, origin, checkout, branchHead, worktree }
  }
  await git(checkout, 'worktree', 'remove', '--force', worktree)
  return { root, origin, checkout, branchHead, worktree: null }
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
    started_at: STARTED,
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
  const run: RunHostCommand = async (cmd, cwd, extraEnv) => {
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
      return spawnCapture(cmd, cwd, extraEnv)
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
      await store.update(run.id, { branch: run.branch, round: run.round, inner_checkpoint: 'forge-done' })

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

  test('uncommitted-only work is recorded without mutating the worktree or publishing', async () => {
    const world = await seedWorld('dirty')
    if (world.worktree === null) throw new Error('dirty fixture did not keep its worktree')
    const harness = buildHybridHost()
    const beforeStatus = await gitRaw(world.worktree, 'status', '--porcelain')
    const beforeHead = await gitRaw(world.worktree, 'rev-parse', 'HEAD')

    const out = await orchestrator(world, harness.run).step(makeRun(world.checkout))

    expect(out.run.phase).toBe('failed')
    expect(out.run.pr).toBeNull()
    expect(out.run.failure_reason).toStartWith(FAILURE)
    expect(out.run.failure_reason).toContain('0 commits;')
    expect(out.run.failure_reason).toContain(TRIDENT_SNAPSHOT_MARKER)
    expect(out.run.failure_reason).toContain('(1 untracked)')
    const snapshotRef = 'refs/tags/trident-salvage/salvage-run'
    expect(out.run.failure_reason).toContain(snapshotRef)
    expect(await gitOut(world.checkout, 'rev-parse', snapshotRef)).toMatch(/^[0-9a-f]{40}$/)
    expect(await gitOut(world.checkout, 'show', '--stat', '--oneline', snapshotRef)).toContain('README.md')
    expect(await gitOut(world.checkout, 'show', `${snapshotRef}:brand-new.txt`)).toBe(
      'untracked work',
    )
    expect(await gitRaw(world.worktree, 'status', '--porcelain')).toBe(beforeStatus)
    expect(await gitRaw(world.worktree, 'rev-parse', 'HEAD')).toBe(beforeHead)
    expect(harness.calls.some((cmd) => cmd[0] === 'git' && cmd.includes('push'))).toBe(false)
    expect(harness.calls.some((cmd) => cmd[0] === 'gh' && cmd[2] === 'create')).toBe(false)
    expect(interpretFailure(out.run).klass).toBe(
      interpretFailure(makeRun(world.checkout, { phase: 'failed', failure_reason: FAILURE })).klass,
    )
    expect(composeTerminalDelivery(out.run)?.text).toContain(snapshotRef)

    // The snapshot marker must not lock out later COMMIT publication. This is
    // the ordinary recovery path when the lane resumes long enough to commit
    // after the terminal observer first records its working tree.
    await git(world.worktree, 'add', '-A')
    await git(world.worktree, ...GIT_ID, 'commit', '-q', '-m', 'finish after snapshot')
    const later = await orchestrator(world, harness.run).reconcile_stranded(out.run)
    expect(later).not.toBeNull()
    expect(later?.pr).toBe(7)
    expect(later?.failure_reason).toContain(TRIDENT_SNAPSHOT_MARKER)
    expect(later?.failure_reason).toContain(TRIDENT_SALVAGE_MARKER)
  }, 60_000)

  test('index-only content is retained as the snapshot index parent', async () => {
    const world = await seedWorld('staged-only')
    if (world.worktree === null) throw new Error('staged fixture did not keep its worktree')
    const harness = buildHybridHost()
    const beforeStatus = await gitRaw(world.worktree, 'status', '--porcelain')
    const beforeHead = await gitRaw(world.worktree, 'rev-parse', 'HEAD')

    const out = await orchestrator(world, harness.run).step(makeRun(world.checkout))

    const snapshotRef = 'refs/tags/trident-salvage/salvage-run'
    expect(beforeStatus).toContain('MM README.md')
    expect(out.run.failure_reason).toContain('1 uncommitted text line(s) across 1 file(s)')
    expect(out.run.failure_reason).toContain(TRIDENT_SNAPSHOT_MARKER)
    expect(await gitOut(world.checkout, 'show', `${snapshotRef}:README.md`)).toBe('base')
    expect(await gitOut(world.checkout, 'show', `${snapshotRef}^2:README.md`)).toBe(
      'base\nstaged work',
    )
    expect(await gitRaw(world.worktree, 'status', '--porcelain')).toBe(beforeStatus)
    expect(await gitRaw(world.worktree, 'rev-parse', 'HEAD')).toBe(beforeHead)
  }, 60_000)

  test('untracked-only nested work is captured even when repository config hides it', async () => {
    const world = await seedWorld('untracked-only')
    if (world.worktree === null) throw new Error('untracked fixture did not keep its worktree')
    const harness = buildHybridHost()
    expect(await gitRaw(world.worktree, 'status', '--porcelain')).toBe('')
    const beforeHead = await gitRaw(world.worktree, 'rev-parse', 'HEAD')
    const out = await orchestrator(world, harness.run).step(makeRun(world.checkout))

    const snapshotRef = 'refs/tags/trident-salvage/salvage-run'
    expect(out.run.failure_reason).toContain('2 uncommitted text line(s) across 2 file(s)')
    expect(out.run.failure_reason).toContain('(2 untracked)')
    expect(await gitOut(world.checkout, 'show', `${snapshotRef}:new/plan.md`)).toBe('new plan')
    expect(await gitOut(world.checkout, 'show', `${snapshotRef}:new/nested/feature.test.ts`)).toBe(
      'new test',
    )
    expect(await gitRaw(world.worktree, 'status', '--porcelain')).toBe('')
    expect(await gitRaw(world.worktree, 'rev-parse', 'HEAD')).toBe(beforeHead)
  }, 60_000)

  test('tracked work survives when a live index lock makes stash-create fail', async () => {
    const world = await seedWorld('dirty')
    if (world.worktree === null) throw new Error('dirty fixture did not keep its worktree')
    const harness = buildHybridHost()
    const beforeStatus = await gitRaw(world.worktree, 'status', '--porcelain')
    const beforeHead = await gitRaw(world.worktree, 'rev-parse', 'HEAD')
    const liveIndexLock = await gitOut(world.worktree, 'rev-parse', '--git-path', 'index.lock')
    writeFileSync(liveIndexLock, 'owned by a live build\n')

    const out = await orchestrator(world, harness.run).step(makeRun(world.checkout))

    const snapshotRef = 'refs/tags/trident-salvage/salvage-run'
    expect(out.run.failure_reason).toContain(TRIDENT_SNAPSHOT_MARKER)
    expect(out.run.failure_reason).toContain('snapshot stash-create failed')
    expect(out.run.failure_reason).not.toContain(TRIDENT_SNAPSHOT_FAILURE_MARKER)
    expect(await gitOut(world.checkout, 'show', `${snapshotRef}:README.md`)).toBe(
      'base\nuncommitted work',
    )
    expect(await gitOut(world.checkout, 'show', `${snapshotRef}:brand-new.txt`)).toBe(
      'untracked work',
    )
    expect(await gitRaw(world.worktree, 'status', '--porcelain')).toBe(beforeStatus)
    expect(await gitRaw(world.worktree, 'rev-parse', 'HEAD')).toBe(beforeHead)
    expect(existsSync(liveIndexLock)).toBe(true)
    expect(composeTerminalDelivery(out.run)?.text).toContain(
      'Recovery warning: snapshot stash-create failed',
    )
    rmSync(liveIndexLock)
  }, 60_000)

  test(
    'branch-scoped stashed work is recorded without leaking its message or publishing',
    async () => {
      const world = await seedWorld('stashed')
      const harness = buildHybridHost()

      const out = await orchestrator(world, harness.run).step(makeRun(world.checkout))

      expect(out.run.phase).toBe('failed')
      expect(out.run.pr).toBeNull()
      expect(out.run.failure_reason).not.toBe(FAILURE)
      expect(out.run.failure_reason).toContain(TRIDENT_STASH_PARKED_MARKER)
      expect(out.run.failure_reason).not.toContain('parked-for-comparison')
      expect(harness.calls.some((cmd) => cmd.includes('stash') && cmd.includes('list'))).toBe(true)
      expect(harness.calls.some((cmd) => cmd.includes('reflog') && cmd.includes('refs/stash'))).toBe(
        true,
      )
      expect(harness.calls.some((cmd) => cmd[0] === 'git' && cmd.includes('push'))).toBe(false)
      expect(harness.calls.some((cmd) => cmd[0] === 'gh' && cmd[2] === 'create')).toBe(false)
      expect(interpretFailure(out.run).klass).toBe(
        interpretFailure(makeRun(world.checkout, { phase: 'failed', failure_reason: FAILURE })).klass,
      )
    },
    60_000,
  )

  test('a stale stash from an earlier run on the reused branch is ignored', async () => {
    const world = await seedWorld('stashed')
    const harness = buildHybridHost()
    const stashEpoch = Number(await gitOut(world.checkout, 'stash', 'list', '--format=%ct'))
    const runStartedAfterStash = new Date((stashEpoch + 1) * 1_000).toISOString()

    const out = await orchestrator(world, harness.run).step(
      makeRun(world.checkout, { started_at: runStartedAfterStash }),
    )

    expect(out.run.failure_reason).toBe(FAILURE)
    expect(out.run.failure_reason).not.toContain(TRIDENT_STASH_PARKED_MARKER)
  }, 60_000)

  test('a crafted message on another branch is not attributed to this run', async () => {
    const world = await seedWorld('decoy-stash')
    const harness = buildHybridHost()

    const out = await orchestrator(world, harness.run).step(makeRun(world.checkout))

    expect(out.run.failure_reason).toBe(FAILURE)
    expect(out.run.failure_reason).not.toContain(TRIDENT_STASH_PARKED_MARKER)
  }, 60_000)

  test('a deleted unpruned worktree does not prevent the stash leg', async () => {
    const world = await seedWorld('stashed')
    if (world.worktree === null) throw new Error('stashed fixture did not keep its worktree')
    rmSync(world.worktree, { recursive: true, force: true })
    const porcelain = await gitRaw(world.checkout, 'worktree', 'list', '--porcelain')
    expect(porcelain).toContain('prunable')
    const harness = buildHybridHost()

    const out = await orchestrator(world, harness.run).step(makeRun(world.checkout))

    expect(out.run.failure_reason).toContain(TRIDENT_STASH_PARKED_MARKER)
    expect(out.note).not.toContain('worktree capture threw')
    expect(harness.calls.some((cmd) => cmd.includes('stash') && cmd.includes('list'))).toBe(true)
  }, 60_000)

  test("the operator's shared checkout is never selected as a salvage worktree", async () => {
    const world = await seedWorld('shared-dirty')
    const harness = buildHybridHost()
    const before = await gitRaw(world.checkout, 'status', '--porcelain', '--untracked-files=all')

    const out = await orchestrator(world, harness.run).step(
      makeRun(world.checkout, { worktree: world.checkout }),
    )

    expect(out.run.failure_reason).toBe(FAILURE)
    expect(out.run.failure_reason).not.toContain(TRIDENT_SNAPSHOT_MARKER)
    expect(await gitRaw(world.checkout, 'status', '--porcelain', '--untracked-files=all')).toBe(
      before,
    )
    expect(
      await spawnCapture(
        ['git', '-C', world.checkout, 'rev-parse', '--verify', 'refs/tags/trident-salvage/salvage-run'],
        world.checkout,
      ),
    ).toMatchObject({ ok: false })
  }, 60_000)

  test("a newer dispatch's worktree is outside the failed run's ownership window", async () => {
    const world = await seedWorld('dirty')
    const harness = buildHybridHost()
    const staleRow = makeRun(world.checkout, {
      phase: 'failed',
      failure_reason: FAILURE,
      last_advanced_at: '2021-01-01T00:00:00.000Z',
    })

    const out = await orchestrator(world, harness.run).reconcile_stranded(staleRow)

    expect(out).toBeNull()
    expect(
      await spawnCapture(
        ['git', '-C', world.checkout, 'rev-parse', '--verify', 'refs/tags/trident-salvage/salvage-run'],
        world.checkout,
      ),
    ).toMatchObject({ ok: false })
  }, 60_000)

  test('a worktree created inside the one-second ownership slack is captured', async () => {
    const world = await seedWorld('dirty')
    if (world.worktree === null) throw new Error('dirty fixture did not keep its worktree')
    const createdAt = statSync(join(world.worktree, '.git')).mtimeMs
    const run = makeRun(world.checkout, {
      phase: 'failed',
      failure_reason: FAILURE,
      started_at: new Date(createdAt - 1_000).toISOString(),
      last_advanced_at: new Date(createdAt - 500).toISOString(),
    })
    const harness = buildHybridHost()

    const out = await orchestrator(world, harness.run).reconcile_stranded(run)

    expect(out?.failure_reason).toContain(TRIDENT_SNAPSHOT_MARKER)
    expect(await gitOut(world.checkout, 'rev-parse', 'refs/tags/trident-salvage/salvage-run')).toMatch(
      /^[0-9a-f]{40}$/,
    )
  }, 60_000)

  test('a failed ref anchor is persisted and does not block later commit salvage', async () => {
    const world = await seedWorld('dirty')
    if (world.worktree === null) throw new Error('dirty fixture did not keep its worktree')
    const harness = buildHybridHost()
    const failingAnchor: RunHostCommand = async (cmd, cwd) => {
      if (cmd.includes('update-ref') && cmd.some((arg) => arg.includes('trident-salvage'))) {
        return {
          ok: false,
          stdout: '',
          stderr: 'simulated ref refusal',
          exit_code: 1,
        }
      }
      return harness.run(cmd, cwd)
    }

    const first = await orchestrator(world, failingAnchor).step(makeRun(world.checkout))

    expect(first.run.failure_reason).toContain(TRIDENT_SNAPSHOT_FAILURE_MARKER)
    expect(first.run.failure_reason).toContain('snapshot update-ref failed: simulated ref refusal')
    expect(first.run.failure_reason).not.toContain(TRIDENT_SNAPSHOT_MARKER)
    expect(composeTerminalDelivery(first.run)?.text).toContain(
      'Recovery warning: snapshot update-ref failed: simulated ref refusal.',
    )

    await git(world.worktree, 'add', '-A')
    await git(world.worktree, ...GIT_ID, 'commit', '-q', '-m', 'finish after anchor refusal')
    const later = await orchestrator(world, harness.run).reconcile_stranded(first.run)
    expect(later?.pr).toBe(7)
    expect(later?.failure_reason).toContain(TRIDENT_SALVAGE_MARKER)
  }, 60_000)

  test('a failed dirty snapshot remains visible when committed work is published', async () => {
    const world = await seedWorld('ahead-dirty')
    const harness = buildHybridHost()
    const failingAnchor: RunHostCommand = async (cmd, cwd) => {
      if (cmd.includes('update-ref') && cmd.some((arg) => arg.includes('trident-salvage'))) {
        return { ok: false, stdout: '', stderr: 'simulated ref refusal', exit_code: 1 }
      }
      return harness.run(cmd, cwd)
    }

    const out = await orchestrator(world, failingAnchor).step(makeRun(world.checkout))

    expect(out.run.pr).toBe(7)
    expect(out.run.failure_reason).toContain(TRIDENT_SALVAGE_MARKER)
    expect(out.run.failure_reason).not.toContain(TRIDENT_SNAPSHOT_MARKER)
    expect(out.run.failure_reason).toContain(TRIDENT_SNAPSHOT_FAILURE_MARKER)
    expect(out.run.failure_reason).toContain('snapshot update-ref failed')
    expect(out.note).toContain('stranded build salvaged → PR #7')
    expect(composeTerminalDelivery(out.run)?.text).toContain(
      'Recovery warning: snapshot update-ref failed: simulated ref refusal.',
    )
  }, 60_000)

  test('retry after a lost store write keeps the first recovery ref and snapshot', async () => {
    const world = await seedWorld('dirty')
    if (world.worktree === null) throw new Error('dirty fixture did not keep its worktree')
    const harness = buildHybridHost()
    const orch = orchestrator(world, harness.run)
    const failedRow = makeRun(world.checkout, { phase: 'failed', failure_reason: FAILURE })

    // The ref succeeds, but deliberately discard the returned row to model the
    // boot sweep's following store update failing.
    const first = await orch.reconcile_stranded(failedRow)
    expect(first?.failure_reason).toContain(TRIDENT_SNAPSHOT_MARKER)
    const snapshotRef = 'refs/tags/trident-salvage/salvage-run'
    const firstOid = await gitOut(world.checkout, 'rev-parse', snapshotRef)
    expect(await gitOut(world.checkout, 'show', `${snapshotRef}:README.md`)).toBe(
      'base\nuncommitted work',
    )

    writeFileSync(join(world.worktree, 'README.md'), 'base\nchanged after failed store write\n')
    const retry = await orch.reconcile_stranded(failedRow)

    expect(retry?.failure_reason).toContain(TRIDENT_SNAPSHOT_MARKER)
    expect(await gitOut(world.checkout, 'rev-parse', snapshotRef)).toBe(firstOid)
    expect(await gitOut(world.checkout, 'show', `${snapshotRef}:README.md`)).toBe(
      'base\nuncommitted work',
    )
    expect(harness.calls.filter((cmd) => cmd.includes('update-ref'))).toHaveLength(1)
  }, 60_000)

  test('committed and uncommitted work are both reported while the commit is published', async () => {
    const world = await seedWorld('ahead-dirty')
    const harness = buildHybridHost()

    const out = await orchestrator(world, harness.run).step(makeRun(world.checkout))

    expect(out.run.phase).toBe('failed')
    expect(out.run.pr).toBe(7)
    expect(out.run.failure_reason).toContain(TRIDENT_SALVAGE_MARKER)
    expect(out.run.failure_reason).toContain(TRIDENT_SNAPSHOT_MARKER)
    const remote = await spawnCapture(
      ['git', '-C', world.checkout, 'ls-remote', '--heads', 'origin', `refs/heads/${BRANCH}`],
      world.checkout,
    )
    expect(remote.ok).toBe(true)
    if (world.branchHead === null) throw new Error('ahead-dirty fixture did not create a branch head')
    expect(remote.stdout.trim().split(/\s+/)[0]).toBe(world.branchHead)
    expect(await gitOut(world.checkout, 'rev-parse', 'refs/tags/trident-salvage/salvage-run')).toMatch(
      /^[0-9a-f]{40}$/,
    )
  }, 60_000)

  test('already-published commits can gain a snapshot without claiming another publish', async () => {
    const world = await seedWorld('ahead-dirty')
    if (world.worktree === null) throw new Error('ahead-dirty fixture did not keep its worktree')
    await git(world.worktree, 'push', '-q', 'origin', BRANCH)
    const harness = buildHybridHost()

    const out = await orchestrator(world, harness.run).step(makeRun(world.checkout, { pr: 7 }))

    expect(out.run.failure_reason).toContain(TRIDENT_SNAPSHOT_MARKER)
    expect(out.note).toContain('stranded work recorded without a publish')
    expect(harness.calls.some((cmd) => cmd[0] === 'git' && cmd.includes('push'))).toBe(false)
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
    const run = makeRun(world.checkout, { inner_checkpoint: 'forge-done' })
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
