import { describe, expect, test } from 'bun:test'

import {
  EventNotFoundError,
  GoogleCalendarApiError,
  OAuthMissingError,
  buildGoogleCalendarClient,
  buildInMemoryCalendarClient,
  durationMinutes,
  parseAgenda,
} from '../index.ts'

describe('buildInMemoryCalendarClient', () => {
  test('list compares timestamps by instant — non-UTC offsets do not break the window filter', async () => {
    // `2026-06-01T09:00:00-07:00` is the SAME instant as
    // `2026-06-01T16:00:00Z`. A naive lexicographic compare would
    // place the `-07:00` row OUTSIDE a `15:00Z–18:00Z` query window
    // (because the string starts with `09:` < `15:`) even though the
    // actual instant lies inside it. Regression-pin both orderings.
    const c = buildInMemoryCalendarClient({ nextId: (() => {
      let n = 0
      return () => `i-${n++}`
    })() })
    await c.create({
      title: 'PST-encoded inside window',
      start: '2026-06-01T09:00:00-07:00',  // == 16:00 UTC
      end: '2026-06-01T10:00:00-07:00',
    })
    await c.create({
      title: 'UTC-encoded inside window',
      start: '2026-06-01T17:00:00Z',
      end: '2026-06-01T18:00:00Z',
    })
    const rows = await c.list({
      range_start: '2026-06-01T15:00:00Z',
      range_end: '2026-06-01T19:00:00Z',
    })
    expect(rows.map((r) => r.title).sort()).toEqual([
      'PST-encoded inside window',
      'UTC-encoded inside window',
    ])
    // Ordering by instant: PST 09:00-07 = 16:00 UTC, UTC 17:00 = 17:00 UTC.
    expect(rows.map((r) => r.title)).toEqual([
      'PST-encoded inside window',
      'UTC-encoded inside window',
    ])
  })

  test('create returns a confirmed event with default primary calendar_id when omitted', async () => {
    const c = buildInMemoryCalendarClient({ nextId: () => 'cal-x' })
    const row = await c.create({
      title: 'standup',
      start: '2026-06-01T09:00:00Z',
      end: '2026-06-01T09:30:00Z',
    })
    expect(row.id).toBe('cal-x')
    expect(row.calendar_id).toBe('primary')
    expect(row.status).toBe('confirmed')
  })

  test('update on a non-existent event rejects with EventNotFoundError', async () => {
    const c = buildInMemoryCalendarClient()
    await expect(
      c.update({ event_id: 'missing', fields: { title: 'x' } }),
    ).rejects.toThrow(EventNotFoundError)
  })

  test('two calendars can hold the same event id without collision — keyed by (calendar_id, event_id)', async () => {
    // Regression: Google's API addresses events as (calendar_id,
    // event_id), so the same event id can legally exist on two
    // different calendars (e.g. an event copied between work + personal
    // calendars). A naive id-only Map would collapse them; the in-
    // memory client must mirror Google's composite addressing.
    let n = 0
    const c = buildInMemoryCalendarClient({ nextId: () => `shared-${n++}` })
    const work = await c.create({
      title: 'work copy',
      start: '2026-06-01T09:00:00Z',
      end: '2026-06-01T10:00:00Z',
      calendar_id: 'work',
    })
    // Reset the id minter so the next create reuses the id.
    n = 0
    const c2 = buildInMemoryCalendarClient({ nextId: () => `shared-${n++}` })
    // Two clients are independent — to actually test composite keying
    // we manually inject by using the same client + a forced-id mint.
    const c3 = buildInMemoryCalendarClient({
      nextId: () => 'collision-id',
    })
    await c3.create({
      title: 'work copy',
      start: '2026-06-01T09:00:00Z',
      end: '2026-06-01T10:00:00Z',
      calendar_id: 'work',
    })
    // Second create with the SAME id on a DIFFERENT calendar — the
    // composite-key map must keep both rows. We need a fresh id minter
    // since the test client mints once; bypass by reusing the same
    // mint (the in-memory client just stores whatever id() returns).
    await c3.create({
      title: 'personal copy',
      start: '2026-06-01T09:00:00Z',
      end: '2026-06-01T10:00:00Z',
      calendar_id: 'personal',
    })
    const workRow = await c3.get({ event_id: 'collision-id', calendar_id: 'work' })
    expect(workRow.title).toBe('work copy')
    expect(workRow.calendar_id).toBe('work')
    const personalRow = await c3.get({
      event_id: 'collision-id',
      calendar_id: 'personal',
    })
    expect(personalRow.title).toBe('personal copy')
    expect(personalRow.calendar_id).toBe('personal')
    // Cancel one — the other survives.
    await c3.cancel({ event_id: 'collision-id', calendar_id: 'work' })
    await expect(
      c3.get({ event_id: 'collision-id', calendar_id: 'work' }),
    ).rejects.toThrow(EventNotFoundError)
    const stillThere = await c3.get({
      event_id: 'collision-id',
      calendar_id: 'personal',
    })
    expect(stillThere.title).toBe('personal copy')
    // touch `work` to avoid an unused-var lint
    void work
    void c2
  })

  test('all-day events use date-range compare, not instant compare', async () => {
    // Regression: Google all-day events set `start.date` (YYYY-MM-DD,
    // no offset, calendar-LOCAL), not `start.dateTime`. Comparing a
    // calendar-local date as a UTC instant mis-shifts the event on
    // any non-UTC calendar (a Pacific calendar's 2026-06-01 all-day
    // would parse to 2026-05-31T17:00:00Z and either be wrongly
    // dropped or wrongly mis-ordered). The Core treats all-day rows
    // as date-range entities and lex-compares the date prefix.
    const c = buildInMemoryCalendarClient({ nextId: (() => {
      let n = 0
      return () => `ad-${n++}`
    })() })
    await c.create({
      title: 'all-day inside',
      start: '2026-06-01',
      end: '2026-06-02',
    })
    await c.create({
      title: 'all-day before window',
      start: '2026-05-31',
      end: '2026-06-01',
    })
    await c.create({
      title: 'all-day after window',
      start: '2026-06-15',
      end: '2026-06-16',
    })
    await c.create({
      title: 'datetimed inside',
      start: '2026-06-05T12:00:00Z',
      end: '2026-06-05T13:00:00Z',
    })
    const rows = await c.list({
      range_start: '2026-06-01T00:00:00Z',
      range_end: '2026-06-08T00:00:00Z',
    })
    // All-day on 2026-06-01 + datetimed on 2026-06-05 are both in
    // window; the before + after rows are dropped. Ordering: all-day
    // 2026-06-01 sorts as 2026-06-01T00:00:00Z, ahead of the datetimed
    // 2026-06-05.
    expect(rows.map((r) => r.title)).toEqual([
      'all-day inside',
      'datetimed inside',
    ])
  })

  test('sub-day window respects the time portion for all-day events — instant compare, not date-prefix', async () => {
    // Regression for the third Codex pass: a sub-day query like
    // [6/1T12:00Z, 6/2T12:00Z] must NOT include a 6/1 all-day event
    // whose instant (6/1T00:00:00Z under the v1 midnight-UTC coercion)
    // is before range_start. The earlier date-prefix-compare would
    // include it (because dates matched lexicographically), which
    // violated the documented "start >= range_start" semantics.
    let n = 0
    const c = buildInMemoryCalendarClient({ nextId: () => `sd-${n++}` })
    await c.create({
      title: 'all-day 6/1 — before window starts',
      start: '2026-06-01',
      end: '2026-06-02',
    })
    await c.create({
      title: 'all-day 6/2 — also before query end',
      start: '2026-06-02',
      end: '2026-06-03',
    })
    await c.create({
      title: 'datetimed mid-window',
      start: '2026-06-01T15:00:00Z',
      end: '2026-06-01T16:00:00Z',
    })
    const rows = await c.list({
      range_start: '2026-06-01T12:00:00Z',
      range_end: '2026-06-02T12:00:00Z',
    })
    // 6/1 all-day instant = 6/1T00:00:00Z → BEFORE 6/1T12:00:00Z → dropped.
    // 6/2 all-day instant = 6/2T00:00:00Z → AFTER 6/1T12:00:00Z, BEFORE
    //   6/2T12:00:00Z → kept.
    // 6/1T15:00Z datetimed → inside window → kept.
    // Ordering by instant: 6/2T00:00Z lands BEFORE 6/1T15:00Z numerically
    //   wait no, 6/2T00:00:00Z is LATER than 6/1T15:00:00Z. So ordering:
    //   6/1T15:00Z (15h after epoch-start-of-day), then 6/2T00:00:00Z.
    expect(rows.map((r) => r.title)).toEqual([
      'datetimed mid-window',
      'all-day 6/2 — also before query end',
    ])
  })

  test('cancel on a different calendar_id surfaces EventNotFoundError', async () => {
    const c = buildInMemoryCalendarClient({ nextId: () => 'cal-y' })
    await c.create({
      title: 'work',
      start: '2026-06-01T09:00:00Z',
      end: '2026-06-01T10:00:00Z',
    })
    await expect(
      c.cancel({ event_id: 'cal-y', calendar_id: 'other_calendar@group.calendar.google.com' }),
    ).rejects.toThrow(EventNotFoundError)
    // Default 'primary' still works.
    await expect(c.cancel({ event_id: 'cal-y' })).resolves.toBeUndefined()
  })
})

