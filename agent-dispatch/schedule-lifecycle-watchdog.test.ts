/**
 * @neutronai/agent-dispatch — scheduleDispatchLifecycleWatchdog (F4).
 *
 * Proves the SCHEDULED subagent lifecycle watchdog (the piece that was never
 * scheduled) actually RUNS on its tick and — NOTIFY-ONLY — emits a NON-TERMINAL
 * suspected-stuck ALERT while killing nothing and transitioning nothing:
 *   - Blocker-A: it does NOT push a terminal `crashed` report and the record
 *     stays `running`.
 *   - Blocker-C: the alert path journals a `watchdog_alert` system_event.
 * An injected interval driver runs the tick synchronously (no real timers).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  SystemEventsStore,
  emitSystemEvent,
  registerSystemEventSink,
} from '@neutronai/persistence/system-events.ts'
import { newControlState, registerCanceller } from '@neutronai/runtime/subagent/control.ts'
import { SubagentRegistry } from '@neutronai/runtime/subagent/registry.ts'
import {
  scheduleDispatchLifecycleWatchdog,
  buildDispatchStuckAlertSink,
  type DispatchSuspectedStuckAlert,
} from './watchdog-report.ts'

let db: ProjectDb | undefined
let tmp: string | undefined

afterEach(() => {
  registerSystemEventSink(null)
  db?.close()
  db = undefined
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

describe('scheduleDispatchLifecycleWatchdog (F4)', () => {
  test('Blocker-A: the scheduled tick emits a NON-TERMINAL alert, killing/transitioning NOTHING', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)

    // A live atlas dispatch stale for 10 min (> 5-min threshold).
    await registry.create({ run_id: 'r1', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
    await registry.update('r1', { status: 'running', last_event_at: Date.now() - 10 * 60_000 })

    // Register a canceller — proof-nothing-killed: it must never be invoked.
    let cancellerCalls = 0
    registerCanceller(control, 'r1', async () => {
      cancellerCalls++
    })

    const alerts: DispatchSuspectedStuckAlert[] = []
    let tickFn: (() => void) | null = null
    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      alert_sink: (a) => {
        alerts.push(a)
      },
      set_interval: (fn) => {
        tickFn = fn
        return 0 as unknown as ReturnType<typeof setInterval>
      },
      clear_interval: () => {},
    })
    expect(tickFn).not.toBeNull()

    tickFn!()
    await Bun.sleep(20)

    // The tick RAN and emitted a NON-TERMINAL suspected-stuck alert…
    expect(alerts.length).toBe(1)
    const a = alerts[0]!
    expect(a.run_id).toBe('r1')
    expect(a.agent_kind).toBe('atlas')
    expect(a.reason).toBe('stuck')
    // …the alert is NOT a terminal report: no `crashed`/`status`, and it says so.
    expect((a as unknown as { status?: unknown }).status).toBeUndefined()
    expect(a.markdown).toContain('NOT been stopped')
    expect(a.markdown).not.toContain('crashed')

    // NOTHING killed, NOTHING transitioned — the record is still live+running.
    expect(cancellerCalls).toBe(0)
    expect(registry.byRunId('r1')?.status).toBe('running')
    expect(registry.byRunId('r1')?.failure_reason).toBeUndefined()
    expect(registry.live().length).toBe(1)

    // A second tick does NOT re-alert the same still-live run (deduped).
    tickFn!()
    await Bun.sleep(20)
    expect(alerts.length).toBe(1)

    await scheduled.stop()
  })

  test('Blocker-C: a stuck dispatched subagent produces a watchdog_alert system_event', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-dispatch-o4-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
    // Wire the ambient O4 sink exactly as the gateway boot does.
    registerSystemEventSink(new SystemEventsStore({ db }))

    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    await registry.create({ run_id: 'r2', instance_key: 'owner', agent_kind: 'sentinel', spawn_depth: 0 })
    await registry.update('r2', { status: 'running', last_event_at: Date.now() - 10 * 60_000 })

    // The composer's alert sink emits `watchdog_alert` into O4 (same code path).
    let tickFn: (() => void) | null = null
    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      alert_sink: (alert) => {
        void emitSystemEvent({
          event: 'watchdog_alert',
          module: 'watchdog',
          level: 'warn',
          project_slug: 'owner',
          payload: { source: 'dispatch_lifecycle', run_id: alert.run_id, reason: alert.reason },
        })
      },
      set_interval: (fn) => {
        tickFn = fn
        return 0 as unknown as ReturnType<typeof setInterval>
      },
      clear_interval: () => {},
    })

    tickFn!()
    await Bun.sleep(40) // let the tick + the fire-and-forget O4 write settle

    const rows = db.all<{ event_name: string; module: string; payload_json: string }, []>(
      `SELECT event_name, module, payload_json FROM system_events WHERE event_name = 'watchdog_alert'`,
      [],
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.module).toBe('watchdog')
    expect(rows[0]!.payload_json).toContain('dispatch_lifecycle')
    expect(rows[0]!.payload_json).toContain('r2')

    await scheduled.stop()
  })

  test('round-4 wrapper propagation: alert_sink rejects on tick 1 → NOT latched → retried + delivered exactly once', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)

    // A live atlas dispatch stale past threshold — detected every tick until latched.
    await registry.create({ run_id: 'r3', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
    await registry.update('r3', { status: 'running', last_event_at: Date.now() - 10 * 60_000 })

    let cancellerCalls = 0
    registerCanceller(control, 'r3', async () => {
      cancellerCalls++
    })

    // The sink REJECTS the first delivery (transient O4/app-ws blip), then succeeds.
    let sinkCalls = 0
    let deliveries = 0
    let tickFn: (() => void) | null = null
    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      alert_sink: async (_a) => {
        sinkCalls++
        if (sinkCalls === 1) throw new Error('sink boom')
        deliveries++
      },
      set_interval: (fn) => {
        tickFn = fn
        return 0 as unknown as ReturnType<typeof setInterval>
      },
      clear_interval: () => {},
    })

    // Tick 1 — the wrapper PROPAGATES the rejection, so the run is NOT added to
    // `notified`. Nothing delivered, nothing killed, the tick did not wedge.
    tickFn!()
    await Bun.sleep(20)
    expect(sinkCalls).toBe(1)
    expect(deliveries).toBe(0)
    expect(cancellerCalls).toBe(0)
    expect(registry.byRunId('r3')?.status).toBe('running')

    // Tick 2 — still un-latched → rediscovered, sink recovers → delivered ONCE.
    tickFn!()
    await Bun.sleep(20)
    expect(sinkCalls).toBe(2)
    expect(deliveries).toBe(1)

    // Tick 3 — now latched → no repeat delivery (exactly-once holds).
    tickFn!()
    await Bun.sleep(20)
    expect(sinkCalls).toBe(2)
    expect(deliveries).toBe(1)
    expect(cancellerCalls).toBe(0)

    await scheduled.stop()
  })

  test('round-4 High-B single-flight: two OVERLAPPING ticks notify a still-live run exactly once', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    await registry.create({ run_id: 'r4', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
    await registry.update('r4', { status: 'running', last_event_at: Date.now() - 10 * 60_000 })

    // A DEFERRED sink: it does not resolve until released, so tick 1 stays
    // in-flight (awaiting delivery) across the moment tick 2 fires.
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => {
      release = res
    })
    let sinkCalls = 0
    let tickFn: (() => void) | null = null
    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      alert_sink: async (_a) => {
        sinkCalls++
        await gate
      },
      set_interval: (fn) => {
        tickFn = fn
        return 0 as unknown as ReturnType<typeof setInterval>
      },
      clear_interval: () => {},
    })

    // Fire twice back-to-back. Tick 1 is awaiting the gated sink (dedup ledger not
    // yet written), so a NON-single-flight loop would let tick 2 read the run as
    // un-notified and fire the sink AGAIN. The in-flight guard skips tick 2.
    tickFn!()
    tickFn!()
    await Bun.sleep(20)
    expect(sinkCalls).toBe(1) // tick 2 skipped — no duplicate notify

    // Release → tick 1 completes and latches the run in `notified`.
    release()
    await Bun.sleep(20)

    // A later, non-overlapping tick sees the run already notified → no repeat.
    tickFn!()
    await Bun.sleep(20)
    expect(sinkCalls).toBe(1)

    await scheduled.stop()
  })

  test('round-7 High-2: stop() is QUIESCING — it does not resolve until the in-flight tick drains', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    await registry.create({ run_id: 'r5', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
    await registry.update('r5', { status: 'running', last_event_at: Date.now() - 10 * 60_000 })

    // A DEFERRED sink holds the tick in-flight until released — this stands in for
    // registry pruning / persistence that must NOT resume against a closing DB.
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => {
      release = res
    })
    let tickCompleted = false
    let tickFn: (() => void) | null = null
    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      alert_sink: async (_a) => {
        await gate
        tickCompleted = true
      },
      set_interval: (fn) => {
        tickFn = fn
        return 0 as unknown as ReturnType<typeof setInterval>
      },
      clear_interval: () => {},
    })

    // Start a tick; it blocks inside the gated sink (in-flight, not yet done).
    tickFn!()
    await Bun.sleep(10)
    expect(tickCompleted).toBe(false)

    // stop() must NOT resolve while a tick is in-flight — it DRAINS it first. The
    // gateway awaits this before db.close(), so no post-close DB access occurs.
    let stopResolved = false
    const stopPromise = scheduled.stop().then(() => {
      stopResolved = true
    })
    await Bun.sleep(10)
    expect(stopResolved).toBe(false) // still draining the in-flight tick
    expect(tickCompleted).toBe(false)

    // Release the tick → it completes, and ONLY THEN does stop() resolve.
    release()
    await stopPromise
    expect(tickCompleted).toBe(true)
    expect(stopResolved).toBe(true)
  })
})

describe('buildDispatchStuckAlertSink — persist-before-deliver (round-9)', () => {
  const alert: DispatchSuspectedStuckAlert = {
    run_id: 'r1',
    agent_kind: 'atlas',
    reason: 'stuck',
    age_ms: 1,
    markdown: 'x',
  }

  test('journal record() rejects → NO visible push; on retry the push lands EXACTLY ONCE', async () => {
    let journalCalls = 0
    let pushCalls = 0
    const sink = buildDispatchStuckAlertSink({
      // The durable journal REJECTS on the first call, then succeeds.
      journal: async (): Promise<void> => {
        journalCalls++
        if (journalCalls === 1) throw new Error('journal down')
      },
      // The user-visible push always "succeeds" — the mutation check: with the OLD
      // send-then-record order this counter would reach 2 (fires on both ticks).
      push: (): void => {
        pushCalls++
      },
    })

    // Tick 1 — journal rejects → the sink rejects BEFORE any push (persist-first),
    // so the watchdog leaves the run un-latched and the user sees NOTHING yet.
    await expect(sink(alert)).rejects.toThrow('journal down')
    expect(pushCalls).toBe(0)

    // Tick 2 (retry) — journal commits → the push fires. EXACTLY ONCE across both.
    await sink(alert)
    expect(pushCalls).toBe(1)
    expect(journalCalls).toBe(2)
  })

  test('a push that throws is swallowed (journal already committed → alert stays latched)', async () => {
    const sink = buildDispatchStuckAlertSink({
      journal: async (): Promise<void> => {},
      push: (): void => {
        throw new Error('dead socket')
      },
    })
    // A dead socket must NOT propagate — the durable journal already committed, so
    // re-throwing would wrongly un-latch and re-journal.
    await expect(Promise.resolve(sink(alert))).resolves.toBeUndefined()
  })

  test('integration: journal rejects tick 1 → the VISIBLE push is delivered EXACTLY ONCE across retry ticks', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    await registry.create({ run_id: 'r7', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
    await registry.update('r7', { status: 'running', last_event_at: Date.now() - 10 * 60_000 })

    let journalCalls = 0
    let pushCalls = 0
    const sink = buildDispatchStuckAlertSink({
      journal: async (): Promise<void> => {
        journalCalls++
        if (journalCalls === 1) throw new Error('journal down')
      },
      push: (): void => {
        pushCalls++
      },
    })

    let tickFn: (() => void) | null = null
    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      alert_sink: sink,
      set_interval: (fn) => {
        tickFn = fn
        return 0 as unknown as ReturnType<typeof setInterval>
      },
      clear_interval: () => {},
    })

    // Tick 1 — journal rejects → run NOT latched, NO visible push.
    tickFn!()
    await Bun.sleep(20)
    expect(journalCalls).toBe(1)
    expect(pushCalls).toBe(0)

    // Tick 2 — journal commits → the visible push fires once, run latched.
    tickFn!()
    await Bun.sleep(20)
    expect(pushCalls).toBe(1)

    // Tick 3 — latched → no repeat visible push (exactly-once holds).
    tickFn!()
    await Bun.sleep(20)
    expect(pushCalls).toBe(1)

    await scheduled.stop()
  })
})
