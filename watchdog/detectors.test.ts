import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { CronStateStore } from '@neutronai/cron/state.ts'
import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import {
  ProcessRegistry,
  pushAmbientProcessRegistry,
  registerLiveProcessSafe,
} from '@neutronai/tools/process-registry.ts'
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
    const detector = new HeartbeatDetector({ owner_slug: 't1', tracker, threshold_ms: 30_000, now: () => now })
    const alerts = await detector.detect()
    expect(alerts.length).toBe(1)
    expect(alerts[0]?.kind).toBe('gateway_heartbeat')
  })

  test('quiet when fresh', async () => {
    let now = 100_000
    const tracker: HeartbeatTracker = { lastHeartbeatAt: () => now - 1_000 }
    const detector = new HeartbeatDetector({ owner_slug: 't1', tracker, threshold_ms: 30_000, now: () => now })
    expect((await detector.detect()).length).toBe(0)
  })
})

describe('StuckAgentDetector', () => {
  test('fires for processes whose OUTSTANDING TURN is older than threshold', async () => {
    let now = 100_000
    const reg = new ProcessRegistry({ now: () => now })
    reg.register({ name: 'old', pid: 9_999_991, tool_name: 't' })
    reg.markTurnStarted('old', 9_999_991, 'inc:1')
    now += 20 * 60_000
    reg.register({ name: 'fresh', pid: 9_999_992, tool_name: 't' })
    reg.markTurnStarted('fresh', 9_999_992, 'inc:1')
    const detector = new StuckAgentDetector({
      owner_slug: 't1',
      process_registry: reg,
      inactivity_threshold_ms: 15 * 60_000,
      now: () => now,
    })
    const alerts = await detector.detect()
    expect(alerts.length).toBe(1)
    expect(alerts[0]?.payload['process_name']).toBe('old')
  })

  // REGRESSION (2026-07-18). Reproduces Ryan's live install exactly: two warm
  // per-topic chat REPLs, both ALIVE and HEALTHY (`ps` showed real `claude`
  // PTYs at 6h29m / 4h55m uptime), quiet only because he was not typing in
  // those topics. The old age-over-`last_activity_at` filter judged that
  // resting state "not progressing" and logged 26 `⚠️ Supervisor alert:
  // stuck_agent` messages on a fixed half-hourly cadence — forever, and worse
  // with every topic he used. Silence is a request/response REPL's NORMAL
  // state; only an outstanding turn can be stuck.
  test('an idle warm REPL with NO in-flight turn NEVER alerts, however long it has been quiet', async () => {
    let now = 100_000
    const reg = new ProcessRegistry({ now: () => now })
    reg.register({
      name: 'cc-agent-dev\0owner\0general\0anthropic:env_oauth',
      pid: 98_137,
      tool_name: 'cc-repl',
    })
    reg.register({
      name: 'cc-agent-dev\0owner\0buddhism\0anthropic:env_oauth',
      pid: 22_009,
      tool_name: 'cc-repl',
    })
    // Six and a half hours of no output — the real uptimes off Ryan's box.
    now += 6 * 60 * 60_000 + 29 * 60_000
    const detector = new StuckAgentDetector({
      owner_slug: 't1',
      process_registry: reg,
      inactivity_threshold_ms: 15 * 60_000,
      now: () => now,
    })
    expect(await detector.detect()).toEqual([])
    // Still silent an hour later, and on every subsequent tick.
    now += 60 * 60_000
    expect(await detector.detect()).toEqual([])
  })

  test('a SETTLED turn clears the marker — no alert afterwards even once the old turn-start ages out', async () => {
    let now = 100_000
    const reg = new ProcessRegistry({ now: () => now })
    reg.register({ name: 'repl', pid: 4_242, tool_name: 'cc-repl' })
    reg.markTurnStarted('repl', 4_242, 'inc:1')
    now += 60_000
    reg.markTurnSettled('repl', 4_242, 'inc:1')
    const detector = new StuckAgentDetector({
      owner_slug: 't1',
      process_registry: reg,
      inactivity_threshold_ms: 15 * 60_000,
      now: () => now,
    })
    // Well past the threshold measured from when that turn STARTED.
    now += 30 * 60_000
    expect(await detector.detect()).toEqual([])
  })

  test('a turn that is still outstanding past the threshold DOES alert — the real signal survives', async () => {
    let now = 100_000
    const reg = new ProcessRegistry({ now: () => now })
    reg.register({ name: 'repl', pid: 4_242, tool_name: 'cc-repl' })
    reg.markTurnStarted('repl', 4_242, 'inc:7')
    const detector = new StuckAgentDetector({
      owner_slug: 't1',
      process_registry: reg,
      inactivity_threshold_ms: 15 * 60_000,
      now: () => now,
    })
    now += 16 * 60_000
    const alerts = await detector.detect()
    expect(alerts.length).toBe(1)
    expect(alerts[0]?.payload['process_name']).toBe('repl')
    expect(alerts[0]?.payload['turn_id']).toBe('inc:7')
  })

  // The wedge that output-age detection MISSES: a turn that keeps emitting
  // output (a spinner, a retry loop) but never completes. Fresh
  // `last_activity_at` the whole time, so the old filter never fired.
  test('a chattering-but-never-completing turn alerts even though output is fresh', async () => {
    let now = 100_000
    const reg = new ProcessRegistry({ now: () => now })
    reg.register({ name: 'repl', pid: 4_242, tool_name: 'cc-repl' })
    reg.markTurnStarted('repl', 4_242, 'inc:1')
    const detector = new StuckAgentDetector({
      owner_slug: 't1',
      process_registry: reg,
      inactivity_threshold_ms: 15 * 60_000,
      now: () => now,
    })
    // Output every minute for 20 minutes; the turn never settles.
    for (let i = 0; i < 20; i++) {
      now += 60_000
      reg.touchIfPid('repl', 4_242)
    }
    expect((await detector.detect()).length).toBe(1)
  })

  test('a SUPERSEDED turn settling late cannot clear the successor marker', async () => {
    let now = 100_000
    const reg = new ProcessRegistry({ now: () => now })
    reg.register({ name: 'repl', pid: 4_242, tool_name: 'cc-repl' })
    reg.markTurnStarted('repl', 4_242, 'inc:1')
    // Turn 1 is cancelled; turn 2 starts and wedges.
    reg.markTurnStarted('repl', 4_242, 'inc:2')
    // Turn 1's driver only now unwinds and settles — it must NOT clear turn 2.
    expect(reg.markTurnSettled('repl', 4_242, 'inc:1')).toBe(false)
    const detector = new StuckAgentDetector({
      owner_slug: 't1',
      process_registry: reg,
      inactivity_threshold_ms: 15 * 60_000,
      now: () => now,
    })
    now += 16 * 60_000
    const alerts = await detector.detect()
    expect(alerts.length).toBe(1)
    expect(alerts[0]?.payload['turn_id']).toBe('inc:2')
  })

  // MIRROR-IMAGE LEAK. A turn that throws / times out / is cancelled must not
  // latch `busy_since` forever, or this bug returns inverted: permanent alerts
  // instead of permanent silence. The dispatch site settles in a `finally`, and
  // process DEATH drops the record wholesale via the child-exit paths.
  test('a turn that throws does not leave a permanently-busy record', async () => {
    let now = 100_000
    const reg = new ProcessRegistry({ now: () => now })
    reg.register({ name: 'repl', pid: 4_242, tool_name: 'cc-repl' })
    const handleTurn = async (turnId: string): Promise<void> => {
      reg.markTurnStarted('repl', 4_242, turnId)
      try {
        throw new Error('turn blew up mid-flight')
      } finally {
        reg.markTurnSettled('repl', 4_242, turnId)
      }
    }
    await expect(handleTurn('inc:1')).rejects.toThrow('turn blew up mid-flight')
    expect(reg.list()[0]?.busy_since).toBeNull()
    const detector = new StuckAgentDetector({
      owner_slug: 't1',
      process_registry: reg,
      inactivity_threshold_ms: 15 * 60_000,
      now: () => now,
    })
    now += 60 * 60_000
    expect(await detector.detect()).toEqual([])
  })

  test('a process that DIES mid-turn leaves no busy record behind (crash path drops it)', async () => {
    const reg = new ProcessRegistry()
    const dispose = pushAmbientProcessRegistry(reg)
    try {
      const handle = registerLiveProcessSafe({ name: 'repl', pid: 4_242, tool_name: 'cc-repl' })
      handle.markTurnStarted('inc:1')
      expect(reg.list()[0]?.busy_turn_id).toBe('inc:1')
      // The child-exit path: abnormal exit enqueues the crash and drops the
      // live record, so nothing stays busy.
      handle.markCrashed()
      expect(reg.list()).toEqual([])
      expect(reg.listStuck(-1)).toEqual([])
      // …and the crash is still reportable — crashed_agent is untouched.
      expect(reg.listPendingCrashes().map((r) => r.name)).toEqual(['repl'])
    } finally {
      dispose()
    }
  })
})

