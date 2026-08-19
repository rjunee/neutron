import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import type { CompositionInput } from '../composition.ts'
import type { ModuleContext } from '../module-graph.ts'
import { buildCoreModules } from './build-core-modules.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-liveness-wiring-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const fakeCtx: ModuleContext = {
  graph: { get: () => ({}) as never, names: () => [] },
  config: {},
}

function baseInput(): CompositionInput {
  return {
    db,
    project_slug: 'alice',
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
  }
}

function tridentInput(probe_launcher_alive?: NonNullable<CompositionInput['trident']>['probe_launcher_alive']): CompositionInput {
  return {
    ...baseInput(),
    trident: {
      fire_inner_workflow: async () => ({ status: 'fired', error: null }),
      run_host: async () => ({ ok: true, stdout: 'main', stderr: '', exit_code: 0 }),
      delivery_sink: { send: async () => '' },
      ...(probe_launcher_alive === undefined ? {} : { probe_launcher_alive }),
    },
  }
}

async function seedRunning(id: string, generation: string): Promise<void> {
  const store = new TridentRunStore(db)
  await store.create({ id, slug: id, project_slug: 'alice', repo_path: '/repo', task: 'build' })
  await store.update(id, {
    phase: 'ralph-task',
    branch: 'trident/test',
    pr: 312,
    inner_checkpoint: 'ralph-task-built',
    subagent_run_id: 'wf-wire-1',
    subagent_status: 'running',
    workflow_run_id: generation,
  })
}

describe('trident external liveness composition wiring', () => {
  test('an absent probe preserves the two existing timers', async () => {
    const mods = buildCoreModules(tridentInput())
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      expect(instance.loop.describeAll().map((descriptor) => descriptor.name)).toEqual(['trident', 'trident-watch'])
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  })

  test('a wired probe exposes the default 15 second timer', async () => {
    const mods = buildCoreModules(tridentInput(async () => 'dead'))
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      expect(instance.loop.describeAll()).toContainEqual(expect.objectContaining({ name: 'trident-liveness', cadenceMs: 15_000 }))
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  })

  test('positive launcher death enters the existing durable recovery path', async () => {
    const mods = buildCoreModules(tridentInput(async () => 'dead'))
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedRunning('dead-run', 'gen-wire-1')
      await instance.loop.runLivenessOnce()
      const after = new TridentRunStore(db).get('dead-run')!
      expect(after.phase).toBe('ralph-task')
      expect(after.subagent_status).toBe('crashed')
      expect(after.subagent_run_id).toBe('wf-wire-1')
      expect(after.workflow_run_id).toBe('gen-wire-1')
      expect(after.failure_reason).toStartWith('inner workflow launcher crashed:')
      expect(after.failure_reason).toContain('gen-wire-1')
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  })

  test('alive evidence leaves the running row untouched', async () => {
    const mods = buildCoreModules(tridentInput(async () => 'alive'))
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedRunning('alive-run', 'gen-alive-1')
      await instance.loop.runLivenessOnce()
      expect(new TridentRunStore(db).get('alive-run')!.subagent_status).toBe('running')
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  })
})
