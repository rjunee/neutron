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

describe('lifecycle watchdog', () => {
  test('reaps stale running record by cancelling it', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    const rec = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'r' },
    )
    registry.update(rec.run_id, { status: 'running', last_event_at: 0 })
    registerCanceller(ctrl, rec.run_id, async () => {})
    const affected = await runLifecycleTick({
      control: ctrl,
      registry,
      now: () => STALE_THRESHOLD_MS + 1,
      pid_alive: () => true,
    })
    expect(affected).toBeGreaterThanOrEqual(1)
    expect(statusOf(ctrl, rec.run_id)?.status).toBe('cancelled')
  })

  test('marks crashed when pid is no longer alive', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    const rec = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'r' },
    )
    registry.update(rec.run_id, { status: 'running', pid: 99999 })
    await runLifecycleTick({
      control: ctrl,
      registry,
      now: () => Date.now(),
      pid_alive: () => false,
    })
    expect(statusOf(ctrl, rec.run_id)?.status).toBe('crashed')
  })

  test('prunes records past cleanup_after', async () => {
    const registry = new SubagentRegistry()
    const ctrl = newControlState(registry)
    const rec = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: async () => validClaims, mint_run_id: () => 'r' },
    )
    registry.update(rec.run_id, {
      status: 'finished',
      ended_at: 0,
      cleanup_after: 100,
    })
    const affected = await runLifecycleTick({
      control: ctrl,
      registry,
      now: () => 1000,
      pid_alive: () => true,
    })
    expect(affected).toBeGreaterThanOrEqual(1)
    expect(registry.byRunId(rec.run_id)).toBeUndefined()
  })
})

describe('announce', () => {
  test('formatAnnouncement extracts duration and renders markdown', () => {
    const registry = new SubagentRegistry()
    const r = registry.create({
      run_id: 'r',
      instance_key: 't',
      agent_kind: 'forge',
      spawn_depth: 0,
    })
    registry.update(r.run_id, { status: 'finished', ended_at: r.started_at + 5000 })
    const updated = registry.byRunId(r.run_id)!
    const a = formatAnnouncement({ record: updated, summary: 'Done.', deliverables: ['PR #99'] })
    expect(a.duration_ms).toBe(5000)
    const md = renderAnnouncementMarkdown(a)
    expect(md).toContain('### Subagent forge (finished)')
    expect(md).toContain('PR #99')
  })
})