describe('CrashedAgentDetector', () => {
  test('fires for entries whose pid is not alive + reaps the registry', async () => {
    const reg = new ProcessRegistry()
    reg.register({ name: 'dead', pid: 9_999_991, tool_name: 't' })
    reg.register({ name: 'alive', pid: 9_999_992, tool_name: 't' })
    const probe: PidLivenessProbe = { isAlive: (pid) => pid === 9_999_992 }
    const detector = new CrashedAgentDetector({
      owner_slug: 't1',
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
      owner_slug: 't1',
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
      owner_slug: 't1',
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
      owner_slug: 't1',
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

  test('round-12: a fast RESPAWN before detect() does NOT erase the crash — pid 1 still reported once', async () => {
    const reg = new ProcessRegistry()
    const clear = pushAmbientProcessRegistry(reg)
    try {
      // Register pid 1 through the ambient handle (exactly as spawn.ts does), then
      // the exit handler enqueues its crash.
      const h1 = registerLiveProcessSafe({ name: 'session', pid: 1, tool_name: 'cc-repl' })
      h1.markCrashed()

      // A FAST respawn reuses the SAME session key with pid 2 BEFORE the 30 s tick —
      // the upsert (delete+register) overwrites the live slot. Pre-round-12 this
      // erased pid 1's crash; now the crash lives in the pending queue.
      registerLiveProcessSafe({ name: 'session', pid: 2, tool_name: 'cc-repl' })

      // pid 2 is alive; only the ENQUEUED pid-1 crash can fire (probe forced alive).
      const detector = new CrashedAgentDetector({
        owner_slug: 'owner',
        process_registry: reg,
        pid_probe: { isAlive: () => true },
      })
      const alerts = await detector.detect()
      expect(alerts.length).toBe(1)
      expect(alerts[0]?.payload['pid']).toBe(1) // pid 1's crash survived the respawn

      // Commit reaps the crash but leaves the live pid-2 child intact.
      detector.commit(alerts[0]!)
      expect(reg.list().find((r) => r.name === 'session')?.pid).toBe(2)
      expect(reg.listPendingCrashes().length).toBe(0)
      // Exactly once — no repeat.
      expect((await detector.detect()).length).toBe(0)
    } finally {
      clear()
    }
  })

  test('round-12 sweep: a CLEAN/intentional exit (unregister) does NOT enqueue a false crash', async () => {
    const reg = new ProcessRegistry()
    const clear = pushAmbientProcessRegistry(reg)
    try {
      const h = registerLiveProcessSafe({ name: 'session', pid: 1, tool_name: 'cc-repl' })
      // Clean exit / intentional kill routes to unregister(), NEVER markCrashed().
      h.unregister()
      expect(reg.listPendingCrashes().length).toBe(0)
      const detector = new CrashedAgentDetector({
        owner_slug: 'owner',
        process_registry: reg,
        pid_probe: { isAlive: () => true },
      })
      expect((await detector.detect()).length).toBe(0) // no false crash
    } finally {
      clear()
    }
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
      owner_slug: 't1',
      fired_at: 1000,
      duration_ms: 30_000,
      status: 'ok',
    })
    const detector = new OverrunCronDetector({ owner_slug: 't1', jobs, state })
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
    const detector = new OverrunCronDetector({ owner_slug: 't1', jobs, state })

    // Run A overruns → one alert; commit simulates the supervisor's delivery.
    await state.record({ job_name: 'slow-job', owner_slug: 't1', fired_at: 1000, duration_ms: 30_000, status: 'ok' })
    const a = await detector.detect()
    expect(a.length).toBe(1)
    for (const x of a) detector.commit(x)
    // Re-observing the SAME run A → suppressed (no storm).
    expect((await detector.detect()).length).toBe(0)

    // Run B (a DIFFERENT run of the same job) ALSO overruns → a NEW alert, not
    // swallowed by the still-open job-name incident (the round-1 over-correction).
    await state.record({ job_name: 'slow-job', owner_slug: 't1', fired_at: 2000, duration_ms: 40_000, status: 'ok' })
    const b = await detector.detect()
    expect(b.length).toBe(1)
    for (const x of b) detector.commit(x)
    // Re-observing run B → suppressed again.
    expect((await detector.detect()).length).toBe(0)
  })
})

describe('DbLockContentionDetector', () => {
  // AT-LEAST semantics (inclusive): fire when delta >= threshold. Boundary matrix
  // for threshold 5 — below (4) is quiet, EQUAL (5) fires, above (6) fires.
  function firesAtDelta(delta: number): Promise<boolean> {
    let now = 1_000
    let count = 0
    const counter: BusyRetryCounter = { exhaustionCount: () => count }
    const detector = new DbLockContentionDetector({
      owner_slug: 't1',
      counter,
      window_ms: 60_000,
      threshold_per_window: 5,
      now: () => now,
    })
    // sample 1 (count=0), then sample 2 a moment later at `delta`.
    return detector.detect().then(async () => {
      now += 1_000
      count = delta
      return (await detector.detect()).length === 1
    })
  }

  test('BELOW threshold (delta=4) — quiet', async () => {
    expect(await firesAtDelta(4)).toBe(false)
  })

  test('EQUAL to threshold (delta=5) — fires (inclusive)', async () => {
    expect(await firesAtDelta(5)).toBe(true)
  })

  test('ABOVE threshold (delta=6) — fires', async () => {
    expect(await firesAtDelta(6)).toBe(true)
  })

  test('round-10 startup: threshold-many exhaustions BEFORE the first tick fire on the first tick', async () => {
    let now = 0 // boot
    let count = 0
    const counter: BusyRetryCounter = { exhaustionCount: () => count }
    // Constructed at boot with counter 0 — the module composes here, seeding the
    // baseline. The supervisor would only call detect() 30 s later.
    const detector = new DbLockContentionDetector({
      owner_slug: 't1',
      counter,
      window_ms: 60_000,
      threshold_per_window: 5,
      now: () => now,
    })
    // 5 exhaustions accumulate DURING the boot→first-tick blind window.
    now = 30_000
    count = 5
    // The FIRST tick (30 s in) must SEE them — with the pre-fix self-baseline this
    // returned 0 (the blind spot). The construction baseline makes delta = 5 - 0.
    const alerts = await detector.detect()
    expect(alerts.length).toBe(1)
  })

  test('round-10: a LATE construction does NOT false-fire on historical backlog', async () => {
    let now = 3_600_000 // constructed an hour in
    let count = 1_000 // large historical exhaustion total already accrued
    const counter: BusyRetryCounter = { exhaustionCount: () => count }
    const detector = new DbLockContentionDetector({
      owner_slug: 't1',
      counter,
      window_ms: 60_000,
      threshold_per_window: 5,
      now: () => now,
    })
    // First tick shortly after construction, NO new exhaustions → delta ~0, quiet.
    now += 30_000
    expect((await detector.detect()).length).toBe(0)
    // Then 5 NEW exhaustions within the window → fires (measured from the baseline).
    now += 1_000
    count = 1_005
    expect((await detector.detect()).length).toBe(1)
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
      owner_slug: 't1',
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
      owner_slug: 't1',
      pool,
      substrate_kind: 'gpt-5-5-api',
      now: () => now,
    })
    const alerts = await detector.detect()
    expect(alerts.length).toBe(1)
    expect(alerts[0]?.payload['credential_count']).toBe(2)
  })
})
