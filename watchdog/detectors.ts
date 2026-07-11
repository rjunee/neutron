/**
 * @neutronai/watchdog — 6 logical-watchdog detectors.
 *
 * The 6 ports from Nova:
 *
 *   1. gateway_heartbeat — cross-process liveness pulse (project.db row)
 *   2. stuck_agent — registered process with no activity > threshold
 *   3. crashed_agent — registered process whose pid is gone
 *   4. overrun_cron — cron job's last_run_duration_ms > expected
 *   5. db_lock_contention — busy-retry exhaustions in window > threshold
 *   6. substrate_cooldown_saturation — every credential in cooldown
 *
 * Detectors are pure: each pulls its source-of-truth + emits the alerts
 * that should fire NOW. The `WatchdogSupervisor` runs them in a tick +
 * persists into `watchdog_alerts` + notifies.
 */

import type { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import type { CronStateStore } from '@neutronai/cron/state.ts'
import type {
  CredentialPool,
  PooledCredential,
} from '@neutronai/runtime/credential-pool.ts'
import type { ProcessRegistry } from '@neutronai/tools/process-registry.ts'
import { IncidentEdgeTracker } from './incident.ts'
import type { WatchdogAlert, WatchdogDetector, WatchdogKind } from './types.ts'

export interface CommonDetectorOptions {
  project_slug: string
  now?: () => number
}

const newAlertId = (kind: WatchdogKind, key: string, ts: number): string =>
  `${kind}:${key}:${ts}`

// ─────────────────────────────────────────────────────────────────
// 1. gateway_heartbeat
// ─────────────────────────────────────────────────────────────────

export interface HeartbeatTracker {
  /** Wall-clock unix-ms of the last heartbeat written by the gateway. */
  lastHeartbeatAt(): number | null
}

export interface HeartbeatDetectorOptions extends CommonDetectorOptions {
  tracker: HeartbeatTracker
  /** Fire if the heartbeat is older than this. Default 30 s (3× sd_notify tick). */
  threshold_ms?: number
}

export class HeartbeatDetector implements WatchdogDetector {
  readonly kind: WatchdogKind = 'gateway_heartbeat'
  private readonly tracker: HeartbeatTracker
  private readonly project_slug: string
  private readonly now: () => number
  private readonly threshold_ms: number
  private readonly incidents = new IncidentEdgeTracker()

  // COMMIT-ON-SUCCESS (F4 round-3): latch this incident's dedup ONLY after the
  // supervisor durably persisted AND delivered the alert. A transient failure
  // skips this, so the incident re-attempts next tick instead of being lost.
  commit(alert: WatchdogAlert): void {
    this.incidents.commitById(alert.id)
  }

  constructor(opts: HeartbeatDetectorOptions) {
    this.tracker = opts.tracker
    this.project_slug = opts.project_slug
    this.now = opts.now ?? Date.now
    this.threshold_ms = opts.threshold_ms ?? 30_000
  }

  async detect(): Promise<WatchdogAlert[]> {
    const last = this.tracker.lastHeartbeatAt()
    const now = this.now()
    const firing = last !== null && now - last > this.threshold_ms
    // Incident-edge: fire ONCE while the heartbeat stays stale, and again only
    // after it recovers then goes stale anew (Blocker-1 fix).
    const risen = this.incidents.candidates(firing ? [this.project_slug] : [], (key) =>
      newAlertId(this.kind, key, now),
    )
    return risen.map(({ id }) => ({
      id,
      kind: this.kind,
      project_slug: this.project_slug,
      detected_at: now / 1000,
      resolved_at: null,
      payload: { last_heartbeat_at: last, age_ms: last === null ? 0 : now - last },
    }))
  }
}

// ─────────────────────────────────────────────────────────────────
// 2. stuck_agent
// ─────────────────────────────────────────────────────────────────

export interface StuckAgentDetectorOptions extends CommonDetectorOptions {
  process_registry: ProcessRegistry
  /** Default 15 minutes (matches Nova's stuck-agent threshold). */
  inactivity_threshold_ms?: number
}

export class StuckAgentDetector implements WatchdogDetector {
  readonly kind: WatchdogKind = 'stuck_agent'
  private readonly registry: ProcessRegistry
  private readonly project_slug: string
  private readonly now: () => number
  private readonly threshold_ms: number
  private readonly incidents = new IncidentEdgeTracker()

  // COMMIT-ON-SUCCESS (F4 round-3): latch this incident's dedup ONLY after the
  // supervisor durably persisted AND delivered the alert. A transient failure
  // skips this, so the incident re-attempts next tick instead of being lost.
  commit(alert: WatchdogAlert): void {
    this.incidents.commitById(alert.id)
  }

  constructor(opts: StuckAgentDetectorOptions) {
    this.registry = opts.process_registry
    this.project_slug = opts.project_slug
    this.now = opts.now ?? Date.now
    this.threshold_ms = opts.inactivity_threshold_ms ?? 15 * 60_000
  }

  async detect(): Promise<WatchdogAlert[]> {
    const now = this.now()
    const stuck = this.registry.listStuck(this.threshold_ms)
    const byName = new Map(stuck.map((r) => [r.name, r]))
    // Incident-edge PER process: one alert per stuck process while it stays
    // stuck; a process that recovers (activity resumes → drops out of listStuck)
    // and later wedges again re-fires (Blocker-1 fix).
    const risen = this.incidents.candidates(byName.keys(), (key) => newAlertId(this.kind, key, now))
    return risen.map(({ key, id }) => {
      const r = byName.get(key)!
      return {
        id,
        kind: this.kind,
        project_slug: this.project_slug,
        detected_at: now / 1000,
        resolved_at: null,
        payload: {
          process_name: r.name,
          pid: r.pid,
          tool_name: r.tool_name,
          last_activity_at: r.last_activity_at,
          age_ms: now - r.last_activity_at,
        },
      }
    })
  }
}

// ─────────────────────────────────────────────────────────────────
// 3. crashed_agent
// ─────────────────────────────────────────────────────────────────

export interface PidLivenessProbe {
  /** Returns true if the OS still has a process with this PID. */
  isAlive(pid: number): boolean
}

/** Default probe — uses kill(pid, 0). */
export const DefaultPidLivenessProbe: PidLivenessProbe = {
  isAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
}

export interface CrashedAgentDetectorOptions extends CommonDetectorOptions {
  process_registry: ProcessRegistry
  pid_probe?: PidLivenessProbe
}

export class CrashedAgentDetector implements WatchdogDetector {
  readonly kind: WatchdogKind = 'crashed_agent'
  private readonly registry: ProcessRegistry
  private readonly project_slug: string
  private readonly now: () => number
  private readonly probe: PidLivenessProbe
  private readonly incidents = new IncidentEdgeTracker()

  constructor(opts: CrashedAgentDetectorOptions) {
    this.registry = opts.process_registry
    this.project_slug = opts.project_slug
    this.now = opts.now ?? Date.now
    this.probe = opts.pid_probe ?? DefaultPidLivenessProbe
  }

  async detect(): Promise<WatchdogAlert[]> {
    const now = this.now()
    // PURE: report dead records as candidates. Do NOT unregister here — the reap
    // is a STATE MUTATION that must happen AFTER the alert is durably persisted +
    // delivered (round-4 sweep, Blocker-2). Unregistering before delivery meant a
    // failed persist/notify lost the crash forever: the record was already gone,
    // so the retry tick had nothing to rediscover. The incident tracker keeps the
    // dead record deduped (one alert per crash) WITHOUT removing it — the removal
    // is deferred to commit().
    const dead = this.registry.list().filter((r) => !this.probe.isAlive(r.pid))
    const byName = new Map(dead.map((r) => [r.name, r]))
    const risen = this.incidents.candidates(byName.keys(), (key) => newAlertId(this.kind, key, now))
    return risen.map(({ key, id }) => {
      const r = byName.get(key)!
      return {
        id,
        kind: this.kind,
        project_slug: this.project_slug,
        detected_at: now / 1000,
        resolved_at: null,
        payload: {
          process_name: r.name,
          pid: r.pid,
          tool_name: r.tool_name,
        },
      }
    })
  }

  // COMMIT-ON-SUCCESS (round-4): the dead record is REAPED from the registry ONLY
  // after its crash alert was durably persisted + delivered. Until then it stays
  // discoverable so a failed tick retries. `commitById` latches the incident so a
  // re-registered same-name process later is a fresh incident.
  //
  // IDENTITY-GUARDED reap (High A): remove the entry ONLY if it still points at the
  // EXACT pid we detected dead. A respawn intentionally replaces an entry under the
  // same `name` with a NEW pid (`registerLiveProcessSafe` upsert / spawn.ts); if
  // that happened between detect() and this commit(), a name-only unregister would
  // erase the freshly-respawned LIVE process. `unregisterIfPid` no-ops in that case
  // and leaves the new child registered.
  commit(alert: WatchdogAlert): void {
    this.incidents.commitById(alert.id)
    const payload = alert.payload as { process_name?: unknown; pid?: unknown }
    const name = payload.process_name
    const pid = payload.pid
    if (typeof name === 'string' && typeof pid === 'number') {
      this.registry.unregisterIfPid(name, pid)
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// 4. overrun_cron
// ─────────────────────────────────────────────────────────────────

export interface OverrunCronDetectorOptions extends CommonDetectorOptions {
  jobs: CronJobRegistry
  state: CronStateStore
  /** Default expected_duration_ms when a job omits it. */
  default_expected_ms?: number
}

export class OverrunCronDetector implements WatchdogDetector {
  readonly kind: WatchdogKind = 'overrun_cron'
  private readonly jobs: CronJobRegistry
  private readonly state: CronStateStore
  private readonly project_slug: string
  private readonly now: () => number
  private readonly default_expected_ms: number
  private readonly incidents = new IncidentEdgeTracker()

  // COMMIT-ON-SUCCESS (F4 round-3): latch this incident's dedup ONLY after the
  // supervisor durably persisted AND delivered the alert. A transient failure
  // skips this, so the incident re-attempts next tick instead of being lost.
  commit(alert: WatchdogAlert): void {
    this.incidents.commitById(alert.id)
  }

  constructor(opts: OverrunCronDetectorOptions) {
    this.jobs = opts.jobs
    this.state = opts.state
    this.project_slug = opts.project_slug
    this.now = opts.now ?? Date.now
    this.default_expected_ms = opts.default_expected_ms ?? 10 * 60_000
  }

  async detect(): Promise<WatchdogAlert[]> {
    const now = this.now()
    const payloads = new Map<string, Record<string, unknown>>()
    for (const job of this.jobs.list()) {
      const state = this.state.get(job.name, this.project_slug)
      if (!state || state.last_run_duration_ms === null) continue
      const expected = job.expected_duration_ms ?? this.default_expected_ms
      if (state.last_run_duration_ms <= expected) continue
      // PER-RUN incident key (Blocker-B fix). Keying by job name ALONE would
      // suppress a LATER run of the same job that ALSO overran (the incident
      // never closes until a run comes in UNDER budget). `last_run_at` identifies
      // the specific run, so: the same overrunning run re-observed → suppressed;
      // a DIFFERENT run that overruns → a NEW key → a fresh alert. Satisfies both
      // "no storm for one overrun" AND "one alert per overrunning run".
      const key = `${job.name} ${state.last_run_at}`
      payloads.set(key, {
        job_name: job.name,
        duration_ms: state.last_run_duration_ms,
        expected_ms: expected,
        last_run_at: state.last_run_at,
      })
    }
    const risen = this.incidents.candidates(payloads.keys(), (key) => newAlertId(this.kind, key, now))
    return risen.map(({ key, id }) => ({
      id,
      kind: this.kind,
      project_slug: this.project_slug,
      detected_at: now / 1000,
      resolved_at: null,
      payload: payloads.get(key)!,
    }))
  }
}

// ─────────────────────────────────────────────────────────────────
// 5. db_lock_contention
// ─────────────────────────────────────────────────────────────────

export interface BusyRetryCounter {
  /** Total busy-retry exhaustion events since process start. */
  exhaustionCount(): number
}

export interface DbLockDetectorOptions extends CommonDetectorOptions {
  counter: BusyRetryCounter
  /** Window the counter delta is measured against. Default 60 s. */
  window_ms?: number
  /** Fire when delta within window > this. Default 5. */
  threshold_per_window?: number
}

export class DbLockContentionDetector implements WatchdogDetector {
  readonly kind: WatchdogKind = 'db_lock_contention'
  private readonly counter: BusyRetryCounter
  private readonly project_slug: string
  private readonly now: () => number
  private readonly window_ms: number
  private readonly threshold: number
  private samples: Array<{ t: number; count: number }> = []
  private readonly incidents = new IncidentEdgeTracker()

  // COMMIT-ON-SUCCESS (F4 round-3): latch this incident's dedup ONLY after the
  // supervisor durably persisted AND delivered the alert. A transient failure
  // skips this, so the incident re-attempts next tick instead of being lost.
  commit(alert: WatchdogAlert): void {
    this.incidents.commitById(alert.id)
  }

  constructor(opts: DbLockDetectorOptions) {
    this.counter = opts.counter
    this.project_slug = opts.project_slug
    this.now = opts.now ?? Date.now
    this.window_ms = opts.window_ms ?? 60_000
    this.threshold = opts.threshold_per_window ?? 5
  }

  async detect(): Promise<WatchdogAlert[]> {
    const now = this.now()
    const cur = this.counter.exhaustionCount()
    this.samples.push({ t: now, count: cur })
    // Drop samples older than 2× window so the buffer is bounded.
    const cutoff = now - this.window_ms * 2
    this.samples = this.samples.filter((s) => s.t >= cutoff)
    const windowStart = now - this.window_ms
    const inWindow = this.samples.filter((s) => s.t >= windowStart)
    const oldest = inWindow[0]
    const delta = oldest ? cur - oldest.count : 0
    const firing = oldest !== undefined && delta >= this.threshold
    // Incident-edge: sustained contention keeps `delta` over threshold across
    // ticks — fire once per contention incident, re-fire only after it subsides
    // below threshold and crosses again (Blocker-1 fix).
    const risen = this.incidents.candidates(firing ? [this.project_slug] : [], (key) =>
      newAlertId(this.kind, key, now),
    )
    return risen.map(({ id }) => ({
      id,
      kind: this.kind,
      project_slug: this.project_slug,
      detected_at: now / 1000,
      resolved_at: null,
      payload: {
        delta,
        window_ms: this.window_ms,
        threshold: this.threshold,
      },
    }))
  }
}

// ─────────────────────────────────────────────────────────────────
// 6. substrate_cooldown_saturation
// ─────────────────────────────────────────────────────────────────

export interface SubstrateCooldownDetectorOptions extends CommonDetectorOptions {
  pool: CredentialPool
  /** Substrate kind (e.g. 'cc' / 'gpt-5-5-api') for the alert payload. */
  substrate_kind: string
}

export class SubstrateCooldownDetector implements WatchdogDetector {
  readonly kind: WatchdogKind = 'substrate_cooldown_saturation'
  private readonly pool: CredentialPool
  private readonly project_slug: string
  private readonly substrate_kind: string
  private readonly now: () => number
  private readonly incidents = new IncidentEdgeTracker()

  // COMMIT-ON-SUCCESS (F4 round-3): latch this incident's dedup ONLY after the
  // supervisor durably persisted AND delivered the alert. A transient failure
  // skips this, so the incident re-attempts next tick instead of being lost.
  commit(alert: WatchdogAlert): void {
    this.incidents.commitById(alert.id)
  }

  constructor(opts: SubstrateCooldownDetectorOptions) {
    this.pool = opts.pool
    this.project_slug = opts.project_slug
    this.substrate_kind = opts.substrate_kind
    this.now = opts.now ?? Date.now
  }

  async detect(): Promise<WatchdogAlert[]> {
    const now = this.now()
    const allCold =
      this.pool.credentials.length > 0 &&
      this.pool.credentials.every(
        (c: PooledCredential) => c.cooldown_until !== undefined && c.cooldown_until > now,
      )
    // Incident-edge: a cooldown lasts minutes across many ticks — fire once when
    // the pool saturates, and again only after some credential recovers then the
    // pool saturates anew (Blocker-1 fix: was ~20 pings for a 10-min cooldown).
    const risen = this.incidents.candidates(allCold ? [this.substrate_kind] : [], (key) =>
      newAlertId(this.kind, key, now),
    )
    return risen.map(({ id }) => ({
      id,
      kind: this.kind,
      project_slug: this.project_slug,
      detected_at: now / 1000,
      resolved_at: null,
      payload: {
        substrate_kind: this.substrate_kind,
        credential_count: this.pool.credentials.length,
      },
    }))
  }
}
