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
} from './detectors.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-watchdog-detectors-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('HeartbeatDetector', () => {
  test('fires when last heartbeat is older than threshold', async () => {
    let now = 100_000
    const tracker: HeartbeatTracker = { lastHeartbeatAt: () => now - 60_000 }
    const detector = new HeartbeatDetector({ project_slug: 't1', tracker, threshold_ms: 30_000, now: () => now })
    const alerts = await detector.detect()
    expect(alerts.length).toBe(1)
    expect(alerts[0]?.kind).toBe('gateway_heartbeat')
  })

  test('quiet when fresh', async () => {
    let now = 100_000
    const tracker: HeartbeatTracker = { lastHeartbeatAt: () => now - 1_000 }
    const detector = new HeartbeatDetector({ project_slug: 't1', tracker, threshold_ms: 30_000, now: () => now })
    expect((await detector.detect()).length).toBe(0)
  })
})

describe('StuckAgentDetector', () => {
  test('fires for processes whose last activity is older than threshold', async () => {
    let now = 100_000
    const reg = new ProcessRegistry({ now: () => now })
    reg.register({ name: 'old', pid: 9_999_991, tool_name: 't' })
    now += 20 * 60_000
    reg.register({ name: 'fresh', pid: 9_999_992, tool_name: 't' })
    const detector = new StuckAgentDetector({
      project_slug: 't1',
      process_registry: reg,
      inactivity_threshold_ms: 15 * 60_000,
      now: () => now,
    })
    const alerts = await detector.detect()
    expect(alerts.length).toBe(1)
    expect(alerts[0]?.payload['process_name']).toBe('old')
  })
})

describe('CrashedAgentDetector', () => {
  test('fires for entries whose pid is not alive + reaps the registry', async () => {
    const reg = new ProcessRegistry()
    reg.register({ name: 'dead', pid: 9_999_991, tool_name: 't' })
    reg.register({ name: 'alive', pid: 9_999_992, tool_name: 't' })
    const probe: PidLivenessProbe = { isAlive: (pid) => pid === 9_999_992 }
    const detector = new CrashedAgentDetector({
      project_slug: 't1',
      process_registry: reg,
      pid_probe: probe,
    })
    const alerts = await detector.detect()
    expect(alerts.length).toBe(1)
    expect(alerts[0]?.payload['process_name']).toBe('dead')
    // detect() is PURE (round-4 sweep): the dead entry is NOT reaped until the
    // alert is committed-after-delivery. Both entries are still registered here.
    expect(reg.size()).toBe(2)
    // commit() (post-delivery) is what unregisters the dead pid.
    detector.commit(alerts[0]!)
    expect(reg.size()).toBe(1)
    expect(reg.list().some((r) => r.name === 'dead')).toBe(false)
  })

  test('round-4 commit-on-success: a flaky store DEFERS the reap — rediscovered next tick, unregistered only after delivery', async () => {
    const reg = new ProcessRegistry()
    reg.register({ name: 'dead', pid: 9_999_991, tool_name: 't' })
    const probe: PidLivenessProbe = { isAlive: () => false }
    const detector = new CrashedAgentDetector({
      project_slug: 't1',
      process_registry: reg,
      pid_probe: probe,
    })

    // Tick 1 — a candidate is raised, but the supervisor's persist/deliver FAILS,
    // so commit() is never called. The dead entry MUST still be registered so it
    // is re-observed next tick (no state mutated before delivery).
    const t1 = await detector.detect()
    expect(t1.length).toBe(1)
    // (supervisor's record()/notify() threw → NO commit)
    expect(reg.size()).toBe(1)

    // Tick 2 — the same dead entry is rediscovered (still un-latched), delivery
    // now succeeds → commit() reaps it exactly once.
    const t2 = await detector.detect()
    expect(t2.length).toBe(1)
    detector.commit(t2[0]!)
    expect(reg.size()).toBe(0)

    // Tick 3 — nothing left to observe.
    expect((await detector.detect()).length).toBe(0)
  })

  test('round-4 High-A: a RESPAWN under the same name (new pid) SURVIVES the stale commit', async () => {
    const reg = new ProcessRegistry()
    reg.register({ name: 'session', pid: 1, tool_name: 't' })
    // pid 1 is dead; the respawn's pid 2 is alive.
    const probe: PidLivenessProbe = { isAlive: (pid) => pid === 2 }
    const detector = new CrashedAgentDetector({
      project_slug: 't1',
      process_registry: reg,
      pid_probe: probe,
    })

    // detect() captures the dead pid 1 as a candidate (mutates nothing).
    const alerts = await detector.detect()
    expect(alerts.length).toBe(1)
    expect(alerts[0]?.payload['pid']).toBe(1)

    // A respawn REPLACES `session` with a NEW live pid 2 (upsert: same name, new
    // pid) BEFORE the crash alert's persist/deliver settles and commit() lands.
    reg.unregister('session')
    reg.register({ name: 'session', pid: 2, tool_name: 't' })

    // Commit the STALE pid-1 alert — the identity guard must leave the live pid-2
    // entry intact (a name-only unregister would erase the freshly-respawned child).
    detector.commit(alerts[0]!)
    expect(reg.size()).toBe(1)
    expect(reg.list().find((r) => r.name === 'session')?.pid).toBe(2)
  })

  test('round-6 High-1: a DEAD→DEAD respawn under the same name is REPORTED, not suppressed', async () => {
    const reg = new ProcessRegistry()
    reg.register({ name: 's', pid: 1, tool_name: 't' })
    // Both pid 1 and pid 2 are dead.
    const probe: PidLivenessProbe = { isAlive: () => false }
    const detector = new CrashedAgentDetector({
      project_slug: 't1',
      process_registry: reg,
      pid_probe: probe,
    })

    // Tick 1 — dead pid 1 is reported.
    const t1 = await detector.detect()
    expect(t1.length).toBe(1)
    expect(t1[0]?.payload['pid']).toBe(1)

    // A DEAD replacement under the same name (upsert: same name, new dead pid 2)
    // lands BEFORE the pid-1 alert commits.
    reg.unregister('s')
    reg.register({ name: 's', pid: 2, tool_name: 't' })

    // Commit the pid-1 alert — pid guard keeps pid 2 (it did not match).
    detector.commit(t1[0]!)
    expect(reg.list().find((r) => r.name === 's')?.pid).toBe(2)

    // Tick 2 — pid 2's death MUST surface (a distinct name+pid incident), not be
    // suppressed by pid 1's still-open name key. This is the High-1 regression.
    const t2 = await detector.detect()
    expect(t2.length).toBe(1)
    expect(t2[0]?.payload['pid']).toBe(2)

    // Commit pid 2 → reaped; tick 3 sees nothing.
    detector.commit(t2[0]!)
    expect(reg.size()).toBe(0)
    expect((await detector.detect()).length).toBe(0)
  })
})

