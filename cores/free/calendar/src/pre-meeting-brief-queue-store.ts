/**
 * @neutronai/calendar-core — durable pre-meeting-brief queue store
 * (ISSUE #16, 2026-05-22).
 *
 * Per-project SQLite-backed durable queue for the pre-meeting-brief
 * scheduler's pending fires. Before this module the in-process timer
 * wheel in `pre-meeting-brief-scheduler.ts` lost every pending fire
 * on gateway restart and the silent-drop branch at line 172 hid the
 * loss from any caller. Now `start()` re-reads `listPending(project)`
 * from the durable queue and re-arms timers (or marks rows skipped
 * with a reason when the meeting has already started by boot time).
 *
 * Two implementations:
 *
 *   - `SqlitePreMeetingBriefQueueStore` — production. Opens the
 *     per-project Calendar Core sidecar lazily (mirroring the
 *     `CalendarProjectCache` resolver shape). The migration runner
 *     applies `migrations/0003_pre_meeting_brief_queue.sql` on every
 *     handle open via `applyCalendarSidecarMigrations`.
 *   - `InMemoryPreMeetingBriefQueueStore` — test seam. Holds rows in a
 *     `Map` keyed on `(calendar_id, event_id)`; same surface, no I/O.
 *     Tests pre-seed rows directly via `_seed(...)` to exercise
 *     boot-time re-walk behaviour without spinning up a real DB.
 *
 * Production wires this through `gateway/cores/calendar-wiring.ts ->
 * buildCalendarPreMeetingBriefSchedulerDeps`. The gateway boot path
 * in `gateway/index.ts` constructs one `SqlitePreMeetingBriefQueueStore`
 * per instance, sharing the same per-project sidecar dir as the
 * `CalendarProjectCache` (both stores live in `calendar.db`).
 */

