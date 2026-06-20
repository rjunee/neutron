/**
 * Action 1 — first-week brief tests.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import action01 from '../01-first-week-brief.ts'
import { buildContext, makeFixture, teardown, type TestFixture } from '../../__tests__/test-helpers.ts'
import { OvernightQueueStore } from '../../../overnight/queue-store.ts'
import type { BriefSubstrate, WowActionContext } from '../../action-types.ts'

let fix: TestFixture

beforeEach(() => {
  fix = makeFixture()
})
afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
})

describe('action 01-first-week-brief', () => {
  test('always fires (no trigger gate)', () => {
    const ctx = buildContext(fix)
    expect(action01.triggerCondition(ctx)).toBe(true)
  })

  test('templated brief fires when no substrate wired', async () => {
    const ctx = buildContext(fix, {
      interview: { display_name: 'Casey', archetype_blend: ['Athena', 'Curie'] },
      captured_projects: [{ name: 'Acme' }, { name: 'Topline' }],
      rituals: [{ kind: 'morning', label: 'meditation', time_of_day: '06:30' }],
    })
    const result = await action01.run(ctx)
    expect(result.fired).toBe(true)
    expect(result.reason).toBe('delivered')
    expect(fix.channelCalls.texts.length).toBe(1)
    const sent = fix.channelCalls.texts[0]!
    expect(sent.body).toContain('Casey')
    expect(sent.body).toContain('Athena')
    expect(sent.body).toContain('meditation')
    expect(result.redacted_payload?.used_substrate).toBe(false)
  })

  test('substrate-wired path uses returned body + tokens_used', async () => {
    const substrate: BriefSubstrate = {
      async composeBrief() {
        return { body: 'A real LLM brief landed here.', tokens_used: 412 }
      },
    }
    const ctx = buildContext(fix, { substrate })
    const result = await action01.run(ctx)
    expect(result.fired).toBe(true)
    expect(fix.channelCalls.texts[0]!.body).toBe('A real LLM brief landed here.')
    expect(result.redacted_payload?.tokens_used).toBe(412)
    expect(result.redacted_payload?.used_substrate).toBe(true)
  })

  test('substrate throw bubbles up (action-runner handles retry)', async () => {
    const substrate: BriefSubstrate = {
      async composeBrief() {
        throw new Error('synthetic substrate error')
      },
    }
    const ctx = buildContext(fix, { substrate })
    let caught: unknown = null
    try {
      await action01.run(ctx)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('synthetic substrate error')
  })

  test('#309 fix #1 — when the user trimmed projects, the brief renders ONLY the kept set', async () => {
    // The owner asked to trim to 4 but the brief rendered all 9 because
    // mergeProjects re-added every import_result.proposed_projects entry.
    // When projects_confirmed === true, captured_projects IS the kept set
    // and the import merge must be skipped.
    const ctx = buildContext(fix, {
      interview: { phase_state_json: { user_first_name: 'Ryan' } },
      captured_projects: [{ name: 'Tabs' }, { name: 'Pristine' }],
      projects_confirmed: true,
      import_result: {
        entities: [],
        topics: [],
        proposed_projects: [
          { name: 'Tabs', rationale: '', suggested_topics: [] },
          { name: 'Pristine', rationale: '', suggested_topics: [] },
          { name: 'Dropped One', rationale: '', suggested_topics: [] },
          { name: 'Dropped Two', rationale: '', suggested_topics: [] },
        ],
        proposed_tasks: [],
        proposed_reminders: [],
        voice_signals: {},
        facts: {},
      },
    })
    await action01.run(ctx)
    const body = fix.channelCalls.texts[0]!.body
    expect(body).toContain('Projects on deck (2):')
    expect(body).toContain('Tabs')
    expect(body).toContain('Pristine')
    // The trimmed-away imported projects must NOT resurface.
    expect(body).not.toContain('Dropped One')
    expect(body).not.toContain('Dropped Two')
  })

  test('unconfirmed (legacy) path still dedupe-merges captured + imported projects', async () => {
    const ctx = buildContext(fix, {
      interview: { phase_state_json: { user_first_name: 'Ryan' } },
      captured_projects: [{ name: 'Tabs' }],
      // projects_confirmed omitted (undefined) — legacy/unconfirmed caller.
      import_result: {
        entities: [],
        topics: [],
        proposed_projects: [{ name: 'Imported', rationale: '', suggested_topics: [] }],
        proposed_tasks: [],
        proposed_reminders: [],
        voice_signals: {},
        facts: {},
      },
    })
    await action01.run(ctx)
    const body = fix.channelCalls.texts[0]!.body
    expect(body).toContain('Projects on deck (2):')
    expect(body).toContain('Tabs')
    expect(body).toContain('Imported')
  })

  test('truthful brief — empty overnight_queue offers instead of claiming queued work', async () => {
    // go-live brief-truthful (2026-06-20): the onboarding reality is an
    // EMPTY overnight_queue. The brief must state real projects and OFFER
    // overnight work / reminders, never assert scheduled/queued work.
    const ctx = buildContext(fix, {
      interview: { phase_state_json: { user_first_name: 'Ryan' } },
      captured_projects: [{ name: 'Tabs' }, { name: 'Pristine' }],
      projects_confirmed: true,
    })
    await action01.run(ctx)
    const body = fix.channelCalls.texts[0]!.body
    // Real projects are stated.
    expect(body).toContain('Tabs')
    expect(body).toContain('Pristine')
    // No fabricated scheduled/queued overnight claims.
    expect(body).not.toContain("I've queued these to work on overnight while you sleep:")
    expect(body).not.toContain('overnight pass at 7am tomorrow')
    expect(body.toLowerCase()).not.toContain("i've scheduled")
    // The offer is present.
    expect(body).toContain('Nothing is scheduled overnight yet')
    expect(body).toContain('I can run autonomous overnight work or set reminders')
    // House style: no em dashes in the brief copy.
    expect(body).not.toContain('—')
  })

  test('truthful brief — control: real overnight_queue rows are reflected', async () => {
    const store = new OvernightQueueStore(fix.db, () => '2026-06-20T00:00:00.000Z')
    await store.create({
      id: 'owk-20260620-100',
      project_slug: 't1',
      description: 'Deepen Tabs from imported context',
      status: 'queued',
    })
    const ctx = buildContext(fix, {
      project_slug: 't1',
      interview: { phase_state_json: { user_first_name: 'Ryan' } },
      captured_projects: [{ name: 'Tabs' }],
    })
    await action01.run(ctx)
    const body = fix.channelCalls.texts[0]!.body
    expect(body).toContain("I've queued these to work on overnight while you sleep:")
    expect(body).toContain('Deepen Tabs from imported context')
    expect(body).not.toContain('Nothing is scheduled overnight yet')
  })

  test('engagement decoder maps Telegram-side labels to WowEngagement', () => {
    expect(action01.decodeEngagement?.('read')).toBe('read')
    expect(action01.decodeEngagement?.('scrolled')).toBe('scrolled')
    expect(action01.decodeEngagement?.('idle')).toBe('idle')
    expect(action01.decodeEngagement?.('nope')).toBeNull()
  })
})
