/**
 * @neutronai/tasks — reminder ↔ task auto-link layer (P6).
 *
 * Per the P6 brief § 4.8, every task with a `due_date` is paired with a
 * `reminders` row + a `task_reminder_links` join row (migration 0037).
 * Task complete / cancel / delete cascades the cancellation to the
 * linked reminder; due-date updates either keep the reminder in place
 * (non-null → different non-null), cancel + delete the link (non-null
 * → null), or create a new reminder (null → non-null).
 *
 * The link write happens in the same transaction as the task mutation
 * — the user-visible model is "this task has a reminder," so an async
 * read-after-write window without the reminder would be confusing.
 *
 * Mechanics surface as standalone functions (callable from the HTTP
 * surface, the Tasks-Core adapter, or a test) PLUS a single
 * `attachReminderLinkSubscriber(...)` glue that wires the task-store
 * mutation stream into the link layer so a callsite just subscribes
 * once at composition time and stops worrying about it.
 */

import type { ProjectDb } from '../persistence/index.ts'
import { ReminderStore, type Reminder } from '../reminders/store.ts'
import type {
  Task,
  TaskMutationEvent,
  TaskStore,
} from './store.ts'

/**
 * Source tag stamped on every reminder this layer creates. Mirrors the
 * Tasks Core's `CORE_TASK_SOURCE_TAG` convention so a `source` grep on
 * the `reminders` table cleanly distinguishes engine writes from Core
 * writes from task-driven writes.
 */
export const TASK_REMINDER_SOURCE = '@neutronai/tasks' as const

export interface TaskReminderLink {
  task_id: string
  reminder_id: string
  project_slug: string
  created_at: string
}

export interface ReminderLinkContext {
  projectDb: ProjectDb
  remindersStore: ReminderStore
}

interface LinkDbRow {
  task_id: string
  reminder_id: string
  project_slug: string
  created_at: string
}

const LINK_COLS = 'task_id, reminder_id, project_slug, created_at'

/**
 * Create a reminder for a task that has a due_date AND insert the
 * `task_reminder_links` row binding them. Idempotent on the link side:
 * if an open (status='pending') link already exists for the task, the
 * call returns it without creating a duplicate.
 *
 * Throws if `task.due_date` is null — callers should pre-check.
 */
export async function createLinkedReminder(input: {
  task: Task
  ctx: ReminderLinkContext
}): Promise<TaskReminderLink> {
  const { task, ctx } = input
  if (task.due_date === null) {
    throw new Error(
      `createLinkedReminder: task ${task.id} has no due_date`,
    )
  }
  const existing = listOpenLinksForTask({ task_id: task.id, db: ctx.projectDb })
  for (const link of existing) {
    const reminder = ctx.remindersStore.get(link.reminder_id)
    if (reminder !== null && reminder.status === 'pending') {
      return link
    }
  }
  const fireAt = parseDueDateToFireAt(task.due_date)
  if (fireAt === null) {
    throw new Error(
      `createLinkedReminder: task ${task.id} due_date '${task.due_date}' not parseable`,
    )
  }
  // Wrap the reminder INSERT + link INSERT in a single transaction so
  // an INSERT failure on `task_reminder_links` (FK violation, busy
  // timeout, schema drift) doesn't leak a reminder row with no link
  // back to the task — that would surface as pending notifications
  // for tasks that don't list them. BEGIN/COMMIT keeps both writes
  // atomic; the rollback path drops the reminder row too.
  const createdAt = new Date().toISOString()
  const reminder = await ctx.projectDb.transaction(async () => {
    const r = await ctx.remindersStore.create({
      project_slug: task.project_slug,
      topic_id: task.project_id === '' ? null : `app-project:${task.project_id}`,
      fire_at: fireAt,
      message: task.title,
      source: TASK_REMINDER_SOURCE,
    })
    await ctx.projectDb.run(
      `INSERT INTO task_reminder_links
         (task_id, reminder_id, project_slug, created_at)
       VALUES (?, ?, ?, ?)`,
      [task.id, r.id, task.project_slug, createdAt],
    )
    return r
  })
  return {
    task_id: task.id,
    reminder_id: reminder.id,
    project_slug: task.project_slug,
    created_at: createdAt,
  }
}

