/**
 * @neutronai/calendar-core — `/cal` chat-command parser + dispatcher.
 *
 * Pure data-shape: `parseCalCommand(raw)` returns a typed `CalCommand`
 * discriminated union; `executeCalCommand(cmd, ctx)` walks it against
 * a `CalendarClient` and returns a render-ready response envelope.
 * The chat-bridge calls `parseCalCommand` first; if the result is
 * `'unrecognized'`, the bridge falls through to the normal LLM
 * dispatch path. If the result is anything else, the bridge calls
 * `executeCalCommand` and posts the response back as a tool-call-
 * shape message + short-circuits the LLM.
 *
 * Five sub-commands (mirrors the owner's existing `gog calendar` daily-
 * driver shape per § 3.2 of the Calendar Core S1 brief):
 *
 *   /cal show <date_or_range>        → list events in window
 *   /cal create <spec>                → create event from nat-lang
 *   /cal find-time <emails> <dur>    → propose slots over freebusy
 *   /cal next                         → next single upcoming event
 *   /cal invite <event_id> <emails>  → add attendees to event
 *
 * Plus `/cal` with no args → `{ kind: 'help' }`; everything else →
 * `{ kind: 'unrecognized', reason }` so the LLM path picks it up.
 *
 * Date parsing: `today`, `tomorrow`, `this week`, `next 7 days`,
 * weekday names (case-insensitive `monday`..`sunday`), ISO dates
 * (`YYYY-MM-DD`) + ISO ranges (`YYYY-MM-DD..YYYY-MM-DD`). v1 does
 * NOT support free-form natural-language dates ("next thursday at
 * 3pm" etc.) — keeps the parser deterministic + testable; the LLM
 * path catches malformed dates by falling through to the agent
 * which can synthesize a calendar_create call directly.
 */

import {
  DEFAULT_CALENDAR_ID,
  type CalendarClient,
  type CalendarEventRow,
  type TimeSlot,
} from './backend.ts'
import type { CalendarProjectCache } from './cache.ts'

export type CalCommand =
  | { kind: 'show'; window: { range_start: string; range_end: string }; label: string }
  | {
      kind: 'create'
      title: string
      start: string
      end: string
      attendees: readonly string[]
    }
  | {
      kind: 'find_time'
      attendees: readonly string[]
      duration_minutes: number
    }
  | { kind: 'next' }
  | {
      kind: 'invite'
      event_id: string
      emails: readonly string[]
    }
  | { kind: 'help' }
  | { kind: 'unrecognized'; reason: string }

export type CalCommandErrorCode =
  | 'malformed'
  | 'unknown_event'
  | 'oauth_missing'
  | 'capability_denied'
  | 'no_slot_found'
  | 'create_failed'
  | 'invite_failed'

export interface CalCommandResponse {
  text: string
  data?: unknown
  deep_link?: string
  error?: { code: CalCommandErrorCode; message: string }
}

export interface CalCommandContext {
  client: CalendarClient
  cache?: CalendarProjectCache | null
  project_id?: string
  user_id?: string
  user_email?: string | null
  user_tz?: string
  now: Date
}

/* ─── Parser ──────────────────────────────────────────────────────── */

const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}

/**
 * Parse a `/cal ...` chat message. Pure — no I/O, no client touching.
 * Returns `{kind:'unrecognized', reason}` for malformed bodies so the
 * caller can fall through to the LLM path; returns `{kind:'help'}` for
 * a bare `/cal` so the user gets a cheatsheet.
 *
 * `now` is required so date parsing is deterministic.
 */
export function parseCalCommand(raw: string, now: Date): CalCommand {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('/cal')) {
    return { kind: 'unrecognized', reason: 'does not start with /cal' }
  }
  const body = trimmed.slice('/cal'.length).trim()
  if (body.length === 0) return { kind: 'help' }
  const verbMatch = body.match(/^(\S+)\s*(.*)$/)
  if (verbMatch === null) return { kind: 'unrecognized', reason: 'no verb' }
  const verb = (verbMatch[1] ?? '').toLowerCase()
  const rest = (verbMatch[2] ?? '').trim()
  switch (verb) {
    case 'show':
      return parseShow(rest, now)
    case 'create':
      return parseCreate(rest, now)
    case 'find-time':
    case 'find_time':
    case 'findtime':
      return parseFindTime(rest)
    case 'next':
      return { kind: 'next' }
    case 'invite':
      return parseInvite(rest)
    case 'help':
    case '?':
      return { kind: 'help' }
    default:
      return { kind: 'unrecognized', reason: `unknown verb: ${verb}` }
  }
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime())
  out.setDate(out.getDate() + days)
  return out
}

