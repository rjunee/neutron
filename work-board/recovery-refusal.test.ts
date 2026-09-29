import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { WorkBoardStore, type WorkBoardItem, type WorkBoardRecoveryRefusalTarget } from './store.ts'

let dir: string
let db: ProjectDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'board-recovery-refusal-'))
  seedMigratedDb(join(dir, 'project.db'))
  db = ProjectDb.open(join(dir, 'project.db'))
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

function observed(card: WorkBoardItem): WorkBoardRecoveryRefusalTarget {
  if (!['failed', 'blocked', 'upcoming'].includes(card.status)) throw new Error('Fixture must be recoverable')
  return { linked_run_id: card.linked_run_id, status: card.status as WorkBoardRecoveryRefusalTarget['status'], updated_at: card.updated_at }
}

test('a refusal with no new run survives restart and preserves binding, spend, ordering, PR and attempts', async () => {
  const notifications: string[] = []
  const store = new WorkBoardStore(db, { onChange: board => notifications.push(board) })
  const card = await store.create('board', { title: 'Rejected plan' })
  await store.attachRun('board', card.id, 'source')
  await store.detachRun('board', 'source', 'blocked', {
    pr: 12, pr_url: 'https://example.test/pull/12', task_iteration: 7, max_task_iterations: 9,
  })
  const before = store.get('board', card.id)!
  notifications.length = 0
  expect(await store.recordRecoveryRefusal('board', card.id, observed(before), 'Recovery refused: published head moved.')).toBe(true)
  expect(notifications).toEqual(['board'])
  const after = store.get('board', card.id)!
  expect(after).toMatchObject({
    status: 'blocked', linked_run_id: 'source', recovery_refusal: 'Recovery refused: published head moved.',
    task_iteration: 7, max_task_iterations: 9, sort_order: before.sort_order,
    pr: before.pr, pr_url: before.pr_url, attempts: before.attempts, completed_at: null, inline_active: false,
  })
  expect(store.listActive('board').map(row => row.id)).toContain(card.id)
  db.close()
  db = ProjectDb.open(join(dir, 'project.db'))
  expect(new WorkBoardStore(db).get('board', card.id)?.recovery_refusal).toBe(after.recovery_refusal)
})

test('a historical source refusal preserves the different current failed binding and a headless refusal is still durable', async () => {
  const store = new WorkBoardStore(db)
  const card = await store.create('board', { title: 'Older source' })
  await store.attachRun('board', card.id, 'historical')
  await store.detachRun('board', 'historical', 'blocked')
  await store.attachRun('board', card.id, 'current')
  await store.detachRun('board', 'current', 'failed')
  const before = store.get('board', card.id)!
  expect(await store.recordRecoveryRefusal('board', card.id, observed(before), 'Recovery refused: historical source exhausted.')).toBe(true)
  expect(store.get('board', card.id)).toMatchObject({ status: 'blocked', linked_run_id: 'current', attempts: before.attempts })
  const headless = await store.create('board', { title: 'Missing binding' })
  expect(await store.recordRecoveryRefusal('board', headless.id, observed(headless), 'Recovery refused: no source.')).toBe(true)
  expect(store.get('board', headless.id)).toMatchObject({ status: 'blocked', linked_run_id: null, recovery_refusal: 'Recovery refused: no source.', attempts: [] })
})

test('foreign scope, stale binding, stale status and stale timestamp cannot write or notify', async () => {
  let tick = 0
  const notifications: string[] = []
  const store = new WorkBoardStore(db, {
    now: () => new Date(Date.UTC(2026, 8, 29, 0, 0, tick++)).toISOString(),
    onChange: board => notifications.push(board),
  })
  const card = await store.create('board', { title: 'Observed' })
  await store.attachRun('board', card.id, 'source')
  await store.detachRun('board', 'source', 'blocked')
  const before = store.get('board', card.id)!
  notifications.length = 0
  for (const [board, expected] of [
    ['foreign', observed(before)],
    ['board', { ...observed(before), linked_run_id: 'other' }],
    ['board', { ...observed(before), status: 'failed' as const }],
    ['board', { ...observed(before), updated_at: card.updated_at }],
  ] as const) expect(await store.recordRecoveryRefusal(board, card.id, expected, 'Wrong refusal')).toBe(false)
  expect(store.get('board', card.id)).toEqual(before)
  expect(notifications).toEqual([])
  await store.attachRun('board', card.id, 'new')
  await store.detachRun('board', 'new', 'blocked')
  expect(await store.recordRecoveryRefusal('board', card.id, observed(before), 'Late refusal')).toBe(false)
  expect(store.get('board', card.id)).toMatchObject({ linked_run_id: 'new', recovery_refusal: null })
})

test('active, inline, shelved, completed and unexpectedly live cards refuse without changing evidence', async () => {
  const store = new WorkBoardStore(db, { isRunLive: id => id === 'still-live' })
  for (const mode of ['in_progress', 'inline', 'archived', 'done', 'live'] as const) {
    const card = await store.create('board', { title: mode })
    if (mode === 'inline') await store.setInlineActive('board', card.id, true)
    else if (mode === 'live') {
      await store.bindRun('board', card.id, 'still-live')
      await store.update('board', card.id, { status: 'blocked' })
    } else await store.update('board', card.id, { status: mode })
    const before = store.get('board', card.id)!
    // Runtime callers cannot widen the permitted status set with a cast.
    const target = { linked_run_id: before.linked_run_id, status: before.status, updated_at: before.updated_at } as WorkBoardRecoveryRefusalTarget
    expect(await store.recordRecoveryRefusal('board', card.id, target, 'Refused')).toBe(false)
    expect(store.get('board', card.id)).toEqual(before)
  }
})

