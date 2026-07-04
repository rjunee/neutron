/**
 * @neutronai/calendar-core — CalendarClient interface + reference adapters.
 *
 * The Tier 1 Calendar Core programs against a narrow `CalendarClient`
 * (list / create / update / cancel / get). Production: a thin Google
 * Calendar v3 REST wrapper backed by an OAuth bearer token resolved
 * lazily from the per-Core SecretsAccessor + a refresh-token exchange
 * (handled at the runtime composition layer in a follow-up sprint —
 * for v1 the access token persisted at install time is what we use).
 *
 * Tests never hit the real Google API. The Core ships an in-memory
 * `buildInMemoryCalendarClient()` that matches the same contract, so
 * the `__tests__/tools.test.ts` suite exercises the full tool wiring
 * end-to-end without network.
 *
 * Why this interface lives in the Core (not under a shared
 * `calendar/` substrate yet):
 * - There is no canonical `calendar/` workspace package today
 *   (substrate-side calendar persistence would be a M3+ decision —
 *   Tier 2 Calendar-Private variant is the path that would justify
 *   one). Until then the Core owns its own client surface; if/when a
 *   substrate-side calendar lands, the Core retains a thin adapter
 *   the same way the Tasks Core will once P6 ships its canonical
 *   task DB.
 *
 * Ordering: list returns CHRONOLOGICAL ASCENDING from range_start
 * (forward-looking; the user wants the soonest upcoming event first).
 * Distinct from the Notes / Tasks ordering convention (newest-first
 * created_at) — meetings are forward-looking, not journals.
 */

import { randomUUID } from 'node:crypto'

import { PROJECT_ID_EXTENDED_PROPERTY } from './manifest.ts'

/**
 * Status of a Calendar event. Mirrors Google Calendar v3's `status`
 * enum minus `tentative` (the v1 surface treats tentative as
 * confirmed); a follow-up sprint can widen if a use-case needs it.
 */
export type CalendarEventStatus = 'confirmed' | 'cancelled'

/**
 * Single event row returned by every `CalendarClient` read path.
 * Mirrors the tool output schema 1:1 — optional fields not set on a
 * row are simply absent.
 */
export interface CalendarEventRow {
  id: string
  /** Google calendar id this event lives on (e.g. `primary`). */
  calendar_id: string
  title: string
  /** ISO-8601 datetime — event start. */
  start: string
  /** ISO-8601 datetime — event end. */
  end: string
  description?: string
  attendees?: string[]
  status: CalendarEventStatus
  html_link?: string
  /**
   * Echo of `extendedProperties.private.neutron_project_id` from the
   * Google payload (or the literal value stamped at create-time by the
   * in-memory client). Lets the per-project filter SQL + the launcher
   * tile render without round-tripping back to Google for the
   * extended-properties bag.
   */
  project_id?: string
}

export interface CalendarListInput {
  /** ISO-8601 lower bound for event start (inclusive). */
  range_start: string
  /** ISO-8601 upper bound for event start (exclusive). */
  range_end: string
  calendar_id?: string
  limit?: number
  /**
   * Filter to events tagged with
   * `extendedProperties.private.neutron_project_id = <project_id>`.
   * Omitted = owner-wide (every event matches). The Google REST
   * adapter forwards as `privateExtendedProperty=<key>=<value>` on
   * `events.list`; the in-memory client mirrors the same filter.
   */
  project_id?: string
}

export interface CalendarCreateInput {
  title: string
  start: string
  end: string
  attendees?: string[]
  calendar_id?: string
  description?: string
  /**
   * Stamp `extendedProperties.private.neutron_project_id` on the new
   * event so later `list({project_id})` reads filter by it.
   */
  project_id?: string
}

/**
 * Per-attendee busy interval the freebusy endpoint returns. Mirrors
 * Google Calendar v3's `freebusy.query` response shape (`{start, end}`
 * per row) with the `dateTime` flattening already applied — both
 * fields are ISO-8601 strings.
 */
export interface BusyInterval {
  start: string
  end: string
}

export interface FreeBusyInput {
  /** Email addresses, in the order results should be returned. */
  attendees: readonly string[]
  /** ISO-8601 lower bound. */
  window_start: string
  /** ISO-8601 upper bound. */
  window_end: string
}

