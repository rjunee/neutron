/**
 * 2026-05-28 wow-cleanup sprint — Fix B.
 *
 * The wow_fired first-week brief must surface the contents of the import
 * (projects, tasks, reminders) instead of just bare counts, AND emit a
 * follow-up button prompt (+ allow_freeform) so the user can accept the
 * overnight pass or amend any of the above via freeform. Sam's verbatim
 * feedback 2026-05-28: "it just gives a summary like 15 pending tasks,
 * 5 suggested reminders... what are they? where can I see those? Maybe
 * there should be buttons to list tasks, list reminders, and freetext
 * responses to make changes."
 *
 * 2026-05-28 Argus r1 BLOCKER (PR #327 fix-pass r2): the previous
 * 1+N shape ([A] Start overnight pass + [B-D] Review N projects/tasks/
 * reminders) shipped without engine routing for the B-D values — every
 * tap returned noop_terminal. Per Argus the per-item drop/keep/edit
 * sub-flow is a future sprint; this round emits [A] + allow_freeform
 * only. The freeform path lets the user type "show me the tasks" /
 * "drop the AC install" etc. and the engine routes that through the
 * wow_brief acceptance handler.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import action01 from '../../wow-moment/actions/01-first-week-brief.ts'
import {
  buildContext,
  makeFixture,
  teardown,
  type TestFixture,
} from '../../wow-moment/__tests__/test-helpers.ts'
import type { ImportResult } from '../../history-import/types.ts'

let fix: TestFixture
beforeEach(() => {
  fix = makeFixture()
})
afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
})

function fixture(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    entities: [],
    topics: [],
    proposed_projects: [
      { name: 'Topline', rationale: 'biggest open thread', suggested_topics: [] },
      { name: 'Acme', rationale: 'spousal launch', suggested_topics: [] },
    ],
    proposed_tasks: [
      { title: 'Reply to Priya about Q3 invoice', due_at: 1_700_000_000_000, priority_hint: 'P1' },
      { title: 'Order Alexandre milk' },
      { title: 'Schedule AC install', due_at: 1_700_100_000_000 },
    ],
    proposed_reminders: [
      { pattern: 'morning 06:30', body: 'meditate 10 min' },
      { pattern: 'weekly mon 09:00', body: 'review priorities' },
    ],
    voice_signals: {},
    facts: {},
    ...overrides,
  }
}

describe('brief inlines import contents + emits NO competing affordance (Argus r1 BLOCKER #2)', () => {
  test('brief text inlines project / task / reminder items', async () => {
    const ctx = buildContext(fix, {
      interview: {
        archetype_blend: ['Guide'],
        phase_state_json: { user_first_name: 'Sam' },
      },
      import_result: fixture(),
    })
    await action01.run(ctx)
    const sent = fix.channelCalls.texts[0]
    expect(sent).toBeDefined()
    const body = sent!.body
    // Section headers carry the actual count, not a generic preamble.
    expect(body).toContain('Projects on deck (2):')
    expect(body).toContain('Tasks queued (3):')
    expect(body).toContain('Reminders suggested (2):')
    // Specific items are inlined so the user can SEE them.
    expect(body).toContain('Topline')
    expect(body).toContain('Acme')
    expect(body).toContain('Reply to Priya about Q3 invoice')
    expect(body).toContain('Order Alexandre milk')
    expect(body).toContain('meditate 10 min')
    expect(body).toContain('review priorities')
  })

  // 2026-06-09 (Argus r1 BLOCKER #2) — the brief NO LONGER emits any
  // tappable affordance. The prior [A] Start overnight pass button became
  // a stale, still-tappable noop once the GAP3 fix advanced the engine to
  // `completed` + fired the guide; every tap returned `noop_terminal` and
  // spun the deterministic typing indicator forever (the r4 stuck-typing
  // class / ISSUES #115). These tests are the reproduce-first regression
  // guard: action-01 delivers TEXT ONLY, emits NO prompt, and exposes NO
  // follow_up_prompt_id so the dispatcher never surfaces a brief_prompt_id.
  test('emits NO competing button prompt — brief is text-only (no stale noop affordance)', async () => {
    const ctx = buildContext(fix, {
      interview: {
        archetype_blend: ['Guide'],
        phase_state_json: { user_first_name: 'Sam' },
      },
      import_result: fixture(),
    })
    const result = await action01.run(ctx)
    // Exactly one channel surface: the brief text. No button prompt.
    expect(fix.channelCalls.texts.length).toBe(1)
    expect(fix.channelCalls.prompts.length).toBe(0)
    // No follow-up prompt id → dispatcher will not set brief_prompt_id →
    // the engine has no competing prompt to leave dangling at `completed`.
    expect(result.follow_up_prompt_id).toBeUndefined()
    // The old [A]/[B-D] affordance choice values are gone entirely.
    expect(result.redacted_payload?.['affordance_prompt_id']).toBeUndefined()
  })

  test('text-only holds regardless of populated/empty categories', async () => {
    const ctx = buildContext(fix, {
      interview: {
        archetype_blend: ['Guide'],
        phase_state_json: { user_first_name: 'Sam' },
      },
      import_result: fixture({
        proposed_reminders: [],
      }),
    })
    const result = await action01.run(ctx)
    expect(fix.channelCalls.prompts.length).toBe(0)
    expect(result.follow_up_prompt_id).toBeUndefined()
  })

  test('text-only holds when import_result is null', async () => {
    const ctx = buildContext(fix, {
      interview: {
        archetype_blend: ['Guide'],
        phase_state_json: { user_first_name: 'Sam' },
      },
      import_result: null,
    })
    const result = await action01.run(ctx)
    expect(fix.channelCalls.texts.length).toBe(1)
    expect(fix.channelCalls.prompts.length).toBe(0)
    expect(result.follow_up_prompt_id).toBeUndefined()
  })
})
