/**
 * @neutronai/watchdog — supervisor COMMIT-ON-SUCCESS (F4 round-3).
 *
 * A supervision system that loses its alert on a transient DB/sink blip is worse
 * than useless. These tests prove the fix: the incident-edge dedup is committed
 * ONLY after the alert is durably persisted AND delivered, so a transient
 * failure re-attempts and delivers EXACTLY ONCE when it clears — never
 * permanently suppressed.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { AlertStore } from './alert-store.ts'
import { HeartbeatDetector, type HeartbeatTracker } from './detectors.ts'
import { WatchdogSupervisor } from './supervisor.ts'
import type { WatchdogAlert, WatchdogDetector } from './types.ts'

let db: ProjectDb | undefined
let tmp: string | undefined

afterEach(() => {
  db?.close()
  db = undefined
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

// A persistently-stale heartbeat (a sustained condition that fires every tick).
function staleHeartbeatDetector(): HeartbeatDetector {
  let now = 1_000_000
  const tracker: HeartbeatTracker = { lastHeartbeatAt: () => now - 60_000 }
  return new HeartbeatDetector({ project_slug: 'owner', tracker, threshold_ms: 30_000, now: () => (now += 1) })
}

describe('WatchdogSupervisor — COMMIT-ON-SUCCESS (round-3)', () => {
  test('store.record rejects on the first tick → alert still delivered EXACTLY ONCE on a later tick', async () => {
    let recordCalls = 0
    const flakyStore = {
      record: async (): Promise<void> => {
        recordCalls++
        if (recordCalls === 1) throw new Error('transient: database is locked')
      },
    } as unknown as AlertStore

    const notified: WatchdogAlert[] = []
    const supervisor = new WatchdogSupervisor({
      store: flakyStore,
      notifier: { notify: async (a) => { notified.push(a) } },
      detectors: [staleHeartbeatDetector()],
    })

    // Tick 1 — persist throws → NOT committed, notifier sees nothing.
    expect((await supervisor.runOnce()).length).toBe(0)
    expect(notified.length).toBe(0)

    // Tick 2 — persist succeeds → notify → delivered exactly once.
    expect((await supervisor.runOnce()).length).toBe(1)
    expect(notified.length).toBe(1)

    // Tick 3 — committed → no storm.
    expect((await supervisor.runOnce()).length).toBe(0)
    expect(notified.length).toBe(1)
  })

  test('a throwing notifier on the first tick → retried and delivered next, persisted exactly once', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-wd-supervisor-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
    const store = new AlertStore(db) // REAL store — proves INSERT OR IGNORE idempotency

    let notifyCalls = 0
    const delivered: WatchdogAlert[] = []
    const supervisor = new WatchdogSupervisor({
      store,
      notifier: {
        notify: async (a): Promise<void> => {
          notifyCalls++
          if (notifyCalls === 1) throw new Error('transient: sink down')
          delivered.push(a)
        },
      },
      detectors: [staleHeartbeatDetector()],
    })

    // Tick 1 — record OK, notify throws → NOT committed, nothing delivered.
    expect((await supervisor.runOnce()).length).toBe(0)
    expect(delivered.length).toBe(0)

    // Tick 2 — record re-runs (idempotent no-op), notify succeeds → delivered once.
    expect((await supervisor.runOnce()).length).toBe(1)
    expect(delivered.length).toBe(1)

    // Tick 3 — committed → no storm.
    expect((await supervisor.runOnce()).length).toBe(0)
    expect(delivered.length).toBe(1)

    // The notifier was CALLED twice (throw + success) but the row persisted ONCE
    // (idempotent record — no duplicate on the notify-retry).
    expect(notifyCalls).toBe(2)
    expect(store.listOpen('owner').length).toBe(1)
  })
})

describe('WatchdogSupervisor — quiescing stop (round-7 meta-audit)', () => {
  test('stop() does not resolve until an in-flight tick drains (no persist against a closing DB)', async () => {
    // A detector whose detect() blocks until released — stands in for a tick whose
    // persist/notify would otherwise resume after stop() against a closing DB.
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => {
      release = res
    })
    let detectCompleted = false
    const gatedDetector: WatchdogDetector = {
      kind: 'gateway_heartbeat',
      detect: async (): Promise<WatchdogAlert[]> => {
        await gate
        detectCompleted = true
        return []
      },
    }
    const supervisor = new WatchdogSupervisor({
      store: { record: async (): Promise<void> => {} } as unknown as AlertStore,
      notifier: { notify: async (): Promise<void> => {} },
      detectors: [gatedDetector],
    })

    // Drive a tick; it blocks inside detect() (in-flight).
    const tick = supervisor.runOnce()
    await Promise.resolve()
    expect(detectCompleted).toBe(false)

    // stop() must DRAIN the in-flight tick — it cannot resolve first.
    let stopResolved = false
    const stopP = supervisor.stop().then(() => {
      stopResolved = true
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(stopResolved).toBe(false)
    expect(detectCompleted).toBe(false)

    // Release → the tick completes, and ONLY THEN does stop() resolve.
    release()
    await stopP
    await tick
    expect(detectCompleted).toBe(true)
    expect(stopResolved).toBe(true)
  })
})
