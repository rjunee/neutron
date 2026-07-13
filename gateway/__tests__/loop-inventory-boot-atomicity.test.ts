/**
 * §F2 — WHOLE-BOOT loop atomicity through the REAL `boot()` path (not a
 * reimplementation). A composer starts its own long-lived loops (the Open
 * composer starts the ChunkedUploadSweeper + dispatch-lifecycle-watchdog) and
 * pushes their `stop()` onto `realmode_cleanups`. If `composeProductionGraph`
 * (which boot runs AFTER the composer) then fails, `boot()`'s init-failure
 * cleanup must drain those cleanups so the composer's loops are STOPPED, not
 * leaked — the composer-side half of the whole-composition atomicity.
 *
 * This drives the production `boot()` + `composeProductionGraph` path with a
 * composer that (a) starts a real loop and registers its stop, and (b) hands
 * composeProductionGraph a registry pre-seeded with a gateway loop name so the
 * graph composition throws. It asserts boot rethrows AND the composer's loop was
 * stopped.
 *
 * MUTATION-VERIFIED: deleting the realmode-cleanup drain from `boot()`'s
 * failure path leaves the composer loop running → this test reds.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { boot } from '@neutronai/gateway/index.ts'
import type { CompositionInput } from '@neutronai/gateway/composition.ts'
import { LoopRegistry, SupervisedLoop } from '@neutronai/loop'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

let ownerDir: string
let savedHome: string | undefined
let savedNotify: string | undefined

beforeEach(() => {
  ownerDir = mkdtempSync(join(tmpdir(), 'neutron-boot-atomicity-'))
  savedHome = process.env['NEUTRON_HOME']
  savedNotify = process.env['NOTIFY_SOCKET']
  process.env['NEUTRON_HOME'] = ownerDir
  delete process.env['NOTIFY_SOCKET']
})

afterEach(() => {
  if (savedHome === undefined) delete process.env['NEUTRON_HOME']
  else process.env['NEUTRON_HOME'] = savedHome
  if (savedNotify === undefined) delete process.env['NOTIFY_SOCKET']
  else process.env['NOTIFY_SOCKET'] = savedNotify
  rmSync(ownerDir, { recursive: true, force: true })
})

test("boot() stops a composer-started loop when composeProductionGraph fails", async () => {
  // A composer-started loop, mirroring the Open composer's self-started loops.
  const composerLoop = new SupervisedLoop({
    name: 'composer-started-loop',
    intervalMs: 60_000,
    tick: async () => {},
  })
  composerLoop.start()
  expect(composerLoop.describe().isActive?.()).toBe(true)

  const composer = async ({
    db,
    project_slug,
  }: {
    db: CompositionInput['db']
    project_slug: string
  }): Promise<CompositionInput> => {
    // Pre-seed the shared registry with a GATEWAY loop name so
    // composeProductionGraph collides during compose() and rethrows.
    const registry = new LoopRegistry()
    registry.register({
      name: 'reminders',
      cadenceMs: 30_000,
      startedAt: 1,
      health: () => ({ lastTickAt: null, lastError: null }),
    })
    return {
      db,
      project_slug,
      topic_handler: async () => undefined,
      approval_notifier: { notify: async () => undefined },
      watchdog_notifier: { notify: async () => undefined },
      reminder_dispatcher: { dispatch: async () => undefined },
      heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
      loop_registry: registry,
      // The composer's own loop stop — boot's failure cleanup must drain this.
      realmode_cleanups: [
        async () => {
          await composerLoop.stop()
        },
      ],
    }
  }

  let threw = false
  try {
    await boot({ composer, port: 0 })
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
  // boot()'s init-failure cleanup drained realmode_cleanups → the composer's
  // loop is stopped, not leaked.
  expect(composerLoop.describe().isActive?.()).toBe(false)
})

test('boot() clears the gateway-liveness interval when boot fails AFTER it starts', async () => {
  // A registry whose `detail()` THROWS → `bootLine()` throws, failing boot at a
  // point AFTER the gateway-liveness interval has already been armed. The shared
  // failure cleanup must clear that interval (no leaked timer, no onGatewayTick
  // against torn-down resources). We hold the registry reference to inspect it.
  const sharedRegistry = new LoopRegistry()
  sharedRegistry.register({
    name: 'evil-throwing-detail',
    cadenceMs: 1_000,
    startedAt: 1,
    health: () => ({ lastTickAt: null, lastError: null }),
    detail: () => {
      throw new Error('boom in detail() — fails bootLine() AFTER liveness starts')
    },
  })

  const composer = async ({
    db,
    project_slug,
  }: {
    db: CompositionInput['db']
    project_slug: string
  }): Promise<CompositionInput> => ({
    db,
    project_slug,
    topic_handler: async () => undefined,
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
    // composeProductionGraph SUCCEEDS (no collision), so boot reaches the
    // liveness-start + bootLine(); bootLine() then throws on the evil detail().
    loop_registry: sharedRegistry,
  })

  let threw = false
  try {
    await boot({ composer, port: 0 })
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
  // gateway-liveness was register-before-started into the shared registry before
  // bootLine() threw; the shared failure cleanup cleared its interval.
  const liveness = sharedRegistry.get('gateway-liveness')
  expect(liveness, 'gateway-liveness should have been registered before bootLine() threw').toBeDefined()
  expect(liveness?.isActive?.()).toBe(false) // interval cleared — not leaked
})
