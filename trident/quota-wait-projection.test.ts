import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { deriveQuotaWait } from './run-progress.ts'
import { TridentRunStore } from './store.ts'
import { quotaWaitEvents } from './testing/quota-wait-events.ts'

let directory: string
let db: ProjectDb
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'quota-projection-'))
  seedMigratedDb(join(directory, 'project.db'))
  db = ProjectDb.open(join(directory, 'project.db'))
})
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })

test('bounded durable query retains a nested synthesis wait through restart and excludes foreign host/child steps', async () => {
  let store = new TridentRunStore(db)
  const created = await store.create({ slug: 'nested-quota', project_slug: 'project', repo_path: '/repo', task: 'review' })
  await store.update(created.id, { worktree: '/worktree' })
  const run = store.get(created.id)!
  const parentStepId = `${run.id}:review:1:head:${'a'.repeat(40)}`
  const stepId = `review-${'b'.repeat(64)}:1:0`
  const events = quotaWaitEvents(run, 1_800_000_000_000, { parentStepId, stepId })
  for (const event of events) await store.recordStageEvent(run.id, event.stage, event.meta)
  for (let i = 0; i < 100; i++) await store.recordStageEvent(run.id, 'unrelated-noise', '{}')
  await store.recordStageEvent(run.id, 'claude-native-child-bound', JSON.stringify({ parentStepId: `${run.id}:review:2`, stepId, childId: 'foreign-child' }))
  for (const identity of [{ stepId: parentStepId, childId: 'native-child-current' },
    { stepId, childId: 'foreign-child' }, { stepId: `${stepId}:foreign`, childId: 'native-child-current' }]) {
    await store.recordStageEvent(run.id, 'claude-quota-wait-ended', JSON.stringify(identity))
  }
  db.close()
  db = ProjectDb.open(join(directory, 'project.db'))
  store = new TridentRunStore(db)
  const allHistory = spyOn(store, 'stageEvents').mockImplementation(() => { throw Error('Projection must not read complete history') })
  const selected = store.quotaWaitEvents(run.id)
  expect(selected).toHaveLength(3)
  expect(selected.map(event => event.stage)).toEqual(events.map(event => event.stage))
  expect(deriveQuotaWait(store.get(run.id)!, selected)).toEqual({ retry_at: '2027-01-15T08:00:00.000Z' })
  expect(allHistory).not.toHaveBeenCalled()
  await store.recordStageEvent(run.id, 'claude-quota-resumed', events[2]!.meta)
  expect(deriveQuotaWait(run, store.quotaWaitEvents(run.id))).toBeNull()
  await store.recordStageEvent(run.id, 'claude-quota-waiting', events[2]!.meta)
  expect(deriveQuotaWait(run, store.quotaWaitEvents(run.id))).not.toBeNull()
  await store.recordStageEvent(run.id, 'claude-native-child-bound', events[1]!.meta)
  expect(deriveQuotaWait(run, store.quotaWaitEvents(run.id))).toBeNull()
  await store.recordStageEvent(run.id, 'claude-quota-waiting', events[2]!.meta)
  expect(deriveQuotaWait(run, store.quotaWaitEvents(run.id))).not.toBeNull()
  const mode = JSON.parse(events[0]!.meta!)
  mode.checkpoint.pending.step_id = `${run.id}:review:2`
  await store.recordStageEvent(run.id, 'build-mode-state', JSON.stringify(mode))
  expect(deriveQuotaWait(run, store.quotaWaitEvents(run.id))).toBeNull()
  allHistory.mockRestore()
})

test('durable query fails closed for unmapped nested children and malformed explicit parent identities', async () => {
  const store = new TridentRunStore(db)
  const created = await store.create({ slug: 'foreign-quota', project_slug: 'project', repo_path: '/repo', task: 'review' })
  await store.update(created.id, { worktree: '/worktree' })
  const run = store.get(created.id)!
  const events = quotaWaitEvents(run)
  await store.recordStageEvent(run.id, events[0]!.stage, events[0]!.meta)
  for (const parentStepId of [undefined, null, '', 1, `${run.id}:review:2`]) {
    const stepId = parentStepId === undefined ? `${run.id}:plan:0:1:0` : `${run.id}:plan:0`
    const identity = JSON.stringify({ stepId, parentStepId, childId: 'native-child-current' })
    await store.recordStageEvent(run.id, 'claude-native-child-bound', identity)
    await store.recordStageEvent(run.id, 'claude-quota-waiting', identity)
    expect(store.quotaWaitEvents(run.id)).toHaveLength(1)
    expect(deriveQuotaWait(run, store.quotaWaitEvents(run.id))).toBeNull()
  }
  // Same query accepts a direct child with no optional parent field.
  for (const event of events.slice(1)) await store.recordStageEvent(run.id, event.stage, event.meta)
  expect(store.quotaWaitEvents(run.id)).toHaveLength(3)
  expect(deriveQuotaWait(run, store.quotaWaitEvents(run.id))).toEqual({ retry_at: null })
})
