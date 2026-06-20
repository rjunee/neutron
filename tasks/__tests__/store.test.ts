import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { NO_PROJECT, TaskNotFoundError, TaskStore } from '../store.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-tasks-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('TaskStore — CRUD', () => {
  test('create + get round-trip preserves every field', async () => {
    const store = new TaskStore(db)
    const t = await store.create({
      project_slug: 't1',
      project_id: 'proj-A',
      title: 'wire P6.0 store',
      description: 'land migration 0032 + canonical TaskStore',
      priority: 2,
      due_date: '2026-05-20T09:00:00.000Z',
      owner_persona: 'sam',
      source: 'chat',
    })

    expect(t.status).toBe('open')
    expect(t.created_at).toBe(t.updated_at)
    expect(t.completed_at).toBeNull()

    const got = store.get(t.id)
    expect(got).not.toBeNull()
    expect(got?.title).toBe('wire P6.0 store')
    expect(got?.project_id).toBe('proj-A')
    expect(got?.description).toBe('land migration 0032 + canonical TaskStore')
    expect(got?.priority).toBe(2)
    expect(got?.due_date).toBe('2026-05-20T09:00:00.000Z')
    expect(got?.owner_persona).toBe('sam')
    expect(got?.source).toBe('chat')
    expect(got?.project_slug).toBe('t1')
  })

  test('create defaults: project_id="", nullable fields null, status=open', async () => {
    const store = new TaskStore(db)
    const t = await store.create({ project_slug: 't1', title: 'no-frills' })
    expect(t.project_id).toBe(NO_PROJECT)
    expect(t.project_id).toBe('')
    expect(t.status).toBe('open')
    expect(t.description).toBeNull()
    expect(t.priority).toBeNull()
    expect(t.due_date).toBeNull()
    expect(t.owner_persona).toBeNull()
    expect(t.source).toBeNull()
    expect(t.completed_at).toBeNull()
  })

  test('get returns null for unknown id', () => {
    const store = new TaskStore(db)
    expect(store.get('nope-' + crypto.randomUUID())).toBeNull()
  })

  test('update patches selected fields and bumps updated_at', async () => {
    const store = new TaskStore(db)
    const created = await store.create({ project_slug: 't1', title: 'before' })
    // Force a measurable wall-clock delta so updated_at must change.
    await new Promise((r) => setTimeout(r, 5))

    const patched = await store.update(created.id, {
      title: 'after',
      description: 'edited',
      priority: 3,
    })

    expect(patched.title).toBe('after')
    expect(patched.description).toBe('edited')
    expect(patched.priority).toBe(3)
    expect(patched.status).toBe('open')
    expect(patched.created_at).toBe(created.created_at)
    expect(patched.updated_at >= created.updated_at).toBe(true)
  })

  test('update can null out optional fields explicitly', async () => {
    const store = new TaskStore(db)
    const t = await store.create({
      project_slug: 't1',
      title: 'will lose due_date',
      due_date: '2026-05-20T09:00:00.000Z',
      priority: 1,
    })
    const cleared = await store.update(t.id, { due_date: null, priority: null })
    expect(cleared.due_date).toBeNull()
    expect(cleared.priority).toBeNull()
  })

  test('update throws TaskNotFoundError for unknown id', async () => {
    const store = new TaskStore(db)
    await expect(store.update('nope', { title: 'x' })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    )
  })

  test('complete flips status and stamps completed_at', async () => {
    const store = new TaskStore(db)
    const t = await store.create({ project_slug: 't1', title: 'finish me' })
    const done = await store.complete(t.id)

    expect(done.status).toBe('done')
    expect(done.completed_at).not.toBeNull()
    expect(done.updated_at >= t.updated_at).toBe(true)
  })

  test('complete is idempotent — does not bump completed_at on re-complete', async () => {
    const store = new TaskStore(db)
    const t = await store.create({ project_slug: 't1', title: 'idempotent' })
    const first = await store.complete(t.id)
    await new Promise((r) => setTimeout(r, 5))
    const second = await store.complete(t.id)

    expect(first.completed_at).toBe(second.completed_at)
    expect(second.status).toBe('done')
  })

  test('complete throws TaskNotFoundError for unknown id', async () => {
    const store = new TaskStore(db)
    await expect(store.complete('nope')).rejects.toBeInstanceOf(TaskNotFoundError)
  })

  test('re-opening a done task via update clears completed_at', async () => {
    const store = new TaskStore(db)
    const t = await store.create({ project_slug: 't1', title: 'reopen me' })
    await store.complete(t.id)
    const reopened = await store.update(t.id, { status: 'open' })
    expect(reopened.status).toBe('open')
    expect(reopened.completed_at).toBeNull()
  })

  test('update preserves completed_at when status="done" is echoed back on an already-done task', async () => {
    // Regression: any caller editing a done task while echoing back
    // status:'done' (e.g. fixing a typo via a generic update payload)
    // must NOT reset completed_at to NOW. completed_at is server-managed
    // and only advances on the open→done transition.
    const store = new TaskStore(db)
    const t = await store.create({ project_slug: 't1', title: 'audit me' })
    const completed = await store.complete(t.id)
    expect(completed.completed_at).not.toBeNull()
    await new Promise((r) => setTimeout(r, 5))

    const reEdited = await store.update(t.id, {
      status: 'done',
      title: 'audit me — fixed typo',
    })

    expect(reEdited.status).toBe('done')
    expect(reEdited.title).toBe('audit me — fixed typo')
    expect(reEdited.completed_at).toBe(completed.completed_at)
    // updated_at may advance (we edited the title), but completed_at must be pinned.
    expect(reEdited.updated_at >= completed.updated_at).toBe(true)
  })

  test('cancel flips status, idempotent, throws on missing id', async () => {
    const store = new TaskStore(db)
    const t = await store.create({ project_slug: 't1', title: 'cancel me' })
    const cancelled = await store.cancel(t.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.completed_at).toBeNull()

    const again = await store.cancel(t.id)
    expect(again.status).toBe('cancelled')
    expect(again.updated_at).toBe(cancelled.updated_at)

    await expect(store.cancel('nope')).rejects.toBeInstanceOf(TaskNotFoundError)
  })

  test('cancelling a previously-done task clears completed_at', async () => {
    // Regression: invariant says completed_at is populated only while
    // status='done'. Cancelling after completion must clear it so
    // readers can distinguish "completed" from "completed-then-cancelled".
    const store = new TaskStore(db)
    const t = await store.create({ project_slug: 't1', title: 'flip me' })
    const completed = await store.complete(t.id)
    expect(completed.completed_at).not.toBeNull()

    const cancelled = await store.cancel(t.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.completed_at).toBeNull()
  })

  test('delete removes the row and is non-idempotent (second delete throws)', async () => {
    const store = new TaskStore(db)
    const t = await store.create({ project_slug: 't1', title: 'goodbye' })
    await store.delete(t.id)
    expect(store.get(t.id)).toBeNull()
    await expect(store.delete(t.id)).rejects.toBeInstanceOf(TaskNotFoundError)
  })
})

