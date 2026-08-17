import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import type { CompositionInput } from '../composition.ts'
import type { ModuleContext } from '../module-graph.ts'
import { buildCoreModules } from './build-core-modules.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-terminal-wake-wiring-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
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

function tridentInput(
  on_terminal_wake?: NonNullable<CompositionInput['trident']>['on_terminal_wake'],
): CompositionInput {
  return {
    ...baseInput(),
    trident: {
      fire_inner_workflow: async () => ({ status: 'fired', error: null }),
      run_host: async () => ({ ok: true, stdout: 'main', stderr: '', exit_code: 0 }),
      delivery_sink: { send: async () => '' },
      ...(on_terminal_wake === undefined ? {} : { on_terminal_wake }),
    },
  }
}

async function seedTerminalButGarbled(id: string): Promise<void> {
  const store = new TridentRunStore(db)
  await store.create({ id, slug: id, project_slug: 'alice', repo_path: '/repo', task: 'build' })
  await store.update(id, {
    merge_mode: 'local',
    subagent_run_id: 'wf-done',
    subagent_status: 'completed',
    inner_result: null,
  })
}

describe('trident terminal-build wake composition wiring', () => {
  test("the tick loop's composed terminal hook invokes the threaded wake observer exactly once", async () => {
    const woken: string[] = []
    const mods = buildCoreModules(tridentInput(async (run) => { woken.push(run.id) }))
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedTerminalButGarbled('wake-run')

      await instance.loop.runOnce()
      expect(new TridentRunStore(db).get('wake-run')?.phase).toBe('failed')
      expect(woken).toEqual(['wake-run'])

      await instance.loop.runOnce()
      expect(woken).toEqual(['wake-run'])
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  })

  test('an absent on_terminal_wake leaves the terminal chain unchanged', async () => {
    const mods = buildCoreModules(tridentInput())
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedTerminalButGarbled('unwired-wake-run')

      await instance.loop.runOnce()
      expect(new TridentRunStore(db).get('unwired-wake-run')?.phase).toBe('failed')
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  })
})
