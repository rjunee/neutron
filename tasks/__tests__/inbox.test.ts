import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { NO_PROJECT, TaskStore, type Task } from '../store.ts'
import {
  applyInboxRow,
  applyInboxRows,
  listAllTasks,
  effectiveBucket,
  parseInbox,
  parseInboxLine,
  priorityTagToStorage,
  renderDashboardMarkdown,
  renderTasksMarkdown,
  TASK_SOURCE_INBOX,
  type InboxRow,
} from '../inbox/index.ts'

const NOW = new Date('2026-06-21T12:00:00.000Z')

// ---------------------------------------------------------------------------
// types / parsing
// ---------------------------------------------------------------------------

describe('inbox — parse', () => {
  test('priorityTagToStorage maps P0..P3 → 3..0', () => {
    expect(priorityTagToStorage('P0')).toBe(3)
    expect(priorityTagToStorage('P1')).toBe(2)
    expect(priorityTagToStorage('P2')).toBe(1)
    expect(priorityTagToStorage('P3')).toBe(0)
    expect(priorityTagToStorage('p1')).toBe(2) // case-insensitive
    expect(priorityTagToStorage('nope')).toBeNull()
  })

  test('add row normalizes priority tag + date-only due to storage forms', () => {
    const row = parseInboxLine(
      '{"action":"add","title":"ship it","priority":"P1","due":"2026-06-30","project":"neutron","notes":"do the thing"}',
    )
    expect(typeof row).not.toBe('string')
    const r = row as InboxRow
    expect(r.action).toBe('add')
    expect(r.title).toBe('ship it')
    expect(r.priority).toBe(2) // P1 → storage 2
    expect(r.due_date).toBe('2026-06-30T00:00:00.000Z') // date-only anchored to UTC midnight
    expect(r.project).toBe('neutron')
    expect(r.notes).toBe('do the thing')
  })

  test('add row accepts a bare 0..3 storage priority and full ISO due', () => {
    const r = parseInboxLine(
      '{"action":"add","title":"x","priority":2,"due":"2026-07-01T09:30:00.000Z"}',
    ) as InboxRow
    expect(r.priority).toBe(2)
    expect(r.due_date).toBe('2026-07-01T09:30:00.000Z')
  })

  test('add without title is a parse error', () => {
    const res = parseInboxLine('{"action":"add","priority":"P0"}')
    expect(typeof res).toBe('string')
    expect(res as string).toContain('title')
  })

  test('edit action without id or title is a parse error', () => {
    const res = parseInboxLine('{"action":"complete"}')
    expect(typeof res).toBe('string')
    expect(res as string).toContain('id')
  })

  test('a present-but-invalid priority or due is a parse error (not silently dropped)', () => {
    const badPrio = parseInboxLine('{"action":"add","title":"x","priority":"P9"}')
    expect(typeof badPrio).toBe('string')
    expect(badPrio as string).toContain('priority')

    const badPrioInt = parseInboxLine('{"action":"add","title":"x","priority":4}')
    expect(typeof badPrioInt).toBe('string')

    const badDue = parseInboxLine('{"action":"add","title":"x","due":"not-a-date"}')
    expect(typeof badDue).toBe('string')
    expect(badDue as string).toContain('due')

    // Impossible calendar date must be rejected, not rolled over to Mar 3.
    const rollover = parseInboxLine('{"action":"add","title":"x","due":"2026-02-31"}')
    expect(typeof rollover).toBe('string')
    expect(rollover as string).toContain('due')
    // A real leap day is accepted.
    const leap = parseInboxLine('{"action":"add","title":"x","due":"2024-02-29"}') as InboxRow
    expect(leap.due_date).toBe('2024-02-29T00:00:00.000Z')

    // Full-ISO impossible dates are rejected too (not just date-only).
    const isoRollover = parseInboxLine('{"action":"add","title":"x","due":"2026-02-31T09:00:00.000Z"}')
    expect(typeof isoRollover).toBe('string')
    expect(isoRollover as string).toContain('due')
    // A valid full-ISO due passes through.
    const isoOk = parseInboxLine('{"action":"add","title":"x","due":"2026-07-01T09:30:00.000Z"}') as InboxRow
    expect(isoOk.due_date).toBe('2026-07-01T09:30:00.000Z')

    // An absent field is fine — no error, field simply unset.
    const ok = parseInboxLine('{"action":"add","title":"x"}') as InboxRow
    expect(ok.priority).toBeUndefined()
    expect(ok.due_date).toBeUndefined()
  })

  test('unknown action + malformed JSON are reported, blanks skipped', () => {
    const body = [
      '',
      '{"action":"frobnicate","title":"x"}',
      'not json at all',
      '   ',
      '{"action":"add","title":"valid"}',
    ].join('\n')
    const { rows, errors } = parseInbox(body)
    expect(rows.length).toBe(1)
    expect(rows[0]?.title).toBe('valid')
    expect(errors.length).toBe(2)
    expect(errors[0]?.line).toBe(2) // 1-based; blank line 1 skipped
  })
})

