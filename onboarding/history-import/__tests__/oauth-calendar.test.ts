/**
 * Calendar OAuth importer tests — mocked Google Calendar API.
 */

import { expect, test } from 'bun:test'
import { fetchCalendarEvents, type CalendarClient } from '../oauth-calendar.ts'
import { ImportError } from '../types.ts'

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

const mockClient: CalendarClient = {
  async *listEvents(input) {
    expect(input.since_ms).toBeGreaterThan(0)
    expect(input.until_ms).toBeGreaterThan(input.since_ms)
    yield {
      event_id: 'e1',
      summary: 'Standup',
      start_ms: 1714521600000,
      end_ms: 1714523400000,
      attendees: [{ email: 'a@x.com', display_name: 'Alice' }],
      organizer: 'me',
    }
    yield {
      event_id: 'e2',
      summary: 'Strategy review',
      description: 'Q3 plans',
      start_ms: 1714608000000,
    }
  },
}

test('fetches calendar events with default 365-day window', async () => {
  const records = await collect(
    fetchCalendarEvents({
      oauth: { access_token: 'xyz' },
      client: mockClient,
    }),
  )
  expect(records.length).toBe(2)
  expect(records[0]?.conversation_id).toBe('calendar:e1')
  expect(records[0]?.title).toBe('Standup')
})

test('renders event metadata into the message text', async () => {
  const records = await collect(
    fetchCalendarEvents({
      oauth: { access_token: 'xyz' },
      client: mockClient,
    }),
  )
  const text = records[0]?.messages[0]?.text ?? ''
  expect(text).toContain('Event: Standup')
  expect(text).toContain('Alice')
  expect(text).toContain('Organizer: me')
})

test('throws ImportError on empty access_token', async () => {
  await expect(async () => {
    for await (const _ of fetchCalendarEvents({
      oauth: { access_token: '' },
      client: mockClient,
    })) {
      // unreachable
    }
  }).toThrow(ImportError)
})

test('respects max_events cap', async () => {
  const wideClient: CalendarClient = {
    async *listEvents() {
      for (let i = 0; i < 100; i++)
        yield { event_id: `e-${i}`, start_ms: Date.now(), summary: `e-${i}` }
    },
  }
  const records = await collect(
    fetchCalendarEvents({
      oauth: { access_token: 'xyz' },
      client: wideClient,
      max_events: 5,
    }),
  )
  expect(records.length).toBe(5)
})
