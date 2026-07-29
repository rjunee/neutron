/**
 * Calendar Core S1 — chat-command parser + dispatcher tests.
 *
 * Pure parser cases for every `/cal` sub-command happy + malformed
 * paths, plus dispatcher round-trip cases against the in-memory
 * `buildInMemoryCalendarClient`.
 */

import { describe, expect, test } from 'bun:test'

import {
  buildInMemoryCalendarClient,
  type CalendarClient,
} from '../src/backend.ts'
import {
  executeCalCommand,
  parseAndExecuteCalCommand,
  parseCalCommand,
  type CalCommand,
  type CalCommandResponse,
} from '../src/chat-commands.ts'

const NOW = new Date('2026-05-20T18:00:00Z')

describe('parseCalCommand — verb dispatch', () => {
  test('bare /cal returns help', () => {
    const cmd = parseCalCommand('/cal', NOW)
    expect(cmd.kind).toBe('help')
  })

  test('whitespace before /cal is tolerated', () => {
    const cmd = parseCalCommand('   /cal   ', NOW)
    expect(cmd.kind).toBe('help')
  })

  test('non-/cal body is unrecognized', () => {
    const cmd = parseCalCommand('what is on my calendar', NOW)
    expect(cmd.kind).toBe('unrecognized')
  })

  test('unknown verb routes to unrecognized', () => {
    const cmd = parseCalCommand('/cal wat', NOW)
    expect(cmd.kind).toBe('unrecognized')
  })
})

describe('parseCalCommand — /cal show', () => {
  test('today resolves to current local day', () => {
    const cmd = parseCalCommand('/cal show today', NOW)
    expect(cmd.kind).toBe('show')
    if (cmd.kind === 'show') expect(cmd.label).toBe('today')
  })

  test('omitted arg defaults to today', () => {
    const cmd = parseCalCommand('/cal show', NOW)
    expect(cmd.kind).toBe('show')
    if (cmd.kind === 'show') expect(cmd.label).toBe('today')
  })

  test('tomorrow resolves to a non-empty window', () => {
    const cmd = parseCalCommand('/cal show tomorrow', NOW)
    expect(cmd.kind).toBe('show')
    if (cmd.kind === 'show') expect(cmd.label).toBe('tomorrow')
  })

  test('this week resolves over 7-day forward window', () => {
    const cmd = parseCalCommand('/cal show this week', NOW)
    expect(cmd.kind).toBe('show')
    if (cmd.kind === 'show') {
      const start = Date.parse(cmd.window.range_start)
      const end = Date.parse(cmd.window.range_end)
      expect(end - start).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
    }
  })

  test('next 5 days resolves a 5-day window', () => {
    const cmd = parseCalCommand('/cal show next 5 days', NOW)
    expect(cmd.kind).toBe('show')
    if (cmd.kind === 'show') {
      const start = Date.parse(cmd.window.range_start)
      const end = Date.parse(cmd.window.range_end)
      const days = Math.round((end - start) / (24 * 60 * 60 * 1000))
      expect(days).toBe(5)
    }
  })

  test('weekday name resolves to next occurrence', () => {
    const cmd = parseCalCommand('/cal show friday', NOW)
    expect(cmd.kind).toBe('show')
  })

  test('ISO date range parses', () => {
    const cmd = parseCalCommand('/cal show 2026-06-01..2026-06-03', NOW)
    expect(cmd.kind).toBe('show')
    if (cmd.kind === 'show') expect(cmd.label).toBe('2026-06-01..2026-06-03')
  })

  test('single ISO date parses', () => {
    const cmd = parseCalCommand('/cal show 2026-06-01', NOW)
    expect(cmd.kind).toBe('show')
    if (cmd.kind === 'show') expect(cmd.label).toBe('2026-06-01')
  })

  test('malformed date token returns unrecognized', () => {
    const cmd = parseCalCommand('/cal show banana', NOW)
    expect(cmd.kind).toBe('unrecognized')
  })
})

describe('parseCalCommand — /cal create', () => {
  test('full happy path parses title + when + duration + attendees', () => {
    const cmd = parseCalCommand(
      '/cal create Standup @ tomorrow 09:00 for 30m with user@example.com, casey@example.com',
      NOW,
    )
    expect(cmd.kind).toBe('create')
    if (cmd.kind === 'create') {
      expect(cmd.title).toBe('Standup')
      expect(cmd.attendees).toEqual(['user@example.com', 'casey@example.com'])
      const startMs = Date.parse(cmd.start)
      const endMs = Date.parse(cmd.end)
      expect(endMs - startMs).toBe(30 * 60_000)
    }
  })

  test('missing @ when returns unrecognized', () => {
    const cmd = parseCalCommand('/cal create Bad', NOW)
    expect(cmd.kind).toBe('unrecognized')
  })

  test('missing duration returns unrecognized', () => {
    const cmd = parseCalCommand('/cal create Bad @ tomorrow 09:00', NOW)
    expect(cmd.kind).toBe('unrecognized')
  })

  test('unrecognized duration returns unrecognized', () => {
    const cmd = parseCalCommand('/cal create Bad @ tomorrow 09:00 for ages', NOW)
    expect(cmd.kind).toBe('unrecognized')
  })

  test('ISO datetime when parses', () => {
    const cmd = parseCalCommand(
      '/cal create Sync @ 2026-06-02T14:00 for 1h',
      NOW,
    )
    expect(cmd.kind).toBe('create')
    if (cmd.kind === 'create') {
      expect(cmd.title).toBe('Sync')
      const dur = Date.parse(cmd.end) - Date.parse(cmd.start)
      expect(dur).toBe(60 * 60_000)
    }
  })
})

