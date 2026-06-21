/**
 * @neutronai/tasks/inbox — markdown render for tasks.md + DASHBOARD.md.
 *
 * Pure functions: `Task[]` (any status) + a reference `now` → the
 * markdown blob the scanner writes to disk. No I/O, no store access —
 * golden-fixture testable.
 *
 * Two surfaces:
 *
 *   - **tasks.md** — a flat, focus-ordered view of every open task
 *     (cross-project) plus a recent-Done tail. The markdown-first
 *     analogue of the Tasks tab.
 *   - **DASHBOARD.md** — the same open tasks grouped into auto-promoted
 *     P0/P1/P2/P3 sections. "Auto-promotion" means a task's section is
 *     the MAX of its raw priority and its due-date urgency: an
 *     overdue P3 surfaces under "Do Now" even though its stored
 *     priority is P3. The promotion thresholds reuse the exact
 *     `focus-score.ts` due-date bands (overdue / ≤2d / ≤7d) so the
 *     dashboard and the focus score never disagree about urgency.
 *
 * Ordering reuses `computeFocusScore` (NOT a re-implementation) so the
 * markdown reflects the same deterministic signal the cron stamps. We
 * recompute against the render's `now` so staleness / overdue bands are
 * current at render time even between cron ticks.
 */

import { computeFocusScore } from '../focus-score.ts'
import { NO_PROJECT, type Task } from '../store.ts'
import {
  formatDueDateTag,
  renderDoneLine,
  renderTaskLine,
} from '../projection/format.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** Default Done-tail window for the markdown surface (days). */
export const DEFAULT_DONE_WINDOW_DAYS = 14

/** Priority/urgency bucket. `P0` is most urgent. */
export type PriorityBucket = 'P0' | 'P1' | 'P2' | 'P3'

const BUCKET_ORDER: ReadonlyArray<PriorityBucket> = ['P0', 'P1', 'P2', 'P3']

interface BucketMeta {
  bucket: PriorityBucket
  heading: string
}

/** Section headings for the auto-promoted DASHBOARD buckets. */
const BUCKET_META: ReadonlyArray<BucketMeta> = [
  { bucket: 'P0', heading: '🔴 Do Now (P0)' },
  { bucket: 'P1', heading: '🟠 Important (P1)' },
  { bucket: 'P2', heading: '🔵 This Week (P2)' },
  { bucket: 'P3', heading: '⚪ Backlog (P3)' },
]

/** Storage priority (0..3, 3 = most urgent) → bucket index (0 = P0). */
function priorityBucketIndex(priority: number | null): number {
  if (priority === null || priority < 0 || priority > 3) return 3
  return 3 - priority
}

/**
 * Due-date urgency → bucket index, or null when the due date doesn't
 * promote the task. Bands match `focus-score.ts` exactly:
 * overdue (≤0d) → P0, ≤2d → P1, ≤7d → P2.
 */
function dueBucketIndex(due_date: string | null, nowMs: number): number | null {
  if (due_date === null) return null
  const dueMs = Date.parse(due_date)
  if (!Number.isFinite(dueMs)) return null
  const daysLeft = Math.floor((dueMs - nowMs) / DAY_MS)
  if (daysLeft <= 0) return 0
  if (daysLeft <= 2) return 1
  if (daysLeft <= 7) return 2
  return null
}

/**
 * The auto-promoted bucket for a task: the more-urgent (lower index) of
 * its raw priority bucket and its due-date urgency bucket.
 */
export function effectiveBucket(task: Task, now: Date): PriorityBucket {
  const nowMs = now.getTime()
  const prioIdx = priorityBucketIndex(task.priority)
  const dueIdx = dueBucketIndex(task.due_date, nowMs)
  const idx = dueIdx === null ? prioIdx : Math.min(prioIdx, dueIdx)
  return BUCKET_ORDER[idx] as PriorityBucket
}

/** Recompute a fresh focus score for ordering against the render's `now`. */
function freshScore(task: Task, now: Date): number {
  return computeFocusScore({
    priority: task.priority,
    due_date: task.due_date,
    updated_at: task.updated_at,
    now,
  })
}

/**
 * Sort open tasks by fresh focus score DESC, then due_date ASC (nulls
 * last), then created_at DESC — the same tiebreak chain the store's
 * `focus_score` order uses, applied to the freshly recomputed score.
 */
function sortByFocus(tasks: Task[], now: Date): Task[] {
  return [...tasks].sort((a, b) => {
    const sa = freshScore(a, now)
    const sb = freshScore(b, now)
    if (sb !== sa) return sb - sa
    const da = a.due_date === null ? Infinity : Date.parse(a.due_date)
    const db = b.due_date === null ? Infinity : Date.parse(b.due_date)
    if (da !== db) return da - db
    return Date.parse(b.created_at) - Date.parse(a.created_at)
  })
}

function partition(tasks: Task[], now: Date, doneWindowDays: number): {
  active: Task[]
  done: Task[]
} {
  const nowMs = now.getTime()
  const windowMs = doneWindowDays * DAY_MS
  const active = sortByFocus(
    tasks.filter((t) => t.status === 'open'),
    now,
  )
  const done = tasks
    .filter((t) => t.status === 'done' && t.completed_at !== null)
    .filter((t) => nowMs - Date.parse(t.completed_at as string) <= windowMs)
    .sort(
      (a, b) =>
        Date.parse(b.completed_at as string) - Date.parse(a.completed_at as string),
    )
  return { active, done }
}

