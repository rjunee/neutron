/**
 * @neutronai/calendar-core — pre-meeting-brief composer.
 *
 * Composes a free-form, conversational Haiku-4.5 brief over the
 * structured `calendar_brief` row (title + duration + attendees +
 * agenda + prior_context). Deterministic `llm_error` fallback when the
 * LLM call throws — a transient outage never silently drops a meeting
 * reminder.
 *
 * Mental-model lift from internal design notes —
 * re-implemented in-tree (per § 8 invariant 2 — zero direct imports
 * from external sources).
 */

import { createHash } from 'node:crypto'

import type { CalendarBriefToolOutput } from './tools.ts'

/** Locked v1 prompt template — embedded as a string constant so the
 *  snapshot test in `__tests__/pre-meeting-brief.test.ts` catches
 *  inadvertent drift. */
export const PRE_MEETING_BRIEF_PROMPT_TEMPLATE = `You are the user's pre-meeting brief composer. The user has a meeting starting in {{lead_minutes}} minutes. Write a 3-6 sentence brief covering:

1. What this meeting is about (one sentence — derived from title + agenda below).
2. Who else is on it (attendees + your one-line read of any relevant prior context bullets).
3. The single most important thing the user should remember walking in (one sentence — your best read of the context).

Keep the tone direct, no filler, no greetings. The user is a busy operator — every sentence must earn its place.

EVENT
- title: {{title}}
- starts: {{start_local}} ({{user_tz}})
- duration: {{duration_minutes}} min
- agenda:
{{agenda_bullets_or_none}}

ATTENDEES
{{attendee_bullets}}

PRIOR CONTEXT (from Notes / Tasks lookups against attendees)
{{prior_context_bullets_or_none}}` as const

export type PreMeetingBriefOutcome = 'ok' | 'llm_error'

export interface PreMeetingBrief {
  text: string
  prompt_hash: string
  model: string
  outcome: PreMeetingBriefOutcome
}

export interface PreMeetingBriefDeps {
  briefRow: CalendarBriefToolOutput['brief']
  priorContext: readonly string[]
  userTz: string
  /** Default 10. */
  leadMinutes?: number
  /** Resolves to the FAST_MODEL id used in the brief metadata. */
  modelId: string
  /** Pluggable LLM call. Production wires the @neutronai/runtime
   *  fast-model dispatcher; tests inject a deterministic stub. */
  llm: (prompt: string) => Promise<string>
}

/**
 * Render the prompt for `deps.briefRow`. Exposed for the snapshot test.
 */
export function renderBriefPrompt(deps: Omit<PreMeetingBriefDeps, 'llm' | 'modelId'>): string {
  const lead = deps.leadMinutes ?? 10
  const tz = deps.userTz
  const startLocal = formatLocal(deps.briefRow.start, tz)
  const agenda = deps.briefRow.agenda
  const agendaBlock =
    agenda.length === 0
      ? '  (no agenda items extracted from description)'
      : agenda.map((a) => `  - ${a}`).join('\n')
  const attendees = deps.briefRow.attendees
  const attendeeBlock =
    attendees.length === 0
      ? '  (no attendees on the event)'
      : attendees.map((a) => `  - ${a}`).join('\n')
  const prior = deps.priorContext
  const priorBlock =
    prior.length === 0
      ? '  (no prior context found)'
      : prior.map((p) => `  - ${p}`).join('\n')
  return PRE_MEETING_BRIEF_PROMPT_TEMPLATE.replace('{{lead_minutes}}', String(lead))
    .replace('{{title}}', deps.briefRow.title)
    .replace('{{start_local}}', startLocal)
    .replace('{{user_tz}}', tz)
    .replace('{{duration_minutes}}', String(deps.briefRow.duration_minutes))
    .replace('{{agenda_bullets_or_none}}', agendaBlock)
    .replace('{{attendee_bullets}}', attendeeBlock)
    .replace('{{prior_context_bullets_or_none}}', priorBlock)
}

function formatLocal(iso: string, tz: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try {
    return d.toLocaleString('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return d.toISOString()
  }
}

/**
 * Compose the brief. Calls `deps.llm(prompt)`; on throw returns a
 * deterministic `'llm_error'` fallback (the raw structured row
 * rendered as bullets) so a transient outage never drops a meeting
 * reminder silently.
 */
export async function composePreMeetingBrief(
  deps: PreMeetingBriefDeps,
): Promise<PreMeetingBrief> {
  const prompt = renderBriefPrompt(deps)
  const prompt_hash = createHash('sha256').update(prompt).digest('hex')
  try {
    const text = await deps.llm(prompt)
    return {
      text: text.trim(),
      prompt_hash,
      model: deps.modelId,
      outcome: 'ok',
    }
  } catch {
    // Deterministic fallback — render the structured row directly.
    // Same shape the audit log records under `outcome='llm_error'`.
    const lines: string[] = []
    lines.push(`Pre-meeting brief (LLM unavailable, falling back to structured row):`)
    lines.push(`• ${deps.briefRow.title}`)
    lines.push(
      `• ${formatLocal(deps.briefRow.start, deps.userTz)} • ${deps.briefRow.duration_minutes} min`,
    )
    if (deps.briefRow.attendees.length > 0) {
      lines.push(`• Attendees: ${deps.briefRow.attendees.join(', ')}`)
    }
    if (deps.briefRow.agenda.length > 0) {
      lines.push(`• Agenda: ${deps.briefRow.agenda.join('; ')}`)
    }
    return {
      text: lines.join('\n'),
      prompt_hash,
      model: deps.modelId,
      outcome: 'llm_error',
    }
  }
}
