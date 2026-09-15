import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ReminderStore } from './store.ts'
import { ReminderTickLoop } from './tick.ts'
import { buildReminderDispatcher } from './dispatcher.ts'
import { exhaustionReason, type DeliveryObservation } from './delivery.ts'

let dir: string
let db: ProjectDb
let store: ReminderStore
let now: number
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reminder-observation-'))
  seedMigratedDb(join(dir, 'project.db'))
  db = ProjectDb.open(join(dir, 'project.db'))
  store = new ReminderStore(db)
  await store.initializeDelivery()
  now = 100_000
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
const create = (fire_at = now) => store.create({ owner_slug: 'sample', topic_id: null, message: 'hello', fire_at })
const delivered: DeliveryObservation = { state: 'delivered' }

test('bounds include five attempts and the full hour', () => {
  expect(exhaustionReason(4, now, now + 3600)).toBeNull()
  expect(exhaustionReason(5, now, now)).toBe('undelivered: attempt limit reached')
  expect(exhaustionReason(0, now, now + 3601)).toBe('undelivered: delivery window expired')
})

for (const kind of ['false', 'void', 'throw', 'true'] as const) {
  test(`outbound ${kind} has an explicit durable observation`, async () => {
    const r = await create()
    const dispatcher = buildReminderDispatcher({ llm: null, outbound: { post: () => {
      const claim = store.getDelivery(r.id, r.fire_at)!
      expect(claim.attempts).toBe(1)
      expect(claim.state).toBe('not-yet-known')
      expect(store.get(r.id)!.fired_at).toBeNull()
      if (kind === 'throw') throw new Error('ack lost')
      return kind === 'void' ? undefined : kind === 'true'
    } } })
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now * 1000 })
    expect((await loop.runOnce()).fired).toBe(kind === 'true' ? 1 : 0)
    const record = store.getDelivery(r.id, r.fire_at)!
    expect(record.state).toBe(kind === 'true' ? 'delivered' : kind === 'false' ? 'known-not-delivered' : 'not-yet-known')
    expect(record.delivered_at).toBe(kind === 'true' ? now : null)
    expect(record.observed_at).toBe(kind === 'true' || kind === 'false' ? now : null)
    expect(store.get(r.id)!.fired_at).toBe(kind === 'true' ? now : null)
  })
}

for (const state of ['known-not-delivered', 'not-yet-known'] as const) {
  test(`${state} exhausts across actual database reopen without firing`, async () => {
    const r = await create()
    let calls = 0
    for (let i = 0; i < 7; i++) {
      const loop = new ReminderTickLoop({ store, now: () => now * 1000,
        dispatcher: { dispatch: async () => { calls++; return { state, reason: 'unconfirmed' } } } })
      expect((await loop.runOnce()).fired).toBe(0)
      expect((await loop.runOnce()).fired).toBe(0)
      db.close()
      db = ProjectDb.open(join(dir, 'project.db'))
      store = new ReminderStore(db)
      now += 30
    }
    expect(calls).toBe(5)
    expect(store.getDelivery(r.id, r.fire_at)).toMatchObject({ attempts: 5, state,
      exhausted_reason: 'undelivered: attempt limit reached', delivered_at: null })
    expect(store.get(r.id)!.status).toBe('pending')
    expect(store.get(r.id)!.fired_at).toBeNull()
  })
}

test('lost completion survives restart and time expiry never stamps fired', async () => {
  const r = await create()
  expect(await store.beginDelivery(r, now, 30)).toBe(1)
  db.close()
  db = ProjectDb.open(join(dir, 'project.db'))
  store = new ReminderStore(db)
  expect(store.getDelivery(r.id, r.fire_at)!.state).toBe('not-yet-known')
  now += 3601
  const loop = new ReminderTickLoop({ store, now: () => now * 1000,
    dispatcher: { dispatch: async () => { throw new Error('must not dispatch expired occurrence') } } })
  expect((await loop.runOnce()).fired).toBe(0)
  expect(store.getDelivery(r.id, r.fire_at)).toMatchObject({ attempts: 1,
    exhausted_reason: 'undelivered: delivery window expired', delivered_at: null })
  expect(store.get(r.id)!.fired_at).toBeNull()
})