test('only a successful new binding clears a refusal; ordinary input cannot fabricate or clear it', async () => {
  const store = new WorkBoardStore(db)
  const card = await store.create('board', { title: 'Protected reason', ...{ recovery_refusal: 'Fabricated' } })
  expect(card.recovery_refusal).toBeNull()
  await store.attachRun('board', card.id, 'source')
  await store.detachRun('board', 'source', 'blocked')
  expect(await store.recordRecoveryRefusal('board', card.id, observed(store.get('board', card.id)!), 'Recovery refused: budget spent.')).toBe(true)
  await store.update('board', card.id, { title: 'Renamed', ...{ recovery_refusal: 'Fabricated' } })
  expect(store.get('board', card.id)?.recovery_refusal).toBe('Recovery refused: budget spent.')
  await store.attachRun('board', card.id, 'source')
  expect(store.get('board', card.id)?.recovery_refusal).toBe('Recovery refused: budget spent.')
  await store.update('board', card.id, { status: 'upcoming', ...{ recovery_refusal: null } })
  expect(store.get('board', card.id)?.recovery_refusal).toBe('Recovery refused: budget spent.')
  const attempts = store.get('board', card.id)?.attempts
  expect(await store.attachRun('foreign', card.id, 'new')).toBeNull()
  expect(store.get('board', card.id)?.recovery_refusal).toBe('Recovery refused: budget spent.')
  expect(await store.attachRun('board', card.id, 'new')).toMatchObject({ status: 'in_progress', linked_run_id: 'new', recovery_refusal: null, attempts })
})

test('blank refusal reasons refuse before mutation and multiline reasons are bounded', async () => {
  const store = new WorkBoardStore(db)
  const card = await store.create('board', { title: 'Bounded reason' })
  await expect(store.recordRecoveryRefusal('board', card.id, observed(card), ' \n ')).rejects.toThrow('must have a reason')
  expect(store.get('board', card.id)?.recovery_refusal).toBeNull()
  expect(await store.recordRecoveryRefusal('board', card.id, observed(card), 'Recovery\n refused: ' + 'a'.repeat(3000))).toBe(true)
  const reason = store.get('board', card.id)!.recovery_refusal!
  expect(reason.startsWith('Recovery refused: ')).toBe(true)
  expect(reason).toHaveLength(2048)
})

test('recovery bind joins its claim transaction and only publishes after commit', async () => {
  const notifications: string[] = []
  const store = new WorkBoardStore(db, { onChange: board => notifications.push(board) })
  const card = await store.create('board', { title: 'Atomic recovery' })
  await store.attachRun('board', card.id, 'source')
  await store.detachRun('board', 'source', 'blocked', { pr: 17, pr_url: 'https://example.test/pull/17' })
  const before = store.get('board', card.id)!
  expect(await store.recordRecoveryRefusal('board', card.id, observed(before), 'Recovery refused: stale head.')).toBe(true)
  const refusal = store.get('board', card.id)!
  notifications.length = 0
  await db.transaction(async tx => {
    expect(store.attachRecoveryRunInTransaction(tx, 'foreign', card.id, 'new', observed(refusal))).toBe(false)
    expect(store.attachRecoveryRunInTransaction(tx, 'board', card.id, 'new', observed(before))).toBe(false)
    expect(store.attachRecoveryRunInTransaction(tx, 'board', card.id, 'source', observed(refusal))).toBe(false)
    expect(store.attachRecoveryRunInTransaction(tx, 'board', card.id, 'new', observed(refusal))).toBe(true)
    expect(store.attachRecoveryRunInTransaction(tx, 'board', card.id, 'second', observed(refusal))).toBe(false)
    // The caller has not committed its source claim yet, so a push is premature.
    expect(notifications).toEqual([])
  })
  store.notifyRecoveryBindingCommitted('board')
  expect(notifications).toEqual(['board'])
  expect(store.get('board', card.id)).toMatchObject({
    status: 'in_progress', linked_run_id: 'new', recovery_refusal: null,
    pr: null, pr_url: null, attempts: refusal.attempts,
    task_iteration: refusal.task_iteration, max_task_iterations: refusal.max_task_iterations,
  })
})

test('a rolled back recovery transaction leaves its refusal and source untouched', async () => {
  const store = new WorkBoardStore(db)
  const card = await store.create('board', { title: 'Rollback' })
  expect(await store.recordRecoveryRefusal('board', card.id, observed(card), 'Recovery refused.')).toBe(true)
  const before = store.get('board', card.id)!
  await expect(db.transaction(async tx => {
    expect(store.attachRecoveryRunInTransaction(tx, 'board', card.id, 'new', observed(before))).toBe(true)
    throw new Error('claim failed')
  })).rejects.toThrow('claim failed')
  expect(store.get('board', card.id)).toEqual(before)
})
