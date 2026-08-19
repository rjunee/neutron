/**
 * P6 — `reminders_convert_to_task` MCP tool tests.
 *
 * Verifies the happy path (reminder → task + linked reminder + cancel),
 * the failure paths (unknown id, cross-project id, non-pending status),
 * and the back-compat path (no TaskStore wired → unsupported error).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SecretAuditLog } from '@neutronai/cores-runtime'
import { ReminderStore } from '@neutronai/reminders'
import { TaskStore } from '@neutronai/tasks'
import { attachReminderLinkSubscriber } from '@neutronai/tasks'

import { seedMigratedDb } from '../../../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import {
  buildReminderStoreBackend,
  buildTools,
  loadManifest,
} from '../index.ts'

const OWNER = 't1'

let tmp: string
let projectDb: ProjectDb
let audit: SecretAuditLog
let reminderStore: ReminderStore
let taskStore: TaskStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'reminders-convert-'))
  const dbPath = join(tmp, 'project.db')
  seedMigratedDb(dbPath)
  projectDb = ProjectDb.open(dbPath)
  audit = new SecretAuditLog({ db: projectDb })
  reminderStore = new ReminderStore(projectDb)
  taskStore = new TaskStore(projectDb)
  // Production wires the reminder-link subscriber from composition so a
  // task created via the tasks workspace synchronously gets a linked
  // reminder + link row. The convert-to-task tool relies on that path.
  attachReminderLinkSubscriber({
    store: taskStore,
    ctx: { projectDb, remindersStore: reminderStore },
  })
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeTools(opts: { withTaskStore: boolean }) {
  const backend = buildReminderStoreBackend({
    project_slug: OWNER,
    projectDb,
    ...(opts.withTaskStore ? { taskStore } : {}),
  })
  const manifest = loadManifest()
  return buildTools({
    manifest,
    project_slug: OWNER,
    audit,
    backend,
  })
}

describe('reminders_convert_to_task', () => {
  test('converts a pending reminder into a task + linked reminder', async () => {
    const tools = makeTools({ withTaskStore: true })
    const future = Math.floor(Date.now() / 1000) + 3600
    const create = await tools.reminders_create({
      message: 'follow up with Casey',
      fire_at: future,
      project_id: 'proj-A',
    })
    const result = await tools.reminders_convert_to_task({
      id: create.id,
    })
    expect(result.task_id).toBeTruthy()
    expect(result.cancelled_reminder_id).toBe(create.id)
    expect(result.linked_reminder_id).toBeTruthy()
    // Source reminder is cancelled.
    const cancelled = reminderStore.get(create.id)
    expect(cancelled?.status).toBe('cancelled')
    // Task exists with source='reminder'.
    const task = taskStore.get(result.task_id)
    expect(task?.source).toBe('reminder')
    expect(task?.title).toBe('follow up with Casey')
    expect(task?.project_id).toBe('proj-A')
    // The linked reminder is pending and bound to the new task.
    if (result.linked_reminder_id !== null) {
      const linked = reminderStore.get(result.linked_reminder_id)
      expect(linked?.status).toBe('pending')
      expect(linked?.message).toBe('follow up with Casey')
    }
  })

  test('respects title + priority + project_id overrides', async () => {
    const tools = makeTools({ withTaskStore: true })
    const future = Math.floor(Date.now() / 1000) + 3600
    const create = await tools.reminders_create({
      message: 'original body',
      fire_at: future,
    })
    const result = await tools.reminders_convert_to_task({
      id: create.id,
      title: 'overridden title',
      priority: 2,
      project_id: 'proj-X',
    })
    const task = taskStore.get(result.task_id)
    expect(task?.title).toBe('overridden title')
    expect(task?.priority).toBe(2)
    expect(task?.project_id).toBe('proj-X')
  })

  // The General scope is NOT a project. `~general` is the app rail's spelling of
  // the no-project scope and `~` is outside the gateway's project-id alphabet, so
  // letting it reach `taskStore.create` writes a task whose project_id names a
  // project that cannot exist — and the projection then mkdirs
  // `Projects/~general/`. The task store does not re-validate the id, so the
  // Core is the only thing standing between the sentinel and the filesystem.
  //
  // THREE paths carry it here and each is asserted separately: the explicit
  // override, the `app-project:~general` topic the app's reminders surface
  // writes, and the bare `~general` the Core's own create path stores raw.
  describe('the General sentinel never becomes a task project_id', () => {
    test('explicit project_id override of ~general lands in the no-project bucket', async () => {
      const tools = makeTools({ withTaskStore: true })
      const future = Math.floor(Date.now() / 1000) + 3600
      const create = await tools.reminders_create({
        message: 'general override',
        fire_at: future,
      })
      const result = await tools.reminders_convert_to_task({
        id: create.id,
        project_id: '~general',
      })
      expect(taskStore.get(result.task_id)?.project_id).toBe('')
    })

    test('an app-project:~general topic lands in the no-project bucket', async () => {
      // Exactly what `gateway/http/app-reminders-surface.ts` persists for a
      // reminder created on the General scope.
      const future = Math.floor(Date.now() / 1000) + 3600
      const row = await reminderStore.create({
        owner_slug: OWNER,
        topic_id: 'app-project:~general',
        fire_at: future,
        message: 'created on the General scope',
      })
      const tools = makeTools({ withTaskStore: true })
      const result = await tools.reminders_convert_to_task({ id: row.id })
      expect(taskStore.get(result.task_id)?.project_id).toBe('')
    })

    test('a bare ~general topic lands in the no-project bucket', async () => {
      const tools = makeTools({ withTaskStore: true })
      const future = Math.floor(Date.now() / 1000) + 3600
      const create = await tools.reminders_create({
        message: 'bare sentinel topic',
        fire_at: future,
        project_id: '~general',
      })
      const result = await tools.reminders_convert_to_task({ id: create.id })
      expect(taskStore.get(result.task_id)?.project_id).toBe('')
    })

    test('the sentinel name WITHOUT its sigil is a real project and is untouched', async () => {
      // `general` is a legal project id and an instance can have one (#183). It
      // is not the sentinel and must not be collapsed. NOTE: this case would
      // also pass before the fix — it is here to pin that the fix did not
      // over-reach, not to prove the match is exact. The prefix case below does
      // that.
      const tools = makeTools({ withTaskStore: true })
      const future = Math.floor(Date.now() / 1000) + 3600
      const create = await tools.reminders_create({
        message: 'not the sentinel',
        fire_at: future,
        project_id: 'general',
      })
      const result = await tools.reminders_convert_to_task({ id: create.id })
      expect(taskStore.get(result.task_id)?.project_id).toBe('general')
    })

    test('a value that merely STARTS WITH the sentinel is not collapsed', async () => {
      // This is what pins the comparison to `===` rather than `startsWith`. It
      // has to come through the override, because the sigil is outside the
      // server's project-id alphabet so no reminders_create project_id could
      // carry it — but the override is an arbitrary caller-supplied string.
      const tools = makeTools({ withTaskStore: true })
      const future = Math.floor(Date.now() / 1000) + 3600
      const create = await tools.reminders_create({
        message: 'prefix, not the sentinel',
        fire_at: future,
      })
      const result = await tools.reminders_convert_to_task({
        id: create.id,
        project_id: '~generalish',
      })
      expect(taskStore.get(result.task_id)?.project_id).toBe('~generalish')
    })
  })

  test('unknown reminder id surfaces an error', async () => {
    const tools = makeTools({ withTaskStore: true })
    await expect(
      tools.reminders_convert_to_task({ id: 'does-not-exist' }),
    ).rejects.toThrow(/not found/)
  })

  test('cross-project id surfaces an error (info-hiding via not-found)', async () => {
    // Create a reminder in instance t1, then build tools bound to t2.
    const future = Math.floor(Date.now() / 1000) + 3600
    const t1Tools = makeTools({ withTaskStore: true })
    const create = await t1Tools.reminders_create({
      message: 'm',
      fire_at: future,
    })
    const otherBackend = buildReminderStoreBackend({
      project_slug: 't2',
      projectDb,
      taskStore,
    })
    const otherTools = buildTools({
      manifest: loadManifest(),
      project_slug: 't2',
      audit,
      backend: otherBackend,
    })
    await expect(
      otherTools.reminders_convert_to_task({ id: create.id }),
    ).rejects.toThrow(/not found/)
  })

  test('non-pending reminder surfaces an error', async () => {
    const tools = makeTools({ withTaskStore: true })
    const future = Math.floor(Date.now() / 1000) + 3600
    const create = await tools.reminders_create({
      message: 'cancel me first',
      fire_at: future,
    })
    await tools.reminders_cancel({ id: create.id })
    await expect(
      tools.reminders_convert_to_task({ id: create.id }),
    ).rejects.toThrow(/not pending/)
  })

  test('no-TaskStore-wired backend throws ReminderConvertUnsupportedError', async () => {
    const tools = makeTools({ withTaskStore: false })
    const future = Math.floor(Date.now() / 1000) + 3600
    const create = await tools.reminders_create({ message: 'm', fire_at: future })
    await expect(
      tools.reminders_convert_to_task({ id: create.id }),
    ).rejects.toThrow(/no canonical TaskStore wired/)
  })
})