test('claim rejects cancelled, moved, terminal, and early attempts', async () => {
  const r = await create()
  expect(await store.beginDelivery(r, now, 30)).toBe(1)
  expect(await store.beginDelivery(r, now, 30)).toBeNull()
  await store.reschedule(r.id, now + 5)
  expect(await store.beginDelivery(r, now + 30, 30)).toBeNull()
  const moved = store.get(r.id)!
  await store.cancel(r.id)
  expect(await store.beginDelivery(moved, now + 30, 30)).toBeNull()
  const good = await create()
  expect(await store.beginDelivery(good, now, 30)).toBe(1)
  expect(await store.observeDelivery(good, 1, delivered, now, null)).toBe(true)
  // Reopen through SQL solely to reach the ledger guard independently of status.
  await db.run("UPDATE reminders SET status = 'pending' WHERE id = ?", [good.id])
  expect(await store.beginDelivery(good, now + 30, 30)).toBeNull()
  const exhausted = await create()
  expect(await store.beginDelivery(exhausted, now + 3601, 30)).toBeNull()
  // Simulate a corrected clock; reach the terminal guard without the cadence guard masking it.
  await db.run('UPDATE reminder_delivery SET next_attempt_at = ? WHERE reminder_id = ?', [now, exhausted.id])
  expect(await store.beginDelivery(exhausted, now, 30)).toBeNull()
})

test('stale or duplicate observation cannot overwrite a newer attempt or delivery', async () => {
  const r = await create()
  expect(await store.beginDelivery(r, now, 30)).toBe(1)
  expect(await store.beginDelivery(r, now + 30, 30)).toBe(2)
  expect(await store.observeDelivery(r, 1, delivered, now + 31, null)).toBe(false)
  expect(store.getDelivery(r.id, r.fire_at)!.state).toBe('not-yet-known')
  expect(await store.observeDelivery(r, 2, delivered, now + 32, null)).toBe(true)
  expect(await store.observeDelivery(r, 2, { state: 'known-not-delivered', reason: 'late' }, now + 33, null)).toBe(false)
  expect(store.getDelivery(r.id, r.fire_at)!.delivered_at).toBe(now + 32)
})

for (const change of ['reschedule', 'cancel'] as const) {
  test(`delivery preserves concurrent owner ${change}`, async () => {
    const r = await create()
    const loop = new ReminderTickLoop({ store, now: () => now * 1000, dispatcher: { dispatch: async () => {
      if (change === 'reschedule') await store.reschedule(r.id, now + 600)
      else await store.cancel(r.id)
      return delivered
    } } })
    expect((await loop.runOnce()).fired).toBe(1)
    expect(store.get(r.id)!.status).toBe(change === 'cancel' ? 'cancelled' : 'pending')
    expect(store.get(r.id)!.fired_at).toBeNull()
    expect(store.getDelivery(r.id, r.fire_at)!.delivered_at).toBe(now)
  })
}

test('query excludes exhausted, delivered and waiting rows before applying limit', async () => {
  const expired = await create(now - 3601)
  await store.beginDelivery(expired, now, 30)
  const waiting = await create(now - 3)
  await store.beginDelivery(waiting, now, 30)
  const done = await create(now - 2)
  await store.beginDelivery(done, now, 30)
  await store.observeDelivery(done, 1, delivered, now, null)
  await db.run("UPDATE reminders SET status = 'pending' WHERE id = ?", [done.id])
  const fresh = await create(now - 1)
  expect(store.listDispatchable(now, 1).map(r => r.id)).toEqual([fresh.id])
})

