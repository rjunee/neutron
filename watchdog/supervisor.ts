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
   * One tick. Runs every detector, persists + notifies each fired alert.
   * Returns the alerts that fired so tests can assert.
   */
  async runOnce(): Promise<WatchdogAlert[]> {
    if (this.running) return []
    this.running = true
    const fired: WatchdogAlert[] = []
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
          try {
            await this.store.record(alert)
          } catch (err) {
            // Likely a duplicate (PK collision) — log + continue
            console.warn(`watchdog supervisor: persist ${alert.id} failed:`, err)
            continue
          }
          fired.push(alert)
          try {
            await this.notifier.notify(alert)
          } catch (err) {
            console.error(`watchdog notifier failed for ${alert.id}:`, err)
          }
        }
      }
    } finally {
      this.running = false
    }
    return fired
  }
}
