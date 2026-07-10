import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import {
  ProjectDb,
  registerSystemEventSink,
  type SystemEventInput,
  type SystemEventSink,
} from '@neutronai/persistence/index.ts'
import { CronJobRegistry, validateJobName } from './jobs.ts'
import { CronHandlerRegistry } from './handlers.ts'
import { CronScheduler } from './scheduler.ts'
import { CronStateStore } from './state.ts'
import { wallClockToEpoch } from './calendar.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-cron-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('validateJobName', () => {
  test('accepts ASCII alnum + dash', () => {
    expect(() => validateJobName('vault-backup')).not.toThrow()
    expect(() => validateJobName('a')).not.toThrow()
  })

  test('rejects uppercase + special chars + leading dash + leading digit', () => {
    expect(() => validateJobName('VaultBackup')).toThrow()
    expect(() => validateJobName('vault.backup')).toThrow()
    expect(() => validateJobName('-x')).toThrow()
    expect(() => validateJobName('1job')).toThrow()
  })
})

describe('CronJobRegistry', () => {
  test('register + list', () => {
    const reg = new CronJobRegistry()
    reg.register({
      name: 'a',
      description: 'a',
      schedule: { kind: 'interval_ms', interval_ms: 1000 },
      handler: 'a',
    })
    reg.register({
      name: 'b',
      description: 'b',
      schedule: { kind: 'interval_ms', interval_ms: 2000 },
      handler: 'b',
    })
    expect(reg.list().map((j) => j.name)).toEqual(['a', 'b'])
  })

  test('duplicate registration throws', () => {
    const reg = new CronJobRegistry()
    const def = {
      name: 'a',
      description: 'a',
      schedule: { kind: 'interval_ms' as const, interval_ms: 1000 },
      handler: 'a',
    }
    reg.register(def)
    expect(() => reg.register(def)).toThrow(/already registered/)
  })
})

describe('CronScheduler.fireOnce', () => {
  test('runs handler + records state', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    jobs.register({
      name: 'vault-backup',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 1000 },
      handler: 'vault_backup',
    })
    handlers.register('vault_backup', async () => ({ status: 'ok', detail: 'done' }))
    let now = 1_000_000
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 't1',
      now: () => now,
    })
    const result = await scheduler.fireOnce('vault-backup')
    expect(result.status).toBe('ok')
    const state = new CronStateStore(db).get('vault-backup', 't1')
    expect(state?.last_run_status).toBe('ok')
    expect(state?.last_run_at).toBe(1_000)
  })

  test('handler throw → status=error + error captured in state', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    jobs.register({
      name: 'a',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 1000 },
      handler: 'h',
    })
    handlers.register('h', async () => { throw new Error('boom') })
    const scheduler = new CronScheduler({ jobs, handlers, db, project_slug: 't1' })
    const result = await scheduler.fireOnce('a')
    expect(result.status).toBe('error')
    expect(result.detail).toBe('boom')
    const state = new CronStateStore(db).get('a', 't1')
    expect(state?.last_run_error).toBe('boom')
  })

  test('unknown job → error', async () => {
    const scheduler = new CronScheduler({
      jobs: new CronJobRegistry(),
      handlers: new CronHandlerRegistry(),
      db,
      project_slug: 't1',
    })
    const result = await scheduler.fireOnce('nope')
    expect(result.status).toBe('error')
    expect(result.detail).toMatch(/unknown job/)
  })
})