/**
 * Cancel every linked reminder for a task. Leaves the link rows in
 * place so a later audit can correlate the two ids; the FK ON DELETE
 * CASCADE removes them when the task is hard-deleted.
 *
 * Returns the count of reminders that transitioned from pending to
 * cancelled (already-cancelled reminders are no-ops).
 */
export async function cancelLinkedReminders(input: {
  task_id: string
  ctx: ReminderLinkContext
}): Promise<{ cancelled: number }> {
  const { task_id, ctx } = input
  const links = listLinkedRemindersForTask(task_id, ctx.projectDb)
  let cancelled = 0
  for (const link of links) {
    const ok = await ctx.remindersStore.cancel(link.reminder_id)
    if (ok) cancelled += 1
  }
  return { cancelled }
}

/**
 * Update the due_date on a task's linked reminder in-place (the link
 * row stays the same). Returns true when a pending reminder was found
 * and rescheduled. Used by the update path when `due_date` changes
 * from `non-null → different-non-null`.
 */
export async function updateLinkedReminder(input: {
  task_id: string
  next_due_date: string
  ctx: ReminderLinkContext
}): Promise<{ rescheduled: number }> {
  const { task_id, next_due_date, ctx } = input
  const links = listLinkedRemindersForTask(task_id, ctx.projectDb)
  const fireAt = parseDueDateToFireAt(next_due_date)
  if (fireAt === null) return { rescheduled: 0 }
  let rescheduled = 0
  for (const link of links) {
    const reminder = ctx.remindersStore.get(link.reminder_id)
    if (reminder === null || reminder.status !== 'pending') continue
    const ok = await ctx.remindersStore.reschedule(link.reminder_id, fireAt)
    if (ok) rescheduled += 1
  }
  return { rescheduled }
}

/**
 * List every linked reminder for a task (regardless of reminder
 * status). The Focus aggregator and the Reminders Core convert-to-task
 * tool use this to round-trip a (task, reminder) pair.
 */
export function listLinkedRemindersForTask(
  task_id: string,
  db: ProjectDb,
): TaskReminderLink[] {
  return db
    .prepare<LinkDbRow, [string]>(
      `SELECT ${LINK_COLS}
         FROM task_reminder_links
        WHERE task_id = ?
        ORDER BY created_at ASC`,
    )
    .all(task_id)
    .map(rowToLink)
}

/**
 * List links for a task whose linked reminder is still pending — the
 * shape `createLinkedReminder` uses to de-dup. Cheap because the
 * partial index on `(project_slug, task_id)` is dense.
 */
function listOpenLinksForTask(input: {
  task_id: string
  db: ProjectDb
}): TaskReminderLink[] {
  return listLinkedRemindersForTask(input.task_id, input.db)
}

/**
 * Wire the task-store mutation stream into the reminder-link layer.
 * Returns the same unsubscribe function `TaskStore.subscribe` returned
 * — composition-root code holds onto it for shutdown cleanup (no-op in
 * production, useful in tests).
 *
 * The mutation handlers run inline AFTER the task write commits (for
 * create / update / complete / cancel) and BEFORE the SQL DELETE (for
 * delete) so the reminder cleanup can find the link rows before
 * FK CASCADE removes them.
 */