function parseShow(rest: string, now: Date): CalCommand {
  const arg = rest.length > 0 ? rest.toLowerCase() : 'today'
  const todayStart = startOfDay(now)
  if (arg === 'today') {
    return {
      kind: 'show',
      label: 'today',
      window: {
        range_start: todayStart.toISOString(),
        range_end: addDays(todayStart, 1).toISOString(),
      },
    }
  }
  if (arg === 'tomorrow') {
    const tomorrow = addDays(todayStart, 1)
    return {
      kind: 'show',
      label: 'tomorrow',
      window: {
        range_start: tomorrow.toISOString(),
        range_end: addDays(tomorrow, 1).toISOString(),
      },
    }
  }
  if (arg === 'this week') {
    // Start of this week = today; end = +7 days. ("This week" =
    // forward-looking 7 days, NOT calendar week — matches the owner's
    // muscle-memory shape per § 3.2 of the brief.)
    return {
      kind: 'show',
      label: 'this week',
      window: {
        range_start: todayStart.toISOString(),
        range_end: addDays(todayStart, 7).toISOString(),
      },
    }
  }
  const next7Match = arg.match(/^next\s+(\d+)\s+days?$/)
  if (next7Match !== null) {
    const n = Math.max(1, Math.min(60, Number.parseInt(next7Match[1] ?? '7', 10)))
    return {
      kind: 'show',
      label: `next ${n} days`,
      window: {
        range_start: todayStart.toISOString(),
        range_end: addDays(todayStart, n).toISOString(),
      },
    }
  }
  if (Object.prototype.hasOwnProperty.call(WEEKDAYS, arg)) {
    const targetDow = WEEKDAYS[arg] as number
    const cur = now.getDay()
    let delta = (targetDow - cur + 7) % 7
    if (delta === 0) delta = 7 // "monday" said on a Monday means NEXT Monday
    const target = addDays(todayStart, delta)
    return {
      kind: 'show',
      label: arg,
      window: {
        range_start: target.toISOString(),
        range_end: addDays(target, 1).toISOString(),
      },
    }
  }
  const rangeMatch = arg.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/)
  if (rangeMatch !== null) {
    const start = new Date(`${rangeMatch[1]}T00:00:00`)
    const end = new Date(`${rangeMatch[2]}T00:00:00`)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return { kind: 'unrecognized', reason: `malformed date range: ${arg}` }
    }
    return {
      kind: 'show',
      label: arg,
      window: {
        range_start: start.toISOString(),
        range_end: addDays(end, 1).toISOString(),
      },
    }
  }
  const isoMatch = arg.match(/^(\d{4}-\d{2}-\d{2})$/)
  if (isoMatch !== null) {
    const start = new Date(`${isoMatch[1]}T00:00:00`)
    if (Number.isNaN(start.getTime())) {
      return { kind: 'unrecognized', reason: `malformed date: ${arg}` }
    }
    return {
      kind: 'show',
      label: isoMatch[1] ?? arg,
      window: {
        range_start: start.toISOString(),
        range_end: addDays(start, 1).toISOString(),
      },
    }
  }
  return { kind: 'unrecognized', reason: `unrecognized date token: ${arg}` }
}

const EMAIL_RE = /^[^\s,@]+@[^\s,@.]+(?:\.[^\s,@.]+)+$/

function splitEmails(raw: string): string[] {
  if (raw.trim().length === 0) return []
  const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0)
  return parts.filter((p) => EMAIL_RE.test(p))
}

