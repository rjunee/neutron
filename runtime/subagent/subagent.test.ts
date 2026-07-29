import { describe, expect, test } from 'bun:test'

import {
  MAX_CHILDREN_PER_AGENT,
  MAX_CONCURRENT_SUBAGENTS,
  MAX_SPAWN_DEPTH,
  SubagentRegistry,
  cancelRun,
  formatAnnouncement,
  newControlState,
  registerCanceller,
  renderAnnouncementMarkdown,
  runLifecycleTick,
  spawnSubagent,
  statusOf,
  STALE_THRESHOLD_MS,
} from './index.ts'

const validClaims = {
  instance: 'instance-a',
  depth: MAX_SPAWN_DEPTH,
  scope: ['agent:dispatch_subagent'],
  jti: 'jti-1',
}

describe('subagent registry + spawn', () => {
  test('spawn at top level (no parent) succeeds with depth=0', async () => {
    const registry = new SubagentRegistry()
    const rec = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'run-top' },
    )
    expect(rec.run_id).toBe('run-top')
    expect(rec.spawn_depth).toBe(0)
    expect(rec.status).toBe('pending')
  })

  test('nested spawn requires a delegation token', async () => {
    const registry = new SubagentRegistry()
    const parent = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'run-parent' },
    )
    await expect(
      spawnSubagent(
        { parent_run_id: parent.run_id, instance_key: 'instance-a', agent_kind: 'atlas' },
        { registry, verify_delegation: async () => validClaims },
      ),
    ).rejects.toThrow(/requires a signed delegation token/)
  })

  test('nested spawn at MAX_SPAWN_DEPTH succeeds', async () => {
    const registry = new SubagentRegistry()
    const parent = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'p' },
    )
    const child = await spawnSubagent(
      {
        parent_run_id: parent.run_id,
        instance_key: 'instance-a',
        agent_kind: 'atlas',
        delegation_token: 'tok',
      },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'c' },
    )
    expect(child.spawn_depth).toBe(1)
    expect(child.spawn_depth).toBe(MAX_SPAWN_DEPTH)
  })

  test('nested spawn beyond MAX_SPAWN_DEPTH rejects', async () => {
    const registry = new SubagentRegistry()
    const parent = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'p' },
    )
    const child = await spawnSubagent(
      {
        parent_run_id: parent.run_id,
        instance_key: 'instance-a',
        agent_kind: 'atlas',
        delegation_token: 'tok',
      },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'c' },
    )
    await expect(
      spawnSubagent(
        {
          parent_run_id: child.run_id,
          instance_key: 'instance-a',
          agent_kind: 'argus',
          delegation_token: 'tok',
        },
        { registry, verify_delegation: async () => validClaims },
      ),
    ).rejects.toThrow(/exceeds MAX_SPAWN_DEPTH/)
  })

  test('delegation instance mismatch rejects', async () => {
    const registry = new SubagentRegistry()
    const parent = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'p' },
    )
    await expect(
      spawnSubagent(
        {
          parent_run_id: parent.run_id,
          instance_key: 'instance-a',
          agent_kind: 'atlas',
          delegation_token: 'wrong-instance-tok',
        },
        {
          registry,
          verify_delegation: async () => ({ ...validClaims, instance: 'instance-b' }),
        },
      ),
    ).rejects.toThrow(/instance.*instance-b.*instance-a/)
  })

  test('global concurrency cap blocks new spawns', async () => {
    const registry = new SubagentRegistry()
    for (let i = 0; i < MAX_CONCURRENT_SUBAGENTS; i++) {
      // eslint-disable-next-line no-await-in-loop
      await spawnSubagent(
        { instance_key: 'instance-a', agent_kind: 'forge' },
        {
          registry,
          verify_delegation: async () => validClaims,
          mint_run_id: () => `r-${i}`,
        },
      )
    }
    await expect(
      spawnSubagent(
        { instance_key: 'instance-a', agent_kind: 'forge' },
        { registry, verify_delegation: async () => validClaims },
      ),
    ).rejects.toThrow(/global concurrency cap hit/)
  })

  test('per-parent child cap blocks beyond MAX_CHILDREN_PER_AGENT', async () => {
    const registry = new SubagentRegistry()
    const parent = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'p' },
    )
    for (let i = 0; i < MAX_CHILDREN_PER_AGENT; i++) {
      // eslint-disable-next-line no-await-in-loop
      await spawnSubagent(
        {
          parent_run_id: parent.run_id,
          instance_key: 'instance-a',
          agent_kind: 'atlas',
          delegation_token: 'tok',
        },
        { registry, verify_delegation: async () => validClaims, mint_run_id: () => `c-${i}` },
      )
    }
    await expect(
      spawnSubagent(
        {
          parent_run_id: parent.run_id,
          instance_key: 'instance-a',
          agent_kind: 'atlas',
          delegation_token: 'tok',
        },
        { registry, verify_delegation: async () => validClaims },
      ),
    ).rejects.toThrow(/already has 5 live children/)
  })
})