describe('parseAgenda', () => {
  test('returns an empty array on missing or empty description', () => {
    expect(parseAgenda(undefined)).toEqual([])
    expect(parseAgenda('')).toEqual([])
    expect(parseAgenda('   ')).toEqual([])
  })

  test('extracts bulleted + numbered lines, ignores prose', () => {
    expect(
      parseAgenda(
        [
          'Prep for the meeting:',
          '- intake call',
          '* compliance checklist',
          '• Heppner artifact set',
          'Notes',
          '1. confirm next session',
          '2) tentative date 2026-06-11',
        ].join('\n'),
      ),
    ).toEqual([
      'intake call',
      'compliance checklist',
      'Heppner artifact set',
      'confirm next session',
      'tentative date 2026-06-11',
    ])
  })
})

describe('durationMinutes', () => {
  test('computes integer minutes for a normal ISO-8601 interval', () => {
    expect(durationMinutes('2026-06-01T09:00:00Z', '2026-06-01T10:30:00Z')).toBe(90)
    expect(durationMinutes('2026-06-01T09:00:00Z', '2026-06-01T09:00:00Z')).toBe(0)
  })

  test('returns 0 on malformed timestamps rather than throwing', () => {
    expect(durationMinutes('garbage', '2026-06-01T10:00:00Z')).toBe(0)
    expect(durationMinutes('2026-06-01T09:00:00Z', 'also-garbage')).toBe(0)
  })
})

