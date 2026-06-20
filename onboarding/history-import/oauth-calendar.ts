/**
 * @neutronai/onboarding/history-import — Google Calendar OAuth importer (P2 S3).
 *
 * Per docs/plans/P2-onboarding.md § 6 S3. Pulls the last 365 days of
 * events. Each event becomes a degenerate single-message ConversationRecord
 * so the chunker + Pass-1 + Pass-2 pipeline ingests it uniformly with
 * ChatGPT/Claude/Gmail.
 */

import {
  ImportError,
  type ConversationMessage,
  type ConversationRecord,
  type OAuthRefs,
} from './types.ts'

export interface CalendarClient {
  /** List events in [since_ms, until_ms]. Sorted by start time ascending. */
  listEvents(input: {
    /** OAuth refs threaded from `fetchCalendarEvents.oauth`. The production
     *  client (`googleapis`) attaches these to every Calendar API call so
     *  the request authenticates as the signed-in user. */
    oauth: OAuthRefs
    since_ms: number
    until_ms: number
    max_results: number
  }): AsyncIterable<{
    event_id: string
    summary?: string
    description?: string
    start_ms: number
    end_ms?: number
    attendees?: Array<{ email?: string; display_name?: string }>
    organizer?: string
    location?: string
  }>
}

export interface FetchCalendarEventsInput {
  oauth: OAuthRefs
  client: CalendarClient
  /** Default 365 days. */
  window_days?: number
  /** Hard ceiling on events analyzed. Default 5_000. */
  max_events?: number
  now?: () => number
}

const DAY_MS = 24 * 60 * 60 * 1_000
const DEFAULT_WINDOW_DAYS = 365
const DEFAULT_MAX_EVENTS = 5_000

export async function* fetchCalendarEvents(
  input: FetchCalendarEventsInput,
): AsyncIterable<ConversationRecord> {
  if (input.oauth.access_token.length === 0) {
    throw new ImportError(
      'oauth_scope_missing',
      'calendar-oauth',
      'Calendar OAuth access_token is empty; user has not granted the calendar.readonly scope',
    )
  }
  const now = input.now?.() ?? Date.now()
  const window_days = input.window_days ?? DEFAULT_WINDOW_DAYS
  const max_events = input.max_events ?? DEFAULT_MAX_EVENTS
  const since_ms = now - window_days * DAY_MS
  const until_ms = now
  let count = 0
  for await (const evt of input.client.listEvents({
    oauth: input.oauth,
    since_ms,
    until_ms,
    max_results: max_events,
  })) {
    if (count >= max_events) break
    const text = renderEvent(evt)
    const message: ConversationMessage = {
      role: 'event',
      text,
      created_at: evt.start_ms,
    }
    yield {
      conversation_id: `calendar:${evt.event_id}`,
      title: evt.summary ?? '(untitled event)',
      created_at: evt.start_ms,
      messages: [message],
      meta: { source: 'calendar', event_id: evt.event_id },
    }
    count += 1
  }
}

function renderEvent(evt: {
  summary?: string
  description?: string
  start_ms: number
  end_ms?: number
  attendees?: Array<{ email?: string; display_name?: string }>
  organizer?: string
  location?: string
}): string {
  const parts: string[] = []
  parts.push(`Event: ${evt.summary ?? '(untitled)'}`)
  parts.push(`Starts: ${new Date(evt.start_ms).toISOString()}`)
  if (evt.end_ms !== undefined) parts.push(`Ends: ${new Date(evt.end_ms).toISOString()}`)
  if (evt.location !== undefined && evt.location.length > 0)
    parts.push(`Location: ${evt.location}`)
  if (evt.organizer !== undefined) parts.push(`Organizer: ${evt.organizer}`)
  if (evt.attendees !== undefined && evt.attendees.length > 0) {
    const list = evt.attendees
      .map((a) => a.display_name ?? a.email ?? '')
      .filter((s) => s.length > 0)
      .join(', ')
    if (list.length > 0) parts.push(`Attendees: ${list}`)
  }
  if (evt.description !== undefined && evt.description.length > 0) {
    parts.push('', evt.description.trim())
  }
  return parts.join('\n')
}
