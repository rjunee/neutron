import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  GENERAL_WORK_BOARD_PROJECT_ID,
  sanitizeTitle,
  validateDesignDocRef,
  workBoardProjectIdForKey,
  workBoardScopeKey,
  WorkBoardRunStillLiveError,
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

  test('listAllActive aggregates active items across ALL scopes (General + projects)', async () => {
    const store = new WorkBoardStore(db)
    await store.create(SLUG, { title: 'general item' }) // General/owner scope
    const proj = await store.create('proj-123', { title: 'project item' }) // a project scope
    const done = await store.create('proj-123', { title: 'finished item' })
    await store.complete('proj-123', done.id) // excluded (status=done)

    const all = store.listAllActive()
    const titles = all.map((it) => it.title)
    expect(titles).toContain('general item')
    expect(titles).toContain('project item')
    expect(titles).not.toContain('finished item')
    // Single-scope listActive would MISS the project item.
    expect(store.listActive(SLUG).map((it) => it.title)).not.toContain('project item')
    expect(all.some((it) => it.id === proj.id)).toBe(true)
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

  // ISSUES #386 — the rail's pulsing activity indicator is driven by
  // `inline_active`, so a TERMINAL row that still carries the flag renders the
  // project as perpetually-working and cannot self-heal (Ryan's `willow`
  // pulsed for days off exactly one such row). `update()`'s terminal transition
  // was fixed in 5909fe87, but `setInlineActive` stayed unguarded, leaving the
  // broken state reachable. These pin the closed hole.
  test('setInlineActive REFUSES to mark a done item inline-active', async () => {
    const store = new WorkBoardStore(db)
    const item = await store.create(SLUG, { title: 'finished work' })
    await store.complete(SLUG, item.id)
    expect(store.get(SLUG, item.id)?.status).toBe('done')

    await store.setInlineActive(SLUG, item.id, true)

    // Without the terminal guard this reads back `true` — the #386 bad state.
    expect(store.get(SLUG, item.id)?.inline_active).toBe(false)
    expect(store.get(SLUG, item.id)?.status).toBe('done')
  })

  test('setInlineActive REFUSES to mark a failed item inline-active', async () => {
    const store = new WorkBoardStore(db)
    const item = await store.create(SLUG, { title: 'broken work' })
    await store.update(SLUG, item.id, { status: 'failed' })

    await store.setInlineActive(SLUG, item.id, true)

    expect(store.get(SLUG, item.id)?.inline_active).toBe(false)
  })

  test('setInlineActive still works normally on a live (non-terminal) item, and clearing is always allowed', async () => {
    const store = new WorkBoardStore(db)
    const item = await store.create(SLUG, { title: 'live work' })

    // Guard must not break the ordinary path.
    await store.setInlineActive(SLUG, item.id, true)
    expect(store.get(SLUG, item.id)?.inline_active).toBe(true)

    // Completing clears it (the update() terminal transition).
    await store.complete(SLUG, item.id)
    expect(store.get(SLUG, item.id)?.inline_active).toBe(false)

    // Clearing on a terminal row is permitted — it only moves toward consistency.
    await store.setInlineActive(SLUG, item.id, false)
    expect(store.get(SLUG, item.id)?.inline_active).toBe(false)
  })

  test('migration 0108 heals a pre-existing terminal row that still carries inline_active', async () => {
    const store = new WorkBoardStore(db)
    const item = await store.create(SLUG, { title: 'legacy stuck row' })
    await store.complete(SLUG, item.id)

    // Forge the exact pre-5909fe87 bad state the migration exists to sweep up,
    // bypassing the (now-guarded) store API via raw SQL.
    db.raw().run(`UPDATE work_board_items SET inline_active = 1 WHERE id = ?`, [item.id])
    expect(store.get(SLUG, item.id)?.inline_active).toBe(true)
    expect(store.get(SLUG, item.id)?.status).toBe('done')

    // The heal statement is idempotent and terminal-scoped.
    db.raw().run(
      `UPDATE work_board_items SET inline_active = 0
        WHERE inline_active = 1 AND status IN ('done', 'failed')`,
    )

    expect(store.get(SLUG, item.id)?.inline_active).toBe(false)
  })

  test('the heal statement leaves live inline-active work untouched', async () => {
    const store = new WorkBoardStore(db)
    const live = await store.create(SLUG, { title: 'genuinely running' })
    await store.setInlineActive(SLUG, live.id, true)

    db.raw().run(
      `UPDATE work_board_items SET inline_active = 0
        WHERE inline_active = 1 AND status IN ('done', 'failed')`,
    )

    // Still marked — the heal must never clear active work.
    expect(store.get(SLUG, live.id)?.inline_active).toBe(true)
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

/**
 * The SHELVED lane (migration 0122). Acceptance (b) of the removal card: a
 * deprioritised card must be counted as completed NOWHERE, so `done` and
 * `archived` stop sharing one word.
 *
 * These are the mutant-red pins. A mutant that buckets archived with done
 * (e.g. `listCompleted` widened to `status IN ('done','archived')`, or `list()`
 * folding the two), or that stamps `completed_at` on the archive transition,
 * FAILS here.
 */
describe('WorkBoardStore — the SHELVED lane (status=archived)', () => {
  test('→archived leaves the active lane, clears inline_active, and NEVER stamps completed_at', async () => {
    const store = new WorkBoardStore(db, { now: () => '2026-08-14T00:00:00.000Z' })
    const a = await store.create(SLUG, { title: 'deprioritised email card' })
    await store.create(SLUG, { title: 'still active' })
    await store.update(SLUG, a.id, { inline_active: true })
    expect(store.get(SLUG, a.id)?.inline_active).toBe(true)

    const shelved = await store.update(SLUG, a.id, { status: 'archived' })
    expect(shelved?.status).toBe('archived')
    // (iii) shelved ≠ shipped — no completion datestamp, ever.
    expect(shelved?.completed_at).toBeNull()
    // A shelved card can never still claim live inline work.
    expect(shelved?.inline_active).toBe(false)

    // (i) gone from every ACTIVE surface (this is also what drops it from the
    // per-turn prompt fragment, which rides listActive).
    expect(store.listActive(SLUG).map((i) => i.id)).not.toContain(a.id)
    expect(store.listAllActive().map((i) => i.id)).not.toContain(a.id)
    // (ii) present in NO completed list — not the history, not the count.
    expect(store.listCompleted(SLUG).map((i) => i.id)).not.toContain(a.id)
    expect(store.listCompleted(SLUG)).toHaveLength(0)
    // (iv) still on the board, in its own bucket.
    expect(store.listArchived(SLUG).map((i) => i.id)).toEqual([a.id])
    expect(store.list(SLUG).map((i) => i.id)).toContain(a.id)
  })

  test('list() orders active → archived → completed', async () => {
    const store = new WorkBoardStore(db)
    const active = await store.create(SLUG, { title: 'active' })
    const shelved = await store.create(SLUG, { title: 'shelved' })
    const done = await store.create(SLUG, { title: 'done' })
    await store.update(SLUG, shelved.id, { status: 'archived' })
    await store.complete(SLUG, done.id)
    expect(store.list(SLUG).map((i) => i.id)).toEqual([active.id, shelved.id, done.id])
  })

  test('shelving a DONE card nulls completed_at (it stops counting as progress)', async () => {
    const store = new WorkBoardStore(db, { now: () => '2026-08-14T00:00:00.000Z' })
    const a = await store.create(SLUG, { title: 'was marked done by mistake' })
    await store.complete(SLUG, a.id)
    expect(store.get(SLUG, a.id)?.completed_at).not.toBeNull()

    const shelved = await store.update(SLUG, a.id, { status: 'archived' })
    expect(shelved?.status).toBe('archived')
    expect(shelved?.completed_at).toBeNull()
    expect(store.listCompleted(SLUG)).toHaveLength(0)
    expect(store.listArchived(SLUG).map((i) => i.id)).toEqual([a.id])
  })

  test('un-shelving re-appends to the END of the active lane', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'first' }) // sort_order 1
    await store.create(SLUG, { title: 'second' }) // sort_order 2
    const c = await store.create(SLUG, { title: 'third' }) // sort_order 3
    await store.update(SLUG, a.id, { status: 'archived' })

    const back = await store.update(SLUG, a.id, { status: 'upcoming' })
    expect(back?.status).toBe('upcoming')
    // Its stale sort_order (1) must not collide with the renumbered active lane.
    expect(back?.sort_order).toBe(c.sort_order + 1)
    expect(store.listActive(SLUG).map((i) => i.id).at(-1)).toBe(a.id)
    expect(store.listArchived(SLUG)).toHaveLength(0)
  })

  test('reorder ignores an archived row (it is not in the active lane)', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'a' })
    const b = await store.create(SLUG, { title: 'b' })
    const c = await store.create(SLUG, { title: 'c' })
    await store.update(SLUG, b.id, { status: 'archived' })

    // Moving the archived row is a no-op…
    await store.reorder(SLUG, b.id, { before: a.id })
    expect(store.listActive(SLUG).map((i) => i.id)).toEqual([a.id, c.id])
    expect(store.get(SLUG, b.id)?.status).toBe('archived')
    // …and the archived row is not a reorder TARGET either — the lane renumbers
    // to a clean 1..N over the two active rows only.
    await store.reorder(SLUG, c.id, { before: a.id })
    expect(store.listActive(SLUG).map((i) => [i.id, i.sort_order])).toEqual([
      [c.id, 1],
      [a.id, 2],
    ])
  })

  test('archiving a card whose bound run is LIVE is REFUSED', async () => {
    const live = new WorkBoardStore(db, { isRunLive: () => true })
    const a = await live.create(SLUG, { title: 'building right now' })
    await live.attachRun(SLUG, a.id, 'run-live')

    let caught: unknown = null
    try {
      await live.update(SLUG, a.id, { status: 'archived' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(WorkBoardRunStillLiveError)
    expect((caught as WorkBoardRunStillLiveError).run_id).toBe('run-live')
    // The refusal happened BEFORE any write — the card is untouched.
    expect(live.get(SLUG, a.id)?.status).toBe('in_progress')
    expect(live.listArchived(SLUG)).toHaveLength(0)
  })

  test('archiving the same card succeeds once its run is no longer live', async () => {
    const dead = new WorkBoardStore(db, { isRunLive: () => false })
    const a = await dead.create(SLUG, { title: 'its build already ended' })
    await dead.attachRun(SLUG, a.id, 'run-over')
    const shelved = await dead.update(SLUG, a.id, { status: 'archived' })
    expect(shelved?.status).toBe('archived')
    expect(shelved?.completed_at).toBeNull()
    expect(dead.listArchived(SLUG).map((i) => i.id)).toEqual([a.id])
  })

  test('the live-run guard covers ONLY the →archived transition', async () => {
    const live = new WorkBoardStore(db, { isRunLive: () => true })
    const a = await live.create(SLUG, { title: 'building right now' })
    await live.attachRun(SLUG, a.id, 'run-live')
    // A title edit, and a status move that is not a shelving, still go through.
    const renamed = await live.update(SLUG, a.id, { title: 'renamed mid-build' })
    expect(renamed?.title).toBe('renamed mid-build')
    const requeued = await live.update(SLUG, a.id, { status: 'upcoming' })
    expect(requeued?.status).toBe('upcoming')
  })
})

describe('WorkBoardStore — Phase 2b run binding + reconcile', () => {
  test('inline_active is settable via update (the caret writer)', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'work inline on me' })
    const updated = await store.update(SLUG, a.id, { inline_active: true })
    expect(updated?.inline_active).toBe(true)
    expect((await store.update(SLUG, a.id, { inline_active: false }))?.inline_active).toBe(false)
  })

  test('generic complete() clears inline_active (terminal transition)', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'complete me inline' })
    await store.update(SLUG, a.id, { inline_active: true })
    const done = await store.complete(SLUG, a.id)
    expect(done?.status).toBe('done')
    expect(done?.completed_at).not.toBeNull()
    expect(done?.inline_active).toBe(false)
    // also persisted, not just returned
    expect(store.get(SLUG, a.id)?.inline_active).toBe(false)
  })

  test('generic update to failed clears inline_active', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'fail me inline' })
    await store.update(SLUG, a.id, { inline_active: true, status: 'in_progress' })
    const failed = await store.update(SLUG, a.id, { status: 'failed' })
    expect(failed?.status).toBe('failed')
    expect(failed?.inline_active).toBe(false)
  })

  test('terminal clear wins over explicit inline_active:true in the same patch', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'done but trying to stay active' })
    const result = await store.update(SLUG, a.id, { status: 'done', inline_active: true })
    expect(result?.status).toBe('done')
    expect(result?.inline_active).toBe(false)
  })

  test('non-terminal status transition preserves inline_active', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'go in progress while inline' })
    await store.update(SLUG, a.id, { inline_active: true })
    const inProgress = await store.update(SLUG, a.id, { status: 'in_progress' })
    expect(inProgress?.inline_active).toBe(true)
  })

  test('attachRun binds linked_run_id, moves to in_progress, clears inline, fires onChange', async () => {
    let pushes = 0
    const store = new WorkBoardStore(db, { onChange: () => (pushes += 1) })
    const a = await store.create(SLUG, { title: 'build me' })
    await store.update(SLUG, a.id, { inline_active: true })
    pushes = 0
    const bound = await store.attachRun(SLUG, a.id, 'run-1')
    expect(bound?.linked_run_id).toBe('run-1')
    expect(bound?.status).toBe('in_progress')
    expect(bound?.inline_active).toBe(false)
    expect(pushes).toBe(1)
  })

  test('getByRunId finds the bound item (project-scoped)', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'find me by run' })
    await store.attachRun(SLUG, a.id, 'run-xyz')
    expect(store.getByRunId(SLUG, 'run-xyz')?.id).toBe(a.id)
    expect(store.getByRunId('other-project', 'run-xyz')).toBeNull()
    expect(store.getByRunId(SLUG, 'no-such-run')).toBeNull()
  })

  test('detachRun(done) clears the binding + completes (datestamped history)', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'finish me' })
    await store.attachRun(SLUG, a.id, 'run-done')
    const done = await store.detachRun(SLUG, 'run-done', 'done')
    expect(done?.status).toBe('done')
    expect(done?.linked_run_id).toBeNull()
    expect(done?.completed_at).not.toBeNull()
  })

  test('detachRun(failed) marks the item FAILED and KEEPS the run link (#340), no datestamp', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'fail me' })
    await store.attachRun(SLUG, a.id, 'run-fail')
    const failed = await store.detachRun(SLUG, 'run-fail', 'failed')
    // #340 — FAILED lane, link KEPT so the client shows red + reason + retry.
    expect(failed?.status).toBe('failed')
    expect(failed?.linked_run_id).toBe('run-fail')
    expect(failed?.completed_at).toBeNull()
  })

  test('a failed item RETRIES cleanly: attachRun overwrites the link + flips to in_progress', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'retry me' })
    await store.attachRun(SLUG, a.id, 'run-1')
    await store.detachRun(SLUG, 'run-1', 'failed')
    // ▶/↻ retry — a fresh run supersedes the failed one.
    const retried = await store.attachRun(SLUG, a.id, 'run-2')
    expect(retried?.status).toBe('in_progress')
    expect(retried?.linked_run_id).toBe('run-2')
    // ...and a subsequent success completes + unlinks it (no stale failed state).
    const done = await store.detachRun(SLUG, 'run-2', 'done')
    expect(done?.status).toBe('done')
    expect(done?.linked_run_id).toBeNull()
  })

  test('manually advancing a failed card off the failed lane DETACHES the terminal run', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'requeue me' })
    await store.attachRun(SLUG, a.id, 'run-1')
    await store.detachRun(SLUG, 'run-1', 'failed')
    // The status-dot advance: nextStatus('failed') → 'upcoming'. The stale failed
    // run link must go, or the card renders red-dot/failed with status='upcoming'.
    const requeued = await store.update(SLUG, a.id, { status: 'upcoming' })
    expect(requeued?.status).toBe('upcoming')
    expect(requeued?.linked_run_id).toBeNull()
  })

  test('detachRun is a safe no-op when no item is bound to the run', async () => {
    const store = new WorkBoardStore(db)
    expect(await store.detachRun(SLUG, 'ghost-run', 'done')).toBeNull()
  })

  test('clearRun only clears when run_id is still the bound run (concurrent-safe)', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'shared item' })
    await store.attachRun(SLUG, a.id, 'run-1')
    await store.attachRun(SLUG, a.id, 'run-2') // run-2 supersedes run-1's binding
    // run-1 finishing must NOT clear run-2's still-live marker.
    await store.clearRun(SLUG, a.id, 'run-1')
    expect(store.get(SLUG, a.id)?.linked_run_id).toBe('run-2')
    // run-2 finishing clears it (it IS the bound run).
    await store.clearRun(SLUG, a.id, 'run-2')
    expect(store.get(SLUG, a.id)?.linked_run_id).toBeNull()
  })

  test('attachRun re-opening a done item clears completed_at + re-appends to the active lane', async () => {
    const store = new WorkBoardStore(db)
    const a = await store.create(SLUG, { title: 'reopen me' })
    await store.create(SLUG, { title: 'other active' })
    await store.complete(SLUG, a.id)
    expect(store.get(SLUG, a.id)?.completed_at).not.toBeNull()
    const reopened = await store.attachRun(SLUG, a.id, 'run-reopen')
    expect(reopened?.status).toBe('in_progress')
    expect(reopened?.completed_at).toBeNull()
    expect(reopened?.linked_run_id).toBe('run-reopen')
  })
})