export interface FindTimeInput {
  attendees: readonly string[]
  duration_minutes: number
  window_start: string
  window_end: string
  /** Default 15. */
  granularity_minutes?: number
  /** Default 5. */
  max_slots?: number
  /**
   * 24-hour local window for proposed slots. Default `[9, 18]`
   * (09:00-18:00 local). Inclusive of start hour, exclusive of end
   * hour. The slot derivation rejects candidates whose START falls
   * outside the window.
   */
  preferred_hours?: readonly [number, number]
}

export interface TimeSlot {
  start: string
  end: string
  /** Echoed for caller convenience. Same order as input.attendees. */
  attendees: readonly string[]
}

export interface InviteInput {
  event_id: string
  calendar_id?: string
  add_emails: readonly string[]
  /**
   * Google semantics: `'all'` re-notifies every existing + new
   * attendee; `'externalOnly'` notifies only newly-added external
   * attendees; `'none'` updates the calendar without email. Defaults
   * to `'all'` because the chat-command intent is "send the invite".
   */
  send_updates?: 'all' | 'externalOnly' | 'none'
}

export interface CalendarUpdateFields {
  title?: string
  start?: string
  end?: string
  attendees?: string[]
  description?: string
}

export interface CalendarUpdateInput {
  event_id: string
  calendar_id?: string
  fields: CalendarUpdateFields
}

export interface CalendarCancelInput {
  event_id: string
  calendar_id?: string
}

export interface CalendarGetInput {
  event_id: string
  calendar_id?: string
}

/**
 * Backend contract every CalendarClient implementation satisfies. The
 * shape mirrors the five MCP tool inputs the manifest declares, with
 * `get` as the lookup helper used by `calendar_brief` (so the brief
 * tool's contract doesn't widen the client surface).
 */
export interface CalendarClient {
  list(input: CalendarListInput): Promise<CalendarEventRow[]>
  create(input: CalendarCreateInput): Promise<CalendarEventRow>
  /** Throws `EventNotFoundError` on unknown id. */
  update(input: CalendarUpdateInput): Promise<CalendarEventRow>
  /** Throws `EventNotFoundError` on unknown id. */
  cancel(input: CalendarCancelInput): Promise<void>
  /** Throws `EventNotFoundError` on unknown id. */
  get(input: CalendarGetInput): Promise<CalendarEventRow>
  /**
   * Per-attendee busy intervals. Returns parallel arrays in the same
   * order as `input.attendees`. Google path: `POST /freeBusy`. The
   * in-memory client computes busy intervals from its own row set
   * (cancelled rows ignored; attendee match is exact-string email
   * compare).
   */
  freebusy(input: FreeBusyInput): Promise<BusyInterval[][]>
  /**
   * Find up to `max_slots` time windows where every attendee is free.
   * Pure derivation over `freebusy(...)` + the slot granularity +
   * the preferred-hours window. Algorithm lives in `src/free-busy.ts`
   * so both backends call the same code path.
   */
  findTime(input: FindTimeInput): Promise<TimeSlot[]>
  /**
   * Add attendees to an existing event + send invitations. Throws
   * `EventNotFoundError` on unknown id. The wrapper deduplicates
   * against the existing attendee list (case-insensitive email
   * compare).
   */
  invite(input: InviteInput): Promise<CalendarEventRow>
}

/**
 * Thrown when an `update` / `cancel` / `get` references an event id
 * that doesn't exist. The Core's tool layer surfaces this as an
 * `error` outcome via the CapabilityGuard wrapper — the audit log
 * records the failure and the caller sees the message.
 */
export class EventNotFoundError extends Error {
  readonly code = 'event_not_found' as const
  readonly event_id: string

  constructor(event_id: string) {
    super(`event not found: ${event_id}`)
    this.name = 'EventNotFoundError'
    this.event_id = event_id
  }
}

/**
 * Default page size when callers omit `limit`. The Google Calendar v3
 * default is 250 / max 2500, but the launcher / brief surfaces don't
 * need anywhere near that many — keeping the default tight reduces
 * round-trip payload size on the production wrapper.
 *
 * Exported so the Google-backed adapter can pass the same default into
 * the `maxResults` query parameter; otherwise an omitted `limit` would
 * return Google's 250-row default and the two backends would disagree.
 */
export const DEFAULT_LIST_LIMIT = 50

