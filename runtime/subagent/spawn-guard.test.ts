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

  test('nested: concurrent spawns sharing a key create exactly ONE record (no TOCTOU race)', async () => {
    // Regression for the race where the guard read ran BEFORE the
    // `await verify_delegation`, letting two concurrent nested spawns both
    // pass the check and both create a record. The guard now reads liveByKey
    // immediately before the synchronous create (after the await), so the
    // second caller always sees the first's record.
    const registry = new SubagentRegistry()
    const parent = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: verify, mint_run_id: () => 'parent' },
    )
    const key = 'instance-a:nested-task:atlas'
    // A verifier that yields the event loop (a real JWT verify is async), so
    // the two spawns interleave at the await point.
    const yieldingVerify = async () => {
      await Promise.resolve()
      return validClaims
    }
    const ids = makeIds('child')
    const [a, b] = await Promise.all([
      spawnSubagent(
        { parent_run_id: parent.run_id, instance_key: 'instance-a', agent_kind: 'atlas', delegation_token: 'tok', spawn_key: key },
        { registry, verify_delegation: yieldingVerify, mint_run_id: ids },
      ),
      spawnSubagent(
        { parent_run_id: parent.run_id, instance_key: 'instance-a', agent_kind: 'atlas', delegation_token: 'tok', spawn_key: key },
        { registry, verify_delegation: yieldingVerify, mint_run_id: ids },
      ),
    ])
    // Both resolve to the SAME single child record.
    expect(a.run_id).toBe(b.run_id)
    // Only one child of the parent exists (plus the parent = 2 total).
    expect(registry.byParent(parent.run_id)).toHaveLength(1)
    expect(registry.snapshot()).toHaveLength(2)
  })

  test('nested: an UNauthorized request (no token) with a guessed key throws — never coalesces', async () => {
    // Regression for the leak where coalescing happened BEFORE nested
    // authorization, handing a malformed/forged request another run's record.
    const registry = new SubagentRegistry()
    const parent = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: verify, mint_run_id: () => 'parent' },
    )
    const key = 'instance-a:secret-task:atlas'
    // A legitimate, authorized nested child holds the key.
    await spawnSubagent(
      { parent_run_id: parent.run_id, instance_key: 'instance-a', agent_kind: 'atlas', delegation_token: 'tok', spawn_key: key },
      { registry, verify_delegation: verify, mint_run_id: () => 'legit-child' },
    )
    // An attacker who guesses the key but presents NO delegation token must be
    // rejected on authorization — not handed the live record.
    await expect(
      spawnSubagent(
        { parent_run_id: parent.run_id, instance_key: 'instance-a', agent_kind: 'atlas', spawn_key: key },
        { registry, verify_delegation: verify, mint_run_id: () => 'attacker' },
      ),
    ).rejects.toThrow(/requires a signed delegation token/)
  })

  test('nested: a request whose delegation token fails verification throws — never coalesces', async () => {
    const registry = new SubagentRegistry()
    const parent = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge' },
      { registry, verify_delegation: verify, mint_run_id: () => 'parent' },
    )
    const key = 'instance-a:t:atlas'
    await spawnSubagent(
      { parent_run_id: parent.run_id, instance_key: 'instance-a', agent_kind: 'atlas', delegation_token: 'tok', spawn_key: key },
      { registry, verify_delegation: verify, mint_run_id: () => 'legit' },
    )
    await expect(
      spawnSubagent(
        { parent_run_id: parent.run_id, instance_key: 'instance-a', agent_kind: 'atlas', delegation_token: 'forged', spawn_key: key },
        {
          registry,
          verify_delegation: async () => {
            throw new Error('bad signature')
          },
          mint_run_id: () => 'attacker',
        },
      ),
    ).rejects.toThrow(/bad signature/)
  })

  test('the guard is instance-scoped: a same key on a different instance does NOT coalesce', async () => {
    const registry = new SubagentRegistry()
    const key = 'shared-key'
    const a = await spawnSubagent(
      { instance_key: 'instance-a', agent_kind: 'forge', spawn_key: key },
      { registry, verify_delegation: verify, mint_run_id: () => 'A' },
    )
    registry.update(a.run_id, { status: 'running' })
    const b = await spawnSubagent(
      { instance_key: 'instance-b', agent_kind: 'forge', spawn_key: key },
      { registry, verify_delegation: verify, mint_run_id: () => 'B' },
    )
    expect(b.run_id).toBe('B')
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