function parseCreate(rest: string, now: Date): CalCommand {
  // Heuristic v1 nat-lang parser:
  //   <title> @ <when> for <duration> [with <emails>]
  //
  // <when>     ::= 'today'|'tomorrow'|<HH:mm>|<YYYY-MM-DD>T<HH:mm>|<weekday>@<HH:mm>
  // <duration> ::= <n>m|<n>min|<n>mins|<n>h|<n>hr|<n>hrs|<n>m
  //
  // Anything that doesn't parse → unrecognized with a clear reason.
  // Misses fall through to the LLM path which can synthesize a
  // `calendar_create` call from a richer prompt.
  if (rest.length === 0) {
    return { kind: 'unrecognized', reason: 'expected: /cal create <title> @ <when> for <duration> [with <emails>]' }
  }
  const atIdx = rest.indexOf(' @ ')
  if (atIdx < 0) {
    return { kind: 'unrecognized', reason: 'missing " @ <when>"' }
  }
  const title = rest.slice(0, atIdx).trim()
  if (title.length === 0) return { kind: 'unrecognized', reason: 'empty title' }
  const afterAt = rest.slice(atIdx + 3).trim()
  // Split on " for " — the duration follows; anything after " with "
  // is the attendee list.
  const forIdx = afterAt.indexOf(' for ')
  if (forIdx < 0) {
    return { kind: 'unrecognized', reason: 'missing " for <duration>"' }
  }
  const whenRaw = afterAt.slice(0, forIdx).trim()
  const afterFor = afterAt.slice(forIdx + 5).trim()
  let durationRaw = afterFor
  let attendeesRaw = ''
  const withIdx = afterFor.indexOf(' with ')
  if (withIdx >= 0) {
    durationRaw = afterFor.slice(0, withIdx).trim()
    attendeesRaw = afterFor.slice(withIdx + 6).trim()
  }
  const start = resolveWhen(whenRaw, now)
  if (start === null) {
    return { kind: 'unrecognized', reason: `unrecognized "when": ${whenRaw}` }
  }
  const durMinutes = parseDuration(durationRaw)
  if (durMinutes === null) {
    return { kind: 'unrecognized', reason: `unrecognized "duration": ${durationRaw}` }
  }
  const end = new Date(start.getTime() + durMinutes * 60_000)
  const attendees = splitEmails(attendeesRaw)
  return {
    kind: 'create',
    title,
    start: start.toISOString(),
    end: end.toISOString(),
    attendees,
  }
}

function parseDuration(raw: string): number | null {
  const cleaned = raw.toLowerCase().replace(/\s+/g, '')
  const m = cleaned.match(/^(\d+)(m|min|mins|minutes|h|hr|hrs|hour|hours)$/)
  if (m === null) return null
  const n = Number.parseInt(m[1] ?? '0', 10)
  const unit = m[2] ?? 'm'
  if (n <= 0) return null
  if (unit === 'm' || unit === 'min' || unit === 'mins' || unit === 'minutes') {
    return n
  }
  return n * 60
}

function resolveWhen(raw: string, now: Date): Date | null {
  const lower = raw.toLowerCase()
  // `YYYY-MM-DDTHH:mm` (ISO local).
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/)
  if (isoMatch !== null) {
    const d = new Date(`${isoMatch[1]}T${isoMatch[2]}:${isoMatch[3]}:00`)
    return Number.isNaN(d.getTime()) ? null : d
  }
  // `today HH:mm` / `tomorrow HH:mm` / `<weekday> HH:mm`.
  const dayThenTime = lower.match(/^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(\d{1,2}):(\d{2})$/)
  if (dayThenTime !== null) {
    const dayTok = dayThenTime[1] ?? 'today'
    const hour = Number.parseInt(dayThenTime[2] ?? '0', 10)
    const minute = Number.parseInt(dayThenTime[3] ?? '0', 10)
    const base = startOfDay(now)
    let target: Date
    if (dayTok === 'today') {
      target = base
    } else if (dayTok === 'tomorrow') {
      target = addDays(base, 1)
    } else {
      const dow = WEEKDAYS[dayTok] as number
      const cur = now.getDay()
      let delta = (dow - cur + 7) % 7
      if (delta === 0) delta = 7
      target = addDays(base, delta)
    }
    return new Date(target.getFullYear(), target.getMonth(), target.getDate(), hour, minute, 0)
  }
  return null
}

function parseFindTime(rest: string): CalCommand {
  if (rest.length === 0) {
    return { kind: 'unrecognized', reason: 'expected: /cal find-time <emails> <duration>' }
  }
  const parts = rest.split(/\s+/).filter((s) => s.length > 0)
  if (parts.length < 2) {
    return { kind: 'unrecognized', reason: 'expected emails + duration' }
  }
  const durationTok = parts[parts.length - 1] ?? ''
  const emailsRaw = parts.slice(0, -1).join(' ')
  const attendees = splitEmails(emailsRaw)
  const duration = parseDuration(durationTok)
  if (attendees.length === 0) {
    return { kind: 'unrecognized', reason: 'no valid emails' }
  }
  if (duration === null) {
    return { kind: 'unrecognized', reason: `unrecognized duration: ${durationTok}` }
  }
  return { kind: 'find_time', attendees, duration_minutes: duration }
}