test('expired recurring occurrence advances atomically without a delivery stamp', async () => {
  const r = await store.createRecurring({ owner_slug: 'sample', topic_id: null,
    message: 'weekly', fire_at: now - 3601, recurrence: 'weekly' })
  const loop = new ReminderTickLoop({ store, now: () => now * 1000,
    dispatcher: { dispatch: async () => delivered } })
  expect((await loop.runOnce()).fired).toBe(0)
  expect(store.get(r.id)!.fire_at).toBeGreaterThan(now)
  expect(store.get(r.id)!.fired_at).toBeNull()
  expect(store.getDelivery(r.id, r.fire_at)!.exhausted_reason).toBe('undelivered: delivery window expired')
})

test('dispatch query filters cadence, delivered and terminal rows before its limit', async () => {
  const r = await create()
  await store.beginDelivery(r, now, 30)
  expect(store.listDispatchable(now, 1)).toEqual([])
  now += 30
  expect(store.listDispatchable(now, 1).map(x => x.id)).toEqual([r.id])
  await store.observeDelivery(r, 1, { state: 'delivered' }, now, null)
  await db.run("UPDATE reminders SET status = 'pending' WHERE id = ?", [r.id])
  expect(store.listDispatchable(now, 1)).toEqual([])
  const expired = await create()
  now += 3601
  await store.beginDelivery(expired, now, 30)
  const fresh = await create()
  expect(store.listDispatchable(now, 1).map(x => x.id)).toEqual([fresh.id])
})

test('database refuses an unclassified delivery observation', async () => {
  const r = await create()
  await store.beginDelivery(r, now, 30)
  await expect(db.run("UPDATE reminder_delivery SET state = 'invented' WHERE reminder_id = ?", [r.id])).rejects.toThrow()
  expect(store.getDelivery(r.id, r.fire_at)!.state).toBe('not-yet-known')
})

test('ritual notices preserve positive evidence through later rejection, silence or throw', async () => {
  for (const last of [false, undefined, 'throw']) {
    const r = await create()
    let posts = 0
    const dispatcher = buildReminderDispatcher({
      llm: { compose: async () => 'body' },
      outbound: { post: () => {
        posts++
        if (posts === 1) return true
        if (last === 'throw') throw new Error('connection closed')
        return last as false | undefined
      } },
      ritual_planner: { plan: async () => ({ kind: 'fire', plan: {
        ritual_id: 'daily', run_id: 'sample', prompt: 'brief', declared_tool_surface: [], silent: false,
        settle: async () => ['notice'],
      } }) },
    })
    expect((await new ReminderTickLoop({ store, dispatcher, now: () => now * 1000 }).runOnce()).fired).toBe(1)
    expect(posts).toBe(2)
    expect(store.getDelivery(r.id, r.fire_at)!.state).toBe('delivered')
  }
})

test('planner throw is unknown while silent success and skipped ritual are non-delivery', async () => {
  const r = await create()
  const failed = buildReminderDispatcher({ outbound: { post: () => true },
    ritual_planner: { plan: async () => { throw new Error('planner unavailable') } } })
  expect(await failed.dispatch(r)).toEqual({ state: 'not-yet-known', reason: 'Error: planner unavailable' })
  const silent = buildReminderDispatcher({ llm: { compose: async () => 'body' }, outbound: { post: () => true },
    ritual_planner: { plan: async () => ({ kind: 'fire', plan: {
      ritual_id: 'daily', run_id: 'sample', prompt: 'brief', declared_tool_surface: [], silent: true,
      settle: async () => [],
    } }) } })
  expect(await silent.dispatch(r)).toMatchObject({ state: 'known-not-delivered' })
  const skipped = buildReminderDispatcher({ outbound: { post: () => true },
    ritual_planner: { plan: async () => ({ kind: 'skipped', ritual_id: 'daily', reason: 'unapproved' }) } })
  expect(await skipped.dispatch(r)).toMatchObject({ state: 'known-not-delivered' })
})