import type { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { mapRows, openSidecar, parseJsonColumn } from '@neutronai/persistence/index.ts'

import { applyCalendarSidecarMigrations } from '../migrations/runner.ts'
import { CALENDAR_DB, CALENDAR_DIR } from './cache.ts'

export type PreMeetingBriefQueueStatus = 'pending' | 'fired' | 'skipped'

export interface PreMeetingBriefQueueRow {
  calendar_id: string
  event_id: string
  project_id: string
  meeting_start_ms: number
  lead_time_ms: number
  fire_at_ms: number
  status: PreMeetingBriefQueueStatus
  skip_reason: string | null
  enqueued_at_ms: number
  fired_at_ms: number | null
  /** ISSUE #29 — persisted from `CalendarEventRow.title` so
   *  `rehydrateFromQueueStore` can rebuild a non-stub event when the cache
   *  walk hasn't populated the matching key yet. NULL on pre-migration rows. */
  title: string | null
  /** ISSUE #29 — persisted from `CalendarEventRow.attendees` (JSON-encoded
   *  array of email strings on disk; deserialized here). NULL on
   *  pre-migration rows or events with no attendees; populated (non-empty
   *  array) when the cache walk wrote this row post-migration. */
  attendees: readonly string[] | null
  /** ISSUE #29 — persisted from `CalendarEventRow.html_link`. NULL on
   *  pre-migration rows or events without a calendar link. */
  meeting_link: string | null
}

export interface UpsertPendingInput {
  calendar_id: string
  event_id: string
  project_id: string
  meeting_start_ms: number
  lead_time_ms: number
  fire_at_ms: number
  enqueued_at_ms: number
  /** ISSUE #29 — optional rich-content fields for rehydration. Callers
   *  that omit these write NULL into the columns; the read path then
   *  falls back to the empty-stub behaviour (Codex r1 P2 cache-walk
   *  refresh mitigation continues to cover that path). */
  title?: string | null
  attendees?: readonly string[] | null
  meeting_link?: string | null
}

export interface PreMeetingBriefQueueStore {
  /** Read every `pending` row for one project. Newest enqueued first
   *  is NOT guaranteed; rows are returned by `fire_at_ms ASC` so the
   *  scheduler boot walk processes earliest fires first. */
  listPending(project_id: string): Promise<PreMeetingBriefQueueRow[]>

  /** Insert or update a pending row. If the row already exists,
   *  overwrite the timing fields + reset `status='pending'` /
   *  `skip_reason=null` / `fired_at_ms=null`. This is how event
   *  reschedules propagate — a moved Google Calendar event flips its
   *  cached row and the next walk upserts the new `fire_at_ms`. */
  upsertPending(input: UpsertPendingInput): Promise<void>

  /** Mark a row `fired` after the scheduler's fire callback resolves.
   *  Idempotent — a re-fire (concurrent restart race) is a no-op
   *  against an already-fired row. */
  markFired(calendar_id: string, event_id: string, fired_at_ms: number): Promise<void>

  /** Mark a row `skipped` with a structured reason string. Reasons
   *  used today: `'meeting_already_started_at_boot'`,
   *  `'meeting_already_started_at_enqueue'`. */
  markSkipped(calendar_id: string, event_id: string, reason: string): Promise<void>

  /** Defensive janitor — wipe rows whose `meeting_start_ms` is more
   *  than `retention_ms` in the past. Returns the count removed.
   *  Today no cron drives this; the scheduler caller can invoke
   *  periodically. */
  deleteCompletedOlderThan(cutoff_ms: number): Promise<number>
}

interface ProjectHandle {
  db: Database
  db_path: string
}

export interface SqlitePreMeetingBriefQueueStoreOptions {
  /** Absolute path to the instance home (`<owner_home>`) dir. */
  owner_home: string
  /** Override per-project root resolution (default:
   *  `<owner_home>/Projects/<project_id>/calendar/`). */
  resolveProjectCalendarDir?: (project_id: string) => string
}

/**
 * Production queue store. Opens the per-project Calendar Core sidecar
 * lazily and reuses the same migrations directory the cache uses.
 * Idempotent on `applyCalendarSidecarMigrations` so opening both a
 * `CalendarProjectCache` and a `SqlitePreMeetingBriefQueueStore` for
 * the same project against the same `calendar.db` is safe.
 */
export class SqlitePreMeetingBriefQueueStore implements PreMeetingBriefQueueStore {
  private readonly owner_home: string
  private readonly resolveProjectCalendarDir: (project_id: string) => string
  private readonly handles = new Map<string, ProjectHandle>()
  private readonly initPromises = new Map<string, Promise<ProjectHandle>>()

  constructor(opts: SqlitePreMeetingBriefQueueStoreOptions) {
    this.owner_home = opts.owner_home
    this.resolveProjectCalendarDir =
      opts.resolveProjectCalendarDir ??
      ((project_id) => join(opts.owner_home, 'Projects', project_id, CALENDAR_DIR))
  }

  /** Force-close every per-project DB handle. Useful for tests + for
   *  the gateway SIGTERM `realmode_cleanups` path. */
  closeAll(): void {
    for (const handle of this.handles.values()) {
      try {
        handle.db.close()
      } catch {
        /* ignore */
      }
    }
    this.handles.clear()
    this.initPromises.clear()
  }

  async listPending(project_id: string): Promise<PreMeetingBriefQueueRow[]> {
    const handle = await this.openHandle(project_id)
    const rows = handle.db
      .query<RawQueueRow, [string]>(
        `SELECT calendar_id, event_id, project_id, meeting_start_ms,
                lead_time_ms, fire_at_ms, status, skip_reason,
                enqueued_at_ms, fired_at_ms,
                title, attendees_json, meeting_link
           FROM pre_meeting_brief_queue
           WHERE status = 'pending' AND project_id = ?
           ORDER BY fire_at_ms ASC`,
      )
      .all(project_id)
    return mapRows(rows, rowFromDb)
  }

  async upsertPending(input: UpsertPendingInput): Promise<void> {
    const handle = await this.openHandle(input.project_id)
    // ISSUE #29 — serialize rich-content fields. NULL when the caller
    // omitted them (pre-migration writers OR test seeds that exercise the
    // backward-compat path); JSON-encoded array when the cache walk
    // supplied an attendees list (possibly empty — serialized as `[]`).
    const attendees_json =
      input.attendees === undefined || input.attendees === null
        ? null
        : JSON.stringify(input.attendees)
    handle.db.run(
      `INSERT INTO pre_meeting_brief_queue (
         calendar_id, event_id, project_id, meeting_start_ms,
         lead_time_ms, fire_at_ms, status, skip_reason,
         enqueued_at_ms, fired_at_ms,
         title, attendees_json, meeting_link
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?, ?, ?)
       ON CONFLICT(calendar_id, event_id) DO UPDATE SET
         project_id       = excluded.project_id,
         meeting_start_ms = excluded.meeting_start_ms,
         lead_time_ms     = excluded.lead_time_ms,
         fire_at_ms       = excluded.fire_at_ms,
         status           = 'pending',
         skip_reason      = NULL,
         enqueued_at_ms   = excluded.enqueued_at_ms,
         fired_at_ms      = NULL,
         title            = excluded.title,
         attendees_json   = excluded.attendees_json,
         meeting_link     = excluded.meeting_link`,
      [
        input.calendar_id,
        input.event_id,
        input.project_id,
        input.meeting_start_ms,
        input.lead_time_ms,
        input.fire_at_ms,
        input.enqueued_at_ms,
        input.title ?? null,
        attendees_json,
        input.meeting_link ?? null,
      ],
    )
  }

  async markFired(
    calendar_id: string,
    event_id: string,
    fired_at_ms: number,
  ): Promise<void> {
    const handle = await this.lookupHandleForKey(calendar_id, event_id)
    if (handle === null) return
    handle.db.run(
      `UPDATE pre_meeting_brief_queue
         SET status      = 'fired',
             fired_at_ms = ?
       WHERE calendar_id = ? AND event_id = ?`,
      [fired_at_ms, calendar_id, event_id],
    )
  }

  async markSkipped(
    calendar_id: string,
    event_id: string,
    reason: string,
  ): Promise<void> {
    const handle = await this.lookupHandleForKey(calendar_id, event_id)
    if (handle === null) return
    handle.db.run(
      `UPDATE pre_meeting_brief_queue
         SET status      = 'skipped',
             skip_reason = ?
       WHERE calendar_id = ? AND event_id = ?`,
      [reason, calendar_id, event_id],
    )
  }

  async deleteCompletedOlderThan(cutoff_ms: number): Promise<number> {
    let removed = 0
    for (const handle of this.handles.values()) {
      const stmt = handle.db.query<{ n: number }, [number]>(
        `SELECT changes() AS n FROM (
           SELECT 1
             WHERE (SELECT count(*) FROM pre_meeting_brief_queue
                     WHERE meeting_start_ms < ?) > 0
         )`,
      )
      handle.db.run(
        `DELETE FROM pre_meeting_brief_queue
            WHERE meeting_start_ms < ?
              AND status IN ('fired', 'skipped')`,
        [cutoff_ms],
      )
      const got = stmt.get(cutoff_ms)
      if (got !== null) removed += got.n
    }
    return removed
  }

  /**
   * Resolve the DB handle for a given (calendar_id, event_id) pair.
   * Returns null when no handle is open and the row has never been
   * upserted — `markFired` / `markSkipped` on an unknown row is a
   * no-op (idempotent shape).
   */
  private async lookupHandleForKey(
    calendar_id: string,
    event_id: string,
  ): Promise<ProjectHandle | null> {
    for (const handle of this.handles.values()) {
      const row = handle.db
        .query<{ found: number }, [string, string]>(
          `SELECT 1 AS found
             FROM pre_meeting_brief_queue
             WHERE calendar_id = ? AND event_id = ?
             LIMIT 1`,
        )
        .get(calendar_id, event_id)
      if (row !== null) return handle
    }
    return null
  }

  private async openHandle(project_id: string): Promise<ProjectHandle> {
    const cleaned = sanitizeProjectId(project_id)
    if (cleaned === null) {
      throw new Error(
        `pre-meeting-brief-queue: invalid project_id ${JSON.stringify(project_id)} — must be 1-128 chars from [A-Za-z0-9_.-]`,
      )
    }
    const cached = this.handles.get(cleaned)
    if (cached !== undefined) return cached
    const inflight = this.initPromises.get(cleaned)
    if (inflight !== undefined) return inflight
    const promise = this.initHandle(cleaned)
    this.initPromises.set(cleaned, promise)
    try {
      const handle = await promise
      this.handles.set(cleaned, handle)
      return handle
    } finally {
      this.initPromises.delete(cleaned)
    }
  }

  private async initHandle(project_id: string): Promise<ProjectHandle> {
    const dir = this.resolveProjectCalendarDir(project_id)
    mkdirSync(dir, { recursive: true })
    const db_path = join(dir, CALENDAR_DB)
    // P3 shared open — previously busy_timeout only (same 100 ms value as
    // the shared set); now additionally gains WAL/synchronous/temp_store/
    // cache_size plus foreign_keys=ON, which is inert here (schema declares
    // no FOREIGN KEYs). Strictly more tolerant, no semantic change.
    const db = openSidecar(db_path)
    try {
      applyCalendarSidecarMigrations(db)
    } catch (err) {
      try {
        db.close()
      } catch {
        /* ignore */
      }
      throw err
    }
    return { db, db_path }
  }
}

interface RawQueueRow {
  calendar_id: string
  event_id: string
  project_id: string
  meeting_start_ms: number
  lead_time_ms: number
  fire_at_ms: number
  status: string
  skip_reason: string | null
  enqueued_at_ms: number
  fired_at_ms: number | null
  title: string | null
  attendees_json: string | null
  meeting_link: string | null
}

function rowFromDb(raw: RawQueueRow): PreMeetingBriefQueueRow {
  const status: PreMeetingBriefQueueStatus =
    raw.status === 'fired'
      ? 'fired'
      : raw.status === 'skipped'
        ? 'skipped'
        : 'pending'
  return {
    calendar_id: raw.calendar_id,
    event_id: raw.event_id,
    project_id: raw.project_id,
    meeting_start_ms: raw.meeting_start_ms,
    lead_time_ms: raw.lead_time_ms,
    fire_at_ms: raw.fire_at_ms,
    status,
    skip_reason: raw.skip_reason,
    enqueued_at_ms: raw.enqueued_at_ms,
    fired_at_ms: raw.fired_at_ms,
    title: raw.title,
    attendees: parseAttendeesJson(raw.attendees_json),
    meeting_link: raw.meeting_link,
  }
}

/**
 * ISSUE #29 — defensive parse of the JSON-encoded attendees column.
 * Returns `null` on NULL (pre-migration row OR explicit no-attendees
 * write) AND on any parse error / non-string-array shape (corruption
 * defense — should never happen since we control the writer; if it
 * does we degrade to the empty-stub path rather than crash the
 * scheduler boot walk).
 */
function parseAttendeesJson(raw: string | null): readonly string[] | null {
  if (raw === null) return null
  // Corrupt-JSON policy (explicit, historical): fallback → null — corrupt
  // or wrong-shaped attendees degrade to the empty-stub path rather than
  // crashing the scheduler boot walk.
  const parsed = parseJsonColumn(raw, { onCorrupt: 'fallback', fallback: null })
  if (!Array.isArray(parsed)) return null
  if (!parsed.every((v): v is string => typeof v === 'string')) return null
  return parsed
}

/** Mirrors the comment-store's project-id sanitiser. */
function sanitizeProjectId(project_id: string): string | null {
  if (project_id.length === 0 || project_id.length > 128) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(project_id)) return null
  return project_id
}

