/**
 * @neutronai/gateway/tasks/p6 — pure prompt-builder for the daily nudge LLM call.
 *
 * Per docs/plans/2026-05-23-002-feat-p6-1-nudge-engine-staleness-current-focus-pick-plan.md
 * Part A.3. Builds the user-prompt body the nudge engine hands the LLM
 * along with the persona-spliced system prompt. Kept as a pure function
 * (`NudgeContextBundle` → `string`) so it can be exercised in isolation
 * by `nudge-engine-prompt.test.ts` without any I/O.
 *
 * Output shape contract (LLM must return JSON like):
 *
 *   { "task_id": "<id-from-slate>", "rationale": "<≤ 280 char sentence>" }
 *
 * The engine validates the response, clamps the rationale, and rejects
 * task_ids not in the slate before persisting.
 */

import type { Task } from '../../../tasks/store.ts'

/** Hard cap on rationale length the validator enforces post-LLM. */
export const NUDGE_RATIONALE_MAX_CHARS = 280

/** Token-budget cap on the slate fed to the LLM. */
export const NUDGE_SLATE_LLM_LIMIT = 20

/**
 * Demotion-count threshold above which the prompt flags a task as
 * "consider skip or kill." The default 3 mirrors the staleness engine's
 * default `skip_or_kill_threshold`.
 */
export const SKIP_OR_KILL_FLAG_DEFAULT = 3

/**
 * Subset of a `Task` the prompt-builder cares about. Letting the
 * caller pass a narrowed projection keeps test setup terse.
 */
export interface NudgeSlateRow {
  id: string
  title: string
  project_id: string
  priority: number | null
  due_date: string | null
  focus_score: number | null
  staleness_demotion_count: number
}

export interface YesterdayCompletion {
  id: string
  title: string
}

export interface NudgeContextBundle {
  /** Owner-local day in YYYY-MM-DD; surfaced in the prompt header. */
  day: string
  /** Top-N open tasks for the owner, sorted by focus_score DESC. */
  slate: ReadonlyArray<NudgeSlateRow>
  /** Tasks the user completed yesterday. */
  yesterday_completions: ReadonlyArray<YesterdayCompletion>
  /** Count of tasks the user has already resolved today. */
  resolved_today_count: number
  /**
   * Threshold (in demotions) at or above which a row is flagged as
   * "skip-or-kill candidate" in the slate render. Defaults to
   * `SKIP_OR_KILL_FLAG_DEFAULT`.
   */
  skip_or_kill_flag_threshold?: number
}

/**
 * Build the user-prompt body. The system prompt comes from the persona
 * loader (the engine wraps the LLM call with `composeSystemPrompt` so
 * the persona is spliced above the user prompt).
 *
 * Format is intentionally Markdown-ish (the LLM is good at reading it)
 * with a fenced JSON response instruction at the end.
 */
export function buildNudgePrompt(bundle: NudgeContextBundle): string {
  const skipFlag =
    bundle.skip_or_kill_flag_threshold ?? SKIP_OR_KILL_FLAG_DEFAULT
  const lines: string[] = []
  lines.push(`# Daily Focus Pick — ${bundle.day}`)
  lines.push('')
  lines.push(
    `You are choosing ONE task the user should focus on today, given the persona context above (SOUL.md voice, USER.md facts, priority-map.md routing) and the slate below. Return strict JSON only.`,
  )
  lines.push('')
  lines.push(`## Today's resolved count: ${bundle.resolved_today_count}`)
  lines.push('')
  if (bundle.yesterday_completions.length > 0) {
    lines.push(`## Yesterday's completions`)
    lines.push('')
    for (const c of bundle.yesterday_completions) {
      lines.push(`- ${shortLine(c.title, 140)}`)
    }
    lines.push('')
  } else {
    lines.push(`## Yesterday's completions`)
    lines.push('')
    lines.push(`(none)`)
    lines.push('')
  }
  lines.push(`## Today's open slate (top ${bundle.slate.length} by focus score)`)
  lines.push('')
  if (bundle.slate.length === 0) {
    lines.push(`(empty — return JSON {"task_id":"","rationale":"empty slate"})`)
  } else {
    for (const row of bundle.slate) {
      lines.push(renderSlateRow(row, skipFlag))
    }
  }
  lines.push('')
  lines.push(`## Response format (required)`)
  lines.push('')
  lines.push('Return JSON in a single fenced ```json block with these keys:')
  lines.push('')
  lines.push('```json')
  lines.push('{')
  lines.push('  "task_id": "<one of the ids above>",')
  lines.push(
    `  "rationale": "<a single sentence, max ${NUDGE_RATIONALE_MAX_CHARS} characters, explaining WHY this is the right one to do today>"`,
  )
  lines.push('}')
  lines.push('```')
  lines.push('')
  lines.push(
    `Pick exactly one task_id from the slate above. If multiple tasks have a [skip-or-kill] flag, mention in the rationale whether the user should consider killing them.`,
  )
  return lines.join('\n')
}

/**
 * Render a single slate row. Format:
 *
 *   - `<id>` (P<priority>, due <due>, score <score>) — <title> [skip-or-kill]
 *
 * Fields that are null are omitted from the parenthetical; the
 * skip-or-kill flag only appears when `staleness_demotion_count` is at
 * or above the threshold.
 */
function renderSlateRow(row: NudgeSlateRow, skipFlag: number): string {
  const meta: string[] = []
  if (row.priority !== null) meta.push(`P${row.priority}`)
  if (row.due_date !== null) meta.push(`due ${row.due_date}`)
  if (row.focus_score !== null) meta.push(`score ${row.focus_score}`)
  if (row.project_id.length > 0) meta.push(`project ${row.project_id}`)
  const flag = row.staleness_demotion_count >= skipFlag ? ' [skip-or-kill]' : ''
  const metaStr = meta.length > 0 ? ` (${meta.join(', ')})` : ''
  return `- \`${row.id}\`${metaStr} — ${shortLine(row.title, 200)}${flag}`
}

function shortLine(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1)}…`
}

/**
 * Project a full `Task` into the narrowed `NudgeSlateRow` shape the
 * prompt-builder consumes. Exported so the engine + tests share one
 * mapping point.
 */
export function taskToSlateRow(task: Task): NudgeSlateRow {
  return {
    id: task.id,
    title: task.title,
    project_id: task.project_id,
    priority: task.priority,
    due_date: task.due_date,
    focus_score: task.focus_score,
    // Read from the raw db row in the engine via a typed cast; the
    // Task type does not yet carry the staleness columns (added in
    // migration 0045 — see plan § C.1). The engine reads them
    // alongside the standard columns and merges into NudgeSlateRow.
    staleness_demotion_count: 0,
  }
}
