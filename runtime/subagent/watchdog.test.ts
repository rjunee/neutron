import { describe, expect, test } from 'bun:test'

import { newControlState, registerCanceller } from './control.ts'
import { SubagentRegistry } from './registry.ts'
import {
  DEFAULT_STUCK_THRESHOLD_MS,
  runAgentWatchdog,
  type AgentWatchdogEvent,
} from './watchdog.ts'

/**
 * Agent-aware WATCHDOG. The generic lifecycle reaper silently cancels/marks-
 * crashed and never surfaces — a caller awaiting the run hangs forever. This
 * watchdog detects the two terminal-liveness conditions over DISPATCHED agents
 * and SURFACES each (marks failed + notifies):
 *
 *   - process_dead: pid gone before a terminal event
 *   - stuck: no progress past the per-agent-kind timeout
 */

async function liveRecord(
  registry: SubagentRegistry,
  opts: { run_id: string; agent_kind?: 'forge' | 'argus' | 'atlas' | 'sentinel' | 'core'; pid?: number; last_event_at?: number },
) {
  const rec = await registry.create({
    run_id: opts.run_id,
    instance_key: 'instance-a',
    agent_kind: opts.agent_kind ?? 'forge',
    spawn_depth: 0,
  })
  const patch: Record<string, unknown> = { status: 'running' }
  if (opts.pid !== undefined) patch.pid = opts.pid
  if (opts.last_event_at !== undefined) patch.last_event_at = opts.last_event_at
  await registry.update(rec.run_id, patch)
  return registry.byRunId(rec.run_id)!
}

describe('agent-aware watchdog — process_dead', () => {
  test('a running agent whose pid is gone is marked crashed + surfaced + notified', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    await liveRecord(registry, { run_id: 'r-dead', pid: 99999, last_event_at: 1_000 })

    const notified: AgentWatchdogEvent[] = []
    const res = await runAgentWatchdog({
      control: ctrl,
      registry,
      pid_alive: () => false, // process gone
      now: () => 2_000,
      notify: (e) => {
        notified.push(e)
      },
    })

    expect(res.surfaced).toHaveLength(1)
    const event = res.surfaced[0]!
    expect(event.reason).toBe('process_dead')
    expect(event.run_id).toBe('r-dead')
    expect(event.pid).toBe(99999)
    // The registry record is now terminal-failed with the reason recorded.
    const rec = registry.byRunId('r-dead')!
    expect(rec.status).toBe('crashed')
    expect(rec.failure_reason).toBe('process_dead')
    expect(rec.ended_at).toBe(2_000)
    // …and the notifier saw exactly that event (surfaced, not swallowed).
    expect(notified).toEqual(res.surfaced)
  })

  test('process_dead takes precedence over stuck when both hold', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    // Old last_event_at (stuck) AND a dead pid → reason must be process_dead.
    await liveRecord(registry, { run_id: 'r', pid: 5, last_event_at: 0 })
    const res = await runAgentWatchdog({
      control: ctrl,
      registry,
      pid_alive: () => false,
      now: () => DEFAULT_STUCK_THRESHOLD_MS + 10,
    })
    expect(res.surfaced[0]?.reason).toBe('process_dead')
  })
})

