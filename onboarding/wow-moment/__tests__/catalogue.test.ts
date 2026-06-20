/**
 * Catalogue — registry shape + the v2 always-fire / candidate split.
 *
 * Per docs/plans/P2-onboarding-v2.md § 5.1 + § 5.4. v1's flat 7-id
 * DISPATCH_ORDER is replaced with ALWAYS_FIRE_FIRST + CANDIDATE_IDS +
 * ALWAYS_FIRE_LAST so the dispatcher can interleave the LLM picker.
 */

import { describe, expect, test } from 'bun:test'
import {
  ALWAYS_FIRE_FIRST,
  ALWAYS_FIRE_LAST,
  CANDIDATE_IDS,
  getActionModule,
  listDispatchOrder,
} from '../catalogue.ts'
import { ALL_WOW_ACTION_IDS, type WowActionId } from '../telemetry.ts'

describe('catalogue (P2 v2)', () => {
  test('ALWAYS_FIRE_FIRST is 07-overnight-pass; ALWAYS_FIRE_LAST is 01-first-week-brief', () => {
    expect(ALWAYS_FIRE_FIRST).toBe('07-overnight-pass')
    expect(ALWAYS_FIRE_LAST).toBe('01-first-week-brief')
  })

  test('CANDIDATE_IDS is the 5-id LLM-picker set (02, 03, 04, 05, 06-interest-check-in)', () => {
    expect(CANDIDATE_IDS).toEqual([
      '02-lifestyle-reminders',
      '03-project-shells',
      '04-overdue-task',
      '05-followup-email-draft',
      '06-interest-check-in',
    ])
  })

  test('action 06 is interest-check-in, NOT dharma-reframe (v2 redesign)', () => {
    expect(CANDIDATE_IDS).toContain('06-interest-check-in')
    // The dharma-reframe id is REMOVED from the catalogue + telemetry
    // type union; reference it via `as WowActionId` to assert that it is
    // no longer registered.
    expect(() => getActionModule('06-dharma-reframe-reminder' as unknown as WowActionId)).toThrow()
  })

  test('every action_id in ALL_WOW_ACTION_IDS has a module', () => {
    for (const id of ALL_WOW_ACTION_IDS) {
      const m = getActionModule(id)
      expect(m).toBeDefined()
      expect(m.action_id).toBe(id)
      expect(typeof m.triggerCondition).toBe('function')
      expect(typeof m.run).toBe('function')
    }
  })

  test('ALL_WOW_ACTION_IDS covers exactly the baseline + candidate set (7 ids)', () => {
    const expected = new Set<WowActionId>([
      ALWAYS_FIRE_FIRST,
      ALWAYS_FIRE_LAST,
      ...CANDIDATE_IDS,
    ])
    expect(ALL_WOW_ACTION_IDS.length).toBe(7)
    expect(new Set(ALL_WOW_ACTION_IDS).size).toBe(7)
    for (const id of ALL_WOW_ACTION_IDS) expect(expected.has(id)).toBe(true)
  })

  test('listDispatchOrder yields [first, ...picked, last] in order', () => {
    const picked: WowActionId[] = ['03-project-shells', '06-interest-check-in']
    const ordered = listDispatchOrder(picked)
    expect(ordered.length).toBe(picked.length + 2)
    expect(ordered[0]?.action_id).toBe(ALWAYS_FIRE_FIRST)
    expect(ordered[ordered.length - 1]?.action_id).toBe(ALWAYS_FIRE_LAST)
    for (let i = 0; i < picked.length; i++) {
      expect(ordered[i + 1]?.action_id).toBe(picked[i]!)
    }
  })

  test('getActionModule throws on unknown id', () => {
    expect(() => getActionModule('99-nope' as WowActionId)).toThrow()
  })
})
