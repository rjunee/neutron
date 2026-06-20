/**
 * Action 2 — lifestyle reminders.
 *
 * Per docs/plans/P2-onboarding.md § 2.5 #2. Fires when interview's
 * `phase_state_json.rituals_captured` (or `ctx.rituals`) array has ≥1
 * entry of kind `morning|evening|weekly` AND time-of-day captured.
 *
 * Owned-data write into `reminders` table. Up to 3 reminder rows + a
 * `[A] Looks good [B] Tweak [C] Skip` button-prompt.
 *
 * Reversibility: `[B]` enters edit flow; `[C]` deletes the rows.
 *
 * Failure mode: SQLite write retries via `persistence/retry.ts`; if 3
 * attempts fail, the runner records substrate-error.
 */

import { buildButtonPrompt } from '../../../channels/button-primitive.ts'
import type { CreateReminderInput } from '../../../reminders/store.ts'
import type {
  RitualEntry,
  WowActionContext,
  WowActionModule,
  WowActionResult,
} from '../action-types.ts'
import type { WowEngagement } from '../telemetry.ts'

const ACTION_ID = '02-lifestyle-reminders' as const
const MAX_REMINDERS = 3

const action02: WowActionModule = {
  action_id: ACTION_ID,

  triggerCondition(ctx: WowActionContext): boolean {
    return validRituals(ctx.rituals).length > 0
  },

  async run(ctx: WowActionContext): Promise<WowActionResult> {
    const candidates = validRituals(ctx.rituals).slice(0, MAX_REMINDERS)
    const inserted: string[] = []
    const titles: string[] = []
    for (const r of candidates) {
      const fire_at = nextFireAt(r, ctx.now())
      const id = ctx.uuid()
      const input: CreateReminderInput = {
        id,
        project_slug: ctx.project_slug,
        topic_id: ctx.topic_id,
        fire_at,
        message: composeReminderMessage(r),
      }
      await ctx.reminders.create(input)
      inserted.push(id)
      titles.push(`${r.kind} ${r.label}`)
    }
    const prompt = buildButtonPrompt({
      body: composePromptBody(titles),
      options: [
        { label: 'A', body: 'Looks good', value: 'kept' },
        { label: 'B', body: 'Tweak', value: 'tweaked' },
        { label: 'C', body: 'Skip', value: 'skipped' },
      ],
      allow_freeform: false,
      idempotency: {
        project_slug: ctx.project_slug,
        topic_id: ctx.topic_id,
        seed: `wow:02:${inserted.join(',')}`,
      },
    })
    const { prompt_id } = await ctx.channel.emitPrompt({
      prompt,
      topic_id: ctx.topic_id,
    })
    return {
      fired: true,
      reason: 'reminders_inserted',
      redacted_payload: {
        count: inserted.length,
        kinds: candidates.map((r) => r.kind),
      },
      follow_up_prompt_id: prompt_id,
    }
  },

  decodeEngagement(value: string): WowEngagement | null {
    if (value === 'kept' || value === 'tweaked' || value === 'skipped') return value
    return null
  },
}

function validRituals(rituals: RitualEntry[]): RitualEntry[] {
  return rituals.filter(
    (r) =>
      (r.kind === 'morning' || r.kind === 'evening' || r.kind === 'weekly') &&
      typeof r.time_of_day === 'string' &&
      /^\d{1,2}:\d{2}$/.test(r.time_of_day),
  )
}

function nextFireAt(r: RitualEntry, now_ms: number): number {
  // Schedule the first instance ~1h ahead (clamps to a coarse "soon"
  // window). Production cron rolls forward thereafter; this initial
  // landing time is enough for the wow-moment to show "your reminder
  // is set for X" in the prompt body.
  const oneHourSec = 60 * 60
  return Math.floor(now_ms / 1000) + oneHourSec
}

function composeReminderMessage(r: RitualEntry): string {
  return `${capitalize(r.kind)} ritual: ${r.label} (${r.time_of_day}).`
}

function composePromptBody(titles: string[]): string {
  if (titles.length === 0) return 'I scheduled your rituals.'
  const lines: string[] = []
  lines.push('I scheduled these reminders for you:')
  for (const t of titles) lines.push(`- ${t}`)
  lines.push('')
  lines.push('Tap below to keep, tweak, or skip.')
  return lines.join('\n')
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)
}

export default action02
