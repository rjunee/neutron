/**
 * @neutronai/watchdog — supervisor.
 *
 * Runs every registered detector in a tick, persists fired alerts to
 * `watchdog_alerts`, and dispatches them through the supplied notifier.
 *
 * Deduplication: an alert id (built from kind + key + ts) collides with a
 * just-recorded alert when the condition fires repeatedly within the same
 * tick. Persistence's PRIMARY KEY enforces uniqueness; the supervisor
 * swallows the dup and continues.
 */

import type { AlertStore } from './alert-store.ts'
import type {
  WatchdogAlert,
  WatchdogDetector,
  WatchdogNotifier,
} from './types.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import type { LoopDescriptor } from '@neutronai/loop'

export interface SupervisorOptions {
  store: AlertStore
  notifier: WatchdogNotifier
  detectors?: WatchdogDetector[]
  /** Tick interval. Default 30 s. */
  tick_interval_ms?: number
}

export class WatchdogSupervisor {
  private readonly detectors: WatchdogDetector[]
  private readonly store: AlertStore
  private readonly notifier: WatchdogNotifier
  private readonly tick_interval_ms: number
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  // §F2 — loop-inventory observability (mirrors SupervisedLoop's fields; the
  // supervisor keeps its own hand-rolled setInterval so it can't reuse them).
  private startedAtMs: number | null = null
  private lastTickAtMs: number | null = null
  // §F2 — the most recent error observed in a tick (detector.detect / persist /
  // notify / commit failure), CLEARED on a fully-clean tick (recovery). The
  // supervisor's own alert store owns durable failure surfacing; this is the
  // loop-inventory `LoopHealth.lastError` (null-when-healthy) contract.
  private lastError: unknown = null
  /** The in-flight tick, so {@link stop} can QUIESCE (await it) before returning. */
  private inflight: Promise<void> | null = null
  /**
   * Alert ids whose NOTIFICATION was delivered but whose `detector.commit()` has
   * not yet latched the incident (a commit that threw). Guards exactly-once: the
   * same candidate re-appears next tick (still un-committed), and this set makes
   * the supervisor RE-COMMIT it WITHOUT re-persisting or re-notifying — a commit
   * failure can never redeliver an already-delivered notification. Entries are
   * dropped the moment their commit finally succeeds (the incident's `open` set
   * suppresses it thereafter), so in the normal path this stays empty.
   */
  private readonly deliveredIds = new Set<string>()

  constructor(options: SupervisorOptions) {
    this.store = options.store
    this.notifier = options.notifier
    this.detectors = [...(options.detectors ?? [])]
    this.tick_interval_ms = options.tick_interval_ms ?? 30_000
  }

  registerDetector(detector: WatchdogDetector): void {
    this.detectors.push(detector)
  }

  /**
   * The kinds of every registered detector, in registration order. Lets a wiring
   * test assert the composer registered ALL SIX detectors (F4) rather than the
   * former three — a registration regression the per-detector tests can't catch.
   */
  detectorKinds(): WatchdogDetector['kind'][] {
    return this.detectors.map((d) => d.kind)
  }

  start(): void {
    if (this.timer !== null) return
    if (this.startedAtMs === null) this.startedAtMs = Date.now()
    this.timer = setInterval(() => {
      fireAndForget('supervisor.runOnce', this.runOnce())
    }, this.tick_interval_ms)
  }

  /**
   * §F2 — live LoopRegistry descriptor (name `watchdog`, cadence
   * `tick_interval_ms`). `lastTickAt` reflects the most recent COMPLETED tick;
   * `lastError` carries the most recent tick's detector/persist/notify/commit
   * error (null when the last tick was clean — recovery clears it). The
   * supervisor's alert store still owns durable failure surfacing; this is the
   * loop-inventory health view. Call after `start()`.
   */
  describe(): LoopDescriptor {
    const self = this
    return {
      name: 'watchdog',
      cadenceMs: this.tick_interval_ms,
      // LAZY (register-before-start): 0 until `start()`, real time after.
      get startedAt(): number {
        return self.startedAtMs ?? 0
      },
      health: () => ({ lastTickAt: this.lastTickAtMs, lastError: this.lastError }),
      // Live: true while the supervisor's interval is armed (stop() nulls it).
      isActive: () => this.timer !== null,
    }
  }

