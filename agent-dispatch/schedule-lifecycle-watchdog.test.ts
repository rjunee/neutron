/**
 * @neutronai/agent-dispatch — scheduleDispatchLifecycleWatchdog (F4).
 *
 * Proves the SCHEDULED subagent lifecycle watchdog (the piece that was never
 * scheduled) actually RUNS on its tick, NOTIFIES a stuck dispatch through the
 * report surface, and — NOTIFY-ONLY — kills nothing and transitions nothing.
 * An injected interval driver runs the tick synchronously so the test is
 * hermetic (no real timers).
 */

import { describe, expect, test } from 'bun:test'
import { newControlState, registerCanceller } from '@neutronai/runtime/subagent/control.ts'
import { SubagentRegistry } from '@neutronai/runtime/subagent/registry.ts'
import type { DispatchReport } from './service.ts'
import { scheduleDispatchLifecycleWatchdog } from './watchdog-report.ts'

describe('scheduleDispatchLifecycleWatchdog (F4)', () => {
  test('the scheduled tick RUNS, reports a stuck dispatch, and kills NOTHING', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)

    // A live atlas dispatch that has been stale for 10 min (> 5-min threshold).
    await registry.create({ run_id: 'r1', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
    await registry.update('r1', { status: 'running', last_event_at: Date.now() - 10 * 60_000 })

    // Register a canceller — proof-nothing-killed: it must never be invoked.
    let cancellerCalls = 0
    registerCanceller(control, 'r1', async () => {
      cancellerCalls++
    })

    const reports: DispatchReport[] = []
    // Capture the interval callback so we can drive the tick ourselves.
    let tickFn: (() => void) | null = null
    const scheduled = scheduleDispatchLifecycleWatchdog({
      registry,
      control,
      report: (r) => {
        reports.push(r)
      },
      set_interval: (fn) => {
        tickFn = fn
        return 0 as unknown as ReturnType<typeof setInterval>
      },
      clear_interval: () => {},
    })

    expect(tickFn).not.toBeNull()

    // Drive one scheduled tick + let the async runLifecycleTick settle.
    tickFn!()
    await Bun.sleep(20)

    // The tick RAN and reported the stuck dispatch as crashed (surfacing).
    expect(reports.length).toBe(1)
    expect(reports[0]!.run_id).toBe('r1')
    expect(reports[0]!.agent_kind).toBe('atlas')
    expect(reports[0]!.status).toBe('crashed') // report label; the RECORD is untouched (below)

    // NOTIFY-ONLY: nothing killed, nothing transitioned.
    expect(cancellerCalls).toBe(0)
    expect(registry.byRunId('r1')?.status).toBe('running')
    expect(registry.live().length).toBe(1)

    // A second tick does NOT re-report the same still-live run (deduped).
    tickFn!()
    await Bun.sleep(20)
    expect(reports.length).toBe(1)

    scheduled.stop()
  })
})