/**
 * Convert an ISO-8601 instant to milliseconds since epoch. Used for
 * window filtering and ordering so `2026-06-01T09:00:00-07:00` and
 * `2026-06-01T16:00:00Z` compare as the SAME instant (Date.parse
 * normalizes the offset) — lexicographic string compare gets that
 * wrong, which would drop in-window events whenever the calendar's
 * timezone isn't UTC. Returns `Number.NaN` for malformed input so
 * callers can decide whether to drop or include the row; the in-memory
 * client conservatively drops NaN (treats as out-of-window) so a buggy
 * event row doesn't sneak past the gate.
 */
function instantMs(s: string): number {
  return Date.parse(s)
}

/**
 * Is this string a Google "all-day" date — `YYYY-MM-DD` with no
 * timezone? Google sets `start.date` instead of `start.dateTime` for
 * all-day events; the raw string is calendar-LOCAL, not an instant.
 * Comparing it as a UTC instant gives the wrong answer on non-UTC
 * calendars (a June 1 all-day in `America/Los_Angeles` would parse to
 * the prior local evening). The Core treats date-only timestamps as
 * date-range entities: an all-day event is "in window" iff its date
 * falls inside the `range_start`'s date and the `range_end`'s date
 * (inclusive lower, exclusive upper, lexicographic on the YYYY-MM-DD
 * prefix — valid because date strings sort correctly).
 */
function isAllDayDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/**
 * Compare an event's start against the query window. Both all-day and
 * datetimed events are compared by INSTANT (`Date.parse`-based), so
 * the query window's time component is always honoured:
 *
 * - datetimed events parse directly (offset-aware).
 * - all-day events (Google sets `start.date` rather than
 *   `start.dateTime`; the row's `start` is `YYYY-MM-DD`) are coerced
 *   to `T00:00:00Z` for the compare. This means an all-day on a
 *   non-UTC calendar that "really" starts at, say, `2026-06-01T07:00Z`
 *   (Pacific local midnight) compares as `2026-06-01T00:00:00Z`
 *   instead. Imperfect at the timezone-boundary edge — known v1
 *   limitation documented in README + AGENTS.md ("Calendar-timezone-
 *   aware filtering is out of scope for v1; revisit when a customer
 *   surfaces a non-UTC calendar use-case in onboarding"). The Core
 *   has no way to learn the calendar's timezone short of a separate
 *   `calendars.get` round-trip, which is deferred. ALTERNATIVE
 *   (rejected for v1): date-prefix lex compare — it ignored the time
 *   portion of the query window so a sub-day query like
 *   `[6/1T12:00Z, 6/2T12:00Z]` wrongly included a `6/1` all-day, the
 *   issue Codex flagged on the prior pass.
 *
 * NaN guard drops malformed rows rather than implicitly including
 * them. NaN on a range bound means "no lower/upper limit on that
 * side".
 */
function isStartInWindow(
  start: string,
  range_start: string,
  range_end: string,
): boolean {
  const ms = isAllDayDate(start) ? Date.parse(`${start}T00:00:00Z`) : instantMs(start)
  if (Number.isNaN(ms)) return false
  const startMs = instantMs(range_start)
  const endMs = instantMs(range_end)
  if (!Number.isNaN(startMs) && ms < startMs) return false
  if (!Number.isNaN(endMs) && ms >= endMs) return false
  return true
}

/**
 * Sort key for chronological-ascending ordering. All-day events
 * (`YYYY-MM-DD`) sort by their date treated as the start of that
 * local day; datetimed events sort by instant. We coerce all-day
 * dates to `T00:00:00Z` for the sort so they land at the start of
 * the day relative to UTC-encoded events. Imperfect at the
 * timezone-boundary edge (a `2026-06-01` all-day on a `-07:00`
 * calendar sorts beside `2026-06-01T00:00:00Z` instead of
 * `2026-06-01T07:00:00Z`), but consistent and stable — and good
 * enough for the launcher's "next on the calendar" surface.
 */
function sortInstantMs(start: string): number {
  if (isAllDayDate(start)) return Date.parse(`${start}T00:00:00Z`)
  return instantMs(start)
}

/** Default calendar id when callers omit one — same convention Google
 *  uses for the authenticated user's main calendar. */
export const DEFAULT_CALENDAR_ID = 'primary' as const

interface InMemoryCalendarClientOptions {
  /** Wall-clock override for tests that need deterministic ids. */
  nextId?: () => string
}

/**
 * Reference in-memory `CalendarClient`. Used by every Core test in
 * `cores/free/calendar/__tests__/` so the suite never reaches Google.
 * The production wrapper is `buildGoogleCalendarClient` below.
 *
 * Ordering: `list` returns CHRONOLOGICAL ASCENDING from `range_start`
 * — the soonest upcoming event lands at position 0. This matches the
 * brief's behavioural-spec gate ("forward-looking, NOT oldest-first
 * like a journal").
 */
