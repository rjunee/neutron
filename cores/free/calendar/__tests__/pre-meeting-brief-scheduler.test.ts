/**
 * Calendar Core S1 — pre-meeting-brief scheduler tests.
 *
 * Exercises the Option-B per-Core timer wheel against a synthetic
 * cache + fake timer to verify (a) boot enqueues fires for events in
 * the lookahead window, (b) fires run at `event.start - lead_ms`,
 * (c) cancelled events are de-queued on the next tick.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PRE_MEETING_LEAD_MS,
  buildPreMeetingBriefScheduler,
  type PreMeetingBriefFireInput,
  type TimerHandle,
} from '../src/pre-meeting-brief-scheduler.ts'
import {
  openCalendarProjectCache,
  type CalendarProjectCache,
} from '../src/cache.ts'
import {
  buildInMemoryCalendarClient,
  type CalendarEventRow,
} from '../src/backend.ts'
import {
  InMemoryPreMeetingBriefQueueStore,
} from '../src/pre-meeting-brief-queue-store.ts'

interface FakeTimer extends TimerHandle {
  fire_at_ms: number
  fn: () => void
  cancelled: boolean
}

interface FakeClock {
  now_ms: number
  pending: FakeTimer[]
  schedule(fn: () => void, delay_ms: number): FakeTimer
  advanceTo(t_ms: number): void
}

function buildFakeClock(start_ms: number): FakeClock {
  let now = start_ms
  const pending: FakeTimer[] = []
  return {
    get now_ms(): number {
      return now
    },
    set now_ms(v: number) {
      now = v
    },
    pending,
    schedule(fn, delay_ms): FakeTimer {
      const t: FakeTimer = {
        fire_at_ms: now + Math.max(0, delay_ms),
        fn,
        cancelled: false,
        cancel(): void {
          this.cancelled = true
        },
      }
      pending.push(t)
      return t
    },
    advanceTo(target_ms): void {
      while (true) {
        const next = pending
          .filter((t) => !t.cancelled && t.fire_at_ms <= target_ms)
          .sort((a, b) => a.fire_at_ms - b.fire_at_ms)[0]
        if (next === undefined) break
        now = next.fire_at_ms
        next.cancelled = true
        next.fn()
      }
      now = target_ms
    },
  }
}

let tmp: string
let cache: CalendarProjectCache

function seedRow(
  partial: Partial<CalendarEventRow> & {
    id: string
    title: string
    start: string
    end: string
  },
): CalendarEventRow {
  return {
    calendar_id: 'primary',
    status: 'confirmed',
    ...partial,
  } as CalendarEventRow
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'calendar-sched-'))
  cache = openCalendarProjectCache({
    dir: join(tmp, 'projA', 'calendar'),
    project_id: 'projA',
  })
})
afterEach(() => {
  cache.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('pre-meeting-brief scheduler', () => {
  test('boot enqueues one fire per upcoming event in the lookahead window', async () => {
    const NOW = Date.parse('2026-05-21T09:00:00Z')
    const clock = buildFakeClock(NOW)

    cache.upsertEvents([
      // In-window — fire enqueued.
      seedRow({
        id: 'evt-1',
        title: 'Soon',
        start: new Date(NOW + 30 * 60_000).toISOString(),
        end: new Date(NOW + 60 * 60_000).toISOString(),
      }),
      // Past — fire skipped (start - lead < now).
      seedRow({
        id: 'evt-past',
        title: 'Past',
        start: new Date(NOW - 60 * 60_000).toISOString(),
        end: new Date(NOW - 30 * 60_000).toISOString(),
      }),
      // Outside lookahead — fire skipped.
      seedRow({
        id: 'evt-far',
        title: 'Far',
        start: new Date(NOW + 48 * 60 * 60_000).toISOString(),
        end: new Date(NOW + 48 * 60 * 60_000 + 30 * 60_000).toISOString(),
      }),
    ])

    const fired: PreMeetingBriefFireInput[] = []
    const scheduler = buildPreMeetingBriefScheduler({
      cacheFor: async () => cache,
      listProjects: async () => [{ project_id: 'projA' }],
      queueStore: new InMemoryPreMeetingBriefQueueStore(),
      fire: async (input) => {
        fired.push(input)
      },
      now: () => clock.now_ms,
      scheduleTimer: (fn, ms) => clock.schedule(fn, ms),
      lookahead_ms: 24 * 60 * 60 * 1000,
    })

    await scheduler.start()
    try {
      expect(scheduler.enqueued.size).toBe(1)
      const entry = scheduler.enqueued.get('primary:evt-1')
      expect(entry?.project_id).toBe('projA')

      // Advance past the fire instant.
      const fireInstant = Date.parse(new Date(NOW + 30 * 60_000).toISOString())
        - PRE_MEETING_LEAD_MS
      clock.advanceTo(fireInstant + 1)
      await new Promise((r) => setTimeout(r, 5))
      expect(fired).toHaveLength(1)
      expect(fired[0]?.event.id).toBe('evt-1')
    } finally {
      await scheduler.stop()
    }
  })

  test('tick re-walks the cache and picks up newly-cached events', async () => {
    const NOW = Date.parse('2026-05-21T09:00:00Z')
    const clock = buildFakeClock(NOW)

    const fired: PreMeetingBriefFireInput[] = []
    const scheduler = buildPreMeetingBriefScheduler({
      cacheFor: async () => cache,
      listProjects: async () => [{ project_id: 'projA' }],
      queueStore: new InMemoryPreMeetingBriefQueueStore(),
      fire: async (input) => {
        fired.push(input)
      },
      now: () => clock.now_ms,
      scheduleTimer: (fn, ms) => clock.schedule(fn, ms),
    })

    await scheduler.start()
    try {
      expect(scheduler.enqueued.size).toBe(0)
      cache.upsertEvents([
        seedRow({
          id: 'evt-new',
          title: 'NewlyCached',
          start: new Date(NOW + 60 * 60_000).toISOString(),
          end: new Date(NOW + 90 * 60_000).toISOString(),
        }),
      ])
      await scheduler.tick(clock.now_ms)
      expect(scheduler.enqueued.size).toBe(1)
    } finally {
      await scheduler.stop()
    }
  })

  test('boot pulls events from client.list and upserts cache when client is wired (Argus r2 BLOCKER #1)', async () => {
    // Prior bug: scheduler read only the cache, which was populated
    // EXCLUSIVELY by `/cal create`. Events Sam / customers create
    // directly in Google Calendar (the realistic pattern) never
    // appeared in the cache → no briefs ever fired.
    //
    // Fix: scheduler calls `opts.client.list()` and upserts results
    // into the cache before walking it. Seed an event ONLY in the
    // client (not in the cache) and assert the scheduler enqueues
    // its timer + populates the cache.
    const NOW = Date.parse('2026-05-21T09:00:00Z')
    const clock = buildFakeClock(NOW)

    const client = buildInMemoryCalendarClient()
    const created = await client.create({
      title: 'External Event',
      start: new Date(NOW + 60 * 60_000).toISOString(),
      end: new Date(NOW + 90 * 60_000).toISOString(),
      project_id: 'projA',
    })

    // Cache is empty BEFORE start().
    expect(
      cache.listEvents({
        range_start_ms: NOW,
        range_end_ms: NOW + 24 * 60 * 60_000,
      }),
    ).toHaveLength(0)

    const fired: PreMeetingBriefFireInput[] = []
    const scheduler = buildPreMeetingBriefScheduler({
      cacheFor: async () => cache,
      listProjects: async () => [{ project_id: 'projA' }],
      queueStore: new InMemoryPreMeetingBriefQueueStore(),
      client,
      fire: async (input) => {
        fired.push(input)
      },
      now: () => clock.now_ms,
      scheduleTimer: (fn, ms) => clock.schedule(fn, ms),
    })

    await scheduler.start()
    try {
      // Scheduler called client.list, upserted into cache, walked
      // cache, and enqueued the timer for the external event.
      expect(scheduler.enqueued.size).toBe(1)
      const enq = scheduler.enqueued.get(`primary:${created.id}`)
      expect(enq?.project_id).toBe('projA')

      // Cache now reflects the live fetch.
      const cached = cache.listEvents({
        range_start_ms: NOW,
        range_end_ms: NOW + 24 * 60 * 60_000,
      })
      expect(cached).toHaveLength(1)
      expect(cached[0]?.title).toBe('External Event')

      // Fire the timer + verify the brief callback ran with the
      // event from the live fetch.
      const fireInstant =
        Date.parse(new Date(NOW + 60 * 60_000).toISOString()) - PRE_MEETING_LEAD_MS
      clock.advanceTo(fireInstant + 1)
      await new Promise((r) => setTimeout(r, 5))
      expect(fired).toHaveLength(1)
      expect(fired[0]?.event.title).toBe('External Event')
    } finally {
      await scheduler.stop()
    }
  })

  test('client.list failures fall back to cache walk (Argus r2 BLOCKER #1)', async () => {
    // The live-fetch step is best-effort: a transient Google failure
    // must not stop the scheduler from re-firing briefs for events
    // already in the cache. Seed the cache directly, wire a throwing
    // client, and verify the scheduler still enqueues from the cache.
    const NOW = Date.parse('2026-05-21T09:00:00Z')
    const clock = buildFakeClock(NOW)

    cache.upsertEvents([
      seedRow({
        id: 'evt-already-cached',
        title: 'Already cached',
        start: new Date(NOW + 60 * 60_000).toISOString(),
        end: new Date(NOW + 90 * 60_000).toISOString(),
      }),
    ])

    const throwingClient = buildInMemoryCalendarClient()
    const originalList = throwingClient.list.bind(throwingClient)
    void originalList
    throwingClient.list = async (): Promise<CalendarEventRow[]> => {
      throw new Error('transient google failure')
    }

    const scheduler = buildPreMeetingBriefScheduler({
      cacheFor: async () => cache,
      listProjects: async () => [{ project_id: 'projA' }],
      queueStore: new InMemoryPreMeetingBriefQueueStore(),
      client: throwingClient,
      fire: async () => {},
      now: () => clock.now_ms,
      scheduleTimer: (fn, ms) => clock.schedule(fn, ms),
    })

    await scheduler.start()
    try {
      expect(scheduler.enqueued.size).toBe(1)
    } finally {
      await scheduler.stop()
    }
  })

  test('cancelled events de-queue on the next walk + durable row marked skipped (Argus r2 B1)', async () => {
    const NOW = Date.parse('2026-05-21T09:00:00Z')
    const clock = buildFakeClock(NOW)

    cache.upsertEvents([
      seedRow({
        id: 'evt-1',
        title: 'Will be cancelled',
        start: new Date(NOW + 60 * 60_000).toISOString(),
        end: new Date(NOW + 90 * 60_000).toISOString(),
      }),
    ])

    const fired: PreMeetingBriefFireInput[] = []
    const queueStore = new InMemoryPreMeetingBriefQueueStore()
    const scheduler = buildPreMeetingBriefScheduler({
      cacheFor: async () => cache,
      listProjects: async () => [{ project_id: 'projA' }],
      queueStore,
      fire: async (input) => {
        fired.push(input)
      },
      now: () => clock.now_ms,
      scheduleTimer: (fn, ms) => clock.schedule(fn, ms),
    })

    await scheduler.start()
    try {
      expect(scheduler.enqueued.size).toBe(1)
      // Durable row recorded as pending after the boot walk.
      const pendingAfterBoot = await queueStore.listPending('projA')
      expect(pendingAfterBoot).toHaveLength(1)

      cache.upsertEvents([
        seedRow({
          id: 'evt-1',
          title: 'Will be cancelled',
          start: new Date(NOW + 60 * 60_000).toISOString(),
          end: new Date(NOW + 90 * 60_000).toISOString(),
          status: 'cancelled',
        }),
      ])
      await scheduler.tick(clock.now_ms)
      expect(scheduler.enqueued.size).toBe(0)

      // Argus r2 BLOCKER B1 — the durable row MUST be cleared too. A
      // boot between cancellation and `fire_at_ms` re-arms a 0-delay
      // timer from `rehydrateFromQueueStore` otherwise (the durable
      // row reads `pending`) → ghost brief.
      const pendingAfterCancel = await queueStore.listPending('projA')
      expect(pendingAfterCancel).toHaveLength(0)
      const row = queueStore.getRow('primary', 'evt-1')
      expect(row?.status).toBe('skipped')
      expect(row?.skip_reason).toBe('event_removed_from_cache')
    } finally {
      await scheduler.stop()
    }
  })

  // Argus r2 BLOCKER B1 (PR #276) — pre-fix the in-memory cache walk
  // cancelled the timer + removed the queue entry, but the durable
  // SQLite row stayed `pending`. A gateway restart between cancellation
  // and `fire_at_ms` would re-arm a 0-delay timer from
  // `rehydrateFromQueueStore` and fire a ghost brief for an event that
  // no longer exists. Two-boot regression: simulate a cancel + restart
  // and assert no brief is delivered + the row is `skipped`.
  test('two-boot: cancelled event does not re-fire after restart (Argus r2 B1)', async () => {
    const NOW = Date.parse('2026-05-21T09:00:00Z')
    const MEETING_START = NOW + 10 * 60_000 // 10 min from boot
    const FIRE_AT = MEETING_START - 5 * 60_000 // 5 min lead → fires NOW + 5 min
    const queueStore = new InMemoryPreMeetingBriefQueueStore()

    // 1. Boot scheduler #1 + cache the event.
    cache.upsertEvents([
      seedRow({
        id: 'evt-cancel',
        title: 'Will cancel before fire',
        start: new Date(MEETING_START).toISOString(),
        end: new Date(MEETING_START + 30 * 60_000).toISOString(),
      }),
    ])
    const clock1 = buildFakeClock(NOW)
    const fires1: PreMeetingBriefFireInput[] = []
    const scheduler1 = buildPreMeetingBriefScheduler({
      cacheFor: async () => cache,
      listProjects: async () => [{ project_id: 'projA' }],
      queueStore,
      lead_ms: 5 * 60_000,
      fire: async (input) => {
        fires1.push(input)
      },
      now: () => clock1.now_ms,
      scheduleTimer: (fn, ms) => clock1.schedule(fn, ms),
    })
    await scheduler1.start()
    expect(scheduler1.enqueued.size).toBe(1)
    const pendingBeforeCancel = await queueStore.listPending('projA')
    expect(pendingBeforeCancel).toHaveLength(1)
    expect(pendingBeforeCancel[0]?.fire_at_ms).toBe(FIRE_AT)

    // 2. Cancel the event in the cache.
    cache.upsertEvents([
      seedRow({
        id: 'evt-cancel',
        title: 'Will cancel before fire',
        start: new Date(MEETING_START).toISOString(),
        end: new Date(MEETING_START + 30 * 60_000).toISOString(),
        status: 'cancelled',
      }),
    ])

    // 3. Run a tick → stale-drop loop fires → in-memory entry dropped
    //    + durable row marked skipped.
    await scheduler1.tick(clock1.now_ms)
    expect(scheduler1.enqueued.size).toBe(0)
    const pendingAfterCancel = await queueStore.listPending('projA')
    expect(pendingAfterCancel).toHaveLength(0)
    const skippedRow = queueStore.getRow('primary', 'evt-cancel')
    expect(skippedRow?.status).toBe('skipped')
    expect(skippedRow?.skip_reason).toBe('event_removed_from_cache')

    // 4. Tear down scheduler #1 (no shutdown sync needed — state is
    //    durable in the queue store).
    await scheduler1.stop()
    expect(fires1).toHaveLength(0)

    // 5. Boot scheduler #2 from the same queue store. Advance the clock
    //    past the original fire window so any re-armed 0-delay timer
    //    would fire immediately.
    const clock2 = buildFakeClock(FIRE_AT + 1 * 60_000) // 1 min past fire window
    const fires2: PreMeetingBriefFireInput[] = []
    const scheduler2 = buildPreMeetingBriefScheduler({
      cacheFor: async () => cache,
      listProjects: async () => [{ project_id: 'projA' }],
      queueStore,
      lead_ms: 5 * 60_000,
      fire: async (input) => {
        fires2.push(input)
      },
      now: () => clock2.now_ms,
      scheduleTimer: (fn, ms) => clock2.schedule(fn, ms),
    })
    await scheduler2.start()
    try {
      // 6. Advance the clock further past the fire window — any 0-delay
      //    timer armed by rehydration would have fired by now.
      clock2.advanceTo(clock2.now_ms + 10_000)
      await new Promise((r) => setTimeout(r, 5))

      // 7. The CRITICAL assertion: NO brief delivered for the cancelled
      //    event. Pre-fix this would fire because the durable row was
      //    still `pending` → rehydrate re-armed a 0-delay timer.
      const ghost = fires2.find((f) => f.event.id === 'evt-cancel')
      expect(ghost).toBeUndefined()

      // 8. Durable row remains skipped (rehydrate skipped it because
      //    status !== 'pending').
      const stillSkipped = queueStore.getRow('primary', 'evt-cancel')
      expect(stillSkipped?.status).toBe('skipped')
      expect(stillSkipped?.skip_reason).toBe('event_removed_from_cache')
    } finally {
      await scheduler2.stop()
    }
  })

  // ISSUE #16 — durable queue store.
  //
  // Prior bug at `pre-meeting-brief-scheduler.ts:172`:
  // `if (fireAt <= t) continue` silently dropped any event whose
  // lead window had passed by the time the scheduler `start()`
  // ran. A gateway restart between `fire_at_ms` and `meeting_start_ms`
  // → no brief ever fired. Fix: durable queue store re-walked on boot.
  test('survives gateway restart — brief fires after restart within the lead window (ISSUE #16)', async () => {
    const NOW = Date.parse('2026-05-21T09:00:00Z')
    const clock = buildFakeClock(NOW)
    const MEETING_START = NOW + 10 * 60_000 // 10 min from boot

    cache.upsertEvents([
      seedRow({
        id: 'evt-survives',
        title: 'Important meeting',
        start: new Date(MEETING_START).toISOString(),
        end: new Date(MEETING_START + 30 * 60_000).toISOString(),
      }),
    ])

    const queueStore = new InMemoryPreMeetingBriefQueueStore()
    const fires1: PreMeetingBriefFireInput[] = []

    // 1. Boot scheduler #1 — lead = 5 min so fire_at_ms = NOW + 5 min.
    const scheduler1 = buildPreMeetingBriefScheduler({
      cacheFor: async () => cache,
      listProjects: async () => [{ project_id: 'projA' }],
      queueStore,
      lead_ms: 5 * 60_000,
      fire: async (input) => {
        fires1.push(input)
      },
      now: () => clock.now_ms,
      scheduleTimer: (fn, ms) => clock.schedule(fn, ms),
    })
    await scheduler1.start()
    expect(scheduler1.enqueued.size).toBe(1)
    // Row enqueued in durable store with pending status.
    const pendingAfterStart = await queueStore.listPending('projA')
    expect(pendingAfterStart).toHaveLength(1)
    expect(pendingAfterStart[0]?.calendar_id).toBe('primary')
    expect(pendingAfterStart[0]?.event_id).toBe('evt-survives')
    expect(pendingAfterStart[0]?.meeting_start_ms).toBe(MEETING_START)

    // 2. Tear down scheduler #1 — simulates gateway crash BEFORE fire.
    //    (In-process timer is dropped; durable row stays pending.)
    await scheduler1.stop()
    expect(fires1).toHaveLength(0)
    // Row still pending after stop — stop() only releases in-process
    // timers; nothing removes the durable row.
    const stillPending = await queueStore.listPending('projA')
    expect(stillPending).toHaveLength(1)

    // 3. Advance clock past the fire window (NOW + 6 min — fire_at was
    //    NOW + 5 min) but still BEFORE meeting_start_ms (NOW + 10 min).
    clock.now_ms = NOW + 6 * 60_000

    // 4. Boot scheduler #2 against the SAME queueStore.
    const fires2: PreMeetingBriefFireInput[] = []
    const scheduler2 = buildPreMeetingBriefScheduler({
      cacheFor: async () => cache,
      listProjects: async () => [{ project_id: 'projA' }],
      queueStore,
      lead_ms: 5 * 60_000,
      fire: async (input) => {
        fires2.push(input)
      },
      now: () => clock.now_ms,
      scheduleTimer: (fn, ms) => clock.schedule(fn, ms),
    })
    await scheduler2.start()
    try {
      // Rehydration step armed an immediate-fire (0-delay) timer.
      // Advance the fake clock to flush it.
      clock.advanceTo(clock.now_ms + 10)
      await new Promise((r) => setTimeout(r, 5))

      // 5. Brief delivered after restart.
      expect(fires2.length).toBeGreaterThanOrEqual(1)
      const fired = fires2.find((f) => f.event.id === 'evt-survives')
      expect(fired).toBeDefined()

      // 6. Durable row marked fired (no longer pending).
      const pendingAfterFire = await queueStore.listPending('projA')
      expect(pendingAfterFire).toHaveLength(0)
      const all = queueStore.allRows()
      const row = all.find((r) => r.event_id === 'evt-survives')
      expect(row?.status).toBe('fired')
      expect(row?.fired_at_ms).not.toBeNull()
    } finally {
      await scheduler2.stop()
    }
  })

  test('past-window row at boot marks skipped with a reason (ISSUE #16)', async () => {
    const NOW = Date.parse('2026-05-21T09:00:00Z')
    const clock = buildFakeClock(NOW)

    // Pre-seed a row whose meeting_start_ms is already in the past.
    const queueStore = new InMemoryPreMeetingBriefQueueStore()
    await queueStore.upsertPending({
      calendar_id: 'primary',
      event_id: 'evt-stale',
      project_id: 'projA',
      meeting_start_ms: NOW - 60_000, // started 1 min ago
      lead_time_ms: 10 * 60_000,
      fire_at_ms: NOW - 11 * 60_000, // fire window 11 min ago
      enqueued_at_ms: NOW - 20 * 60_000,
    })

    const fires: PreMeetingBriefFireInput[] = []
    const scheduler = buildPreMeetingBriefScheduler({
      cacheFor: async () => cache,
      listProjects: async () => [{ project_id: 'projA' }],
      queueStore,
      fire: async (input) => {
        fires.push(input)
      },
      now: () => clock.now_ms,
      scheduleTimer: (fn, ms) => clock.schedule(fn, ms),
    })
    await scheduler.start()
    try {
      // No fire — the meeting already started, so the brief is
      // useless. The row flips to `skipped` with a reason.
      clock.advanceTo(clock.now_ms + 100)
      await new Promise((r) => setTimeout(r, 5))
      expect(fires).toHaveLength(0)

      const row = queueStore.getRow('primary', 'evt-stale')
      expect(row).not.toBeNull()
      expect(row?.status).toBe('skipped')
      expect(row?.skip_reason).toBe('meeting_already_started_at_boot')
    } finally {
      await scheduler.stop()
    }
  })

  // Codex r1 P2 on PR #276 — `rehydrateFromQueueStore` arms timers
  // with a stub `CalendarEventRow` whose title/attendees/link are
  // blank. The subsequent cache walk inside `enqueueForProject`
  // builds the rich event row but `armTimer` early-returns when
  // `fire_at_ms` matches. Without refreshing the entry's event the
  // brief fires with the stub. Regression test: after rehydrate +
  // cache walk, the fire callback must see the richer event row.
  test('rehydrated timer is refreshed by the subsequent cache walk (Codex r1 P2)', async () => {
    const NOW = Date.parse('2026-05-21T09:00:00Z')
    const clock = buildFakeClock(NOW)
    const MEETING_START = NOW + 10 * 60_000
    const queueStore = new InMemoryPreMeetingBriefQueueStore()

    // Pre-seed a pending row from a prior (now-crashed) session — so
    // `start()` rehydrates BEFORE the cache walk runs. The matching
    // cache row carries the full title/attendees/link tuple the
    // composer would render in the brief.
    await queueStore.upsertPending({
      calendar_id: 'primary',
      event_id: 'evt-refresh',
      project_id: 'projA',
      meeting_start_ms: MEETING_START,
      lead_time_ms: 5 * 60_000,
      fire_at_ms: NOW + 5 * 60_000,
      enqueued_at_ms: NOW - 60_000,
    })
    cache.upsertEvents([
      seedRow({
        id: 'evt-refresh',
        title: 'Quarterly board sync',
        start: new Date(MEETING_START).toISOString(),
        end: new Date(MEETING_START + 30 * 60_000).toISOString(),
        attendees: ['sam@example.com', 'cofounder@example.com'],
        html_link: 'https://calendar.google.com/event?eid=abc',
        description: 'Discuss next-quarter targets.',
      }),
    ])

    const fires: PreMeetingBriefFireInput[] = []
    const scheduler = buildPreMeetingBriefScheduler({
      cacheFor: async () => cache,
      listProjects: async () => [{ project_id: 'projA' }],
      queueStore,
      lead_ms: 5 * 60_000,
      fire: async (input) => {
        fires.push(input)
      },
      now: () => clock.now_ms,
      scheduleTimer: (fn, ms) => clock.schedule(fn, ms),
    })
    await scheduler.start()
    try {
      // Advance to fire window.
      clock.advanceTo(NOW + 5 * 60_000 + 10)
      await new Promise((r) => setTimeout(r, 5))

      const fired = fires.find((f) => f.event.id === 'evt-refresh')
      expect(fired).toBeDefined()
      // The CRITICAL assertion: title is from the cache, not the stub.
      expect(fired?.event.title).toBe('Quarterly board sync')
      expect(fired?.event.attendees).toContain('sam@example.com')
      expect(fired?.event.html_link).toBe('https://calendar.google.com/event?eid=abc')
    } finally {
      await scheduler.stop()
    }
  })

  // ISSUE #29 (Codex r2 P2 on PR #276) — closing condition: restart
  // scheduler immediately before fire window; the brief emitted must
  // contain the actual event title + attendee count + meeting link.
  //
  // The Codex r1 P2 test above ALSO seeds the cache, so the cache walk
  // refresh repairs the stub before the fire callback runs. This test
  // models the harder race: rehydrate fires BEFORE the cache walk's
  // armTimer refresh runs. In production that race exists because
  // `walkAllProjects` issues an `opts.client.list(...)` HTTP call that
  // awaits, during which Bun's event loop can flush the 0-delay
  // rehydrate timer first. With the fake clock here we model the same
  // ordering by making `listProjects` return projects ONLY on the
  // rehydrate call — the subsequent walk sees no projects, so the
  // cleanup path that would mark the entry `event_removed_from_cache`
  // never runs. The rehydrate's 0-delay timer then fires with whatever
  // `buildEventFromQueueRow` produced from the durable row.
  test('ISSUE #29 — rehydrate fires with rich content when cache walk loses the race', async () => {
    const NOW = Date.parse('2026-05-23T09:00:00Z')
    const clock = buildFakeClock(NOW)
    const MEETING_START = NOW + 4 * 60_000 // 4 min away
    const queueStore = new InMemoryPreMeetingBriefQueueStore()

    // Pre-seed the durable row WITH rich content — exactly what the
    // post-fix `enqueueForProject` writes on the prior session before
    // the gateway crashed. `fire_at_ms` is in the PAST (boot raced
    // ahead of the cache refresh) so rehydrate arms a 0-delay timer.
    await queueStore.upsertPending({
      calendar_id: 'primary',
      event_id: 'evt-issue-29',
      project_id: 'projA',
      meeting_start_ms: MEETING_START,
      lead_time_ms: 5 * 60_000,
      fire_at_ms: NOW - 60_000, // 1 min overdue at boot
      enqueued_at_ms: NOW - 10 * 60_000,
      title: 'Strategy review with Casey',
      attendees: ['sam@example.com', 'casey@example.com'],
      meeting_link: 'https://meet.google.com/abc-defg-hij',
    })

    // Cache is intentionally EMPTY — the gateway just restarted and
    // the calendar sync hasn't refreshed yet. Without ISSUE #29's
    // durable rich fields the rehydrate would fire with an empty stub.
    expect(
      cache.listEvents({
        range_start_ms: NOW,
        range_end_ms: NOW + 24 * 60 * 60_000,
        limit: 200,
      }),
    ).toHaveLength(0)

    let listProjectsCall = 0
    const fires: PreMeetingBriefFireInput[] = []
    const scheduler = buildPreMeetingBriefScheduler({
      cacheFor: async () => cache,
      // Stateful: first call (rehydrate phase) sees projA; second call
      // (walkAllProjects phase) sees no projects — modelling the race
      // where rehydrate's 0-delay timer fires before the walk's
      // cleanup runs.
      listProjects: async () => {
        listProjectsCall += 1
        return listProjectsCall === 1 ? [{ project_id: 'projA' }] : []
      },
      queueStore,
      lead_ms: 5 * 60_000,
      fire: async (input) => {
        fires.push(input)
      },
      now: () => clock.now_ms,
      scheduleTimer: (fn, ms) => clock.schedule(fn, ms),
    })
    await scheduler.start()
    try {
      // Tick forward microseconds — enough for the 0-delay rehydrate
      // timer to flush.
      clock.advanceTo(NOW + 1)
      await new Promise((r) => setTimeout(r, 5))

      const fired = fires.find((f) => f.event.id === 'evt-issue-29')
      expect(fired).toBeDefined()
      // CLOSING CONDITION (ISSUE #29) — title + attendees + meeting
      // link are populated from the durable row, NOT the empty stub.
      expect(fired?.event.title).toBe('Strategy review with Casey')
      expect(fired?.event.attendees).toEqual([
        'sam@example.com',
        'casey@example.com',
      ])
      expect(fired?.event.html_link).toBe(
        'https://meet.google.com/abc-defg-hij',
      )
    } finally {
      await scheduler.stop()
    }
  })

  // ISSUE #29 backward-compat — a pre-migration row (NULL in the new
  // columns) must still rehydrate without throwing. The fire callback
  // sees the historical empty-stub. Same listProjects trick as above
  // so the rehydrated timer survives long enough to fire.
  test('ISSUE #29 — pre-migration NULL fields fall back to empty stub', async () => {
    const NOW = Date.parse('2026-05-23T09:00:00Z')
    const clock = buildFakeClock(NOW)
    const MEETING_START = NOW + 10 * 60_000
    const queueStore = new InMemoryPreMeetingBriefQueueStore()

    // Pre-seed a row WITHOUT the new optional fields — equivalent to
    // a row written by the prior session before ISSUE #29 shipped.
    // The InMemory store's `upsertPending` collapses `undefined` to
    // `null`, matching the Sqlite write contract.
    await queueStore.upsertPending({
      calendar_id: 'primary',
      event_id: 'evt-old',
      project_id: 'projA',
      meeting_start_ms: MEETING_START,
      lead_time_ms: 5 * 60_000,
      fire_at_ms: NOW - 60_000,
      enqueued_at_ms: NOW - 10 * 60_000,
      // title / attendees / meeting_link intentionally omitted.
    })
    const seeded = queueStore.getRow('primary', 'evt-old')
    expect(seeded?.title).toBeNull()
    expect(seeded?.attendees).toBeNull()
    expect(seeded?.meeting_link).toBeNull()

    let listProjectsCall = 0
    const fires: PreMeetingBriefFireInput[] = []
    const scheduler = buildPreMeetingBriefScheduler({
      cacheFor: async () => cache,
      listProjects: async () => {
        listProjectsCall += 1
        return listProjectsCall === 1 ? [{ project_id: 'projA' }] : []
      },
      queueStore,
      lead_ms: 5 * 60_000,
      fire: async (input) => {
        fires.push(input)
      },
      now: () => clock.now_ms,
      scheduleTimer: (fn, ms) => clock.schedule(fn, ms),
    })
    await scheduler.start()
    try {
      clock.advanceTo(NOW + 1)
      await new Promise((r) => setTimeout(r, 5))

      const fired = fires.find((f) => f.event.id === 'evt-old')
      expect(fired).toBeDefined()
      // Historical empty-stub behaviour — title empty, no attendees,
      // no link. Scheduler did not throw on the NULL columns.
      expect(fired?.event.title).toBe('')
      expect(fired?.event.attendees).toBeUndefined()
      expect(fired?.event.html_link).toBeUndefined()
    } finally {
      await scheduler.stop()
    }
  })
})
