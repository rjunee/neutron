/**
 * @neutronai/reminders-core — `/remind` chat-command parser + dispatcher.
 *
 * Pure parser + dispatcher pair. The parser is a side-effect-free
 * function the chat-bridge calls on every inbound message body to
 * decide whether to short-circuit the LLM path; the dispatcher calls
 * the matching `RemindersBackend` method (via the Core's substrate-
 * backed adapter) and returns a render-ready response envelope.
 *
 * The time-spec resolver is lifted from the Nova `remind` skill's
 * parser table — same grammar the long-running Nova users already
 * type ("in 30m", "tomorrow at 9am", "next friday 10:00", "every
 * weekday at 8am", ...). The engine's recurrence enum is
 * `'weekly' | 'monthly' | 'occasional'` only — `daily` rejects with a
 * hint to use the `nag-until-done` pattern (Shape C) so the engine
 * surface stays untouched (per brief § 3.2.2).
 *
 * The chat-bridge wires this into `app-ws-surface` via the new
 * `chatCommandFilter` hook: if `text.trimStart().startsWith('/remind')`,
 * the bridge calls `parseRemindCommand` + `executeRemindCommand`; if
 * the parser returns `unrecognized`, the bridge falls through to the
 * normal LLM path; if the parser returns any other shape, the bridge
 * posts the `RemindCommandResponse` back to the channel as an
 * `agent_message` envelope and short-circuits.
 */

import {
  REMINDER_PATTERN_NAMES,
  UnknownReminderPatternError,
  isReminderPatternName,
  type ReminderPatternName,
  type SmartWrapComposer,
} from './smart-wrap.ts'
import type {
  RemindersBackend,
  RemindersListInput,
  RemindersUpdateResult,
  ReminderRow,
} from './backend.ts'

/**
 * Resolved time-spec. The chat parser produces this; the dispatcher
 * feeds the `fire_at` into the backend's `create(...)` (or, for
 * recurring, would feed `createRecurring` — but the Core's backend
 * surface exposes `create` only as the public path; recurring writes
 * in the chat surface are explicitly out-of-scope per § 9 in the
 * brief, so a `recurring` resolved time-spec on `/remind capture` is
 * rejected by the dispatcher with an `unsupported_recurrence` error).
 *
 * Recurring is still part of the type so the parser can SURFACE the
 * recurrence intent — the dispatcher then chooses to reject it (S1)
 * or forward it once a follow-up sprint adds a recurring write path
 * to the chat surface.
 */
export type ResolvedTimeSpec =
  | { kind: 'one_shot'; fire_at: number }
  | {
      kind: 'recurring'
      fire_at: number
      recurrence: 'weekly' | 'monthly' | 'occasional'
    }

export type RemindCommand =
  | {
      kind: 'capture'
      body: string
      when: ResolvedTimeSpec
      mode: 'literal' | 'smart_wrap' | 'pattern'
      pattern?: ReminderPatternName
      pattern_slots?: Record<string, string>
    }
  | { kind: 'list'; project_id?: string }
  | { kind: 'cancel'; target: string }
  | { kind: 'snooze'; id: string; new_when: ResolvedTimeSpec }
  | { kind: 'update'; id: string; new_body: string }
  | { kind: 'help' }
  | {
      kind: 'unrecognized'
      reason:
        | 'not_a_remind_command'
        | 'malformed_time_spec'
        | 'unsupported_recurrence'
        | 'unknown_pattern'
        | 'past_time'
        | 'future_too_far'
        | 'empty_body'
    }

export type RemindCommandErrorCode =
  | 'malformed'
  | 'unknown_reminder'
  | 'multiple_matches'
  | 'empty_project'
  | 'capability_denied'
  | 'past_time'
  | 'future_too_far'
  | 'unknown_pattern'
  | 'unsupported_recurrence'
  | 'backend_error'

export interface RemindCommandResponse {
  /** Short confirmation / result one-liner for the chat reply. */
  text: string
  /** Optional structured result (reminder row / list / etc.). */
  data?: unknown
  /** Optional deep-link the channel may surface as a tap target. */
  deep_link?: string
  /** Optional inline buttons (P5.1 button primitives) the chat surface renders. */
  buttons?: Array<{ id: string; label: string; value: string }>
  /** True iff the command was malformed; the bridge surfaces a help block. */
  error?: {
    code: RemindCommandErrorCode
    message: string
  }
}

const VERB = '/remind'
const SUB_VERBS = new Set([
  'list',
  'cancel',
  'snooze',
  'update',
  'smart',
  'pattern',
])

/**
 * Maximum +5y in the future a fire_at may sit before the parser
 * rejects with `future_too_far`. Mirrors the constant in
 * `gateway/http/app-reminders-surface.ts` so the chat path and the
 * tab path enforce the same bounds.
 */
