import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { RitualRunStore, type RitualRunTerminalStatus } from './ritual-runs.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-ritual-runs-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('RitualRunStore', () => {
  test('insertSpawned → row queryable, status spawned, ended_at null', async () => {
    const store = new RitualRunStore(db)
    await store.insertSpawned({
      run_id: 'r1',
      ritual_id: 'morning-brief',
      reminder_id: 'rem-1',
      instance_key: 'inst-1',
      project_id: 'proj-1',
      started_at: 1000,
    })
    const row = store.get('r1')
    expect(row?.status).toBe('spawned')
    expect(row?.ended_at).toBeNull()
    expect(row?.skip_reason).toBeNull()
    expect(row?.reminder_id).toBe('rem-1')
    expect(row?.project_id).toBe('proj-1')
  })

  test('insertSpawned defaults nullable reminder_id/project_id to null', async () => {
    const store = new RitualRunStore(db)
    await store.insertSpawned({
      run_id: 'r-null',
      ritual_id: 'morning-brief',
      instance_key: 'inst-1',
      started_at: 1000,
    })
    const row = store.get('r-null')
    expect(row?.reminder_id).toBeNull()
    expect(row?.project_id).toBeNull()
  })

  test('markTerminal round-trips every terminal status', async () => {
    const store = new RitualRunStore(db)
    const terminals: RitualRunTerminalStatus[] = ['finished', 'failed', 'timed_out', 'crashed']
    for (const [i, status] of terminals.entries()) {
      const run_id = `t-${status}`
      await store.insertSpawned({
        run_id,
        ritual_id: 'morning-brief',
        instance_key: 'inst-1',
        started_at: 1000 + i,
      })
      await store.markTerminal(run_id, status, {
        ended_at: 2000 + i,
        output_summary: status === 'finished' ? 'brief posted' : null,
      })
      const row = store.get(run_id)
      expect(row?.status).toBe(status)
      expect(row?.ended_at).toBe(2000 + i)
    }
    expect(store.get('t-finished')?.output_summary).toBe('brief posted')
  })

  test('markTerminal only advances a live (spawned) row', async () => {
    const store = new RitualRunStore(db)
    await store.insertSpawned({ run_id: 'r1', ritual_id: 'mb', instance_key: 'i', started_at: 1 })
    await store.markTerminal('r1', 'finished', { ended_at: 2 })
    // second terminal is a no-op (guarded on status = 'spawned')
    await store.markTerminal('r1', 'failed', { ended_at: 3 })
    expect(store.get('r1')?.status).toBe('finished')
    expect(store.get('r1')?.ended_at).toBe(2)
  })

  test('insertSkipped → listByRitual surfaces the reason (durable "why didn\'t it run")', async () => {
    const store = new RitualRunStore(db)
    await store.insertSkipped({
      run_id: 's1',
      ritual_id: 'morning-brief',
      reminder_id: 'rem-9',
      instance_key: 'inst-1',
      started_at: 5000,
      skip_reason: 'unapproved',
    })
    const rows = store.listByRitual('morning-brief')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('skipped')
    expect(rows[0]?.skip_reason).toBe('unapproved')
    expect(rows[0]?.ended_at).toBe(5000) // skip is instantaneous: ended_at = started_at
  })

  test('raw INSERT of a skipped row with NULL skip_reason violates the CHECK', () => {
    // The invariant CHECK ((status = 'skipped') = (skip_reason IS NOT NULL))
    // holds at the SQL layer, not just in the store API.
    expect(() =>
      db.raw().run(
        `INSERT INTO code_ritual_runs
           (run_id, ritual_id, instance_key, status, skip_reason, started_at)
         VALUES ('bad', 'mb', 'i', 'skipped', NULL, 1)`,
      ),
    ).toThrow()
  })

  test('raw INSERT of a non-skipped row WITH a skip_reason violates the CHECK', () => {
    expect(() =>
      db.raw().run(
        `INSERT INTO code_ritual_runs
           (run_id, ritual_id, instance_key, status, skip_reason, started_at)
         VALUES ('bad2', 'mb', 'i', 'spawned', 'unapproved', 1)`,
      ),
    ).toThrow()
  })

  test('listByRitual: newest-first ordering + limit', async () => {
    const store = new RitualRunStore(db)
    for (const [i, ts] of [100, 300, 200].entries()) {
      await store.insertSpawned({
        run_id: `r-${i}`,
        ritual_id: 'mb',
        instance_key: 'i',
        started_at: ts,
      })
    }
    const rows = store.listByRitual('mb')
    expect(rows.map((r) => r.started_at)).toEqual([300, 200, 100])
    expect(store.listByRitual('mb', 2).map((r) => r.started_at)).toEqual([300, 200])
    expect(store.listByRitual('other')).toHaveLength(0)
  })

  test('pruneTerminalOlderThan deletes old terminal rows, keeps old spawned + fresh terminal', async () => {
    const store = new RitualRunStore(db)
    // old finished (should be pruned)
    await store.insertSpawned({ run_id: 'old-fin', ritual_id: 'mb', instance_key: 'i', started_at: 100 })
    await store.markTerminal('old-fin', 'finished', { ended_at: 150 })
    // old spawned/live (must NEVER be pruned regardless of age)
    await store.insertSpawned({ run_id: 'old-live', ritual_id: 'mb', instance_key: 'i', started_at: 100 })
    // fresh finished (newer than cutoff — kept)
    await store.insertSpawned({ run_id: 'new-fin', ritual_id: 'mb', instance_key: 'i', started_at: 5000 })
    await store.markTerminal('new-fin', 'finished', { ended_at: 5100 })

    await store.pruneTerminalOlderThan(1000)

    expect(store.get('old-fin')).toBeNull()
    expect(store.get('old-live')?.status).toBe('spawned')
    expect(store.get('new-fin')?.status).toBe('finished')
  })
})

describe('migration 0106 schema', () => {
  test('reminders table has ritual_id column', () => {
    const cols = db
      .raw()
      .query<{ name: string }, []>(`PRAGMA table_info(reminders)`)
      .all()
      .map((c) => c.name)
    expect(cols).toContain('ritual_id')
  })

  test("code_subagent_registry accepts agent_kind 'ritual' and rejects an unknown kind", () => {
    const insert = (kind: string) =>
      db.raw().run(
        `INSERT INTO code_subagent_registry
           (run_id, instance_key, agent_kind, started_at, last_event_at, boot_id)
         VALUES (?, 'inst', ?, 1, 1, 'boot-x')`,
        [`run-${kind}`, kind],
      )
    expect(() => insert('ritual')).not.toThrow()
    expect(() => insert('bogus')).toThrow()
    // sanity: an existing kind still works after the rebuild
    expect(() => insert('forge')).not.toThrow()
  })

  test('all three indexes exist post-migration (rebuild recreated 0100 indexes)', () => {
    const idx = db
      .raw()
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all()
      .map((r) => r.name)
    expect(idx).toContain('idx_code_subagent_registry_live')
    expect(idx).toContain('idx_code_subagent_registry_owner')
    expect(idx).toContain('idx_code_ritual_runs_ritual')
  })
})