test('attempt three stamps fired once and only once', async () => {
  const r = await create()
  let attempts = 0
  const loop = new ReminderTickLoop({ store, now: () => now * 1000,
    dispatcher: { dispatch: async () => ++attempts === 3 ? delivered : undefined } })
  for (let i = 0; i < 3; i++) {
    expect(store.get(r.id)!.fired_at).toBeNull()
    expect((await loop.runOnce()).fired).toBe(i === 2 ? 1 : 0)
    now += 30
  }
  const stamp = store.get(r.id)!.fired_at
  for (let i = 0; i < 6; i++) { expect((await loop.runOnce()).fired).toBe(0); now += 30 }
  expect(attempts).toBe(3)
  expect(loop.stats().fired).toBe(1)
  expect(store.get(r.id)!.fired_at).toBe(stamp)
  expect(store.getDelivery(r.id, r.fire_at)).toMatchObject({ attempts: 3, state: 'delivered' })
})

test('fifth crashed attempt exhausts on restart without a completion callback', async () => {
  const r = await create()
  for (let i = 1; i <= 5; i++) { expect(await store.beginDelivery(r, now, 30)).toBe(i); now += 30 }
  let calls = 0
  await new ReminderTickLoop({ store, now: () => now * 1000,
    dispatcher: { dispatch: async () => { calls++ } } }).runOnce()
  expect(calls).toBe(0)
  expect(store.getDelivery(r.id, r.fire_at)!.exhausted_reason).toBe('undelivered: attempt limit reached')
})

test('loop permits exactly the hour boundary and refuses later attempts', async () => {
  const r = await create()
  let calls = 0
  const loop = new ReminderTickLoop({ store, now: () => now * 1000,
    dispatcher: { dispatch: async () => { calls++ } } })
  await loop.runOnce()
  now += 3600
  await loop.runOnce()
  expect(calls).toBe(2)
  now += 30
  await loop.runOnce()
  expect(calls).toBe(2)
  expect(store.getDelivery(r.id, r.fire_at)).toMatchObject({ attempts: 2,
    state: 'not-yet-known', exhausted_reason: 'undelivered: delivery window expired' })
})

test('recurring fifth failure advances only its occurrence and retains history', async () => {
  const r = await store.createRecurring({ owner_slug: 'sample', topic_id: null,
    message: 'weekly', fire_at: now, recurrence: 'weekly' })
  const loop = new ReminderTickLoop({ store, now: () => now * 1000,
    dispatcher: { dispatch: async () => undefined } })
  for (let i = 0; i < 5; i++) { await loop.runOnce(); now += 30 }
  expect(store.get(r.id)!.fire_at).toBe(r.fire_at + 7 * 86400)
  expect(store.getDelivery(r.id, r.fire_at)!.exhausted_reason).toBe('undelivered: attempt limit reached')
  now = store.get(r.id)!.fire_at
  await loop.runOnce()
  expect(store.getDelivery(r.id, now)).toMatchObject({ attempts: 1, state: 'not-yet-known' })
})

for (const later of ['false', 'void', 'throw'] as const) {
  test(`an accepted ritual notice survives a later ${later} post`, async () => {
    const r = await create()
    let calls = 0
    const dispatcher = buildReminderDispatcher({ llm: { compose: async () => 'body' },
      ritual_planner: { plan: async () => ({ kind: 'fire', plan: {
        ritual_id: 'sample', run_id: 'run', prompt: 'compose', declared_tool_surface: [], silent: false,
        settle: async () => ['notice'],
      } }) },
      outbound: { post: () => {
        calls++
        if (calls === 1) return true
        if (later === 'throw') throw new Error('second ack lost')
        return later === 'void' ? undefined : false
      } },
    })
    expect(await dispatcher.dispatch(r)).toEqual(delivered)
    expect(calls).toBe(2)
  })
}

