/**
 * @neutronai/agent-dispatch — watchdog → report-back adapter tests.
 *
 * The supervised-failure half of report-back: a stuck/dead dispatch reaped by
 * the agent-aware watchdog must surface through the SAME report sink a clean
 * completion does — and a forge/argus (Trident) event must NOT.
 */

import { describe, expect, test } from 'bun:test'

import {
  SubagentRegistry,
  newControlState,
  runAgentWatchdog,
  type AgentWatchdogEvent,
  type SubagentRecord,
} from '@neutronai/runtime/subagent/index.ts'
import { buildBootSweepReport, buildDispatchWatchdogNotifier, type DispatchReport } from './index.ts'
import { scheduleDispatchLifecycleWatchdog } from './watchdog-report.ts'
import { LoopRegistry } from '@neutronai/loop'

function event(over: Partial<AgentWatchdogEvent>): AgentWatchdogEvent {
  return {
    run_id: 'run-1',
    agent_kind: 'atlas',
    instance_key: 'inst-a',
    reason: 'stuck',
    last_event_at: 0,
    detected_at: 600_000,
    age_ms: 600_000,
    ...over,
  }
}

describe('buildDispatchWatchdogNotifier', () => {
  test('surfaces a reaped dispatch as a crashed report (research)', async () => {
    const reports: DispatchReport[] = []
    const notify = buildDispatchWatchdogNotifier((r) => {
      reports.push(r)
    })
    await notify(event({ agent_kind: 'atlas', reason: 'stuck' }))
    expect(reports).toHaveLength(1)
    expect(reports[0]!.kind).toBe('research')
    expect(reports[0]!.status).toBe('crashed')
    expect(reports[0]!.markdown).toContain('stuck')
  })

  test('maps sentinel → review and core → adhoc, carrying the delivery target', async () => {
    const reports: DispatchReport[] = []
    const notify = buildDispatchWatchdogNotifier((r) => {
      reports.push(r)
    })
    await notify(event({ agent_kind: 'sentinel' }))
    await notify(
      event({
        agent_kind: 'core',
        reason: 'process_dead',
        delivery_target: { channel: 'app_socket', binding_id: 'b1' },
      }),
    )
    expect(reports.map((r) => r.kind)).toEqual(['review', 'adhoc'])
    expect(reports[1]!.delivery_target).toEqual({ channel: 'app_socket', binding_id: 'b1' })
  })

  test('skips a forge/argus event — those belong to the Trident loop', async () => {
    const reports: DispatchReport[] = []
    const notify = buildDispatchWatchdogNotifier((r) => {
      reports.push(r)
    })
    await notify(event({ agent_kind: 'forge' }))
    await notify(event({ agent_kind: 'argus' }))
    expect(reports).toHaveLength(0)
  })

  test('a throwing report sink does not propagate out of the notifier', async () => {
    const notify = buildDispatchWatchdogNotifier(() => {
      throw new Error('sink down')
    })
    await expect(notify(event({}))).resolves.toBeUndefined()
  })
})

describe('buildBootSweepReport — age matches a live watchdog reap for the same record', () => {
  // A boot-reaped orphan must surface EXACTLY like a live watchdog reap, including
  // its reported age. With DISTINCT start vs progress timestamps the two formulas
  // diverge if the adapter uses `started_at`: the live watchdog reports
  // `detected_at - last_event_at`, so the boot adapter must too — not
  // `detected_at - started_at` (which over-reports by the whole run duration).
  test('boot-reap age == live-watchdog age (progress-based, NOT started_at-based)', async () => {
    // started_at=0 (spawn), last_event_at=900 (last progress), detected at 1000.
    // Progress-based age = 1000 - 900 = 100. started_at-based age = 1000 - 0 = 1000.
    const STARTED_AT = 0
    const LAST_EVENT_AT = 900
    const DETECTED_AT = 1000
    const PROGRESS_AGE = DETECTED_AT - LAST_EVENT_AT // 100 — the correct age
    const STARTED_AGE = DETECTED_AT - STARTED_AT // 1000 — the WRONG (old) age

    // LIVE watchdog age for the same timestamps: a dead pid past its last progress.
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    await registry.create({ run_id: 'r', instance_key: 'inst-a', agent_kind: 'atlas', spawn_depth: 0 })
    await registry.update('r', { status: 'running', last_event_at: LAST_EVENT_AT, pid: 99999 })
    const live = await runAgentWatchdog({
      control: ctrl,
      registry,
      pid_alive: () => false, // process_dead → surfaces regardless of the stuck threshold
      now: () => DETECTED_AT,
    })
    const liveAge = live.surfaced[0]!.age_ms
    expect(liveAge).toBe(PROGRESS_AGE)

    // BOOT-reap age for a hand-built orphan with the same start/progress/detect.
    const orphan: SubagentRecord = {
      run_id: 'r',
      instance_key: 'inst-a',
      agent_kind: 'atlas',
      spawn_depth: 0,
      status: 'running',
      started_at: STARTED_AT,
      last_event_at: LAST_EVENT_AT,
      ended_at: DETECTED_AT,
    }
    const reports: DispatchReport[] = []
    await buildBootSweepReport((r) => {
      reports.push(r)
    })(orphan)
    const bootAge = Number(/age at reap: (\d+)ms/.exec(reports[0]!.markdown)![1])

    expect(bootAge).toBe(liveAge) // parity: boot reap age == live reap age
    expect(bootAge).toBe(PROGRESS_AGE)
    expect(bootAge).not.toBe(STARTED_AGE) // NOT the old started_at-based over-report
  })
})

describe('§F2 — lifecycle watchdog registration is failure-atomic (defect #2)', () => {
  test('a colliding registry registration STOPS the self-started loop (no timer leak)', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    let cleared = false
    // The lifecycle watchdog self-STARTS in its factory (arms the fake interval),
    // so register-before-start is impossible — the composer wraps register in a
    // try/catch that STOPS the loop on failure. Reproduce that exact wrap here.
    const wd = scheduleDispatchLifecycleWatchdog({
      registry,
      control: ctrl,
      alert_sink: () => {},
      set_interval: () => 1,
      clear_interval: () => {
        cleared = true
      },
    })
    const loopRegistry = new LoopRegistry()
    loopRegistry.register({
      name: 'dispatch-lifecycle-watchdog',
      cadenceMs: 60_000,
      startedAt: 1,
      health: () => ({ lastTickAt: null, lastError: null }),
    })
    let threw = false
    try {
      loopRegistry.register(wd.describe())
    } catch {
      await wd.stop() // the composer's catch — stop the just-started loop
      threw = true
    }
    expect(threw).toBe(true)
    // stop() cleared the interval → the just-started loop was stopped, no leak.
    expect(cleared).toBe(true)
  })
})