function parseInvite(rest: string): CalCommand {
  if (rest.length === 0) {
    return { kind: 'unrecognized', reason: 'expected: /cal invite <event_id> <emails>' }
  }
  const parts = rest.split(/\s+/).filter((s) => s.length > 0)
  if (parts.length < 2) {
    return { kind: 'unrecognized', reason: 'expected event_id + emails' }
  }
  const event_id = parts[0] ?? ''
  const emails = splitEmails(parts.slice(1).join(' '))
  if (emails.length === 0) {
    return { kind: 'unrecognized', reason: 'no valid emails' }
  }
  return { kind: 'invite', event_id, emails }
}

/* ─── Dispatcher ──────────────────────────────────────────────────── */

const HELP_TEXT =
  '/cal commands:\n' +
  '  /cal show <today|tomorrow|this week|next N days|YYYY-MM-DD|YYYY-MM-DD..YYYY-MM-DD>\n' +
  '  /cal create <title> @ <when> for <duration> [with <emails>]\n' +
  '  /cal find-time <emails> <duration>\n' +
  '  /cal next\n' +
  '  /cal invite <event_id> <emails>'

/**
 * Walk a parsed `CalCommand` against the supplied `CalendarClient` and
 * return a render-ready chat envelope. Pure async over the client +
 * cache — surfaces the four typed error shapes the brief locks
 * (oauth_missing / unknown_event / no_slot_found / malformed).
 */
export async function executeCalCommand(
  cmd: CalCommand,
  ctx: CalCommandContext,
): Promise<CalCommandResponse> {
  switch (cmd.kind) {
    case 'help':
      return { text: HELP_TEXT }
    case 'unrecognized':
      return {
        text: HELP_TEXT,
        error: { code: 'malformed', message: cmd.reason },
      }
    case 'show':
      return executeShow(cmd, ctx)
    case 'create':
      return executeCreate(cmd, ctx)
    case 'find_time':
      return executeFindTime(cmd, ctx)
    case 'next':
      return executeNext(ctx)
    case 'invite':
      return executeInvite(cmd, ctx)
  }
}

async function executeShow(
  cmd: Extract<CalCommand, { kind: 'show' }>,
  ctx: CalCommandContext,
): Promise<CalCommandResponse> {
  try {
    const listInput: Parameters<CalendarClient['list']>[0] = {
      range_start: cmd.window.range_start,
      range_end: cmd.window.range_end,
      limit: 10,
    }
    if (ctx.project_id !== undefined && ctx.project_id.length > 0) {
      listInput.project_id = ctx.project_id
    }
    const results = await ctx.client.list(listInput)
    if (results.length === 0) {
      return { text: `No events for ${cmd.label}.`, data: { events: [] } }
    }
    const lines = results.map((row) => `• ${formatRow(row, ctx.user_tz)}`)
    return {
      text: `${results.length} event(s) for ${cmd.label}:\n${lines.join('\n')}`,
      data: { events: results },
    }
  } catch (err) {
    return mapClientError(err)
  }
}

async function executeCreate(
  cmd: Extract<CalCommand, { kind: 'create' }>,
  ctx: CalCommandContext,
): Promise<CalCommandResponse> {
  try {
    const createInput: Parameters<CalendarClient['create']>[0] = {
      title: cmd.title,
      start: cmd.start,
      end: cmd.end,
      calendar_id: DEFAULT_CALENDAR_ID,
    }
    if (cmd.attendees.length > 0) createInput.attendees = [...cmd.attendees]
    if (ctx.project_id !== undefined && ctx.project_id.length > 0) {
      createInput.project_id = ctx.project_id
    }
    const event = await ctx.client.create(createInput)
    if (ctx.cache !== null && ctx.cache !== undefined) {
      try {
        ctx.cache.upsertEvents([event])
      } catch {
        // best-effort
      }
    }
    return {
      text: `Created: ${formatRow(event, ctx.user_tz)}`,
      data: { event },
      ...(event.html_link !== undefined ? { deep_link: event.html_link } : {}),
    }
  } catch (err) {
    return mapClientError(err, 'create_failed')
  }
}

