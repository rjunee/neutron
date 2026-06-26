/**
 * @neutronai/agent-dispatch — watchdog → report-back adapter tests.
 *
 * The supervised-failure half of report-back: a stuck/dead dispatch reaped by
 * the agent-aware watchdog must surface through the SAME report sink a clean
 * completion does — and a forge/argus (Trident) event must NOT.
 */

import { describe, expect, test } from 'bun:test'

import type { AgentWatchdogEvent } from '../runtime/subagent/index.ts'
import { buildDispatchWatchdogNotifier, type DispatchReport } from './index.ts'

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
