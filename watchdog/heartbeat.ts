/**
 * @neutronai/watchdog — gateway heartbeat pulse.
 *
 * The REAL source of truth the `HeartbeatDetector` (`detectors.ts`) reads. It
 * replaces the never-stale `{ lastHeartbeatAt: () => Date.now() }` stub the Open
 * composer used to pass (`open/composer.ts`) — a tracker that reports "now" on
 * every read can NEVER be older than the threshold, so the heartbeat detector
 * was structurally incapable of firing.
 *
 * A `HeartbeatPulse` is driven by an EXTERNAL periodic tick — in production the
 * gateway's systemd `WATCHDOG=1` `setInterval` (`gateway/index.ts`), the one
 * process-level liveness loop. Each tick calls {@link pulse}; the detector reads
 * {@link lastHeartbeatAt}. When the gateway tick stops firing (the event loop
 * wedges, the timer is cleared, or the tick callback throws and stops
 * re-pulsing) the last-pulse timestamp stops advancing, so `now - last` crosses
 * the detector threshold and the heartbeat alert fires. That is the whole point
 * of driving it off a real source: it CAN go stale.
 *
 * NOTIFY-ONLY: this is pure observability state — a counter that a tick advances
 * and a detector reads. It changes no control flow and kills nothing.
 */

import type { HeartbeatTracker } from './detectors.ts'

export class HeartbeatPulse implements HeartbeatTracker {
  private last: number | null = null
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  /** Advance the heartbeat to the current wall-clock. Called by the gateway tick. */
  pulse(): void {
    this.last = this.now()
  }

  /** Wall-clock unix-ms of the last pulse, or null before the first tick. */
  lastHeartbeatAt(): number | null {
    return this.last
  }
}