describe('O4 — cron_job_error degrade journal (rising edge)', () => {
  // Synchronous in-memory sink: emitSystemEventSafe calls record() synchronously
  // inside the (voided) emit, so rows land before fireOnce's await chain resolves.
  function fakeSink(): { rows: SystemEventInput[]; sink: SystemEventSink } {
    const rows: SystemEventInput[] = []
    return {
      rows,
      sink: {
        record(input: SystemEventInput) {
          rows.push(input)
          return { id: String(rows.length) }
        },
      },
    }
  }

  afterEach(() => registerSystemEventSink(null))

  function flakyScheduler(): { scheduler: CronScheduler; setMode: (m: 'fail' | 'ok') => void } {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    jobs.register({
      name: 'flaky',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 1000 },
      handler: 'h',
    })
    let mode: 'fail' | 'ok' = 'fail'
    handlers.register('h', async () => {
      if (mode === 'fail') throw new Error('handler boom')
      return { status: 'ok' as const }
    })
    return {
      scheduler: new CronScheduler({ jobs, handlers, db, project_slug: 't1' }),
      setMode: (m) => {
        mode = m
      },
    }
  }

  test('fires exactly ONE row on the healthy→error edge, NOT on every failing poll', async () => {
    const { rows, sink } = fakeSink()
    registerSystemEventSink(sink)
    const { scheduler } = flakyScheduler()
    await scheduler.fireOnce('flaky') // healthy→error: emit
    await scheduler.fireOnce('flaky') // error→error: NO emit (rising-edge dedup)
    await scheduler.fireOnce('flaky') // error→error: NO emit
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ event: 'cron_job_error', module: 'cron', project_slug: 't1' })
    expect(rows[0]?.payload).toMatchObject({ job_name: 'flaky', error: 'handler boom' })
  })

  test('re-fires after recovery (error→ok→error is a fresh rising edge)', async () => {
    const { rows, sink } = fakeSink()
    registerSystemEventSink(sink)
    const { scheduler, setMode } = flakyScheduler()
    await scheduler.fireOnce('flaky') // →error: emit #1
    setMode('ok')
    await scheduler.fireOnce('flaky') // →ok: no emit, clears the edge
    setMode('fail')
    await scheduler.fireOnce('flaky') // →error again: emit #2
    expect(rows).toHaveLength(2)
  })

  test('healthy job never emits; a write-throwing sink does NOT break the fire', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    jobs.register({
      name: 'good',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 1000 },
      handler: 'h',
    })
    handlers.register('h', async () => ({ status: 'ok' as const }))
    // Healthy path: no sink interaction at all.
    let recorded = 0
    registerSystemEventSink({
      record() {
        recorded++
        return { id: 'x' }
      },
    })
    const okScheduler = new CronScheduler({ jobs, handlers, db, project_slug: 't1' })
    const okResult = await okScheduler.fireOnce('good')
    expect(okResult.status).toBe('ok')
    expect(recorded).toBe(0)

    // Degrade path with a THROWING sink: the fire still completes + records state.
    const jobs2 = new CronJobRegistry()
    const handlers2 = new CronHandlerRegistry()
    jobs2.register({
      name: 'bad',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 1000 },
      handler: 'h2',
    })
    handlers2.register('h2', async () => {
      throw new Error('degrade boom')
    })
    registerSystemEventSink({
      record() {
        throw new Error('journal write failed')
      },
    })
    const badScheduler = new CronScheduler({ jobs: jobs2, handlers: handlers2, db, project_slug: 't1' })
    const badResult = await badScheduler.fireOnce('bad')
    expect(badResult.status).toBe('error')
    expect(badResult.detail).toBe('degrade boom')
    const state = new CronStateStore(db).get('bad', 't1')
    expect(state?.last_run_status).toBe('error')
  })
})