describe('control: cancelRun + statusOf', () => {
  test('cancelRun calls registered canceller and marks cancelled', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    const rec = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'r' },
    )
    let cancelled = false
    registerCanceller(ctrl, rec.run_id, async () => {
      cancelled = true
    })
    registry.update(rec.run_id, { status: 'running' })
    await cancelRun(ctrl, rec.run_id)
    expect(cancelled).toBe(true)
    expect(statusOf(ctrl, rec.run_id)?.status).toBe('cancelled')
  })

  test('cancelRun on already-finished run is a no-op', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    const rec = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'r' },
    )
    registry.update(rec.run_id, { status: 'finished', ended_at: Date.now() })
    let called = 0
    registerCanceller(ctrl, rec.run_id, async () => {
      called++
    })
    await cancelRun(ctrl, rec.run_id)
    expect(called).toBe(0)
  })

  test('canceller throw is swallowed; run is still marked cancelled', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    const rec = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'r' },
    )
    registry.update(rec.run_id, { status: 'running' })
    registerCanceller(ctrl, rec.run_id, async () => {
      throw new Error('canceller failure')
    })
    await cancelRun(ctrl, rec.run_id)
    expect(statusOf(ctrl, rec.run_id)?.status).toBe('cancelled')
  })
})

describe('lifecycle prune pass', () => {
  // Liveness reaping (stale-`running` → cancelled, pid-gone → crashed) moved to
  // the agent-aware watchdog, which SURFACES instead of silently reaping — see
  // watchdog.test.ts. runLifecycleTick now only prunes terminal records, so the
  // two never race over the same `running` record.
  test('prunes records past cleanup_after', async () => {
    const registry = new SubagentRegistry()
    const rec = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'r' },
    )
    registry.update(rec.run_id, {
      status: 'finished',
      ended_at: 0,
      cleanup_after: 100,
    })
    const affected = await runLifecycleTick({ registry, now: () => 1000 })
    expect(affected).toBeGreaterThanOrEqual(1)
    expect(registry.byRunId(rec.run_id)).toBeUndefined()
  })

  test('prune-only mode (no watchdog deps) leaves a live record untouched', async () => {
    const registry = new SubagentRegistry()
    const rec = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'r' },
    )
    // Stale + a would-be-gone pid, but a prune-only tick does not reap liveness.
    registry.update(rec.run_id, { status: 'running', last_event_at: 0, pid: 99999 })
    const affected = await runLifecycleTick({ registry, now: () => STALE_THRESHOLD_MS + 1 })
    expect(affected).toBe(0)
    expect(registry.byRunId(rec.run_id)?.status).toBe('running')
  })

  test('composed tick: surfaces a stale agent via the watchdog AND prunes, in one pass', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    // A stale live agent that the watchdog phase should surface…
    const stale = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'stale' },
    )
    registry.update(stale.run_id, { status: 'running', last_event_at: 0 })
    registerCanceller(ctrl, stale.run_id, async () => {})
    // …and a terminal record the prune phase should delete.
    const done = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'done' },
    )
    registry.update(done.run_id, { status: 'finished', ended_at: 0, cleanup_after: 100 })

    const surfaced: string[] = []
    const affected = await runLifecycleTick({
      registry,
      now: () => STALE_THRESHOLD_MS + 1,
      watchdog: {
        control: ctrl,
        pid_alive: () => true,
        notify: (e) => {
          surfaced.push(e.run_id)
        },
      },
    })

    // Watchdog surfaced the stale agent (marked crashed + notified)…
    expect(surfaced).toEqual(['stale'])
    expect(statusOf(ctrl, 'stale')?.status).toBe('crashed')
    expect(statusOf(ctrl, 'stale')?.failure_reason).toBe('stuck')
    // …and the prune phase deleted the terminal record.
    expect(registry.byRunId('done')).toBeUndefined()
    expect(affected).toBe(2) // 1 surfaced + 1 pruned
  })

  test('the JSONL turn_progress_at probe flows through to the watchdog (prod wiring is config, not code)', async () => {
    // The lifecycle tick threads its `watchdog` deps straight into
    // runAgentWatchdog, so a production caller wires the JSONL source-of-truth
    // probe (makeJsonlTurnProgressProbe) here with no watchdog code change.
    // Proof: a heartbeat-fresh last_event_at no longer hides a wedge once the
    // probe reports a stale JSONL timestamp.
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    const wedged = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'wedged' },
    )
    const now = STALE_THRESHOLD_MS + 10_000
    registry.update(wedged.run_id, { status: 'running', last_event_at: now - 1 }) // heartbeat-fresh
    registerCanceller(ctrl, wedged.run_id, async () => {})

    const surfaced: string[] = []
    await runLifecycleTick({
      registry,
      now: () => now,
      watchdog: {
        control: ctrl,
        pid_alive: () => true,
        turn_progress_at: () => 0, // stale JSONL — the source of truth
        notify: (e) => {
          surfaced.push(e.run_id)
        },
      },
    })

    expect(surfaced).toEqual(['wedged'])
    expect(statusOf(ctrl, 'wedged')?.failure_reason).toBe('stuck')
  })
})

describe('announce', () => {
  test('formatAnnouncement extracts duration and renders markdown', async () => {
    const registry = new SubagentRegistry()
    const r = await registry.create({
      run_id: 'r',
      instance_key: 't',
      agent_kind: 'forge',
      spawn_depth: 0,
    })
    await registry.update(r.run_id, { status: 'finished', ended_at: r.started_at + 5000 })
    const updated = registry.byRunId(r.run_id)!
    const a = formatAnnouncement({ record: updated, summary: 'Done.', deliverables: ['PR #99'] })
    expect(a.duration_ms).toBe(5000)
    const md = renderAnnouncementMarkdown(a)
    expect(md).toContain('### Subagent forge (finished)')
    expect(md).toContain('PR #99')
  })
})