export function buildInMemoryCalendarClient(
  options: InMemoryCalendarClientOptions = {},
): CalendarClient {
  const nextId = options.nextId ?? ((): string => randomUUID())
  // Composite key — Google's API addresses events as
  // `(calendar_id, event_id)`, so two different calendars can legally
  // hold the same event id. Keying solely on event id would collapse
  // them and silently lose data. Mirror Google's addressing.
  const rows = new Map<string, CalendarEventRow>()
  const key = (calendar_id: string, event_id: string): string =>
    `${calendar_id}\x00${event_id}`

  return {
    async list(input: CalendarListInput): Promise<CalendarEventRow[]> {
      const limit = input.limit ?? DEFAULT_LIST_LIMIT
      const calendar_id = input.calendar_id ?? DEFAULT_CALENDAR_ID
      const out: CalendarEventRow[] = []
      for (const row of rows.values()) {
        if (row.calendar_id !== calendar_id) continue
        if (row.status === 'cancelled') continue
        if (!isStartInWindow(row.start, input.range_start, input.range_end)) {
          continue
        }
        // Project filter — only enforced when supplied. Omitted →
        // owner-wide. Mirrors the Google REST adapter's
        // `privateExtendedProperty=<key>=<value>` clause.
        if (input.project_id !== undefined) {
          if (row.project_id !== input.project_id) continue
        }
        out.push({ ...row })
      }
      out.sort((a, b) => sortInstantMs(a.start) - sortInstantMs(b.start))
      return out.slice(0, limit)
    },

    async create(input: CalendarCreateInput): Promise<CalendarEventRow> {
      const id = nextId()
      const calendar_id = input.calendar_id ?? DEFAULT_CALENDAR_ID
      const row: CalendarEventRow = {
        id,
        calendar_id,
        title: input.title,
        start: input.start,
        end: input.end,
        status: 'confirmed',
      }
      if (input.description !== undefined) row.description = input.description
      if (input.attendees !== undefined) row.attendees = [...input.attendees]
      if (input.project_id !== undefined) row.project_id = input.project_id
      rows.set(key(calendar_id, id), row)
      return { ...row }
    },

    async update(input: CalendarUpdateInput): Promise<CalendarEventRow> {
      const expected_cal = input.calendar_id ?? DEFAULT_CALENDAR_ID
      const row = rows.get(key(expected_cal, input.event_id))
      if (row === undefined) throw new EventNotFoundError(input.event_id)
      const next: CalendarEventRow = { ...row }
      if (input.fields.title !== undefined) next.title = input.fields.title
      if (input.fields.start !== undefined) next.start = input.fields.start
      if (input.fields.end !== undefined) next.end = input.fields.end
      if (input.fields.description !== undefined) {
        next.description = input.fields.description
      }
      if (input.fields.attendees !== undefined) {
        next.attendees = [...input.fields.attendees]
      }
      rows.set(key(expected_cal, input.event_id), next)
      return { ...next }
    },

    async cancel(input: CalendarCancelInput): Promise<void> {
      const expected_cal = input.calendar_id ?? DEFAULT_CALENDAR_ID
      const k = key(expected_cal, input.event_id)
      if (!rows.has(k)) throw new EventNotFoundError(input.event_id)
      rows.delete(k)
    },

    async get(input: CalendarGetInput): Promise<CalendarEventRow> {
      const expected_cal = input.calendar_id ?? DEFAULT_CALENDAR_ID
      const row = rows.get(key(expected_cal, input.event_id))
      if (row === undefined) throw new EventNotFoundError(input.event_id)
      return { ...row }
    },

    async freebusy(input: FreeBusyInput): Promise<BusyInterval[][]> {
      // Per-attendee parallel arrays in the input order. The in-memory
      // client never knows which calendar a remote attendee's events
      // live on — emails are matched against the per-row `attendees`
      // list. The user's own busy intervals are also included when
      // their email appears in the input list AND the row has them
      // marked as an attendee. v1 simplification: an event with no
      // attendees is treated as the calendar OWNER'S busy time when
      // the email is `primary` (chat-command + invite flows almost
      // always invite the user's primary explicitly).
      const window_start_ms = Date.parse(input.window_start)
      const window_end_ms = Date.parse(input.window_end)
      const out: BusyInterval[][] = []
      for (const email of input.attendees) {
        const intervals: BusyInterval[] = []
        for (const row of rows.values()) {
          if (row.status === 'cancelled') continue
          const start_ms = Date.parse(row.start)
          const end_ms = Date.parse(row.end)
          if (Number.isNaN(start_ms) || Number.isNaN(end_ms)) continue
          if (end_ms <= window_start_ms || start_ms >= window_end_ms) continue
          const matches = row.attendees?.includes(email) ?? false
          if (!matches) continue
          intervals.push({ start: row.start, end: row.end })
        }
        out.push(intervals)
      }
      return out
    },

    async findTime(input: FindTimeInput): Promise<TimeSlot[]> {
      // Delegate to the shared algorithm so the in-memory + Google
      // backends behave identically. The free-busy module is a
      // top-of-file import so this stays a pure deps chain.
      const per_attendee_busy = await this.freebusy({
        attendees: input.attendees,
        window_start: input.window_start,
        window_end: input.window_end,
      })
      const { findFreeSlots } = await import('./free-busy.ts')
      return findFreeSlots({ ...input, per_attendee_busy })
    },

    async invite(input: InviteInput): Promise<CalendarEventRow> {
      const expected_cal = input.calendar_id ?? DEFAULT_CALENDAR_ID
      const row = rows.get(key(expected_cal, input.event_id))
      if (row === undefined) throw new EventNotFoundError(input.event_id)
      const existing = new Set(
        (row.attendees ?? []).map((e) => e.toLowerCase()),
      )
      const merged: string[] = [...(row.attendees ?? [])]
      for (const email of input.add_emails) {
        const lower = email.toLowerCase()
        if (existing.has(lower)) continue
        merged.push(email)
        existing.add(lower)
      }
      const next: CalendarEventRow = { ...row, attendees: merged }
      rows.set(key(expected_cal, input.event_id), next)
      return { ...next }
    },
  }
}

