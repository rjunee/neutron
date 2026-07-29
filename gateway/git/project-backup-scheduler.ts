/**
 * @neutronai/gateway/git — per-gateway project-backup scheduler (P7.4 Phase 2).
 *
 * Per docs/plans/P7.4-phase2-project-backup-sprint-brief.md § 3. ONE
 * ticker per gateway (not N per project). On every tick the scheduler:
 *
 *   1. Enumerates per-instance projects.
 *   2. For each project where `now - last_attempted_at_ms >= tickIntervalMs`
 *      (or no sidecar yet): schedules a `backupNow(project_id)` with a
 *      per-project jitter so 20 projects don't IO-storm at once.
 *   3. Writes `last_attempted_at_ms` BEFORE the snapshot fires (so a
 *      gateway crash + restart doesn't re-fire every minute).
 *
 * Boot-time backfill (brief § 3.3): on `start()`, the scheduler fires
 * an immediate tick. Projects whose `last_attempted_at_ms` is older
 * than `tickIntervalMs` (or has no sidecar at all) get an immediate
 * backup — still jittered, so a freshly-booted gateway with 20
 * projects doesn't IO-storm.
 *
 * Sleep / suspend (brief § 3.4): a laptop running Open that sleeps
 * for 18 hours doesn't fire the ticker. On resume, the next tick
 * sees `now - last_attempted_at_ms` is huge and re-engages
 * immediately. For Managed (hosted VPS), this concern doesn't apply.
 */

import { SupervisedLoop, type LoopDescriptor } from '@neutronai/loop'

import type {
  BackupResult,
  ProjectBackupLogger,
  ProjectBackupStore,
} from './project-backup-store.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('project-backup-scheduler')

/** Coerce arbitrary log meta to the logger's primitive `LogValue` shape —
 *  non-primitives are JSON-stringified so the emitted `k=v` line stays single. */
const coerceLogFields = (
  fields?: Record<string, unknown>,
): Record<string, string | number | boolean | null | undefined> | undefined => {
  if (fields === undefined) return undefined
  const out: Record<string, string | number | boolean | null | undefined> = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] =
      v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v)
        ? (v as string | number | boolean | null | undefined)
        : (() => { try { return JSON.stringify(v) } catch { return String(v) } })()
  }
  return out
}

/** Default tick interval — every 6 hours. Brief § 0.3 confirms fixed. */
export const DEFAULT_TICK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Default jitter cap — 5 minutes. Spreads 20 projects' snapshot
 *  windows across a 5 min IO window. */
export const DEFAULT_JITTER_MAX_MS = 5 * 60 * 1000

/** Short interval the ticker walks at — every 60s the scheduler
 *  re-checks the per-project last-attempted ledger. Each project's
 *  individual cadence is still governed by `tickIntervalMs`; the
 *  inner timer just polls. */
const POLL_INTERVAL_MS = 60_000

export interface ProjectBackupSchedulerOptions {
  store: ProjectBackupStore
  /** Tick interval per project. Default 6h. */
  tickIntervalMs?: number
  /** Project-id enumerator — production reads `<owner_home>/Projects/`. */
  enumerateProjects: () => Promise<string[]>
  /** Jitter cap to spread snapshot IO. Default 5 min. */
  jitterMaxMs?: number
  /** Now-fn override (tests). */
  now?: () => number
  /** Logger. */
  logger?: ProjectBackupLogger
  /**
   * Optional inner-poll override for tests. Defaults to 60s in
   * production; tests typically pass a smaller value AND a fake
   * setInterval/setTimeout pair via the timer hooks below.
   */
  pollIntervalMs?: number
  /**
   * Optional setInterval override (tests).
   */
  setInterval?: (handler: () => void, ms: number) => NodeJS.Timeout
  /**
   * Optional setTimeout override (tests).
   */
  setTimeout?: (handler: () => void, ms: number) => NodeJS.Timeout
  /**
   * Optional clearInterval override (tests).
   */
  clearInterval?: (handle: NodeJS.Timeout) => void
  /**
   * Optional clearTimeout override (tests).
   */
  clearTimeout?: (handle: NodeJS.Timeout) => void
  /**
   * Random fn override (tests). Returns [0,1).
   */
  random?: () => number
}

