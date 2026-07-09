import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { OvernightQueueStore, nextOwkId, owkDatePrefix } from './queue-store.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-overnight-queue-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('migration 0078', () => {
  test('overnight_queue + overnight_budget tables exist', () => {
    const tables = db
      .prepare<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('overnight_queue', 'overnight_budget')`,
      )
      .all()
      .map((r) => r.name)
      .sort()
    expect(tables).toEqual(['overnight_budget', 'overnight_queue'])
  })
})

describe('OvernightQueueStore', () => {
  test('create + get round-trips with defaults', async () => {
    const store = new OvernightQueueStore(db)
    const item = await store.create({
      id: 'owk-20260619-001',
      project_slug: 'acme',
      description: 'Deepen pricing analysis',
    })
    expect(item.agent_role).toBe('forge')
    expect(item.priority).toBe('P3')
    expect(item.status).toBe('queued')
    expect(item.ralph).toBe(false)
    const got = store.get('owk-20260619-001')
    expect(got).not.toBeNull()
    expect(got?.description).toBe('Deepen pricing analysis')
    expect(got?.trident_run_id).toBeNull()
  })

  test('create honours overrides', async () => {
    const store = new OvernightQueueStore(db)
    const item = await store.create({
      id: 'owk-20260619-002',
      project_slug: 'globex',
      description: 'Build the importer',
      agent_role: 'atlas',
      priority: 'P1',
      context_relpath: 'docs/spec.md',
      ralph: true,
    })
    expect(item.agent_role).toBe('atlas')
    expect(item.priority).toBe('P1')
    expect(item.context_relpath).toBe('docs/spec.md')
    expect(item.ralph).toBe(true)
    expect(store.get(item.id)?.ralph).toBe(true)
  })

  test('update patches only provided fields + persists trident link', async () => {
    const store = new OvernightQueueStore(db)
    await store.create({ id: 'owk-20260619-003', project_slug: 'acme', description: 'x' })
    const updated = await store.update('owk-20260619-003', {
      status: 'in-flight',
      trident_run_id: 'run-abc',
      trident_slug: 'overnight-owk-20260619-003',
      started_at: '2026-06-19T23:30:00Z',
      window_date_local: '2026-06-19',
    })
    expect(updated?.status).toBe('in-flight')
    expect(updated?.trident_run_id).toBe('run-abc')
    expect(updated?.window_date_local).toBe('2026-06-19')
    // description untouched
    expect(updated?.description).toBe('x')
  })

  test('listByStatus + countInFlight', async () => {
    const store = new OvernightQueueStore(db)
    await store.create({ id: 'owk-20260619-010', project_slug: 'a', description: 'q1' })
    await store.create({ id: 'owk-20260619-011', project_slug: 'a', description: 'q2' })
    const inflight = await store.create({
      id: 'owk-20260619-012',
      project_slug: 'b',
      description: 'r1',
    })
    await store.update(inflight.id, { status: 'in-flight' })
    expect(store.listByStatus('queued').length).toBe(2)
    expect(store.countInFlight()).toBe(1)
  })

  test('per-window budget counter is atomic UPSERT', async () => {
    const store = new OvernightQueueStore(db)
    expect(store.startedThisWindow('2026-06-19')).toBe(0)
    await store.incrementStarted('2026-06-19', 1)
    await store.incrementStarted('2026-06-19', 1)
    await store.incrementStarted('2026-06-20', 1)
    expect(store.startedThisWindow('2026-06-19')).toBe(2)
    expect(store.startedThisWindow('2026-06-20')).toBe(1)
  })
})

describe('owk-id allocation', () => {
  test('nextOwkId increments within a date, ignores other dates', () => {
    const ids = new Set(['owk-20260619-001', 'owk-20260619-004', 'owk-20260618-009'])
    expect(nextOwkId('20260619', ids)).toBe('owk-20260619-005')
    expect(nextOwkId('20260620', ids)).toBe('owk-20260620-001')
  })

  test('owkDatePrefix is UTC YYYYMMDD', () => {
    expect(owkDatePrefix(Date.parse('2026-06-19T12:00:00Z'))).toBe('20260619')
  })
})