describe('TaskStore — project scoping', () => {
  test('project A and project B rows are isolated by project_id filter', async () => {
    const store = new TaskStore(db)
    await store.create({ project_slug: 't1', project_id: 'A', title: 'a-1' })
    await store.create({ project_slug: 't1', project_id: 'A', title: 'a-2' })
    await store.create({ project_slug: 't1', project_id: 'B', title: 'b-1' })

    const a = store.list({ project_slug: 't1', project_id: 'A' })
    expect(a.map((r) => r.title).sort()).toEqual(['a-1', 'a-2'])

    const b = store.list({ project_slug: 't1', project_id: 'B' })
    expect(b.map((r) => r.title)).toEqual(['b-1'])
  })

  test('omitting project_id returns every project (cross-project rollup)', async () => {
    const store = new TaskStore(db)
    await store.create({ project_slug: 't1', project_id: 'A', title: 'a' })
    await store.create({ project_slug: 't1', project_id: 'B', title: 'b' })
    await store.create({ project_slug: 't1', title: 'unprojected' })

    const all = store.list({ project_slug: 't1' })
    expect(all.map((r) => r.title).sort()).toEqual(['a', 'b', 'unprojected'])
  })

  test('NO_PROJECT filter returns only unprojected tasks', async () => {
    const store = new TaskStore(db)
    await store.create({ project_slug: 't1', project_id: 'A', title: 'a' })
    await store.create({ project_slug: 't1', title: 'global-1' })
    await store.create({ project_slug: 't1', title: 'global-2' })

    const globals = store.list({ project_slug: 't1', project_id: NO_PROJECT })
    expect(globals.map((r) => r.title).sort()).toEqual(['global-1', 'global-2'])
  })
})

