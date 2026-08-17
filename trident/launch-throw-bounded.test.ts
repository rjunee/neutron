import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { TridentRunStore, type TridentRun } from './store.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'trident-launch-throw-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

interface LaunchControl {
  faultsRemaining: number
  attempts: number
  fires: number
}

function orchestrator(control: LaunchControl, crashRecovery = false) {
  return buildTridentOrchestrator({
    fire_workflow: async () => {
      control.fires += 1
      return { status: 'fired' as const, launcher_session_key: `generation-${control.fires}` }
    },
    db_path: join(tmp, 'project.db'),
    run_host: async () => ({ ok: true, stdout: '', stderr: '', exit_code: 0 }),
    base_branch: 'main',
    now: () => new Date(0).toISOString(),
    mint_run_id: () => {
      control.attempts += 1
      if (control.faultsRemaining > 0) {
        control.faultsRemaining -= 1
        throw new Error('resolveBase: git refused')
      }
      return `wf-${control.attempts}`
    },
    ...(crashRecovery ? { begin_crash_recovery: (id: string) => store.beginCrashRecovery(id) } : {}),
  })
}

async function seedRun(id: string): Promise<TridentRun> {
  await store.create({ id, slug: id, project_slug: 'p', repo_path: '/repo', task: 'build' })
  await store.update(id, {
    phase: 'ralph-task',
    branch: 'trident/work-survives',
    inner_checkpoint: 'ralph-task-built',
  })
  return store.get(id)!
}

describe('launch throws are visible and bounded', () => {
  test('a throwing launch is retried visibly then reaped', async () => {
    const control = { faultsRemaining: 3, attempts: 0, fires: 0 }
    const orch = orchestrator(control)
    const run = await seedRun('throwing-launch')

    const first = await orch.step(run)
    expect(first).toMatchObject({ changed: false, waiting: true })
    expect(first.note).toMatch(/attempt 1 of 3/)

    const second = await orch.step(run)
    expect(second).toMatchObject({ changed: false, waiting: true })
    expect(second.note).toMatch(/attempt 2 of 3/)

    const third = await orch.step(run)
    expect(third.changed).toBe(true)
    expect(third.run.phase).toBe('failed')
    expect(third.run.failure_reason).toContain('resolveBase: git refused')
    expect(third.run.failure_reason).toContain('not retrying')
    expect(third.run.failure_reason ?? '').not.toMatch(/exhausted/)
    expect(third.run.branch).toBe('trident/work-survives')
    expect(third.run.inner_checkpoint).toBe('ralph-task-built')

    expect(await store.saveIfActive(third.run)).toBe(true)
    expect(store.get(run.id)).toMatchObject({
      phase: 'failed',
      branch: 'trident/work-survives',
      inner_checkpoint: 'ralph-task-built',
    })
  })

  test('crash-claimed run cannot zombie', async () => {
    const control = { faultsRemaining: 3, attempts: 0, fires: 0 }
    const orch = orchestrator(control, true)
    const run = await seedRun('crash-claimed')
    await store.update(run.id, {
      subagent_run_id: 'wf-dead',
      subagent_status: 'running',
      workflow_run_id: 'generation-dead',
    })
    await store.crashRunningByLauncher('generation-dead', 'pooled child exited')

    const outcomes = []
    for (let sweep = 0; sweep < 3; sweep++) {
      const outcome = await orch.step(store.get(run.id)!)
      outcomes.push(outcome)
      if (outcome.changed) expect(await store.saveIfActive(outcome.run)).toBe(true)
    }

    expect(outcomes[0]?.note).toMatch(/attempt 1 of 3/)
    expect(outcomes[1]?.note).toMatch(/attempt 2 of 3/)
    expect(outcomes[2]?.run.phase).toBe('failed')
    const after = store.get(run.id)!
    expect(after.phase).toBe('failed')
    expect(after.failure_reason).toContain('resolveBase: git refused')
    expect(after.crash_recoveries).toBe(1)
    expect(control.fires).toBe(0)
  })

  test('success clears the fault budget', async () => {
    const control = { faultsRemaining: 2, attempts: 0, fires: 0 }
    const orch = orchestrator(control)
    const run = await seedRun('fault-reset')

    expect((await orch.step(run)).note).toMatch(/attempt 1 of 3/)
    expect((await orch.step(run)).note).toMatch(/attempt 2 of 3/)
    const launched = await orch.step(run)
    expect(launched).toMatchObject({ changed: true, waiting: true })
    expect(launched.note).toContain('fired inner workflow')
    expect(launched.run.subagent_run_id).toBe('wf-3')
    expect(control.fires).toBe(1)

    const relaunchable: TridentRun = {
      ...launched.run,
      subagent_run_id: null,
      subagent_status: null,
      workflow_run_id: null,
    }
    control.faultsRemaining = 3
    expect((await orch.step(relaunchable)).note).toMatch(/attempt 1 of 3/)
    expect((await orch.step(relaunchable)).note).toMatch(/attempt 2 of 3/)
    const reaped = await orch.step(relaunchable)
    expect(reaped.run.phase).toBe('failed')
    expect(reaped.run.failure_reason).toContain('launch failed 3 time(s); not retrying')
    expect(reaped.run.failure_reason ?? '').not.toContain('exhausted')
  })
})