export class ProjectBackupScheduler {
  private readonly store: ProjectBackupStore
  private readonly tickIntervalMs: number
  private readonly enumerateProjects: () => Promise<string[]>
  private readonly jitterMaxMs: number
  private readonly nowFn: () => number
  private readonly logger: ProjectBackupLogger
  private readonly pollIntervalMs: number
  private readonly setIntervalFn: (handler: () => void, ms: number) => NodeJS.Timeout
  private readonly setTimeoutFn: (handler: () => void, ms: number) => NodeJS.Timeout
  private readonly clearIntervalFn: (handle: NodeJS.Timeout) => void
  private readonly clearTimeoutFn: (handle: NodeJS.Timeout) => void
  private readonly randomFn: () => number

  /** Loop scaffolding — drives the recurring re-check `poll()` at
   *  `pollIntervalMs` with an immediate boot-backfill tick, plus the quiescing
   *  stop (§F1). The per-project jitter timers below are the scheduler's OWN
   *  domain machinery and stay here. */
  private readonly loop: SupervisedLoop
  private readonly pendingJitterTimers = new Map<string, NodeJS.Timeout>()
  /** §F1 — jittered snapshots ALREADY launched (their timer fired). `stop()`
   *  drains these so a shutdown quiesces an in-flight `backupNow()`, not just
   *  the polling loop + not-yet-fired jitter timers. */
  private readonly activeFires = new Set<Promise<void>>()
  /** §F1 — in-flight `poll()` runs (loop-driven AND direct/manual callers), so
   *  `stop()` quiesces a poll that is mid-`readLastAttemptedAt`/`writeLastAttemptedAt`. */
  private readonly activePolls = new Set<Promise<void>>()
  private stopped = false

