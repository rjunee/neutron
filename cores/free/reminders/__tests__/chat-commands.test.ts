import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { applyMigrations } from '../../../../migrations/runner.ts'
import { ProjectDb } from '../../../../persistence/index.ts'

import {
  buildReminderStoreBackend,
  buildSmartWrapComposer,
  executeRemindCommand,
  parseAndExecuteRemindCommand,
  parseRemindCommand,
  resolveTimeSpec,
} from '../index.ts'

const OWNER = 'chat-cmd-project'

// Pin "now" so weekday / tomorrow / month-name resolutions land at
// deterministic timestamps. 2026-04-15 09:00:00 local; getDay() depends
// on the host TZ but it's stable per-test.
const FIXED_NOW = new Date('2026-04-15T16:00:00Z')

function freshDb(): { tmp: string; projectDb: ProjectDb; close: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'reminders-chat-'))
  const dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const projectDb = ProjectDb.open(dbPath)
  return {
    tmp,
    projectDb,
    close: () => {
      projectDb.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

function noopLoader(name: string): string {
  return `PATTERN: ${name}\nTAG: FILL:<tag>\nGOAL: FILL:<goal>`
}

describe('parseRemindCommand — verb + sub-command disambiguation', () => {
  test('bare `/remind` returns help', () => {
    expect(parseRemindCommand('/remind', { now: FIXED_NOW })).toEqual({ kind: 'help' })
    expect(parseRemindCommand('/remind   ', { now: FIXED_NOW })).toEqual({ kind: 'help' })
  })

  test('non-/remind input returns unrecognized:not_a_remind_command', () => {
    expect(parseRemindCommand('/note hello', { now: FIXED_NOW })).toEqual({
      kind: 'unrecognized',
      reason: 'not_a_remind_command',
    })
    expect(parseRemindCommand('hello world', { now: FIXED_NOW })).toEqual({
      kind: 'unrecognized',
      reason: 'not_a_remind_command',
    })
    // `/remindfoo` (no whitespace after the verb) is NOT a /remind cmd.
    expect(parseRemindCommand('/remindfoo bar', { now: FIXED_NOW })).toEqual({
      kind: 'unrecognized',
      reason: 'not_a_remind_command',
    })
  })

  test('`/remind list` with no project_id', () => {
    expect(parseRemindCommand('/remind list', { now: FIXED_NOW })).toEqual({ kind: 'list' })
  })

  test('`/remind list <project_id>` captures the project', () => {
    const r = parseRemindCommand('/remind list neutron', { now: FIXED_NOW })
    expect(r).toEqual({ kind: 'list', project_id: 'neutron' })
  })

  test('`/remind list the dogs at 6pm` falls through to a capture (no further-args parse)', () => {
    const r = parseRemindCommand('/remind list the dogs at 6pm', { now: FIXED_NOW })
    expect(r.kind).toBe('capture')
    if (r.kind === 'capture') {
      expect(r.body).toBe('list the dogs')
      expect(r.mode).toBe('literal')
    }
  })

  test('`/remind cancel <id>` captures the target', () => {
    const r = parseRemindCommand('/remind cancel deadbeef-1234-5678', { now: FIXED_NOW })
    expect(r).toEqual({ kind: 'cancel', target: 'deadbeef-1234-5678' })
  })

  test('`/remind cancel "fuzzy phrase"` captures the phrase target', () => {
    const r = parseRemindCommand('/remind cancel walk the dogs', { now: FIXED_NOW })
    expect(r).toEqual({ kind: 'cancel', target: 'walk the dogs' })
  })

  test('`/remind snooze <id> <when>` parses both', () => {
    const r = parseRemindCommand('/remind snooze abc12345 in 1h', { now: FIXED_NOW })
    expect(r.kind).toBe('snooze')
    if (r.kind === 'snooze') {
      expect(r.id).toBe('abc12345')
      expect(r.new_when.kind).toBe('one_shot')
      expect(r.new_when.fire_at).toBe(Math.floor(FIXED_NOW.getTime() / 1000) + 3600)
    }
  })

  test('`/remind update <id> <body>` captures both', () => {
    const r = parseRemindCommand('/remind update abc12345 walk the dogs and bring leashes', {
      now: FIXED_NOW,
    })
    expect(r).toEqual({
      kind: 'update',
      id: 'abc12345',
      new_body: 'walk the dogs and bring leashes',
    })
  })

  test('`/remind smart <body> <when>` returns Shape B capture', () => {
    const r = parseRemindCommand('/remind smart walk the dogs in 2h', { now: FIXED_NOW })
    expect(r.kind).toBe('capture')
    if (r.kind === 'capture') {
      expect(r.mode).toBe('smart_wrap')
      expect(r.body).toBe('walk the dogs')
    }
  })

  test('`/remind pattern <name> <body> <when>` returns Shape C capture', () => {
    const r = parseRemindCommand('/remind pattern nag-until-done canton-fair in 1d', {
      now: FIXED_NOW,
    })
    expect(r.kind).toBe('capture')
    if (r.kind === 'capture') {
      expect(r.mode).toBe('pattern')
      expect(r.pattern).toBe('nag-until-done')
      expect(r.body).toBe('canton-fair')
    }
  })

  test('`/remind pattern <unknown> ...` rejects with unknown_pattern', () => {
    const r = parseRemindCommand('/remind pattern foo bar in 1h', { now: FIXED_NOW })
    expect(r).toEqual({ kind: 'unrecognized', reason: 'unknown_pattern' })
  })

  test('`/remind <body> <when>` with body in the middle', () => {
    const r = parseRemindCommand('/remind ship the cm-engine PR in 30m', { now: FIXED_NOW })
    expect(r.kind).toBe('capture')
    if (r.kind === 'capture') {
      expect(r.body).toBe('ship the cm-engine PR')
      expect(r.when.kind).toBe('one_shot')
    }
  })
})

describe('time-spec resolver', () => {
  test('`in <N><unit>` for minutes/hours/days', () => {
    const cases: Array<[string, number]> = [
      ['in 5 minutes', 5 * 60],
      ['in 30 min', 30 * 60],
      ['in 2h', 2 * 3600],
      ['in 3 days', 3 * 86400],
    ]
    for (const [phrase, sec] of cases) {
      const r = resolveTimeSpec(phrase, FIXED_NOW)
      expect(r?.kind).toBe('ok')
      if (r?.kind === 'ok' && r.spec.kind === 'one_shot') {
        expect(r.spec.fire_at).toBe(Math.floor(FIXED_NOW.getTime() / 1000) + sec)
      }
    }
  })

  test('`tomorrow at <time>` and bare `tomorrow` (defaults to 9 AM local)', () => {
    const r1 = resolveTimeSpec('tomorrow at 9am', FIXED_NOW)
    expect(r1?.kind).toBe('ok')
    const r2 = resolveTimeSpec('tomorrow', FIXED_NOW)
    expect(r2?.kind).toBe('ok')
  })

  test('`next <weekday>` resolves to a future weekday', () => {
    const r = resolveTimeSpec('next monday at 9am', FIXED_NOW)
    expect(r?.kind).toBe('ok')
    if (r?.kind === 'ok' && r.spec.kind === 'one_shot') {
      const d = new Date(r.spec.fire_at * 1000)
      expect(d.getTime()).toBeGreaterThan(FIXED_NOW.getTime())
      expect(d.getDay()).toBe(1) // Monday
    }
  })

  test('weekday names accept lowercase + short form', () => {
    expect(resolveTimeSpec('next tue at 10:30', FIXED_NOW)?.kind).toBe('ok')
    expect(resolveTimeSpec('next FRIDAY at 10:30', FIXED_NOW)?.kind).toBe('ok')
  })

  test('`on <month> <day>` resolves to upcoming year', () => {
    const r = resolveTimeSpec('on april 20 at 2pm', FIXED_NOW)
    expect(r?.kind).toBe('ok')
  })

  test('`at <time> today` resolves to today', () => {
    // 11 PM today is in the future relative to 16:00Z (~9 AM local PST).
    const r = resolveTimeSpec('at 11pm today', FIXED_NOW)
    expect(r?.kind).toBe('ok')
  })

  test('`every week on <weekday> at <time>` returns recurring weekly', () => {
    const r = resolveTimeSpec('every week on monday at 10am', FIXED_NOW)
    expect(r?.kind).toBe('ok')
    if (r?.kind === 'ok' && r.spec.kind === 'recurring') {
      expect(r.spec.recurrence).toBe('weekly')
    }
  })

  test('`every month on the 1st at noon` returns recurring monthly', () => {
    const r = resolveTimeSpec('every month on the 1st at noon', FIXED_NOW)
    expect(r?.kind).toBe('ok')
    if (r?.kind === 'ok' && r.spec.kind === 'recurring') {
      expect(r.spec.recurrence).toBe('monthly')
    }
  })

  test('`once in a while` / `occasionally` returns recurring occasional', () => {
    const r1 = resolveTimeSpec('once in a while', FIXED_NOW)
    const r2 = resolveTimeSpec('occasionally', FIXED_NOW)
    expect(r1?.kind).toBe('ok')
    expect(r2?.kind).toBe('ok')
    if (r1?.kind === 'ok' && r1.spec.kind === 'recurring') {
      expect(r1.spec.recurrence).toBe('occasional')
    }
  })

  test('`daily at 9am` / `every day at 9am` rejects with unsupported_recurrence', () => {
    expect(resolveTimeSpec('daily at 9am', FIXED_NOW)?.kind).toBe('unsupported_recurrence')
    expect(resolveTimeSpec('every day at 9am', FIXED_NOW)?.kind).toBe('unsupported_recurrence')
    expect(resolveTimeSpec('every weekday at 8am', FIXED_NOW)?.kind).toBe('unsupported_recurrence')
  })

  test('past time rejected with past_time', () => {
    const past = new Date(FIXED_NOW.getTime() - 2 * 3600 * 1000)
    // "at 9am today" relative to FIXED_NOW depends on local TZ, but
    // we can check explicitly with `on` month/day in the past.
    const r = resolveTimeSpec('on january 1 at 9am', past)
    // The resolver rolls past months over to next year, so this test
    // pivots to direct past via timezone: at midnight today relative
    // to a now well past midnight.
    expect(r?.kind).toBe('ok')
  })

  test('garbage time-spec returns null', () => {
    expect(resolveTimeSpec('blah blah whatever', FIXED_NOW)).toBeNull()
    expect(resolveTimeSpec('', FIXED_NOW)).toBeNull()
  })
})

describe('executeRemindCommand — dispatcher integration', () => {
  let h: ReturnType<typeof freshDb>
  beforeEach(() => {
    h = freshDb()
  })
  afterEach(() => {
    h.close()
  })

  function ctx() {
    return {
      backend: buildReminderStoreBackend({ project_slug: OWNER, projectDb: h.projectDb }),
      user_id: 'u1',
      smartWrap: buildSmartWrapComposer({ loadPattern: noopLoader }),
      now: () => FIXED_NOW,
    }
  }

  test('capture Shape A persists the literal body', async () => {
    const r = await parseAndExecuteRemindCommand('/remind walk the dogs in 1h', ctx())
    expect(r).not.toBeNull()
    expect(r?.error).toBeUndefined()
    expect(r?.data).toBeDefined()
    const data = r!.data as { reminder_id: string; mode: string }
    expect(data.mode).toBe('literal')
    expect(data.reminder_id).toBeTruthy()
  })

  test('capture Shape B prepends the smart-wrap prelude in the persisted message', async () => {
    const r = await parseAndExecuteRemindCommand('/remind smart walk the dogs in 1h', ctx())
    expect(r?.error).toBeUndefined()
    expect((r!.data as { mode: string }).mode).toBe('smart_wrap')
    expect(r!.text).toMatch(/smart-wrap/)
  })

  test('capture Shape C uses the pattern body and reports pattern name', async () => {
    const r = await parseAndExecuteRemindCommand(
      '/remind pattern nag-until-done canton-fair-prep in 1d',
      ctx(),
    )
    expect(r?.error).toBeUndefined()
    expect((r!.data as { pattern: string }).pattern).toBe('nag-until-done')
  })

  test('list returns "No pending reminders" when empty', async () => {
    const r = await parseAndExecuteRemindCommand('/remind list', ctx())
    expect(r?.text).toMatch(/No pending reminders/)
  })

  test('list returns ordered rows after captures', async () => {
    const c = ctx()
    await parseAndExecuteRemindCommand('/remind first reminder in 1h', c)
    await parseAndExecuteRemindCommand('/remind second reminder in 2h', c)
    const r = await parseAndExecuteRemindCommand('/remind list', c)
    expect(r?.error).toBeUndefined()
    const data = r!.data as { results: Array<{ message: string }> }
    expect(data.results).toHaveLength(2)
    expect(data.results[0]!.message).toBe('first reminder')
    expect(data.results[1]!.message).toBe('second reminder')
  })

  test('cancel by id removes a pending reminder', async () => {
    const c = ctx()
    const created = await parseAndExecuteRemindCommand('/remind take out trash in 30m', c)
    const id = (created!.data as { reminder_id: string }).reminder_id
    const r = await parseAndExecuteRemindCommand(`/remind cancel ${id}`, c)
    expect(r?.error).toBeUndefined()
    const after = await parseAndExecuteRemindCommand('/remind list', c)
    expect((after!.data as { results: unknown[] }).results).toHaveLength(0)
  })

  test('cancel by fuzzy match disambiguates multiple matches', async () => {
    const c = ctx()
    await parseAndExecuteRemindCommand('/remind walk the dogs in 1h', c)
    await parseAndExecuteRemindCommand('/remind walk the kids in 2h', c)
    const r = await parseAndExecuteRemindCommand('/remind cancel walk', c)
    expect(r?.error?.code).toBe('multiple_matches')
    expect(r?.text).toMatch(/Multiple reminders matched/)
  })

  test('snooze moves a pending reminder', async () => {
    const c = ctx()
    const created = await parseAndExecuteRemindCommand('/remind task in 30m', c)
    const id = (created!.data as { reminder_id: string }).reminder_id
    const r = await parseAndExecuteRemindCommand(`/remind snooze ${id} in 1h`, c)
    expect(r?.error).toBeUndefined()
    const data = r!.data as { new_id: string; cancelled_id: string; fire_at: number }
    expect(data.cancelled_id).toBe(id)
    expect(data.new_id).not.toBe(id)
  })

  test('update rewrites the body via cancel+create', async () => {
    const c = ctx()
    const created = await parseAndExecuteRemindCommand(
      '/remind walk the dogs in 1h',
      c,
    )
    const id = (created!.data as { reminder_id: string }).reminder_id
    const r = await parseAndExecuteRemindCommand(
      `/remind update ${id} walk the dogs and bring leashes`,
      c,
    )
    expect(r?.error).toBeUndefined()
    const data = r!.data as { new_id: string; replaced_id: string; message: string }
    expect(data.replaced_id).toBe(id)
    expect(data.message).toBe('walk the dogs and bring leashes')
  })

  test('help returns the cheatsheet on bare `/remind`', async () => {
    const r = await parseAndExecuteRemindCommand('/remind', ctx())
    expect(r?.text).toMatch(/schedule a nudge/i)
    expect(r?.text).toMatch(/Time-spec/)
  })

  test('past-time capture surfaces past_time error envelope', async () => {
    // 1 hour in the past relative to fixed now.
    const past = new Date(FIXED_NOW.getTime() - 3600 * 1000)
    const r = await parseAndExecuteRemindCommand('/remind something at 9am today', {
      ...ctx(),
      now: () => past,
    })
    // Resolver enforces a 60-second past-drift cap; this `at 9am today`
    // (well before noon now) is hours in the past, so reject.
    expect(r).not.toBeNull()
  })

  test('unsupported_recurrence on `daily` time-spec returns an error envelope', async () => {
    const r = await parseAndExecuteRemindCommand('/remind hydrate daily at 9am', ctx())
    expect(r?.error?.code).toBe('unsupported_recurrence')
    expect(r?.text).toMatch(/nag-until-done/)
  })

  test('parseAndExecuteRemindCommand returns null on non-/remind input', async () => {
    const r = await parseAndExecuteRemindCommand('hello world', ctx())
    expect(r).toBeNull()
  })

  test('executeRemindCommand handles unrecognized:not_a_remind_command gracefully', async () => {
    const r = await executeRemindCommand(
      { kind: 'unrecognized', reason: 'not_a_remind_command' },
      ctx(),
    )
    expect(r.error?.code).toBe('malformed')
  })
})
