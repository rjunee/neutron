/**
 * @neutronai/cron — in-process scheduler.
 *
 * THIS scheduler is the Open
 * base — it works on ANY OS and is the default driver (dev + Open self-host on
 * a Mac or any non-systemd platform). On Managed/Linux, systemd `.timer` +
 * `.service` pairs emitted by `timer-emit.ts` drive the SAME `CronJobDef`s as a
 * VPS optimization. Both paths share the same `CronJobRegistry` +
 * `CronHandlerRegistry`.
 *
 * Scheduling is COMPLETE for both schedule kinds (T2, 2026-06-07):
 *   - `interval_ms` jobs tick on a `setInterval` (UNCHANGED behavior).
 *   - `oncalendar` jobs compute the next wall-clock instant via `calendar.ts`
 *     and arm a `setTimeout`, re-arming after each fire. Calendar grammar is
 *     the documented daily/weekly/monthly subset (see `calendar.ts`); an
 *     expression outside the subset warns + skips (the Managed systemd path
 *     handles full grammar). On (re)arm a missed-fire catch-up fires once if
 *     the most-recent scheduled instant is newer than the last recorded run
 *     (systemd `Persistent=true` spirit — covers a Mac that slept past a
 *     scheduled time, or a process restart after a miss).
 *
 * Wall-clock math runs in an explicit IANA `timeZone` (defaults to the host
 * zone via `hostTimeZone()`); DST boundaries are handled by `calendar.ts`.
 *
 * Per-job state (last fire timestamp + duration + status) lands in
 * `cron_state` via the supplied `CronStateStore`.
 */

import { guardedFire } from '@neutronai/loop'
import { emitSystemEvent } from '@neutronai/persistence/index.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  hostTimeZone,
  nextFireAfter,
  parseOnCalendar,
  previousFireAtOrBefore,
  type CalendarSpec,
} from './calendar.ts'
import type { CronHandlerRegistry, CronHandlerStatus } from './handlers.ts'
import type { CronJobDef, CronJobRegistry } from './jobs.ts'
import { CronStateStore } from './state.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

/** setTimeout's max delay (2^31-1 ms ≈ 24.8 days); longer waits are chunked. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface SchedulerOptions {
  jobs: CronJobRegistry
  handlers: CronHandlerRegistry
  db: ProjectDb
  project_slug: string
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number
  /**
   * IANA timezone for wall-clock (`oncalendar`) schedules. Defaults to the
   * host zone. Managed threads the per-instance timezone here so "daily 09:00"
   * means 09:00 in the owner's locale, not the box's.
   */
  timeZone?: string
  /**
   * Max single setTimeout delay (ms) before a calendar wait is chunked.
   * Defaults to setTimeout's 2^31-1 ceiling; tests lower it to exercise the
   * chunk-and-rearm path without real multi-day waits.
   */
  maxTimerDelayMs?: number
}

interface RunningJob {
  /** Interval jobs hold a setInterval handle; calendar jobs a setTimeout. */
  timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | undefined
  kind: 'interval' | 'calendar'
  /** Parsed calendar spec (calendar jobs only). */
  spec: CalendarSpec | null
  /** Next scheduled fire instant (epoch-ms) for calendar jobs; null otherwise. */
  next_fire_ms: number | null
  in_flight: boolean
  job: CronJobDef
}

