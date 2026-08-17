import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ReminderStore } from '@neutronai/reminders/store.ts'
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
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
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

/**
 * Due dates are RELATIVE to now, never wall-clock literals.
 *
 * The link layer refuses to schedule a reminder for a moment that has already
 * gone (`MAX_PAST_DUE_DRIFT_SECONDS`), so a hardcoded ISO date silently turns
 * this whole file red the day the clock passes it — which is exactly what the
 * original `2026-06-15` literals did.
 */
function inDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

const DUE_SOON = inDays(7)
const DUE_LATER = inDays(21)

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
      due_date: DUE_SOON,
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
      due_date: DUE_SOON,
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
      due_date: DUE_SOON,
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
      due_date: DUE_SOON,
    })
    await waitForLink(task.id)
    const linkBefore = listLinkedRemindersForTask(task.id, db)[0]!
    const fireBefore = remindersStore.get(linkBefore.reminder_id)?.fire_at
    await taskStore.update(task.id, { due_date: DUE_LATER })
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
      due_date: DUE_SOON,
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
      due_date: DUE_SOON,
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
      due_date: DUE_SOON,
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

/**
 * ISSUES #440 — the three behaviours that had to be true before this layer
 * could ship ON by default rather than being deleted as a permanently-unset
 * switch. Each one is a way the link could have annoyed the owner or quietly
 * dropped their reminder.
 */
describe('task ↔ reminder auto-link — safe-to-ship-on behaviours', () => {
  test('a due date already in the past schedules NOTHING', async () => {
    // The noise vector: the onboarding history-import seeder bulk-creates tasks
    // from LLM-proposed `due_at` values, and past-dated ones would each be due
    // the instant they were written — the tick loop drains 50 per pass, so an
    // import lands as a wall of pings. Overdue-ness is the focus score's job.
    const task = await taskStore.create({
      project_slug: 't1',
      title: 'imported from last quarter',
      due_date: inDays(-30),
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(listLinkedRemindersForTask(task.id, db)).toHaveLength(0)
  })

  test('moving a due date INTO the past retires the reminder instead of firing it', async () => {
    const task = await taskStore.create({
      project_slug: 't1',
      title: 'slipped backwards',
      due_date: DUE_SOON,
    })
    await waitForLink(task.id)
    const reminderId = listLinkedRemindersForTask(task.id, db)[0]!.reminder_id
    await taskStore.update(task.id, { due_date: inDays(-2) })
    await waitFor(() => {
      const r = remindersStore.get(reminderId)
      return r !== null && r.status === 'cancelled'
    })
    expect(remindersStore.get(reminderId)?.status).toBe('cancelled')
  })

  test('re-opening a completed task gives its reminder back', async () => {
    // Completing cancels the reminder. Before this branch existed, re-opening
    // changed neither status-to-terminal nor the due date, so it fell through
    // every branch and the task sat open with a live due date and nothing
    // scheduled — permanently.
    const task = await taskStore.create({
      project_slug: 't1',
      title: 'not done after all',
      due_date: DUE_SOON,
    })
    await waitForLink(task.id)
    const firstReminderId = listLinkedRemindersForTask(task.id, db)[0]!.reminder_id
    await taskStore.complete(task.id)
    await waitFor(() => remindersStore.get(firstReminderId)?.status === 'cancelled')

    await taskStore.update(task.id, { status: 'open' })
    await waitFor(() => {
      const links = listLinkedRemindersForTask(task.id, db)
      return links.some((l) => remindersStore.get(l.reminder_id)?.status === 'pending')
    })
    const pending = listLinkedRemindersForTask(task.id, db)
      .map((l) => remindersStore.get(l.reminder_id))
      .filter((r) => r !== null && r.status === 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]?.message).toBe('not done after all')
  })

  test('renaming a task rewrites its pending reminder body', async () => {
    // The reminder message IS the task title. Without this the owner gets
    // reminded, by name, of a task that no longer goes by that name.
    const task = await taskStore.create({
      project_slug: 't1',
      title: 'call the plumber',
      due_date: DUE_SOON,
    })
    await waitForLink(task.id)
    const reminderId = listLinkedRemindersForTask(task.id, db)[0]!.reminder_id
    await taskStore.update(task.id, { title: 'call the electrician' })
    await waitFor(() => remindersStore.get(reminderId)?.message === 'call the electrician')
    const after = remindersStore.get(reminderId)
    expect(after?.message).toBe('call the electrician')
    // Rescheduling did not happen and the row is still live.
    expect(after?.status).toBe('pending')
  })
})