/**
 * Production Google Calendar v3 REST client.
 *
 * Talks to `https://www.googleapis.com/calendar/v3/...` via global
 * `fetch`. No SDK dependency by design — the v3 surface is small and
 * a 200-line REST wrapper avoids pulling `googleapis` and its
 * ~5MB transitive tree into the Tier 1 Core. The wrapper accepts an
 * `access_token` accessor closure so the runtime composer can refresh
 * tokens out-of-band without the client caching stale credentials.
 *
 * v1 limitations (deliberate — flagged in README + AGENTS.md):
 * - No automatic refresh-token exchange here. The runtime composer
 *   resolves a live access token via the per-Core SecretsAccessor
 *   before each invocation; the OAuth flow itself (consent screen +
 *   token exchange) is handled outside the Core (the gateway's
 *   existing Google-side OAuth helpers, or, for early dev, an
 *   operator-pasted access token).
 * - No recurring-event expansion. The wrapper passes
 *   `singleEvents=true` so Google's server expands recurrences; we
 *   never re-implement RRULE expansion client-side.
 * - No batch endpoint. v1 sends one HTTP request per mutation.
 */
/**
 * The narrow subset of the platform `fetch` surface this wrapper
 * actually uses. We don't bind `typeof fetch` directly because Bun's
 * type widens `fetch` with extras (`preconnect`, BunFetchRequestInit)
 * that test stubs don't have any reason to provide; a one-call alias
 * keeps the tests typed without a cast.
 */
export type FetchLike = (
  input: URL | Request | string,
  init?: RequestInit,
) => Promise<Response>

export interface GoogleCalendarClientOptions {
  /** Lazy access-token resolver. Called before each request so the
   *  runtime can refresh out-of-band. Returns `null` to signal a
   *  permanent OAuth failure — the wrapper throws
   *  `OAuthMissingError` in that case. */
  accessToken: () => Promise<string | null>
  /** Override for tests / local dev — defaults to the public Google
   *  Calendar v3 base URL. */
  baseUrl?: string
  /** Override fetch — tests inject a stub. Defaults to globalThis.fetch. */
  fetchImpl?: FetchLike
}

/**
 * Thrown when the access-token accessor returns null. The runtime
 * composer can interpret this as "re-prompt the user for OAuth
 * consent" — surfaced separately from a generic API error so the
 * caller doesn't conflate "transient API failure" with "user revoked
 * access".
 */