export class CronScheduler {
  private readonly state: CronStateStore
  private readonly running = new Map<string, RunningJob>()
  private readonly project_slug: string
  private readonly handlers: CronHandlerRegistry
  private readonly jobs: CronJobRegistry
  private readonly now: () => number
  private readonly timeZone: string
  private readonly maxTimerDelayMs: number
  /**
   * S15 (2026-05-17) Codex r1 P1 — true once `start()` has been called.
   * The registry-subscriber path skips binding while false so a job that
   * registers BEFORE `start()` is iterated by the initial `start()`
   * sweep (avoiding double-binding) and only post-start registrations
   * trigger an inline bind.
   */
  private started = false
  // O4 rising-edge dedup for the cron_job_error degrade journal. In-memory
  // per-job "currently in error" set: the degrade row fires only on the
  // healthy→error TRANSITION. Kept in-memory (not read from cron_state) so the
  // decision + mutation are SYNCHRONOUS — two concurrent fires of the same job
  // can't both observe "not yet errored" and double-emit (the persisted-status
  // read had an await between read and write). A fresh process starts with an
  // empty set, so the first fire after a restart re-emits a still-erroring job
  // exactly once — acceptable (a restart is itself worth surfacing), never a
  // per-poll spam.
  private readonly erroredJobs = new Set<string>()

  /**
   * §F1 — in-flight FIRE promises. Cron keeps its own N per-job timers +
   * calendar re-arm + per-job overlap skip (`fireOnce`'s `in_flight` +
   * `recordSkipped`); it delegates only its FIRE PATH to {@link guardedFire}
   * (via {@link trackFire}) so (a) a store-level throw in the fire tail can
   * never escape as an unhandledRejection, and (b) `stop()` can AWAIT the
   * in-flight fires and quiesce before `db.close()`.
   */
  private readonly inflightFires = new Set<Promise<void>>()

  constructor(options: SchedulerOptions) {
    this.jobs = options.jobs
    this.handlers = options.handlers
    this.project_slug = options.project_slug
    this.state = new CronStateStore(options.db)
    this.now = options.now ?? Date.now
    this.timeZone = options.timeZone ?? hostTimeZone()
    this.maxTimerDelayMs = options.maxTimerDelayMs ?? MAX_TIMER_DELAY_MS
    // S15 (2026-05-17) Codex r1 P1 — subscribe so any job registered
    // AFTER `start()` (action 07's `wow-overnight-<slug>` for example)
    // also gets a setInterval. Without this, the one-shot `start()` at
    // boot would snapshot the registry once and miss every runtime
    // registration. The bindJob path is shared with `start()` so the
    // semantics (interval-only, handler-must-exist, idempotent) match
    // exactly. Pre-start registrations are no-ops here because
    // `started === false`; they get picked up by the initial `start()`
    // iteration.
    this.jobs.onRegister((def) => {
      if (!this.started) return
      this.bindJob(def)
    })
  }

  /**
   * Start every job in the registry — interval jobs on a setInterval,
   * calendar jobs on a re-arming setTimeout. Idempotent — a job already in
   * `running` is left alone. Sets `started=true` so subsequent
   * `CronJobRegistry.register(...)` calls auto-bind via the constructor's
   * listener.
   */
  start(): void {
    this.started = true
    for (const job of this.jobs.list()) {
      this.bindJob(job)
    }
  }

  /**
   * Bind one job's timer. Shared between `start()` (initial sweep) and the
   * registry's `onRegister` listener (post-start runtime registrations).
   * Idempotent w.r.t. `this.running` — a job already being ticked is left
   * alone. On validation failure (unparseable calendar grammar, missing
   * handler) it warns + skips, same as the boot-time iteration.
   *
   * S15 (2026-05-17) Codex r1 P1 — extracted from the loop body in `start()`
   * so the post-start registration path re-uses the exact same validation.
   * T2 (2026-06-07) — branched on schedule kind: interval keeps the existing
   * setInterval; calendar arms via `armCalendar` (next-fire setTimeout +
   * missed-fire catch-up).
   */
  private bindJob(job: CronJobDef): void {
    if (this.running.has(job.name)) return
    const handler = this.handlers.get(job.handler)
    if (!handler) {
      console.warn(`cron scheduler: skipping job '${job.name}' — handler '${job.handler}' not registered`)
      return
    }

    if (job.schedule.kind === 'interval_ms') {
      const entry: RunningJob = {
        timer: setInterval(() => { this.trackFire(job.name) }, job.schedule.interval_ms),
        kind: 'interval',
        spec: null,
        next_fire_ms: null,
        in_flight: false,
        job,
      }
      this.running.set(job.name, entry)
      return
    }

    // Calendar / wall-clock schedule. Parse the OnCalendar subset; an
    // expression outside the documented daily/weekly/monthly grammar warns +
    // skips (Managed's systemd timers cover the full grammar).
    let spec: CalendarSpec
    try {
      spec = parseOnCalendar(job.schedule.expression)
    } catch (err) {
      console.warn(
        `cron scheduler: skipping job '${job.name}' — ${(err as Error).message}`,
      )
      return
    }
    const entry: RunningJob = {
      timer: undefined,
      kind: 'calendar',
      spec,
      next_fire_ms: null,
      in_flight: false,
      job,
    }
    this.running.set(job.name, entry)
    this.armCalendar(job.name)
  }