describe('CronScheduler.stop — §F1 quiescing shutdown', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  test('stop() awaits an in-flight fire before resolving (quiesce)', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    jobs.register({
      name: 'slow',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 5 },
      handler: 'h-slow',
    })
    let entered = false
    let finished = false
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    handlers.register('h-slow', async () => {
      entered = true
      await gate
      finished = true
      return { status: 'ok' }
    })
    const scheduler = new CronScheduler({ jobs, handlers, db, project_slug: 't1' })
    scheduler.start()
    // Wait for the interval to fire and the handler to block on the gate.
    for (let i = 0; i < 100 && !entered; i++) await sleep(2)
    expect(entered).toBe(true)

    let stopped = false
    const stopP = scheduler.stop().then(() => {
      stopped = true
    })
    // The synchronous teardown already ran (no more jobs ticking)...
    expect(scheduler.runningCount()).toBe(0)
    // ...but stop() must NOT resolve while the fire is still in flight.
    await sleep(15)
    expect(stopped).toBe(false)
    expect(finished).toBe(false)

    release()
    await stopP
    expect(stopped).toBe(true)
    expect(finished).toBe(true)
  })

  test('stop() quiesces a fire started directly via the public fireOnce()', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    jobs.register({
      name: 'manual',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 999_999 },
      handler: 'h-manual',
    })
    let entered = false
    let finished = false
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    handlers.register('h-manual', async () => {
      entered = true
      await gate
      finished = true
      return { status: 'ok' }
    })
    const scheduler = new CronScheduler({ jobs, handlers, db, project_slug: 't1' })
    // Manual operator trigger — drive fireOnce() DIRECTLY (no start()/timer).
    const fireP = scheduler.fireOnce('manual')
    for (let i = 0; i < 100 && !entered; i++) await sleep(2)
    expect(entered).toBe(true)

    let stopped = false
    const stopP = scheduler.stop().then(() => {
      stopped = true
    })
    await sleep(15)
    // stop() must await the in-flight manual fire, not just timer-driven ones.
    expect(stopped).toBe(false)
    expect(finished).toBe(false)

    release()
    await stopP
    await fireP
    expect(stopped).toBe(true)
    expect(finished).toBe(true)
  })
})

describe('CronScheduler.start — runtime registrations (S15 Codex r1 P1)', () => {
  // Backstop for the Codex review on PR #126. Pre-fix the scheduler
  // snapshotted the job registry exactly once in `start()`, so jobs
  // registered AFTER start (notably `wow-overnight-<slug>` from
  // onboarding/wow-moment/actions/07-overnight-pass.ts, which runs at
  // wow-moment dispatch time — long after boot) never bound a timer.
  // The registry now notifies subscribers on `register(...)` and the
  // scheduler subscribes in its constructor so post-start registrations
  // auto-bind via the shared `bindJob` path.
  test('job registered AFTER start() still fires via the autonomous tick', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    let calls = 0
    handlers.register('h-runtime', async () => {
      calls += 1
      return { status: 'ok' }
    })

    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 't-runtime',
    })
    // start() FIRST — snapshot the (empty) registry.
    scheduler.start()
    // Register a job AFTER start. Pre-S15-Codex this would have been
    // invisible to the setInterval mesh.
    jobs.register({
      name: 'late-job',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 50 },
      handler: 'h-runtime',
    })
    // Wait for the autonomous tick to fire at least once.
    await new Promise((resolve) => setTimeout(resolve, 150))
    scheduler.stop()
    // The late-bound timer fired without any manual fireOnce.
    expect(calls).toBeGreaterThan(0)
    const state = new CronStateStore(db).get('late-job', 't-runtime')
    expect(state).not.toBeNull()
    expect(state!.last_run_status).toBe('ok')
  })

  test('job registered BEFORE start() is bound exactly once (no double-tick)', async () => {
    // Guards against the listener firing AND the boot iteration both
    // binding the same job (which would silently double-tick at the
    // configured cadence).
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    let calls = 0
    handlers.register('h-pre', async () => {
      calls += 1
      return { status: 'ok' }
    })
    jobs.register({
      name: 'pre-job',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 50 },
      handler: 'h-pre',
    })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 't-pre',
    })
    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 130))
    scheduler.stop()
    // 130 ms / 50 ms = 2 ticks. If the job were double-bound we'd see
    // ~4 calls. Allow some scheduler jitter on slow CI — the assertion
    // is "no doubling" so cap at 3.
    expect(calls).toBeGreaterThan(0)
    expect(calls).toBeLessThanOrEqual(3)
  })

  test('stop() → start() cycle re-binds every job (started flag resets)', async () => {
    // The `stop()` path needs to reset `started` so a re-`start()` can
    // walk the registry again. Without the reset, post-stop registrations
    // would still bind via the listener, but the originally registered
    // job's timer would stay torn down with no re-bind path.
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    let calls = 0
    handlers.register('h-cycle', async () => {
      calls += 1
      return { status: 'ok' }
    })
    jobs.register({
      name: 'cycle-job',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 50 },
      handler: 'h-cycle',
    })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 't-cycle',
    })
    scheduler.start()
    scheduler.stop()
    // After a stop, no ticks should land.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const calls_after_stop = calls
    // Re-start must rebind.
    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 150))
    scheduler.stop()
    expect(calls).toBeGreaterThan(calls_after_stop)
  })
})