export const MAX_FUTURE_DRIFT_SECONDS = 60 * 60 * 24 * 365 * 5
/**
 * Maximum 60s in the past a fire_at may sit before the parser rejects
 * with `past_time`. Same constant the tab path uses.
 */
export const MAX_PAST_DRIFT_SECONDS = 60

/**
 * Default time-of-day in owner-local TZ when the user gives a date but
 * no time. Matches the Nova skill default. 9 AM gives the morning
 * brief shape that most reminders want.
 */
const DEFAULT_HOUR_LOCAL = 9
const DEFAULT_MINUTE_LOCAL = 0

const WEEKDAYS: ReadonlyArray<string> = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]
const WEEKDAY_SHORT: ReadonlyArray<string> = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
]
const MONTHS: ReadonlyArray<string> = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

/**
 * Pure parser. Splits on the first whitespace for the verb; everything
 * after the verb is parsed against the locked time-spec grammar.
 *
 * Sub-command disambiguation: `smart` / `pattern` / `list` / `cancel`
 * / `snooze` / `update` are reserved verbs only when they are the FIRST
 * token after `/remind `. `/remind list the dogs at 6pm` is interpreted
 * as a capture of "list the dogs" at 6pm BECAUSE the `list` sub-command
 * does not match any further argument shape (its valid shape is empty
 * OR a single project_id).
 *
 * `/remind` alone (no arg) → `{kind:'help'}` so the user gets a
 * cheatsheet when they discover the command.
 *
 * `now` is injected by the dispatcher so tests can pin the clock.
 */
export function parseRemindCommand(
  raw: string,
  opts: { now: Date },
): RemindCommand {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith(VERB)) {
    return { kind: 'unrecognized', reason: 'not_a_remind_command' }
  }
  // Strip the verb. After the verb either end-of-string or whitespace.
  const after = trimmed.slice(VERB.length)
  if (after.length === 0 || after.trim().length === 0) {
    return { kind: 'help' }
  }
  if (!/^\s/.test(after)) {
    // `/remindfoo` — not a real command (no whitespace after the verb).
    return { kind: 'unrecognized', reason: 'not_a_remind_command' }
  }
  const rest = after.trim()
  // First token (sub-verb) — case-insensitive against the reserved set.
  const firstSpace = firstWhitespace(rest)
  const firstToken = (firstSpace === -1 ? rest : rest.slice(0, firstSpace)).toLowerCase()
  if (firstToken === 'list') {
    const arg = firstSpace === -1 ? '' : rest.slice(firstSpace).trim()
    if (arg.length === 0) return { kind: 'list' }
    // `/remind list <project_id>` — a single project-id argument.
    // If the argument looks like a project_id (one bareword), accept;
    // otherwise treat as a capture of the whole phrase.
    if (/^[A-Za-z0-9_.-]+$/.test(arg)) {
      return { kind: 'list', project_id: arg }
    }
    // Fall through to capture handling.
    return parseCapture(rest, opts.now)
  }
  if (firstToken === 'cancel') {
    const arg = firstSpace === -1 ? '' : rest.slice(firstSpace).trim()
    if (arg.length === 0) {
      return { kind: 'unrecognized', reason: 'empty_body' }
    }
    return { kind: 'cancel', target: arg }
  }
  if (firstToken === 'snooze') {
    const arg = firstSpace === -1 ? '' : rest.slice(firstSpace).trim()
    if (arg.length === 0) {
      return { kind: 'unrecognized', reason: 'empty_body' }
    }
    // `<id> <time-spec>` — split the id off the front.
    const idSplit = firstWhitespace(arg)
    if (idSplit === -1) {
      return { kind: 'unrecognized', reason: 'malformed_time_spec' }
    }
    const id = arg.slice(0, idSplit).trim()
    const tail = arg.slice(idSplit).trim()
    if (id.length === 0 || tail.length === 0) {
      return { kind: 'unrecognized', reason: 'malformed_time_spec' }
    }
    const resolved = resolveTimeSpec(tail, opts.now)
    if (resolved === null) {
      return { kind: 'unrecognized', reason: 'malformed_time_spec' }
    }
    if (resolved.kind === 'past_time') {
      return { kind: 'unrecognized', reason: 'past_time' }
    }
    if (resolved.kind === 'future_too_far') {
      return { kind: 'unrecognized', reason: 'future_too_far' }
    }
    if (resolved.kind === 'unsupported_recurrence') {
      return { kind: 'unrecognized', reason: 'unsupported_recurrence' }
    }
    return { kind: 'snooze', id, new_when: resolved.spec }
  }
  if (firstToken === 'update') {
    const arg = firstSpace === -1 ? '' : rest.slice(firstSpace).trim()
    if (arg.length === 0) {
      return { kind: 'unrecognized', reason: 'empty_body' }
    }
    const idSplit = firstWhitespace(arg)
    if (idSplit === -1) {
      return { kind: 'unrecognized', reason: 'empty_body' }
    }
    const id = arg.slice(0, idSplit).trim()
    const body = arg.slice(idSplit).trim()
    if (id.length === 0 || body.length === 0) {
      return { kind: 'unrecognized', reason: 'empty_body' }
    }
    return { kind: 'update', id, new_body: body }
  }
  if (firstToken === 'smart') {
    const arg = firstSpace === -1 ? '' : rest.slice(firstSpace).trim()
    if (arg.length === 0) {
      return { kind: 'unrecognized', reason: 'empty_body' }
    }
    return parseCapture(arg, opts.now, { mode: 'smart_wrap' })
  }
  if (firstToken === 'pattern') {
    const arg = firstSpace === -1 ? '' : rest.slice(firstSpace).trim()
    if (arg.length === 0) {
      return { kind: 'unrecognized', reason: 'empty_body' }
    }
    // `<pattern-name> <body...> <time-spec>` — pattern name is first.
    const nameSplit = firstWhitespace(arg)
    if (nameSplit === -1) {
      return { kind: 'unrecognized', reason: 'unknown_pattern' }
    }
    const patternName = arg.slice(0, nameSplit).toLowerCase()
    if (!isReminderPatternName(patternName)) {
      return { kind: 'unrecognized', reason: 'unknown_pattern' }
    }
    const tail = arg.slice(nameSplit).trim()
    if (tail.length === 0) {
      return { kind: 'unrecognized', reason: 'empty_body' }
    }
    return parseCapture(tail, opts.now, { mode: 'pattern', pattern: patternName })
  }
  // Default — `/remind <body> <when>` capture.
  return parseCapture(rest, opts.now)
}

