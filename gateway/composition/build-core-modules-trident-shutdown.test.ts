/**
 * §F1 — the trident MODULE's quiescing shutdown (PR #313).
 *
 * `buildCoreModules(...).tridentModule.shutdown` must:
 *   1. capture the orchestrator's `drain()` on the WIRED path (and leave it
 *      undefined on the unwired path), and
 *   2. QUIESCE — `await loop.stop()` (then `drain()`) so an in-flight FIRE turn
 *      settles before the caller closes the DB.
 *
 * These tests drive the REAL module (`buildCoreModules` → `tridentModule.init` /
 * `.shutdown`) with a GATED `fire_inner_workflow`, so a launch holds a tick
 * in-flight and we can prove `shutdown()` stays pending until the fire releases.
 * The primitive-level tests cannot cover this integration wiring — a regression
 * that dropped the `drain` capture or reordered the shutdown would pass them.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import type { FireInnerWorkflow } from '@neutronai/trident/inner-loop.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'

import { buildCoreModules } from './build-core-modules.ts'
import type { CompositionInput } from '../composition.ts'
import type { ModuleContext } from '../module-graph.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-shutdown-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A ctx whose graph.get('channels') returns a bare object — unused because we
 *  supply `trident.delivery_sink`. */
const fakeCtx: ModuleContext = {
  graph: { get: () => ({}) as never, names: () => [] },
  config: {},
}

/** Minimal valid CompositionInput (mirrors the boot-init-cleanup composer). */
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

describe('trident module shutdown — §F1 quiesce + drain wiring', () => {
  test('wired path: captures drain() and shutdown quiesces an in-flight fire', async () => {
    let entered = false
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    // Gated fire seam: the launching turn blocks until we release the gate,
    // holding the tick (and thus the orchestrator FIRE turn) in flight.
    const fire_inner_workflow: FireInnerWorkflow = async () => {
      entered = true
      await gate
      return { status: 'fired', error: null }
    }

    const input: CompositionInput = {
      ...baseInput(),
      trident: {
        fire_inner_workflow,
        // Stub host so base-branch detection never spawns real git.
        run_host: async () => ({ ok: true, stdout: 'main', stderr: '', exit_code: 0 }),
        // Supply a sink so the (unused) ChannelRouter fallback isn't needed.
        delivery_sink: { send: async () => '' },
      },
    }

    const mods = buildCoreModules(input)
    const instance = await mods.tridentModule.init(fakeCtx)
    // (a) the wired path captured the orchestrator's drain().
    expect(instance.drain).toBeDefined()

    // A fresh run (subagent_run_id === null) launches on the first tick →
    // invokes the gated fire. `init` already called `loop.start()`, so drive one
    // tick directly and hold it in flight (do NOT await — it blocks on the gate).
    const store = new TridentRunStore(db)
    await store.create({ slug: 'r1', project_slug: 'alice', repo_path: '/repo', task: 'do a thing' })
    const tickP = instance.loop.runOnce()

    try {
      for (let i = 0; i < 100 && !entered; i++) await sleep(2)
      expect(entered).toBe(true)

      // (b) shutdown() must stay PENDING while the fire is in flight.
      let shutdownDone = false
      const shutdownP = Promise.resolve(mods.tridentModule.shutdown!(instance)).then(() => {
        shutdownDone = true
      })
      await sleep(20)
      expect(shutdownDone).toBe(false)

      // (c) releasing the gate lets the fire settle → shutdown + tick resolve.
      // Bound with a timeout so a quiesce regression fails fast, not hangs.
      release()
      const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 2000))
      const raced = await Promise.race([shutdownP.then(() => 'done' as const), timeout])
      expect(raced).toBe('done')
      expect(shutdownDone).toBe(true)
      await tickP
    } finally {
      release() // idempotent — ensure nothing is left blocked on the gate
      await instance.loop.stop()
    }
  })

  test('unwired path: drain is undefined and shutdown still resolves', async () => {
    const mods = buildCoreModules(baseInput())
    const instance = await mods.tridentModule.init(fakeCtx)
    try {
      expect(instance.drain).toBeUndefined()
      await expect(Promise.resolve(mods.tridentModule.shutdown!(instance))).resolves.toBeUndefined()
    } finally {
      await instance.loop.stop()
    }
  })
})
