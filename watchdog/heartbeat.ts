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
 * gateway's `WATCHDOG=1` `setInterval` (`gateway/index.ts`), the one process-level
 * liveness loop. Each tick calls {@link pulse}; the `HeartbeatDetector` reads
 * {@link lastHeartbeatAt} on the supervisor's own tick. When the pulse stops
 * advancing, `now - last` crosses the detector threshold and the alert fires —
 * replacing the `() => Date.now()` stub that reported "now" on every read and so
 * could NEVER be stale.
 *
 * WHAT THIS ACTUALLY DETECTS — read carefully (F4 Blocker-3 correction). The
 * pulse and the detector both run on `setInterval` timers in the SAME process and
 * event loop. So this detects the GATEWAY TICK LOOP STOPPING WHILE THE DETECTOR
 * LOOP KEEPS RUNNING: the `WATCHDOG` timer being cleared, the tick scheduler
 * dying, or the pulse source being detached — a divergence between the two loops.
 *
 * It does NOT (and cannot) detect a SYNCHRONOUS EVENT-LOOP WEDGE. During a real
 * synchronous stall neither timer fires (both are frozen); when the loop resumes,
 * the already-overdue 5 s pulse timer runs BEFORE the 30 s detector reads it, so
 * the heartbeat looks fresh and the wedge is never reported. The teeth for a true
 * process-level stall are OUT of this loop entirely: systemd's `WatchdogSec` on
 * the unit, which restarts the process when `WATCHDOG=1` datagrams stop arriving
 * (a kernel-side timer independent of the wedged Bun loop). Measuring in-loop
 * timer LATENESS to catch a resumed-after-stall pulse is possible but is beyond
 * this notify-only PR (it would need an out-of-loop clock or a scheduled-vs-actual
 * delta) — deferred.
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