// ---------------------------------------------------------------------------
// render — focus ordering + section promotion (pure)
// ---------------------------------------------------------------------------

function fakeTask(overrides: Partial<Task>): Task {
  return {
    id: 'fake',
    project_slug: 't1',
    project_id: NO_PROJECT,
    title: 'placeholder',
    description: null,
    status: 'open',
    priority: null,
    due_date: null,
    owner_persona: null,
    source: null,
    focus_score: null,
    focus_score_updated_at: null,
    llm_rank: null,
    llm_reason: null,
    prioritized_by: null,
    prioritized_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    completed_at: null,
    ...overrides,
  }
}

describe('inbox — render (focus ordering + promotion)', () => {
  test('effectiveBucket promotes an overdue low-priority task to P0', () => {
    const overdueP3 = fakeTask({
      priority: 0, // storage P3
      due_date: '2026-06-10T00:00:00.000Z', // 11 days overdue at NOW
    })
    const freshP1 = fakeTask({ priority: 2, due_date: null }) // storage P1, no due
    expect(effectiveBucket(overdueP3, NOW)).toBe('P0')
    expect(effectiveBucket(freshP1, NOW)).toBe('P1')
  })

  test('effectiveBucket: due-soon (≤2d) promotes to P1, due-this-week (≤7d) to P2', () => {
    const dueTomorrow = fakeTask({ priority: 0, due_date: '2026-06-22T18:00:00.000Z' })
    const dueIn5 = fakeTask({ priority: 0, due_date: '2026-06-26T12:00:00.000Z' })
    expect(effectiveBucket(dueTomorrow, NOW)).toBe('P1')
    expect(effectiveBucket(dueIn5, NOW)).toBe('P2')
  })

  test('tasks.md orders active by fresh focus score DESC', () => {
    const p0 = fakeTask({ id: 'a', title: 'top priority', priority: 3 })
    const p3 = fakeTask({ id: 'b', title: 'low priority', priority: 0 })
    // Pass them in reverse-focus order to prove the renderer sorts.
    const md = renderTasksMarkdown({ tasks: [p3, p0], now: NOW })
    const topIdx = md.indexOf('top priority')
    const lowIdx = md.indexOf('low priority')
    expect(topIdx).toBeGreaterThan(-1)
    expect(topIdx).toBeLessThan(lowIdx)
    // Focus tag reflects the recomputed P0 score (25.0).
    expect(md).toContain('top priority [P0] [focus:25.0]')
  })

  test('DASHBOARD groups into auto-promoted P0/P1 sections in order', () => {
    const overdueP3 = fakeTask({
      id: 'a',
      title: 'overdue chore',
      priority: 0,
      due_date: '2026-06-01T00:00:00.000Z',
    })
    const plainP1 = fakeTask({ id: 'b', title: 'important thing', priority: 2 })
    const md = renderDashboardMarkdown({ tasks: [plainP1, overdueP3], now: NOW })
    expect(md).toContain('## 🔴 Do Now (P0)')
    expect(md).toContain('## 🟠 Important (P1)')
    // Overdue P3 was promoted into the P0 section, above the P1 section.
    const doNowIdx = md.indexOf('Do Now (P0)')
    const importantIdx = md.indexOf('Important (P1)')
    const overdueIdx = md.indexOf('overdue chore')
    const importantTaskIdx = md.indexOf('important thing')
    expect(doNowIdx).toBeLessThan(importantIdx)
    expect(overdueIdx).toBeGreaterThan(doNowIdx)
    expect(overdueIdx).toBeLessThan(importantIdx)
    expect(importantTaskIdx).toBeGreaterThan(importantIdx)
    expect(md).toContain('⚠️ overdue')
  })

  test('empty surfaces render placeholders', () => {
    expect(renderTasksMarkdown({ tasks: [], now: NOW })).toContain('_No active tasks._')
    expect(renderDashboardMarkdown({ tasks: [], now: NOW })).toContain('**All clear**')
  })
})

// ---------------------------------------------------------------------------
// apply — rows mutate the store
// ---------------------------------------------------------------------------