interface CaptureOpts {
  mode?: 'literal' | 'smart_wrap' | 'pattern'
  pattern?: ReminderPatternName
}

function parseCapture(rest: string, now: Date, opts: CaptureOpts = {}): RemindCommand {
  // Longest-suffix time-spec match: try progressively longer tail
  // windows until one parses cleanly, then everything before becomes
  // the body.
  const tokens = rest.split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) {
    return { kind: 'unrecognized', reason: 'empty_body' }
  }
  // The time-spec can be 1-7 tokens long; try from longest to shortest.
  const MAX_TIME_SPEC_TOKENS = 7
  for (
    let start = Math.max(0, tokens.length - MAX_TIME_SPEC_TOKENS);
    start < tokens.length;
    start += 1
  ) {
    const candidate = tokens.slice(start).join(' ')
    const resolved = resolveTimeSpec(candidate, now)
    if (resolved === null) continue
    if (resolved.kind === 'past_time') {
      return { kind: 'unrecognized', reason: 'past_time' }
    }
    if (resolved.kind === 'future_too_far') {
      return { kind: 'unrecognized', reason: 'future_too_far' }
    }
    if (resolved.kind === 'unsupported_recurrence') {
      return { kind: 'unrecognized', reason: 'unsupported_recurrence' }
    }
    const body = tokens.slice(0, start).join(' ').trim()
    if (body.length === 0) {
      return { kind: 'unrecognized', reason: 'empty_body' }
    }
    const result: RemindCommand = {
      kind: 'capture',
      body,
      when: resolved.spec,
      mode: opts.mode ?? 'literal',
    }
    if (opts.pattern !== undefined) result.pattern = opts.pattern
    return result
  }
  return { kind: 'unrecognized', reason: 'malformed_time_spec' }
}

type TimeSpecResult =
  | { kind: 'ok'; spec: ResolvedTimeSpec }
  | { kind: 'past_time' }
  | { kind: 'future_too_far' }
  | { kind: 'unsupported_recurrence' }

/**
 * Resolve a natural-language time-spec phrase against `now`. Returns
 * `null` when the phrase doesn't match any known shape. Returns a
 * tagged result otherwise so the caller can distinguish "didn't parse"
 * from "parsed but outside bounds".
 *
 * Exported for tests; not re-exported as a public API by the Core's
 * barrel (the chat-command parser is the public entry point).
 */
