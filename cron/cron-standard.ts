/**
 * @neutronai/cron — standard 5-field (Vixie/crontab) cron evaluator.
 *
 * NET-NEW (reminder cron-cadence parity, 2026-07-01). The sibling
 * `calendar.ts` parses the systemd `OnCalendar` subset the in-process cron
 * SCHEDULER uses; this module parses the classic crontab grammar the reminder
 * store persists so a coarse-label reminder store can gain FAITHFUL cron
 * cadence (daily-at-9, every-6-hours, annual on Feb 7, quarterly, …).
 *
 * The two grammars are deliberately kept separate — OnCalendar and crontab
 * differ in field order, wildcard spelling, and (critically) day-of-month /
 * day-of-week combination semantics (systemd ANDs them; classic cron ORs
 * them). Sharing a parser would silently mis-fire one of the two.
 *
 * Supported crontab grammar (5 space-separated fields: `min hour dom mon dow`):
 *   - `*`                      — every value in the field's range
 *   - `n`                      — a single value
 *   - `a-b`                    — an inclusive range
 *   - `a,b,c`                  — a comma list (each item may itself be a range
 *                                or a step)
 *   - `* / s` (no spaces)      — every s-th value across the full range
 *   - `a-b/s`                  — every s-th value within a range
 *   - month names (JAN..DEC)   — case-insensitive, in the month field
 *   - weekday names (SUN..SAT) — case-insensitive, in the day-of-week field
 *   Day-of-week accepts 0..7 where BOTH 0 and 7 mean Sunday.
 *
 * Day-of-month / day-of-week COMBINATION (Vixie semantics): when BOTH fields
 * are restricted (neither is `*`), a day fires if it matches EITHER field.
 * When only one is restricted, that one governs. This mirrors classic
 * crontab, and is the behaviour the reminder cadence must reproduce.
 *
 * All wall-clock math runs against an explicit IANA `timeZone` and is
 * DST-correct — the resolver reuses `wallClockToEpoch` + `zonedParts` from
 * `calendar.ts`, and a wall-clock time that does not exist on a
 * spring-forward day is skipped to the next valid instant (no fire an hour
 * early). There is no `Date.now()` in here: the caller passes the reference
 * instant, so the whole evaluator is deterministic and unit-testable.
 */

import { hostTimeZone, wallClockToEpoch, zonedParts } from './calendar.ts'

/**
 * A parsed crontab schedule. Each field is expanded to the explicit, sorted,
 * de-duplicated set of values it matches. `domStar` / `dowStar` record whether
 * the source field was a bare `*`, which drives the Vixie OR/AND combination
 * rule at match time.
 */
export interface CronSpec {
  /** Matching minutes (0..59), ascending. */
  minutes: number[]
  /** Matching hours (0..23), ascending. */
  hours: number[]
  /** Matching days-of-month (1..31), ascending. */
  daysOfMonth: number[]
  /** Matching months (1..12), ascending. */
  months: number[]
  /** Matching weekdays (0=Sun..6=Sat), ascending. Sunday is always 0. */
  daysOfWeek: number[]
  /** True when the day-of-month field was `*`. */
  domStar: boolean
  /** True when the day-of-week field was `*`. */
  dowStar: boolean
}

