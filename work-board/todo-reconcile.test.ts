import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { WorkBoardStore } from './store.ts'
import { openMigratedDbAt } from '../tests/support/migrated-db.ts'
import {
  normalizeTodos,
  reconcileTodosIntoBoard,
  todoStatusToBoardStatus,
  type TodoItem,
} from './todo-reconcile.ts'

let tmp: string
let db: ProjectDb
let store: WorkBoardStore
const SLUG = 'acme'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-todo-reconcile-'))
  db = openMigratedDbAt(join(tmp, 'project.db'))
  store = new WorkBoardStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const todo = (content: string, status: TodoItem['status']): TodoItem => ({
  content,
  status,
  activeForm: `doing ${content}`,
})

describe('todoStatusToBoardStatus', () => {
  test('maps CC status → board lane', () => {
    expect(todoStatusToBoardStatus('pending')).toBe('upcoming')
    expect(todoStatusToBoardStatus('in_progress')).toBe('in_progress')
    expect(todoStatusToBoardStatus('completed')).toBe('done')
  })
})

describe('normalizeTodos', () => {
  test('drops non-arrays, non-objects, bad content, bad status', () => {
    expect(normalizeTodos(undefined)).toEqual([])
    expect(normalizeTodos('nope')).toEqual([])
    expect(
      normalizeTodos([
        null,
        42,
        { content: '', status: 'pending' }, // empty content
        { content: '  ', status: 'pending' }, // whitespace-only content
        { content: 'ok', status: 'weird' }, // bad status
        { content: 'good', status: 'in_progress', activeForm: 'x' },
        { status: 'pending' }, // missing content
      ]),
    ).toEqual([{ content: 'good', status: 'in_progress', activeForm: 'x' }])
  })
})

describe('reconcileTodosIntoBoard', () => {
  test('first call creates one card per NEW todo, with mapped status', async () => {
    const res = await reconcileTodosIntoBoard(store, SLUG, [
      todo('scaffold the module', 'in_progress'),
      todo('write the tests', 'pending'),
      todo('read the spec', 'completed'),
    ])
    expect(res.created).toBe(3)
    expect(res.updated).toBe(0)
    expect(res.matched).toBe(0)

    const items = store.list(SLUG)
    expect(items.length).toBe(3)
    const byTitle = new Map(items.map((i) => [i.title, i]))
    expect(byTitle.get('scaffold the module')?.status).toBe('in_progress')
    expect(byTitle.get('write the tests')?.status).toBe('upcoming')
    expect(byTitle.get('read the spec')?.status).toBe('done')
    // task_type defaults to 'build' for a synced todo.
    expect(byTitle.get('write the tests')?.task_type).toBe('build')
  })

  test('IDEMPOTENCY — second call with the SAME list creates ZERO new cards and issues ZERO updates', async () => {
    const list = [
      todo('scaffold the module', 'in_progress'),
      todo('write the tests', 'pending'),
    ]
    const first = await reconcileTodosIntoBoard(store, SLUG, list)
    expect(first.created).toBe(2)

    const before = store.list(SLUG)
    const second = await reconcileTodosIntoBoard(store, SLUG, list)
    expect(second.created).toBe(0)
    expect(second.updated).toBe(0)
    expect(second.matched).toBe(2)

    const after = store.list(SLUG)
    expect(after.length).toBe(2)
    // No churn: same ids, same updated_at (no write happened).
    expect(after.map((i) => i.id).sort()).toEqual(before.map((i) => i.id).sort())
    for (const item of after) {
      const prev = before.find((p) => p.id === item.id)!
      expect(item.updated_at).toBe(prev.updated_at)
    }
  })

  test('a status transition on an existing todo updates the linked card', async () => {
    await reconcileTodosIntoBoard(store, SLUG, [todo('ship it', 'in_progress')])
    const [card] = store.list(SLUG)
    expect(card!.status).toBe('in_progress')

    const res = await reconcileTodosIntoBoard(store, SLUG, [todo('ship it', 'completed')])
    expect(res.created).toBe(0)
    expect(res.updated).toBe(1)
    expect(res.matched).toBe(1)

    const done = store.get(SLUG, card!.id)
    expect(done?.status).toBe('done')
    expect(done?.completed_at).not.toBeNull()
  })

  test('adds only the NEW todos when the list grows, matches the rest', async () => {
    await reconcileTodosIntoBoard(store, SLUG, [todo('step one', 'completed')])
    const res = await reconcileTodosIntoBoard(store, SLUG, [
      todo('step one', 'completed'), // matched, unchanged
      todo('step two', 'in_progress'), // new
    ])
    expect(res.created).toBe(1)
    expect(res.updated).toBe(0)
    expect(res.matched).toBe(1)
    expect(store.list(SLUG).length).toBe(2)
  })

  test('empty / invalid list is a no-op (the board-less edge)', async () => {
    const res = await reconcileTodosIntoBoard(store, SLUG, [])
    expect(res).toEqual({ created: 0, updated: 0, matched: 0 })
    expect(store.list(SLUG).length).toBe(0)
  })

  test('duplicate titles within ONE list produce a single card', async () => {
    const res = await reconcileTodosIntoBoard(store, SLUG, [
      todo('same task', 'pending'),
      todo('same  task', 'in_progress'), // sanitizes to the same title
    ])
    expect(res.created).toBe(1)
    expect(store.list(SLUG).length).toBe(1)
  })

  test('scope isolation — a todo synced to project A never lands on project B', async () => {
    await reconcileTodosIntoBoard(store, 'proj-a', [todo('a work', 'pending')])
    await reconcileTodosIntoBoard(store, 'proj-b', [todo('b work', 'pending')])
    expect(store.list('proj-a').map((i) => i.title)).toEqual(['a work'])
    expect(store.list('proj-b').map((i) => i.title)).toEqual(['b work'])
  })

  test('matches an ACTIVE card of the same title over a stale completed one', async () => {
    // Two cards share a title: one done (history), one active. A pending todo of
    // that title should match the ACTIVE one (list() returns active first).
    const active = await store.create(SLUG, { title: 'dup', status: 'upcoming' })
    await store.create(SLUG, { title: 'dup', status: 'done' })
    const res = await reconcileTodosIntoBoard(store, SLUG, [todo('dup', 'in_progress')])
    expect(res.created).toBe(0)
    expect(res.updated).toBe(1)
    expect(store.get(SLUG, active.id)?.status).toBe('in_progress')
  })
})