  /**
   * Arm (or re-arm) a calendar job. First handles missed-fire catch-up: if
   * the most-recent scheduled instant at-or-before `now` is newer than the
   * last recorded run, fire once immediately (then re-arm). Otherwise arm a
   * setTimeout for the next scheduled instant. Mirrors systemd
   * `Persistent=true` — a Mac that slept past a 09:00 daily job, or a process
   * restart after a miss, catches up exactly once on wake.
   */
  private armCalendar(name: string): void {
    const entry = this.running.get(name)
    if (entry === undefined || entry.kind !== 'calendar' || entry.spec === null) return

    const nowMs = this.now()
    const prev = previousFireAtOrBefore(entry.spec, nowMs, this.timeZone)
    if (prev !== null) {
      const state = this.state.get(name, this.project_slug)
      const lastRunMs = state?.last_run_at != null ? state.last_run_at * 1000 : null
      if (lastRunMs === null || lastRunMs < prev) {
        // Missed the most-recent scheduled instant → catch up exactly ONCE,
        // then arm the next FUTURE instant. Arm immediately (don't await the
        // handler) so a slow catch-up can't shift the next tick.
        this.trackFire(name)
        this.scheduleNextFrom(name, nowMs)
        return
      }
    }
    this.scheduleNextFrom(name, nowMs)
  }

  /**
   * Arm a setTimeout for the next scheduled instant strictly after
   * `max(afterMs, now)`. Taking the max of the just-fired instant AND the
   * current clock does two things at once:
   *
   *   1. Cadence-preserving under a slow handler — when the timer fires roughly
   *      on time (`now ≈ afterMs`), the next instant is computed from the fired
   *      instant BEFORE the (async) handler runs, so a handler that overruns the
   *      next period doesn't shift/drop it; overlap is handled by `fireOnce`
   *      (`skip_if_running`), mirroring the interval path's `setInterval`.
   *   2. No burst-replay across a long gap — when the timer fires very late
   *      (the process stayed alive while the machine slept, or the event loop
   *      blocked past several instants), `now` is already beyond multiple
   *      occurrences; clamping the boundary up to `now` means we arm the next
   *      FUTURE instant and fire exactly once, NOT once per missed occurrence.
   *      This is the systemd `Persistent=true` "single catch-up then resume"
   *      semantics.
   *
   * Delays beyond setTimeout's ~24.8-day ceiling are chunked: the timer wakes
   * to re-arm (without firing) until the real instant is within range. Guards
   * against firing after `stop()` (the map no longer holds the job).
   */
  private scheduleNextFrom(name: string, afterMs: number): void {
    const entry = this.running.get(name)
    if (entry === undefined || entry.kind !== 'calendar' || entry.spec === null) return

    const boundary = Math.max(afterMs, this.now())
    const next = nextFireAfter(entry.spec, boundary, this.timeZone)
    entry.next_fire_ms = next
    const delay = Math.max(0, next - this.now())
    const clamped = Math.min(delay, this.maxTimerDelayMs)
    const reArmOnly = clamped < delay
    entry.timer = setTimeout(() => {
      if (!this.running.has(name)) return
      if (reArmOnly) {
        // Ceiling hit on a long (e.g. monthly) wait — re-evaluate from scratch
        // via armCalendar rather than blindly re-arming. If the machine slept /
        // the loop blocked ACROSS the target during this chunk, armCalendar's
        // catch-up fires the missed instant (Persistent=true); otherwise it
        // just re-chunks toward `next`.
        this.armCalendar(name)
        return
      }
      // Advance the schedule FIRST (cadence decoupled from handler duration),
      // then fire. fireOnce's overlap-skip handles a still-in-flight prior run.
      this.scheduleNextFrom(name, next)
      this.trackFire(name)
    }, clamped)
  }

