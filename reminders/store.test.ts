import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ReminderStore } from './store.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-reminders-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('ReminderStore', () => {
  test('create + get round-trip', async () => {
    const store = new ReminderStore(db)
    const r = await store.create({
      owner_slug: 't1',
      topic_id: 'topic-1',
      fire_at: 1700000000,
      message: 'remember the milk',
    })
    expect(r.status).toBe('pending')
    const got = store.get(r.id)
    expect(got?.message).toBe('remember the milk')
    expect(got?.topic_id).toBe('topic-1')
  })

  test('cancel pending reminder', async () => {
    const store = new ReminderStore(db)
    const r = await store.create({
      owner_slug: 't1',
      topic_id: null,
      fire_at: 1700000000,
      message: 'x',
    })
    expect(await store.cancel(r.id)).toBe(true)
    expect(store.get(r.id)?.status).toBe('cancelled')
    // second cancel returns false (already cancelled)
    expect(await store.cancel(r.id)).toBe(false)
  })

  test('listDue returns only pending reminders with fire_at <= as_of', async () => {
    const store = new ReminderStore(db)
    await store.create({ owner_slug: 't1', topic_id: null, fire_at: 1000, message: 'a' })
    await store.create({ owner_slug: 't1', topic_id: null, fire_at: 2000, message: 'b' })
    await store.create({ owner_slug: 't1', topic_id: null, fire_at: 3000, message: 'c' })
    const due = store.listDue(1500)
    expect(due.map((r) => r.message)).toEqual(['a'])
    const all = store.listDue(5000)
    expect(all.map((r) => r.message)).toEqual(['a', 'b', 'c'])
  })

  test('markFired flips status only when pending', async () => {
    const store = new ReminderStore(db)
    const r = await store.create({ owner_slug: 't1', topic_id: null, fire_at: 100, message: 'x' })
    await store.markFired(r.id)
    const got = store.get(r.id)
    expect(got?.status).toBe('fired')
    expect(got?.fired_at).not.toBeNull()
    // second markFired no-op (status already 'fired')
    await store.markFired(r.id)
    expect(store.get(r.id)?.status).toBe('fired')
  })

  test('listPending sorts oldest-due first and skips fired/cancelled', async () => {
    const store = new ReminderStore(db)
    const a = await store.create({ owner_slug: 't1', topic_id: null, fire_at: 1000, message: 'a' })
    await store.create({ owner_slug: 't1', topic_id: null, fire_at: 500, message: 'b' })
    await store.markFired(a.id)
    const pending = store.listPending('t1')
    expect(pending.map((r) => r.message)).toEqual(['b'])
  })

  test('listPendingByTopic scopes results to (project, topic_id) pair', async () => {
    const store = new ReminderStore(db)
    await store.create({ owner_slug: 't1', topic_id: 'app-project:demo', fire_at: 200, message: 'demo' })
    await store.create({ owner_slug: 't1', topic_id: 'app-project:other', fire_at: 100, message: 'other' })
    await store.create({ owner_slug: 't1', topic_id: null, fire_at: 50, message: 'orphan' })
    const demo = store.listPendingByTopic('t1', 'app-project:demo')
    expect(demo.map((r) => r.message)).toEqual(['demo'])
    const other = store.listPendingByTopic('t1', 'app-project:other')
    expect(other.map((r) => r.message)).toEqual(['other'])
    // Untagged rows never match a project topic.
    const ghost = store.listPendingByTopic('t1', 'app-project:ghost')
    expect(ghost).toEqual([])
  })

  test('reschedule updates fire_at for a pending row and returns true', async () => {
    const store = new ReminderStore(db)
    const r = await store.create({
      owner_slug: 't1',
      topic_id: 'app-project:demo',
      fire_at: 1000,
      message: 'x',
    })
    expect(await store.reschedule(r.id, 5000)).toBe(true)
    expect(store.get(r.id)?.fire_at).toBe(5000)
  })

  test('reschedule returns false for cancelled / fired / missing rows', async () => {
    const store = new ReminderStore(db)
    const r = await store.create({
      owner_slug: 't1',
      topic_id: 'app-project:demo',
      fire_at: 1000,
      message: 'x',
    })
    await store.cancel(r.id)
    expect(await store.reschedule(r.id, 5000)).toBe(false)
    // Original fire_at untouched even after the failed reschedule.
    expect(store.get(r.id)?.fire_at).toBe(1000)

    expect(await store.reschedule('nope-not-a-real-id', 5000)).toBe(false)
  })

  test('createRecurring with a coarse label round-trips recurrence, leaves recurrence_spec null', async () => {
    const store = new ReminderStore(db)
    const r = await store.createRecurring({
      owner_slug: 't1',
      topic_id: null,
      fire_at: 1700000000,
      message: 'weekly',
      recurrence: 'weekly',
    })
    const got = store.get(r.id)
    expect(got?.recurrence).toBe('weekly')
    expect(got?.recurrence_spec).toBeNull()
  })

  test('createRecurring with a cron spec round-trips recurrence_spec, leaves recurrence null', async () => {
    const store = new ReminderStore(db)
    const r = await store.createRecurring({
      owner_slug: 't1',
      topic_id: null,
      fire_at: 1700000000,
      message: 'daily 9am',
      recurrence_spec: '0 9 * * *',
    })
    const got = store.get(r.id)
    expect(got?.recurrence_spec).toBe('0 9 * * *')
    expect(got?.recurrence).toBeNull()
  })

  test('one-shot create leaves both cadence columns null', async () => {
    const store = new ReminderStore(db)
    const r = await store.create({
      owner_slug: 't1',
      topic_id: null,
      fire_at: 1700000000,
      message: 'once',
    })
    const got = store.get(r.id)
    expect(got?.recurrence).toBeNull()
    expect(got?.recurrence_spec).toBeNull()
  })

  test('createRecurring enforces exactly-one cadence (rejects both / neither)', async () => {
    const store = new ReminderStore(db)
    const base = { owner_slug: 't1', topic_id: null, fire_at: 1700000000, message: 'x' }
    await expect(
      store.createRecurring({ ...base, recurrence: 'weekly', recurrence_spec: '0 9 * * *' }),
    ).rejects.toThrow()
    await expect(store.createRecurring({ ...base })).rejects.toThrow()
  })

  test('ritual_id is read-through: create() defaults null; a raw UPDATE round-trips (migration 0106)', async () => {
    // The write path deliberately does NOT exist yet (registration lands with its
    // validation — plan task 8 / task 4). So create() always writes NULL, and the
    // read-through is exercised via a direct SQL UPDATE — the only writer today.
    const store = new ReminderStore(db)
    const r = await store.create({
      owner_slug: 't1',
      topic_id: null,
      fire_at: 1700000000,
      message: 'plain nudge',
    })
    expect(store.get(r.id)?.ritual_id).toBeNull()

    await db.run(`UPDATE reminders SET ritual_id = 'morning-brief' WHERE id = ?`, [r.id])
    expect(store.get(r.id)?.ritual_id).toBe('morning-brief')
  })

  test('recurring create defaults ritual_id null (no write path yet)', async () => {
    const store = new ReminderStore(db)
    const r = await store.createRecurring({
      owner_slug: 't1',
      topic_id: null,
      fire_at: 1700000000,
      message: 'weekly nudge',
      recurrence: 'weekly',
    })
    expect(store.get(r.id)?.ritual_id).toBeNull()
  })
})
