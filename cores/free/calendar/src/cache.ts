/**
 * @neutronai/calendar-core — per-project SQLite cache + pre-meeting-brief
 * audit log.
 *
 * Lives at `<OWNER_HOME>/Projects/<project_id>/calendar/calendar.db`.
 * Google Calendar v3 is the source of truth; this cache is a fast-render
 * store for the launcher tile + the pre-meeting-brief scheduler's tick
 * walk + the durable audit log of every brief fire. Refresh discipline
 * (S1): a row is "fresh" iff `cached_at + CACHE_TTL_MS >= now`; the
 * scheduler skips re-fetching from Google for any window where the
 * cache has a fresh hit.
 *
 * Defence-in-depth: a sidecar copied between projects has a
 * `calendar_meta.project_id` row that doesn't match the directory the
 * file lives under. The resolver throws `CalendarSidecarMismatchError`
 * before returning a handle, so a stray copy never silently leaks one
 * project's calendar onto another.
 *
 * Why per-project (not instance-wide): mirrors the Notes / Reminders Core
 * sidecar convention from `docs/plans/project-folder-convention.md` —
 * "user-visible content lives under the project tree, agent-only state
 * lives under `.<core>/`". The calendar cache is user-visible (P7 file
 * explorer will list it), so it uses `calendar/` (no leading dot).
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { applyCalendarSidecarMigrations } from '../migrations/runner.ts'
import type { CalendarEventRow } from './backend.ts'

/** Per-project sidecar directory name (sibling of `notes/`, `reminders/`,
 *  `.comments/`, `.docs-versions/`). */
export const CALENDAR_DIR = 'calendar' as const
/** Sidecar SQLite filename. */
export const CALENDAR_DB = 'calendar.db' as const
/** Current schema version after applying every migration in
 *  `migrations/`. Bumped to 3 on 2026-05-22 (ISSUE #16: add the
 *  durable `pre_meeting_brief_queue` table so the scheduler survives
 *  gateway restart without silently dropping fires). */
export const CALENDAR_SCHEMA_VERSION = 3 as const
/** Default cache TTL (ms). After this the scheduler re-fetches from Google. */
export const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000

export type PreMeetingBriefOutcome = 'ok' | 'llm_error' | 'no_post_target'

export interface CachedEventRow {
  calendar_id: string
  event_id: string
  title: string
  start_iso: string
  end_iso: string
  status: 'confirmed' | 'cancelled'
  description: string | null
  attendees: readonly string[]
  html_link: string | null
  project_id: string | null
  etag: string | null
  cached_at: number
}

export interface BriefAuditRow {
  id: number
  calendar_id: string
  event_id: string
  fired_at: number
  model: string
  outcome: PreMeetingBriefOutcome
  prompt_hash: string
  response_excerpt: string | null
  chat_message_id: string | null
}

export interface RecordBriefFireInput {
  calendar_id: string
  event_id: string
  fired_at: number
  model: string
  outcome: PreMeetingBriefOutcome
  prompt_hash: string
  response_excerpt: string | null
  chat_message_id: string | null
}

export interface ListEventsWindow {
  range_start_ms: number
  range_end_ms: number
  /** Default 50. */
  limit?: number
}

export interface CalendarProjectCache {
  /** Project id this cache is bound to. */
  readonly project_id: string
  /** Absolute path to the sidecar `.db` file. */
  readonly db_path: string

  /** Upsert a batch of cached event rows. cached_at is set to `now`
   *  for every row (caller can override by providing a `cached_at`
   *  per row). */
  upsertEvents(rows: readonly CalendarEventRow[], options?: { cached_at?: number }): void

  /** Read cached rows whose start_iso falls in `[range_start, range_end)`,
   *  status != 'cancelled', ordered by start_iso ASC. */
  listEvents(window: ListEventsWindow): CachedEventRow[]

  /** Append one row to the pre_meeting_brief_audit log. Returns the
   *  inserted row's id. */
  recordBriefFire(input: RecordBriefFireInput): number

  /** Read recent audit rows for an event (newest first). */
  listBriefAudit(input: { calendar_id: string; event_id: string; limit?: number }): BriefAuditRow[]

  /** Close the underlying SQLite handle. */
  close(): void
}

export class CalendarSidecarMismatchError extends Error {
  readonly code = 'calendar_sidecar_mismatch' as const
  constructor(
    readonly expected_project_id: string,
    readonly found_project_id: string,
  ) {
    super(
      `calendar sidecar mismatch: expected project_id='${expected_project_id}', found='${found_project_id}' — sidecar may have been copied between projects`,
    )
    this.name = 'CalendarSidecarMismatchError'
  }
}

