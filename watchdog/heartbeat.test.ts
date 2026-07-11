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

  test('REAL scheduling: the tick loop stops while the detector loop keeps reading → FIRES', async () => {
    // This is exactly what the heartbeat detects (Blocker-3 correction): the
    // WATCHDOG tick loop stopped advancing the pulse while the supervisor's
    // detector loop keeps running. We model that by advancing the clock + calling
    // detect() (the detector loop) WITHOUT calling pulse() (the dead tick loop).
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

    // The tick loop DIES (no more pulse) but the detector loop keeps reading.
    now += 31_000
    const fired = await detector.detect()
    expect(fired.length).toBe(1)
    expect(fired[0]!.kind).toBe('gateway_heartbeat')
    expect(fired[0]!.payload['age_ms']).toBe(31_000)
  })

  test('incident-edge: a SUSTAINED stall fires exactly ONCE across many detector ticks', async () => {
    // Blocker-1: the detector loop keeps running every 30 s while the pulse stays
    // dead. Without incident-edge each read minted a fresh alert (a storm).
    let now = 100_000
    const pulse = new HeartbeatPulse({ now: () => now })
    pulse.pulse()
    const detector = new HeartbeatDetector({
      project_slug: 'owner',
      tracker: pulse,
      threshold_ms: 30_000,
      now: () => now,
    })
    now += 40_000 // stale
    let total = 0
    for (let i = 0; i < 10; i++) {
      total += (await detector.detect()).length
      now += 30_000 // detector loop keeps ticking; pulse stays dead
    }
    expect(total).toBe(1) // ONE incident, not ten
  })

  test('incident-edge: stale → healthy → stale re-fires (a second incident)', async () => {
    let now = 100_000
    const pulse = new HeartbeatPulse({ now: () => now })
    pulse.pulse()
    const detector = new HeartbeatDetector({
      project_slug: 'owner',
      tracker: pulse,
      threshold_ms: 30_000,
      now: () => now,
    })
    now += 40_000
    expect((await detector.detect()).length).toBe(1) // incident 1
    // Recovery: the tick loop resumes pulsing → fresh.
    pulse.pulse()
    expect((await detector.detect()).length).toBe(0)
    // Tick loop dies again → a NEW incident fires.
    now += 40_000
    expect((await detector.detect()).length).toBe(1) // incident 2
  })

  test('LIMITATION (documented): a synchronous wedge is NOT detected — the resumed pulse masks it', async () => {
    // Blocker-3 honesty test. During a real synchronous event-loop wedge BOTH the
    // pulse timer and the detector timer are frozen. When the loop resumes, the
    // overdue pulse timer fires BEFORE the detector reads, so the heartbeat looks
    // fresh and the wedge is never reported. Model that ordering: advance the
    // clock (the wedge), pulse (the resumed overdue pulse timer), THEN detect.
    let now = 100_000
    const pulse = new HeartbeatPulse({ now: () => now })
    pulse.pulse()
    const detector = new HeartbeatDetector({
      project_slug: 'owner',
      tracker: pulse,
      threshold_ms: 30_000,
      now: () => now,
    })
    now += 120_000 // a 2-minute synchronous wedge (both timers frozen)
    pulse.pulse() // resume: the overdue pulse fires first…
    // …so the detector, reading after, sees a fresh heartbeat → NO alert.
    expect(await detector.detect()).toEqual([])
    // (systemd WatchdogSec — an out-of-process timer — is what catches this.)
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
