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
 * The link write is SYNCHRONOUS with respect to the task mutation, but not
 * transactional with it: `TaskStore` commits the task row, then awaits its
 * subscribers inline (`tasks/store.ts`), and the reminder + link INSERTs share
 * a transaction of their own. So there is no async read-after-write window —
 * by the time `create`/`update` resolves the reminder exists — but a reminder
 * failure does NOT roll back the task. (This header used to claim one shared
 * transaction; it never was one.)
 *
 * Mechanics surface as standalone functions (callable from the HTTP
 * surface, the Tasks-Core adapter, or a test) PLUS a single
 * `attachReminderLinkSubscriber(...)` glue that wires the task-store
 * mutation stream into the link layer so a callsite just subscribes
 * once at composition time and stops worrying about it.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { createLogger } from '@neutronai/logger'
import { ReminderStore, type Reminder } from '@neutronai/reminders/store.ts'
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

/**
 * How far into the past a due date may sit and still earn a reminder.
 *
 * A reminder is a thing that fires LATER. Scheduling one for a moment that has
 * already gone means it is due the instant it is written, and the tick loop
 * posts it to the owner immediately — which is not "a reminder", it is a
 * notification for a deadline they already missed.
 *
 * This matters because tasks arrive in BULK with historical dates: the
 * onboarding history-import seeder (`tasks/history-import-seeder.ts`) creates
 * tasks straight from LLM-proposed `due_at` values, and a batch of those with
 * past dates would land as a wall of instant pings (the tick loop drains 50 due
 * rows per pass). The overdue signal is already carried by `focus_score`'s
 * overdue bucket (`tasks/focus-score.ts`) and the daily nudge pick — it does not
 * need a second, louder channel.
 *
 * 60 s of tolerance, matching the same floor the app reminders HTTP surface
 * enforces on hand-created reminders (`MAX_PAST_DRIFT_SECONDS`,
 * `gateway/http/app-reminders-surface.ts`), so "due in a moment" still schedules.
 */
export const MAX_PAST_DUE_DRIFT_SECONDS = 60

export interface TaskReminderLink {
  task_id: string
  reminder_id: string
  project_slug: string
  created_at: string
}

export interface ReminderLinkContext {
  projectDb: ProjectDb
  remindersStore: ReminderStore
  /** Override the wall clock (test seam). Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Is this due date far enough in the future to be worth a reminder?
 *
 * Callers pre-check with this rather than `createLinkedReminder` returning
 * null, keeping that function's "you asked for it, you get it" contract (same
 * shape as its existing `due_date === null` throw).
 */
export function dueDateIsSchedulable(
  due_date: string | null,
  now_ms: number,
): boolean {
  if (due_date === null) return false
  const fireAt = parseDueDateToFireAt(due_date)
  if (fireAt === null) return false
  return fireAt >= Math.floor(now_ms / 1000) - MAX_PAST_DUE_DRIFT_SECONDS
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
      owner_slug: task.project_slug,
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
 * Rewrite the message body of every PENDING linked reminder to the task's
 * current title. Used by the update path when the title changes; fired and
 * cancelled reminders are history and are left alone.
 */
export async function retitleLinkedReminders(input: {
  task_id: string
  title: string
  ctx: ReminderLinkContext
}): Promise<{ retitled: number }> {
  const { task_id, title, ctx } = input
  const links = listLinkedRemindersForTask(task_id, ctx.projectDb)
  let retitled = 0
  for (const link of links) {
    const ok = await ctx.remindersStore.retitle(link.reminder_id, title)
    if (ok) retitled += 1
  }
  return { retitled }
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
 * The candidate set `createLinkedReminder` de-dups against — every link for the
 * task; the caller filters on reminder status. Cheap: `task_reminder_links` is
 * indexed on `(project_slug, task_id)` (migration 0037) and a task has at most
 * a handful of links over its life.
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
      createLogger('task-reminder-link').warn('handler_threw', {
        event: event.kind,
        task: event.task.id,
        error: msg,
      })
    }
  })
}

async function handleEvent(
  event: TaskMutationEvent,
  ctx: ReminderLinkContext,
): Promise<void> {
  const nowMs = (ctx.now ?? Date.now)()
  switch (event.kind) {
    case 'create': {
      if (
        event.task.status === 'open' &&
        dueDateIsSchedulable(event.task.due_date, nowMs)
      ) {
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
      // A renamed task must not keep reminding the owner by its old name. Done
      // first + unconditionally: the title can change in the same PATCH as the
      // due date, and every branch below either keeps the reminder or replaces
      // it, so retitling here is never wasted and never fights them.
      if (before.title !== after.title) {
        await retitleLinkedReminders({ task_id: after.id, title: after.title, ctx })
      }
      // RE-OPEN. Completing a task cancels its reminder; re-opening it must give
      // the reminder back, or the task sits open with a live due date and
      // nothing scheduled — permanently, because every branch below compares
      // due dates and a pure re-open changes neither. This branch has to come
      // before them for exactly that reason.
      if (before.status !== 'open' && dueDateIsSchedulable(afterDue, nowMs)) {
        // `createLinkedReminder` de-dupes against a still-pending link, so a
        // re-open that never lost its reminder is a no-op here.
        await createLinkedReminder({ task: after, ctx })
        return
      }
      if (beforeDue === null && afterDue !== null) {
        if (dueDateIsSchedulable(afterDue, nowMs)) {
          await createLinkedReminder({ task: after, ctx })
        }
        return
      }
      if (beforeDue !== null && afterDue === null) {
        await cancelLinkedReminders({ task_id: after.id, ctx })
        return
      }
      if (beforeDue !== null && afterDue !== null && beforeDue !== afterDue) {
        // Moving a due date INTO the past retires the reminder rather than
        // rescheduling it to fire on the next tick — same reasoning as
        // `MAX_PAST_DUE_DRIFT_SECONDS`.
        if (!dueDateIsSchedulable(afterDue, nowMs)) {
          await cancelLinkedReminders({ task_id: after.id, ctx })
          return
        }
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
