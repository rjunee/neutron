/**
 * @neutronai/tasks — overnight-work → task hook (P6).
 *
 * Per the P6 brief § 4.11 + § 5.6, the overnight-dispatcher reporter
 * emits an `overnight.work_completed` event per finished item; a
 * composition-root subscriber creates a `source='overnight'` review
 * task scoped to the originating project.
 *
 * The dispatcher itself hasn't grown a full event-bus yet — this
 * module ships the small surface the hook needs:
 *
 *   - `OvernightWorkCompletedEvent` shape (the event the reporter
 *     emits).
 *   - `createOvernightReviewTask(...)` — the actual TaskStore.create
 *     call, idempotent against a deterministic id derived from
 *     `(project_slug, project_id, item_title, completed_at)`.
 *   - `attachOvernightWorkCompletedHook(...)` — composition-root glue
 *     that turns an emitter callback into a one-line subscription.
 *
 * When the overnight dispatcher grows a structured event surface, the
 * subscriber it carries is `(event) => createOvernightReviewTask(...)`.
 * Until then, callers can invoke `createOvernightReviewTask(...)`
 * directly from the cron handler.
 */

import { createHash } from 'node:crypto'

import {
  NO_PROJECT,
  TASK_SOURCE_OVERNIGHT,
  type Task,
  type TaskStore,
} from './store.ts'

export interface OvernightWorkCompletedEvent {
  project_slug: string
  /** Project the overnight item belonged to. `NO_PROJECT` for instance-level work. */
  project_id: string
  /** Short title of the completed item (used verbatim in the review task title). */
  item_title: string
  /** Free-form description / link to the summary markdown. Optional. */
  description?: string
  /** Wall-clock ms of completion (used for idempotency + audit). */
  completed_at_ms: number
}

export interface CreateOvernightReviewTaskInput {
  event: OvernightWorkCompletedEvent
  store: TaskStore
}

/**
 * Idempotency hash — re-firing the same overnight completion (e.g. a
 * cron tick that double-counts on restart) lands at the same task row
 * and the store's create call returns the existing one rather than
 * inserting a duplicate.
 */
export function overnightReviewTaskHash(event: OvernightWorkCompletedEvent): string {
  const h = createHash('sha256')
  h.update(`project_slug:${event.project_slug} `)
  h.update(`project:${event.project_id} `)
  h.update(`title:${event.item_title} `)
  // Bucket completion to the minute so micro-jitter doesn't create
  // two rows from the same logical event.
  const bucket = Math.floor(event.completed_at_ms / 60_000)
  h.update(`bucket:${bucket}`)
  return `ovn_${h.digest('hex').slice(0, 24)}`
}

/**
 * Create a `source='overnight'` review task for one completed
 * overnight-work item. Idempotent against repeat events. Returns the
 * task row (newly-created OR the existing one).
 */
export async function createOvernightReviewTask(
  input: CreateOvernightReviewTaskInput,
): Promise<Task> {
  const { event, store } = input
  const id = overnightReviewTaskHash(event)
  const existing = store.get(id)
  if (existing !== null) return existing
  const project = event.project_id === '' ? NO_PROJECT : event.project_id
  return store.create({
    id,
    project_slug: event.project_slug,
    project_id: project,
    title: `Review overnight work: ${event.item_title}`,
    description: event.description ?? null,
    priority: 1,
    source: TASK_SOURCE_OVERNIGHT,
  })
}

/**
 * Glue helper — wraps `createOvernightReviewTask` as a subscriber
 * callback. The overnight dispatcher's event-emitter (current and
 * future) calls this with a fired event and gets the resulting task
 * back; errors propagate so the dispatcher can record the failure.
 */
export function attachOvernightWorkCompletedHook(input: {
  store: TaskStore
}): (event: OvernightWorkCompletedEvent) => Promise<Task> {
  return (event) => createOvernightReviewTask({ event, store: input.store })
}