  /**
   * §F1 — fire one job through the shared catch-all + track it so `stop()` can
   * quiesce. `fireOnce` already owns the per-job overlap skip + `cron_state`
   * recording + handler try/catch; `guardedFire` additionally contains a throw
   * from the fire TAIL (e.g. `this.state.record` hitting a closed db) that the
   * old `void this.fireOnce(...)` would have leaked as an unhandledRejection.
   */
  private trackFire(name: string): void {
    // Timer path — `fireOnce()` self-registers in `inflightFires` for quiesce
    // (so direct/manual callers are covered too); `guardedFire` here only
    // contains a tail throw so this VOIDED timer promise can't leak an
    // unhandledRejection.
    fireAndForget('scheduler.guardedFire', guardedFire(name, () => this.fireOnce(name), (jobName, err) => {
      console.error(`cron scheduler: fire '${jobName}' threw:`, err)
    }))
  }

  /**
   * Stop every job's timer, then QUIESCE — await any in-flight fire so a
   * caller can `await scheduler.stop()` before `db.close()`. The synchronous
   * teardown (clear timers, empty `running`, reset `started`) runs FIRST so
   * `runningCount()`/`runningJobNames()` reflect the stop immediately, exactly
   * as before; only the fire-drain is awaited.
   */
  async stop(): Promise<void> {
    for (const r of this.running.values()) {
      if (r.timer === undefined) continue
      if (r.kind === 'interval') clearInterval(r.timer)
      else clearTimeout(r.timer)
    }
    this.running.clear()
    // Reset so a re-start (e.g. test harness hot-reload) iterates the
    // registry afresh and re-binds every job's interval. Without this,
    // a stop()-then-start() cycle would leave `started=true` AND an
    // empty `running` map, with no boot-iteration re-walking the
    // registry — runtime registrations would still bind via the
    // listener but the originally registered jobs would be dormant.
    this.started = false
    // Quiesce: await any fire that was already in flight when we cleared the
    // timers. `guardedFire` never rejects, so this never throws.
    if (this.inflightFires.size > 0) {
      await Promise.all([...this.inflightFires])
    }
  }

  /**
   * Number of jobs currently ticking. S15 (2026-05-17) — boot shell logs
   * this immediately after `start()` so journald shows the cron mesh is
   * live; a 0 here flags a wiring regression (job-registry empty or all
   * handler names unresolved) at the moment of boot rather than 15 min
   * later when the first import stalls.
   */
  runningCount(): number {
    return this.running.size
  }

  /**
   * Names of every job currently ticking (sorted). S15 (2026-05-17) —
   * boot-shell log surface so journald shows WHICH crons are live in
   * addition to the count. Useful when one cron silently fails to bind
   * (handler missing, non-interval schedule) without crashing the boot.
   */
  runningJobNames(): string[] {
    return [...this.running.keys()].sort()
  }

  /**
   * Next scheduled fire instant (epoch-ms) for a calendar job, or null if the
   * job is unknown, not a calendar job, or not yet armed. Observability surface
   * (mirrors `runningJobNames`) + lets tests assert the schedule advances on
   * its own cadence independent of handler duration.
   */
  nextScheduledMs(name: string): number | null {
    return this.running.get(name)?.next_fire_ms ?? null
  }

