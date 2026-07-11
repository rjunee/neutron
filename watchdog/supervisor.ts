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
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.tick_interval_ms)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
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
    const delivered: WatchdogAlert[] = []
    try {
      for (const detector of this.detectors) {
        let alerts: WatchdogAlert[]
        try {
          alerts = await detector.detect()
        } catch (err) {
          console.error(`watchdog detector ${detector.kind} failed:`, err)
          continue
        }
        for (const alert of alerts) {
          // (1) Durable persist. A REAL store failure (not a dup — record is
          // idempotent) leaves the incident UN-committed so it retries next tick.
          try {
            await this.store.record(alert)
          } catch (err) {
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
            console.error(
              `watchdog supervisor: alert delivery FAILING — notify ${alert.id} threw ` +
                `(will retry next tick):`,
              err,
            )
          }
          // (3) COMMIT the dedup ONLY after persist AND notify both succeeded.
          if (notified) {
            delivered.push(alert)
            try {
              detector.commit?.(alert)
            } catch (err) {
              console.error(`watchdog supervisor: commit ${alert.id} threw:`, err)
            }
          }
        }
      }
    } finally {
      this.running = false
    }
    return delivered
  }
}