export function attachReminderLinkSubscriber(input: {
  store: TaskStore
  ctx: ReminderLinkContext
}): () => void {
  const { store, ctx } = input
  return store.subscribe(async (event) => {
    try {
      await handleEvent(event, ctx)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[task-reminder-link] handler threw on ${event.kind} task=${event.task.id}: ${msg}`,
      )
    }
  })
}

async function handleEvent(
  event: TaskMutationEvent,
  ctx: ReminderLinkContext,
): Promise<void> {
  switch (event.kind) {
    case 'create': {
      if (event.task.due_date !== null && event.task.status === 'open') {
        await createLinkedReminder({ task: event.task, ctx })
      }
      return
    }
    case 'update': {
      const before = event.previous
      const after = event.task
      if (before === undefined) return
      const beforeDue = before.due_date
      const afterDue = after.due_date
      const statusTerminal = after.status !== 'open'
      if (statusTerminal) {
        // Status flipped to non-open via update — cancel any links.
        await cancelLinkedReminders({ task_id: after.id, ctx })
        return
      }
      if (beforeDue === null && afterDue !== null) {
        await createLinkedReminder({ task: after, ctx })
        return
      }
      if (beforeDue !== null && afterDue === null) {
        await cancelLinkedReminders({ task_id: after.id, ctx })
        return
      }
      if (beforeDue !== null && afterDue !== null && beforeDue !== afterDue) {
        const links = listLinkedRemindersForTask(after.id, ctx.projectDb)
        const hasPending = links.some((l) => {
          const r = ctx.remindersStore.get(l.reminder_id)
          return r !== null && r.status === 'pending'
        })
        if (hasPending) {
          await updateLinkedReminder({
            task_id: after.id,
            next_due_date: afterDue,
            ctx,
          })
        } else {
          await createLinkedReminder({ task: after, ctx })
        }
      }
      return
    }
    case 'complete':
    case 'cancel': {
      await cancelLinkedReminders({ task_id: event.task.id, ctx })
      return
    }
    case 'delete': {
      // Cancel the linked reminders first so the audit row carries a
      // `cancelled_at` rather than just disappearing; the FK CASCADE
      // then sweeps the link table when the tasks row is gone.
      await cancelLinkedReminders({ task_id: event.task.id, ctx })
      return
    }
  }
}

/**
 * Parse a task `due_date` (ISO-8601 string OR date-only `YYYY-MM-DD`)
 * into the Reminders Store's unix-seconds epoch. Returns null when
 * unparseable.
 *
 * A date-only string is promoted to **09:00 UTC** on that calendar
 * day. NOT "Nova task-scanner local 9am" — Nova's scanner runs in
 * Sam's local TZ, while this substrate is multi-instance and
 * timezone-agnostic. 09:00 UTC lands at ~01:00 America/Los_Angeles,
 * ~10:00 Europe/Berlin, ~17:00 Asia/Singapore — i.e. it's deliberately
 * a UTC anchor, not a per-instance "start of working day".
 *
 * Per-instance TZ promotion is deferred until the instance-tz resolver
 * is wired (no canonical resolver exists today). Until then, a
 * client that needs an exact-local fire time should send a full
 * ISO-8601 `due_date` (e.g. `2026-05-25T09:00:00-07:00`) — those
 * pass through this branch and are parsed by `Date.parse` directly
 * without the +9h bump.
 */
function parseDueDateToFireAt(due_date: string): number | null {
  let ms = Date.parse(due_date)
  if (!Number.isFinite(ms)) return null
  // `Date.parse('YYYY-MM-DD')` returns 00:00:00Z. Promote to 09:00 UTC
  // so a "due today" reminder doesn't fire at midnight UTC. See JSDoc
  // above for the TZ rationale.
  if (/^\d{4}-\d{2}-\d{2}$/.test(due_date.trim())) {
    ms += 9 * 60 * 60 * 1000
  }
  return Math.floor(ms / 1000)
}

function rowToLink(row: LinkDbRow): TaskReminderLink {
  return {
    task_id: row.task_id,
    reminder_id: row.reminder_id,
    project_slug: row.project_slug,
    created_at: row.created_at,
  }
}

// Re-export for callers that want a typed Reminder reference.
export type { Reminder }
