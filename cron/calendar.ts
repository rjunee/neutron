/**
 * @neutronai/cron — calendar / wall-clock schedule evaluator.
 *
 * NET-NEW (T2, 2026-06-07). The in-process scheduler (`scheduler.ts`) is the
 * Open base and must be COMPLETE — Open-on-Mac (and any non-systemd platform)
 * gets full scheduling, both `interval_ms` AND calendar/wall-clock. Managed
 * keeps systemd `.timer` units (`timer-emit.ts`) as a VPS optimization over
 * the SAME `CronJobDef` / `CronSchedule`. This module parses the OnCalendar
 * subset Neutron actually uses and computes next/previous fire instants from
 * an EXPLICIT epoch argument — there is no `Date.now()` in here, so the whole
 * evaluator is deterministic and unit-testable (per the repo's time-test rule:
 * inject the clock, never read wall-clock inside logic).
 *
 * Supported OnCalendar subset (case-insensitive):
 *   - Named shortcuts: `minutely`, `hourly`, `daily`, `weekly`, `monthly`.
 *   - Daily at a time:      `*-*-* HH:MM[:SS]`   (also bare `HH:MM[:SS]`)
 *   - Weekly on weekdays:   `DOW *-*-* HH:MM[:SS]` (also `DOW HH:MM[:SS]`)
 *   - Monthly on a day:     `*-*-DD HH:MM[:SS]`
 *   where DOW is a comma-list and/or `..`-range of Mon Tue Wed Thu Fri Sat Sun
 *   (e.g. `Mon`, `Mon,Fri`, `Mon..Fri`), and `*` wildcards are honored in the
 *   hour and minute fields (so `hourly` == `*-*-* *:00:00`).
 *
 * EXPLICITLY UNSUPPORTED (throws): year / month-of-year restrictions
 * (`2026-*-*`, `*-06-*`, `yearly`), second wildcards (`*:*:*`), step values
 * (`*:0/15`), combined weekday + day-of-month (`Mon *-*-31` — systemd ANDs
 * them, putting the next fire potentially years out), and timezone suffixes
 * inside the expression. These are out of the documented subset; production
 * Managed deployments that need the full grammar route through systemd via
 * `timer-emit.ts`, which passes the expression verbatim.
 *
 * Timezone: all wall-clock math is done in an explicit IANA `timeZone`
 * argument (the scheduler defaults it to the host zone). DST is handled
 * — the wall-clock→epoch conversion resolves the correct UTC offset at the
 * target instant, so "daily 09:00" lands at 09:00 local on both sides of a
 * spring-forward / fall-back boundary.
 *
 * DST gap policy: a wall-clock time that does NOT exist on the spring-forward
 * day (e.g. 02:30 in `America/New_York`, where the clock jumps 02:00→03:00) is
 * SKIPPED for that day — next/previous-fire round-trip-check each candidate and
 * reject a resolved instant whose zoned parts don't match the requested time,
 * so a gap-only schedule fires on the next valid day rather than an hour early.
 * (Our documented schedules — 09:00 daily etc. — never fall in the gap; this is
 * correctness armor.)
 */

/**
 * A parsed calendar schedule. Field semantics:
 *   - `daysOfWeek`: matching weekdays (0=Sun .. 6=Sat), sorted/deduped, or
 *     `null` for "any day of week".
 *   - `dayOfMonth`: 1..31, or `null` for "any day of month". When BOTH this
 *     and `daysOfWeek` are set they are ANDed (systemd semantics).
 *   - `hour`: 0..23, or `null` for "every hour" (wildcard).
 *   - `minute`: 0..59, or `null` for "every minute" (wildcard).
 *   - `second`: 0..59 (no wildcard — fixed point in the minute).
 */
export interface CalendarSpec {
  daysOfWeek: number[] | null
  dayOfMonth: number | null
  hour: number | null
  minute: number | null
  second: number
}

/** Exact weekday tokens (abbreviation OR full name), case-insensitive. */
const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
}

/** Named-shortcut expansions to canonical `[DOW ]DATE TIME` form. */
const NAMED_SHORTCUTS: Record<string, string> = {
  minutely: '*-*-* *:*:00',
  hourly: '*-*-* *:00:00',
  daily: '*-*-* 00:00:00',
  weekly: 'Mon *-*-* 00:00:00',
  monthly: '*-*-01 00:00:00',
}

/** systemd shortcuts we deliberately do NOT support in-process (need MoY). */
const UNSUPPORTED_SHORTCUTS = new Set([
  'yearly',
  'annually',
  'quarterly',
  'semiannually',
])

