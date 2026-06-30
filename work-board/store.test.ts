import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import {
  sanitizeTitle,
  validateDesignDocRef,
  WorkBoardStore,
  WorkBoardValidationError,
} from './store.ts'

let tmp: string
let db: ProjectDb
const SLUG = 'acme'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-work-board-store-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('WorkBoardStore', () => {
  test('migration applies — work_board_items table exists', () => {
    const row = db
      .prepare<{ name: string }, [string]>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get('work_board_items')
    expect(row?.name).toBe('work_board_items')
  })

  test('create appends at end with defaults + round-trips', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'first thing' })
    const b = await store.create(SLUG, { title: 'second thing' })
    expect(a.status).toBe('upcoming')
    expect(a.inline_active).toBe(false)
    expect(a.linked_run_id).toBeNull()
    expect(a.completed_at).toBeNull()
    expect(a.sort_order).toBe(1)
    expect(b.sort_order).toBe(2)
    const got = store.get(SLUG, a.id)
    expect(got?.title).toBe('first thing')
  })

  test('title is newline-stripped + length-capped at the store', async () => {
    const store = new WorkBoardStore(db)
    const item = await store.create(SLUG, { title: '  multi\nline\t  title  ' })
    expect(item.title).toBe('multi line title')
    const long = await store.create(SLUG, { title: 'x'.repeat(500) })
    expect(long.title.length).toBe(256)
  })

  test('create with status=done stamps completed_at', async () => {
    const store = new WorkBoardStore(db, { now: () => '2026-06-29T00:00:00.000Z' })
    const item = await store.create(SLUG, { title: 'already done', status: 'done' })
    expect(item.completed_at).toBe('2026-06-29T00:00:00.000Z')
  })

  test('complete stamps completed_at; re-open OFF done nulls it', async () => {
    const store = new WorkBoardStore(db)
    const item = await store.create(SLUG, { title: 'ship it' })
    const done = await store.complete(SLUG, item.id)
    expect(done?.status).toBe('done')
    expect(done?.completed_at).not.toBeNull()
    const reopened = await store.update(SLUG, item.id, { status: 'in_progress' })
    expect(reopened?.status).toBe('in_progress')
    expect(reopened?.completed_at).toBeNull()
  })

  test('re-opening a done item re-appends it to the END of the active lane (no stale sort_order collision)', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'A' }) // sort 1
    const b = await store.create(SLUG, { title: 'B' }) // sort 2
    const c = await store.create(SLUG, { title: 'C' }) // sort 3
    // Complete A (its sort_order 1 is now a stale done-row value), then reorder
    // the active lane so B/C renumber to 1,2 — A's stale 1 would collide.
    await store.complete(SLUG, a.id)
    await store.reorder(SLUG, c.id, { before: b.id }) // active: C(1), B(2)
    // Re-open A — it must land at the END of the active lane, not at sort 1.
    const reopened = await store.update(SLUG, a.id, { status: 'upcoming' })
    expect(reopened?.completed_at).toBeNull()
    const active = store.listActive(SLUG)
    expect(active.map((it) => it.title)).toEqual(['C', 'B', 'A'])
    // No duplicate sort_order values across the active lane.
    const orders = active.map((it) => it.sort_order)
    expect(new Set(orders).size).toBe(orders.length)
    expect(orders[orders.length - 1]).toBe(Math.max(...orders))
  })

  test('re-completing an already-done item does NOT refresh completed_at or reorder history', async () => {
    let tick = 0
    const store = new WorkBoardStore(db, {
      now: () => new Date(Date.UTC(2026, 5, 29, 0, 0, ++tick)).toISOString(),
    })
    const item = await store.create(SLUG, { title: 'done thing' })
    const first = await store.complete(SLUG, item.id)
    const stamp = first?.completed_at
    expect(stamp).not.toBeNull()
    // Idempotent: completing again (or PATCH status=done) must preserve it.
    const again = await store.complete(SLUG, item.id)
    expect(again?.completed_at).toBe(stamp!)
    const viaUpdate = await store.update(SLUG, item.id, { status: 'done' })
    expect(viaUpdate?.completed_at).toBe(stamp!)
  })

  test('list orders active by sort_order then completed reverse-chron', async () => {
    // Monotonic clock so completed_at strictly increases (wall-clock ms can tie).
    let tick = 0
    const store = new WorkBoardStore(db, {
      now: () => new Date(Date.UTC(2026, 5, 29, 0, 0, ++tick)).toISOString(),
    })
    const a = await store.create(SLUG, { title: 'A' })
    const b = await store.create(SLUG, { title: 'B' })
    const c = await store.create(SLUG, { title: 'C' })
    // Complete A then C — C is completed later so should sort first.
    await store.complete(SLUG, a.id)
    await store.complete(SLUG, c.id)
    const list = store.list(SLUG)
    // Active first (only B), then completed reverse-chron (C before A).
    expect(list.map((it) => it.title)).toEqual(['B', 'C', 'A'])
    expect(store.listActive(SLUG).map((it) => it.title)).toEqual(['B'])
    expect(store.listCompleted(SLUG).map((it) => it.title)).toEqual(['C', 'A'])
  })

  test('reorder gap-renumbers the active lane (before/after)', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'A' })
    const b = await store.create(SLUG, { title: 'B' })
    const c = await store.create(SLUG, { title: 'C' })
    // Move C before A → C, A, B.
    await store.reorder(SLUG, c.id, { before: a.id })
    expect(store.listActive(SLUG).map((it) => it.title)).toEqual(['C', 'A', 'B'])
    // Sort orders are renumbered to a clean 1..N.
    expect(store.listActive(SLUG).map((it) => it.sort_order)).toEqual([1, 2, 3])
    // Move A after B → C, B, A.
    await store.reorder(SLUG, a.id, { after: b.id })
    expect(store.listActive(SLUG).map((it) => it.title)).toEqual(['C', 'B', 'A'])
  })

  test('reorder concurrently under a transaction stays consistent (no torn sort_order)', async () => {
    const store = new WorkBoardStore(db)
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await store.create(SLUG, { title: `T${i}` })).id)
    // Fire several reorders concurrently; the per-instance write mutex +
    // transaction must serialize them so the final lane is a clean permutation.
    await Promise.all([
      store.reorder(SLUG, ids[4]!, { before: ids[0]! }),
      store.reorder(SLUG, ids[3]!, { before: ids[0]! }),
      store.reorder(SLUG, ids[2]!, { after: ids[1]! }),
    ])
    const orders = store.listActive(SLUG).map((it) => it.sort_order)
    // No duplicate / torn sort_order values; a contiguous 1..5.
    expect([...orders].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5])
    expect(store.listActive(SLUG).length).toBe(5)
  })

  test('onChange fires after every committed mutation', async () => {
    let changes = 0
    const store = new WorkBoardStore(db, { onChange: () => void changes++ })
    const item = await store.create(SLUG, { title: 'A' })
    await store.update(SLUG, item.id, { title: 'A2' })
    await store.complete(SLUG, item.id)
    await store.setInlineActive(SLUG, item.id, true)
    await store.bindRun(SLUG, item.id, 'run-1')
    await store.reorder(SLUG, item.id, {})
    await store.delete(SLUG, item.id)
    expect(changes).toBe(7)
  })

  test('a throwing onChange never rolls back the committed write', async () => {
    const store = new WorkBoardStore(db, {
      onChange: () => {
        throw new Error('push exploded')
      },
    })
    const item = await store.create(SLUG, { title: 'survives' })
    expect(store.get(SLUG, item.id)?.title).toBe('survives')
  })

  test('project_slug scopes reads + writes (no cross-scope leakage)', async () => {
    const store = new WorkBoardStore(db)
    const mine = await store.create('me', { title: 'mine' })
    await store.create('other', { title: 'theirs' })
    expect(store.list('me').map((it) => it.title)).toEqual(['mine'])
    expect(store.get('other', mine.id)).toBeNull()
    // An update scoped to the wrong slug is a no-op (WHERE project_slug guards).
    const res = await store.update('other', mine.id, { title: 'hijacked' })
    expect(res).toBeNull()
    expect(store.get('me', mine.id)?.title).toBe('mine')
  })

  test('design_doc_ref scheme allow-list rejects javascript:/data:/file:', async () => {
    const store = new WorkBoardStore(db)
    await expect(
      store.create(SLUG, { title: 'x', design_doc_ref: 'javascript:alert(1)' }),
    ).rejects.toBeInstanceOf(WorkBoardValidationError)
    await expect(
      store.create(SLUG, { title: 'x', design_doc_ref: 'data:text/html,<b>' }),
    ).rejects.toBeInstanceOf(WorkBoardValidationError)
    await expect(
      store.create(SLUG, { title: 'x', design_doc_ref: 'file:///etc/passwd' }),
    ).rejects.toBeInstanceOf(WorkBoardValidationError)
    // https + in-app docs links are accepted.
    const ok1 = await store.create(SLUG, {
      title: 'a',
      design_doc_ref: 'https://example.com/doc',
    })
    expect(ok1.design_doc_ref).toBe('https://example.com/doc')
    const ok2 = await store.create(SLUG, {
      title: 'b',
      design_doc_ref: '/api/app/projects/acme/docs/plan.md',
    })
    expect(ok2.design_doc_ref).toBe('/api/app/projects/acme/docs/plan.md')
  })

  test('validateDesignDocRef + sanitizeTitle helpers', () => {
    expect(validateDesignDocRef('  ')).toBeNull()
    expect(validateDesignDocRef(null)).toBeNull()
    expect(validateDesignDocRef('https://x.com')).toBe('https://x.com')
    expect(() => validateDesignDocRef('ftp://x')).toThrow(WorkBoardValidationError)
    expect(sanitizeTitle('a\n\nb   c')).toBe('a b c')
  })
})
