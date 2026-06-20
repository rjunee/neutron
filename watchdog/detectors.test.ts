import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import { CronJobRegistry } from '../cron/jobs.ts'
import { CronStateStore } from '../cron/state.ts'
import { newCredentialPool } from '../runtime/credential-pool.ts'
import { ProcessRegistry } from '../tools/process-registry.ts'
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
    expect(reg.size()).toBe(1)
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