export interface OpenCalendarProjectCacheInput {
  /** Absolute path to the directory where `calendar.db` should live.
   *  Typically `<OWNER_HOME>/Projects/<project_id>/calendar/`. */
  dir: string
  /** Project id this cache is bound to. */
  project_id: string
  /** Clock override (tests). */
  now?: () => number
}

interface SidecarPragmas {
  cache_size: number
  busy_timeout_ms: number
}

const DEFAULT_PRAGMAS: SidecarPragmas = {
  cache_size: -64_000,
  busy_timeout_ms: 100,
}

/**
 * Open the per-project Calendar Core sidecar, apply migrations,
 * verify project_id, and return a typed handle. Idempotent — every
 * call returns a fresh handle (no in-process caching). For
 * cache-aware open semantics (resolver-style), wrap with
 * `CalendarProjectCacheStore` (below).
 */
export function openCalendarProjectCache(
  input: OpenCalendarProjectCacheInput,
): CalendarProjectCache {
  const now = input.now ?? ((): number => Date.now())
  mkdirSync(input.dir, { recursive: true })
  const db_path = join(input.dir, CALENDAR_DB)
  const db = new Database(db_path, { create: true })
  try {
    db.exec(`PRAGMA cache_size = ${DEFAULT_PRAGMAS.cache_size}`)
    db.exec(`PRAGMA busy_timeout = ${DEFAULT_PRAGMAS.busy_timeout_ms}`)
    applyCalendarSidecarMigrations(db)
    bootstrapMetaRow(db, input.project_id, now())
  } catch (err) {
    db.close()
    throw err
  }

  return buildHandle({ db, db_path, project_id: input.project_id, now })
}

/**
 * Compute the instant epoch ms for a stored event start. Mirrors the
 * backend.ts `isAllDayDate` path: all-day rows (`YYYY-MM-DD`) coerce
 * to UTC midnight of that local date, datetimed rows parse directly
 * (offset-aware via `Date.parse`). Returns `null` for malformed input
 * — the upsert stores it as NULL and the listEvents query excludes
 * NULL rows from the window walk.
 *
 * Argus r2 IMPORTANT #2 (2026-05-21) — `start_iso` preserves Google's
 * offset form (e.g. `2026-06-01T09:00:00-07:00` = instant 16:00Z) so
 * a lex compare against the query window's Z-form silently masks
 * in-window events on every non-UTC instance. Numeric compare via
 * `start_ms` fixes the bug for both shapes.
 */
function computeStartMs(start: string): number | null {
  let parsed: number
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    parsed = Date.parse(`${start}T00:00:00Z`)
  } else {
    parsed = Date.parse(start)
  }
  return Number.isNaN(parsed) ? null : parsed
}

function bootstrapMetaRow(db: Database, project_id: string, now_ms: number): void {
  const existing = db
    .query<{ project_id: string }, []>(
      `SELECT project_id FROM calendar_meta WHERE singleton = 1`,
    )
    .get()
  if (existing === null) {
    db.run(
      `INSERT INTO calendar_meta(singleton, schema_version, project_id, initialised_at)
       VALUES (1, ?, ?, ?)`,
      [CALENDAR_SCHEMA_VERSION, project_id, now_ms],
    )
    return
  }
  if (existing.project_id !== project_id) {
    throw new CalendarSidecarMismatchError(project_id, existing.project_id)
  }
}