/**
 * In-memory test seam. Mirrors the production interface exactly so
 * tests can pre-seed rows + assert post-fire transitions without
 * touching the disk. `getRow(...)` is a test-only accessor for
 * inspecting `skipped` / `fired` rows that `listPending` no longer
 * returns.
 */
export class InMemoryPreMeetingBriefQueueStore implements PreMeetingBriefQueueStore {
  private readonly rows = new Map<string, PreMeetingBriefQueueRow>()

  private key(calendar_id: string, event_id: string): string {
    return `${calendar_id}\x00${event_id}`
  }

  async listPending(project_id: string): Promise<PreMeetingBriefQueueRow[]> {
    const out: PreMeetingBriefQueueRow[] = []
    for (const row of this.rows.values()) {
      if (row.status !== 'pending') continue
      if (row.project_id !== project_id) continue
      out.push({ ...row })
    }
    out.sort((a, b) => a.fire_at_ms - b.fire_at_ms)
    return out
  }

  async upsertPending(input: UpsertPendingInput): Promise<void> {
    const k = this.key(input.calendar_id, input.event_id)
    this.rows.set(k, {
      calendar_id: input.calendar_id,
      event_id: input.event_id,
      project_id: input.project_id,
      meeting_start_ms: input.meeting_start_ms,
      lead_time_ms: input.lead_time_ms,
      fire_at_ms: input.fire_at_ms,
      status: 'pending',
      skip_reason: null,
      enqueued_at_ms: input.enqueued_at_ms,
      fired_at_ms: null,
      // ISSUE #29 — mirror the Sqlite write contract: `undefined` from
      // a caller that omitted the optional field, or explicit `null`,
      // both collapse to `null` on disk. The InMemory seam must reflect
      // this exactly so tests exercising both branches see the same
      // shape they would in production.
      title: input.title ?? null,
      attendees:
        input.attendees === undefined || input.attendees === null
          ? null
          : [...input.attendees],
      meeting_link: input.meeting_link ?? null,
    })
  }

