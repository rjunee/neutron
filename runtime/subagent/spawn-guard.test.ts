import { describe, expect, test } from 'bun:test'

import { MAX_SPAWN_DEPTH, SubagentRegistry } from './registry.ts'
import { spawnSubagent } from './spawn.ts'

/**
 * Double-spawn GUARD. Before this, every `spawnSubagent` minted a fresh
 * run_id, so two dispatches for the SAME logical task each started their own
 * process — the Vajra incident class (registry-only pid never killed → two
 * processes on one session). The guard keys on a caller-supplied logical
 * `spawn_key` and coalesces/refuses a duplicate while the first is in flight.
 */

const validClaims = {
  instance: 'instance-a',
  depth: MAX_SPAWN_DEPTH,
  scope: ['agent:dispatch_subagent'],
  jti: 'jti-1',
}

const verify = async () => validClaims

function makeIds(prefix: string): () => string {
  let n = 0
  return () => `${prefix}-${n++}`
}

describe('double-spawn guard', () => {
  test('coalesce (default): a duplicate in-flight spawn returns the SAME record, no second run', async () => {
    const registry = new SubagentRegistry()
    const key = 'instance-a:task-42:forge'

    const first = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge', spawn_key: key },
      { registry, verify_delegation: verify, mint_run_id: () => 'run-1' },
    )
    // The first run is now live (pending). A second dispatch for the same key…
    const second = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge', spawn_key: key },
      { registry, verify_delegation: verify, mint_run_id: () => 'run-2' },
    )

    // …coalesces onto the first: same run_id, and run-2 was never minted.
    expect(second.run_id).toBe('run-1')
    expect(first.run_id).toBe('run-1')
    expect(registry.byRunId('run-2')).toBeUndefined()
    // Exactly ONE record exists for the logical task.
    expect(registry.snapshot()).toHaveLength(1)
    expect(registry.live()).toHaveLength(1)
  })

  test('refuse: on_duplicate=refuse throws instead of coalescing', async () => {
    const registry = new SubagentRegistry()
    const key = 'instance-a:task-7:argus'
    await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'argus', spawn_key: key },
      { registry, verify_delegation: verify, mint_run_id: () => 'r1' },
    )
    await expect(
      spawnSubagent(
        { instance_key: 'instance-a', agent_kind: 'argus', spawn_key: key, on_duplicate: 'refuse' },
        { registry, verify_delegation: verify, mint_run_id: () => 'r2' },
      ),
    ).rejects.toThrow(/duplicate in-flight spawn for key .*task-7.*refusing/)
    expect(registry.byRunId('r2')).toBeUndefined()
  })

  test('coalesce holds while the first is RUNNING (not just pending)', async () => {
    const registry = new SubagentRegistry()
    const key = 'k-running'
    const first = await spawnSubagent(
      { instance_key: 'i', agent_kind: 'forge', spawn_key: key },
      { registry, verify_delegation: verify, mint_run_id: () => 'run-a' },
    )
    registry.update(first.run_id, { status: 'running', pid: 1234 })
    const dup = await spawnSubagent(
      { instance_key: 'i', agent_kind: 'forge', spawn_key: key },
      { registry, verify_delegation: verify, mint_run_id: () => 'run-b' },
    )
    expect(dup.run_id).toBe('run-a')
    expect(dup.status).toBe('running')
  })

  test('once the first run is TERMINAL, a fresh spawn for the same key proceeds', async () => {
    const registry = new SubagentRegistry()
    const key = 'k-recycle'
    const first = await spawnSubagent(
      { instance_key: 'i', agent_kind: 'forge', spawn_key: key },
      { registry, verify_delegation: verify, mint_run_id: () => 'run-old' },
    )
    // Finished (or crashed/cancelled) → no longer a live holder of the key.
    registry.update(first.run_id, { status: 'finished', ended_at: Date.now() })

    const next = await spawnSubagent(
      { instance_key: 'i', agent_kind: 'forge', spawn_key: key },
      { registry, verify_delegation: verify, mint_run_id: () => 'run-new' },
    )
    expect(next.run_id).toBe('run-new')
    expect(registry.liveByKey(key)?.run_id).toBe('run-new')
  })

  test('distinct keys never collide — two logical tasks both spawn', async () => {
    const registry = new SubagentRegistry()
    const a = await spawnSubagent(
      { instance_key: 'i', agent_kind: 'forge', spawn_key: 'task-A:forge' },
      { registry, verify_delegation: verify, mint_run_id: () => 'A' },
    )
    const b = await spawnSubagent(
      { instance_key: 'i', agent_kind: 'forge', spawn_key: 'task-B:forge' },
      { registry, verify_delegation: verify, mint_run_id: () => 'B' },
    )
    expect(a.run_id).toBe('A')
    expect(b.run_id).toBe('B')
    expect(registry.live()).toHaveLength(2)
  })

  test('no spawn_key ⇒ guard is inert (back-compat): two spawns, two distinct runs', async () => {
    const registry = new SubagentRegistry()
    const ids = makeIds('legacy')
    const a = await spawnSubagent(
      { instance_key: 'i', agent_kind: 'forge' },
      { registry, verify_delegation: verify, mint_run_id: ids },
    )
    const b = await spawnSubagent(
      { instance_key: 'i', agent_kind: 'forge' },
      { registry, verify_delegation: verify, mint_run_id: ids },
    )
    expect(a.run_id).not.toBe(b.run_id)
    expect(registry.live()).toHaveLength(2)
  })

  test('coalesce returns the in-flight twin WITHOUT consuming a concurrency slot', async () => {
    // The duplicate must not be blocked by the global cap — the original twin
    // already counts toward it, and coalescing adds nothing.
    const registry = new SubagentRegistry()
    const key = 'k-cap'
    const first = await spawnSubagent(
      { instance_key: 'i', agent_kind: 'forge', spawn_key: key },
      { registry, verify_delegation: verify, mint_run_id: () => 'first' },
    )
    registry.update(first.run_id, { status: 'running' })
    // Fill the rest of the concurrency budget with unrelated live runs.
    for (let i = 0; i < 7; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await spawnSubagent(
        { instance_key: 'i', agent_kind: 'forge' },
        { registry, verify_delegation: verify, mint_run_id: () => `filler-${i}` },
      )
      registry.update(r.run_id, { status: 'running' })
    }
    expect(registry.live()).toHaveLength(8) // MAX_CONCURRENT_SUBAGENTS

    // A NEW key would be refused by the cap…
    await expect(
      spawnSubagent(
        { instance_key: 'i', agent_kind: 'forge', spawn_key: 'brand-new' },
        { registry, verify_delegation: verify, mint_run_id: () => 'nope' },
      ),
    ).rejects.toThrow(/global concurrency cap hit/)

    // …but a DUPLICATE of the in-flight key still coalesces cleanly.
    const dup = await spawnSubagent(
      { instance_key: 'i', agent_kind: 'forge', spawn_key: key },
      { registry, verify_delegation: verify, mint_run_id: () => 'dup' },
    )
    expect(dup.run_id).toBe('first')
  })
})
