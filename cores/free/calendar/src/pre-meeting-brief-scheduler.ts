/**
 * @neutronai/calendar-core — pre-meeting-brief scheduler (Option B per
 * § 3.4 of the Calendar Core S1 brief).
 *
 * Per-Core in-process timer wheel. On `start()` the scheduler walks
 * the per-project cache for every active project, enqueues one fire
 * entry per upcoming event at `event.start - lead_ms`, and registers
 * a `setTimeout` per fire. On `tick(now)` the scheduler re-walks the
 * cache, picks up newly-cached events, de-queues fires for events
 * that have moved or been cancelled.
 *
 * Why Option B (timer wheel) and NOT Option A (reminders-engine
 * extension): the brief offers both; A requires extending
 * `reminders/RemindersEngine.scheduleOneShot(...)` + a per-project
 * handler-kind registry that doesn't exist in this codebase yet
 * (`reminders/` ships `ReminderStore` + `ReminderTickLoop`, no
 * `RemindersEngine` class). Adding the engine + handler registry is
 * cross-Core surgery a Calendar feature shouldn't carry; per the brief
 * § 13 fallback, Forge ships Option B + files an ISSUES.md entry for
 * the consolidation. Pros: zero touch on the Reminders module, no
 * second writer to the reminders table, simpler tests. Cons: gateway
 * restart loses the queue (must re-walk on boot — acceptable: the
 * cache IS the source of truth, and every restart will re-scan within
 * `tick_interval_ms`).
 *
 * Test seam: clock + setTimeout are injected via `opts.now` +
 * `opts.scheduleTimer`. The default uses `Date.now()` +
 * `setTimeout(...)`; tests pass a fake-timer pair so fires advance
 * deterministically.
 */

import type { CalendarClient, CalendarEventRow } from './backend.ts'
import type { CalendarProjectCache } from './cache.ts'
import type {
  PreMeetingBriefQueueRow,
  PreMeetingBriefQueueStore,
} from './pre-meeting-brief-queue-store.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

/** Default lead time before a meeting that the brief fires (ms). 10 min. */
export const PRE_MEETING_LEAD_MS = 10 * 60 * 1000
/** Default lookahead window for the boot + tick walks (ms). 24h. */
export const PRE_MEETING_LOOKAHEAD_MS = 24 * 60 * 60 * 1000
/** Default tick cadence (ms). 5 min. */
export const PRE_MEETING_TICK_MS = 5 * 60 * 1000

export interface PreMeetingBriefFireInput {
  event: CalendarEventRow
  project_id: string
  fired_at: number
}

export interface PreMeetingBriefScheduler {
  start(): Promise<void>
  tick(now: number): Promise<void>
  stop(): Promise<void>
  /** Test introspection — peek at the queue. */
  readonly enqueued: ReadonlyMap<string, { project_id: string; fire_at_ms: number }>
}

export type TimerHandle = { cancel(): void }

export interface PreMeetingBriefSchedulerOpts {
  /** Per-project cache resolver — same one the chat-command + MCP
   *  layers use. */
  cacheFor: (project_id: string) => Promise<CalendarProjectCache>
  /** The list of project_ids the owner has active. */
  listProjects: () => Promise<readonly { project_id: string }[]>
  /** Live calendar client — used to re-fetch when the cache is stale. */
  client?: CalendarClient
  /** Pluggable fire — composes the brief + posts it. */
  fire: (input: PreMeetingBriefFireInput) => Promise<void>
  /** Durable queue store (ISSUE #16) — re-walked on every `start()` so
   *  the scheduler survives gateway restart without silently dropping
   *  fires whose lead window passed mid-restart. Tests pass
   *  `new InMemoryPreMeetingBriefQueueStore()`; production wires
   *  `SqlitePreMeetingBriefQueueStore`. */
  queueStore: PreMeetingBriefQueueStore
  /** Default lead time before a meeting. */
  lead_ms?: number
  /** Default lookahead window for the cache walk. */
  lookahead_ms?: number
  /** Default tick cadence. */
  tick_interval_ms?: number
  /** Clock override (tests). */
  now?: () => number
  /** Timer factory override (tests). Default wraps setTimeout. */
  scheduleTimer?: (fn: () => void, delay_ms: number) => TimerHandle
}

interface QueueEntry {
  project_id: string
  fire_at_ms: number
  /** Latest known event row. The fire closure reads from here at fire
   *  time (not the value captured at `armTimer` call) so a richer row
   *  from a later cache walk supersedes an earlier rehydration stub. */
  event: CalendarEventRow
  timer: TimerHandle | null
}