describe('agent-aware watchdog — stuck', () => {
  test('a running agent past its inactivity threshold is killed + surfaced', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    await liveRecord(registry, { run_id: 'r-stuck', last_event_at: 0 }) // no pid; wedged

    let killed = false
    registerCanceller(ctrl, 'r-stuck', async () => {
      killed = true
    })

    const res = await runAgentWatchdog({
      control: ctrl,
      registry,
      now: () => DEFAULT_STUCK_THRESHOLD_MS + 1,
      pid_alive: () => true, // process still alive but making no progress
    })

    expect(res.surfaced).toHaveLength(1)
    expect(res.surfaced[0]?.reason).toBe('stuck')
    expect(res.surfaced[0]?.age_ms).toBe(DEFAULT_STUCK_THRESHOLD_MS + 1)
    // The wedged process was terminated via the registered canceller.
    expect(killed).toBe(true)
    const rec = registry.byRunId('r-stuck')!
    expect(rec.status).toBe('crashed')
    expect(rec.failure_reason).toBe('stuck')
  })

  test('an agent making progress within threshold is NOT surfaced', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    await liveRecord(registry, { run_id: 'r-ok', pid: 1, last_event_at: 1_000 })
    const res = await runAgentWatchdog({
      control: ctrl,
      registry,
      now: () => 1_000 + DEFAULT_STUCK_THRESHOLD_MS - 1, // just under threshold
      pid_alive: () => true,
    })
    expect(res.surfaced).toHaveLength(0)
    expect(registry.byRunId('r-ok')?.status).toBe('running')
  })

  test('per-agent-kind thresholds override the default', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    // atlas (research) gets a long leash; argus (review) a short one.
    await liveRecord(registry, { run_id: 'atlas-1', agent_kind: 'atlas', last_event_at: 0 })
    await liveRecord(registry, { run_id: 'argus-1', agent_kind: 'argus', last_event_at: 0 })

    const res = await runAgentWatchdog({
      control: ctrl,
      registry,
      now: () => 10_000,
      pid_alive: () => true,
      stuck_threshold_ms: { atlas: 60_000, argus: 5_000 },
    })

    // At now=10_000: argus (5s) is stuck; atlas (60s) is not yet.
    const ids = res.surfaced.map((e) => e.run_id)
    expect(ids).toEqual(['argus-1'])
    expect(registry.byRunId('atlas-1')?.status).toBe('running')
    expect(registry.byRunId('argus-1')?.status).toBe('crashed')
  })

  test('a flat numeric threshold applies to every kind', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    await liveRecord(registry, { run_id: 'r', agent_kind: 'sentinel', last_event_at: 0 })
    const res = await runAgentWatchdog({
      control: ctrl,
      registry,
      now: () => 1_500,
      pid_alive: () => true,
      stuck_threshold_ms: 1_000,
    })
    expect(res.surfaced[0]?.run_id).toBe('r')
  })
})

describe('agent-aware watchdog — JSONL turn-progress is the source of truth', () => {
  // The registry's last_event_at is refreshed by registry.update() on EVERY
  // patch, so a heartbeat / queue-operation keeps it fresh while the turn is
  // wedged. The watchdog must key `stuck` off the injected turn_progress_at
  // probe (the JSONL signal), not last_event_at. Vajra incident 2026-04-21.

  test('stale JSONL + heartbeat-fresh last_event_at + live process → flagged stuck', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    const now = DEFAULT_STUCK_THRESHOLD_MS + 5_000
    // last_event_at is FRESH (a heartbeat just bumped it to ~now) — pre-fix this
    // would never look stuck. The JSONL, though, has not advanced in ages (t=0).
    await liveRecord(registry, { run_id: 'r-wedged', pid: 1, last_event_at: now - 1 })

    const res = await runAgentWatchdog({
      control: ctrl,
      registry,
      now: () => now,
      pid_alive: () => true, // process alive (port probe would say "fine")
      turn_progress_at: () => 0, // …but the transcript JSONL is stale
    })

    expect(res.surfaced).toHaveLength(1)
    const event = res.surfaced[0]!
    expect(event.reason).toBe('stuck')
    // age_ms reflects JSONL staleness (now - 0), NOT the fresh last_event_at.
    expect(event.age_ms).toBe(now)
    expect(event.turn_progress_at).toBe(0)
    expect(registry.byRunId('r-wedged')?.status).toBe('crashed')
    expect(registry.byRunId('r-wedged')?.failure_reason).toBe('stuck')
  })

  test('JSONL progressing + stale last_event_at → NOT flagged', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    // last_event_at is ANCIENT (would trip the legacy threshold), but the JSONL
    // shows the turn advanced moments ago — the agent is working, not stuck.
    await liveRecord(registry, { run_id: 'r-working', pid: 1, last_event_at: 0 })

    const res = await runAgentWatchdog({
      control: ctrl,
      registry,
      now: () => DEFAULT_STUCK_THRESHOLD_MS + 5_000,
      pid_alive: () => true,
      turn_progress_at: () => DEFAULT_STUCK_THRESHOLD_MS + 4_000, // fresh JSONL progress
    })

    expect(res.surfaced).toHaveLength(0)
    expect(registry.byRunId('r-working')?.status).toBe('running')
  })

  test('probe returns null (no transcript) → falls back to last_event_at', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    // No JSONL signal for this record → the watchdog uses last_event_at as before.
    await liveRecord(registry, { run_id: 'r-notranscript', pid: 1, last_event_at: 0 })

    const res = await runAgentWatchdog({
      control: ctrl,
      registry,
      now: () => DEFAULT_STUCK_THRESHOLD_MS + 1,
      pid_alive: () => true,
      turn_progress_at: () => null, // no transcript progress signal available
    })

    expect(res.surfaced).toHaveLength(1)
    expect(res.surfaced[0]?.reason).toBe('stuck')
    // No JSONL override → the event carries no turn_progress_at and age_ms is
    // computed from last_event_at (legacy behaviour preserved).
    expect(res.surfaced[0]?.turn_progress_at).toBeUndefined()
    expect(res.surfaced[0]?.age_ms).toBe(DEFAULT_STUCK_THRESHOLD_MS + 1)
  })

  test('process_dead still takes precedence even when JSONL looks fresh', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    await liveRecord(registry, { run_id: 'r-dead', pid: 42, last_event_at: 0 })

    const res = await runAgentWatchdog({
      control: ctrl,
      registry,
      now: () => DEFAULT_STUCK_THRESHOLD_MS + 1,
      pid_alive: () => false, // process gone
      turn_progress_at: () => DEFAULT_STUCK_THRESHOLD_MS, // JSONL "fresh" — irrelevant
    })

    expect(res.surfaced[0]?.reason).toBe('process_dead')
    expect(res.surfaced[0]?.pid).toBe(42)
  })
})