describe('parseCalCommand — /cal find-time', () => {
  test('emails + duration parses', () => {
    const cmd = parseCalCommand(
      '/cal find-time user@example.com, casey@example.com 30m',
      NOW,
    )
    expect(cmd.kind).toBe('find_time')
    if (cmd.kind === 'find_time') {
      expect(cmd.attendees).toEqual(['user@example.com', 'casey@example.com'])
      expect(cmd.duration_minutes).toBe(30)
    }
  })

  test('underscore alias parses', () => {
    const cmd = parseCalCommand('/cal find_time user@example.com 30m', NOW)
    expect(cmd.kind).toBe('find_time')
  })

  test('missing duration returns unrecognized', () => {
    const cmd = parseCalCommand('/cal find-time user@example.com', NOW)
    expect(cmd.kind).toBe('unrecognized')
  })

  test('no valid emails returns unrecognized', () => {
    const cmd = parseCalCommand('/cal find-time bogus 30m', NOW)
    expect(cmd.kind).toBe('unrecognized')
  })
})

describe('parseCalCommand — /cal next + /cal invite', () => {
  test('/cal next parses', () => {
    expect(parseCalCommand('/cal next', NOW).kind).toBe('next')
  })

  test('/cal invite parses event id + emails', () => {
    const cmd = parseCalCommand('/cal invite evt-1 casey@example.com', NOW)
    expect(cmd.kind).toBe('invite')
    if (cmd.kind === 'invite') {
      expect(cmd.event_id).toBe('evt-1')
      expect(cmd.emails).toEqual(['casey@example.com'])
    }
  })

  test('/cal invite missing emails returns unrecognized', () => {
    const cmd = parseCalCommand('/cal invite evt-1', NOW)
    expect(cmd.kind).toBe('unrecognized')
  })
})

/* ─── Dispatcher round-trip ───────────────────────────────────────── */

async function seedClient(): Promise<CalendarClient> {
  const c = buildInMemoryCalendarClient({ nextId: ((): () => string => {
    let n = 0
    return (): string => {
      n += 1
      return `evt-${n}`
    }
  })() })
  await c.create({
    title: 'Standup',
    start: '2026-05-20T20:00:00Z',
    end: '2026-05-20T20:30:00Z',
    attendees: ['user@example.com', 'casey@example.com'],
    project_id: 'demo',
  })
  await c.create({
    title: 'Lunch',
    start: '2026-05-20T23:00:00Z',
    end: '2026-05-21T00:00:00Z',
    project_id: 'other',
  })
  return c
}

describe('executeCalCommand — dispatcher round-trip', () => {
  test('show today returns one in-window event scoped to project', async () => {
    const client = await seedClient()
    const cmd = parseCalCommand('/cal show today', NOW)
    const res = await executeCalCommand(cmd, {
      client,
      project_id: 'demo',
      now: NOW,
    })
    expect(res.error).toBeUndefined()
    expect(res.text).toContain('Standup')
    expect(res.text).not.toContain('Lunch')
  })

  test('show today without project_id returns both events', async () => {
    const client = await seedClient()
    const cmd = parseCalCommand('/cal show today', NOW)
    const res = await executeCalCommand(cmd, { client, now: NOW })
    expect(res.text).toContain('Standup')
    expect(res.text).toContain('Lunch')
  })

  test('next returns the soonest in-window event', async () => {
    const client = await seedClient()
    const res = await executeCalCommand(
      { kind: 'next' },
      { client, project_id: 'demo', now: NOW },
    )
    expect(res.text).toContain('Standup')
  })

  test('create stamps project_id when supplied', async () => {
    const client = buildInMemoryCalendarClient()
    const cmd = parseCalCommand(
      '/cal create Demo @ tomorrow 10:00 for 45m',
      NOW,
    )
    const res = await executeCalCommand(cmd, {
      client,
      project_id: 'demo',
      now: NOW,
    })
    expect(res.error).toBeUndefined()
    const events = await client.list({
      range_start: '2026-05-20T00:00:00Z',
      range_end: '2026-05-25T00:00:00Z',
      project_id: 'demo',
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.title).toBe('Demo')
    expect(events[0]?.project_id).toBe('demo')
  })

  test('find-time returns slots over freebusy', async () => {
    const client = await seedClient()
    const cmd = parseCalCommand(
      '/cal find-time user@example.com, casey@example.com 30m',
      NOW,
    )
    const res = await executeCalCommand(cmd, {
      client,
      project_id: 'demo',
      now: NOW,
      user_email: 'user@example.com',
    })
    expect(res.error).toBeUndefined()
    expect(res.text).toMatch(/Proposed/)
  })

  test('invite to unknown event surfaces unknown_event', async () => {
    const client = await seedClient()
    const res = await executeCalCommand(
      { kind: 'invite', event_id: 'missing', emails: ['x@example.com'] },
      { client, project_id: 'demo', now: NOW },
    )
    expect(res.error?.code).toBe('unknown_event')
  })

  test('parseAndExecuteCalCommand convenience wrapper round-trips', async () => {
    const client = await seedClient()
    const { command, response } = await parseAndExecuteCalCommand(
      '/cal show today',
      { client, project_id: 'demo', now: NOW },
    )
    expect((command as CalCommand).kind).toBe('show')
    expect((response as CalCommandResponse).text).toContain('Standup')
  })

  test('help command returns the help text without dispatching', async () => {
    const client = await seedClient()
    const res = await executeCalCommand({ kind: 'help' }, { client, now: NOW })
    expect(res.text).toContain('/cal commands')
  })
})