describe('inbox — apply', () => {
  let tmp: string
  let db: ProjectDb
  let store: TaskStore

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-inbox-apply-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
    store = new TaskStore(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  const deps = () => ({ store, project_slug: 't1' })

  test('add creates a task with normalized fields + inbox source', async () => {
    const row = parseInboxLine(
      '{"action":"add","title":"wire surface","priority":"P0","due":"2026-06-25","project":"neutron"}',
    ) as InboxRow
    const outcome = await applyInboxRow(deps(), row)
    expect(outcome.status).toBe('applied')
    const task = store.get(outcome.task_id as string)
    expect(task).not.toBeNull()
    expect(task?.title).toBe('wire surface')
    expect(task?.priority).toBe(3)
    expect(task?.due_date).toBe('2026-06-25T00:00:00.000Z')
    expect(task?.project_id).toBe('neutron')
    expect(task?.source).toBe(TASK_SOURCE_INBOX)
    expect(task?.status).toBe('open')
  })

  test('add with a stable id is idempotent on replay (skipped:duplicate)', async () => {
    const line = '{"action":"add","id":"task-1","title":"once"}'
    const first = await applyInboxRow(deps(), parseInboxLine(line) as InboxRow)
    const second = await applyInboxRow(deps(), parseInboxLine(line) as InboxRow)
    expect(first.status).toBe('applied')
    expect(second.status).toBe('skipped')
    expect(second.reason).toBe('duplicate')
    expect(store.list({ project_slug: 't1', status: 'all' }).length).toBe(1)
  })

  test('complete by title locates the open task and closes it', async () => {
    await applyInboxRow(
      deps(),
      parseInboxLine('{"action":"add","title":"close me","project":"neutron"}') as InboxRow,
    )
    const outcome = await applyInboxRow(
      deps(),
      parseInboxLine('{"action":"complete","title":"close me","project":"neutron"}') as InboxRow,
    )
    expect(outcome.status).toBe('applied')
    const task = store.get(outcome.task_id as string)
    expect(task?.status).toBe('done')
    expect(task?.completed_at).not.toBeNull()
  })

  test('update with explicit null clears due_date and notes', async () => {
    await applyInboxRow(
      deps(),
      parseInboxLine('{"action":"add","id":"clr","title":"clear me","due":"2026-06-30","notes":"some notes"}') as InboxRow,
    )
    expect(store.get('clr')?.due_date).not.toBeNull()
    expect(store.get('clr')?.description).not.toBeNull()

    const outcome = await applyInboxRow(
      deps(),
      parseInboxLine('{"action":"update","id":"clr","due":null,"notes":null}') as InboxRow,
    )
    expect(outcome.status).toBe('applied')
    expect(store.get('clr')?.due_date).toBeNull()
    expect(store.get('clr')?.description).toBeNull()
  })

  test('update by id patches priority + due and recomputes focus_score', async () => {
    const add = await applyInboxRow(
      deps(),
      parseInboxLine('{"action":"add","id":"t9","title":"raise me","priority":"P3"}') as InboxRow,
    )
    const before = store.get(add.task_id as string)
    const outcome = await applyInboxRow(
      deps(),
      parseInboxLine('{"action":"update","id":"t9","priority":"P0","due":"2026-06-22"}') as InboxRow,
    )
    expect(outcome.status).toBe('applied')
    const after = store.get('t9')
    expect(after?.priority).toBe(3)
    expect(after?.due_date).toBe('2026-06-22T00:00:00.000Z')
    expect(after?.focus_score).toBeGreaterThan(before?.focus_score as number)
  })

  test('complete / cancel / delete on a missing id are skipped:not_found', async () => {
    for (const action of ['complete', 'cancel', 'delete']) {
      const outcome = await applyInboxRow(
        deps(),
        parseInboxLine(`{"action":"${action}","id":"ghost"}`) as InboxRow,
      )
      expect(outcome.status).toBe('skipped')
      expect(outcome.reason).toBe('not_found')
    }
  })

  test('an id-based edit cannot cross project_slug boundaries', async () => {
    // A task owned by a DIFFERENT slug.
    const foreign = await store.create({ project_slug: 't2', title: 'not yours', id: 'foreign-1' })
    // The scanner runs for slug 't1'; an inbox row naming the foreign id...
    const outcome = await applyInboxRow(
      deps(), // project_slug: 't1'
      parseInboxLine('{"action":"complete","id":"foreign-1"}') as InboxRow,
    )
    expect(outcome.status).toBe('skipped')
    expect(outcome.reason).toBe('not_found')
    // The foreign task is untouched.
    expect(store.get(foreign.id)?.status).toBe('open')
  })

  test('listAllTasks pages past the 1000-row cap', async () => {
    const N = 1001
    for (let i = 0; i < N; i++) {
      await store.create({ project_slug: 't1', title: `task ${i}` })
    }
    const all = listAllTasks(deps())
    expect(all.length).toBe(N)
  })

  test('title-based lookup pages past the first 500 open tasks', async () => {
    // 501 dateless open tasks → default order is newest-first, so the
    // FIRST-created ('task 0') sorts last, landing on page 2 (offset 500).
    for (let i = 0; i < 501; i++) {
      await store.create({ project_slug: 't1', title: `task ${i}` })
    }
    const outcome = await applyInboxRow(
      deps(),
      parseInboxLine('{"action":"complete","title":"task 0"}') as InboxRow,
    )
    expect(outcome.status).toBe('applied')
    expect(store.get(outcome.task_id as string)?.status).toBe('done')
  })

  test('applyInboxRows applies a batch in order', async () => {
    const { rows } = parseInbox(
      [
        '{"action":"add","id":"a","title":"first"}',
        '{"action":"add","id":"b","title":"second","priority":"P0"}',
        '{"action":"cancel","id":"a"}',
      ].join('\n'),
    )
    const outcomes = await applyInboxRows(deps(), rows)
    expect(outcomes.map((o) => o.status)).toEqual(['applied', 'applied', 'applied'])
    expect(store.get('a')?.status).toBe('cancelled')
    expect(store.get('b')?.status).toBe('open')
  })
})
