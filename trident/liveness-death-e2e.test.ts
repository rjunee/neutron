/** End-to-end pin for external launcher liveness → durable bounded recovery. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { InnerLoopInput } from './inner-loop.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { TridentRunStore, type TridentRun } from './store.ts'
import { TridentTickLoop, type LauncherLiveness } from './tick.ts'

let scratchpad: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  scratchpad = mkdtempSync(join(tmpdir(), 'trident-liveness-death-e2e-'))
  db = ProjectDb.open(join(scratchpad, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(scratchpad, { recursive: true, force: true })
})

async function seedRunning(id: string, generation: string): Promise<TridentRun> {
  await store.create({ id, slug: id, project_slug: 'p', repo_path: '/repo', task: 'build' })
  return (await store.update(id, {
    phase: 'ralph-task',
    branch: 'trident/existing',
    pr: 312,
    inner_checkpoint: 'ralph-task-built',
    subagent_run_id: `workflow-${id}`,
    subagent_status: 'running',
    workflow_run_id: generation,
  }))!
}

function harness(
  answer: LauncherLiveness,
  fire: (input: InnerLoopInput) => Promise<{ status: 'fired'; error: null; launcher_session_key: string }>,
  maxCrashRecoveries = 2,
): TridentTickLoop {
  const orchestrator = buildTridentOrchestrator({
    fire_workflow: fire,
    db_path: join(scratchpad, 'project.db'),
    run_host: async () => ({ ok: true, stdout: '', stderr: '', exit_code: 0 }),
    base_branch: 'main',
    on_orphaned_session: 'wait',
    begin_crash_recovery: (id) => store.beginCrashRecovery(id),
    max_crash_recoveries: maxCrashRecoveries,
  })
  return new TridentTickLoop({
    store,
    step: orchestrator.step,
    probe_launcher_alive: async () => answer,
    latch_launcher_dead: (key, reason) => store.crashRunningByLauncher(key, reason),
  })
}

describe('external launcher death reaches the real orchestrator without killing the build', () => {
  test('a positively dead generation is latched in seconds then continued by the sweep', async () => {
    await seedRunning('spent', 'generation-dead')
    const loop = harness(
      'dead',
      async () => ({ status: 'fired', error: null, launcher_session_key: 'unused' }),
      3,
    )

    await loop.runLivenessOnce()
    const latched = store.get('spent')!
    expect(latched.phase).toBe('ralph-task')
    expect(latched.subagent_status).toBe('crashed')
    expect(latched.failure_reason).toContain('inner workflow launcher crashed:')
    expect(latched.failure_reason).toContain('generation-dead')

    await loop.runOnce()
    const continued = store.get('spent')!
    expect(continued.phase).toBe('ralph-task')
    expect(continued.subagent_status).toBe('running')
    expect(continued.workflow_run_id).toBe('unused')
    expect(continued.crash_recoveries).toBe(1)
  })

  test('a slow but positively alive run is untouched by the liveness pass and one sweep', async () => {
    const stale = new Date(Date.now() - 30 * 60_000).toISOString()
    const staleStore = new TridentRunStore(db, () => stale)
    await staleStore.create({
      id: 'slow-alive', slug: 'slow-alive', project_slug: 'p', repo_path: '/repo', task: 'build',
    })
    await staleStore.update('slow-alive', {
      phase: 'ralph-task',
      subagent_run_id: 'workflow-slow',
      subagent_status: 'running',
      workflow_run_id: 'generation-alive',
    })
    const before = store.get('slow-alive')!
    const loop = harness('alive', async () => ({
      status: 'fired',
      error: null,
      launcher_session_key: 'must-not-launch',
    }))

    await loop.runLivenessOnce()
    await loop.runOnce()

    expect(store.get('slow-alive')).toEqual(before)
  })
})
