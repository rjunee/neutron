import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { spawnCapture } from './git-mode.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { stubAdvanceDeps } from './state-machine.ts'
import { TridentRunStore } from './store.ts'
import { buildAsBuiltCatchup, TridentTickLoop } from './tick.ts'

const GIT_ID = ['-c', 'user.name=Test Setup', '-c', 'user.email=setup@neutron.local', '-c', 'commit.gpgsign=false']
const HEADER = '# AS_BUILT\n\nRunning log of what shipped, newest first. One entry per merged change.\n\n'

let root: string
let db: ProjectDb
let dbPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'as-built-fold-wiring-'))
  dbPath = join(root, 'project.db')
  seedMigratedDb(dbPath)
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const result = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

describe('as-built outer-loop wiring with real git', () => {
  test('a successful APPROVE merge folds its staged entry on the base', async () => {
    const repo = join(root, 'approve-repo')
    mkdirSync(join(repo, 'docs'), { recursive: true })
    await git(root, 'init', '-q', '--initial-branch=main', repo)
    await git(repo, 'config', 'user.name', 'Test Setup')
    await git(repo, 'config', 'user.email', 'setup@neutron.local')
    writeFileSync(join(repo, 'docs', 'AS_BUILT.md'), `${HEADER}## 2026-08-17 — history\n\nold body\n`)
    await git(repo, 'add', '-A')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'base')

    const branch = 'trident/approve-fold'
    const stagedPath = '.trident/as-built/trident/approve-fold.md'
    await git(repo, 'switch', '-q', '-c', branch)
    mkdirSync(join(repo, '.trident', 'as-built', 'trident'), { recursive: true })
    writeFileSync(join(repo, stagedPath), '## 2026-08-18 — folded after approve\n\nshipped body\n')
    await git(repo, 'add', stagedPath)
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'stage as-built entry')
    await git(repo, 'switch', '-q', 'main')

    const store = new TridentRunStore(db)
    const created = await store.create({
      slug: 'approve-fold',
      project_slug: 'test',
      repo_path: repo,
      task: 'merge and fold',
      branch,
      merge_mode: 'local',
    })
    await store.update(created.id, {
      inner_checkpoint: 'argus-approved',
      subagent_run_id: 'finished-inner-workflow',
      subagent_status: 'completed',
      inner_result: JSON.stringify({
        ok: true,
        verdict: 'APPROVE',
        branch,
        round: 1,
        checkpoint: 'argus-approved',
        remainingTasks: 0,
      }),
    })
    const orchestrator = buildTridentOrchestrator({
      fire_workflow: async () => ({ status: 'fired', error: null }),
      db_path: dbPath,
      run_host: spawnCapture,
      base_branch: 'main',
    })

    const outcome = await orchestrator.step(store.get(created.id)!)

    expect(outcome.run.phase).toBe('done')
    expect(outcome.run.failure_reason).toBeNull()
    expect(outcome.note).toContain('as-built: folded 1')
    expect(await git(repo, 'show', 'main:docs/AS_BUILT.md')).toStartWith(
      `${HEADER}## 2026-08-18 — folded after approve\n\nshipped body\n\n`,
    )
    expect(await git(repo, 'ls-tree', '-r', '--name-only', 'main', '--', '.trident/as-built/')).toBe('')
    expect(
      (await git(repo, 'diff-tree', '--no-commit-id', '--name-status', '-r', 'main')).split('\n').sort(),
    ).toEqual([`D\t${stagedPath}`, 'M\tdocs/AS_BUILT.md'])
  }, 60_000)

  test('a fold failure leaves the merged run done and its staged entry queued', async () => {
    const repo = join(root, 'failed-fold-repo')
    mkdirSync(join(repo, 'docs'), { recursive: true })
    await git(root, 'init', '-q', '--initial-branch=main', repo)
    await git(repo, 'config', 'user.name', 'Test Setup')
    await git(repo, 'config', 'user.email', 'setup@neutron.local')
    writeFileSync(join(repo, 'docs', 'AS_BUILT.md'), `${HEADER}## 2026-08-17 — history\n\nold body\n`)
    await git(repo, 'add', '-A')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'base')

    const branch = 'trident/fold-failure'
    const stagedPath = '.trident/as-built/trident/fold-failure.md'
    await git(repo, 'switch', '-q', '-c', branch)
    mkdirSync(join(repo, '.trident', 'as-built', 'trident'), { recursive: true })
    writeFileSync(join(repo, stagedPath), '## 2026-08-18 — queued after failure\n\nshipped body\n')
    await git(repo, 'add', stagedPath)
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'stage as-built entry')
    await git(repo, 'switch', '-q', 'main')

    const store = new TridentRunStore(db)
    const created = await store.create({
      slug: 'fold-failure',
      project_slug: 'test',
      repo_path: repo,
      task: 'merge despite fold failure',
      branch,
      merge_mode: 'local',
    })
    await store.update(created.id, {
      inner_checkpoint: 'argus-approved',
      subagent_run_id: 'finished-inner-workflow',
      subagent_status: 'completed',
      inner_result: JSON.stringify({
        ok: true,
        verdict: 'APPROVE',
        branch,
        round: 1,
        checkpoint: 'argus-approved',
        remainingTasks: 0,
      }),
    })
    const calls: { repo_path: string; merge_mode: string; base: string }[] = []
    const orchestrator = buildTridentOrchestrator({
      fire_workflow: async () => ({ status: 'fired', error: null }),
      db_path: dbPath,
      run_host: spawnCapture,
      base_branch: 'main',
      fold_as_built: async (run, base) => {
        calls.push({ repo_path: run.repo_path, merge_mode: run.merge_mode, base })
        return { ok: false, folded: 0, reason: 'deterministic fold failure' }
      },
    })

    const outcome = await orchestrator.step(store.get(created.id)!)

    expect(outcome.run.phase).toBe('done')
    expect(outcome.run.failure_reason).toBeNull()
    expect(outcome.note).toContain('as-built fold deferred')
    expect(outcome.note).toContain('deterministic fold failure')
    expect(calls).toEqual([{ repo_path: repo, merge_mode: 'local', base: 'main' }])
    expect(await git(repo, 'show', `main:${stagedPath}`)).toBe(
      '## 2026-08-18 — queued after failure\n\nshipped body',
    )
    expect(await git(repo, 'show', 'main:docs/AS_BUILT.md')).toBe(
      `${HEADER}## 2026-08-17 — history\n\nold body`,
    )
  }, 60_000)

  test('a later ordinary tick folds a missed entry and an empty queue creates no commit', async () => {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'docs'), { recursive: true })
    await git(root, 'init', '-q', '--initial-branch=main', repo)
    writeFileSync(join(repo, 'docs', 'AS_BUILT.md'), `${HEADER}## 2026-08-17 — history\n\nold body\n`)
    await git(repo, 'add', '-A')
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'base')

    const stagedPath = '.trident/as-built/missed-after-merge.md'
    mkdirSync(join(repo, '.trident', 'as-built'), { recursive: true })
    writeFileSync(join(repo, stagedPath), '## 2026-08-18 — caught up later\n\nnew body\n')
    await git(repo, 'add', stagedPath)
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'merge left staged entry')
    const queuedTip = await git(repo, 'rev-parse', 'main')

    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'missed-fold',
      project_slug: 'test',
      repo_path: repo,
      task: 'already merged',
      merge_mode: 'local',
    })
    await store.update(run.id, { phase: 'done' })
    const loop = new TridentTickLoop({
      store,
      deps: stubAdvanceDeps(),
      watch_interval_ms: 0,
      fold_staged_as_built: buildAsBuiltCatchup(spawnCapture, 'main'),
    })

    expect((await loop.runOnce()).advanced).toBe(0)
    const foldedTip = await git(repo, 'rev-parse', 'main')
    expect(foldedTip).not.toBe(queuedTip)
    expect(await git(repo, 'show', 'main:docs/AS_BUILT.md')).toStartWith(
      `${HEADER}## 2026-08-18 — caught up later\n\nnew body\n\n`,
    )
    expect(await git(repo, 'ls-tree', '-r', '--name-only', 'main', '--', '.trident/as-built/')).toBe('')
    expect((await git(repo, 'diff-tree', '--no-commit-id', '--name-status', '-r', foldedTip)).split('\n').sort()).toEqual([
      `D\t${stagedPath}`,
      'M\tdocs/AS_BUILT.md',
    ])

    expect((await loop.runOnce()).advanced).toBe(0)
    expect(await git(repo, 'rev-parse', 'main')).toBe(foldedTip)
    await loop.stop()
  }, 60_000)
})
