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

describe('WatchdogSupervisor — exactly-once across a failing commit (round-8)', () => {
  test('a THROWING detector.commit() does NOT redeliver the notification', async () => {
    const notified: WatchdogAlert[] = []
    let commitCalls = 0
    const alertId = 'db_lock_contention:owner:1'
    // A persistent condition that yields the SAME candidate every tick (as a real
    // detector does while its incident stays un-committed), whose commit() ALWAYS
    // throws — so the incident never latches.
    const throwingCommitDetector: WatchdogDetector = {
      kind: 'db_lock_contention',
      detect: async (): Promise<WatchdogAlert[]> => [
        {
          id: alertId,
          kind: 'db_lock_contention',
          project_slug: 'owner',
          detected_at: 1,
          resolved_at: null,
          payload: {},
        },
      ],
      commit: (): void => {
        commitCalls++
        throw new Error('commit boom')
      },
    }
    const supervisor = new WatchdogSupervisor({
      store: { record: async (): Promise<void> => {} } as unknown as AlertStore,
      notifier: { notify: async (a): Promise<void> => { notified.push(a) } },
      detectors: [throwingCommitDetector],
    })

    // Tick 1 — persist + notify succeed, commit throws → notified ONCE, not latched.
    const t1 = await supervisor.runOnce()
    expect(t1.length).toBe(1)
    expect(notified.length).toBe(1)
    expect(commitCalls).toBe(1)

    // Tick 2 — the same candidate reappears (never latched). The deliveredIds guard
    // RE-COMMITS only — it must NOT re-persist or re-notify. Exactly ONE notification.
    const t2 = await supervisor.runOnce()
    expect(t2.length).toBe(0)
    expect(notified.length).toBe(1) // <-- exactly-once preserved across the commit failure
    expect(commitCalls).toBe(2) // commit retried (surfaced, not silently dropped)

    // Tick 3 — still failing → still exactly one notification.
    await supervisor.runOnce()
    expect(notified.length).toBe(1)
    expect(commitCalls).toBe(3)
  })

  test('a commit that recovers latches cleanly with no re-notify (delivered exactly once)', async () => {
    const notified: WatchdogAlert[] = []
    let failCommit = true
    let committed = false
    const alertId = 'db_lock_contention:owner:2'
    const detector: WatchdogDetector = {
      kind: 'db_lock_contention',
      // Keeps yielding the candidate until it is successfully committed, then goes
      // quiet — exactly how IncidentEdgeTracker.candidates() behaves.
      detect: async (): Promise<WatchdogAlert[]> =>
        committed
          ? []
          : [
              {
                id: alertId,
                kind: 'db_lock_contention',
                project_slug: 'owner',
                detected_at: 1,
                resolved_at: null,
                payload: {},
              },
            ],
      commit: (): void => {
        if (failCommit) throw new Error('transient commit failure')
        committed = true
      },
    }
    const supervisor = new WatchdogSupervisor({
      store: { record: async (): Promise<void> => {} } as unknown as AlertStore,
      notifier: { notify: async (a): Promise<void> => { notified.push(a) } },
      detectors: [detector],
    })

    // Tick 1 — notify once, commit throws (un-latched).
    await supervisor.runOnce()
    expect(notified.length).toBe(1)

    // Tick 2 — commit now succeeds via the re-commit branch → no re-notify.
    failCommit = false
    await supervisor.runOnce()
    expect(notified.length).toBe(1)

    // Tick 3 — incident is committed + quiet → nothing, still exactly one.
    await supervisor.runOnce()
    expect(notified.length).toBe(1)
  })
})
