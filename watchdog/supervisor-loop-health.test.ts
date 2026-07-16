/**
 * §F2 defect #2 — the watchdog supervisor's LoopRegistry health must surface the
 * last tick's error (detector / persist / notify / commit failure) and CLEAR it
 * on a fully-clean tick (recovery). Before the fix `describe().health()` returned
 * `lastError: null` unconditionally, violating the LoopHealth contract.
 */

import { describe, expect, test } from 'bun:test'

import { WatchdogSupervisor } from './supervisor.ts'
import type { AlertStore } from './alert-store.ts'
import type { WatchdogAlert, WatchdogDetector } from './types.ts'

const noopStore = { record: async (): Promise<void> => {} } as unknown as AlertStore

function oneAlert(): WatchdogAlert {
  return {
    id: 'alert-1',
    kind: 'gateway_heartbeat',
    owner_slug: 'owner',
    detected_at: 1,
    resolved_at: null,
    payload: {},
  }
}

function throwingDetector(err: Error): WatchdogDetector {
  return { kind: 'gateway_heartbeat', detect: async () => { throw err } }
}
function cleanDetector(): WatchdogDetector {
  return { kind: 'gateway_heartbeat', detect: async () => [] }
}
function alertingDetector(): WatchdogDetector {
  return { kind: 'gateway_heartbeat', detect: async () => [oneAlert()] }
}

describe('WatchdogSupervisor — loop-inventory health (defect #2)', () => {
  test('a throwing DETECTOR surfaces in health; a later clean tick CLEARS it', async () => {
    const boom = new Error('detector boom')
    let fail = true
    const supervisor = new WatchdogSupervisor({
      store: noopStore,
      notifier: { notify: async () => {} },
      detectors: [{ kind: 'gateway_heartbeat', detect: async () => { if (fail) throw boom; return [] } }],
    })
    await supervisor.runOnce()
    let health = supervisor.describe().health()
    expect(health.lastError).toBe(boom)
    expect(health.lastTickAt).toBeGreaterThan(0)

    // Recovery — a clean tick nulls the error.
    fail = false
    await supervisor.runOnce()
    health = supervisor.describe().health()
    expect(health.lastError).toBeNull()
  })

  test('a throwing STORE (persist) surfaces in health', async () => {
    const boom = new Error('persist boom')
    const supervisor = new WatchdogSupervisor({
      store: { record: async (): Promise<void> => { throw boom } } as unknown as AlertStore,
      notifier: { notify: async () => {} },
      detectors: [alertingDetector()],
    })
    await supervisor.runOnce()
    expect(supervisor.describe().health().lastError).toBe(boom)
  })

  test('a throwing NOTIFIER surfaces in health', async () => {
    const boom = new Error('notify boom')
    const supervisor = new WatchdogSupervisor({
      store: noopStore,
      notifier: { notify: async () => { throw boom } },
      detectors: [alertingDetector()],
    })
    await supervisor.runOnce()
    expect(supervisor.describe().health().lastError).toBe(boom)
  })

  test('a clean tick from the start reports null error', async () => {
    const supervisor = new WatchdogSupervisor({
      store: noopStore,
      notifier: { notify: async () => {} },
      detectors: [cleanDetector()],
    })
    await supervisor.runOnce()
    const health = supervisor.describe().health()
    expect(health.lastError).toBeNull()
    expect(health.lastTickAt).toBeGreaterThan(0)
  })

  test('throwingDetector helper builds a valid detector (type guard)', () => {
    expect(throwingDetector(new Error('x')).kind).toBe('gateway_heartbeat')
  })
})
