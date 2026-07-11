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

    scheduled.stop()
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

    scheduled.stop()
  })
})
