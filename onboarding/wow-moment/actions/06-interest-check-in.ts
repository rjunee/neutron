/**
 * Action 6 — interest-check-in (P2 v2, NEW; replaces dharma-reframe).
 *
 * Per docs/plans/P2-onboarding-v2.md § 5.2 + § 9.4. Surfaces a non-work
 * interest the system inferred (or the user volunteered), schedules a
 * recurring proactive nudge at the appropriate cadence, AND fires one
 * immediate prompt asking whether to plan something now. The biggest
 * v2 wow per Sam 2026-05-15: *"the agent is proactive — it picks the
 * moment to surface, not waits."*
 *
 * Trigger: `phase_state_json.non_work_interests` is a non-empty array.
 *
 * Owned-data writes:
 *   - 1 recurring row in `reminders` (recurrence inferred from cadence_hint).
 *   - 1 immediate `[A] Plan something [B] Not now` button-prompt.
 *
 * Reversibility: `[B]` snoozes (no edit needed); explicit cancel from the
 * reminder list cancels future occurrences.
 *
 * Telemetry: `interest_name_hash` (sha256 truncated to 16 hex chars) +
 * the chosen cadence label — never the raw interest text.
 */

import { createHash } from 'node:crypto'
import { buildButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import type { CreateRecurringReminderInput, ReminderRecurrence } from '@neutronai/reminders/store.ts'
import type { WowActionContext, WowActionModule, WowActionResult } from '../action-types.ts'
import type { WowEngagement } from '../telemetry.ts'

const ACTION_ID = '06-interest-check-in' as const

/**
 * One captured interest. The history-import Pass-2 emits items in this
 * shape into `ImportResult.inferred_interests`; the work_interview_gap_fill
 * phase writes the user-volunteered ones in the same shape.
 */
export interface NonWorkInterest {
  name: string
  basis?: string
  cadence_hint?: 'weekly' | 'monthly' | 'occasional'
}

const SECONDS_PER_DAY = 24 * 60 * 60

/**
 * Map a cadence hint to a first-fire offset (in seconds). The store
 * carries the recurrence label; the tick loop's next-occurrence rescheduler
 * (or a future cron task) advances subsequent fires using the same offset.
 */
const CADENCE_TO_FIRST_FIRE_OFFSET_SEC: Readonly<Record<ReminderRecurrence, number>> = {
  weekly: 7 * SECONDS_PER_DAY,
  monthly: 30 * SECONDS_PER_DAY,
  occasional: 14 * SECONDS_PER_DAY,
}

const action06: WowActionModule = {
  action_id: ACTION_ID,

  triggerCondition(ctx: WowActionContext): boolean {
    return readInterests(ctx).length > 0
  },

  async run(ctx: WowActionContext): Promise<WowActionResult> {
    const interests = readInterests(ctx)
    if (interests.length === 0) {
      return { fired: false, reason: 'no_interests' }
    }

    // Prefer an interest that came with an explicit cadence hint; fall
    // back to the first entry (and default to monthly so we still write
    // a recurring row rather than a one-shot).
    const target = interests.find((i) => i.cadence_hint !== undefined) ?? interests[0]!
    const cadence: ReminderRecurrence = target.cadence_hint ?? 'monthly'

    const now_sec = Math.floor(ctx.now() / 1000)
    const first_fire_at = now_sec + CADENCE_TO_FIRST_FIRE_OFFSET_SEC[cadence]
    const reminder_id = ctx.uuid()
    const reminder_body = composeRecurringBody(target.name)

    const createInput: CreateRecurringReminderInput = {
      id: reminder_id,
      project_slug: ctx.project_slug,
      topic_id: ctx.topic_id,
      fire_at: first_fire_at,
      message: reminder_body,
      recurrence: cadence,
    }
    await ctx.reminders.createRecurring(createInput)

    const prompt = buildButtonPrompt({
      body: composeImmediatePromptBody(target.name),
      options: [
        { label: 'A', body: 'Plan something', value: 'plan' },
        { label: 'B', body: 'Not now', value: 'snoozed' },
      ],
      allow_freeform: true,
      idempotency: {
        project_slug: ctx.project_slug,
        topic_id: ctx.topic_id,
        seed: `wow:06:${reminder_id}`,
      },
    })
    const { prompt_id } = await ctx.channel.emitPrompt({
      prompt,
      topic_id: ctx.topic_id,
    })

    return {
      fired: true,
      reason: 'interest_check_scheduled',
      redacted_payload: {
        interest_name_hash: hashName(target.name),
        cadence,
        interest_count: interests.length,
      },
      follow_up_prompt_id: prompt_id,
    }
  },

  decodeEngagement(value: string): WowEngagement | null {
    if (value === 'plan') return 'will_handle'
    if (value === 'snoozed') return 'snoozed'
    return null
  },
}

function readInterests(ctx: WowActionContext): NonWorkInterest[] {
  const raw = ctx.interview.phase_state_json?.['non_work_interests']
  if (!Array.isArray(raw)) return []
  const out: NonWorkInterest[] = []
  for (const item of raw) {
    const parsed = parseInterest(item)
    if (parsed !== null) out.push(parsed)
  }
  return out
}

function parseInterest(value: unknown): NonWorkInterest | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? { name: trimmed } : null
  }
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  const name = typeof obj['name'] === 'string' ? obj['name'].trim() : ''
  if (name.length === 0) return null
  const out: NonWorkInterest = { name }
  if (typeof obj['basis'] === 'string') out.basis = obj['basis']
  const cadence = obj['cadence_hint']
  if (cadence === 'weekly' || cadence === 'monthly' || cadence === 'occasional') {
    out.cadence_hint = cadence
  }
  return out
}

function composeRecurringBody(interest_name: string): string {
  return (
    `Check in on the user's interest in ${interest_name}: how is it going, ` +
    `what would help right now, anything to plan? Adapt to current weather, ` +
    `calendar, and recent context.`
  )
}

function composeImmediatePromptBody(interest_name: string): string {
  return (
    `You mentioned ${interest_name} a few times. Want me to plan a session ` +
    `this week — find something nearby, block the calendar, the works?\n\n` +
    `(Or skip and I'll check back later.)`
  )
}

function hashName(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 16)
}

export default action06