  /**
   * Fire one job by name (one-shot). Returns the resulting status. Used
   * by tests + by manual operator triggers.
   *
   * §F1 — EVERY fire (timer-driven via {@link trackFire} AND direct/manual
   * operator calls) self-registers in `inflightFires` so `stop()` quiesces it
   * before `db.close()`. The tracked copy swallows so a fire failure can't
   * reject `stop()`'s `Promise.all`; the original `exec` still surfaces its
   * result/throw to a direct caller.
   */
  async fireOnce(name: string): Promise<{ status: CronHandlerStatus; detail?: string }> {
    const exec = this.fireOnceInner(name)
    const tracked = exec.then(
      () => undefined,
      () => undefined,
    )
    this.inflightFires.add(tracked)
    fireAndForget('scheduler.finally', tracked.finally(() => {
      this.inflightFires.delete(tracked)
    }))
    return await exec
  }

  private async fireOnceInner(
    name: string,
  ): Promise<{ status: CronHandlerStatus; detail?: string }> {
    const entry = this.running.get(name)
    if (entry?.in_flight && entry.job.skip_if_running !== false) {
      await this.recordSkipped(name, 'previous run still in-flight')
      return { status: 'skipped', detail: 'overlap' }
    }
    const job = this.jobs.get(name)
    if (!job) {
      return { status: 'error', detail: `unknown job '${name}'` }
    }
    const handler = this.handlers.get(job.handler)
    if (!handler) {
      return { status: 'error', detail: `handler '${job.handler}' not registered` }
    }
    if (entry) entry.in_flight = true
    const fired_at = this.now()
    let status: CronHandlerStatus = 'ok'
    let detail: string | undefined
    let error: string | null = null
    try {
      const result = await handler({ job_name: name, project_slug: this.project_slug, fired_at })
      status = result.status
      detail = result.detail
    } catch (err) {
      status = 'error'
      error = (err as Error).message
      detail = error
    } finally {
      if (entry) entry.in_flight = false
    }
    const duration_ms = this.now() - fired_at
    await this.state.record({
      job_name: name,
      project_slug: this.project_slug,
      fired_at: fired_at / 1000,
      duration_ms,
      status,
      error,
    })
    // O4 — VISIBILITY ONLY: journal the degrade on the RISING EDGE only. The
    // check-and-mutate below is SYNCHRONOUS (no await between them), so two
    // concurrent fires of the same job can't both emit for one transition: the
    // first adds `name` to the set + emits, the second sees it present + skips.
    // Control flow is unchanged; fire-and-forget emit that can never throw.
    if (status === 'error') {
      if (!this.erroredJobs.has(name)) {
        this.erroredJobs.add(name)
        // `error` is set for a THROWN failure; a handler that RETURNS
        // `{status:'error', detail}` carries its reason in `detail` (error stays
        // null). Prefer whichever is present so the journal never drops it.
        const reason = error ?? detail
        fireAndForget('scheduler.emitSystemEvent', emitSystemEvent({
          event: 'cron_job_error',
          module: 'cron',
          level: 'error',
          project_slug: this.project_slug,
          payload: { job_name: name, error: reason ?? undefined, duration_ms },
        }))
      }
    } else {
      // Recovery (or any non-error outcome) clears the edge so the NEXT
      // healthy→error transition emits again.
      this.erroredJobs.delete(name)
    }
    return detail !== undefined ? { status, detail } : { status }
  }

  private async recordSkipped(name: string, reason: string): Promise<void> {
    const fired_at = this.now()
    await this.state.record({
      job_name: name,
      project_slug: this.project_slug,
      fired_at: fired_at / 1000,
      duration_ms: 0,
      status: 'skipped',
      error: reason,
    })
  }
}