function fail(expr: string, why: string): never {
  throw new Error(
    `unsupported OnCalendar expression '${expr}': ${why} ` +
      `(in-process scheduler supports the documented daily/weekly/monthly subset; ` +
      `full grammar runs via systemd timers on Managed)`,
  )
}

/**
 * Parse a systemd OnCalendar expression into a `CalendarSpec`. Throws with a
 * descriptive message on anything outside the supported subset so a
 * misconfigured job fails loudly at bind time rather than silently never
 * firing.
 */
export function parseOnCalendar(expression: string): CalendarSpec {
  const raw = expression.trim()
  if (raw.length === 0) fail(expression, 'empty expression')

  const lower = raw.toLowerCase()
  if (UNSUPPORTED_SHORTCUTS.has(lower)) {
    fail(expression, `'${lower}' requires year/month-of-year matching`)
  }
  const canonical = NAMED_SHORTCUTS[lower] ?? raw

  const tokens = canonical.split(/\s+/).filter((t) => t.length > 0)

  let dowToken: string | null = null
  let dateToken: string | null = null
  let timeToken: string | null = null

  if (tokens.length === 3) {
    dowToken = tokens[0]!
    dateToken = tokens[1]!
    timeToken = tokens[2]!
  } else if (tokens.length === 2) {
    // Either [DOW, TIME] or [DATE, TIME]. A date token contains '-'.
    const t0 = tokens[0]!
    const t1 = tokens[1]!
    if (t0.includes('-')) {
      dateToken = t0
      timeToken = t1
    } else {
      dowToken = t0
      timeToken = t1
    }
  } else if (tokens.length === 1) {
    // Bare time (`HH:MM[:SS]`) → daily at that time.
    const t0 = tokens[0]!
    if (t0.includes(':')) {
      timeToken = t0
    } else {
      fail(expression, 'single token is neither a known shortcut nor a HH:MM time')
    }
  } else {
    fail(expression, `expected 1-3 whitespace-separated fields, got ${tokens.length}`)
  }

  if (timeToken === null || !timeToken.includes(':')) {
    fail(expression, 'missing HH:MM[:SS] time field')
  }

  const daysOfWeek = dowToken === null ? null : parseDow(expression, dowToken)
  const dayOfMonth = dateToken === null ? null : parseDate(expression, dateToken)
  const { hour, minute, second } = parseTime(expression, timeToken)

  // Combined weekday + day-of-month (systemd ANDs them, e.g. `Mon *-*-31`) is
  // OUTSIDE the documented daily/weekly/monthly subset and can put the next
  // occurrence years out (a 31st that's a Monday). Reject it — Managed's
  // systemd path handles the full grammar; the in-process subset stays bounded.
  if (daysOfWeek !== null && dayOfMonth !== null) {
    fail(expression, 'combined weekday + day-of-month is unsupported (use weekly DOW OR monthly DD, not both)')
  }

  return { daysOfWeek, dayOfMonth, hour, minute, second }
}

function parseDow(expression: string, token: string): number[] {
  const out = new Set<number>()
  for (const part of token.split(',')) {
    const piece = part.trim()
    // Fail closed on empty list elements (`Mon,,Fri`, `Mon,`) rather than
    // silently scheduling the remaining days on an unintended cadence.
    if (piece.length === 0) fail(expression, `empty weekday list element in '${token}'`)
    if (piece.includes('..')) {
      const seg = piece.split('..')
      if (seg.length !== 2 || seg[0]!.trim() === '' || seg[1]!.trim() === '') {
        fail(expression, `malformed weekday range '${piece}' (expected DOW..DOW)`)
      }
      const start = weekdayNum(expression, seg[0]!)
      const end = weekdayNum(expression, seg[1]!)
      // Inclusive range, wrapping through the week (e.g. Fri..Mon).
      let d = start
      for (let guard = 0; guard < 7; guard++) {
        out.add(d)
        if (d === end) break
        d = (d + 1) % 7
      }
    } else {
      out.add(weekdayNum(expression, piece))
    }
  }
  if (out.size === 0) fail(expression, 'empty day-of-week field')
  return [...out].sort((a, b) => a - b)
}

function weekdayNum(expression: string, name: string): number {
  // Exact match only (no prefix truncation) so `Mon-Fri` / `MondayX` /
  // `Mond` fail closed instead of silently parsing as `Mon`.
  const key = name.trim().toLowerCase()
  const n = WEEKDAY_NAMES[key]
  if (n === undefined) fail(expression, `unrecognized weekday '${name}'`)
  // systemd treats Sunday as both 0 and 7; we normalize to 0.
  return n
}