export interface RenderTasksMarkdownInput {
  /** Every task for the instance (any status). */
  tasks: Task[]
  /** Reference clock — injected for deterministic tests. */
  now: Date
  /** Done-tail window in days. Default {@link DEFAULT_DONE_WINDOW_DAYS}. */
  done_window_days?: number
}

const GENERATED_BANNER =
  '<!-- Generated by the neutron task-scanner — do not edit. Append changes to task-inbox.jsonl. -->'

/**
 * Render the flat, focus-ordered `tasks.md` surface. Cross-project, so
 * each line carries a `[project:<id>]` tag.
 */
export function renderTasksMarkdown(input: RenderTasksMarkdownInput): string {
  const doneWindow = input.done_window_days ?? DEFAULT_DONE_WINDOW_DAYS
  const { active, done } = partition(input.tasks, input.now, doneWindow)
  const lines: string[] = []
  lines.push('# Tasks')
  lines.push('')
  lines.push(GENERATED_BANNER)
  lines.push(`<!-- Last updated: ${input.now.toISOString()} -->`)
  lines.push('')
  lines.push('## Active')
  lines.push('')
  if (active.length === 0) {
    lines.push('_No active tasks._')
  } else {
    for (const task of active) {
      lines.push(
        renderTaskLine(task, {
          include_project_tag: true,
          include_focus_score: true,
          focus_score_override: freshScore(task, input.now),
        }),
      )
    }
  }
  lines.push('')
  lines.push(`## Done (last ${doneWindow} days)`)
  lines.push('')
  if (done.length === 0) {
    lines.push(`_No tasks completed in the last ${doneWindow} days._`)
  } else {
    for (const task of done) {
      lines.push(renderDoneLine(task))
    }
  }
  lines.push('')
  return lines.join('\n')
}

export interface RenderDashboardMarkdownInput {
  tasks: Task[]
  now: Date
  done_window_days?: number
}

function formatDateHeading(now: Date): string {
  // e.g. "Sunday, June 21, 2026" — stable UTC formatting (no locale drift).
  const weekday = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
  ][now.getUTCDay()]
  const month = [
    'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December',
  ][now.getUTCMonth()]
  return `${weekday}, ${month} ${now.getUTCDate()}, ${now.getUTCFullYear()}`
}

function projectSuffix(task: Task): string {
  return task.project_id !== NO_PROJECT ? ` \`${task.project_id}\`` : ''
}

function dueSuffix(task: Task, nowMs: number): string {
  const due = formatDueDateTag(task.due_date)
  if (due === null) return ''
  const dueMs = Date.parse(task.due_date as string)
  if (Number.isFinite(dueMs)) {
    const daysLeft = Math.floor((dueMs - nowMs) / DAY_MS)
    if (daysLeft < 0) return ` — ⚠️ overdue ${due}`
    if (daysLeft === 0) return ` — ⏰ due today`
  }
  return ` — due ${due}`
}

/**
 * Render the `DASHBOARD.md` surface: open tasks grouped into
 * auto-promoted P0/P1/P2/P3 sections, each focus-ordered. Empty buckets
 * are omitted; an all-clear note shows when nothing is open.
 */
export function renderDashboardMarkdown(input: RenderDashboardMarkdownInput): string {
  const doneWindow = input.done_window_days ?? DEFAULT_DONE_WINDOW_DAYS
  const { active, done } = partition(input.tasks, input.now, doneWindow)
  const nowMs = input.now.getTime()

  const byBucket = new Map<PriorityBucket, Task[]>()
  for (const meta of BUCKET_META) byBucket.set(meta.bucket, [])
  for (const task of active) {
    byBucket.get(effectiveBucket(task, input.now))?.push(task)
  }

  const lines: string[] = []
  lines.push(GENERATED_BANNER)
  lines.push(`<!-- Last updated: ${input.now.toISOString()} -->`)
  lines.push('')
  lines.push(`# ${formatDateHeading(input.now)}`)
  lines.push('')

  if (active.length === 0) {
    lines.push('> [!tip] **All clear**')
    lines.push('> No open tasks. Check project backlogs or enjoy the space.')
    lines.push('')
  } else {
    for (const meta of BUCKET_META) {
      const bucketTasks = byBucket.get(meta.bucket) as Task[]
      if (bucketTasks.length === 0) continue
      lines.push(`## ${meta.heading}`)
      lines.push('')
      for (const task of bucketTasks) {
        const score = freshScore(task, input.now).toFixed(1)
        lines.push(
          `- [ ] ${task.title}${projectSuffix(task)}${dueSuffix(task, nowMs)} [focus:${score}]`,
        )
      }
      lines.push('')
    }
  }

  lines.push(`## ✅ Done (last ${doneWindow} days)`)
  lines.push('')
  if (done.length === 0) {
    lines.push('_Nothing completed recently._')
  } else {
    for (const task of done) {
      lines.push(renderDoneLine(task))
    }
  }
  lines.push('')
  return lines.join('\n')
}