interface FieldRange {
  min: number
  max: number
  /** Optional name→number aliases (case-insensitive), e.g. JAN=1, SUN=0. */
  names?: Record<string, number>
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

const MINUTE_FIELD: FieldRange = { min: 0, max: 59 }
const HOUR_FIELD: FieldRange = { min: 0, max: 23 }
const DOM_FIELD: FieldRange = { min: 1, max: 31 }
const MONTH_FIELD: FieldRange = { min: 1, max: 12, names: MONTH_NAMES }
// Day-of-week is parsed over 0..7 (7 = Sunday) then folded to 0..6.
const DOW_FIELD: FieldRange = { min: 0, max: 7, names: WEEKDAY_NAMES }

function failCron(expr: string, why: string): never {
  throw new Error(`invalid cron expression '${expr}': ${why}`)
}

/** Resolve a single token (number or name) to an integer within the field. */
function resolveAtom(expr: string, range: FieldRange, raw: string): number {
  const token = raw.trim()
  if (range.names !== undefined) {
    const named = range.names[token.toLowerCase()]
    if (named !== undefined) return named
  }
  if (!/^\d{1,2}$/.test(token)) {
    failCron(expr, `'${raw}' is not a valid value for this field`)
  }
  return Number.parseInt(token, 10)
}

/**
 * Expand ONE field into the sorted, de-duplicated set of values it matches.
 * Handles `*`, single values, ranges, comma lists, and step syntax.
 */
function expandField(expr: string, range: FieldRange, field: string): number[] {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const item = part.trim()
    if (item.length === 0) failCron(expr, 'empty list element')

    // Split an optional trailing `/step`.
    let base = item
    let step = 1
    const slash = item.indexOf('/')
    if (slash >= 0) {
      base = item.slice(0, slash)
      const stepRaw = item.slice(slash + 1)
      if (!/^\d{1,2}$/.test(stepRaw.trim())) failCron(expr, `invalid step '${stepRaw}'`)
      step = Number.parseInt(stepRaw, 10)
      if (step <= 0) failCron(expr, 'step must be a positive integer')
    }

    let lo: number
    let hi: number
    if (base === '*') {
      lo = range.min
      hi = range.max
    } else if (base.includes('-')) {
      const [a, b] = base.split('-')
      if (a === undefined || b === undefined || a.length === 0 || b.length === 0) {
        failCron(expr, `malformed range '${base}'`)
      }
      lo = resolveAtom(expr, range, a)
      hi = resolveAtom(expr, range, b)
    } else {
      lo = resolveAtom(expr, range, base)
      // A bare `n/step` steps from n up to the field max (crontab semantics).
      hi = slash >= 0 ? range.max : lo
    }

    if (lo < range.min || hi > range.max || lo > hi) {
      failCron(expr, `value out of range in '${item}' (allowed ${range.min}..${range.max})`)
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * Parse a standard 5-field cron expression into a fully-expanded `CronSpec`.
 * Throws a descriptive error on anything outside the supported grammar so a
 * misconfigured schedule fails loudly at write time rather than silently never
 * firing.
 */
export function parseCron(expression: string): CronSpec {
  if (typeof expression !== 'string') failCron(String(expression), 'not a string')
  const fields = expression.trim().split(/\s+/).filter((f) => f.length > 0)
  if (fields.length !== 5) {
    failCron(expression, `expected 5 fields (min hour dom mon dow), got ${fields.length}`)
  }
  const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string]

  const minutes = expandField(expression, MINUTE_FIELD, minF)
  const hours = expandField(expression, HOUR_FIELD, hourF)
  const daysOfMonth = expandField(expression, DOM_FIELD, domF)
  const months = expandField(expression, MONTH_FIELD, monF)
  // Fold 7→0 (both mean Sunday), then re-dedupe/sort.
  const dowRaw = expandField(expression, DOW_FIELD, dowF)
  const daysOfWeek = [...new Set(dowRaw.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b)

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domStar: domF.trim() === '*',
    dowStar: dowF.trim() === '*',
  }
}

/**
 * Validate a standard 5-field cron expression. Returns true iff `parseCron`
 * accepts it (5 fields, every field in range). Never throws.
 */
export function isValidCron(expression: unknown): boolean {
  if (typeof expression !== 'string') return false
  try {
    parseCron(expression)
    return true
  } catch {
    return false
  }
}

/** Calendar-date arithmetic via UTC midnight (DST-immune for date stepping). */
function addCalendarDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day) + delta * 86_400_000)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/**
 * Does a calendar date match the spec's day fields? Vixie semantics: when both
 * day-of-month and day-of-week are restricted, match on EITHER; otherwise the
 * single restricted field (or "any day" when both are `*`) governs.
 */
function dayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.includes(month)) return false
  const domMatch = spec.daysOfMonth.includes(day)
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const dowMatch = spec.daysOfWeek.includes(dow)
  if (!spec.domStar && !spec.dowStar) return domMatch || dowMatch
  if (!spec.domStar) return domMatch
  if (!spec.dowStar) return dowMatch
  return true
}

/**
 * Resolve a wall-clock (date + time) in `timeZone` to an epoch-ms instant, or
 * `null` when that wall time does not exist (a spring-forward gap) — the caller
 * skips gap times to the next valid instant so a "09:00 daily" never fires an
 * hour early on the transition day. Fall-back folds resolve to the first of the
 * two instants (a reminder fires once, never twice for the repeated hour).
 */
function resolveWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const epoch = wallClockToEpoch(year, month, day, hour, minute, 0, timeZone)
  const p = zonedParts(epoch, timeZone)
  if (
    p.year === year &&
    p.month === month &&
    p.day === day &&
    p.hour === hour &&
    p.minute === minute
  ) {
    return epoch
  }
  return null
}

/** Upper bound on the forward day scan (~4 years covers Feb-29 / annual specs). */
const MAX_DAY_SCAN = 1500

/**
 * The smallest epoch-ms instant STRICTLY GREATER THAN `afterMs` that matches
 * `spec` in `timeZone`. Throws only when no occurrence exists within
 * `MAX_DAY_SCAN` days — an impossible date such as Feb 30 (`0 0 30 2 *`).
 */
export function nextCronFire(spec: CronSpec, afterMs: number, timeZone: string): number {
  const start = zonedParts(afterMs, timeZone)
  for (let i = 0; i <= MAX_DAY_SCAN; i++) {
    const { year, month, day } = addCalendarDays(start.year, start.month, start.day, i)
    if (!dayMatches(spec, year, month, day)) continue
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const epoch = resolveWallClock(year, month, day, hour, minute, timeZone)
        if (epoch !== null && epoch > afterMs) return epoch
      }
    }
  }
  throw new Error(
    `nextCronFire: no matching occurrence within ${MAX_DAY_SCAN} days ` +
      `(impossible date, e.g. Feb 30?)`,
  )
}

/**
 * Convenience wrapper: parse `expression` and compute its next fire after
 * `afterMs`, defaulting the timezone to the host zone (matching the reminder
 * tick loop's wall-clock intent — "9am" means 9am local). Throws on an invalid
 * expression or an impossible date.
 */
export function nextCronFireFromExpression(
  expression: string,
  afterMs: number,
  timeZone: string = hostTimeZone(),
): number {
  return nextCronFire(parseCron(expression), afterMs, timeZone)
}
