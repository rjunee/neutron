/**
 * Action 06 — interest-check-in (P2 v2) tests.
 *
 * Per docs/plans/P2-onboarding-v2.md § 5.2 / § 9.4. Replaces v1's
 * dharma-reframe action; surfaces a non-work interest, schedules a
 * recurring nudge, fires one immediate plan/snooze prompt.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import action06 from '../06-interest-check-in.ts'
import { buildContext, makeFixture, teardown, type TestFixture } from '../../__tests__/test-helpers.ts'
import type { Reminder } from '../../../../reminders/store.ts'

let fix: TestFixture

beforeEach(() => {
  fix = makeFixture()
})
afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
})

describe('action 06-interest-check-in (P2 v2)', () => {
  test('triggers when phase_state.non_work_interests has ≥1 entry', () => {
    const ctx = buildContext(fix, {
      interview: {
        phase_state_json: {
          non_work_interests: [{ name: 'climbing', cadence_hint: 'weekly' }],
        },
      },
    })
    expect(action06.triggerCondition(ctx)).toBe(true)
  })

  test('does not trigger when non_work_interests is missing or empty', () => {
    const ctxEmpty = buildContext(fix, {
      interview: { phase_state_json: { non_work_interests: [] } },
    })
    expect(action06.triggerCondition(ctxEmpty)).toBe(false)

    const ctxMissing = buildContext(fix, { interview: { phase_state_json: {} } })
    expect(action06.triggerCondition(ctxMissing)).toBe(false)
  })

  test('plain string entries are accepted (legacy shape)', () => {
    const ctx = buildContext(fix, {
      interview: {
        phase_state_json: { non_work_interests: ['painting', '  '] },
      },
    })
    expect(action06.triggerCondition(ctx)).toBe(true)
  })

  test('run: schedules a recurring reminder at the cadence-mapped offset; emits A/B prompt; hashes interest name', async () => {
    const ctx = buildContext(fix, {
      now: (): number => 1_700_000_000_000,
      interview: {
        phase_state_json: {
          non_work_interests: [{ name: 'climbing', cadence_hint: 'weekly' }],
        },
      },
    })
    const result = await action06.run(ctx)
    expect(result.fired).toBe(true)
    expect(result.reason).toBe('interest_check_scheduled')
    const payload = result.redacted_payload ?? {}
    expect(typeof payload['interest_name_hash']).toBe('string')
    expect((payload['interest_name_hash'] as string).length).toBe(16)
    expect(payload['cadence']).toBe('weekly')
    expect(payload['interest_count']).toBe(1)
    // Telemetry payload MUST NOT echo raw interest name.
    expect(JSON.stringify(payload)).not.toContain('climbing')

    // One recurring reminder row landed at +7d (weekly cadence).
    const stored = fix.reminders.listPending('t1')
    expect(stored.length).toBe(1)
    const r: Reminder = stored[0]!
    expect(r.recurrence).toBe('weekly')
    const expected = Math.floor(1_700_000_000_000 / 1000) + 7 * 24 * 60 * 60
    expect(r.fire_at).toBe(expected)

    // Prompt emitted to the channel with plan/snoozed options.
    expect(fix.channelCalls.prompts.length).toBe(1)
    const opts = fix.channelCalls.prompts[0]!.prompt.options.map((o) => o.value)
    expect(opts).toEqual(['plan', 'snoozed'])
  })

  test('cadence default is monthly when no hint is given', async () => {
    const ctx = buildContext(fix, {
      now: (): number => 1_700_000_000_000,
      interview: { phase_state_json: { non_work_interests: [{ name: 'gardening' }] } },
    })
    await action06.run(ctx)
    const stored = fix.reminders.listPending('t1')
    expect(stored[0]?.recurrence).toBe('monthly')
    const expected = Math.floor(1_700_000_000_000 / 1000) + 30 * 24 * 60 * 60
    expect(stored[0]?.fire_at).toBe(expected)
  })

  test('engagement decoder maps plan→will_handle and snoozed→snoozed', () => {
    expect(action06.decodeEngagement?.('plan')).toBe('will_handle')
    expect(action06.decodeEngagement?.('snoozed')).toBe('snoozed')
    expect(action06.decodeEngagement?.('unknown')).toBe(null)
  })

  test('prefers interests with cadence_hint over those without', async () => {
    const ctx = buildContext(fix, {
      now: (): number => 1_700_000_000_000,
      interview: {
        phase_state_json: {
          non_work_interests: [
            { name: 'gardening' },
            { name: 'climbing', cadence_hint: 'weekly' },
          ],
        },
      },
    })
    await action06.run(ctx)
    const stored = fix.reminders.listPending('t1')
    expect(stored.length).toBe(1)
    expect(stored[0]?.recurrence).toBe('weekly')
  })
})