  async markFired(
    calendar_id: string,
    event_id: string,
    fired_at_ms: number,
  ): Promise<void> {
    const k = this.key(calendar_id, event_id)
    const row = this.rows.get(k)
    if (row === undefined) return
    this.rows.set(k, { ...row, status: 'fired', fired_at_ms })
  }

  async markSkipped(
    calendar_id: string,
    event_id: string,
    reason: string,
  ): Promise<void> {
    const k = this.key(calendar_id, event_id)
    const row = this.rows.get(k)
    if (row === undefined) return
    this.rows.set(k, { ...row, status: 'skipped', skip_reason: reason })
  }

  async deleteCompletedOlderThan(cutoff_ms: number): Promise<number> {
    let removed = 0
    for (const [k, row] of this.rows) {
      if (row.meeting_start_ms >= cutoff_ms) continue
      if (row.status === 'pending') continue
      this.rows.delete(k)
      removed += 1
    }
    return removed
  }

  /** Test-only — inspect a row by key regardless of status. Returns
   *  `null` when no row exists. */
  getRow(calendar_id: string, event_id: string): PreMeetingBriefQueueRow | null {
    const row = this.rows.get(this.key(calendar_id, event_id))
    return row === undefined ? null : { ...row }
  }

  /** Test-only — enumerate every row regardless of status. */
  allRows(): PreMeetingBriefQueueRow[] {
    return Array.from(this.rows.values()).map((r) => ({ ...r }))
  }
}
