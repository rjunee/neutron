import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { ReminderStore } from '../../reminders/store.ts'
import { TaskStore } from '../store.ts'
import {
  attachReminderLinkSubscriber,
  createLinkedReminder,
  listLinkedRemindersForTask,
  TASK_REMINDER_SOURCE,
} from '../reminder-link.ts'

let tmp: string
let db: ProjectDb
let taskStore: TaskStore
let remindersStore: ReminderStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-task-reminder-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  taskStore = new TaskStore(db)
  remindersStore = new ReminderStore(db)
  attachReminderLinkSubscriber({
    store: taskStore,
    ctx: { projectDb: db, remindersStore },
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function waitForLink(taskId: string, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const links = listLinkedRemindersForTask(taskId, db)
    if (links.length > 0) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`waitForLink: no link landed for task ${taskId} in ${timeoutMs}ms`)
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`waitFor: predicate did not become true in ${timeoutMs}ms`)
}

describe('task ↔ reminder auto-link — create path', () => {
  test('task with due_date creates reminder + link row', async () => {
    const task = await taskStore.create({
      project_slug: 't1',
      project_id: 'proj-A',
      title: 'submit Q3 report',
      due_date: '2026-06-15T09:00:00.000Z',
      source: 'app',
    })
    await waitForLink(task.id)
    const links = listLinkedRemindersForTask(task.id, db)
    expect(links).toHaveLength(1)
    const reminder = remindersStore.get(links[0]!.reminder_id)
    expect(reminder).not.toBeNull()
    expect(reminder?.source).toBe(TASK_REMINDER_SOURCE)
    expect(reminder?.message).toBe('submit Q3 report')
    expect(reminder?.topic_id).toBe('app-project:proj-A')
  })

  test('task without due_date creates no reminder', async () => {
    const task = await taskStore.create({
      project_slug: 't1',
      title: 'no due date',
    })
    // give the microtask a beat
    await new Promise((r) => setTimeout(r, 30))
    const links = listLinkedRemindersForTask(task.id, db)
    expect(links).toHaveLength(0)
  })

  test('direct call to createLinkedReminder is idempotent', async () => {
    const task = await taskStore.create({
      project_slug: 't1',
      title: 'one-off',
      due_date: '2026-06-15T09:00:00.000Z',
    })
    await waitForLink(task.id)
    const linksBefore = listLinkedRemindersForTask(task.id, db)
    await createLinkedReminder({
      task,
      ctx: { projectDb: db, remindersStore },
    })
    const linksAfter = listLinkedRemindersForTask(task.id, db)
    expect(linksAfter).toHaveLength(linksBefore.length)
  })
})

describe('task ↔ reminder auto-link — update / status / delete', () => {
  test('clearing due_date cancels the linked reminder', async () => {
    const task = await taskStore.create({
      project_slug: 't1',
      title: 'will be cleared',
      due_date: '2026-06-15T09:00:00.000Z',
    })
    await waitForLink(task.id)
    const links = listLinkedRemindersForTask(task.id, db)
    const reminderId = links[0]!.reminder_id
    await taskStore.update(task.id, { due_date: null })
    await waitFor(() => {
      const r = remindersStore.get(reminderId)
      return r !== null && r.status === 'cancelled'
    })
    const after = remindersStore.get(reminderId)
    expect(after?.status).toBe('cancelled')
  })

  test('changing due_date reschedules the linked reminder', async () => {
    const task = await taskStore.create({
      project_slug: 't1',
      title: 'move it',
      due_date: '2026-06-15T09:00:00.000Z',
    })
    await waitForLink(task.id)
    const linkBefore = listLinkedRemindersForTask(task.id, db)[0]!
    const fireBefore = remindersStore.get(linkBefore.reminder_id)?.fire_at
    await taskStore.update(task.id, { due_date: '2026-07-01T09:00:00.000Z' })
    await waitFor(() => {
      const r = remindersStore.get(linkBefore.reminder_id)
      return r !== null && r.fire_at !== fireBefore
    })
    const linkAfter = listLinkedRemindersForTask(task.id, db)
    // Same link row, same reminder id.
    expect(linkAfter).toHaveLength(1)
    expect(linkAfter[0]!.reminder_id).toBe(linkBefore.reminder_id)
    const reminderAfter = remindersStore.get(linkBefore.reminder_id)
    expect(reminderAfter?.status).toBe('pending')
    expect(reminderAfter?.fire_at).not.toBe(fireBefore)
  })

  test('completing a task cancels the linked reminder', async () => {
    const task = await taskStore.create({
      project_slug: 't1',
      title: 'complete me',
      due_date: '2026-06-15T09:00:00.000Z',
    })
    await waitForLink(task.id)
    const reminderId = listLinkedRemindersForTask(task.id, db)[0]!.reminder_id
    await taskStore.complete(task.id)
    await waitFor(() => {
      const r = remindersStore.get(reminderId)
      return r !== null && r.status === 'cancelled'
    })
    expect(remindersStore.get(reminderId)?.status).toBe('cancelled')
    // Link row stays for audit.
    expect(listLinkedRemindersForTask(task.id, db)).toHaveLength(1)
  })

  test('cancelling a task cancels the linked reminder', async () => {
    const task = await taskStore.create({
      project_slug: 't1',
      title: 'cancel me',
      due_date: '2026-06-15T09:00:00.000Z',
    })
    await waitForLink(task.id)
    const reminderId = listLinkedRemindersForTask(task.id, db)[0]!.reminder_id
    await taskStore.cancel(task.id)
    await waitFor(() => {
      const r = remindersStore.get(reminderId)
      return r !== null && r.status === 'cancelled'
    })
    expect(remindersStore.get(reminderId)?.status).toBe('cancelled')
  })

  test('deleting a task cascades the link row removal', async () => {
    const task = await taskStore.create({
      project_slug: 't1',
      title: 'delete me',
      due_date: '2026-06-15T09:00:00.000Z',
    })
    await waitForLink(task.id)
    const reminderId = listLinkedRemindersForTask(task.id, db)[0]!.reminder_id
    await taskStore.delete(task.id)
    await waitFor(() => {
      const r = remindersStore.get(reminderId)
      return r !== null && r.status === 'cancelled'
    })
    // The link row is FK-CASCADE-deleted with the task; the reminder
    // row stays for audit (status='cancelled', not hard-deleted).
    const links = listLinkedRemindersForTask(task.id, db)
    expect(links).toHaveLength(0)
    expect(remindersStore.get(reminderId)?.status).toBe('cancelled')
  })
})
