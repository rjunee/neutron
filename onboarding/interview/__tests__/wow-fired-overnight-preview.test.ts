/**
 * 2026-06-20 (go-live, brief-truthful) — supersedes the 2026-05-28 "Fix C"
 * overnight-preview behaviour.
 *
 * Owner-confirmed defect: the wow first-week brief CLAIMED scheduled
 * overnight work that was never created — the real `overnight_queue` is
 * empty at onboarding (owner DB: 0 rows). Owner decision option A: make
 * the brief TRUTHFUL. The overnight section now reads the REAL
 * `overnight_queue` for the project:
 *  - empty queue (the onboarding reality) → OFFER framing, NO fabricated
 *    "I've queued…/I'll run the overnight pass at 7am" claim;
 *  - queue with rows → reflect the real rows (the control branch).
 *
 * Sam's original 2026-05-28 ask ("explain the overnight pass / list what's
 * queued") still holds — but only when there is genuinely something
 * queued. Promising work that does not exist was the bug.
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
import { OvernightQueueStore } from '../../overnight/queue-store.ts'
import type { ImportResult } from '../../history-import/types.ts'

let fix: TestFixture
beforeEach(() => {
  fix = makeFixture()
})
afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
})

function importWith(opts: { tasks?: number; threads?: number; projects?: number } = {}): ImportResult {
  const tasks: ImportResult['proposed_tasks'] = []
  for (let i = 0; i < (opts.tasks ?? 0); i++) {
    tasks.push({ title: `task ${i + 1}` })
  }
  const projects: ImportResult['proposed_projects'] = []
  for (let i = 0; i < (opts.projects ?? 0); i++) {
    projects.push({ name: `Project ${i + 1}`, rationale: '', suggested_topics: [] })
  }
  return {
    entities: [],
    topics: [],
    proposed_projects: projects,
    proposed_tasks: tasks,
    proposed_reminders: [],
    voice_signals: {},
    facts: {},
  }
}

describe('overnight section is TRUTHFUL — no fabricated queue/schedule claims', () => {
  test('drops the legacy "I will check in tomorrow morning with the overnight pass" line', async () => {
    const ctx = buildContext(fix, {
      interview: {
        archetype_blend: ['Guide'],
        phase_state_json: { user_first_name: 'Sam' },
      },
      import_result: importWith({ tasks: 4 }),
      captured_projects: [{ name: 'Topline' }],
    })
    await action01.run(ctx)
    const body = fix.channelCalls.texts[0]!.body
    expect(body).not.toContain('I will check in tomorrow morning with the overnight pass.')
  })

  test('EMPTY overnight_queue (onboarding reality): offers, never claims queued/scheduled work', async () => {
    // The dispatch context carries stalled threads + proposed tasks — the
    // exact inputs the OLD code used to FABRICATE an "I've queued these…"
    // list from. With the real queue empty, none of that may be asserted
    // as queued or scheduled.
    const ctx = buildContext(fix, {
      interview: {
        archetype_blend: ['Guide'],
        phase_state_json: { user_first_name: 'Sam' },
      },
      import_result: importWith({ tasks: 4 }),
      captured_projects: [{ name: 'Topline' }, { name: 'Acme' }],
      stalled_threads: [
        {
          thread_id: 'th-1',
          recipient_email: 'priya@example.com',
          subject: 'Q3 invoice',
          last_inbound_at: 1_700_000_000_000,
          last_outbound_at: 1_700_000_000_000,
          inbound_count: 1,
        },
      ],
    })
    await action01.run(ctx)
    const body = fix.channelCalls.texts[0]!.body

    // NO fabricated "queued"/"scheduled"/"7am tomorrow" claims.
    expect(body).not.toContain("I've queued these to work on overnight while you sleep:")
    expect(body).not.toContain('overnight pass at 7am tomorrow')
    expect(body).not.toContain('Draft replies for')
    expect(body).not.toContain('Re-rank 4 tasks by overnight signals')
    expect(body).not.toContain('Refresh entity + topic graph')
    expect(body.toLowerCase()).not.toContain("i've scheduled")
    expect(body.toLowerCase()).not.toContain('running tonight')

    // DOES reference the real projects.
    expect(body).toContain('Topline')

    // DOES contain an OFFER to set up overnight work / reminders.
    expect(body).toContain('Nothing is scheduled overnight yet')
    expect(body).toContain('I can run autonomous overnight work or set reminders')
    expect(body).toContain('"schedule overnight research on Topline"')
    expect(body).toContain('"remind me Monday 9am"')

    // No em dashes in the user-facing copy (house style).
    expect(body).not.toContain('—')

    // No competing button prompt alongside the text.
    expect(fix.channelCalls.prompts.length).toBe(0)
  })

  test('CONTROL — when overnight_queue HAS rows, the brief reflects the real rows', async () => {
    const store = new OvernightQueueStore(fix.db, () => '2026-06-20T00:00:00.000Z')
    await store.create({
      id: 'owk-20260620-001',
      project_slug: 't1',
      description: 'Deepen the Topline pricing analysis from imported context',
      status: 'queued',
    })
    await store.create({
      id: 'owk-20260620-002',
      project_slug: 't1',
      description: 'Draft a reply to the stalled Q3 invoice thread',
      status: 'in-flight',
    })
    // A terminal row for the SAME project must NOT be surfaced as a promise.
    await store.create({
      id: 'owk-20260620-003',
      project_slug: 't1',
      description: 'Already-finished item that should not appear',
      status: 'completed',
    })
    // A row for a DIFFERENT project must not leak in.
    await store.create({
      id: 'owk-20260620-004',
      project_slug: 'other',
      description: 'Some other project work',
      status: 'queued',
    })

    const ctx = buildContext(fix, {
      project_slug: 't1',
      interview: {
        archetype_blend: ['Guide'],
        phase_state_json: { user_first_name: 'Sam' },
      },
      captured_projects: [{ name: 'Topline' }],
    })
    await action01.run(ctx)
    const body = fix.channelCalls.texts[0]!.body

    expect(body).toContain("I've queued these to work on overnight while you sleep:")
    expect(body).toContain('Deepen the Topline pricing analysis from imported context')
    expect(body).toContain('Draft a reply to the stalled Q3 invoice thread')
    // Terminal + other-project rows excluded.
    expect(body).not.toContain('Already-finished item that should not appear')
    expect(body).not.toContain('Some other project work')
    // It does NOT fall back to the empty-state offer when work is real.
    expect(body).not.toContain('Nothing is scheduled overnight yet')
    // No em dashes.
    expect(body).not.toContain('—')
  })

  test('invites changes by typing — no "tap below" button reference (Argus r1 BLOCKER #2)', async () => {
    const ctx = buildContext(fix, {
      interview: {
        archetype_blend: ['Guide'],
        phase_state_json: { user_first_name: 'Sam' },
      },
      import_result: importWith({ tasks: 4 }),
      captured_projects: [{ name: 'Topline' }],
    })
    await action01.run(ctx)
    const body = fix.channelCalls.texts[0]!.body
    expect(body).not.toContain('Tap below to start the overnight pass')
    // The per-project pointer is true (engine seeds a topic per project).
    expect(body).toContain('Each project on the left has its own topic')
    // And no competing button prompt was emitted alongside the text.
    expect(fix.channelCalls.prompts.length).toBe(0)
  })
})
