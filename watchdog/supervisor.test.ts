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
import type { WatchdogAlert } from './types.ts'

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
