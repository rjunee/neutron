/**
 * @neutronai/tasks/projection — markdown rendering (P6).
 *
 * Pure-function transforms from a Task[] (already filtered + sorted
 * by the caller) into the markdown blob that gets injected into
 * STATUS.md / written as ACTIONS.md. No I/O — testable via golden
 * fixtures.
 *
 * Tag format (locked to match Nova's internal design notes convention so
 * a future round-trip parse stays clean):
 *
 *     - [ ] <title> [P1] [due:YYYY-MM-DD] [project:<slug>] [focus:7.5]
 *     - [x] ~~<title>~~ ✅ 2026-05-15
 *
 * Priority is rendered as `P0`..`P3` (Nova mnemonic). Project tag is
 * emitted only when the projection is unprojected-by-project (i.e. the
 * ACTIONS.md file for a single project drops the redundant project
 * tag; the cross-project STATUS.md aggregator keeps it).
 *
 * Focus tag is emitted only when `focus_score` is non-null and the
 * caller asked for it (via `include_focus_score`). The Tier 1 STATUS.md
 * always shows focus; ACTIONS.md does too — it's a debugging signal
 * for "why is THIS task on top?" rather than a rendering artifact.
 */

import { NO_PROJECT, type Task } from '../store.ts'

/** P6.0 stores priority as `0..3`; Nova-style projection uses `P0..P3`. */
export function formatPriorityTag(priority: number | null): string | null {
  if (priority === null || priority < 0 || priority > 3) return null
  return `P${3 - priority}`
}

