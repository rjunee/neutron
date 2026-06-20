/**
 * Calendar Core S1 — `pre_meeting_brief_queue` Sqlite store tests.
 *
 * Focus: ISSUE #29 backward-compat — a row written with ONLY the
 * original 0003 columns (no `title` / `attendees_json` / `meeting_link`)
 * must deserialize without error through `listPending` post-migration
 * 0004, returning NULL in the new fields so the scheduler's
 * `buildEventFromQueueRow` falls through to its empty-stub path.
 *
 * Also covers the post-fix round-trip: write via the new typed
 * `upsertPending(...)` with rich-content fields → read via
 * `listPending` → assert the fields hydrate.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CALENDAR_DB, CALENDAR_DIR } from '../src/cache.ts'
import { applyCalendarSidecarMigrations } from '../migrations/runner.ts'
import { SqlitePreMeetingBriefQueueStore } from '../src/pre-meeting-brief-queue-store.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cal-pmb-queue-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('pre-meeting-brief queue store', () => {
  test('ISSUE #29 — pre-migration row with NULL new fields hydrates without throwing', async () => {
    // Open the per-project sidecar via the store so migrations land
    // (including 0004), then write a row using the OLD column set only.
    const project_id = 'projA'
    const store = new SqlitePreMeetingBriefQueueStore({ owner_home: tmp })
    // listPending opens the handle + applies migrations.
    expect(await store.listPending(project_id)).toEqual([])

    const dir = join(tmp, 'Projects', project_id, CALENDAR_DIR)
    mkdirSync(dir, { recursive: true })
    const db_path = join(dir, CALENDAR_DB)
    // Direct insert using only the 0003 column shape — simulates a row
    // a prior gateway boot wrote before ISSUE #29 shipped (or a stale
    // hand-written admin row). The new columns default to NULL.
    const raw = new Database(db_path)
    try {
      raw.run(
        `INSERT INTO pre_meeting_brief_queue (
           calendar_id, event_id, project_id, meeting_start_ms,
           lead_time_ms, fire_at_ms, status, skip_reason,
           enqueued_at_ms, fired_at_ms
         ) VALUES ('primary', 'evt-legacy', ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
        [
          project_id,
          Date.parse('2026-05-23T10:00:00Z'),
          5 * 60_000,
          Date.parse('2026-05-23T09:55:00Z'),
          Date.parse('2026-05-23T09:30:00Z'),
        ],
      )
    } finally {
      raw.close()
    }

    // listPending opens a fresh handle, re-applies migrations
    // (idempotent), and reads the row. The deserializer must not throw
    // on the NULL columns.
    const rows = await store.listPending(project_id)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.event_id).toBe('evt-legacy')
    expect(row?.title).toBeNull()
    expect(row?.attendees).toBeNull()
    expect(row?.meeting_link).toBeNull()
    store.closeAll()
  })

  test('ISSUE #29 — round-trip rich-content fields through upsertPending → listPending', async () => {
    const project_id = 'projB'
    const store = new SqlitePreMeetingBriefQueueStore({ owner_home: tmp })
    await store.upsertPending({
      calendar_id: 'primary',
      event_id: 'evt-rich',
      project_id,
      meeting_start_ms: Date.parse('2026-05-23T11:00:00Z'),
      lead_time_ms: 10 * 60_000,
      fire_at_ms: Date.parse('2026-05-23T10:50:00Z'),
      enqueued_at_ms: Date.parse('2026-05-23T09:00:00Z'),
      title: 'Quarterly board sync',
      attendees: ['sam@example.com', 'casey@example.com'],
      meeting_link: 'https://meet.google.com/abc-defg-hij',
    })
    const rows = await store.listPending(project_id)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.title).toBe('Quarterly board sync')
    expect(row?.attendees).toEqual(['sam@example.com', 'casey@example.com'])
    expect(row?.meeting_link).toBe('https://meet.google.com/abc-defg-hij')
    store.closeAll()
  })

  test('ISSUE #29 — corrupt attendees_json deserializes as NULL (defensive)', async () => {
    // The writer always emits valid JSON, but a hand-edited row or
    // future schema change should degrade to the empty-stub path
    // rather than crash the scheduler boot walk. Verify the parser
    // returns NULL on garbage input.
    const project_id = 'projC'
    const store = new SqlitePreMeetingBriefQueueStore({ owner_home: tmp })
    // Apply migrations + open handle.
    expect(await store.listPending(project_id)).toEqual([])

    const dir = join(tmp, 'Projects', project_id, CALENDAR_DIR)
    mkdirSync(dir, { recursive: true })
    const db_path = join(dir, CALENDAR_DB)
    const raw = new Database(db_path)
    try {
      raw.run(
        `INSERT INTO pre_meeting_brief_queue (
           calendar_id, event_id, project_id, meeting_start_ms,
           lead_time_ms, fire_at_ms, status, skip_reason,
           enqueued_at_ms, fired_at_ms,
           title, attendees_json, meeting_link
         ) VALUES ('primary', 'evt-bad-json', ?, ?, ?, ?, 'pending', NULL, ?, NULL,
                   'OK title', 'not-valid-json{', 'https://meet.google.com/x')`,
        [
          project_id,
          Date.parse('2026-05-23T12:00:00Z'),
          5 * 60_000,
          Date.parse('2026-05-23T11:55:00Z'),
          Date.parse('2026-05-23T11:30:00Z'),
        ],
      )
    } finally {
      raw.close()
    }

    const rows = await store.listPending(project_id)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row?.title).toBe('OK title')
    // Bad JSON → NULL (defensive); other fields still hydrate.
    expect(row?.attendees).toBeNull()
    expect(row?.meeting_link).toBe('https://meet.google.com/x')
    store.closeAll()
  })

  test('ISSUE #29 — migration 0004 is recorded in _migrations after applyCalendarSidecarMigrations', async () => {
    // Sanity: forward-only migration tree records 0001-0004 on a fresh
    // DB. Guards against an accidental dir-reorder breaking the runner.
    const dir = join(tmp, 'check')
    mkdirSync(dir, { recursive: true })
    const db = new Database(join(dir, 'check.db'))
    try {
      applyCalendarSidecarMigrations(db)
      const versions = db
        .query<{ version: number }, []>('SELECT version FROM _migrations ORDER BY version')
        .all()
        .map((r) => r.version)
      expect(versions).toContain(1)
      expect(versions).toContain(2)
      expect(versions).toContain(3)
      expect(versions).toContain(4)
    } finally {
      db.close()
    }
  })
})