export class OAuthMissingError extends Error {
  readonly code = 'oauth_missing' as const
  constructor() {
    super('Google Calendar OAuth token is unavailable — re-prompt for consent')
    this.name = 'OAuthMissingError'
  }
}

export class GoogleCalendarApiError extends Error {
  readonly code = 'google_api_error' as const
  readonly http_status: number
  constructor(http_status: number, message: string) {
    super(`Google Calendar API ${http_status}: ${message}`)
    this.name = 'GoogleCalendarApiError'
    this.http_status = http_status
  }
}

interface GoogleEventPayload {
  id?: string
  status?: string
  summary?: string
  description?: string
  htmlLink?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: Array<{ email?: string }>
  extendedProperties?: {
    private?: Record<string, string>
    shared?: Record<string, string>
  }
}

function startStringFromPayload(p: GoogleEventPayload): string {
  return p.start?.dateTime ?? p.start?.date ?? ''
}

function endStringFromPayload(p: GoogleEventPayload): string {
  return p.end?.dateTime ?? p.end?.date ?? ''
}

function attendeesFromPayload(p: GoogleEventPayload): string[] | undefined {
  if (p.attendees === undefined) return undefined
  return p.attendees
    .map((a) => a.email)
    .filter((e): e is string => typeof e === 'string')
}

function rowFromPayload(
  calendar_id: string,
  p: GoogleEventPayload,
): CalendarEventRow {
  const id = p.id ?? ''
  const row: CalendarEventRow = {
    id,
    calendar_id,
    title: p.summary ?? '',
    start: startStringFromPayload(p),
    end: endStringFromPayload(p),
    status: p.status === 'cancelled' ? 'cancelled' : 'confirmed',
  }
  if (p.description !== undefined) row.description = p.description
  if (p.htmlLink !== undefined) row.html_link = p.htmlLink
  const att = attendeesFromPayload(p)
  if (att !== undefined) row.attendees = att
  const project_id = p.extendedProperties?.private?.[PROJECT_ID_EXTENDED_PROPERTY]
  if (typeof project_id === 'string' && project_id.length > 0) {
    row.project_id = project_id
  }
  return row
}

function payloadFromCreate(input: CalendarCreateInput): Record<string, unknown> {
  const out: Record<string, unknown> = {
    summary: input.title,
    start: { dateTime: input.start },
    end: { dateTime: input.end },
  }
  if (input.description !== undefined) out.description = input.description
  if (input.attendees !== undefined) {
    out.attendees = input.attendees.map((email) => ({ email }))
  }
  if (input.project_id !== undefined) {
    out.extendedProperties = {
      private: { [PROJECT_ID_EXTENDED_PROPERTY]: input.project_id },
    }
  }
  return out
}

function payloadFromUpdate(fields: CalendarUpdateFields): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (fields.title !== undefined) out.summary = fields.title
  if (fields.start !== undefined) out.start = { dateTime: fields.start }
  if (fields.end !== undefined) out.end = { dateTime: fields.end }
  if (fields.description !== undefined) out.description = fields.description
  if (fields.attendees !== undefined) {
    out.attendees = fields.attendees.map((email) => ({ email }))
  }
  return out
}

