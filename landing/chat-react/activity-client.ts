/**
 * landing/chat-react — web ACTIVITY INSPECTOR client (SPEC § WAVE 3.5).
 *
 * The panel behind the clickable per-project activity dot. Two data paths, and
 * both are needed:
 *
 *   1. `GET /api/app/projects/<id>/activity` (or `/api/app/activity` for General)
 *      — the on-open SNAPSHOT: the server's ~200-row in-memory ring plus the
 *      derived state and BOTH clocks. This is the half that answers the wedge
 *      question, because a wedged session emits nothing to stream.
 *   2. Live `activity_event` frames off the app-ws socket, appended on top. This
 *      is the half that makes the panel visibly tick while a turn runs.
 *
 * LIVE-ONLY by decision: no persistence anywhere behind this, so an empty buffer
 * after a restart is correct, not a bug.
 *
 * Wire shapes are re-declared here rather than imported across the workspace
 * boundary, matching the convention `work-board-client.ts` / `tasks-client.ts`
 * follow (keeps the browser bundle free of a gateway dependency). Pure given an
 * injected `fetchImpl`, so it unit-tests with no DOM and no live server.
 */

import {
  GatewayClientError,
  GatewayHttpClient,
  type GatewayHttpClientOptions,
} from '@neutronai/client-core'

/** Row kinds, mirroring `open/activity-inspector.ts` `ActivityEventKind`. */
export type ActivityRowKind =
  | 'tool_start'
  | 'tool_end'
  | 'token'
  | 'thinking'
  | 'status'
  | 'keepalive'
  | 'completion'
  | 'error'
  | 'turn_start'

/** One panel row. */
export interface ActivityRow {
  seq: number
  at: number
  kind: ActivityRowKind
  label: string
  detail?: string
  /** The synthetic liveness keepalive — proves the PROCESS lives, not that work
   *  happened. Rendered faint and excluded from the "last activity" clock. */
  synthetic?: boolean
}

/** Session verdict, mirroring `open/activity-inspector.ts` `InspectorState`. */
export type ActivityState = 'idle' | 'working' | 'wedged' | 'dead'

export interface ActivitySnapshot {
  scope_key: string
  events: ActivityRow[]
  state: ActivityState
  last_event_age_ms: number | null
  last_real_activity_age_ms: number | null
  now: number
  turn_in_flight: boolean
}

const ROW_KINDS: ReadonlySet<string> = new Set<ActivityRowKind>([
  'tool_start',
  'tool_end',
  'token',
  'thinking',
  'status',
  'keepalive',
  'completion',
  'error',
  'turn_start',
])

const STATES: ReadonlySet<string> = new Set<ActivityState>(['idle', 'working', 'wedged', 'dead'])

/**
 * Validate one wire row. Returns null for anything malformed — the panel renders
 * `label`/`detail` as text, and a row with a non-string label would render
 * `[object Object]` rather than failing loudly, so it is dropped at the boundary.
 */
export function parseActivityRow(raw: unknown): ActivityRow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const seq = r['seq']
  const at = r['at']
  const kind = r['kind']
  const label = r['label']
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  if (typeof kind !== 'string' || !ROW_KINDS.has(kind)) return null
  if (typeof label !== 'string') return null
  const row: ActivityRow = { seq, at, kind: kind as ActivityRowKind, label }
  if (typeof r['detail'] === 'string' && r['detail'].length > 0) row.detail = r['detail']
  if (r['synthetic'] === true) row.synthetic = true
  return row
}