async function executeFindTime(
  cmd: Extract<CalCommand, { kind: 'find_time' }>,
  ctx: CalCommandContext,
): Promise<CalCommandResponse> {
  try {
    // Window: tomorrow 09:00 local → +7 days. Mirrors the brief § 3.2
    // shape: "5 proposed slots (15-min granularity) over a 7-day window
    // starting tomorrow 09:00 local".
    const windowStart = startOfDay(addDays(ctx.now, 1))
    windowStart.setHours(9, 0, 0, 0)
    const windowEnd = addDays(windowStart, 7)
    const attendees = [...cmd.attendees]
    if (
      ctx.user_email !== undefined &&
      ctx.user_email !== null &&
      ctx.user_email.length > 0 &&
      !attendees.some((e) => e.toLowerCase() === ctx.user_email?.toLowerCase())
    ) {
      attendees.unshift(ctx.user_email)
    }
    const slots = await ctx.client.findTime({
      attendees,
      duration_minutes: cmd.duration_minutes,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      granularity_minutes: 15,
      max_slots: 5,
    })
    if (slots.length === 0) {
      return {
        text: `No slots found for ${attendees.length} attendee(s) over the next 7 days.`,
        error: { code: 'no_slot_found', message: 'no overlapping free window' },
      }
    }
    const lines = slots.map((s, i) => `${i + 1}. ${formatSlot(s, ctx.user_tz)}`)
    return {
      text: `Proposed ${slots.length} slot(s):\n${lines.join('\n')}`,
      data: { slots },
    }
  } catch (err) {
    return mapClientError(err)
  }
}

async function executeNext(
  ctx: CalCommandContext,
): Promise<CalCommandResponse> {
  try {
    const now = ctx.now
    const windowEnd = addDays(now, 30)
    const listInput: Parameters<CalendarClient['list']>[0] = {
      range_start: now.toISOString(),
      range_end: windowEnd.toISOString(),
      limit: 1,
    }
    if (ctx.project_id !== undefined && ctx.project_id.length > 0) {
      listInput.project_id = ctx.project_id
    }
    const results = await ctx.client.list(listInput)
    if (results.length === 0) {
      return { text: 'No upcoming events in the next 30 days.', data: { event: null } }
    }
    const next = results[0]
    if (next === undefined) {
      return { text: 'No upcoming events in the next 30 days.', data: { event: null } }
    }
    return {
      text: `Next: ${formatRow(next, ctx.user_tz)}`,
      data: { event: next },
      ...(next.html_link !== undefined ? { deep_link: next.html_link } : {}),
    }
  } catch (err) {
    return mapClientError(err)
  }
}

async function executeInvite(
  cmd: Extract<CalCommand, { kind: 'invite' }>,
  ctx: CalCommandContext,
): Promise<CalCommandResponse> {
  try {
    const event = await ctx.client.invite({
      event_id: cmd.event_id,
      add_emails: [...cmd.emails],
      send_updates: 'all',
    })
    return {
      text: `Invited ${cmd.emails.join(', ')} to "${event.title}".`,
      data: { event },
    }
  } catch (err) {
    return mapClientError(err, 'invite_failed')
  }
}

/* ─── Helpers ─────────────────────────────────────────────────────── */

function formatRow(row: CalendarEventRow, tz?: string): string {
  const start = new Date(row.start)
  const time = Number.isNaN(start.getTime())
    ? row.start
    : start.toLocaleString('en-US', {
        ...(tz !== undefined ? { timeZone: tz } : {}),
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
  return `${time} — ${row.title}`
}

function formatSlot(slot: TimeSlot, tz?: string): string {
  const start = new Date(slot.start)
  const startStr = Number.isNaN(start.getTime())
    ? slot.start
    : start.toLocaleString('en-US', {
        ...(tz !== undefined ? { timeZone: tz } : {}),
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
  return startStr
}

function mapClientError(
  err: unknown,
  defaultCode: CalCommandErrorCode = 'malformed',
): CalCommandResponse {
  const code = clientErrorCode(err) ?? defaultCode
  const message = err instanceof Error ? err.message : String(err)
  // Help-style text on every error path so the chat user always sees
  // a recognisable shape; the typed error rides on `error`.
  return {
    text:
      code === 'oauth_missing'
        ? 'Google Calendar is not connected — connect it from Settings → Integrations.'
        : `Calendar error: ${message}`,
    error: { code, message },
  }
}

function clientErrorCode(err: unknown): CalCommandErrorCode | null {
  if (err === null || typeof err !== 'object') return null
  const code = (err as { code?: unknown }).code
  if (typeof code !== 'string') return null
  if (code === 'oauth_missing') return 'oauth_missing'
  if (code === 'event_not_found') return 'unknown_event'
  if (code === 'capability_denied') return 'capability_denied'
  return null
}

/**
 * Convenience entry point — parse + execute in one call. The chat-
 * bridge wires this so the surface code stays a one-liner.
 */
export async function parseAndExecuteCalCommand(
  raw: string,
  ctx: CalCommandContext,
): Promise<{ command: CalCommand; response: CalCommandResponse }> {
  const command = parseCalCommand(raw, ctx.now)
  const response = await executeCalCommand(command, ctx)
  return { command, response }
}
