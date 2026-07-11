/**
 * @neutronai/runtime/subagent — NOTIFY-ONLY watchdog mode (F4).
 *
 * F4 schedules the subagent lifecycle watchdog in NOTIFY-ONLY mode: it DETECTS a
 * stuck/dead dispatch and NOTIFIES, but reaps NOTHING — no canceller is invoked
 * (nothing killed) and no record is transitioned (no control-flow change).
 * Enforcement (killing a wedged dispatch) is a separate flagged PR.
 *
 * These tests are the PROOF-NOTHING-IS-KILLED gate: they assert the canceller is
 * never called and the record stays live under `notify_only`.
 */

import { describe, expect, test } from 'bun:test'
import { newControlState, registerCanceller } from './control.ts'
import { SubagentRegistry } from './registry.ts'
import { runAgentWatchdog, type AgentWatchdogEvent } from './watchdog.ts'

async function seedRunning(
  registry: SubagentRegistry,
  run_id: string,
  last_event_at: number,
): Promise<void> {
  await registry.create({ run_id, instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
  await registry.update(run_id, { status: 'running', last_event_at })
}

describe('runAgentWatchdog — notify_only mode (F4)', () => {
  test('DETECTS a stuck run and NOTIFIES, but does NOT kill it or transition it', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    const now = 1_000_000

    await seedRunning(registry, 'stuck-1', now - 10 * 60_000) // 10 min stale > 5 min threshold

    // Register a canceller and prove it is NEVER invoked (nothing killed).
    let cancellerCalls = 0
    registerCanceller(control, 'stuck-1', async () => {
      cancellerCalls++
    })

    const surfaced: AgentWatchdogEvent[] = []
    const { surfaced: out } = await runAgentWatchdog({
      control,
      registry,
      now: () => now,
      notify_only: true,
      notify: (e) => {
        surfaced.push(e)
      },
    })

    // Notified…
    expect(out.length).toBe(1)
    expect(surfaced.length).toBe(1)
    expect(surfaced[0]!.run_id).toBe('stuck-1')
    expect(surfaced[0]!.reason).toBe('stuck')

    // …but NOTHING killed: the canceller was never invoked.
    expect(cancellerCalls).toBe(0)

    // …and NO control-flow change: the record is STILL running (not crashed).
    expect(registry.byRunId('stuck-1')?.status).toBe('running')
    expect(registry.byRunId('stuck-1')?.failure_reason).toBeUndefined()
    expect(registry.live().length).toBe(1)
  })

  test('a process_dead run under notify_only is surfaced but not transitioned', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    const now = 2_000_000

    await registry.create({ run_id: 'dead-1', instance_key: 'owner', agent_kind: 'atlas', spawn_depth: 0 })
    await registry.update('dead-1', { status: 'running', pid: 424242, last_event_at: now })

    let cancellerCalls = 0
    registerCanceller(control, 'dead-1', async () => {
      cancellerCalls++
    })

    const { surfaced } = await runAgentWatchdog({
      control,
      registry,
      now: () => now,
      notify_only: true,
      pid_alive: () => false, // pid gone
    })

    expect(surfaced.length).toBe(1)
    expect(surfaced[0]!.reason).toBe('process_dead')
    expect(cancellerCalls).toBe(0)
    expect(registry.byRunId('dead-1')?.status).toBe('running') // NOT crashed
  })

  test('the notified ledger suppresses the every-tick repeat for a still-live run', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    const now = 3_000_000
    await seedRunning(registry, 'stuck-2', now - 10 * 60_000)

    const notified = new Set<string>()
    let notifyCount = 0
    const deps = {
      control,
      registry,
      now: () => now,
      notify_only: true,
      notified,
      notify: () => {
        notifyCount++
      },
    }

    await runAgentWatchdog(deps)
    await runAgentWatchdog(deps)
    await runAgentWatchdog(deps)

    // Detected every tick (still live) but notified exactly once (deduped).
    expect(notifyCount).toBe(1)
    expect(notified.has('stuck-2')).toBe(true)
    // Still not killed / transitioned across all three ticks.
    expect(registry.byRunId('stuck-2')?.status).toBe('running')
  })

  test('a throwing notifier does NOT break the tick and does NOT transition the run', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    const now = 4_000_000
    await seedRunning(registry, 'stuck-3', now - 10 * 60_000)
    let cancellerCalls = 0
    registerCanceller(control, 'stuck-3', async () => {
      cancellerCalls++
    })

    const { surfaced } = await runAgentWatchdog({
      control,
      registry,
      now: () => now,
      notify_only: true,
      notify: () => {
        throw new Error('sink boom')
      },
    })

    // The throw was swallowed — the run was still surfaced, nothing killed.
    expect(surfaced.length).toBe(1)
    expect(cancellerCalls).toBe(0)
    expect(registry.byRunId('stuck-3')?.status).toBe('running')
  })

  test('Blocker-2: stale → healthy → stale RE-NOTIFIES (a second incident is not lost)', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    const notified = new Set<string>()
    let notifyCount = 0
    const base = {
      control,
      registry,
      notify_only: true as const,
      notified,
      notify: () => {
        notifyCount++
      },
    }

    // Tick 1 — the run is STALE → notify (incident 1).
    await seedRunning(registry, 'r1', 0)
    await runAgentWatchdog({ ...base, now: () => 10 * 60_000 })
    expect(notifyCount).toBe(1)
    expect(notified.has('r1')).toBe(true)

    // Tick 2 — the run made progress (healthy again) → cleared from `notified`.
    await registry.update('r1', { last_event_at: 20 * 60_000 })
    await runAgentWatchdog({ ...base, now: () => 20 * 60_000 })
    expect(notifyCount).toBe(1) // no new notify on a healthy tick
    expect(notified.has('r1')).toBe(false) // recovery cleared the mark

    // Tick 3 — it wedges AGAIN → a genuine second incident re-notifies.
    await runAgentWatchdog({ ...base, now: () => 30 * 60_000 })
    expect(notifyCount).toBe(2)
    expect(registry.byRunId('r1')?.status).toBe('running') // still nothing killed
  })

  test('Blocker-2: a run that leaves live() is pruned from the notified ledger', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    const notified = new Set<string>()
    await seedRunning(registry, 'r1', 0)
    await runAgentWatchdog({
      control,
      registry,
      now: () => 10 * 60_000,
      notify_only: true,
      notified,
      notify: () => {},
    })
    expect(notified.has('r1')).toBe(true)

    // The run reaches a terminal state (a normal completion) → leaves live().
    await registry.updateTerminal('r1', { status: 'finished', ended_at: 11 * 60_000 })
    await runAgentWatchdog({
      control,
      registry,
      now: () => 12 * 60_000,
      notify_only: true,
      notified,
      notify: () => {},
    })
    // Pruned — the ledger doesn't grow unbounded with dead run_ids.
    expect(notified.has('r1')).toBe(false)
  })

  test('enforcing mode (default) STILL reaps — notify_only is opt-in', async () => {
    const registry = new SubagentRegistry()
    const control = newControlState(registry)
    const now = 5_000_000
    await seedRunning(registry, 'stuck-4', now - 10 * 60_000)
    let cancellerCalls = 0
    registerCanceller(control, 'stuck-4', async () => {
      cancellerCalls++
    })

    // No notify_only → legacy reaping behaviour is unchanged.
    const { surfaced } = await runAgentWatchdog({ control, registry, now: () => now })
    expect(surfaced.length).toBe(1)
    expect(cancellerCalls).toBe(1) // killed
    expect(registry.byRunId('stuck-4')?.status).toBe('crashed') // transitioned
  })
})
