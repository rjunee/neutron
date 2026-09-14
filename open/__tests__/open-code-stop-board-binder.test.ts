import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { parseAndExecuteCodeCommand } from '@neutronai/trident/code-command.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { WorkBoardStore } from '@neutronai/work-board/store.ts'
import { buildTridentCodeBoardBinder } from '../composer.ts'

describe('Open /code stop board binder', () => {
  let tmp: string
  let db: ProjectDb

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-open-code-stop-binder-'))
    seedMigratedDb(join(tmp, 'project.db'))
    db = ProjectDb.open(join(tmp, 'project.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('carries terminal PR and Ralph payload through the production binder', async () => {
    const scope = 'owner'
    const runStore = new TridentRunStore(db)
    const run = await runStore.create({
      slug: 'stop-with-payload',
      project_slug: scope,
      repo_path: '/repo',
      task: 'stop this governed build',
      ralph: true,
      ralph_round: 3,
      max_ralph_rounds: 7,
    })
    await runStore.update(run.id, { pr: 784 })

    const boardStore = new WorkBoardStore(db)
    const item = await boardStore.create(scope, { title: 'Governed build with PR' })
    await boardStore.bindRun(scope, item.id, run.id)
    const binder = buildTridentCodeBoardBinder(() => boardStore)

    const response = await parseAndExecuteCodeCommand('/code stop', {
      store: runStore,
      work_board: binder,
      project_slug: scope,
      repo_path: '/repo',
      resolveMergeMode: async () => 'pr',
    })

    expect(response?.text).toContain('Stopped')
    const stopped = boardStore.get(scope, item.id)!
    expect(stopped.status).toBe('failed')
    expect(stopped.pr).toBe(784)
    expect(stopped.pr_url).toBeNull()
    expect(stopped.ralph_round).toBe(3)
    expect(stopped.max_ralph_rounds).toBe(7)
  })
})