export function buildGoogleCalendarClient(
  options: GoogleCalendarClientOptions,
): CalendarClient {
  const baseUrl = options.baseUrl ?? 'https://www.googleapis.com/calendar/v3'
  const f: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init))

  async function authHeaders(): Promise<Record<string, string>> {
    const token = await options.accessToken()
    if (token === null) throw new OAuthMissingError()
    return { Authorization: `Bearer ${token}` }
  }

  async function call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    options: { event_id_for_not_found?: string } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = await authHeaders()
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const init: RequestInit = {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }
    const res = await f(`${baseUrl}${path}`, init)
    if (res.status === 204) return null
    if (!res.ok) {
      // Map 404 (no longer exists) and 410 (deleted from server, but the
      // tombstone has aged out) to `EventNotFoundError` whenever the
      // caller is operating on a single event id — that's the
      // cross-backend contract the in-memory client and the Core's
      // tool surface document. Keeping the typed-error shape consistent
      // across backends is what lets `calendar_cancel({event_id:'gone'})`
      // surface the same shape whether the instance is running against
      // Google or the in-memory fake. Audit + caller code branch on
      // `instanceof EventNotFoundError`; without this mapping the
      // tooling would have to know which backend it talked to.
      if (
        (res.status === 404 || res.status === 410) &&
        options.event_id_for_not_found !== undefined
      ) {
        throw new EventNotFoundError(options.event_id_for_not_found)
      }
      const text = await res.text().catch(() => '')
      throw new GoogleCalendarApiError(res.status, text)
    }
    return res.json()
  }

  function encodeCalendar(id: string): string {
    return encodeURIComponent(id)
  }

  return {
    async list(input: CalendarListInput): Promise<CalendarEventRow[]> {
      const calendar_id = input.calendar_id ?? DEFAULT_CALENDAR_ID
      const limit = input.limit ?? DEFAULT_LIST_LIMIT
      const out: CalendarEventRow[] = []
      let nextPageToken: string | undefined
      // Page through Google's `events.list` until we have `limit`
      // matching rows OR there's no next page. Necessary because
      // Google's `timeMin` is END-time based — a long-running event
      // before the window (e.g. an all-day prior-day event) can
      // saturate the first page and crowd out valid in-window rows
      // that live on later pages. Capped at GOOGLE_LIST_PAGE_CAP to
      // avoid an unbounded fetch loop in pathological calendars.
      const GOOGLE_LIST_PAGE_CAP = 20
      for (let page = 0; page < GOOGLE_LIST_PAGE_CAP; page++) {
        const params = new URLSearchParams({
          timeMin: input.range_start,
          timeMax: input.range_end,
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: String(limit),
        })
        if (input.project_id !== undefined) {
          // Google's events.list accepts repeated
          // `privateExtendedProperty=<key>=<value>` params; one filter
          // is sufficient here since we only key on
          // `neutron_project_id`.
          params.append(
            'privateExtendedProperty',
            `${PROJECT_ID_EXTENDED_PROPERTY}=${input.project_id}`,
          )
        }
        if (nextPageToken !== undefined) params.set('pageToken', nextPageToken)
        const path = `/calendars/${encodeCalendar(calendar_id)}/events?${params.toString()}`
        const raw = (await call('GET', path)) as {
          items?: GoogleEventPayload[]
          nextPageToken?: string
        }
        const items = raw.items ?? []
        // Google's `timeMin` filters on event END time, not START.
        // Post-filter on event START using `isStartInWindow`, which
        // splits the compare into two paths:
        //   - datetimed events → instant compare (handles non-UTC
        //     offsets correctly)
        //   - all-day events (Google sets `start.date` rather than
        //     `start.dateTime`; row.start ends up as `YYYY-MM-DD`) →
        //     lex compare against the date prefix of the window
        //     bounds. Date strings sort correctly, and this avoids
        //     parsing a calendar-LOCAL date as a UTC instant (which
        //     would mis-shift an all-day on a non-UTC calendar).
        for (const p of items) {
          if (out.length >= limit) break
          const r = rowFromPayload(calendar_id, p)
          if (!isStartInWindow(r.start, input.range_start, input.range_end)) {
            continue
          }
          out.push(r)
        }
        if (out.length >= limit) break
        if (typeof raw.nextPageToken !== 'string' || raw.nextPageToken.length === 0) {
          break
        }
        nextPageToken = raw.nextPageToken
      }
      return out
    },

    async create(input: CalendarCreateInput): Promise<CalendarEventRow> {
      const calendar_id = input.calendar_id ?? DEFAULT_CALENDAR_ID
      const path = `/calendars/${encodeCalendar(calendar_id)}/events`
      const raw = (await call('POST', path, payloadFromCreate(input))) as GoogleEventPayload
      return rowFromPayload(calendar_id, raw)
    },

    async update(input: CalendarUpdateInput): Promise<CalendarEventRow> {
      const calendar_id = input.calendar_id ?? DEFAULT_CALENDAR_ID
      const path = `/calendars/${encodeCalendar(calendar_id)}/events/${encodeURIComponent(input.event_id)}`
      const raw = (await call('PATCH', path, payloadFromUpdate(input.fields), {
        event_id_for_not_found: input.event_id,
      })) as GoogleEventPayload
      return rowFromPayload(calendar_id, raw)
    },

    async cancel(input: CalendarCancelInput): Promise<void> {
      const calendar_id = input.calendar_id ?? DEFAULT_CALENDAR_ID
      const path = `/calendars/${encodeCalendar(calendar_id)}/events/${encodeURIComponent(input.event_id)}`
      await call('DELETE', path, undefined, {
        event_id_for_not_found: input.event_id,
      })
    },

    async get(input: CalendarGetInput): Promise<CalendarEventRow> {
      const calendar_id = input.calendar_id ?? DEFAULT_CALENDAR_ID
      const path = `/calendars/${encodeCalendar(calendar_id)}/events/${encodeURIComponent(input.event_id)}`
      const raw = (await call('GET', path, undefined, {
        event_id_for_not_found: input.event_id,
      })) as GoogleEventPayload
      return rowFromPayload(calendar_id, raw)
    },

    async freebusy(input: FreeBusyInput): Promise<BusyInterval[][]> {
      // Google Calendar v3 `freebusy.query`. POST body shape:
      //   { timeMin, timeMax, items: [{id: <email-or-cal-id>}, ...] }
      // Response shape:
      //   { calendars: { <id>: { busy: [{start, end}, ...] } } }
      // We flatten response.calendars[email].busy into per-attendee
      // parallel arrays. Missing entries surface as empty arrays.
      const body = {
        timeMin: input.window_start,
        timeMax: input.window_end,
        items: input.attendees.map((email) => ({ id: email })),
      }
      const raw = (await call('POST', '/freeBusy', body)) as {
        calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }> }>
      }
      const calendars = raw.calendars ?? {}
      return input.attendees.map((email) => {
        const entry = calendars[email]
        const busy = entry?.busy ?? []
        const out: BusyInterval[] = []
        for (const row of busy) {
          if (typeof row.start === 'string' && typeof row.end === 'string') {
            out.push({ start: row.start, end: row.end })
          }
        }
        return out
      })
    },

    async findTime(input: FindTimeInput): Promise<TimeSlot[]> {
      const per_attendee_busy = await this.freebusy({
        attendees: input.attendees,
        window_start: input.window_start,
        window_end: input.window_end,
      })
      const { findFreeSlots } = await import('./free-busy.ts')
      return findFreeSlots({ ...input, per_attendee_busy })
    },

    async invite(input: InviteInput): Promise<CalendarEventRow> {
      const calendar_id = input.calendar_id ?? DEFAULT_CALENDAR_ID
      // Read-then-patch: Google has no add-attendees endpoint, so we
      // fetch the existing row, merge attendees, and PATCH the full
      // attendee list back with `sendUpdates=<mode>` honoured. The
      // merge is case-insensitive on email so duplicate emails don't
      // collapse silently if the caller re-invites someone.
      const existing = await this.get({ event_id: input.event_id, calendar_id })
      const existingLower = new Set(
        (existing.attendees ?? []).map((e) => e.toLowerCase()),
      )
      const merged: string[] = [...(existing.attendees ?? [])]
      for (const email of input.add_emails) {
        const lower = email.toLowerCase()
        if (existingLower.has(lower)) continue
        merged.push(email)
        existingLower.add(lower)
      }
      const send_updates = input.send_updates ?? 'all'
      const path = `/calendars/${encodeCalendar(calendar_id)}/events/${encodeURIComponent(input.event_id)}?sendUpdates=${encodeURIComponent(send_updates)}`
      const patchBody = {
        attendees: merged.map((email) => ({ email })),
      }
      const raw = (await call('PATCH', path, patchBody, {
        event_id_for_not_found: input.event_id,
      })) as GoogleEventPayload
      return rowFromPayload(calendar_id, raw)
    },
  }
}

/**
 * Parse a free-form event description into an agenda list. Heuristic:
 * lines that start with `-`, `*`, `•`, or `1.` / `1)` are treated as
 * agenda items. Everything else is ignored. Sufficient for v1 brief
 * synthesis; replaced by an LLM-driven summarizer once the brief tool
 * grows past the stub.
 */
export function parseAgenda(description: string | undefined): string[] {
  if (description === undefined || description.trim().length === 0) return []
  const lines = description.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const match = trimmed.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/)
    if (match !== null && typeof match[1] === 'string') {
      out.push(match[1].trim())
    }
  }
  return out
}

/**
 * Compute the integer minute duration of an event. Returns 0 if either
 * timestamp is malformed (defensive — the brief tool surfaces this as
 * duration=0 rather than throwing because a buggy event row should not
 * crash the brief surface).
 */
export function durationMinutes(start: string, end: string): number {
  const s = Date.parse(start)
  const e = Date.parse(end)
  if (Number.isNaN(s) || Number.isNaN(e)) return 0
  return Math.max(0, Math.round((e - s) / 60_000))
}