function parseDate(expression: string, token: string): number | null {
  const parts = token.split('-')
  if (parts.length !== 3) fail(expression, `date field '${token}' is not Y-M-D`)
  const y = parts[0]!
  const m = parts[1]!
  const d = parts[2]!
  if (y !== '*') fail(expression, 'year restrictions are unsupported (use systemd timers)')
  if (m !== '*') fail(expression, 'month-of-year restrictions are unsupported (use systemd timers)')
  if (d === '*') return null
  const dom = parseIntStrict(expression, d, 'day-of-month')
  if (dom < 1 || dom > 31) fail(expression, `day-of-month ${dom} out of range 1-31`)
  return dom
}

function parseTime(
  expression: string,
  token: string,
): { hour: number | null; minute: number | null; second: number } {
  const parts = token.split(':')
  if (parts.length < 2 || parts.length > 3) {
    fail(expression, `time field '${token}' is not HH:MM[:SS]`)
  }
  const hour = parseField(expression, parts[0]!, 'hour', 0, 23)
  const minute = parseField(expression, parts[1]!, 'minute', 0, 59)
  let second = 0
  if (parts.length === 3) {
    const s = parseField(expression, parts[2]!, 'second', 0, 59)
    if (s === null) fail(expression, 'second wildcards are unsupported')
    second = s
  }
  return { hour, minute, second }
}

function parseField(
  expression: string,
  raw: string,
  label: string,
  min: number,
  max: number,
): number | null {
  if (raw === '*') return null
  const n = parseIntStrict(expression, raw, label)
  if (n < min || n > max) fail(expression, `${label} ${n} out of range ${min}-${max}`)
  return n
}

function parseIntStrict(expression: string, raw: string, label: string): number {
  if (!/^\d{1,2}$/.test(raw.trim())) {
    fail(expression, `${label} '${raw}' is not a 1-2 digit number (step/list values unsupported)`)
  }
  return Number.parseInt(raw, 10)
}

// ── Wall-clock ⇄ epoch (IANA timezone aware, DST-correct) ────────────────────

/** The host's IANA timezone, used as the scheduler default. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

interface ZonedParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number
  minute: number
  second: number
}

const PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = PART_FORMATTERS.get(timeZone)
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    PART_FORMATTERS.set(timeZone, f)
  }
  return f
}

/** Decompose an epoch-ms instant into wall-clock parts in `timeZone`. */
export function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(epochMs)
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type)
    return p ? Number.parseInt(p.value, 10) : 0
  }
  // 'en-US' h23 renders midnight as hour '24'; normalize to 0.
  let hour = get('hour')
  if (hour === 24) hour = 0
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  }
}

/** UTC-offset (ms) of `timeZone` at the given instant. */
function offsetMsAt(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone)
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  // asUTC is the wall-clock reinterpreted as if it were UTC; the difference
  // from the real instant (truncated to seconds) is the zone offset.
  return asUTC - Math.floor(epochMs / 1000) * 1000
}

/**
 * Convert a wall-clock date+time in `timeZone` to an epoch-ms instant.
 * DST-correct via a two-pass offset resolution (the first guess can land in
 * the wrong offset across a transition; the refine pass corrects it).
 */
export function wallClockToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  const asUTC = Date.UTC(year, month - 1, day, hour, minute, second)
  const off1 = offsetMsAt(asUTC, timeZone)
  let epoch = asUTC - off1
  const off2 = offsetMsAt(epoch, timeZone)
  if (off2 !== off1) {
    epoch = asUTC - off2
  }
  return epoch
}

// ── Next / previous fire computation ─────────────────────────────────────────

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

function dayMatches(spec: CalendarSpec, year: number, month: number, day: number): boolean {
  if (spec.daysOfWeek !== null) {
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
    if (!spec.daysOfWeek.includes(dow)) return false
  }
  if (spec.dayOfMonth !== null && day !== spec.dayOfMonth) return false
  return true
}

function hoursOf(spec: CalendarSpec): number[] {
  if (spec.hour !== null) return [spec.hour]
  return Array.from({ length: 24 }, (_, i) => i)
}

function minutesOf(spec: CalendarSpec): number[] {
  if (spec.minute !== null) return [spec.minute]
  return Array.from({ length: 60 }, (_, i) => i)
}