test('no post is negative; planner exception is unknown; bare void dispatch is unknown', async () => {
  const r = await create()
  const empty = { ...r, message: ' ' }
  const outbound = { post: () => { throw new Error('must not post') } }
  expect(await buildReminderDispatcher({ outbound }).dispatch(empty)).toMatchObject({ state: 'known-not-delivered' })
  expect(await buildReminderDispatcher({ outbound, ritual_planner: {
    plan: async () => { throw new Error('planner stopped') },
  } }).dispatch(r)).toMatchObject({ state: 'not-yet-known' })
  const loop = new ReminderTickLoop({ store, now: () => now * 1000, dispatcher: { dispatch: async () => {} } })
  expect((await loop.runOnce()).fired).toBe(0)
  expect(store.getDelivery(r.id, r.fire_at)!.state).toBe('not-yet-known')
})

test('fifth crash attempt exhausts on next restart without calling dispatch', async () => {
  const r = await create()
  for (let i = 1; i <= 5; i++) expect(await store.beginDelivery(r, now + i * 30, 30)).toBe(i)
  expect(await store.beginDelivery(r, now + 180, 30)).toBeNull()
  expect(store.getDelivery(r.id, r.fire_at)!.exhausted_reason).toBe('undelivered: attempt limit reached')
})

test('recurring rejection exhausts the occurrence and preserves the next schedule', async () => {
  const r = await store.createRecurring({ owner_slug: 'sample', topic_id: null, message: 'weekly', fire_at: now, recurrence: 'weekly' })
  const loop = new ReminderTickLoop({ store, now: () => now * 1000, dispatcher: {
    dispatch: async () => ({ state: 'known-not-delivered', reason: 'rejected' }),
  } })
  for (let i = 0; i < 5; i++) { expect((await loop.runOnce()).fired).toBe(0); now += 30 }
  expect(store.get(r.id)!.fire_at).toBeGreaterThan(now)
  expect(store.get(r.id)!.fired_at).toBeNull()
  expect(store.getDelivery(r.id, r.fire_at)!.attempts).toBe(5)
})

test('positive evidence on the last attempt wins over retry exhaustion', async () => {
  for (const expireDuringAttempt of [false, true]) {
    const r = await create()
    let calls = 0
    const loop = new ReminderTickLoop({ store, now: () => now * 1000, dispatcher: {
      dispatch: async () => {
        calls++
        if (calls !== 5) return { state: 'not-yet-known', reason: 'no receipt' }
        if (expireDuringAttempt) now = r.fire_at + 3601
        return delivered
      },
    } })
    for (let i = 0; i < 5; i++) {
      expect((await loop.runOnce()).fired).toBe(i === 4 ? 1 : 0)
      now += 30
    }
    expect(store.getDelivery(r.id, r.fire_at)).toMatchObject({ attempts: 5, state: 'delivered', exhausted_reason: null })
    expect(store.get(r.id)!.status).toBe('fired')
  }
})

test('expiry and settlement roll back their ledger when schedule advancement fails', async () => {
  const r = await store.createRecurring({ owner_slug: 'sample', topic_id: null,
    message: 'weekly', fire_at: now, recurrence: 'weekly' })
  await db.exec("CREATE TRIGGER reject_schedule BEFORE UPDATE OF fire_at ON reminders BEGIN SELECT RAISE(ABORT, 'schedule write failed'); END")
  await expect(store.beginDelivery(r, now + 3601, 30, now + 86400)).rejects.toThrow('schedule write failed')
  expect(store.getDelivery(r.id, r.fire_at)).toBeNull()
  expect(await store.beginDelivery(r, now, 30)).toBe(1)
  await expect(store.observeDelivery(r, 1, delivered, now, now + 86400)).rejects.toThrow('schedule write failed')
  expect(store.getDelivery(r.id, r.fire_at)).toMatchObject({ state: 'not-yet-known', delivered_at: null })
  expect(store.get(r.id)!.fire_at).toBe(r.fire_at)
})