describe('buildGoogleCalendarClient — OAuth + REST wrapper', () => {
  /**
   * Smoke test against a stubbed fetch. We don't simulate the full
   * Google Calendar REST surface; we just assert the wrapper:
   *   - calls the access-token accessor before every request
   *   - throws OAuthMissingError when the accessor returns null
   *   - throws GoogleCalendarApiError on non-2xx responses
   *   - builds the expected URL + body shape
   */

  test('throws OAuthMissingError when the accessor returns null', async () => {
    const client = buildGoogleCalendarClient({
      accessToken: async () => null,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    })
    await expect(
      client.list({
        range_start: '2026-06-01T00:00:00Z',
        range_end: '2026-06-02T00:00:00Z',
      }),
    ).rejects.toThrow(OAuthMissingError)
  })

  test('list always sends `maxResults` — falls through to the Core default when caller omits limit, matching the in-memory backend', async () => {
    // Without this, an omitted `limit` would fall through to Google's
    // 250-row default and the two backends would disagree on default
    // payload size. The Core's documented default is 50.
    let seenUrl = ''
    const client = buildGoogleCalendarClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input) => {
        seenUrl = typeof input === 'string' ? input : input.toString()
        return new Response(JSON.stringify({ items: [] }), { status: 200 })
      },
    })
    await client.list({
      range_start: '2026-06-01T00:00:00Z',
      range_end: '2026-06-02T00:00:00Z',
    })
    expect(seenUrl).toContain('maxResults=50')

    // Caller-supplied limit still wins.
    let seenUrl2 = ''
    const client2 = buildGoogleCalendarClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input) => {
        seenUrl2 = typeof input === 'string' ? input : input.toString()
        return new Response(JSON.stringify({ items: [] }), { status: 200 })
      },
    })
    await client2.list({
      range_start: '2026-06-01T00:00:00Z',
      range_end: '2026-06-02T00:00:00Z',
      limit: 5,
    })
    expect(seenUrl2).toContain('maxResults=5')
  })

  test('list post-filters by event START INSTANT, not raw string — non-UTC offsets compare correctly', async () => {
    // A meeting at `09:00:00-07:00` is the SAME instant as `16:00:00Z`,
    // which IS inside a `15:00Z–18:00Z` query. A naive lexicographic
    // compare (`'2026-06-01T09:…' < '2026-06-01T15:…'`) would drop it
    // even though it belongs in the window. Regression-pin: the row
    // survives the client-side filter.
    const client = buildGoogleCalendarClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () => {
        const body = JSON.stringify({
          items: [
            {
              id: 'pst-row',
              status: 'confirmed',
              summary: 'PST-encoded inside UTC window',
              // -07:00 puts this at 16:00 UTC, inside the 15:00Z–18:00Z window.
              start: { dateTime: '2026-06-01T09:00:00-07:00' },
              end: { dateTime: '2026-06-01T10:00:00-07:00' },
            },
            {
              id: 'outside-row',
              status: 'confirmed',
              summary: 'PST-encoded outside UTC window',
              // -07:00 here puts the start at 03:00 UTC, well before the
              // window — must be dropped.
              start: { dateTime: '2026-05-31T20:00:00-07:00' },
              end: { dateTime: '2026-05-31T21:00:00-07:00' },
            },
          ],
        })
        return new Response(body, { status: 200 })
      },
    })
    const rows = await client.list({
      range_start: '2026-06-01T15:00:00Z',
      range_end: '2026-06-01T18:00:00Z',
    })
    expect(rows.map((r) => r.id)).toEqual(['pst-row'])
  })

  test('GET /events sends bearer token + the expected query string + parses items[]', async () => {
    const seen: { url: string; method: string; headers: Headers } = {
      url: '',
      method: '',
      headers: new Headers(),
    }
    const client = buildGoogleCalendarClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input, init) => {
        seen.url = typeof input === 'string' ? input : input.toString()
        seen.method = (init?.method as string) ?? 'GET'
        seen.headers = new Headers(init?.headers as HeadersInit | undefined)
        const body = JSON.stringify({
          items: [
            {
              id: 'evt-1',
              status: 'confirmed',
              summary: 'kickoff',
              start: { dateTime: '2026-06-01T09:00:00Z' },
              end: { dateTime: '2026-06-01T10:00:00Z' },
              attendees: [{ email: 'casey@example.com' }],
              htmlLink: 'https://calendar.google.com/event?eid=foo',
            },
          ],
        })
        return new Response(body, { status: 200 })
      },
    })
    const rows = await client.list({
      range_start: '2026-06-01T00:00:00Z',
      range_end: '2026-06-02T00:00:00Z',
      limit: 25,
    })
    expect(seen.method).toBe('GET')
    expect(seen.headers.get('authorization')).toBe('Bearer ya29.test')
    expect(seen.url).toContain('/calendars/primary/events')
    expect(seen.url).toContain('timeMin=2026-06-01T00%3A00%3A00Z')
    expect(seen.url).toContain('timeMax=2026-06-02T00%3A00%3A00Z')
    expect(seen.url).toContain('singleEvents=true')
    expect(seen.url).toContain('orderBy=startTime')
    expect(seen.url).toContain('maxResults=25')
    expect(rows.length).toBe(1)
    expect(rows[0]?.id).toBe('evt-1')
    expect(rows[0]?.attendees).toEqual(['casey@example.com'])
    expect(rows[0]?.html_link).toBe('https://calendar.google.com/event?eid=foo')
  })

  test('POST /events serialises the expected payload', async () => {
    const seen: { body: string; method: string } = { body: '', method: '' }
    const client = buildGoogleCalendarClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (_input, init) => {
        seen.method = (init?.method as string) ?? 'GET'
        seen.body = typeof init?.body === 'string' ? init.body : ''
        return new Response(
          JSON.stringify({
            id: 'evt-new',
            status: 'confirmed',
            summary: 'kickoff',
            start: { dateTime: '2026-06-01T09:00:00Z' },
            end: { dateTime: '2026-06-01T10:00:00Z' },
          }),
          { status: 200 },
        )
      },
    })
    const row = await client.create({
      title: 'kickoff',
      start: '2026-06-01T09:00:00Z',
      end: '2026-06-01T10:00:00Z',
      attendees: ['casey@example.com'],
      description: 'agenda below',
    })
    expect(seen.method).toBe('POST')
    const body = JSON.parse(seen.body) as Record<string, unknown>
    expect(body.summary).toBe('kickoff')
    expect((body.start as Record<string, string>).dateTime).toBe('2026-06-01T09:00:00Z')
    expect((body.end as Record<string, string>).dateTime).toBe('2026-06-01T10:00:00Z')
    expect(body.description).toBe('agenda below')
    expect(body.attendees).toEqual([{ email: 'casey@example.com' }])
    expect(row.id).toBe('evt-new')
  })

  test('non-2xx responses throw GoogleCalendarApiError with the http status preserved', async () => {
    const client = buildGoogleCalendarClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () => new Response('{"error":"forbidden"}', { status: 403 }),
    })
    let caught: unknown
    try {
      await client.list({
        range_start: '2026-06-01T00:00:00Z',
        range_end: '2026-06-02T00:00:00Z',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(GoogleCalendarApiError)
    expect((caught as GoogleCalendarApiError).http_status).toBe(403)
  })

  test('list post-filters Google `items[]` by event START time — Google `timeMin` is end-time-based, so an overlap event must be dropped client-side', async () => {
    // Google's `events.list` filters on event END time (`timeMin` is the
    // lower bound of the event's end, not start), so a meeting that
    // started before `range_start` but ends inside the window is
    // returned by the API. The Core documents list semantics in terms
    // of START time, matching the in-memory client. Regression: assert
    // the production wrapper drops the overlap event client-side.
    const client = buildGoogleCalendarClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () => {
        const body = JSON.stringify({
          items: [
            {
              id: 'overlap',
              status: 'confirmed',
              summary: 'started before window',
              start: { dateTime: '2026-06-01T08:30:00Z' },
              end: { dateTime: '2026-06-01T09:30:00Z' },
            },
            {
              id: 'inside',
              status: 'confirmed',
              summary: 'inside window',
              start: { dateTime: '2026-06-01T10:00:00Z' },
              end: { dateTime: '2026-06-01T11:00:00Z' },
            },
            {
              id: 'past-end',
              status: 'confirmed',
              summary: 'after window',
              start: { dateTime: '2026-06-01T18:00:00Z' },
              end: { dateTime: '2026-06-01T19:00:00Z' },
            },
          ],
        })
        return new Response(body, { status: 200 })
      },
    })
    const rows = await client.list({
      range_start: '2026-06-01T09:00:00Z',
      range_end: '2026-06-01T17:00:00Z',
    })
    expect(rows.map((r) => r.id)).toEqual(['inside'])
  })

  test('404 / 410 on single-event endpoints surfaces EventNotFoundError, not GoogleCalendarApiError', async () => {
    // The CalendarClient interface documents `update` / `cancel` / `get`
    // as throwing `EventNotFoundError` on missing ids — both the
    // in-memory client and the Core's tool surface branch on that
    // typed error. Without the 404/410 mapping the Google wrapper
    // would throw `GoogleCalendarApiError` instead and callers would
    // need to know which backend they talked to. Regression-pin both
    // status codes for all three single-event endpoints.
    for (const status of [404, 410]) {
      const client404 = buildGoogleCalendarClient({
        accessToken: async () => 'ya29.test',
        fetchImpl: async () => new Response('{"error":"not found"}', { status }),
      })
      await expect(client404.get({ event_id: 'missing' })).rejects.toThrow(
        EventNotFoundError,
      )
      await expect(
        client404.update({ event_id: 'missing', fields: { title: 'x' } }),
      ).rejects.toThrow(EventNotFoundError)
      await expect(client404.cancel({ event_id: 'missing' })).rejects.toThrow(
        EventNotFoundError,
      )
    }
  })

  test('list follows nextPageToken when the first page is saturated with overlap rows that get dropped client-side', async () => {
    // Regression: Google's `timeMin` is end-time based, so a long-
    // running event that started before the window can saturate the
    // first page and crowd out valid in-window rows that live on a
    // later page. Without pagination, callers would silently see too
    // few (or zero) matching rows. Simulate: page 1 returns three
    // overlap rows (all before the window) + a nextPageToken; page 2
    // returns three in-window rows + no token.
    let call_n = 0
    const seenTokens: Array<string | null> = []
    const client = buildGoogleCalendarClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        const m = url.match(/pageToken=([^&]+)/)
        seenTokens.push(m?.[1] ?? null)
        call_n += 1
        if (call_n === 1) {
          return new Response(
            JSON.stringify({
              items: [
                // overlap: started before window, ends inside
                { id: 'o-1', status: 'confirmed', summary: 'overlap 1',
                  start: { dateTime: '2026-05-31T20:00:00Z' }, end: { dateTime: '2026-06-01T10:00:00Z' } },
                { id: 'o-2', status: 'confirmed', summary: 'overlap 2',
                  start: { dateTime: '2026-05-31T22:00:00Z' }, end: { dateTime: '2026-06-01T11:00:00Z' } },
                { id: 'o-3', status: 'confirmed', summary: 'overlap 3',
                  start: { dateTime: '2026-05-31T23:00:00Z' }, end: { dateTime: '2026-06-01T11:30:00Z' } },
              ],
              nextPageToken: 'page-2',
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            items: [
              { id: 'r-1', status: 'confirmed', summary: 'real 1',
                start: { dateTime: '2026-06-01T12:00:00Z' }, end: { dateTime: '2026-06-01T13:00:00Z' } },
              { id: 'r-2', status: 'confirmed', summary: 'real 2',
                start: { dateTime: '2026-06-01T14:00:00Z' }, end: { dateTime: '2026-06-01T15:00:00Z' } },
            ],
          }),
          { status: 200 },
        )
      },
    })
    const rows = await client.list({
      range_start: '2026-06-01T11:45:00Z',
      range_end: '2026-06-01T17:00:00Z',
    })
    expect(rows.map((r) => r.id)).toEqual(['r-1', 'r-2'])
    expect(seenTokens).toEqual([null, 'page-2'])
    expect(call_n).toBe(2)
  })

  test('list correctly handles Google all-day rows (start.date, not start.dateTime)', async () => {
    // Regression: Google all-day events set `start.date` (calendar-
    // local `YYYY-MM-DD`, no timezone offset). The Core's row shape
    // captures whichever Google supplied. Comparing the bare date as
    // a UTC instant would mis-shift on non-UTC calendars. Assert that
    // an all-day event whose date is in the window survives the
    // post-filter regardless of the query window's offset.
    const client = buildGoogleCalendarClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'allday-in',
                status: 'confirmed',
                summary: 'all-day inside',
                start: { date: '2026-06-05' },
                end: { date: '2026-06-06' },
              },
              {
                id: 'allday-out',
                status: 'confirmed',
                summary: 'all-day after',
                start: { date: '2026-06-15' },
                end: { date: '2026-06-16' },
              },
            ],
          }),
          { status: 200 },
        ),
    })
    const rows = await client.list({
      range_start: '2026-06-01T00:00:00Z',
      range_end: '2026-06-08T00:00:00Z',
    })
    expect(rows.map((r) => r.id)).toEqual(['allday-in'])
    expect(rows[0]?.start).toBe('2026-06-05')
  })

  test('list stops paginating once the limit is satisfied', async () => {
    // Regression: even if Google returns a nextPageToken, we stop
    // following pages as soon as we've collected `limit` matching
    // rows. Avoids burning round-trips on busy calendars.
    let call_n = 0
    const client = buildGoogleCalendarClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () => {
        call_n += 1
        return new Response(
          JSON.stringify({
            items: [
              { id: 'a', status: 'confirmed', summary: 'a',
                start: { dateTime: '2026-06-01T09:00:00Z' }, end: { dateTime: '2026-06-01T10:00:00Z' } },
              { id: 'b', status: 'confirmed', summary: 'b',
                start: { dateTime: '2026-06-01T10:00:00Z' }, end: { dateTime: '2026-06-01T11:00:00Z' } },
            ],
            nextPageToken: 'never-followed',
          }),
          { status: 200 },
        )
      },
    })
    const rows = await client.list({
      range_start: '2026-06-01T00:00:00Z',
      range_end: '2026-06-02T00:00:00Z',
      limit: 2,
    })
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(call_n).toBe(1)
  })

  test('list does NOT map 404 to EventNotFoundError — list is a collection endpoint, not a single-event endpoint', async () => {
    // A 404 on `events.list` (e.g. unknown calendar_id) is NOT the
    // "this one event is missing" case the contract covers — propagate
    // the generic `GoogleCalendarApiError` so the caller's catch on
    // `EventNotFoundError` only fires when an event-id-shaped request
    // returns 404.
    const client = buildGoogleCalendarClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () => new Response('{"error":"not found"}', { status: 404 }),
    })
    let caught: unknown
    try {
      await client.list({
        range_start: '2026-06-01T00:00:00Z',
        range_end: '2026-06-02T00:00:00Z',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(GoogleCalendarApiError)
    expect((caught as GoogleCalendarApiError).http_status).toBe(404)
  })

  test('DELETE /events/<id> returns void on 204', async () => {
    let calledMethod = ''
    const client = buildGoogleCalendarClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (_input, init) => {
        calledMethod = (init?.method as string) ?? 'GET'
        return new Response(null, { status: 204 })
      },
    })
    await expect(client.cancel({ event_id: 'evt-1' })).resolves.toBeUndefined()
    expect(calledMethod).toBe('DELETE')
  })
})