/** Safety bound — no supported spec has a gap wider than ~12 months. */
const MAX_DAY_SCAN = 400

/** ~13h probe — wider than any real DST shift, narrower than half a day. */
const DST_PROBE_MS = 13 * 60 * 60 * 1000

/**
 * Every distinct epoch-ms instant that renders the given wall-clock time in
 * `timeZone`, in ascending order:
 *   - normal time  → exactly one instant;
 *   - fall-back fold (the repeated hour, e.g. 01:30 twice on the US fall-back
 *     day) → TWO instants, so `minutely`/`hourly` fire in BOTH passes of the
 *     hour instead of skipping the second;
 *   - spring-forward gap (e.g. 02:30 on the US spring-forward day) → ZERO,
 *     so a gap-only time is skipped to the next valid day.
 *
 * Both candidates are produced by resolving the wall time against the UTC
 * offset on EITHER side of a possible transition (probed ±13h) and keeping
 * only those that round-trip back to the requested wall time.
 */
function wallClockOccurrences(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number[] {
  const asUTC = Date.UTC(year, month - 1, day, hour, minute, second)
  const offBefore = offsetMsAt(asUTC - DST_PROBE_MS, timeZone)
  const offAfter = offsetMsAt(asUTC + DST_PROBE_MS, timeZone)
  const out = new Set<number>()
  for (const off of offBefore === offAfter ? [offBefore] : [offBefore, offAfter]) {
    const epoch = asUTC - off
    const p = zonedParts(epoch, timeZone)
    if (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute &&
      p.second === second
    ) {
      out.add(epoch)
    }
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * All matching instants on a single calendar date, ascending. Collected then
 * sorted (rather than returned in (hour, minute) order) because a fall-back
 * fold interleaves real-time order with wall-clock order — the second 01:00
 * occurs AFTER 01:59-first-pass in real time but BEFORE it in (h, m) order.
 */
function dayOccurrences(
  spec: CalendarSpec,
  year: number,
  month: number,
  day: number,
  hours: number[],
  minutes: number[],
  timeZone: string,
): number[] {
  const epochs: number[] = []
  for (const h of hours) {
    for (const m of minutes) {
      for (const e of wallClockOccurrences(year, month, day, h, m, spec.second, timeZone)) {
        epochs.push(e)
      }
    }
  }
  epochs.sort((a, b) => a - b)
  return epochs
}

/**
 * The smallest epoch-ms instant STRICTLY GREATER THAN `afterMs` that matches
 * `spec` in `timeZone`. Throws only if no occurrence exists within
 * `MAX_DAY_SCAN` days (impossible for the supported subset — a guard against
 * a future grammar bug producing a never-matching spec).
 */
export function nextFireAfter(spec: CalendarSpec, afterMs: number, timeZone: string): number {
  const start = zonedParts(afterMs, timeZone)
  const hours = hoursOf(spec)
  const minutes = minutesOf(spec)
  for (let i = 0; i <= MAX_DAY_SCAN; i++) {
    const { year, month, day } = addCalendarDays(start.year, start.month, start.day, i)
    if (!dayMatches(spec, year, month, day)) continue
    for (const epoch of dayOccurrences(spec, year, month, day, hours, minutes, timeZone)) {
      if (epoch > afterMs) return epoch
    }
  }
  throw new Error('nextFireAfter: no matching occurrence within scan window')
}

/**
 * The largest epoch-ms instant LESS THAN OR EQUAL TO `atMs` that matches
 * `spec` in `timeZone`, or `null` if none within `MAX_DAY_SCAN` days back.
 * Used by the scheduler's missed-fire catch-up (systemd `Persistent=true`
 * spirit): on (re)arm, if the most-recent scheduled instant is newer than the
 * last recorded run, fire once to catch up.
 */
export function previousFireAtOrBefore(
  spec: CalendarSpec,
  atMs: number,
  timeZone: string,
): number | null {
  const start = zonedParts(atMs, timeZone)
  const hours = hoursOf(spec)
  const minutes = minutesOf(spec)
  for (let i = 0; i <= MAX_DAY_SCAN; i++) {
    const { year, month, day } = addCalendarDays(start.year, start.month, start.day, -i)
    if (!dayMatches(spec, year, month, day)) continue
    const epochs = dayOccurrences(spec, year, month, day, hours, minutes, timeZone)
    for (let j = epochs.length - 1; j >= 0; j--) {
      if (epochs[j]! <= atMs) return epochs[j]!
    }
  }
  return null
}