describe('agent-aware watchdog — surfacing semantics', () => {
  test('delivery_target rides along so a notice can be routed back to its origin', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    const rec = await registry.create({
      run_id: 'r',
      instance_key: 'instance-a',
      agent_kind: 'forge',
      spawn_depth: 0,
      delivery_target: { channel: 'telegram', binding_id: 'thread-77' },
    })
    await registry.update(rec.run_id, { status: 'running', pid: 1, last_event_at: 0 })

    const res = await runAgentWatchdog({
      control: ctrl,
      registry,
      now: () => DEFAULT_STUCK_THRESHOLD_MS + 1,
      pid_alive: () => true,
    })
    expect(res.surfaced[0]?.delivery_target).toEqual({ channel: 'telegram', binding_id: 'thread-77' })
  })

  test('a throwing notifier does not abort the tick or un-fail the run', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    await liveRecord(registry, { run_id: 'r1', pid: 1, last_event_at: 0 })
    await liveRecord(registry, { run_id: 'r2', pid: 2, last_event_at: 0 })

    const res = await runAgentWatchdog({
      control: ctrl,
      registry,
      now: () => DEFAULT_STUCK_THRESHOLD_MS + 1,
      pid_alive: () => true,
      notify: () => {
        throw new Error('telegram down')
      },
    })
    // Both still surfaced + marked crashed despite the notifier throwing.
    expect(res.surfaced).toHaveLength(2)
    expect(registry.byRunId('r1')?.status).toBe('crashed')
    expect(registry.byRunId('r2')?.status).toBe('crashed')
  })

  test('a run that completes WHILE the canceller awaits is not clobbered or false-surfaced', async () => {
    // Race: the watchdog judges a stuck agent and kills it, but a real
    // completion lands while the (async) canceller is in flight. failRun
    // re-checks after the await, so the legitimate `finished` survives and no
    // false failure event fires.
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    const rec = await liveRecord(registry, { run_id: 'r-finish', last_event_at: 0 })
    // The canceller yields, then a concurrent completion marks the run finished.
    registerCanceller(ctrl, rec.run_id, async () => {
      await Promise.resolve()
      registry.update(rec.run_id, { status: 'finished', ended_at: 123 })
    })

    const notified: AgentWatchdogEvent[] = []
    const res = await runAgentWatchdog({
      control: ctrl,
      registry,
      now: () => DEFAULT_STUCK_THRESHOLD_MS + 1,
      pid_alive: () => true,
      notify: (e) => {
        notified.push(e)
      },
    })

    // No surfaced event, and the real terminal status is preserved.
    expect(res.surfaced).toHaveLength(0)
    expect(notified).toHaveLength(0)
    const after = registry.byRunId('r-finish')!
    expect(after.status).toBe('finished')
    expect(after.failure_reason).toBeUndefined()
  })

  test('a healthy idle registry surfaces nothing (no false positives)', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    await liveRecord(registry, { run_id: 'fresh', pid: 1, last_event_at: 9_000 })
    const res = await runAgentWatchdog({
      control: ctrl,
      registry,
      now: () => 9_500,
      pid_alive: () => true,
    })
    expect(res.surfaced).toHaveLength(0)
  })

  test('already-terminal records are ignored (idempotent across ticks)', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    await liveRecord(registry, { run_id: 'r', pid: 9, last_event_at: 0 })
    const deps = {
      control: ctrl,
      registry,
      now: () => DEFAULT_STUCK_THRESHOLD_MS + 1,
      pid_alive: () => false,
    }
    const first = await runAgentWatchdog(deps)
    expect(first.surfaced).toHaveLength(1)
    // Second tick: the run is already crashed → nothing new surfaces.
    const second = await runAgentWatchdog(deps)
    expect(second.surfaced).toHaveLength(0)
  })
})