describe('TaskStore — project isolation', () => {
  test('listing in project t1 never returns rows from project t2', async () => {
    const store = new TaskStore(db)
    await store.create({ project_slug: 't1', title: 'mine' })
    await store.create({ project_slug: 't2', title: 'theirs' })

    const t1Rows = store.list({ project_slug: 't1', status: 'all' })
    expect(t1Rows.map((r) => r.title)).toEqual(['mine'])

    const t2Rows = store.list({ project_slug: 't2', status: 'all' })
    expect(t2Rows.map((r) => r.title)).toEqual(['theirs'])
  })

  test('a row for project t1 is invisible when listing t2, even with the same project_id', async () => {
    const store = new TaskStore(db)
    await store.create({ project_slug: 't1', project_id: 'shared', title: 'mine' })
    await store.create({ project_slug: 't2', project_id: 'shared', title: 'theirs' })

    expect(
      store.list({ project_slug: 't1', project_id: 'shared' }).map((r) => r.title),
    ).toEqual(['mine'])
    expect(
      store.list({ project_slug: 't2', project_id: 'shared' }).map((r) => r.title),
    ).toEqual(['theirs'])
  })
})

describe('TaskStore — status filter + sort', () => {
  test('default list filters to status=open and excludes done/cancelled', async () => {
    const store = new TaskStore(db)
    const a = await store.create({ project_slug: 't1', title: 'a' })
    const b = await store.create({ project_slug: 't1', title: 'b' })
    const c = await store.create({ project_slug: 't1', title: 'c' })
    await store.complete(b.id)
    await store.cancel(c.id)

    const open = store.list({ project_slug: 't1' })
    expect(open.map((r) => r.title)).toEqual(['a'])
    // a is still present:
    expect(open.find((r) => r.id === a.id)).not.toBeUndefined()
  })

  test('status="done" returns only completed', async () => {
    const store = new TaskStore(db)
    const a = await store.create({ project_slug: 't1', title: 'a' })
    await store.create({ project_slug: 't1', title: 'b' })
    await store.complete(a.id)

    const done = store.list({ project_slug: 't1', status: 'done' })
    expect(done.map((r) => r.title)).toEqual(['a'])
  })

  test('status="cancelled" returns only cancelled', async () => {
    const store = new TaskStore(db)
    const a = await store.create({ project_slug: 't1', title: 'a' })
    await store.cancel(a.id)
    await store.create({ project_slug: 't1', title: 'b' })

    const cancelled = store.list({ project_slug: 't1', status: 'cancelled' })
    expect(cancelled.map((r) => r.title)).toEqual(['a'])
  })

  test('status="all" returns every row regardless of status', async () => {
    const store = new TaskStore(db)
    const a = await store.create({ project_slug: 't1', title: 'a' })
    const b = await store.create({ project_slug: 't1', title: 'b' })
    const c = await store.create({ project_slug: 't1', title: 'c' })
    await store.complete(b.id)
    await store.cancel(c.id)

    const all = store.list({ project_slug: 't1', status: 'all' })
    expect(all.map((r) => r.id).sort()).toEqual([a.id, b.id, c.id].sort())
  })

  test('open tasks sort by due_date ASC (NULL last); dateless tasks sort newest-first', async () => {
    const store = new TaskStore(db)
    // Insert with explicit small wait gaps so created_at orders are deterministic.
    const noDateOld = await store.create({ project_slug: 't1', title: 'old-no-date' })
    await new Promise((r) => setTimeout(r, 5))
    const dueLate = await store.create({
      project_slug: 't1',
      title: 'due-late',
      due_date: '2026-12-31T23:59:59.000Z',
    })
    await new Promise((r) => setTimeout(r, 5))
    const dueSoon = await store.create({
      project_slug: 't1',
      title: 'due-soon',
      due_date: '2026-05-20T09:00:00.000Z',
    })
    await new Promise((r) => setTimeout(r, 5))
    const noDateNew = await store.create({ project_slug: 't1', title: 'new-no-date' })

    const ordered = store.list({ project_slug: 't1' })
    expect(ordered.map((r) => r.id)).toEqual([
      dueSoon.id, // earliest due_date first
      dueLate.id,
      noDateNew.id, // dateless tasks after, newest-first
      noDateOld.id,
    ])
  })

  test('done/cancelled tasks sort after open tasks when status="all"', async () => {
    const store = new TaskStore(db)
    const open = await store.create({ project_slug: 't1', title: 'open' })
    const done = await store.create({ project_slug: 't1', title: 'done' })
    await store.complete(done.id)

    const ordered = store.list({ project_slug: 't1', status: 'all' })
    expect(ordered.map((r) => r.id)).toEqual([open.id, done.id])
  })

  test('non-open rows sort done-by-completed_at-DESC then cancelled-by-updated_at-DESC', async () => {
    // Regression: docstring promises newest-completed first for done,
    // newest-updated first for cancelled, and the entire non-open
    // bucket sits below every open row.
    const store = new TaskStore(db)
    const stillOpen = await store.create({ project_slug: 't1', title: 'still-open' })

    const doneOld = await store.create({ project_slug: 't1', title: 'done-old' })
    await store.complete(doneOld.id)
    await new Promise((r) => setTimeout(r, 5))
    const doneNew = await store.create({ project_slug: 't1', title: 'done-new' })
    await store.complete(doneNew.id)

    await new Promise((r) => setTimeout(r, 5))
    const cancelledOld = await store.create({ project_slug: 't1', title: 'cancelled-old' })
    await store.cancel(cancelledOld.id)
    await new Promise((r) => setTimeout(r, 5))
    const cancelledNew = await store.create({ project_slug: 't1', title: 'cancelled-new' })
    await store.cancel(cancelledNew.id)

    const ordered = store.list({ project_slug: 't1', status: 'all' })
    expect(ordered.map((r) => r.id)).toEqual([
      stillOpen.id, // open first
      doneNew.id, // done sorted by completed_at DESC (newest first)
      doneOld.id,
      cancelledNew.id, // cancelled sorted by updated_at DESC (newest first)
      cancelledOld.id,
    ])
  })

  test('limit caps the result count', async () => {
    const store = new TaskStore(db)
    for (let i = 0; i < 5; i++) {
      await store.create({ project_slug: 't1', title: `t-${i}` })
    }
    const top2 = store.list({ project_slug: 't1', limit: 2 })
    expect(top2.length).toBe(2)
  })
})

describe('TaskStore — schema constraints', () => {
  test('priority outside 0-3 is rejected by the CHECK constraint', async () => {
    const store = new TaskStore(db)
    await expect(
      store.create({ project_slug: 't1', title: 'bad', priority: 7 }),
    ).rejects.toThrow()
    await expect(
      store.create({ project_slug: 't1', title: 'bad', priority: -1 }),
    ).rejects.toThrow()
  })

  test('priority null and 0-3 are accepted', async () => {
    const store = new TaskStore(db)
    for (const p of [null, 0, 1, 2, 3]) {
      const row = await store.create({
        project_slug: 't1',
        title: `p-${p}`,
        priority: p,
      })
      expect(row.priority).toBe(p)
    }
  })

  test('unknown status is rejected by the CHECK constraint', async () => {
    const store = new TaskStore(db)
    const t = await store.create({ project_slug: 't1', title: 'x' })
    // @ts-expect-error — testing the runtime CHECK
    await expect(store.update(t.id, { status: 'snoozed' })).rejects.toThrow()
  })
})
