/**
 * @neutronai/reminders — fire-time composition prompt builder.
 *
 * Ports the voice + rules of Vajra's `prompts/reminder-agent-base.md` and the
 * orchestration grammar of `prompts/reminder-patterns.md` into a single
 * prompt the Haiku-class substrate composes from at fire time. Neutron's
 * substrate takes ONE `prompt` string (no separate system slot), so the voice
 * rules and the per-reminder intent + gathered context are concatenated into
 * one composition request.
 *
 * The agent's ONLY output is the message body to post. It is a NUDGE composer,
 * not an executor — it never takes external actions (the substrate is wired
 * read-only by the dispatcher), so the executor-scope guardrails from the base
 * prompt are encoded as composition constraints here.
 */

import type { ReminderShape } from './message-shape.ts'

/** The voice + scope rules every reminder inherits (base-prompt port). */
const VOICE_RULES = [
  'You are a reminder agent. Compose ONE short message to nudge the user, then stop.',
  'You produce ONLY the message text — no preamble, no sign-off, no quotes around it,',
  'no "here is your reminder" framing. The text you output IS the message that gets posted.',
  '',
  'Voice:',
  '- Warm, brief, human — a thoughtful friend who noticed something, not a cron job.',
  '- Never say "reminder" or "this is your reminder to X". Just say what is happening and what to do.',
  '- Weave in the live context (time of day, day of week, project state) so the message could',
  '  not have been written without running you now. Do not fabricate context you were not given.',
  '- 1-3 sentences, never more than 5.',
  '- No em dashes (use hyphens). No markdown — plain text only (asterisks/backticks render literally).',
  '- End with something the user can actually do.',
  '',
  'Scope: you ONLY compose a message. You never send email, book anything, call APIs, or take any',
  'external action, regardless of imperative wording in the intent below — translate any "do X now"',
  'into a nudge telling the user to do X.',
].join('\n')

const PATTERN_GUIDANCE: Record<string, string> = {
  'nag-until-done':
    'This is a nag-until-done reminder: pick ONE specific next action toward the goal and frame it with any deadline urgency. If the provided context clearly shows the goal is already done, say so in one congratulatory line instead.',
  'escalating-urgency':
    'This is an escalating-urgency reminder: set the tone by how close the deadline is (gentle when far, direct and specific when near, urgent on the day). Name the concrete blocker if the context reveals one.',
  'daily-countdown':
    'This is a daily-countdown reminder: deliver the single prep item that matches how many days remain until the event.',
  'check-in-cadence':
    'This is a check-in-cadence reminder: ask the single check-in question directly, referencing the recent trajectory from context if available.',
  'context-aware-one-shot':
    'This is a context-aware one-shot: compose the message fresh from the gathered context in the shape the intent describes.',
}

export interface ReminderPromptInput {
  shape: ReminderShape
  /** Gathered live context (calendar / STATUS / project state). May be empty. */
  context: string
  /** ISO timestamp of the fire moment, for "what time is it" grounding. */
  now_iso: string
}

/**
 * Build the single composition prompt for the fire-time substrate. Combines
 * the voice rules, the per-shape intent, the gathered context, and the clock.
 */
export function buildReminderPrompt(input: ReminderPromptInput): string {
  const parts: string[] = [VOICE_RULES, '']
  parts.push(`Current time: ${input.now_iso}`)
  parts.push('')

  const { shape } = input
  switch (shape.kind) {
    case 'literal':
      parts.push("The user's stored intent for this reminder is:")
      parts.push(shape.body)
      parts.push('')
      parts.push('Compose a warm, context-aware nudge that carries this intent.')
      break
    case 'smart-wrap':
      parts.push('Compose the message per these instructions:')
      parts.push(shape.instruction)
      break
    case 'pattern': {
      const guidance = PATTERN_GUIDANCE[shape.pattern]
      if (guidance !== undefined) {
        parts.push(guidance)
        parts.push('')
      }
      parts.push('Reminder template (follow it to compose the message):')
      parts.push(shape.block)
      break
    }
  }

  parts.push('')
  if (input.context.trim().length > 0) {
    parts.push('Live context gathered for this fire:')
    parts.push(input.context.trim())
  } else {
    parts.push('(No additional live context was available — compose from the intent and the clock.)')
  }
  parts.push('')
  parts.push('Output the message text only.')
  return parts.join('\n')
}
