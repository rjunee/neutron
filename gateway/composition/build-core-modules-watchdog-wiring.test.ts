/**
 * F4 — the watchdog module registers ALL SIX detectors + the process-registry
 * module publishes itself ambient. The anti-"built-but-not-wired" gate for the
 * supervision watchdog: it drives the REAL `buildCoreModules(...)` modules.
 *
 * Regressions this turns RED:
 *   - dropping any of the three newly-wired detectors (overrun_cron /
 *     db_lock_contention / substrate_cooldown_saturation) → detectorKinds ≠ 6.
 *   - not publishing the ProcessRegistry ambiently → a spawn-site
 *     `registerLiveProcessSafe` write never reaches the registry the stuck
 *     detector reads (stuck_agent never fires).
 *   - re-stubbing the notifier → the recording notifier never sees the alerts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import { registerLiveProcessSafe } from '@neutronai/tools/process-registry.ts'
import type { WatchdogAlert, WatchdogKind } from '@neutronai/watchdog/types.ts'
import type { PidLivenessProbe } from '@neutronai/watchdog/detectors.ts'

import { buildCoreModules } from './build-core-modules.ts'
import type { CompositionInput } from '../composition.ts'
import type { ModuleContext } from '../module-graph.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-watchdog-wiring-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const NOW = 10_000_000

function baseInput(overrides: Partial<CompositionInput> = {}): CompositionInput {
  return {
    db,
    project_slug: 'alice',
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
    ...overrides,
  }
}

describe('F4 — build-core-modules watchdog + process-registry wiring', () => {
  test('all SIX detectors are registered, publish ambient, and fire + notify', async () => {
    const fired: WatchdogAlert[] = []
    // Every credential cooling down → substrate_cooldown_saturation fires.
    const pool = newCredentialPool({
      strategy: 'fill_first',
      credentials: [{ id: 'a', kind: 'api_key', secret: 's' }],
    })
    // The module-built detectors use the real clock (no `now` injection), so
    // cooldown must be real-future for substrate_cooldown_saturation to fire.
    pool.credentials[0]!.cooldown_until = Date.now() + 60_000

    const deadProbe: PidLivenessProbe = { isAlive: () => false }

    const input = baseInput({
      // Stale heartbeat → gateway_heartbeat fires.
      heartbeat_tracker: { lastHeartbeatAt: () => NOW - 60_000 },
      // A pid that reports dead → crashed_agent fires (+ stuck_agent on the same
      // ancient-activity record).
      pid_probe: deadProbe,
      // All-cooldown pool → substrate_cooldown_saturation.
      watchdog_credential_pool: pool,
      watchdog_notifier: { notify: async (a) => { fired.push(a) } },
    })

    const mods = buildCoreModules(input)

    // Build a mini module graph: process-registry + cron init first, then the
    // watchdog module reads them by name.
    const processRegistry = await Promise.resolve(mods.processRegistryModule.init({} as ModuleContext))
    const cron = await Promise.resolve(mods.cronModule.init({} as ModuleContext))
    const ctx: ModuleContext = {
      graph: {
        get: ((name: string) =>
          name === 'process-registry' ? processRegistry : cron) as never,
        names: () => ['process-registry', 'cron'],
      },
      config: {},
    }

    // Seed a stuck+dead process THROUGH the ambient accessor — proving the
    // process-registry module published itself ambiently (spawn-site parity).
    registerLiveProcessSafe({ name: 'wedged', pid: 999_999, tool_name: 'cc-repl' })
    // Age its activity past the 15-min stuck threshold.
    processRegistry.list()[0]!.last_activity_at = NOW - 30 * 60_000

    // Seed an overrun cron row → overrun_cron fires.
    cron.jobs.register({
      name: 'slow-job',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 60_000 },
      handler: 'h',
      expected_duration_ms: 5_000,
    })
    await cron.state.record({
      job_name: 'slow-job',
      project_slug: 'alice',
      fired_at: NOW / 1000,
      duration_ms: 30_000,
      status: 'ok',
    })

    const wd = await mods.watchdogModule.init(ctx)
    try {
      // (1) ALL SIX detector kinds are registered (was 3 before F4).
      const kinds = wd.supervisor.detectorKinds().sort()
      const expectedKinds: WatchdogKind[] = [
        'gateway_heartbeat',
        'stuck_agent',
        'crashed_agent',
        'overrun_cron',
        'db_lock_contention',
        'substrate_cooldown_saturation',
      ].sort() as WatchdogKind[]
      expect(kinds).toEqual(expectedKinds)

      // (2) A live tick fires the five state-injectable modes (db_lock needs a
      //     real busy-retry exhaustion delta, exercised in six-modes) and the
      //     recording notifier sees every one.
      const out = await wd.supervisor.runOnce()
      const firedKinds = new Set(out.map((a) => a.kind))
      expect(firedKinds.has('gateway_heartbeat')).toBe(true)
      expect(firedKinds.has('stuck_agent')).toBe(true) // proves ambient publish reached the registry
      expect(firedKinds.has('crashed_agent')).toBe(true)
      expect(firedKinds.has('overrun_cron')).toBe(true)
      expect(firedKinds.has('substrate_cooldown_saturation')).toBe(true)
      // The notifier (not the no-op stub) received them.
      expect(fired.length).toBe(out.length)
      expect(fired.length).toBeGreaterThanOrEqual(5)
    } finally {
      mods.watchdogModule.shutdown?.(wd)
      mods.processRegistryModule.shutdown?.(processRegistry)
      await mods.cronModule.shutdown?.(cron)
    }
  })
})