/** ISO-8601 → date-only `YYYY-MM-DD`. Returns null on unparseable input. */
export function formatDueDateTag(due_date: string | null): string | null {
  if (due_date === null) return null
  const ms = Date.parse(due_date)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  const y = d.getUTCFullYear().toString().padStart(4, '0')
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = d.getUTCDate().toString().padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** One-decimal focus score, e.g. `7.5`. */
function formatFocusScoreValue(score: number): string {
  return (Math.round(score * 10) / 10).toFixed(1)
}

export interface RenderStatusBlockInput {
  /** Open tasks, already sorted by focus_score DESC (caller's responsibility). */
  active: Task[]
  /** Done tasks (≤30d old recommended), sorted by completed_at DESC. */
  done: Task[]
  /** When true, emit a `[project:<slug>]` tag on each line. */
  include_project_tag?: boolean
  /** When true (default), emit `[focus:X.Y]` when the row carries a score. */
  include_focus_score?: boolean
}

/**
 * Render the marked-block contents — everything between the start /
 * end markers in STATUS.md. The caller is responsible for the markers
 * themselves; this returns just the inner body so the parser can
 * find/replace it without the markers leaking into the output twice.
 */
export function renderStatusBlock(input: RenderStatusBlockInput): string {
  const includeProject = input.include_project_tag ?? false
  const includeFocus = input.include_focus_score ?? true
  const lines: string[] = []
  lines.push('## Tasks')
  lines.push('')
  lines.push('### Active')
  lines.push('')
  if (input.active.length === 0) {
    lines.push('_No active tasks._')
  } else {
    for (const task of input.active) {
      lines.push(
        renderTaskLine(task, {
          include_project_tag: includeProject,
          include_focus_score: includeFocus,
        }),
      )
    }
  }
  lines.push('')
  lines.push('### Done (last 30 days)')
  lines.push('')
  if (input.done.length === 0) {
    lines.push('_No tasks completed in the last 30 days._')
  } else {
    for (const task of input.done) {
      lines.push(renderDoneLine(task))
    }
  }
  return lines.join('\n')
}

export interface RenderTaskLineOptions {
  /** Emit a `[project:<slug>]` tag when the row is project-scoped. */
  include_project_tag?: boolean
  /** Emit `[focus:X.Y]` when the row carries a non-null focus_score. Default true. */
  include_focus_score?: boolean
  /** Override the rendered focus value (e.g. a freshly recomputed score). */
  focus_score_override?: number | null
}

/**
 * Render a single open-task checkbox line in the locked Nova tag format.
 * Exported so every markdown surface (STATUS.md projection, the
 * instance-wide tasks.md / DASHBOARD.md surface) emits byte-identical
 * lines — the tag format lives in exactly one place.
 */
export function renderTaskLine(
  task: Task,
  opts: RenderTaskLineOptions = {},
): string {
  const includeProject = opts.include_project_tag ?? false
  const includeFocus = opts.include_focus_score ?? true
  const tags: string[] = []
  const prio = formatPriorityTag(task.priority)
  if (prio !== null) tags.push(`[${prio}]`)
  const due = formatDueDateTag(task.due_date)
  if (due !== null) tags.push(`[due:${due}]`)
  if (includeProject && task.project_id !== NO_PROJECT) {
    tags.push(`[project:${task.project_id}]`)
  }
  const focus =
    opts.focus_score_override !== undefined
      ? opts.focus_score_override
      : task.focus_score
  if (includeFocus && focus !== null) {
    tags.push(`[focus:${formatFocusScoreValue(focus)}]`)
  }
  const suffix = tags.length > 0 ? ` ${tags.join(' ')}` : ''
  return `- [ ] ${task.title}${suffix}`
}

/** Render a single completed-task line (`- [x] ~~title~~ ✅ YYYY-MM-DD`). */
export function renderDoneLine(task: Task): string {
  const completed = task.completed_at !== null
    ? formatDueDateTag(task.completed_at)
    : null
  const stamp = completed !== null ? ` ✅ ${completed}` : ''
  return `- [x] ~~${task.title}~~${stamp}`
}

export interface RenderActionsFileInput {
  /** Active tasks for the project, sorted by focus_score DESC. */
  active: Task[]
  /** Done tasks (≤30d) for the project, sorted by completed_at DESC. */
  done: Task[]
  /** Project id (used in the frontmatter `project:` field). */
  project_id: string
  /** Display name for the H1 — when omitted, falls back to `project_id`. */
  project_name?: string
  /** ISO-8601 — stamped into the frontmatter so re-generation order shows. */
  last_updated_iso: string
}

/**
 * Whole-file render for `<OWNER_HOME>/Projects/<id>/ACTIONS.md`.
 * The file is auto-generated end-to-end; there's no narrative content
 * to preserve, so we own every byte.
 *
 * Shape:
 *
 *   ---
 *   project: <id>
 *   last_updated: <iso>
 *   ---
 *
 *   # <display_name> — Actions
 *
 *   ## Active
 *
 *   - [ ] ...
 *
 *   ## Done (last 30 days)
 *
 *   - [x] ...
 */
export function renderActionsFile(input: RenderActionsFileInput): string {
  const name = input.project_name ?? input.project_id
  const lines: string[] = []
  lines.push('---')
  lines.push(`project: ${input.project_id}`)
  lines.push(`last_updated: ${input.last_updated_iso}`)
  lines.push('generated_by: neutron-tasks-projection')
  lines.push('---')
  lines.push('')
  lines.push(`# ${name} — Actions`)
  lines.push('')
  lines.push(
    `_Auto-generated from the canonical task DB. Edits to this file are ` +
      `OVERWRITTEN on the next mutation; edit tasks via the app or chat instead._`,
  )
  lines.push('')
  lines.push('## Active')
  lines.push('')
  if (input.active.length === 0) {
    lines.push('_No active tasks._')
  } else {
    for (const task of input.active) {
      lines.push(renderTaskLine(task, { include_focus_score: true }))
    }
  }
  lines.push('')
  lines.push('## Done (last 30 days)')
  lines.push('')
  if (input.done.length === 0) {
    lines.push('_No tasks completed in the last 30 days._')
  } else {
    for (const task of input.done) {
      lines.push(renderDoneLine(task))
    }
  }
  lines.push('')
  return lines.join('\n')
}
