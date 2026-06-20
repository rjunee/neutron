/**
 * Action 2 — lifestyle reminders tests.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import action02 from '../02-lifestyle-reminders.ts'
import { buildContext, makeFixture, teardown, type TestFixture } from '../../__tests__/test-helpers.ts'
import type { RitualEntry } from '../../action-types.ts'

let fix: TestFixture

beforeEach(() => {
  fix = makeFixture()
})
afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
})

describe('action 02-lifestyle-reminders', () => {
  test('triggers iff at least one valid morning|evening|weekly ritual present', () => {
    expect(action02.triggerCondition(buildContext(fix, { rituals: [] }))).toBe(false)
    const ritual: RitualEntry = {
      kind: 'morning',
      label: '5-min sit',
      time_of_day: '06:30',
    }
    expect(action02.triggerCondition(buildContext(fix, { rituals: [ritual] }))).toBe(true)
  })

  test('rejects rituals with malformed time_of_day', () => {
    const bad: RitualEntry[] = [
      { kind: 'morning', label: 'foo', time_of_day: 'tomorrow morning' as string },
    ]
    expect(action02.triggerCondition(buildContext(fix, { rituals: bad }))).toBe(false)
  })

  test('inserts up to 3 reminder rows + emits A/B/C prompt', async () => {
    const rituals: RitualEntry[] = [
      { kind: 'morning', label: 'meditation', time_of_day: '06:30' },
      { kind: 'evening', label: 'journal', time_of_day: '21:00' },
      { kind: 'weekly', label: 'review', time_of_day: '17:00' },
      { kind: 'morning', label: 'EXTRA', time_of_day: '07:00' }, // 4th — must be capped at 3
    ]
    const ctx = buildContext(fix, { rituals })
    const result = await action02.run(ctx)
    expect(result.fired).toBe(true)
    expect(result.reason).toBe('reminders_inserted')
    expect(result.redacted_payload?.count).toBe(3)
    expect(fix.channelCalls.prompts.length).toBe(1)
    const opts = fix.channelCalls.prompts[0]!.prompt.options.map((o) => o.value)
    expect(opts).toEqual(['kept', 'tweaked', 'skipped'])
    const stored = fix.reminders.listPending('t1')
    expect(stored.length).toBe(3)
  })

  test('telemetry payload carries kinds (no raw labels)', async () => {
    const rituals: RitualEntry[] = [
      { kind: 'morning', label: 'private body', time_of_day: '06:30' },
      { kind: 'evening', label: 'journaling secret thoughts', time_of_day: '21:00' },
    ]
    const ctx = buildContext(fix, { rituals })
    const result = await action02.run(ctx)
    expect(result.redacted_payload?.kinds).toEqual(['morning', 'evening'])
    // Telemetry must NOT carry the raw label content.
    const json = JSON.stringify(result.redacted_payload)
    expect(json).not.toContain('private body')
    expect(json).not.toContain('journaling secret thoughts')
  })

  test('engagement decoder maps kept/tweaked/skipped', () => {
    expect(action02.decodeEngagement?.('kept')).toBe('kept')
    expect(action02.decodeEngagement?.('tweaked')).toBe('tweaked')
    expect(action02.decodeEngagement?.('skipped')).toBe('skipped')
    expect(action02.decodeEngagement?.('nope')).toBeNull()
  })
})