  /**
   * Stop ticking and QUIESCE: clear the interval so no new tick fires, then AWAIT
   * the in-flight tick (if any) before resolving. A bare `clearInterval` cannot
   * drain a running tick — its persist (`AlertStore.record`) / notify would resume
   * against a closing database during shutdown. The gateway's watchdog module runs
   * this async shutdown, and `graph.shutdown()` is awaited BEFORE `db.close()`
   * (round-7 meta-audit — same guarantee the dispatch lifecycle watchdog gets from
   * SupervisedLoop.stop).
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    const p = this.inflight
    if (p !== null) await p
  }

  /**
   * One tick. Runs every detector, then for each candidate alert: persists it,
   * notifies it, and — ONLY when BOTH succeed — commits the detector's
   * incident-edge dedup (COMMIT-ON-SUCCESS, F4 round-3). A transient persist or
   * notify failure does NOT commit, so the same incident is re-attempted next
   * tick and delivered exactly once when the blip clears — never permanently
   * suppressed by a DB/sink hiccup. `record()` is idempotent (`INSERT OR
   * IGNORE`), so re-recording an already-persisted id on a notify-retry is a
   * safe no-op. Returns the alerts DELIVERED this tick so tests can assert.
   */
  async runOnce(): Promise<WatchdogAlert[]> {
    if (this.running) return []
    this.running = true
    // §F2 — most recent error observed THIS tick; assigned to `this.lastError` in
    // the finally so a clean tick clears it (null-when-healthy / recovery).
    let tickError: unknown = null
    const delivered: WatchdogAlert[] = []
    // Expose this tick as `inflight` so a concurrent stop() can await it (quiesce).
    let resolveInflight: () => void = () => {}
    this.inflight = new Promise<void>((res) => {
      resolveInflight = res
    })
    try {
      for (const detector of this.detectors) {
        let alerts: WatchdogAlert[]
        try {
          alerts = await detector.detect()
        } catch (err) {
          tickError = err
          console.error(`watchdog detector ${detector.kind} failed:`, err)
          continue
        }
        for (const alert of alerts) {
          // (0) Already NOTIFIED but not yet committed (a prior commit threw): the
          // notification went out, so do NOT re-persist or re-notify — only RE-COMMIT
          // to finally latch the incident. Guarantees exactly-once even when commit
          // keeps failing (the failure is surfaced, never redelivered).
          if (this.deliveredIds.has(alert.id)) {
            try {
              detector.commit?.(alert)
              this.deliveredIds.delete(alert.id) // latched → `open` suppresses henceforth
            } catch (err) {
              tickError = err
              console.error(
                `watchdog supervisor: commit ${alert.id} threw AGAIN — notification already ` +
                  `delivered; will NOT re-notify, retrying commit next tick:`,
                err,
              )
            }
            continue
          }
          // (1) Durable persist. A REAL store failure (not a dup — record is
          // idempotent) leaves the incident UN-committed so it retries next tick.
          try {
            await this.store.record(alert)
          } catch (err) {
            tickError = err
            console.error(
              `watchdog supervisor: alert delivery FAILING — persist ${alert.id} threw ` +
                `(will retry next tick):`,
              err,
            )
            continue // do NOT commit
          }
          // (2) Notify. On failure, still do NOT commit — the idempotent record
          // means next tick re-records (no-op) and re-attempts the notify.
          let notified = true
          try {
            await this.notifier.notify(alert)
          } catch (err) {
            notified = false
            tickError = err
            console.error(
              `watchdog supervisor: alert delivery FAILING — notify ${alert.id} threw ` +
                `(will retry next tick):`,
              err,
            )
          }
          // (3) COMMIT the dedup ONLY after persist AND notify both succeeded.
          if (notified) {
            delivered.push(alert)
            // Mark delivered BEFORE commit so a commit throw cannot redeliver the
            // notification: next tick takes branch (0) and re-commits only.
            this.deliveredIds.add(alert.id)
            try {
              detector.commit?.(alert)
              this.deliveredIds.delete(alert.id) // committed cleanly → drop the guard entry
            } catch (err) {
              tickError = err
              console.error(
                `watchdog supervisor: commit ${alert.id} threw — notification already ` +
                  `delivered; will NOT re-notify, retrying commit next tick:`,
                err,
              )
            }
          }
        }
      }
    } finally {
      this.running = false
      this.inflight = null
      // §F2 — stamp AFTER the tick tail; `lastError` = this tick's last error, or
      // null when the tick was fully clean (recovery clears a prior error).
      this.lastTickAtMs = Date.now()
      this.lastError = tickError
      resolveInflight()
    }
    return delivered
  }
}
