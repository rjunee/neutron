/**
 * Production-registration proof for the startup stranded-failure sweep. This
 * drives the real buildCoreModules(...).tridentModule.init path; it never calls
 * the sweep or reconciliation seam directly.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { spawnCapture, type HostCommandResult } from '@neutronai/trident/git-mode.ts'
import type { RunHostCommand } from '@neutronai/trident/merge.ts'
import { TRIDENT_SALVAGE_MARKER } from '@neutronai/trident/orchestrator.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'

import type { CompositionInput } from '../composition.ts'
import type { ModuleContext } from '../module-graph.ts'
import { buildCoreModules } from './build-core-modules.ts'

const BRANCH = 'trident/startup-stranded'
const FAILURE = 'inner workflow fire failed: fire turn raised an error before settling'
const CONTROL_FAILURE = 'empty failure with no branch'
const GIT_ID = [
  '-c',
  'user.name=Trident Test',
  '-c',
  'user.email=trident-test@neutron.local',
  '-c',
  'commit.gpgsign=false',
]

let root: string
let origin: string
let checkout: string
let branchHead: string
let db: ProjectDb

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

async function git(repo: string, ...args: string[]): Promise<void> {
  const result = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
}

async function gitOut(repo: string, ...args: string[]): Promise<string> {
  const result = await spawnCapture(['git', '-C', repo, ...args], repo)
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'neutron-trident-startup-sweep-'))
  origin = join(root, 'origin.git')
  checkout = join(root, 'checkout')

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

  await git(checkout, 'branch', BRANCH, 'main')
  const builder = join(root, 'builder')
  await git(checkout, 'worktree', 'add', '-q', builder, BRANCH)
  writeFileSync(join(builder, 'finished.txt'), 'finished build\n')
  await git(builder, 'add', 'finished.txt')
  await git(builder, ...GIT_ID, 'commit', '-q', '-m', 'finished build')
  branchHead = await gitOut(builder, 'rev-parse', 'HEAD')
  await git(checkout, 'worktree', 'remove', '--force', builder)

  db = ProjectDb.open(join(root, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

const fakeCtx: ModuleContext = {
  graph: { get: () => ({}) as never, names: () => [] },
  config: {},
}

function hybridHost(): RunHostCommand {
  let opened = false
  return async (cmd, cwd) => {
    if (cmd[0] === 'git') return spawnCapture(cmd, cwd)
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'list') return ok(opened ? '389\n' : '')
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'create') {
      opened = true
      return ok()
    }
    throw new Error(`unexpected host command: ${cmd.join(' ')}`)
  }
}

function input(run_host: RunHostCommand): CompositionInput {
  return {
    db,
    project_slug: 'alice',
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
    trident: {
      fire_inner_workflow: async () => ({ status: 'fired', error: null }),
      run_host,
      delivery_sink: { send: async () => '' },
    },
  }
}

describe('trident stranded-failure startup sweep production wiring', () => {
  test('module init publishes a real stranded branch while leaving empty failures untouched', async () => {
    const seeded = new TridentRunStore(db)
    const stranded = await seeded.create({
      slug: 'startup-stranded',
      project_slug: 'alice',
      repo_path: checkout,
      task: 'recover the finished build',
      phase: 'failed',
      merge_mode: 'pr',
      branch: BRANCH,
    })
    await seeded.update(stranded.id, { failure_reason: FAILURE })
    const control = await seeded.create({
      slug: 'missing-control',
      project_slug: 'alice',
      repo_path: checkout,
      task: 'no work was built',
      phase: 'failed',
      merge_mode: 'pr',
      branch: 'trident/missing-control',
    })
    await seeded.update(control.id, { failure_reason: CONTROL_FAILURE })
    const controlBefore = seeded.get(control.id)

    const modules = buildCoreModules(input(hybridHost()))
    const instance = await modules.tridentModule.init(fakeCtx)
    try {
      expect(instance.stranded_sweep).toBeDefined()
      await instance.stranded_sweep

      const remote = await gitOut(checkout, 'ls-remote', '--heads', 'origin', `refs/heads/${BRANCH}`)
      expect(remote.split(/\s+/)[0]).toBe(branchHead)

      const recovered = seeded.get(stranded.id)
      expect(recovered?.phase).toBe('failed')
      expect(recovered?.pr).toBe(389)
      expect(recovered?.failure_reason).toStartWith(FAILURE)
      expect(recovered?.failure_reason).toContain(TRIDENT_SALVAGE_MARKER)
      expect(seeded.get(control.id)).toEqual(controlBefore)
    } finally {
      await modules.tridentModule.shutdown!(instance)
    }
  }, 60_000)
})