describe('OverrunCronDetector', () => {
  test('fires when last_run_duration_ms > expected_duration_ms', async () => {
    const jobs = new CronJobRegistry()
    jobs.register({
      name: 'slow-job',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 60_000 },
      handler: 'h',
      expected_duration_ms: 5_000,
    })
    const state = new CronStateStore(db)
    await state.record({
      job_name: 'slow-job',
      project_slug: 't1',
      fired_at: 1000,
      duration_ms: 30_000,
      status: 'ok',
    })
    const detector = new OverrunCronDetector({ project_slug: 't1', jobs, state })
    const alerts = await detector.detect()
    expect(alerts.length).toBe(1)
    expect(alerts[0]?.payload['job_name']).toBe('slow-job')
  })

  test('Blocker-B: one alert per OVERRUNNING RUN — a second overrun is not swallowed', async () => {
    const jobs = new CronJobRegistry()
    jobs.register({
      name: 'slow-job',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 60_000 },
      handler: 'h',
      expected_duration_ms: 5_000,
    })
    const state = new CronStateStore(db)
    const detector = new OverrunCronDetector({ project_slug: 't1', jobs, state })

    // Run A overruns → one alert; commit simulates the supervisor's delivery.
    await state.record({ job_name: 'slow-job', project_slug: 't1', fired_at: 1000, duration_ms: 30_000, status: 'ok' })
    const a = await detector.detect()
    expect(a.length).toBe(1)
    for (const x of a) detector.commit(x)
    // Re-observing the SAME run A → suppressed (no storm).
    expect((await detector.detect()).length).toBe(0)

    // Run B (a DIFFERENT run of the same job) ALSO overruns → a NEW alert, not
    // swallowed by the still-open job-name incident (the round-1 over-correction).
    await state.record({ job_name: 'slow-job', project_slug: 't1', fired_at: 2000, duration_ms: 40_000, status: 'ok' })
    const b = await detector.detect()
    expect(b.length).toBe(1)
    for (const x of b) detector.commit(x)
    // Re-observing run B → suppressed again.
    expect((await detector.detect()).length).toBe(0)
  })
})

describe('DbLockContentionDetector', () => {
  test('fires when delta within window > threshold', async () => {
    let now = 1_000
    let count = 0
    const counter: BusyRetryCounter = { exhaustionCount: () => count }
    const detector = new DbLockContentionDetector({
      project_slug: 't1',
      counter,
      window_ms: 60_000,
      threshold_per_window: 3,
      now: () => now,
    })
    // sample 1 (count=0)
    expect((await detector.detect()).length).toBe(0)
    // sample 2 a moment later (count=5 → delta from oldest = 5)
    now += 1_000
    count = 5
    const alerts = await detector.detect()
    expect(alerts.length).toBe(1)
  })
})

describe('SubstrateCooldownDetector', () => {
  test('quiet when at least one credential is available', async () => {
    const pool = newCredentialPool({
      strategy: 'fill_first',
      credentials: [
        { id: 'a', kind: 'api_key', secret: 'sa' },
        { id: 'b', kind: 'api_key', secret: 'sb' },
      ],
    })
    const detector = new SubstrateCooldownDetector({
      project_slug: 't1',
      pool,
      substrate_kind: 'gpt-5-5-api',
    })
    expect((await detector.detect()).length).toBe(0)
  })

  test('fires when every credential is in cooldown', async () => {
    let now = 1_000_000
    const pool = newCredentialPool({
      strategy: 'fill_first',
      credentials: [
        { id: 'a', kind: 'api_key', secret: 'sa' },
        { id: 'b', kind: 'api_key', secret: 'sb' },
      ],
    })
    for (const c of pool.credentials) c.cooldown_until = now + 60_000
    const detector = new SubstrateCooldownDetector({
      project_slug: 't1',
      pool,
      substrate_kind: 'gpt-5-5-api',
      now: () => now,
    })
    const alerts = await detector.detect()
    expect(alerts.length).toBe(1)
    expect(alerts[0]?.payload['credential_count']).toBe(2)
  })
})