/** Validate a snapshot response body. Throws nothing; returns null when unusable. */
export function parseActivitySnapshot(raw: unknown): ActivitySnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const state = r['state']
  if (typeof state !== 'string' || !STATES.has(state)) return null
  const rawEvents = Array.isArray(r['events']) ? (r['events'] as unknown[]) : []
  const events: ActivityRow[] = []
  for (const e of rawEvents) {
    const row = parseActivityRow(e)
    if (row !== null) events.push(row)
  }
  const num = (k: string): number | null => {
    const v = r[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  return {
    scope_key: typeof r['scope_key'] === 'string' ? (r['scope_key'] as string) : '',
    events,
    state: state as ActivityState,
    last_event_age_ms: num('last_event_age_ms'),
    last_real_activity_age_ms: num('last_real_activity_age_ms'),
    now: num('now') ?? Date.now(),
    turn_in_flight: r['turn_in_flight'] === true,
  }
}

/**
 * The scope key the client uses for General. The web shell models General as the
 * EMPTY project id (`vm.projectId === null` → `''`) but the server keys the
 * General buffer on the literal `'general'` (matching the live-turn metering
 * scope), so the two must be mapped at this boundary — the identical mismatch
 * `workBoardPathSegment` handles for the board.
 */
export const GENERAL_ACTIVITY_SCOPE = 'general'

/** Map a client-side scope id (`''` ⇒ General) to its inspector scope key. */
export function activityScopeKey(project_id: string | null): string {
  return project_id === null || project_id.length === 0 ? GENERAL_ACTIVITY_SCOPE : project_id
}

/** Map a client-side scope id to its snapshot URL path. */
export function activityPath(project_id: string | null): string {
  const scope = activityScopeKey(project_id)
  return scope === GENERAL_ACTIVITY_SCOPE
    ? '/api/app/activity'
    : `/api/app/projects/${encodeURIComponent(scope)}/activity`
}

/**
 * Human age string for a clock. Deliberately coarse and deliberately ALWAYS
 * shown: "how long ago was the last event" is the single number that answers
 * "hung or working?", so it must never be hidden behind a hover or a threshold.
 * `null` (nothing ever recorded) renders as an em-dash-free "never".
 */
export function formatAge(ms: number | null): string {
  if (ms === null) return 'never'
  if (ms < 1000) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s ago`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m ago`
}

/**
 * The one-line verdict the panel headlines. Plain language on purpose: the owner
 * opens this panel because they already distrust the dot, so the answer has to be
 * a sentence, not a colour.
 */
export function describeState(state: ActivityState): string {
  switch (state) {
    case 'idle':
      return 'Idle — no turn running'
    case 'working':
      return 'Working'
    case 'wedged':
      return 'Stalled — alive but no activity'
    case 'dead':
      return 'Not responding — no signal at all'
  }
}

export class ActivityClientError extends GatewayClientError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status)
    this.name = 'ActivityClientError'
  }
}

export type ActivityClientOptions = GatewayHttpClientOptions

export class WebActivityClient extends GatewayHttpClient {
  protected override readonly guardNetworkErrors = true

  protected override makeError(code: string, message: string, status: number): GatewayClientError {
    return new ActivityClientError(code, message, status)
  }

  /** Fetch the current snapshot for a scope (`null`/`''` ⇒ General). */
  async snapshot(project_id: string | null): Promise<ActivitySnapshot> {
    const body = await this.req<unknown>(activityPath(project_id))
    const parsed = parseActivitySnapshot(body)
    if (parsed === null) {
      throw new ActivityClientError('bad_snapshot', 'malformed activity snapshot', 502)
    }
    return parsed
  }
}

/**
 * Merge a live row into an existing list, keeping it ordered by `seq` and bounded.
 *
 * Idempotent on `seq`: the snapshot fetch and the live subscription overlap by
 * design (the panel subscribes BEFORE it fetches, so no row is lost in the gap),
 * which means the same row legitimately arrives twice. Dropping the duplicate here
 * is what makes that overlap safe.
 */
export function mergeActivityRow(rows: readonly ActivityRow[], row: ActivityRow, cap: number): ActivityRow[] {
  if (rows.some((r) => r.seq === row.seq)) return rows as ActivityRow[]
  const next = [...rows, row]
  next.sort((a, b) => a.seq - b.seq)
  return next.length > cap ? next.slice(next.length - cap) : next
}

/**
 * Age of the newest held row against the CLIENT clock, falling back to the
 * snapshot's clock offset.
 *
 * Why not render `snapshot.last_event_age_ms` directly? It is FROZEN at fetch time.
 * The panel must keep counting up as time passes with no new event — that rising
 * number IS the wedge signal, and a stuck "12s ago" would be exactly the same lie as
 * a stuck pulsing dot (ISSUES #386).
 *
 * `realOnly` selects which clock: `false` = any event (keepalives included ⇒ the
 * process is breathing), `true` = keepalives EXCLUDED (⇒ work actually happened).
 *
 * Lives here rather than in the panel so it is a pure, DOM-free unit — and so the
 * web and mobile clients expose the identical function (see
 * `app/lib/activity-client.ts`).
 */
export function liveAge(
  rows: readonly ActivityRow[],
  snapshot: ActivitySnapshot | null,
  now: number,
  opts: { realOnly: boolean },
): number | null {
  const candidates = opts.realOnly ? rows.filter((r) => r.synthetic !== true) : rows
  const newest = candidates.length > 0 ? candidates[candidates.length - 1] : undefined
  if (newest !== undefined) {
    // Clamp: server `at` vs browser clock can be skewed, and a negative age would
    // read as broken rather than as skew.
    return Math.max(0, now - newest.at)
  }
  if (snapshot === null) return null
  const base = opts.realOnly ? snapshot.last_real_activity_age_ms : snapshot.last_event_age_ms
  if (base === null) return null
  return base + Math.max(0, now - snapshot.now)
}