  constructor(opts: ProjectBackupSchedulerOptions) {
    this.store = opts.store
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
    this.enumerateProjects = opts.enumerateProjects
    this.jitterMaxMs = opts.jitterMaxMs ?? DEFAULT_JITTER_MAX_MS
    this.nowFn = opts.now ?? ((): number => Date.now())
    this.logger =
      opts.logger ??
      ((event, fields): void => {
        moduleLog.warn(event, coerceLogFields(fields))
      })
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS
    this.setIntervalFn = opts.setInterval ?? ((h, ms): NodeJS.Timeout => setInterval(h, ms) as unknown as NodeJS.Timeout)
    this.setTimeoutFn = opts.setTimeout ?? ((h, ms): NodeJS.Timeout => setTimeout(h, ms) as unknown as NodeJS.Timeout)
    this.clearIntervalFn = opts.clearInterval ?? ((handle): void => clearInterval(handle as unknown as ReturnType<typeof setInterval>))
    this.clearTimeoutFn = opts.clearTimeout ?? ((handle): void => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>))
    this.randomFn = opts.random ?? Math.random
    // The SupervisedLoop drives the recurring `poll()` re-check. `immediate:
    // true` fires the boot-backfill tick the moment `start()` is called (brief
    // § 3.3), and its quiescing `stop()` awaits an in-flight poll before we
    // clear the jitter timers. The interval timer seams are threaded through so
    // tests that inject a fake `setInterval` keep working.
    this.loop = new SupervisedLoop({
      name: 'project-backup-scheduler',
      intervalMs: this.pollIntervalMs,
      immediate: true,
      tick: () => this.poll(),
      setTimer: (fn, ms) => this.setIntervalFn(fn, ms),
      clearTimer: (handle) => this.clearIntervalFn(handle as NodeJS.Timeout),
    })
  }

  start(): void {
    this.stopped = false
    this.loop.start()
  }

  /** §F2 — live LoopRegistry descriptor (name `project-backup-scheduler`,
   *  cadence = inner poll interval). D-7: this scheduler is DORMANT (never
   *  started in any composition today); the method exists so the loop registers
   *  itself the moment its wiring lands in a post-window feature PR. Call after
   *  `start()`. */
  describe(): LoopDescriptor {
    return this.loop.describe()
  }

  /** Stop + quiesce: mark stopped so an in-flight `poll()` short-circuits,
   *  await the loop (drains the in-flight poll), cancel any not-yet-fired
   *  jittered snapshot timers, THEN drain any snapshot that already started so
   *  shutdown never closes the store out from under an in-flight `backupNow()`. */
  async stop(): Promise<void> {
    this.stopped = true
    await this.loop.stop()
    // Drain in-flight polls (loop-driven OR direct/manual) FIRST: a poll resuming
    // past a gated store read/write bails on the `stopped` re-checks, but draining
    // here BEFORE cancelling the jitter timers guarantees any timer a racing poll
    // still managed to arm is included in the cancellation below (defense-in-depth
    // against the read/write-boundary window).
    if (this.activePolls.size > 0) {
      await Promise.all([...this.activePolls])
    }
    for (const handle of this.pendingJitterTimers.values()) {
      this.clearTimeoutFn(handle)
    }
    this.pendingJitterTimers.clear()
    // Finally drain any snapshot already firing so the store isn't in use when
    // the caller closes the DB.
    if (this.activeFires.size > 0) {
      await Promise.all([...this.activeFires])
    }
  }

  /** Single poll — fires backups for projects whose tick interval has elapsed.
   *  Exposed for tests + manual driving. Every run (loop-driven or direct) is
   *  registered so `stop()` can quiesce it (§F1). */
  async poll(): Promise<void> {
    const p = this.pollInner()
    this.activePolls.add(p)
    try {
      await p
    } finally {
      this.activePolls.delete(p)
    }
  }

  private async pollInner(): Promise<void> {
    if (this.stopped) return
    let projects: string[] = []
    try {
      projects = await this.enumerateProjects()
    } catch (err) {
      this.logger('enumerate_failed', { error_message: errMessage(err) })
      return
    }
    const now = this.nowFn()
    for (const project_id of projects) {
      if (this.stopped) return
      // Skip projects with a pending jittered timer (another tick
      // already scheduled them; we don't want to double-arm).
      if (this.pendingJitterTimers.has(project_id)) continue
      const last = await this.store.readLastAttemptedAt(project_id)
      // §F1 — re-check AFTER the await: if `stop()` fired while we were reading,
      // bail before writing the attempt sidecar / arming a new jitter timer
      // (which would outlive the shutdown that already cleared the timer map).
      if (this.stopped) return
      const elapsed = last === null ? Infinity : now - last
      // Fire when at least `tickIntervalMs` has elapsed since the
      // LAST attempt. `Infinity` for fresh projects always triggers.
      if (elapsed < this.tickIntervalMs) {
        // Update next-scheduled-at for the admin status surface.
        if (last !== null) {
          this.store.setNextScheduledAt(project_id, last + this.tickIntervalMs)
        }
        continue
      }
      const jitter = Math.floor(this.randomFn() * this.jitterMaxMs)
      // Persist the attempt timestamp BEFORE the snapshot fires so a
      // restart-mid-snapshot doesn't loop.
      const attempted_at = this.nowFn()
      try {
        await this.store.writeLastAttemptedAt(project_id, attempted_at)
      } catch (err) {
        this.logger('write_last_attempted_failed', {
          project_id,
          error_message: errMessage(err),
        })
        // Without the sidecar we'd re-fire every poll; skip this
        // project for this round.
        continue
      }
      // §F1 — re-check AFTER the write await: if `stop()` fired while we were
      // writing, bail before arming a jitter timer that would outlive the
      // shutdown that already cleared the timer map.
      if (this.stopped) return
      this.store.setNextScheduledAt(
        project_id,
        attempted_at + this.tickIntervalMs,
      )
      const handle = this.setTimeoutFn(() => {
        this.pendingJitterTimers.delete(project_id)
        if (this.stopped) return
        // Track the in-flight snapshot so `stop()` can drain it. `fire()`
        // catches its own errors + never rejects, so this never carries a
        // rejection.
        const p = this.fire(project_id).then(() => undefined)
        this.activeFires.add(p)
        fireAndForget('project-backup-scheduler.finally', p.finally(() => this.activeFires.delete(p)))
      }, jitter)
      this.pendingJitterTimers.set(project_id, handle)
    }
  }

  private async fire(project_id: string): Promise<BackupResult | null> {
    try {
      const result = await this.store.backupNow(project_id)
      this.logger('backup_completed', {
        project_id,
        commit_sha: result.commit_sha,
        pushed: result.pushed,
        push_error: result.push_error,
      })
      return result
    } catch (err) {
      this.logger('backup_threw', {
        project_id,
        error_message: errMessage(err),
      })
      return null
    }
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
