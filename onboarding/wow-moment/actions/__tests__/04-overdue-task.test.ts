/**
 * Action 4 — overdue task surface tests.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import action04 from '../04-overdue-task.ts'
import { buildContext, makeFixture, teardown, type TestFixture } from '../../__tests__/test-helpers.ts'
import type { ImportResult } from '../../../history-import/types.ts'

let fix: TestFixture
const NOW = 1_700_000_000_000

beforeEach(() => {
  fix = makeFixture()
})
afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
})

function emptyImport(): ImportResult {
  return {
    entities: [],
    topics: [],
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {},
    facts: {},
  }
}

describe('action 04-overdue-task', () => {
  test('does not fire when no proposed_tasks present', () => {
    const ctx = buildContext(fix, { now: () => NOW })
    expect(action04.triggerCondition(ctx)).toBe(false)
  })

  test('does not fire when no due_at < now', () => {
    const ir = emptyImport()
    ir.proposed_tasks = [
      { title: 'future task', due_at: NOW + 100_000 },
      { title: 'no due_at' },
    ]
    const ctx = buildContext(fix, { import_result: ir, now: () => NOW })
    expect(action04.triggerCondition(ctx)).toBe(false)
  })

  test('fires + picks the most-overdue task', async () => {
    const ir = emptyImport()
    ir.proposed_tasks = [
      { title: 'mild overdue', due_at: NOW - 24 * 3600_000 },
      { title: 'most overdue', due_at: NOW - 7 * 24 * 3600_000, priority_hint: 'P0' },
      { title: 'future task', due_at: NOW + 24 * 3600_000 },
    ]
    const ctx = buildContext(fix, { import_result: ir, now: () => NOW })
    const result = await action04.run(ctx)
    expect(result.fired).toBe(true)
    expect(result.reason).toBe('surfaced')
    expect(fix.channelCalls.prompts.length).toBe(1)
    const promptBody = fix.channelCalls.prompts[0]!.prompt.body
    expect(promptBody).toContain('most overdue')
    // Telemetry payload carries hashed title (16 hex chars actually — sha256 first 12).
    expect(typeof result.redacted_payload?.task_title_hash).toBe('string')
    expect((result.redacted_payload?.task_title_hash as string).length).toBe(12)
    expect(result.redacted_payload?.priority_hint).toBe('P0')
    expect(result.redacted_payload?.days_overdue).toBe(7)
    // Telemetry must NOT carry the raw title.
    expect(JSON.stringify(result.redacted_payload)).not.toContain('most overdue')
  })

  test('options are will_handle / snoozed / dropped', async () => {
    const ir = emptyImport()
    ir.proposed_tasks = [{ title: 'foo', due_at: NOW - 1 }]
    const ctx = buildContext(fix, { import_result: ir, now: () => NOW })
    await action04.run(ctx)
    const opts = fix.channelCalls.prompts[0]!.prompt.options.map((o) => o.value)
    expect(opts).toEqual(['will_handle', 'snoozed', 'dropped'])
  })

  test('engagement decoder', () => {
    expect(action04.decodeEngagement?.('will_handle')).toBe('will_handle')
    expect(action04.decodeEngagement?.('snoozed')).toBe('snoozed')
    expect(action04.decodeEngagement?.('dropped')).toBe('dropped')
    expect(action04.decodeEngagement?.('opened')).toBeNull()
  })
})