export function resolveTimeSpec(raw: string, now: Date): TimeSpecResult | null {
  const phrase = raw.trim().toLowerCase()
  if (phrase.length === 0) return null

  // Daily rejection — engine has weekly / monthly / occasional only.
  if (/^daily(?:\s+at\s+|\s+)/.test(phrase) || /^every\s+day(?:\s+at\s+|\s+|$)/.test(phrase)) {
    return { kind: 'unsupported_recurrence' }
  }

  // every weekday — same rejection; engine has no daily cadence.
  if (/^every\s+weekday(?:\s+at\s+|\s+|$)/.test(phrase)) {
    return { kind: 'unsupported_recurrence' }
  }

  // `in <N> <unit>` — relative one-shot.
  const inMatch = /^in\s+(\d+)\s*(min(?:ute)?s?|m|h(?:ours?)?|d(?:ays?)?|s(?:ec(?:ond)?s?)?)$/i
    .exec(phrase)
  if (inMatch !== null) {
    const n = Number(inMatch[1])
    const unit = inMatch[2]!.toLowerCase()
    let seconds: number
    if (unit === 's' || unit.startsWith('sec')) seconds = n
    else if (unit === 'min' || unit === 'minute' || unit === 'minutes' || unit === 'mins' || unit === 'm') seconds = n * 60
    else if (unit === 'h' || unit.startsWith('hour')) seconds = n * 3600
    else if (unit === 'd' || unit.startsWith('day')) seconds = n * 86400
    else return null
    const fire_at = Math.floor(now.getTime() / 1000) + seconds
    return checkBounds(fire_at, now, { kind: 'one_shot', fire_at })
  }

  // `every week on <weekday> at <HH:mm>` / `weekly <weekday> <HH:mm>`
  const weeklyMatch =
    /^(?:every\s+week\s+on\s+|weekly\s+)([a-z]+)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(
      phrase,
    )
  if (weeklyMatch !== null) {
    const weekday = matchWeekday(weeklyMatch[1]!)
    if (weekday === -1) return null
    const time = parseHM(weeklyMatch[2]!, weeklyMatch[3], weeklyMatch[4])
    if (time === null) return null
    const fire_at = nextWeekdayOccurrence(now, weekday, time.hour, time.minute)
    return checkBounds(fire_at, now, {
      kind: 'recurring',
      fire_at,
      recurrence: 'weekly',
    })
  }

  // `every month on the <Nth> at <HH:mm>` / `every month <N> <HH:mm>` /
  // `monthly <N> <HH:mm>` / `monthly on the <N>th at noon`
  const monthlyMatch =
    /^(?:every\s+month(?:\s+on(?:\s+the)?)?\s+|monthly(?:\s+on(?:\s+the)?)?\s+)(\d{1,2})(?:st|nd|rd|th)?\s+(?:at\s+)?(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/.exec(
      phrase,
    )
  if (monthlyMatch !== null) {
    const day = Number(monthlyMatch[1])
    if (!Number.isFinite(day) || day < 1 || day > 31) return null
    const timeStr = monthlyMatch[2]!
    const time = parseTimeWord(timeStr)
    if (time === null) return null
    const fire_at = nextMonthlyOccurrence(now, day, time.hour, time.minute)
    return checkBounds(fire_at, now, {
      kind: 'recurring',
      fire_at,
      recurrence: 'monthly',
    })
  }

  // `once in a while` / `occasionally`
  if (phrase === 'once in a while' || phrase === 'occasionally') {
    // Pick now+7d as the first occurrence; the engine's recurrence
    // advancement picks its own cadence at fire time.
    const fire_at = Math.floor(now.getTime() / 1000) + 7 * 86400
    return checkBounds(fire_at, now, {
      kind: 'recurring',
      fire_at,
      recurrence: 'occasional',
    })
  }

  // `tomorrow at <time>` / `tomorrow <HH:mm>` / `tomorrow`
  const tomorrowMatch = /^tomorrow(?:\s+(?:at\s+)?(.+))?$/.exec(phrase)
  if (tomorrowMatch !== null) {
    const timeStr = (tomorrowMatch[1] ?? '').trim()
    const time = timeStr.length === 0
      ? { hour: DEFAULT_HOUR_LOCAL, minute: DEFAULT_MINUTE_LOCAL }
      : parseTimeWord(timeStr)
    if (time === null) return null
    const fire_at = atLocalOffset(now, 1, time.hour, time.minute)
    return checkBounds(fire_at, now, { kind: 'one_shot', fire_at })
  }

  // `next <weekday> at <time>` / `next <weekday> <HH:mm>` / `next <weekday>`
  const nextMatch = /^next\s+([a-z]+)(?:\s+(?:at\s+)?(.+))?$/.exec(phrase)
  if (nextMatch !== null) {
    const weekday = matchWeekday(nextMatch[1]!)
    if (weekday === -1) return null
    const timeStr = (nextMatch[2] ?? '').trim()
    const time = timeStr.length === 0
      ? { hour: DEFAULT_HOUR_LOCAL, minute: DEFAULT_MINUTE_LOCAL }
      : parseTimeWord(timeStr)
    if (time === null) return null
    const fire_at = nextWeekdayOccurrence(now, weekday, time.hour, time.minute, /*strictlyNext*/ true)
    return checkBounds(fire_at, now, { kind: 'one_shot', fire_at })
  }

  // `on <month> <day> at <time>` / `on <month> <day>`
  const onMatch = /^on\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(?:at\s+)?(.+))?$/.exec(phrase)
  if (onMatch !== null) {
    const monthIdx = MONTHS.indexOf(onMatch[1]!.toLowerCase())
    if (monthIdx === -1) return null
    const day = Number(onMatch[2])
    if (!Number.isFinite(day) || day < 1 || day > 31) return null
    const timeStr = (onMatch[3] ?? '').trim()
    const time = timeStr.length === 0
      ? { hour: DEFAULT_HOUR_LOCAL, minute: DEFAULT_MINUTE_LOCAL }
      : parseTimeWord(timeStr)
    if (time === null) return null
    const fire_at = atSpecificDate(now, monthIdx, day, time.hour, time.minute)
    return checkBounds(fire_at, now, { kind: 'one_shot', fire_at })
  }

  // `at <time> today` / `at <time>`
  const atTodayMatch = /^at\s+(.+?)(?:\s+today)?$/.exec(phrase)
  if (atTodayMatch !== null) {
    const time = parseTimeWord(atTodayMatch[1]!.trim())
    if (time !== null) {
      const fire_at = atLocalOffset(now, 0, time.hour, time.minute)
      return checkBounds(fire_at, now, { kind: 'one_shot', fire_at })
    }
  }

  // bare `<HH:mm>` time — same as "at HH:mm today"
  const bareTime = parseTimeWord(phrase)
  if (bareTime !== null) {
    const fire_at = atLocalOffset(now, 0, bareTime.hour, bareTime.minute)
    return checkBounds(fire_at, now, { kind: 'one_shot', fire_at })
  }

  return null
}