describe('CronScheduler — calendar / wall-clock schedules (T2)', () => {
  const UTC = 'UTC'
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  test('missed-fire catch-up: fires once on a missed instant + records cron_state', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    let calls = 0
    handlers.register('cal-h', async () => {
      calls += 1
      return { status: 'ok' }
    })
    jobs.register({
      name: 'daily-nine',
      description: '',
      schedule: { kind: 'oncalendar', expression: '*-*-* 09:00:00' },
      handler: 'cal-h',
    })
    // "Now" is 10:00 — past today's 09:00 — and no prior run exists, so the
    // most-recent scheduled instant was missed → catch up exactly once.
    const now = wallClockToEpoch(2026, 6, 7, 10, 0, 0, UTC)
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 't-cal',
      now: () => now,
      timeZone: UTC,
    })
    scheduler.start()
    await sleep(40)
    scheduler.stop()
    expect(calls).toBe(1)
    const state = new CronStateStore(db).get('daily-nine', 't-cal')
    expect(state).not.toBeNull()
    expect(state!.last_run_status).toBe('ok')
    expect(state!.last_run_at).toBe(now / 1000)
  })

  test('no catch-up when the last run already covers the most-recent instant', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    let calls = 0
    handlers.register('cal-h2', async () => {
      calls += 1
      return { status: 'ok' }
    })
    jobs.register({
      name: 'daily-nine-2',
      description: '',
      schedule: { kind: 'oncalendar', expression: '*-*-* 09:00:00' },
      handler: 'cal-h2',
    })
    const now = wallClockToEpoch(2026, 6, 7, 10, 0, 0, UTC)
    // Pre-seed a run AT 09:30 today — newer than today's 09:00 scheduled
    // instant, so there is nothing to catch up.
    await new CronStateStore(db).record({
      job_name: 'daily-nine-2',
      project_slug: 't-cal2',
      fired_at: wallClockToEpoch(2026, 6, 7, 9, 30, 0, UTC) / 1000,
      duration_ms: 1,
      status: 'ok',
    })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 't-cal2',
      now: () => now,
      timeZone: UTC,
    })
    scheduler.start()
    await sleep(40)
    // Armed for the NEXT occurrence, but did not fire now.
    expect(calls).toBe(0)
    expect(scheduler.runningJobNames()).toContain('daily-nine-2')
    scheduler.stop()
  })

  test('fires via setTimeout at the scheduled instant and re-arms for the next occurrence', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    const scheduled = wallClockToEpoch(2026, 6, 7, 9, 0, 0, UTC)
    // Start the clock 80 ms BEFORE the scheduled instant so the real
    // setTimeout delay is tiny. The handler advances the clock past the
    // instant so the re-arm computes tomorrow's fire (no repeat-fire loop).
    let now = scheduled - 80
    let calls = 0
    handlers.register('cal-h3', async () => {
      calls += 1
      now = scheduled + 30
      return { status: 'ok' }
    })
    jobs.register({
      name: 'daily-nine-3',
      description: '',
      schedule: { kind: 'oncalendar', expression: '*-*-* 09:00:00' },
      handler: 'cal-h3',
    })
    // Suppress catch-up: record a run just before "now".
    await new CronStateStore(db).record({
      job_name: 'daily-nine-3',
      project_slug: 't-cal3',
      fired_at: (scheduled - 1000) / 1000,
      duration_ms: 1,
      status: 'ok',
    })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 't-cal3',
      now: () => now,
      timeZone: UTC,
    })
    scheduler.start()
    await sleep(250)
    // Fired exactly once at the instant, then re-armed for the next day.
    expect(calls).toBe(1)
    expect(scheduler.runningJobNames()).toContain('daily-nine-3')
    const state = new CronStateStore(db).get('daily-nine-3', 't-cal3')
    expect(state!.last_run_status).toBe('ok')
    scheduler.stop()
  })

  test('chunked (long-gap) timer catches up a target missed mid-chunk (sleep across a monthly wait)', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    let calls = 0
    handlers.register('cal-chunk', async () => {
      calls += 1
      return { status: 'ok' }
    })
    jobs.register({
      name: 'daily-chunk',
      description: '',
      schedule: { kind: 'oncalendar', expression: '*-*-* 09:00:00' },
      handler: 'cal-chunk',
    })
    const scheduled = wallClockToEpoch(2026, 6, 7, 9, 0, 0, UTC)
    const DAY = 86_400_000
    // Clock starts before the target; maxTimerDelayMs=40 forces the wait to be
    // chunked (delay 250ms > 40ms ceiling) — same code path a real monthly
    // (>24.8d) wait takes. Suppress the initial catch-up.
    let now = scheduled - 250
    await new CronStateStore(db).record({
      job_name: 'daily-chunk',
      project_slug: 't-chunk',
      fired_at: (scheduled - 1000) / 1000,
      duration_ms: 1,
      status: 'ok',
    })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 't-chunk',
      now: () => now,
      timeZone: UTC,
      maxTimerDelayMs: 40,
    })
    scheduler.start()
    // Let a couple of chunk wakes pass with the clock still before target.
    await sleep(100)
    expect(calls).toBe(0)
    // Simulate the machine sleeping ACROSS the target during a chunk wait.
    now = scheduled + 5_000
    // Next chunk wake re-evaluates via armCalendar → catch-up fires the miss.
    await sleep(120)
    expect(calls).toBe(1)
    expect(scheduler.nextScheduledMs('daily-chunk')).toBe(scheduled + DAY)
    scheduler.stop()
  })

  test('multi-period gap catches up exactly ONCE (no burst-replay after a long sleep)', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    let calls = 0
    handlers.register('cal-burst', async () => {
      calls += 1
      return { status: 'ok' }
    })
    jobs.register({
      name: 'daily-burst',
      description: '',
      schedule: { kind: 'oncalendar', expression: '*-*-* 09:00:00' },
      handler: 'cal-burst',
    })
    const DAY = 86_400_000
    // Last run was 4 days ago; "now" is well past 4 missed 09:00 instants. A
    // burst-replay would fire ~4 times — Persistent=true semantics fire ONCE.
    await new CronStateStore(db).record({
      job_name: 'daily-burst',
      project_slug: 't-burst',
      fired_at: wallClockToEpoch(2026, 6, 3, 9, 0, 0, UTC) / 1000,
      duration_ms: 1,
      status: 'ok',
    })
    const now = wallClockToEpoch(2026, 6, 7, 10, 0, 0, UTC)
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 't-burst',
      now: () => now,
      timeZone: UTC,
    })
    scheduler.start()
    await sleep(60)
    expect(calls).toBe(1)
    // Re-armed for the next FUTURE instant (tomorrow 09:00), not a 0ms replay.
    expect(scheduler.nextScheduledMs('daily-burst')).toBe(wallClockToEpoch(2026, 6, 8, 9, 0, 0, UTC))
    scheduler.stop()
  })

  test('schedule advances on its own cadence (slow handler does not shift the next tick)', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    const scheduled = wallClockToEpoch(2026, 6, 7, 9, 0, 0, UTC)
    const DAY = 86_400_000
    let now = scheduled - 40
    let calls = 0
    // Simulate a handler that runs LONGER than one full period (advances the
    // clock past the next instant). The next-fire must still be computed from
    // the just-fired SCHEDULED instant (scheduled + 1 day), NOT from the
    // handler's completion time (which would be scheduled + 2 days = a dropped
    // occurrence — the bug Codex r2 flagged).
    handlers.register('cal-slow', async () => {
      calls += 1
      now = scheduled + DAY + 5_000
      return { status: 'ok' }
    })
    jobs.register({
      name: 'daily-slow',
      description: '',
      schedule: { kind: 'oncalendar', expression: '*-*-* 09:00:00' },
      handler: 'cal-slow',
    })
    await new CronStateStore(db).record({
      job_name: 'daily-slow',
      project_slug: 't-slow',
      fired_at: (scheduled - 1000) / 1000,
      duration_ms: 1,
      status: 'ok',
    })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 't-slow',
      now: () => now,
      timeZone: UTC,
    })
    scheduler.start()
    await sleep(180)
    expect(calls).toBe(1)
    // Next tick is the day AFTER the fired instant — not two days out.
    expect(scheduler.nextScheduledMs('daily-slow')).toBe(scheduled + DAY)
    scheduler.stop()
  })

  test('interval + calendar jobs both bind; unparseable calendar grammar is skipped', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    handlers.register('h-mix', async () => ({ status: 'ok' }))
    jobs.register({
      name: 'interval-job',
      description: '',
      schedule: { kind: 'interval_ms', interval_ms: 60_000 },
      handler: 'h-mix',
    })
    jobs.register({
      name: 'calendar-job',
      description: '',
      schedule: { kind: 'oncalendar', expression: 'daily' },
      handler: 'h-mix',
    })
    jobs.register({
      name: 'bad-calendar-job',
      description: '',
      schedule: { kind: 'oncalendar', expression: 'yearly' }, // out of subset
      handler: 'h-mix',
    })
    const now = wallClockToEpoch(2026, 6, 7, 9, 30, 0, UTC)
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 't-mix',
      now: () => now,
      timeZone: UTC,
    })
    // Seed a recent run for the calendar job so the bind doesn't catch-up-fire.
    // Awaited: ProjectDb.run() is mutex-queued, so an unawaited seed could land
    // AFTER start() reads cron_state and spuriously trigger the catch-up path.
    await new CronStateStore(db).record({
      job_name: 'calendar-job',
      project_slug: 't-mix',
      fired_at: now / 1000,
      duration_ms: 1,
      status: 'ok',
    })
    scheduler.start()
    const names = scheduler.runningJobNames()
    expect(names).toContain('interval-job')
    expect(names).toContain('calendar-job')
    expect(names).not.toContain('bad-calendar-job')
    scheduler.stop()
  })

  test('idempotent start()/stop() with a calendar job (catch-up fires once, not per start)', async () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    let calls = 0
    handlers.register('cal-h4', async () => {
      calls += 1
      return { status: 'ok' }
    })
    jobs.register({
      name: 'daily-nine-4',
      description: '',
      schedule: { kind: 'oncalendar', expression: '*-*-* 09:00:00' },
      handler: 'cal-h4',
    })
    const now = wallClockToEpoch(2026, 6, 7, 10, 0, 0, UTC)
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 't-cal4',
      now: () => now,
      timeZone: UTC,
    })
    scheduler.start()
    scheduler.start() // idempotent — already-bound job is left alone
    await sleep(40)
    expect(calls).toBe(1)
    scheduler.stop()
    expect(scheduler.runningCount()).toBe(0)
  })
})
