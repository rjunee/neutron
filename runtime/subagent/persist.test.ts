/**
 * @neutronai/runtime — subagent-registry persistence + boot reap (plan §P7).
 *
 * Proves the D-6 acceptance ("a restart SURFACES, not vanishes, in-flight
 * dispatches") and the CRITICAL care ("the `fired`/`redispatched`
 * orphan-detection sets stay volatile — a restart still re-detects orphans").
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SubagentRegistry, type CreateRecordInput, type SubagentRecord } from './registry.ts'
import { SubagentRegistryStore } from './store.ts'
import { sweepOrphanedDispatchesOnBoot } from './boot-sweep.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-subagent-persist-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const dispatchInput = (over: Partial<CreateRecordInput> = {}): CreateRecordInput => ({
  run_id: over.run_id ?? 'run-1',
  instance_key: over.instance_key ?? 'owner-a',
  agent_kind: over.agent_kind ?? 'atlas',
  spawn_depth: over.spawn_depth ?? 0,
  ...(over.parent_run_id !== undefined ? { parent_run_id: over.parent_run_id } : {}),
  ...(over.parent_session_id !== undefined ? { parent_session_id: over.parent_session_id } : {}),
  ...(over.delivery_target !== undefined ? { delivery_target: over.delivery_target } : {}),
  ...(over.delegation_claims !== undefined ? { delegation_claims: over.delegation_claims } : {}),
  ...(over.spawn_key !== undefined ? { spawn_key: over.spawn_key } : {}),
})

describe('SubagentRegistryStore — migration + write-through', () => {
  test('migration applies — code_subagent_registry table exists', () => {
    const row = db
      .prepare<{ name: string }, [string]>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get('code_subagent_registry')
    expect(row?.name).toBe('code_subagent_registry')
  })

  test('create write-throughs a row; every field round-trips', () => {
    const store = new SubagentRegistryStore(db)
    const registry = new SubagentRegistry(store)
    registry.create(
      dispatchInput({
        run_id: 'run-rich',
        parent_run_id: 'parent-9',
        parent_session_id: 'sess-p',
        delivery_target: { channel: 'app', binding_id: 'b-1' },
        delegation_claims: { instance: 'owner-a', depth: 1, scope: ['research'], jti: 'j-1' },
        spawn_key: 'code-gen:t1:atlas',
      }),
    )
    const loaded = store.get('run-rich')
    expect(loaded).not.toBeNull()
    expect(loaded?.status).toBe('pending')
    expect(loaded?.parent_run_id).toBe('parent-9')
    expect(loaded?.parent_session_id).toBe('sess-p')
    expect(loaded?.delivery_target).toEqual({ channel: 'app', binding_id: 'b-1' })
    expect(loaded?.delegation_claims).toEqual({
      instance: 'owner-a',
      depth: 1,
      scope: ['research'],
      jti: 'j-1',
    })
    expect(loaded?.spawn_key).toBe('code-gen:t1:atlas')
  })

  test('update write-throughs the status transition; delete removes the row', () => {
    const store = new SubagentRegistryStore(db)
    const registry = new SubagentRegistry(store)
    registry.create(dispatchInput({ run_id: 'run-u' }))
    registry.update('run-u', { status: 'running', child_session_id: 'child-1', pid: 4242 })
    const running = store.get('run-u')
    expect(running?.status).toBe('running')
    expect(running?.child_session_id).toBe('child-1')
    expect(running?.pid).toBe(4242)

    registry.delete('run-u')
    expect(store.get('run-u')).toBeNull()
  })

  test('no persistence sink → registry stays pure in-memory (no table writes)', () => {
    const registry = new SubagentRegistry() // S3 behaviour — no store
    registry.create(dispatchInput({ run_id: 'run-mem' }))
    const store = new SubagentRegistryStore(db)
    expect(store.loadAll()).toHaveLength(0)
    // In-memory registry still holds it.
    expect(registry.byRunId('run-mem')?.run_id).toBe('run-mem')
  })
})

describe('(a) a dispatched agent row persists across a simulated process restart', () => {
  test('a running dispatch survives; a fresh registry over the same db still sees it live', () => {
    // Process 1: dispatch + drive to running.
    const store1 = new SubagentRegistryStore(db)
    const registry1 = new SubagentRegistry(store1)
    registry1.create(dispatchInput({ run_id: 'run-live', agent_kind: 'sentinel' }))
    registry1.update('run-live', { status: 'running', pid: 9001 })

    // Process 2 (RESTART): a brand-new in-memory registry + store over the SAME
    // db. The in-memory map starts empty (crash lost it) — but the store retains
    // the row, so the dispatch did NOT vanish.
    const registry2 = new SubagentRegistry(new SubagentRegistryStore(db))
    expect(registry2.snapshot()).toHaveLength(0) // in-memory state gone

    const store2 = new SubagentRegistryStore(db)
    const live = store2.loadLive()
    expect(live).toHaveLength(1)
    expect(live[0]?.run_id).toBe('run-live')
    expect(live[0]?.status).toBe('running')
    expect(live[0]?.pid).toBe(9001)
  })
})

describe('(b) boot sweep marks prior-process in-flight rows crashed + fires report once each', () => {
  test('two live orphans surface exactly once; terminal rows are untouched', async () => {
    // Prior process left two in-flight dispatches + one cleanly-finished one.
    const store1 = new SubagentRegistryStore(db)
    const reg1 = new SubagentRegistry(store1)
    reg1.create(dispatchInput({ run_id: 'orphan-1', agent_kind: 'atlas' }))
    reg1.update('orphan-1', { status: 'running' })
    reg1.create(dispatchInput({ run_id: 'orphan-2', agent_kind: 'core' }))
    // orphan-2 left in 'pending' (never advanced to running) — still LIVE.
    reg1.create(dispatchInput({ run_id: 'done-1', agent_kind: 'sentinel' }))
    reg1.update('done-1', { status: 'finished' })

    // BOOT (process 2): sweep.
    const bootStore = new SubagentRegistryStore(db)
    const fired: SubagentRecord[] = []
    const swept = await sweepOrphanedDispatchesOnBoot({
      store: bootStore,
      report: (rec) => {
        fired.push(rec)
      },
      now: () => 5_000,
    })

    // Both live orphans surfaced; the finished row was NOT.
    expect(swept.map((r) => r.run_id).sort()).toEqual(['orphan-1', 'orphan-2'])
    expect(fired.map((r) => r.run_id).sort()).toEqual(['orphan-1', 'orphan-2'])
    for (const rec of fired) {
      expect(rec.status).toBe('crashed')
      expect(rec.failure_reason).toBe('process_dead')
      expect(rec.ended_at).toBe(5_000)
    }
    // Persisted terminal status.
    expect(bootStore.get('orphan-1')?.status).toBe('crashed')
    expect(bootStore.get('orphan-2')?.status).toBe('crashed')
    expect(bootStore.get('orphan-1')?.failure_reason).toBe('process_dead')
    // The clean finish is untouched.
    expect(bootStore.get('done-1')?.status).toBe('finished')

    // SECOND BOOT: idempotent — the now-crashed rows must NOT re-fire.
    const fired2: SubagentRecord[] = []
    const swept2 = await sweepOrphanedDispatchesOnBoot({
      store: new SubagentRegistryStore(db),
      report: (rec) => {
        fired2.push(rec)
      },
      now: () => 9_999,
    })
    expect(swept2).toHaveLength(0)
    expect(fired2).toHaveLength(0)
  })

  test('a sink that throws does not abort the sweep nor un-crash the row', async () => {
    const store = new SubagentRegistryStore(db)
    const reg = new SubagentRegistry(store)
    reg.create(dispatchInput({ run_id: 'boom' }))
    reg.update('boom', { status: 'running' })

    const swept = await sweepOrphanedDispatchesOnBoot({
      store: new SubagentRegistryStore(db),
      report: () => {
        throw new Error('sink down')
      },
      now: () => 1,
    })
    expect(swept.map((r) => r.run_id)).toEqual(['boom'])
    // Still recorded terminal despite the sink throwing.
    expect(store.get('boom')?.status).toBe('crashed')
  })
})

describe('(c) the fired/redispatched orphan-detection sets stay volatile', () => {
  test('no persisted column can carry a fired/redispatched/reported dedup marker', () => {
    const cols = db
      .prepare<{ name: string }, []>(`PRAGMA table_info(code_subagent_registry)`)
      .all()
      .map((r) => r.name)
    // The table mirrors SubagentRecord ONLY. If any of these ever appears, a
    // dedup set would be persisted — the exact orphan-detection replay P7 forbids.
    for (const forbidden of ['fired', 'redispatched', 'reported', 'reap_notified']) {
      expect(cols).not.toContain(forbidden)
    }
  })

  test('a persisted running row is ALWAYS re-surfaced on a fresh boot (no suppression flag survives)', async () => {
    // If the persistence layer had smuggled a "this-process fired it" flag, the
    // fresh boot would SKIP the orphan. It must not: the orphan re-detects.
    const store1 = new SubagentRegistryStore(db)
    const reg1 = new SubagentRegistry(store1)
    reg1.create(dispatchInput({ run_id: 'reorphan' }))
    reg1.update('reorphan', { status: 'running' })

    const surfaced = await sweepOrphanedDispatchesOnBoot({
      store: new SubagentRegistryStore(db),
      report: () => {},
      now: () => 42,
    })
    expect(surfaced.map((r) => r.run_id)).toEqual(['reorphan'])
    // The re-detection came from the LIVE status alone — the only thing that
    // stops a SECOND boot re-firing is the store transition to terminal, NOT a
    // volatile in-memory dedup set (which a restart would have dropped anyway).
  })

  test('the persisted SubagentRecord shape carries no dedup/fired field', () => {
    const store = new SubagentRegistryStore(db)
    const reg = new SubagentRegistry(store)
    reg.create(dispatchInput({ run_id: 'shape' }))
    reg.update('shape', { status: 'running' })
    const rec = store.get('shape') as unknown as Record<string, unknown>
    for (const forbidden of ['fired', 'redispatched', 'reported']) {
      expect(rec).not.toHaveProperty(forbidden)
    }
  })
})
