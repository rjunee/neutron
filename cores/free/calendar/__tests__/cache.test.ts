/**
 * Calendar Core S1 — per-project SQLite cache tests.
 *
 * Schema round-trip + audit append + project_id mismatch defence.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CALENDAR_DB,
  CALENDAR_DIR,
  CalendarSidecarMismatchError,
  openCalendarProjectCache,
} from '../src/cache.ts'
import type { CalendarEventRow } from '../src/backend.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'calendar-cache-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function eventRow(
  partial: Partial<CalendarEventRow> & {
    id: string
    title: string
    start: string
    end: string
  },
): CalendarEventRow {
  return {
    id: partial.id,
    calendar_id: partial.calendar_id ?? 'primary',
    title: partial.title,
    start: partial.start,
    end: partial.end,
    status: partial.status ?? 'confirmed',
    ...(partial.description !== undefined ? { description: partial.description } : {}),
    ...(partial.attendees !== undefined ? { attendees: partial.attendees } : {}),
    ...(partial.html_link !== undefined ? { html_link: partial.html_link } : {}),
    ...(partial.project_id !== undefined ? { project_id: partial.project_id } : {}),
  }
}

describe('openCalendarProjectCache', () => {
  test('creates calendar.db under <dir>/calendar.db and applies migration', () => {
    const dir = join(tmp, 'projA', CALENDAR_DIR)
    const cache = openCalendarProjectCache({ dir, project_id: 'projA' })
    try {
      expect(cache.project_id).toBe('projA')
      expect(cache.db_path).toBe(join(dir, CALENDAR_DB))
    } finally {
      cache.close()
    }
  })

  test('rejects re-open with a different project_id', () => {
    const dir = join(tmp, 'projA', CALENDAR_DIR)
    const first = openCalendarProjectCache({ dir, project_id: 'projA' })
    first.close()
    expect(() => openCalendarProjectCache({ dir, project_id: 'somebody_else' }))
      .toThrowError(CalendarSidecarMismatchError)
  })
})

describe('events_cache CRUD', () => {
  test('upsertEvents inserts then updates by (calendar_id, event_id)', () => {
    const cache = openCalendarProjectCache({
      dir: join(tmp, 'projA', CALENDAR_DIR),
      project_id: 'projA',
    })
    try {
      const row1 = eventRow({
        id: 'evt-1',
        title: 'Standup',
        start: '2026-05-21T09:00:00Z',
        end: '2026-05-21T09:30:00Z',
        attendees: ['a@x.com'],
        project_id: 'projA',
      })
      cache.upsertEvents([row1])
      let stored = cache.listEvents({
        range_start_ms: Date.parse('2026-05-21T00:00:00Z'),
        range_end_ms: Date.parse('2026-05-22T00:00:00Z'),
      })
      expect(stored).toHaveLength(1)
      expect(stored[0]?.title).toBe('Standup')
      // Idempotent upsert overwrites title.
      cache.upsertEvents([{ ...row1, title: 'Standup-v2' }])
      stored = cache.listEvents({
        range_start_ms: Date.parse('2026-05-21T00:00:00Z'),
        range_end_ms: Date.parse('2026-05-22T00:00:00Z'),
      })
      expect(stored).toHaveLength(1)
      expect(stored[0]?.title).toBe('Standup-v2')
    } finally {
      cache.close()
    }
  })

  test('listEvents filters cancelled rows', () => {
    const cache = openCalendarProjectCache({
      dir: join(tmp, 'projA', CALENDAR_DIR),
      project_id: 'projA',
    })
    try {
      cache.upsertEvents([
        eventRow({
          id: 'live',
          title: 'Live',
          start: '2026-05-21T09:00:00Z',
          end: '2026-05-21T09:30:00Z',
        }),
        eventRow({
          id: 'cancelled',
          title: 'Cancelled',
          start: '2026-05-21T10:00:00Z',
          end: '2026-05-21T10:30:00Z',
          status: 'cancelled',
        }),
      ])
      const stored = cache.listEvents({
        range_start_ms: Date.parse('2026-05-21T00:00:00Z'),
        range_end_ms: Date.parse('2026-05-22T00:00:00Z'),
      })
      expect(stored).toHaveLength(1)
      expect(stored[0]?.title).toBe('Live')
    } finally {
      cache.close()
    }
  })

  test('listEvents handles mixed-offset start_iso correctly (Argus r2 IMPORTANT #2)', () => {
    // Prior bug: `start_iso` lex-compared against the Z-form query
    // window dropped events stored in `±HH:MM` offset form. Google's
    // v3 API returns `start.dateTime` in the calendar's own offset
    // (e.g. `2026-06-01T09:00:00-07:00` = instant 16:00Z), but the
    // window is fed in as `new Date(ms).toISOString()` which is
    // Z-form. `'09:00:00-07:00' < '15:00:00.000Z'` is true → in-window
    // event silently excluded. Fix: numeric `start_ms` compare.
    const cache = openCalendarProjectCache({
      dir: join(tmp, 'projA', CALENDAR_DIR),
      project_id: 'projA',
    })
    try {
      cache.upsertEvents([
        eventRow({
          id: 'evt-pacific',
          title: 'Pacific-time event',
          start: '2026-06-01T09:00:00-07:00',
          end: '2026-06-01T10:00:00-07:00',
        }),
        eventRow({
          id: 'evt-eastern',
          title: 'Eastern-time event',
          start: '2026-06-01T12:00:00-04:00',
          end: '2026-06-01T13:00:00-04:00',
        }),
        eventRow({
          id: 'evt-utc',
          title: 'UTC event',
          start: '2026-06-01T16:30:00Z',
          end: '2026-06-01T17:00:00Z',
        }),
      ])
      // Window: 2026-06-01T15:00:00Z → 2026-06-01T17:00:00Z
      //   - Pacific event = 16:00Z (in window)
      //   - Eastern event = 16:00Z (in window)
      //   - UTC event     = 16:30Z (in window)
      const stored = cache.listEvents({
        range_start_ms: Date.parse('2026-06-01T15:00:00Z'),
        range_end_ms: Date.parse('2026-06-01T17:00:00Z'),
      })
      expect(stored.map((r) => r.title).sort()).toEqual([
        'Eastern-time event',
        'Pacific-time event',
        'UTC event',
      ])
    } finally {
      cache.close()
    }
  })

  test('listEvents returns chronological-ascending order across offset forms (Argus r2 IMPORTANT #2)', () => {
    // Numeric compare must order events by their actual instant, not
    // by lex-sorted ISO string. Mixed-offset rows order would be
    // wrong under lex sort.
    const cache = openCalendarProjectCache({
      dir: join(tmp, 'projA', CALENDAR_DIR),
      project_id: 'projA',
    })
    try {
      cache.upsertEvents([
        // Pacific-form 09:00 = 16:00Z (later instant)
        eventRow({
          id: 'pacific-later',
          title: 'Pacific 09:00 → 16:00Z',
          start: '2026-06-01T09:00:00-07:00',
          end: '2026-06-01T10:00:00-07:00',
        }),
        // Z-form 15:00 = 15:00Z (earlier instant)
        eventRow({
          id: 'utc-earlier',
          title: 'UTC 15:00Z',
          start: '2026-06-01T15:00:00Z',
          end: '2026-06-01T15:30:00Z',
        }),
      ])
      const stored = cache.listEvents({
        range_start_ms: Date.parse('2026-06-01T00:00:00Z'),
        range_end_ms: Date.parse('2026-06-02T00:00:00Z'),
      })
      expect(stored.map((r) => r.title)).toEqual([
        'UTC 15:00Z',
        'Pacific 09:00 → 16:00Z',
      ])
    } finally {
      cache.close()
    }
  })

  test('listEvents returns chronological-ascending order', () => {
    const cache = openCalendarProjectCache({
      dir: join(tmp, 'projA', CALENDAR_DIR),
      project_id: 'projA',
    })
    try {
      cache.upsertEvents([
        eventRow({
          id: 'late',
          title: 'Late',
          start: '2026-05-21T14:00:00Z',
          end: '2026-05-21T15:00:00Z',
        }),
        eventRow({
          id: 'early',
          title: 'Early',
          start: '2026-05-21T09:00:00Z',
          end: '2026-05-21T10:00:00Z',
        }),
      ])
      const stored = cache.listEvents({
        range_start_ms: Date.parse('2026-05-21T00:00:00Z'),
        range_end_ms: Date.parse('2026-05-22T00:00:00Z'),
      })
      expect(stored.map((r) => r.title)).toEqual(['Early', 'Late'])
    } finally {
      cache.close()
    }
  })
})

describe('pre_meeting_brief_audit', () => {
  test('recordBriefFire appends rows and listBriefAudit returns newest first', () => {
    const cache = openCalendarProjectCache({
      dir: join(tmp, 'projA', CALENDAR_DIR),
      project_id: 'projA',
    })
    try {
      const id1 = cache.recordBriefFire({
        calendar_id: 'primary',
        event_id: 'evt-1',
        fired_at: 1000,
        model: 'claude-haiku-fast',
        outcome: 'ok',
        prompt_hash: 'aaaa',
        response_excerpt: 'first',
        chat_message_id: 'msg-1',
      })
      const id2 = cache.recordBriefFire({
        calendar_id: 'primary',
        event_id: 'evt-1',
        fired_at: 2000,
        model: 'claude-haiku-fast',
        outcome: 'llm_error',
        prompt_hash: 'bbbb',
        response_excerpt: 'second',
        chat_message_id: null,
      })
      expect(id1).toBeGreaterThan(0)
      expect(id2).toBeGreaterThan(id1)
      const log = cache.listBriefAudit({
        calendar_id: 'primary',
        event_id: 'evt-1',
      })
      expect(log).toHaveLength(2)
      expect(log[0]?.fired_at).toBe(2000)
      expect(log[1]?.fired_at).toBe(1000)
      expect(log[0]?.outcome).toBe('llm_error')
    } finally {
      cache.close()
    }
  })

  test('audit row for a different event_id is isolated', () => {
    const cache = openCalendarProjectCache({
      dir: join(tmp, 'projA', CALENDAR_DIR),
      project_id: 'projA',
    })
    try {
      cache.recordBriefFire({
        calendar_id: 'primary',
        event_id: 'evt-1',
        fired_at: 1000,
        model: 'm',
        outcome: 'ok',
        prompt_hash: 'a',
        response_excerpt: 'x',
        chat_message_id: null,
      })
      const log = cache.listBriefAudit({
        calendar_id: 'primary',
        event_id: 'evt-other',
      })
      expect(log).toHaveLength(0)
    } finally {
      cache.close()
    }
  })
})