function buildHandle(deps: {
  db: Database
  db_path: string
  project_id: string
  now: () => number
}): CalendarProjectCache {
  const { db, db_path, project_id, now } = deps

  const upsertSql = `INSERT INTO events_cache (
       calendar_id, event_id, title, start_iso, end_iso, status,
       description, attendees_json, html_link, project_id, etag,
       start_ms, cached_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(calendar_id, event_id) DO UPDATE SET
       title = excluded.title,
       start_iso = excluded.start_iso,
       end_iso = excluded.end_iso,
       status = excluded.status,
       description = excluded.description,
       attendees_json = excluded.attendees_json,
       html_link = excluded.html_link,
       project_id = excluded.project_id,
       etag = excluded.etag,
       start_ms = excluded.start_ms,
       cached_at = excluded.cached_at`

  type EventsCacheRow = {
    calendar_id: string
    event_id: string
    title: string
    start_iso: string
    end_iso: string
    status: string
    description: string | null
    attendees_json: string | null
    html_link: string | null
    project_id: string | null
    etag: string | null
    cached_at: number
  }
  // Argus r2 IMPORTANT #2 (2026-05-21) — compare events as INSTANTS
  // (numeric epoch ms) rather than as ISO strings. Lex comparison
  // across mixed-offset shapes (Google's `2026-06-01T09:00:00-07:00`
  // form vs the query window's Z-form `2026-06-01T15:00:00.000Z`)
  // silently drops in-window events on every non-UTC instance. Rows
  // with NULL `start_ms` (only possible if a migration race left a
  // backfill incomplete) are excluded by the IS NOT NULL guard —
  // safer than including unknown-instant rows.
  const listStmt = db.query<EventsCacheRow, [number, number, number]>(
    `SELECT calendar_id, event_id, title, start_iso, end_iso, status,
            description, attendees_json, html_link, project_id, etag, cached_at
       FROM events_cache
       WHERE status != 'cancelled'
         AND start_ms IS NOT NULL
         AND start_ms >= ?
         AND start_ms < ?
       ORDER BY start_ms ASC
       LIMIT ?`,
  )

  const insertAuditSql = `INSERT INTO pre_meeting_brief_audit (
       calendar_id, event_id, fired_at, model, outcome, prompt_hash,
       response_excerpt, chat_message_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

  const lastInsertIdStmt = db.query<{ id: number }, []>(
    `SELECT last_insert_rowid() AS id`,
  )

  const listAuditStmt = db.query<BriefAuditRow, [string, string, number]>(
    `SELECT id, calendar_id, event_id, fired_at, model, outcome, prompt_hash,
            response_excerpt, chat_message_id
       FROM pre_meeting_brief_audit
       WHERE calendar_id = ? AND event_id = ?
       ORDER BY fired_at DESC
       LIMIT ?`,
  )

  return {
    project_id,
    db_path,
    upsertEvents(rows, options): void {
      const cached_at = options?.cached_at ?? now()
      const tx = db.transaction((batch: readonly CalendarEventRow[]) => {
        for (const row of batch) {
          // Argus r2 IMPORTANT #2 — compute the instant epoch ms so
          // the listEvents window compare doesn't lex-compare against
          // mixed-offset ISO forms. All-day rows store `YYYY-MM-DD`
          // with no time component; coerce to UTC midnight of that
          // local date for the compare, mirroring the
          // `isAllDayDate` path in backend.ts.
          const start_ms = computeStartMs(row.start)
          db.run(upsertSql, [
            row.calendar_id,
            row.id,
            row.title,
            row.start,
            row.end,
            row.status,
            row.description ?? null,
            row.attendees !== undefined ? JSON.stringify(row.attendees) : null,
            row.html_link ?? null,
            row.project_id ?? null,
            null,
            start_ms,
            cached_at,
          ])
        }
      })
      tx(rows)
    },
    listEvents(window): CachedEventRow[] {
      const limit = Math.max(1, Math.floor(window.limit ?? 50))
      const raw = listStmt.all(window.range_start_ms, window.range_end_ms, limit)
      return raw.map((r) => {
        let attendees: readonly string[] = []
        if (r.attendees_json !== null) {
          try {
            const parsed = JSON.parse(r.attendees_json) as unknown
            if (Array.isArray(parsed)) {
              attendees = parsed.filter((s): s is string => typeof s === 'string')
            }
          } catch {
            // best-effort
          }
        }
        return {
          calendar_id: r.calendar_id,
          event_id: r.event_id,
          title: r.title,
          start_iso: r.start_iso,
          end_iso: r.end_iso,
          status: r.status === 'cancelled' ? 'cancelled' : 'confirmed',
          description: r.description,
          attendees,
          html_link: r.html_link,
          project_id: r.project_id,
          etag: r.etag,
          cached_at: r.cached_at,
        }
      })
    },
    recordBriefFire(input): number {
      db.run(insertAuditSql, [
        input.calendar_id,
        input.event_id,
        input.fired_at,
        input.model,
        input.outcome,
        input.prompt_hash,
        input.response_excerpt,
        input.chat_message_id,
      ])
      const row = lastInsertIdStmt.get()
      return row?.id ?? 0
    },
    listBriefAudit(input): BriefAuditRow[] {
      const limit = input.limit ?? 20
      return listAuditStmt.all(input.calendar_id, input.event_id, limit)
    },
    close(): void {
      try {
        db.close()
      } catch {
        // ignore close failures
      }
    },
  }
}

/* eslint-disable @typescript-eslint/no-unused-vars */
// Touch dirname so the import is preserved during tree-shaking (the
// migrations runner picks the dir up implicitly via import.meta.url).
void dirname
/* eslint-enable @typescript-eslint/no-unused-vars */
