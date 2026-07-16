/**
 * tests/integration — six watchdog modes.
 *
 * Per the P1 platform base plan in docs/plans § 5 success criterion #4. Each of
 * the 6 logical watchdog modes is synthesised + verified to fire + persist
 * + dispatch through the supervisor.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { CronStateStore } from '@neutronai/cron/state.ts'
import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import { ProcessRegistry } from '@neutronai/tools/process-registry.ts'
import { AlertStore } from '@neutronai/watchdog/alert-store.ts'
import {
  CrashedAgentDetector,
  DbLockContentionDetector,
  HeartbeatDetector,
  OverrunCronDetector,
  StuckAgentDetector,
  SubstrateCooldownDetector,
  type BusyRetryCounter,
  type HeartbeatTracker,
  type PidLivenessProbe,
} from '@neutronai/watchdog/detectors.ts'
import { WatchdogSupervisor } from '@neutronai/watchdog/supervisor.ts'
import type { WatchdogAlert, WatchdogKind } from '@neutronai/watchdog/types.ts'

let tmp: string
let db: ProjectDb
let alertStore: AlertStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-watchdog-six-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  alertStore = new AlertStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const recordingNotifier = (): { fired: WatchdogAlert[]; notify: (a: WatchdogAlert) => Promise<void> } => {
  const fired: WatchdogAlert[] = []
  return { fired, notify: async (a) => { fired.push(a) } }
}

describe('watchdog six modes — supervisor wires every detector + persists + notifies', () => {
  test('all six fire + persist + notify in a single tick', async () => {
    const owner = 't1'
    const now = 10_000_000
    const nowFn = () => now

    // 1. heartbeat: tracker reports an OLD heartbeat
    const tracker: HeartbeatTracker = { lastHeartbeatAt: () => now - 60_000 }
    const heartbeat = new HeartbeatDetector({
      owner_slug: owner,
      tracker,
      threshold_ms: 30_000,
      now: nowFn,
    })

    // 2. stuck_agent: registered process whose last_activity_at is ancient
    const procReg = new ProcessRegistry({ now: nowFn })
    procReg.register({ name: 'old', pid: 9_999_991, tool_name: 't' })
    // re-mutate the just-registered record so its activity is older than the threshold
    procReg.list()[0]!.last_activity_at = now - 30 * 60_000
    const stuck = new StuckAgentDetector({
      owner_slug: owner,
      process_registry: procReg,
      inactivity_threshold_ms: 15 * 60_000,
      now: nowFn,
    })

    // 3. crashed_agent: process whose pid is reported dead by the probe
    const procReg2 = new ProcessRegistry({ now: nowFn })
    procReg2.register({ name: 'dead', pid: 9_999_991, tool_name: 't' })
    const probe: PidLivenessProbe = { isAlive: () => false }
    const crashed = new CrashedAgentDetector({
      owner_slug: owner,
      process_registry: procReg2,
      pid_probe: probe,
    })

    // 4. overrun_cron: cron_state row whose last_run_duration_ms exceeds expected
    const jobs = new CronJobRegistry()
    jobs.register({
      name: 'long-running',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 60_000 },
      handler: 'h',
      expected_duration_ms: 5_000,
    })
    const state = new CronStateStore(db)
    await state.record({
      job_name: 'long-running',
      owner_slug: owner,
      fired_at: now / 1000,
      duration_ms: 30_000,
      status: 'ok',
    })
    const overrun = new OverrunCronDetector({ owner_slug: owner, jobs, state })

    // 5. db_lock_contention: counter delta exceeds threshold within window
    let exhaustionCount = 0
    const counter: BusyRetryCounter = { exhaustionCount: () => exhaustionCount }
    let dbLockNow = now
    const dbLock = new DbLockContentionDetector({
      owner_slug: owner,
      counter,
      window_ms: 60_000,
      threshold_per_window: 3,
      now: () => dbLockNow,
    })

    // 6. substrate_cooldown_saturation: every credential cold
    const pool = newCredentialPool({
      strategy: 'fill_first',
      credentials: [{ id: 'a', kind: 'api_key', secret: 's' }],
    })
    pool.credentials[0]!.cooldown_until = now + 60_000
    const sat = new SubstrateCooldownDetector({
      owner_slug: owner,
      pool,
      substrate_kind: 'gpt-5-5-api',
      now: nowFn,
    })

    const notifier = recordingNotifier()
    const supervisor = new WatchdogSupervisor({
      store: alertStore,
      notifier,
      detectors: [heartbeat, stuck, crashed, overrun, sat],
    })

    // Prime db_lock detector's window — first sample is the baseline
    await dbLock.detect()
    // Bump the count so the next sample shows a delta of 5
    exhaustionCount = 5
    dbLockNow = now + 1_000
    supervisor.registerDetector(dbLock)

    const fired = await supervisor.runOnce()
    const kinds = fired.map((a) => a.kind).sort()
    const expected: WatchdogKind[] = [
      'gateway_heartbeat',
      'stuck_agent',
      'crashed_agent',
      'overrun_cron',
      'substrate_cooldown_saturation',
      'db_lock_contention',
    ].sort() as WatchdogKind[]
    expect(kinds).toEqual(expected)
    // Persisted to the ledger
    const open = alertStore.listOpen(owner)
    expect(open.length).toBe(6)
    // Notifier saw all 6
    expect(notifier.fired.length).toBe(6)
  })
})
