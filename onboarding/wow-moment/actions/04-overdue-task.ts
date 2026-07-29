/**
 * Action 4 — overdue task surface.
 *
 * Per docs/plans/P2-onboarding.md § 2.5 #4 + P6 brief § 5.5. Fires
 * when the canonical TaskStore (or, on legacy paths, Pass-2
 * `ImportResult.proposed_tasks`) contains ≥ 1 entry with `due_at <
 * now`. Surfaces the most-overdue task with `[A] I'll handle it [B]
 * Remind me later [C] Drop it`.
 *
 * Tap-to-act: NO autonomous external action. The gate is the user's
 * tap. Telemetry records a redacted task title (truncated + first-line)
 * — never the full body.
 *
 * P6 (this sprint): when `ctx.task_store` is wired, the candidate
 * list reads `TaskStore.list({status: 'open', order: 'focus_score',
 * limit: 8})` filtered to overdue. The history-import seeder has
 * already landed every `proposed_tasks` row by the time the wow-
 * moment dispatcher reaches Action 4 (execution order 7→2→6→3→4→…
 * locks the seeder's persona-synthesized hook earlier). Legacy paths
 * without a wired TaskStore (older test fixtures) fall back to the
 * in-memory `proposed_tasks` array.
 */

import { createHash } from 'node:crypto'
import { buildButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import type { Task } from '@neutronai/tasks/store.ts'
import type { WowActionContext, WowActionModule, WowActionResult } from '../action-types.ts'
import type { WowEngagement } from '../telemetry.ts'

const ACTION_ID = '04-overdue-task' as const

const action04: WowActionModule = {
  action_id: ACTION_ID,

  triggerCondition(ctx: WowActionContext): boolean {
    const now = ctx.now()
    return overdueTasks(ctx, now).length >= 1
  },

  async run(ctx: WowActionContext): Promise<WowActionResult> {
    const now = ctx.now()
    const candidates = overdueTasks(ctx, now)
    if (candidates.length === 0) {
      return {
        fired: false,
        reason: 'no_overdue',
      }
    }
    // Pick the most-overdue task (smallest due_at) — ties broken by
    // priority hint (P0 > P1 > ... > undefined).
    candidates.sort((a, b) => {
      const da = a.due_at ?? Number.POSITIVE_INFINITY
      const db = b.due_at ?? Number.POSITIVE_INFINITY
      if (da !== db) return da - db
      return prioRank(a.priority_hint) - prioRank(b.priority_hint)
    })
    const task = candidates[0]!
    const prompt = buildButtonPrompt({
      body: composePromptBody(task.title, now - (task.due_at ?? now)),
      options: [
        { label: 'A', body: "I'll handle it", value: 'will_handle' },
        { label: 'B', body: 'Remind me later', value: 'snoozed' },
        { label: 'C', body: 'Drop it', value: 'dropped' },
      ],
      allow_freeform: false,
      idempotency: {
        project_slug: ctx.owner_slug,
        topic_id: ctx.topic_id,
        seed: `wow:04:${redactTitle(task.title)}`,
      },
    })
    const { prompt_id } = await ctx.channel.emitPrompt({
      prompt,
      topic_id: ctx.topic_id,
    })
    return {
      fired: true,
      reason: 'surfaced',
      redacted_payload: {
        task_title_hash: redactTitle(task.title),
        days_overdue: msToDays(now - (task.due_at ?? now)),
        priority_hint: task.priority_hint ?? null,
      },
      follow_up_prompt_id: prompt_id,
    }
  },

  decodeEngagement(value: string): WowEngagement | null {
    if (value === 'will_handle' || value === 'snoozed' || value === 'dropped') return value
    return null
  },
}

function overdueTasks(
  ctx: WowActionContext,
  now: number,
): Array<{ title: string; due_at?: number; priority_hint?: 'P0' | 'P1' | 'P2' | 'P3' }> {
  if (ctx.task_store !== undefined) {
    return overdueFromStore(ctx, now)
  }
  if (ctx.import_result === null) return []
  return ctx.import_result.proposed_tasks.filter(
    (t) => typeof t.due_at === 'number' && t.due_at < now,
  )
}

/**
 * P6 path: pull open tasks from the canonical store, sorted by focus
 * score, then filter to ones that are overdue (`due_date < now`).
 * Returns the shape Action 4 already speaks (title / due_at /
 * priority_hint) so the rest of the action is unchanged.
 */
function overdueFromStore(
  ctx: WowActionContext,
  now: number,
): Array<{ title: string; due_at?: number; priority_hint?: 'P0' | 'P1' | 'P2' | 'P3' }> {
  const store = ctx.task_store
  if (store === undefined) return []
  const rows: Task[] = store.list({
    project_slug: ctx.owner_slug,
    status: 'open',
    order: 'focus_score',
    limit: 8,
  })
  const out: Array<{
    title: string
    due_at?: number
    priority_hint?: 'P0' | 'P1' | 'P2' | 'P3'
  }> = []
  for (const t of rows) {
    if (t.due_date === null) continue
    const dueMs = Date.parse(t.due_date)
    if (!Number.isFinite(dueMs) || dueMs >= now) continue
    const entry: {
      title: string
      due_at?: number
      priority_hint?: 'P0' | 'P1' | 'P2' | 'P3'
    } = { title: t.title, due_at: dueMs }
    const hint = priorityIntToHint(t.priority)
    if (hint !== undefined) entry.priority_hint = hint
    out.push(entry)
  }
  return out
}

/** Inverse of priorityHintToInt. */
function priorityIntToHint(
  priority: number | null,
): 'P0' | 'P1' | 'P2' | 'P3' | undefined {
  if (priority === null) return undefined
  if (priority === 3) return 'P0'
  if (priority === 2) return 'P1'
  if (priority === 1) return 'P2'
  if (priority === 0) return 'P3'
  return undefined
}

function prioRank(hint: 'P0' | 'P1' | 'P2' | 'P3' | undefined): number {
  if (hint === 'P0') return 0
  if (hint === 'P1') return 1
  if (hint === 'P2') return 2
  if (hint === 'P3') return 3
  return 4
}

function composePromptBody(title: string, overdue_ms: number): string {
  const days = msToDays(overdue_ms)
  const days_phrase = days <= 0 ? 'just now' : `${days} day${days === 1 ? '' : 's'} ago`
  return `Heads up — this task came up due ${days_phrase}: "${title}". Want to act on it now?`
}

function msToDays(ms: number): number {
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)))
}

function redactTitle(title: string): string {
  // Privacy-respecting telemetry: hash the full title + truncate the
  // hash to 12 chars. Long enough to be uniquely identifiable across
  // re-runs, short enough to be operations-friendly.
  return createHash('sha256').update(title).digest('hex').slice(0, 12)
}

export default action04
