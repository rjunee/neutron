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

/**
 * THE PROBE'S POSITIVE ANSWER, READ BY THE HANG WATCHDOG.
 *
 * The liveness loop above acts ONLY on a positive 'dead' (`tick.ts`: "if (verdict !==
 * 'dead') continue"), so the one fact that could spare a working build — 'alive' — was
 * computed every 15 seconds and thrown away, while the 90-minute reaper killed lanes
 * that were demonstrably running.
 *
 * WIRED, NOT JUST WRITTEN. This repo has landed a module plus its unit tests five times
 * in one night and skipped the registration, so a green merge delivered no behaviour.
 * These drive the REAL composed orchestrator and assert the probe was CONSULTED and
 * ACTED ON, rather than asserting a seam that production may never pass.
 */
describe('trident hang-watchdog wiring — the composed orchestrator consults the launcher probe', () => {
  /** Age a run's advancement clock past the 90-minute hang threshold, in SQL — the
   *  store deliberately re-stamps `last_advanced_at` on every save. */
  const ageBeyondHangThreshold = (id: string): void => {
    db.raw().run('UPDATE code_trident_runs SET last_advanced_at = ? WHERE id = ?', [
      new Date(Date.now() - 100 * 60_000).toISOString(),
      id,
    ])
  }

  test('an ALIVE launcher spares a run the 90-minute reaper would have killed', async () => {
    let probed = 0
    const mods = buildCoreModules(
      tridentInput(async () => {
        probed += 1
        return 'alive'
      }),
    )
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedRunning('watchdog-alive', 'gen-watchdog-1')
      ageBeyondHangThreshold('watchdog-alive')
      await instance.loop.runOnce()

      const after = new TridentRunStore(db).get('watchdog-alive')!
      expect(probed).toBeGreaterThan(0)
      expect(after.phase).not.toBe('failed')
      expect(after.failure_reason ?? '').not.toContain('suspected agent hang')
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  })

  test('an UNKNOWN launcher still reaps — and the terminal record DISCLOSES what was checked', async () => {
    // The negative half: absence of evidence must not become a reprieve, and the reap
    // must say what it looked at. Every one of the 13 reaped rows in the live DB
    // carried the bare "suspected agent hang" string and no evidence at all.
    const mods = buildCoreModules(tridentInput(async () => 'unknown'))
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      await instance.loop.stop()
      await seedRunning('watchdog-unknown', 'gen-watchdog-2')
      ageBeyondHangThreshold('watchdog-unknown')
      await instance.loop.runOnce()

      const after = new TridentRunStore(db).get('watchdog-unknown')!
      expect(after.phase).toBe('failed')
      expect(after.failure_reason ?? '').toContain('suspected agent hang')
      expect(after.failure_reason ?? '').toMatch(/liveness checked:/)
      expect(after.failure_reason ?? '').toContain('launcher probe=unknown')
    } finally {
      await mods.tridentModule.shutdown!(instance)
    }
  })
})