describe('workBoardScopeKey / workBoardProjectIdForKey (Bug 3 per-project scoping)', () => {
  const OWNER = 'owner'

  test('General (empty / general / undefined) → the bare owner slug', () => {
    expect(workBoardScopeKey(OWNER, '')).toBe(OWNER)
    expect(workBoardScopeKey(OWNER, GENERAL_WORK_BOARD_PROJECT_ID)).toBe(OWNER)
    expect(workBoardScopeKey(OWNER, undefined)).toBe(OWNER)
    expect(workBoardScopeKey(OWNER, null)).toBe(OWNER)
    expect(workBoardScopeKey(OWNER, '   ')).toBe(OWNER)
  })

  test('a real project id → the id verbatim (distinct per project)', () => {
    expect(workBoardScopeKey(OWNER, 'acme')).toBe('acme')
    expect(workBoardScopeKey(OWNER, 'northwind')).toBe('northwind')
    expect(workBoardScopeKey(OWNER, 'acme')).not.toBe(workBoardScopeKey(OWNER, 'northwind'))
  })

  test('the frame project_id reverses the key: General → undefined, project → the id', () => {
    expect(workBoardProjectIdForKey(OWNER, OWNER)).toBeUndefined()
    expect(workBoardProjectIdForKey(OWNER, 'acme')).toBe('acme')
    // round-trip a real project
    const key = workBoardScopeKey(OWNER, 'acme')
    expect(workBoardProjectIdForKey(OWNER, key)).toBe('acme')
    // round-trip General → no tag
    const gkey = workBoardScopeKey(OWNER, 'general')
    expect(workBoardProjectIdForKey(OWNER, gkey)).toBeUndefined()
  })

  test('onChange receives the storage key of the board that mutated', async () => {
    const keys: string[] = []
    const store = new WorkBoardStore(db, { onChange: (k) => keys.push(k) })
    await store.create('acme', { title: 'in acme' })
    await store.create('owner', { title: 'in general' })
    expect(keys).toEqual(['acme', 'owner'])
  })
})
