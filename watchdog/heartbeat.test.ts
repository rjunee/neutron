/**
 * @neutronai/watchdog — HeartbeatPulse (F4).
 *
 * The real heartbeat source that REPLACES the never-stale
 * `{ lastHeartbeatAt: () => Date.now() }` stub. Proves the wired-for-real
 * behaviour the F4 acceptance requires: the heartbeat goes STALE when the tick
 * (the pulse) stops, so the `HeartbeatDetector` can fire — something the old
 * always-`now()` stub was structurally incapable of.
 */

import { describe, expect, test } from 'bun:test'
import { HeartbeatDetector } from './detectors.ts'
import { HeartbeatPulse } from './heartbeat.ts'

describe('HeartbeatPulse', () => {
  test('lastHeartbeatAt is null until the first pulse', () => {
    const pulse = new HeartbeatPulse({ now: () => 1_000 })
    expect(pulse.lastHeartbeatAt()).toBeNull()
    pulse.pulse()
    expect(pulse.lastHeartbeatAt()).toBe(1_000)
  })

  test('pulse advances the timestamp to the injected clock', () => {
    let now = 1_000
    const pulse = new HeartbeatPulse({ now: () => now })
    pulse.pulse()
    expect(pulse.lastHeartbeatAt()).toBe(1_000)
    now = 5_000
    pulse.pulse()
    expect(pulse.lastHeartbeatAt()).toBe(5_000)
  })

  test('detector STAYS SILENT while the tick keeps pulsing, then FIRES when it stops', async () => {
    let now = 100_000
    const pulse = new HeartbeatPulse({ now: () => now })
    const detector = new HeartbeatDetector({
      project_slug: 'owner',
      tracker: pulse,
      threshold_ms: 30_000,
      now: () => now,
    })

    // Tick fires: heartbeat is fresh → no alert.
    pulse.pulse()
    expect(await detector.detect()).toEqual([])

    // Time advances but the tick keeps pulsing → still fresh, still silent.
    now += 10_000
    pulse.pulse()
    now += 10_000
    pulse.pulse()
    expect(await detector.detect()).toEqual([])

    // The tick STOPS (no more pulse). Once now - last > threshold, it fires.
    now += 31_000
    const fired = await detector.detect()
    expect(fired.length).toBe(1)
    expect(fired[0]!.kind).toBe('gateway_heartbeat')
    expect(fired[0]!.payload['age_ms']).toBe(31_000)
  })

  test('a never-stale tracker (the OLD stub) could NEVER fire — regression contract', async () => {
    // Documents exactly what F4 fixed: `() => Date.now()` always reports "now",
    // so age is always ~0 and the detector is structurally incapable of firing.
    let now = 0
    const neverStale = { lastHeartbeatAt: () => now }
    const detector = new HeartbeatDetector({
      project_slug: 'owner',
      tracker: neverStale,
      threshold_ms: 30_000,
      now: () => now,
    })
    now = 10_000_000
    expect(await detector.detect()).toEqual([])
  })
})