const DEFAULT_TIMER_FACTORY = (fn: () => void, delay_ms: number): TimerHandle => {
  const t = setTimeout(fn, Math.max(0, delay_ms))
  return {
    cancel: () => {
      clearTimeout(t)
    },
  }
}

/**
 * Build a pre-meeting-brief scheduler. Idempotent — `start()` can be
 * called multiple times; the second call is a no-op until `stop()` is
 * called.
 */
export function buildPreMeetingBriefScheduler(
  opts: PreMeetingBriefSchedulerOpts,
): PreMeetingBriefScheduler {
  const lead_ms = opts.lead_ms ?? PRE_MEETING_LEAD_MS
  const lookahead_ms = opts.lookahead_ms ?? PRE_MEETING_LOOKAHEAD_MS
  const tick_interval_ms = opts.tick_interval_ms ?? PRE_MEETING_TICK_MS
  const now = opts.now ?? ((): number => Date.now())
  const scheduleTimer = opts.scheduleTimer ?? DEFAULT_TIMER_FACTORY

  // Composite key — events are addressed by (calendar_id, event_id);
  // mirrors the cache + the in-memory client.
  const queue = new Map<string, QueueEntry>()
  let running = false
  let tickTimer: TimerHandle | null = null

  const key = (calendar_id: string, event_id: string): string =>
    `${calendar_id}:${event_id}`

  function cancelAllTimers(): void {
    for (const entry of queue.values()) {
      entry.timer?.cancel()
      entry.timer = null
    }
  }

  interface ArmTimerInput {
    project_id: string
    calendar_id: string
    event_id: string
    fire_at_ms: number
    event: CalendarEventRow
    now_ms: number
  }

  function armTimer(input: ArmTimerInput): void {
    const k = key(input.calendar_id, input.event_id)
    const existing = queue.get(k)
    if (existing !== undefined && existing.fire_at_ms === input.fire_at_ms) {
      // Same fire window — no need to cancel + re-schedule. But refresh
      // the event row so the fire closure picks up the richest data
      // available (e.g. a later cache walk supersedes a rehydration stub
      // whose title/attendees/link were blank). The closure reads
      // `queue.get(k).event` at fire time, not the value captured here.
      existing.event = input.event
      existing.project_id = input.project_id
      return
    }
    existing?.timer?.cancel()
    const entry: QueueEntry = {
      project_id: input.project_id,
      fire_at_ms: input.fire_at_ms,
      event: input.event,
      timer: null,
    }
    entry.timer = scheduleTimer(() => {
      // Async-detached fire — caller handles errors via the `fire`
      // callback's own try/catch. After the user-supplied fire callback
      // resolves we flip the durable row to `fired` so the next boot
      // doesn't re-fire the same brief. We read `cur.event` /
      // `cur.project_id` from the queue map (not captured closure
      // variables) so a refresh through `armTimer` between schedule and
      // fire reflects the latest known event row.
      const cur = queue.get(k)
      const fireEvent = cur?.event ?? input.event
      const fireProject = cur?.project_id ?? input.project_id
      fireAndForget('pre-meeting-brief-scheduler.task', (async (): Promise<void> => {
        try {
          await opts.fire({
            event: fireEvent,
            project_id: fireProject,
            fired_at: now(),
          })
        } catch {
          // best-effort — still mark fired so we don't re-fire on
          // every restart.
        }
        try {
          await opts.queueStore.markFired(
            input.calendar_id,
            input.event_id,
            now(),
          )
        } catch {
          // best-effort
        }
      })())
      if (cur !== undefined) cur.timer = null
      queue.delete(k)
    }, Math.max(0, input.fire_at_ms - input.now_ms))
    queue.set(k, entry)
  }

  /**
   * Re-arm in-memory timers from the durable queue for a project.
   * Called on `start()` BEFORE the cache walk so a row whose
   * `fire_at_ms <= now() && meeting_start_ms > now()` fires at boot
   * (it lost its in-process timer to the restart but the meeting is
   * still in the future, so the brief is still useful). Rows whose
   * `meeting_start_ms <= now()` get marked `skipped` —
   * `'meeting_already_started_at_boot'`.
   */
  async function rehydrateFromQueueStore(project_id: string): Promise<void> {
    const t = now()
    const pending = await opts.queueStore.listPending(project_id)
    for (const row of pending) {
      if (row.project_id !== project_id) continue
      if (row.meeting_start_ms <= t) {
        await opts.queueStore.markSkipped(
          row.calendar_id,
          row.event_id,
          'meeting_already_started_at_boot',
        )
        continue
      }
      const event = buildEventFromQueueRow(row)
      armTimer({
        project_id,
        calendar_id: row.calendar_id,
        event_id: row.event_id,
        fire_at_ms: row.fire_at_ms,
        event,
        now_ms: t,
      })
    }
  }

  function buildEventFromQueueRow(row: PreMeetingBriefQueueRow): CalendarEventRow {
    // ISSUE #29 — rehydrate from the durable row's rich-content fields
    // (`title`, `attendees`, `meeting_link`) when present. If the
    // rehydrated timer fires before the cache walk completes, the
    // brief composer still sees the real event title + attendees +
    // meeting link rather than an empty stub.
    //
    // Pre-migration rows (or rows written by callers that omitted the
    // optional fields) have NULL in those columns. The fallback returns
    // the historical empty-stub; the Codex r1 P2 cache-walk refresh in
    // `armTimer` then supersedes it when the walk catches up — see
    // `pre-meeting-brief-scheduler.ts:151-159`.
    const event: CalendarEventRow = {
      id: row.event_id,
      calendar_id: row.calendar_id,
      title: row.title ?? '',
      start: new Date(row.meeting_start_ms).toISOString(),
      end: new Date(row.meeting_start_ms).toISOString(),
      status: 'confirmed',
      project_id: row.project_id,
    }
    if (row.attendees !== null && row.attendees.length > 0) {
      event.attendees = [...row.attendees]
    }
    if (row.meeting_link !== null) {
      event.html_link = row.meeting_link
    }
    return event
  }

  async function enqueueForProject(project_id: string): Promise<void> {
    const cache = await opts.cacheFor(project_id)
    const t = now()
    // Argus r2 BLOCKER #1 (2026-05-21) — pull events from the live
    // CalendarClient FIRST and upsert into the cache, then walk the
    // cache to enqueue timers. Without this the scheduler reads only
    // rows the `/cal create` chat command wrote: every event the owner
    // creates in Google Calendar (the realistic usage pattern) is
    // invisible, the walk returns zero rows, and NO BRIEFS EVER
    // FIRE. The cache is still the source of truth for the brief
    // composer's audit log + the launcher tile; this pre-step just
    // ensures it reflects what's actually upcoming on Google before
    // we walk it.
    //
    // `opts.client` is optional so tests that pre-seed the cache
    // directly (the boot / tick / cancel cases below) keep working.
    // Production always wires the client through
    // `buildCalendarPreMeetingBriefSchedulerDeps`.
    if (opts.client !== undefined) {
      try {
        const live = await opts.client.list({
          range_start: new Date(t).toISOString(),
          range_end: new Date(t + lookahead_ms).toISOString(),
          project_id,
          limit: 200,
        })
        if (live.length > 0) {
          cache.upsertEvents(live)
        }
      } catch {
        // best-effort — fall through to the cache walk. A transient
        // Google failure must not stop the scheduler from re-firing
        // briefs for already-cached events.
      }
    }
    const rows = cache.listEvents({
      range_start_ms: t,
      range_end_ms: t + lookahead_ms,
      limit: 200,
    })
    // Track which keys are still relevant in this project so we can
    // drop fires for events that moved or were cancelled.
    const stillRelevant = new Set<string>()
    for (const row of rows) {
      const startMs = Date.parse(row.start_iso)
      if (Number.isNaN(startMs)) continue
      const fireAt = startMs - lead_ms
      // ISSUE #16 — the prior code at this line silently dropped
      // fires whose `fireAt <= t`. Now: if the meeting hasn't started
      // yet, upsert + fire immediately (0-delay); if the meeting has
      // already started, mark skipped (don't re-fire briefs for
      // meetings already in progress).
      if (startMs <= t) {
        await opts.queueStore.markSkipped(
          row.calendar_id,
          row.event_id,
          'meeting_already_started_at_enqueue',
        )
        continue
      }
      const k = key(row.calendar_id, row.event_id)
      stillRelevant.add(k)
      const event: CalendarEventRow = {
        id: row.event_id,
        calendar_id: row.calendar_id,
        title: row.title,
        start: row.start_iso,
        end: row.end_iso,
        status: row.status,
      }
      if (row.description !== null) event.description = row.description
      if (row.attendees.length > 0) event.attendees = [...row.attendees]
      if (row.html_link !== null) event.html_link = row.html_link
      if (row.project_id !== null) event.project_id = row.project_id
      // Upsert the durable row BEFORE arming the in-process timer.
      // If the gateway crashes between upsert + fire, the next boot's
      // `rehydrateFromQueueStore` re-arms (or marks skipped) per
      // `meeting_start_ms` vs the wall clock.
      //
      // ISSUE #29 — persist `title`, `attendees`, `meeting_link` into
      // the durable row alongside the timing tuple. On boot the
      // rehydrated event then carries the real content rather than an
      // empty stub when the rehydrate fires before the next cache
      // walk completes.
      try {
        await opts.queueStore.upsertPending({
          calendar_id: row.calendar_id,
          event_id: row.event_id,
          project_id,
          meeting_start_ms: startMs,
          lead_time_ms: lead_ms,
          fire_at_ms: fireAt,
          enqueued_at_ms: t,
          title: event.title,
          attendees: event.attendees ?? null,
          meeting_link: event.html_link ?? null,
        })
      } catch {
        // best-effort — even if the durable upsert fails the
        // in-process timer still arms below so the brief fires this
        // session.
      }
      armTimer({
        project_id,
        calendar_id: row.calendar_id,
        event_id: row.event_id,
        fire_at_ms: fireAt,
        event,
        now_ms: t,
      })
    }
    // Drop stale entries belonging to this project that aren't in the
    // latest cache walk (event moved / cancelled / removed).
    //
    // Argus r2 BLOCKER B1 (PR #276) — mark the durable queue row
    // `skipped` BEFORE deleting the in-memory entry. Without this, a
    // restart between cancellation and the original `fire_at_ms` would
    // re-arm a 0-delay timer from `rehydrateFromQueueStore` (the
    // durable row still reads `pending`) → ghost brief fires for an
    // event that no longer exists in the cache. The `markSkipped` /
    // `queue.delete` ordering is reversible-safe — if `markSkipped`
    // throws, the in-memory timer stays cancelled and the durable row
    // is corrected on the next walk.
    for (const [k, entry] of queue) {
      if (entry.project_id !== project_id) continue
      if (stillRelevant.has(k)) continue
      entry.timer?.cancel()
      try {
        await opts.queueStore.markSkipped(
          entry.event.calendar_id,
          entry.event.id,
          'event_removed_from_cache',
        )
      } catch {
        // best-effort — even if the durable update fails, the
        // in-memory timer is already cancelled. The next walk re-tries
        // the same `markSkipped` call.
      }
      queue.delete(k)
    }
  }

  async function walkAllProjects(): Promise<void> {
    const projects = await opts.listProjects()
    for (const p of projects) {
      try {
        await enqueueForProject(p.project_id)
      } catch {
        // best-effort per project
      }
    }
  }

  async function rehydrateAllProjects(): Promise<void> {
    const projects = await opts.listProjects()
    for (const p of projects) {
      try {
        await rehydrateFromQueueStore(p.project_id)
      } catch {
        // best-effort per project
      }
    }
  }

  function scheduleNextTick(): void {
    if (!running) return
    tickTimer = scheduleTimer(() => {
      fireAndForget('pre-meeting-brief-scheduler.tickInternal', tickInternal(now()).catch(() => {}))
    }, tick_interval_ms)
  }

  async function tickInternal(t: number): Promise<void> {
    if (!running) return
    void t
    await walkAllProjects()
    scheduleNextTick()
  }

  return {
    enqueued: queue as ReadonlyMap<string, { project_id: string; fire_at_ms: number }>,
    async start(): Promise<void> {
      if (running) return
      running = true
      // ISSUE #16 — re-arm timers from the durable queue BEFORE the
      // cache walk. Two cases: (1) `fire_at_ms <= now() <
      // meeting_start_ms` → fire immediately (0-delay timer). (2)
      // `meeting_start_ms <= now()` → mark skipped + drop. The cache
      // walk that follows may re-upsert any of these rows with fresh
      // timing if the event still exists; `armTimer` is idempotent
      // on identical `fire_at_ms`.
      await rehydrateAllProjects()
      await walkAllProjects()
      scheduleNextTick()
    },
    async tick(t: number): Promise<void> {
      if (!running) running = true
      await tickInternal(t)
    },
    async stop(): Promise<void> {
      running = false
      tickTimer?.cancel()
      tickTimer = null
      cancelAllTimers()
      queue.clear()
    },
  }
}