function checkBounds(
  fire_at: number,
  now: Date,
  spec: ResolvedTimeSpec,
): TimeSpecResult {
  const nowSec = Math.floor(now.getTime() / 1000)
  if (fire_at < nowSec - MAX_PAST_DRIFT_SECONDS) {
    return { kind: 'past_time' }
  }
  if (fire_at > nowSec + MAX_FUTURE_DRIFT_SECONDS) {
    return { kind: 'future_too_far' }
  }
  return { kind: 'ok', spec }
}

function firstWhitespace(s: string): number {
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charCodeAt(i)
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) return i
  }
  return -1
}

function matchWeekday(token: string): number {
  const t = token.toLowerCase()
  let idx = WEEKDAYS.indexOf(t)
  if (idx !== -1) return idx
  idx = WEEKDAY_SHORT.indexOf(t)
  return idx
}

function parseHM(
  hourRaw: string,
  minuteRaw: string | undefined,
  ampm: string | undefined,
): { hour: number; minute: number } | null {
  let h = Number(hourRaw)
  if (!Number.isFinite(h) || h < 0 || h > 23) return null
  let m = 0
  if (minuteRaw !== undefined) {
    m = Number(minuteRaw)
    if (!Number.isFinite(m) || m < 0 || m > 59) return null
  }
  if (ampm !== undefined) {
    const ap = ampm.toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    else if (ap === 'am' && h === 12) h = 0
  }
  if (h > 23) return null
  return { hour: h, minute: m }
}

function parseTimeWord(raw: string): { hour: number; minute: number } | null {
  const phrase = raw.trim().toLowerCase()
  if (phrase === 'noon') return { hour: 12, minute: 0 }
  if (phrase === 'midnight') return { hour: 0, minute: 0 }
  // `<H>am` / `<H>pm` / `<H>:<M>am` / `<H>:<M>` / `<H>:<M>pm`
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(phrase)
  if (m === null) return null
  return parseHM(m[1]!, m[2], m[3])
}

