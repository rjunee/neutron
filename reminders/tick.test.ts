import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ReminderStore, type Reminder } from './store.ts'
import {
  ReminderTickLoop,
  type ReminderDispatcher,
  type ReminderFiredHook,
} from './tick.ts'
import type { RitualExecutor } from './ritual-executor.ts'

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
    await store.create({ owner_slug: 't1', topic_id: null, fire_at: now / 1000 - 100, message: 'a' })
    await store.create({ owner_slug: 't1', topic_id: null, fire_at: now / 1000 - 50, message: 'b' })
    await store.create({ owner_slug: 't1', topic_id: null, fire_at: now / 1000 + 1000, message: 'future' })
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
      await store.create({ owner_slug: 't1', topic_id: null, fire_at: now / 1000 - 100, message: `r${i}` })
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
    await store.create({ owner_slug: 't1', topic_id: null, fire_at: now / 1000 - 100, message: 'fail' })
    await store.create({ owner_slug: 't1', topic_id: null, fire_at: now / 1000 - 50, message: 'ok' })
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

  // #319 — crash-window dedup. The row is CLAIMED (status flipped fired /
  // recurrence advanced) BEFORE the post is attempted, so a process crash
  // anywhere during the send leaves an already-claimed row that a post-restart
  // `listDue` will not return — no double-send. The pre-fix loop marked fired
  // only AFTER the post, leaving a `pending` due row across the crash window.
  test('#319 one-shot row is claimed (fired) BEFORE the post, so a crash mid-send cannot re-fire', async () => {
    const store = new ReminderStore(db)
    const now = 10_000_000
    const r = await store.create({
      owner_slug: 't1',
      topic_id: null,
      fire_at: now / 1000 - 100,
      message: 'claim-first',
    })
    let postCount = 0
    // Recorded via an object so the closure mutation isn't control-flow-narrowed.
    const probe: { status: string | null } = { status: null }
    const dispatcher: ReminderDispatcher = {
      dispatch: async (rem) => {
        // Observe the persisted row at the instant the post is attempted.
        probe.status = store.get(rem.id)?.status ?? null
        postCount++
      },
    }
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now })

    await loop.runOnce()
    // The claim is committed BEFORE the dispatcher posts: a crash right after a
    // successful post finds an already-fired row.
    expect(probe.status).toBe('fired')
    expect(postCount).toBe(1)
    expect(store.get(r.id)?.status).toBe('fired')

    // Simulate a restart by ticking again: the claimed row is not re-picked.
    await loop.runOnce()
    expect(postCount).toBe(1)
  })

  test('#319 recurring row is advanced PAST due BEFORE the post, so a crash mid-send cannot re-fire', async () => {
    const store = new ReminderStore(db)
    const now_sec = 10_000_000
    const r = await store.createRecurring({
      owner_slug: 't1',
      topic_id: null,
      fire_at: now_sec - 10,
      message: 'weekly-claim-first',
      recurrence: 'weekly',
    })
    let postCount = 0
    const probe: { fireAt: number | null } = { fireAt: null }
    const dispatcher: ReminderDispatcher = {
      dispatch: async (rem) => {
        probe.fireAt = store.get(rem.id)?.fire_at ?? null
        postCount++
      },
    }
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now_sec * 1000 })

    await loop.runOnce()
    // fire_at was rolled forward to the next occurrence BEFORE the post — so it
    // is no longer due, and a crash-restart tick won't re-fire it.
    expect(probe.fireAt).not.toBeNull()
    expect(probe.fireAt!).toBeGreaterThan(now_sec)
    expect(postCount).toBe(1)
    expect(store.get(r.id)?.status).toBe('pending') // recurring stays pending

    await loop.runOnce()
    expect(postCount).toBe(1) // not due → no double-send
  })

  test('#319 a caught dispatch throw REVERTS the claim so the row retries (one-shot)', async () => {
    const store = new ReminderStore(db)
    const now = 10_000_000
    const r = await store.create({
      owner_slug: 't1',
      topic_id: null,
      fire_at: now / 1000 - 100,
      message: 'rejected-post',
    })
    let attempts = 0
    const dispatcher: ReminderDispatcher = {
      dispatch: async () => {
        attempts++
        if (attempts === 1) throw new Error('outbound post rejected — left pending for retry')
      },
    }
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now })

    await loop.runOnce()
    // First tick claimed then the post failed → claim reverted to pending.
    expect(store.get(r.id)?.status).toBe('pending')
    expect(store.get(r.id)?.fired_at).toBeNull()

    // Second tick re-fires the still-pending row and succeeds.
    await loop.runOnce()
    expect(attempts).toBe(2)
    expect(store.get(r.id)?.status).toBe('fired')
  })

  test('#319 a caught dispatch throw REVERTS the claim so the recurring row stays due', async () => {
    const store = new ReminderStore(db)
    const now_sec = 10_000_000
    const initial_fire = now_sec - 10
    const r = await store.createRecurring({
      owner_slug: 't1',
      topic_id: null,
      fire_at: initial_fire,
      message: 'weekly-rejected',
      recurrence: 'weekly',
    })
    const dispatcher: ReminderDispatcher = {
      dispatch: async () => {
        throw new Error('outbound post rejected — left pending for retry')
      },
    }
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now_sec * 1000 })

    await loop.runOnce()
    // The advance was reverted: the row is still due at its original fire_at.
    const after = store.get(r.id)
    expect(after?.status).toBe('pending')
    expect(after?.fire_at).toBe(initial_fire)
    expect(store.listDue(now_sec).map((x) => x.id)).toContain(r.id)
  })

  test('#319 a concurrent reschedule during dispatch is NOT clobbered by the claim revert', async () => {
    const store = new ReminderStore(db)
    const now_sec = 10_000_000
    const initial_fire = now_sec - 10
    const owner_new_fire = now_sec + 99_999 // owner moves it far into the future
    const r = await store.createRecurring({
      owner_slug: 't1',
      topic_id: null,
      fire_at: initial_fire,
      message: 'weekly-raced',
      recurrence: 'weekly',
    })
    const dispatcher: ReminderDispatcher = {
      dispatch: async (rem) => {
        // Simulate the owner rescheduling WHILE the (long) dispatch is in
        // flight — the claim already advanced fire_at; this overrides it.
        await store.reschedule(rem.id, owner_new_fire)
        throw new Error('post failed after the owner rescheduled')
      },
    }
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now_sec * 1000 })

    await loop.runOnce()
    // The revert is a CAS keyed on the claimed fire_at, so the owner's new time
    // survives — it is NOT overwritten back to the original due time.
    const after = store.get(r.id)
    expect(after?.status).toBe('pending')
    expect(after?.fire_at).toBe(owner_new_fire)
  })

  test('recurring rows roll forward to the next occurrence instead of marking fired', async () => {
    const store = new ReminderStore(db)
    const now_sec = 10_000_000
    const initial_fire = now_sec - 10
    const oneShot = await store.create({
      owner_slug: 't1',
      topic_id: null,
      fire_at: now_sec - 5,
      message: 'one-shot',
    })
    const recurring = await store.createRecurring({
      owner_slug: 't1',
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

  test('cron reminder advances to the next wall-clock occurrence (not a fixed delta)', async () => {
    const store = new ReminderStore(db)
    // Fix "now" to 2026-01-15 08:00:00 UTC; a daily 09:00 UTC cron should
    // advance to 2026-01-15 09:00:00 UTC — one hour later, NOT a coarse delta.
    const now_ms = Date.UTC(2026, 0, 15, 8, 0, 0)
    const now_sec = now_ms / 1000
    const cron = await store.createRecurring({
      owner_slug: 't1',
      topic_id: null,
      fire_at: now_sec - 10, // already due
      message: 'daily 9am',
      recurrence_spec: '0 9 * * *',
    })
    const dispatcher = recordingDispatcher()
    const loop = new ReminderTickLoop({
      store,
      dispatcher,
      now: () => now_ms,
      time_zone: 'UTC',
    })
    const result = await loop.runOnce()
    expect(result.fired).toBe(1)

    const advanced = store.get(cron.id)
    expect(advanced?.status).toBe('pending')
    expect(advanced?.recurrence).toBeNull()
    expect(advanced?.recurrence_spec).toBe('0 9 * * *')
    // Next fire is today 09:00 UTC (strictly after now = 08:00).
    expect(advanced?.fire_at).toBe(Date.UTC(2026, 0, 15, 9, 0, 0) / 1000)
  })

  test('cron reminder rolls to tomorrow when the daily time already passed today', async () => {
    const store = new ReminderStore(db)
    // "now" = 2026-01-15 09:30 UTC — today's 09:00 fire is past.
    const now_ms = Date.UTC(2026, 0, 15, 9, 30, 0)
    const cron = await store.createRecurring({
      owner_slug: 't1',
      topic_id: null,
      fire_at: now_ms / 1000 - 10,
      message: 'daily 9am',
      recurrence_spec: '0 9 * * *',
    })
    const dispatcher = recordingDispatcher()
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now_ms, time_zone: 'UTC' })
    await loop.runOnce()
    expect(store.get(cron.id)?.fire_at).toBe(Date.UTC(2026, 0, 16, 9, 0, 0) / 1000)
  })

  test('a corrupt cron cadence fires once then retires (does not wedge the tick loop)', async () => {
    const store = new ReminderStore(db)
    const now_ms = Date.UTC(2026, 0, 15, 8, 0, 0)
    // recurrence_spec bypasses the tool-boundary validator here (store is
    // deliberately opaque), so simulate a poison row reaching the tick loop.
    const poison = await store.createRecurring({
      owner_slug: 't1',
      topic_id: null,
      fire_at: now_ms / 1000 - 10,
      message: 'broken',
      recurrence_spec: 'not a cron',
    })
    const dispatcher = recordingDispatcher()
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now_ms, time_zone: 'UTC' })
    const result = await loop.runOnce()
    // It dispatched once…
    expect(result.fired).toBe(1)
    // …and retired (marked fired) rather than throwing every tick.
    expect(store.get(poison.id)?.status).toBe('fired')
    expect(store.listPending('t1').length).toBe(0)
  })

  test('recurring next-fire floors at now+60s when the candidate is in the past (catch-up suppressed)', async () => {
    const store = new ReminderStore(db)
    const now_sec = 100_000_000
    // Fire was a month ago + cadence is weekly → candidate would be 23 days
    // in the past. Floor at now+60s.
    const old_fire = now_sec - 30 * 24 * 60 * 60
    const recurring = await store.createRecurring({
      owner_slug: 't1',
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
      owner_slug: 't1',
      topic_id: null,
      fire_at: now / 1000 - 100,
      message: 'a',
    })
    const b = await store.create({
      owner_slug: 't1',
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
      owner_slug: 't1',
      topic_id: null,
      fire_at: now / 1000 - 100,
      message: 'first',
    })
    await store.create({
      owner_slug: 't1',
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
      owner_slug: 't1',
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
      owner_slug: 't1',
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
      owner_slug: 't1',
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
    await store.create({ owner_slug: 't1', topic_id: null, fire_at: now / 1000 - 100, message: 'a' })
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

/**
 * Executor-mode reminders (plan task 4) — the ritual dispatch branch. A due row
 * with a non-null `ritual_id` routes to `ritual_executor.fire` (fire-and-forget),
 * NEVER the nudge `dispatcher` + `on_fired`, and NEVER reverts its #319 claim.
 */
describe('ReminderTickLoop — ritual executor branch', () => {
  /** Tag an already-created reminder row as a ritual (task-8 write path not yet live). */
  function tagRitual(id: string, ritual_id: string): void {
    db.raw().run('UPDATE reminders SET ritual_id = ? WHERE id = ?', [ritual_id, id])
  }

  test('a ritual row fires the executor, NOT the dispatcher or on_fired', async () => {
    const store = new ReminderStore(db)
    const now = 10_000_000
    const ritualRow = await store.create({ owner_slug: 't1', topic_id: null, fire_at: now / 1000 - 100, message: 'brief' })
    tagRitual(ritualRow.id, 'morning-brief')

    const dispatcher = recordingDispatcher()
    const onFiredCalls: Reminder[] = []
    const on_fired: ReminderFiredHook = { onFired: async (r) => { onFiredCalls.push(r) } }
    const fire = mock(async (_r: Reminder) => {})
    const ritual_executor: RitualExecutor = { fire }

    const loop = new ReminderTickLoop({ store, dispatcher, on_fired, ritual_executor, now: () => now })
    const res = await loop.runOnce()

    expect(res.fired).toBe(1)
    expect(fire).toHaveBeenCalled()
    // The executor saw the row snapshot (with the ritual_id set).
    expect(fire.mock.calls[0]![0].id).toBe(ritualRow.id)
    expect(fire.mock.calls[0]![0].ritual_id).toBe('morning-brief')
    // The nudge dispatcher + push hook were NEVER touched for a ritual row.
    expect(dispatcher.fired).toHaveLength(0)
    expect(onFiredCalls).toHaveLength(0)
    // The row was claimed (one-shot → fired), not left pending.
    expect(store.get(ritualRow.id)!.status).toBe('fired')
  })

  test('a nudge row in the SAME tick still goes through the dispatcher + on_fired (contract untouched)', async () => {
    const store = new ReminderStore(db)
    const now = 10_000_000
    const nudge = await store.create({ owner_slug: 't1', topic_id: null, fire_at: now / 1000 - 100, message: 'nudge' })
    const ritualRow = await store.create({ owner_slug: 't1', topic_id: null, fire_at: now / 1000 - 90, message: 'ritual' })
    tagRitual(ritualRow.id, 'evening-wrap')

    const dispatcher = recordingDispatcher()
    const onFiredCalls: Reminder[] = []
    const on_fired: ReminderFiredHook = { onFired: async (r) => { onFiredCalls.push(r) } }
    const fire = mock(async (_r: Reminder) => {})
    const loop = new ReminderTickLoop({ store, dispatcher, on_fired, ritual_executor: { fire }, now: () => now })

    const res = await loop.runOnce()
    expect(res.fired).toBe(2)
    // The nudge went through the dispatcher + push; the ritual did not.
    expect(dispatcher.fired.map((r) => r.message)).toEqual(['nudge'])
    expect(onFiredCalls.map((r) => r.message)).toEqual(['nudge'])
    expect(fire).toHaveBeenCalledTimes(1)
    expect(fire.mock.calls[0]![0].id).toBe(ritualRow.id)
  })

  test('a recurring ritual advances (fire_at moves) with NO revert even when fire() rejects', async () => {
    const store = new ReminderStore(db)
    const now = 10_000_000
    const row = await store.createRecurring({
      owner_slug: 't1',
      topic_id: null,
      fire_at: now / 1000 - 100,
      message: 'daily ritual',
      recurrence: 'weekly',
    })
    tagRitual(row.id, 'daily-delta')
    const originalFireAt = row.fire_at

    // fire() rejects — the tick must NOT revert the claim (history rows are the
    // record; the recurring row already advanced to its next cadence).
    const fire = mock(async (_r: Reminder) => {
      throw new Error('executor blew up')
    })
    const dispatcher = recordingDispatcher()
    const loop = new ReminderTickLoop({ store, dispatcher, ritual_executor: { fire }, now: () => now })

    const res = await loop.runOnce()
    expect(res.fired).toBe(1)
    expect(fire).toHaveBeenCalled()
    // The row is STILL pending (recurring) but its fire_at ADVANCED — no revert.
    const after = store.get(row.id)!
    expect(after.status).toBe('pending')
    expect(after.fire_at).toBeGreaterThan(originalFireAt)
    // A second tick at the same `now` finds nothing due (proof the advance stuck).
    const res2 = await loop.runOnce()
    expect(res2.fired).toBe(0)
    // Never fell back to the nudge dispatcher.
    expect(dispatcher.fired).toHaveLength(0)
  })

  test('a ritual row with NO executor wired is consumed + logged, never dispatched as a nudge', async () => {
    const store = new ReminderStore(db)
    const now = 10_000_000
    const row = await store.create({ owner_slug: 't1', topic_id: null, fire_at: now / 1000 - 100, message: 'orphan ritual' })
    tagRitual(row.id, 'unwired')

    const dispatcher = recordingDispatcher()
    // No ritual_executor supplied.
    const loop = new ReminderTickLoop({ store, dispatcher, now: () => now })
    const res = await loop.runOnce()

    expect(res.fired).toBe(1)
    // Consumed (claimed → fired), and NEVER handed to the nudge dispatcher.
    expect(store.get(row.id)!.status).toBe('fired')
    expect(dispatcher.fired).toHaveLength(0)
  })

  test('runOnce RESOLVES while the executor turn is still pending (fire-and-forget)', async () => {
    const store = new ReminderStore(db)
    const now = 10_000_000
    const row = await store.create({ owner_slug: 't1', topic_id: null, fire_at: now / 1000 - 100, message: 'slow ritual' })
    tagRitual(row.id, 'slow')

    // fire() returns a promise that NEVER resolves — runOnce must not await it.
    let seen = false
    const fire = mock((_r: Reminder): Promise<void> => {
      seen = true
      return new Promise<void>(() => {})
    })
    const dispatcher = recordingDispatcher()
    const loop = new ReminderTickLoop({ store, dispatcher, ritual_executor: { fire }, now: () => now })

    // If the tick awaited fire(), this would hang. It resolves → proof.
    const res = await loop.runOnce()
    expect(res.fired).toBe(1)
    expect(seen).toBe(true)
    expect(fire).toHaveBeenCalled()
  })
})
