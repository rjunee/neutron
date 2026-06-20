import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import { ReminderStore, type Reminder } from './store.ts'
import {
  ReminderTickLoop,
  type ReminderDispatcher,
  type ReminderFiredHook,
} from './tick.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-reminders-tick-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const recordingDispatcher = (): ReminderDispatcher & { fired: Reminder[] } => {
  const fired: Reminder[] = []
  return {
    fired,
    dispatch: async (r) => { fired.push(r) },
  }
}

describe('ReminderTickLoop.runOnce', () => {
  test('fires due reminders + flips status to fired', async () => {
    const store = new ReminderStore(db)
    let now = 10_000_000
    await store.create({ project_slug: 't1', topic_id: null, fire_at: now / 1000 - 100, message: 'a' })
    await store.create({ project_slug: 't1', topic_id: null, fire_at: now / 1000 - 50, message: 'b' })
    await store.create({ project_slug: 't1', topic_id: null, fire_at: now / 1000 + 1000, message: 'future' })
    const dispatcher = recordingDispatcher()
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now })

    const result = await loop.runOnce()
    expect(result.fired).toBe(2)
    expect(dispatcher.fired.map((r) => r.message)).toEqual(['a', 'b'])
    expect(store.listPending('t1').map((r) => r.message)).toEqual(['future'])
  })

  test('per_tick_limit caps the per-tick dispatch count', async () => {
    const store = new ReminderStore(db)
    let now = 10_000_000
    for (let i = 0; i < 5; i++) {
      await store.create({ project_slug: 't1', topic_id: null, fire_at: now / 1000 - 100, message: `r${i}` })
    }
    const dispatcher = recordingDispatcher()
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now, per_tick_limit: 2 })
    expect((await loop.runOnce()).fired).toBe(2)
    expect(dispatcher.fired.length).toBe(2)
    expect(store.listPending('t1').length).toBe(3)
  })

  test('dispatcher errors do not abort the tick (other reminders still fire)', async () => {
    const store = new ReminderStore(db)
    const now = 10_000_000
    await store.create({ project_slug: 't1', topic_id: null, fire_at: now / 1000 - 100, message: 'fail' })
    await store.create({ project_slug: 't1', topic_id: null, fire_at: now / 1000 - 50, message: 'ok' })
    const dispatcher: ReminderDispatcher = {
      dispatch: async (r) => {
        if (r.message === 'fail') throw new Error('nope')
      },
    }
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now })
    const result = await loop.runOnce()
    expect(result.fired).toBe(1)
    // pending: only the failed-dispatch row remains pending
    expect(store.listPending('t1').map((r) => r.message)).toEqual(['fail'])
  })

  test('recurring rows roll forward to the next occurrence instead of marking fired', async () => {
    const store = new ReminderStore(db)
    const now_sec = 10_000_000
    const initial_fire = now_sec - 10
    const oneShot = await store.create({
      project_slug: 't1',
      topic_id: null,
      fire_at: now_sec - 5,
      message: 'one-shot',
    })
    const recurring = await store.createRecurring({
      project_slug: 't1',
      topic_id: null,
      fire_at: initial_fire,
      message: 'weekly check-in',
      recurrence: 'weekly',
    })
    const dispatcher = recordingDispatcher()
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now_sec * 1000 })
    const result = await loop.runOnce()
    expect(result.fired).toBe(2)

    // One-shot row is fired (gone from pending).
    expect(store.get(oneShot.id)?.status).toBe('fired')
    // Recurring row stays pending with fire_at advanced by ~7 days.
    const advanced = store.get(recurring.id)
    expect(advanced?.status).toBe('pending')
    expect(advanced?.recurrence).toBe('weekly')
    const expected = initial_fire + 7 * 24 * 60 * 60
    expect(advanced?.fire_at).toBe(expected)
    expect(store.listPending('t1').map((r) => r.message)).toEqual(['weekly check-in'])
  })

  test('recurring next-fire floors at now+60s when the candidate is in the past (catch-up suppressed)', async () => {
    const store = new ReminderStore(db)
    const now_sec = 100_000_000
    // Fire was a month ago + cadence is weekly → candidate would be 23 days
    // in the past. Floor at now+60s.
    const old_fire = now_sec - 30 * 24 * 60 * 60
    const recurring = await store.createRecurring({
      project_slug: 't1',
      topic_id: null,
      fire_at: old_fire,
      message: 'weekly stale',
      recurrence: 'weekly',
    })
    const dispatcher = recordingDispatcher()
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now_sec * 1000 })
    await loop.runOnce()
    const advanced = store.get(recurring.id)
    expect(advanced?.status).toBe('pending')
    expect(advanced?.fire_at).toBe(now_sec + 60)
  })

  test('P5.6 — on_fired hook fires once per dispatched reminder, after store advance', async () => {
    const store = new ReminderStore(db)
    const now = 10_000_000
    const a = await store.create({
      project_slug: 't1',
      topic_id: null,
      fire_at: now / 1000 - 100,
      message: 'a',
    })
    const b = await store.create({
      project_slug: 't1',
      topic_id: null,
      fire_at: now / 1000 - 50,
      message: 'b',
    })
    const dispatcher = recordingDispatcher()
    // Capture the post-advance status visible to the hook to confirm
    // ordering: the row must already be marked fired by the time the
    // hook sees it.
    const pushed: Array<{ id: string; status: Reminder['status'] }> = []
    const hook: ReminderFiredHook = {
      async onFired(r) {
        const post = store.get(r.id)
        pushed.push({ id: r.id, status: post?.status ?? 'pending' })
      },
    }
    const loop = new ReminderTickLoop({
      store,
      dispatcher,
      now: () => now,
      on_fired: hook,
    })
    const result = await loop.runOnce()
    expect(result.fired).toBe(2)
    expect(pushed.length).toBe(2)
    expect(pushed.map((p) => p.id).sort()).toEqual([a.id, b.id].sort())
    expect(pushed.every((p) => p.status === 'fired')).toBe(true)
  })

  test('P5.6 — on_fired hook errors do not abort the tick', async () => {
    const store = new ReminderStore(db)
    const now = 10_000_000
    await store.create({
      project_slug: 't1',
      topic_id: null,
      fire_at: now / 1000 - 100,
      message: 'first',
    })
    await store.create({
      project_slug: 't1',
      topic_id: null,
      fire_at: now / 1000 - 50,
      message: 'second',
    })
    const dispatcher = recordingDispatcher()
    const seen: string[] = []
    const hook: ReminderFiredHook = {
      async onFired(r) {
        seen.push(r.message)
        if (r.message === 'first') throw new Error('push offline')
      },
    }
    const loop = new ReminderTickLoop({
      store,
      dispatcher,
      now: () => now,
      on_fired: hook,
    })
    const result = await loop.runOnce()
    // Both dispatched + marked fired despite the hook throwing.
    expect(result.fired).toBe(2)
    expect(seen).toEqual(['first', 'second'])
    expect(store.listPending('t1').length).toBe(0)
  })

  test('P5.6 — on_fired hook fires for recurring rows after advanceRecurrence', async () => {
    const store = new ReminderStore(db)
    const now_sec = 10_000_000
    const initial = now_sec - 10
    const recurring = await store.createRecurring({
      project_slug: 't1',
      topic_id: null,
      fire_at: initial,
      message: 'weekly',
      recurrence: 'weekly',
    })
    const dispatcher = recordingDispatcher()
    const seen: Array<{ id: string; fire_at_at_hook_time: number }> = []
    const hook: ReminderFiredHook = {
      async onFired(r) {
        // The reminder ARGUMENT carries the pre-advance fire_at (the
        // hook gets the snapshot the dispatcher saw); the DB row has
        // already advanced.
        seen.push({ id: r.id, fire_at_at_hook_time: r.fire_at })
      },
    }
    const loop = new ReminderTickLoop({
      store,
      dispatcher,
      now: () => now_sec * 1000,
      on_fired: hook,
    })
    await loop.runOnce()
    expect(seen).toEqual([{ id: recurring.id, fire_at_at_hook_time: initial }])
    expect(store.get(recurring.id)?.status).toBe('pending')
    expect(store.get(recurring.id)?.fire_at).toBe(initial + 7 * 24 * 60 * 60)
  })

  test('P5.6 — without on_fired (default), tick behaviour is unchanged', async () => {
    const store = new ReminderStore(db)
    const now = 10_000_000
    await store.create({
      project_slug: 't1',
      topic_id: null,
      fire_at: now / 1000 - 1,
      message: 'a',
    })
    const dispatcher = recordingDispatcher()
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now })
    expect((await loop.runOnce()).fired).toBe(1)
  })

  test('P5.6 — on_fired does NOT fire when the dispatcher throws (row stays pending)', async () => {
    const store = new ReminderStore(db)
    const now = 10_000_000
    await store.create({
      project_slug: 't1',
      topic_id: null,
      fire_at: now / 1000 - 1,
      message: 'broken',
    })
    const dispatcher: ReminderDispatcher = {
      dispatch: async () => {
        throw new Error('substrate offline')
      },
    }
    const calls: string[] = []
    const hook: ReminderFiredHook = {
      async onFired(r) {
        calls.push(r.id)
      },
    }
    const loop = new ReminderTickLoop({
      store,
      dispatcher,
      now: () => now,
      on_fired: hook,
    })
    const result = await loop.runOnce()
    expect(result.fired).toBe(0)
    expect(calls.length).toBe(0)
    expect(store.listPending('t1').length).toBe(1)
  })

  test('runOnce while a previous tick is in-flight returns skipped', async () => {
    const store = new ReminderStore(db)
    const now = 10_000_000
    await store.create({ project_slug: 't1', topic_id: null, fire_at: now / 1000 - 100, message: 'a' })
    let release!: () => void
    const block = new Promise<void>((r) => { release = r })
    const dispatcher: ReminderDispatcher = { dispatch: () => block }
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now })
    const t1 = loop.runOnce()
    // second tick while first is still in-flight
    const t2 = await loop.runOnce()
    expect(t2).toEqual({ fired: 0, skipped_due_to_overlap: true })
    release()
    await t1
    expect(loop.stats().skipped_ticks).toBe(1)
  })
})