function atLocalOffset(now: Date, dayOffset: number, hour: number, minute: number): number {
  const d = new Date(now)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, minute, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

function atSpecificDate(
  now: Date,
  monthIdx: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const d = new Date(now)
  // If the requested month is before the current month, roll over to
  // next year so "on Jan 5 at 9am" in December resolves to next Jan.
  let year = d.getFullYear()
  const curMonth = d.getMonth()
  if (
    monthIdx < curMonth ||
    (monthIdx === curMonth && day < d.getDate())
  ) {
    year += 1
  }
  const result = new Date(year, monthIdx, day, hour, minute, 0, 0)
  return Math.floor(result.getTime() / 1000)
}

function nextWeekdayOccurrence(
  now: Date,
  weekday: number,
  hour: number,
  minute: number,
  strictlyNext: boolean = false,
): number {
  const d = new Date(now)
  d.setHours(hour, minute, 0, 0)
  const curDow = d.getDay()
  let delta = (weekday - curDow + 7) % 7
  // `next monday` after a Monday means the FOLLOWING Monday. Same for
  // weekly recurrence — first occurrence should land in the future.
  if (delta === 0) {
    if (strictlyNext || d.getTime() <= now.getTime()) {
      delta = 7
    }
  } else if (d.getTime() <= now.getTime() && delta === 0) {
    delta = 7
  }
  d.setDate(d.getDate() + delta)
  return Math.floor(d.getTime() / 1000)
}

function nextMonthlyOccurrence(
  now: Date,
  day: number,
  hour: number,
  minute: number,
): number {
  const d = new Date(now)
  d.setDate(day)
  d.setHours(hour, minute, 0, 0)
  if (d.getTime() <= now.getTime()) {
    d.setMonth(d.getMonth() + 1)
  }
  return Math.floor(d.getTime() / 1000)
}

// ─── Dispatcher ─────────────────────────────────────────────────────────

export interface RemindExecuteContext {
  backend: RemindersBackend
  project_id?: string
  user_id: string
  smartWrap: SmartWrapComposer
  /** Inject for test determinism. Default: `() => new Date()`. */
  now?: () => Date
}

/**
 * Convenience: parse + execute in one call. The chat-bridge uses this
 * shape because every inbound message lookup needs both the parse and
 * the dispatch in lockstep.
 */
export async function parseAndExecuteRemindCommand(
  raw: string,
  ctx: RemindExecuteContext,
): Promise<RemindCommandResponse | null> {
  const now = (ctx.now ?? (() => new Date()))()
  const cmd = parseRemindCommand(raw, { now })
  if (cmd.kind === 'unrecognized' && cmd.reason === 'not_a_remind_command') {
    return null
  }
  return executeRemindCommand(cmd, ctx)
}

export async function executeRemindCommand(
  cmd: RemindCommand,
  ctx: RemindExecuteContext,
): Promise<RemindCommandResponse> {
  if (cmd.kind === 'help') return helpResponse()
  if (cmd.kind === 'unrecognized') {
    if (cmd.reason === 'not_a_remind_command') {
      // Fall-through path — caller (`parseAndExecuteRemindCommand`)
      // already returned null upstream so we'd only reach this branch
      // if `executeRemindCommand` was called directly with this shape.
      return {
        text: 'Not a /remind command.',
        error: { code: 'malformed', message: 'not_a_remind_command' },
      }
    }
    return unrecognizedResponse(cmd.reason)
  }
  if (cmd.kind === 'capture') return executeCapture(cmd, ctx)
  if (cmd.kind === 'list') return executeList(cmd, ctx)
  if (cmd.kind === 'cancel') return executeCancel(cmd, ctx)
  if (cmd.kind === 'snooze') return executeSnooze(cmd, ctx)
  if (cmd.kind === 'update') return executeUpdate(cmd, ctx)
  // exhaustive — kept for the TS compiler to catch a future kind addition.
  return { text: 'Unrecognized /remind command.', error: { code: 'malformed', message: 'unknown command' } }
}

async function executeCapture(
  cmd: Extract<RemindCommand, { kind: 'capture' }>,
  ctx: RemindExecuteContext,
): Promise<RemindCommandResponse> {
  if (cmd.when.kind === 'recurring') {
    // S1 — `create` is one-shot only on the Core's surface. Recurring
    // writes from the chat surface are EXPLICITLY out of scope per
    // brief § 9. Surface honestly.
    return {
      text:
        'Recurring reminders from the chat command are not supported in v1. ' +
        'Use `/remind pattern nag-until-done <body> <when>` for a daily-cadence ' +
        'nudge that the fire-time agent loops via the self-delete contract.',
      error: {
        code: 'unsupported_recurrence',
        message:
          'recurring chat captures land in a follow-up sprint; use nag-until-done pattern instead',
      },
    }
  }
  let mode: import('./smart-wrap.ts').ReminderMode
  if (cmd.mode === 'pattern' && cmd.pattern !== undefined) {
    mode = cmd.pattern_slots !== undefined
      ? { kind: 'pattern', name: cmd.pattern, slots: cmd.pattern_slots }
      : { kind: 'pattern', name: cmd.pattern }
  } else if (cmd.mode === 'smart_wrap') {
    mode = { kind: 'smart_wrap' }
  } else {
    mode = { kind: 'literal' }
  }
  let composed
  try {
    composed = ctx.smartWrap.compose({ body: cmd.body, mode })
  } catch (err) {
    if (err instanceof UnknownReminderPatternError) {
      return {
        text: `Unknown reminder pattern '${cmd.pattern ?? '<missing>'}'. Known patterns: ${REMINDER_PATTERN_NAMES.join(', ')}.`,
        error: { code: 'unknown_pattern', message: err.message },
      }
    }
    throw err
  }
  const create_input: Parameters<RemindersBackend['create']>[0] = {
    message: composed.message,
    fire_at: cmd.when.fire_at,
  }
  if (ctx.project_id !== undefined) create_input.project_id = ctx.project_id
  let row
  try {
    row = await ctx.backend.create(create_input)
  } catch (err) {
    return errorFromBackend(err)
  }
  const badge =
    composed.audit.mode === 'smart_wrap'
      ? ' (smart-wrap)'
      : composed.audit.mode === 'pattern'
      ? ` (pattern: ${composed.audit.pattern_name})`
      : ''
  return {
    text: `Reminder set${badge} — fires at ${formatFireAt(row.fire_at)}.`,
    data: {
      reminder_id: row.id,
      fire_at: row.fire_at,
      mode: composed.audit.mode,
      ...(composed.audit.pattern_name !== undefined ? { pattern: composed.audit.pattern_name } : {}),
    },
  }
}

async function executeList(
  cmd: Extract<RemindCommand, { kind: 'list' }>,
  ctx: RemindExecuteContext,
): Promise<RemindCommandResponse> {
  const input: RemindersListInput = {}
  const projectId = cmd.project_id ?? ctx.project_id
  if (projectId !== undefined) input.project_id = projectId
  let rows: ReminderRow[]
  try {
    rows = await ctx.backend.list(input)
  } catch (err) {
    return errorFromBackend(err)
  }
  if (rows.length === 0) {
    return { text: 'No pending reminders.', data: { results: [] } }
  }
  const lines = rows.slice(0, 20).map((r) => `• [${r.id.slice(0, 8)}] ${truncate(r.message, 80)} — ${formatFireAt(r.fire_at)}`)
  return {
    text: lines.join('\n'),
    data: { results: rows.slice(0, 20) },
  }
}

async function executeCancel(
  cmd: Extract<RemindCommand, { kind: 'cancel' }>,
  ctx: RemindExecuteContext,
): Promise<RemindCommandResponse> {
  // If the target looks like a UUID (or a short id ≥8 chars without
  // whitespace), pass directly to cancel; else fuzzy-match against the
  // owner's pending list.
  const target = cmd.target.trim()
  if (looksLikeId(target)) {
    let result
    try {
      result = await ctx.backend.cancel({ id: target })
    } catch (err) {
      return errorFromBackend(err)
    }
    if (!result.ok) {
      return {
        text: `Reminder \`${target.slice(0, 8)}\` not found or already cancelled.`,
        error: { code: 'unknown_reminder', message: 'no pending reminder for id' },
      }
    }
    return { text: `Reminder \`${target.slice(0, 8)}\` cancelled.`, data: { id: target } }
  }
  // Fuzzy match — list and pick by case-insensitive substring.
  const input: RemindersListInput = {}
  if (ctx.project_id !== undefined) input.project_id = ctx.project_id
  let rows: ReminderRow[]
  try {
    rows = await ctx.backend.list(input)
  } catch (err) {
    return errorFromBackend(err)
  }
  const matches = rows.filter((r) => r.message.toLowerCase().includes(target.toLowerCase()))
  if (matches.length === 0) {
    return {
      text: `No pending reminders matching "${target}".`,
      error: { code: 'unknown_reminder', message: 'no match' },
    }
  }
  if (matches.length > 1) {
    const numbered = matches
      .slice(0, 10)
      .map((m, i) => `${i + 1}. [${m.id.slice(0, 8)}] ${truncate(m.message, 70)}`)
      .join('\n')
    return {
      text: `Multiple reminders matched "${target}". Reply with the id:\n${numbered}`,
      data: { matches: matches.slice(0, 10) },
      error: { code: 'multiple_matches', message: `${matches.length} matches; specify the id` },
    }
  }
  const only = matches[0]!
  let result
  try {
    result = await ctx.backend.cancel({ id: only.id })
  } catch (err) {
    return errorFromBackend(err)
  }
  if (!result.ok) {
    return {
      text: `Reminder \`${only.id.slice(0, 8)}\` already cancelled.`,
      error: { code: 'unknown_reminder', message: 'no longer pending' },
    }
  }
  return { text: `Reminder \`${only.id.slice(0, 8)}\` cancelled.`, data: { id: only.id } }
}

async function executeSnooze(
  cmd: Extract<RemindCommand, { kind: 'snooze' }>,
  ctx: RemindExecuteContext,
): Promise<RemindCommandResponse> {
  if (cmd.new_when.kind === 'recurring') {
    return {
      text: 'Snooze accepts a one-shot time-spec only — recurring cadence changes need cancel + re-create.',
      error: { code: 'unsupported_recurrence', message: 'snooze does not change recurrence' },
    }
  }
  let result
  try {
    result = await ctx.backend.snooze({
      id: cmd.id,
      new_fire_at: cmd.new_when.fire_at,
    })
  } catch (err) {
    return errorFromBackend(err)
  }
  return {
    text: `Reminder snoozed → ${formatFireAt(result.fire_at)} (new id: \`${result.id.slice(0, 8)}\`).`,
    data: {
      new_id: result.id,
      cancelled_id: result.cancelled_id,
      fire_at: result.fire_at,
    },
  }
}

async function executeUpdate(
  cmd: Extract<RemindCommand, { kind: 'update' }>,
  ctx: RemindExecuteContext,
): Promise<RemindCommandResponse> {
  let result: RemindersUpdateResult
  try {
    result = await ctx.backend.update({ id: cmd.id, message: cmd.new_body })
  } catch (err) {
    return errorFromBackend(err)
  }
  return {
    text: `Reminder updated (new id: \`${result.id.slice(0, 8)}\`, replaced \`${result.replaced_id.slice(0, 8)}\`).`,
    data: {
      new_id: result.id,
      replaced_id: result.replaced_id,
      message: result.message,
    },
  }
}

function helpResponse(): RemindCommandResponse {
  const lines = [
    '`/remind` — schedule a nudge.',
    '',
    '• `/remind <body> <when>` — literal reminder (Shape A)',
    '• `/remind smart <body> <when>` — context-aware at fire time (Shape B)',
    '• `/remind pattern <name> <body> <when>` — pattern template (Shape C)',
    `  patterns: ${REMINDER_PATTERN_NAMES.join(' / ')}`,
    '• `/remind list [project_id]` — list pending',
    '• `/remind cancel <id_or_match>` — cancel pending',
    '• `/remind snooze <id> <when>` — push fire-time later',
    '• `/remind update <id> <new-body>` — rewrite the message',
    '',
    'Time-spec: `in 30m`, `tomorrow at 9am`, `next friday 10:00`, `at 3pm today`, `on April 15 at 2pm`, `every week on Monday at 10am`, `every month on the 1st at noon`, `once in a while`. The engine has weekly/monthly/occasional only — `daily` is rejected (use the `nag-until-done` pattern instead).',
  ]
  return { text: lines.join('\n'), data: { help: true } }
}

function unrecognizedResponse(
  reason: Exclude<Extract<RemindCommand, { kind: 'unrecognized' }>['reason'], 'not_a_remind_command'>,
): RemindCommandResponse {
  if (reason === 'malformed_time_spec') {
    return {
      text:
        'Could not parse the time. Try `in 30m`, `tomorrow at 9am`, `next friday 10:00`, or `at 3pm today`. Say `/remind` for the full grammar.',
      error: { code: 'malformed', message: 'malformed_time_spec' },
    }
  }
  if (reason === 'unsupported_recurrence') {
    return {
      text:
        'The engine supports weekly / monthly / occasional only — `daily` and `every weekday` are not allowed. Use `/remind pattern nag-until-done <body> <when>` for daily cadence (the fire-time agent loops via the self-delete contract).',
      error: { code: 'unsupported_recurrence', message: 'engine cadence enum' },
    }
  }
  if (reason === 'unknown_pattern') {
    return {
      text: `Unknown pattern. Known: ${REMINDER_PATTERN_NAMES.join(', ')}.`,
      error: { code: 'unknown_pattern', message: 'pattern not in registry' },
    }
  }
  if (reason === 'past_time') {
    return {
      text: 'That time is in the past. Reminders need a future fire time.',
      error: { code: 'past_time', message: 'fire_at in the past' },
    }
  }
  if (reason === 'future_too_far') {
    return {
      text: 'That time is more than five years out. Schedule something closer.',
      error: { code: 'future_too_far', message: 'fire_at > now + 5y' },
    }
  }
  return {
    text: 'Missing reminder body or id. Say `/remind` for the full grammar.',
    error: { code: 'malformed', message: 'empty_body' },
  }
}

function errorFromBackend(err: unknown): RemindCommandResponse {
  const message = err instanceof Error ? err.message : String(err)
  // Surface "not found" + capability_denied as their typed code; fall
  // through to backend_error for everything else.
  if (/not found/i.test(message)) {
    return {
      text: 'Reminder not found.',
      error: { code: 'unknown_reminder', message },
    }
  }
  if (/not pending/i.test(message) || /no longer pending/i.test(message)) {
    return {
      text: 'Reminder is no longer pending (already fired or cancelled).',
      error: { code: 'unknown_reminder', message },
    }
  }
  if (/capability/i.test(message)) {
    return {
      text: 'Permission denied.',
      error: { code: 'capability_denied', message },
    }
  }
  return {
    text: `Backend error: ${message}`,
    error: { code: 'backend_error', message },
  }
}

function looksLikeId(s: string): boolean {
  if (/\s/.test(s)) return false
  // UUIDs are 36 chars with dashes; short ids (≥8 chars) are accepted too.
  if (s.length >= 8 && /^[A-Za-z0-9_.-]+$/.test(s)) return true
  return false
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n - 1)}…`
}

function formatFireAt(fire_at_seconds: number): string {
  const d = new Date(fire_at_seconds * 1000)
  // Render in ISO-ish form so the chat surface gets a stable
  // timezone-aware string; the client can re-render locally if needed.
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
