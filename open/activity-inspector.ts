/**
 * activity-inspector.ts — the ACTIVITY INSPECTOR's live-only event buffer.
 *
 * WHAT THIS IS. Ryan cannot tell whether a project's agent session is working or
 * hung. In Vajra the escape hatch was attaching to tmux; Neutron's sessions are
 * server-side, so there is no equivalent at all. This module is the server half of
 * the panel that replaces tmux: a bounded, in-memory, per-scope ring of the raw
 * events flowing under a session, plus the derivation that turns those events into
 * an honest answer to "hung or working?".
 *
 * LIVE-ONLY, BY DECISION (Ryan 2026-07-29, SPEC § WAVE 3.5). ~200 events buffered
 * in memory per scope. NO persistence, NO schema, NO migration, NO retention
 * policy. The buffer dies with the process and that is correct — scrollback is
 * explicitly future scope. Consequently there is no store class here talking to
 * SQLite; it is a `Map` and a couple of pure functions.
 *
 * THE POINT OF THE TWO CLOCKS — this is the whole design, so do not "simplify" it
 * away. The signal this panel replaces is known-untrustworthy: ISSUES #386 is the
 * per-project activity dot pulsing for DAYS on a real project while nothing ran. A
 * naive inspector would reproduce that bug exactly, because the substrate's
 * `status` stream contains a SYNTHETIC keepalive (`pool.ts`) that fires every ~10 s
 * for as long as the `claude` child process is alive — including while it is
 * livelocked or parked on a wedged menu. "Events are still arriving" therefore does
 * NOT mean "work is happening".
 *
 * So every scope keeps two timestamps:
 *   - `last_event_at`          — ANY event, keepalive included ⇒ the PROCESS is alive.
 *   - `last_real_activity_at`  — keepalive EXCLUDED ⇒ WORK actually happened.
 *
 * `deriveInspectorState` reads both, which is how it can report `wedged` (alive but
 * doing nothing) as distinct from `dead` (not even breathing) and from `idle` (no
 * turn running at all — the normal resting state, which must never look like a
 * hang). A one-clock inspector can express none of those three distinctions.
 *
 * WHERE THE EVENTS COME FROM (two taps, because one is not enough):
 *   1. The substrate event stream, teed at the ONE drain
 *      (`runtime/substrate-text.ts` `DrainOptions.onEvent`). Carries `status`
 *      notices + keepalives, the single `token`, `completion`, `error`.
 *   2. The Pre/PostToolUse hook (`runtime/.../hooks/activity-tap.ts` → the sink's
 *      `/activity` route). Carries the actual tool activity — `Read foo.ts`,
 *      `Bash bun test` — which the event stream does NOT contain at all, because
 *      the persistent-REPL adapter's 1:1 bridge emits one whole-reply `token` and
 *      no tool events whatsoever.
 */

/** Scope key for the buffer: a project id, or `'general'` for the no-project
 *  General topic (which is a real chat scope with a real warm session, so it gets
 *  a real buffer — never assume a project row exists). */
export type InspectorScopeKey = string

/** The General (no-project) scope key. Mirrors the `project_id ?? 'general'`
 *  convention the live-turn metering context already uses. */
export const GENERAL_SCOPE: InspectorScopeKey = 'general'

/** Resolve a nullable project id to a buffer scope key. */
export function inspectorScopeKey(project_id: string | null | undefined): InspectorScopeKey {
  return project_id === null || project_id === undefined || project_id === ''
    ? GENERAL_SCOPE
    : project_id
}

/**
 * A row in the panel. Deliberately NOT the raw substrate `Event` — the panel is a
 * wire surface consumed by two clients, so it gets a flat, stable, display-shaped
 * type. `kind` drives the row's icon/colour; `label` is the bold part; `detail` is
 * the dim part.
 */
export interface ActivityEvent {
  /** Monotonic per-scope sequence. Lets a client dedupe/ order without clock trust. */
  seq: number
  /** Wall clock (ms) the row was recorded. */
  at: number
  kind: ActivityEventKind
  /** Short bold label — a tool name, or the event kind's word. */
  label: string
  /** Optional dim detail — a file path, a command, an error message. */
  detail?: string
  /**
   * TRUE for the synthetic liveness keepalive ONLY. The panel renders these
   * differently (a faint tick, not a work row) and `last_real_activity_at`
   * excludes them. See the two-clocks note in the file header.
   */
  synthetic?: boolean
}

export type ActivityEventKind =
  | 'tool_start'
  | 'tool_end'
  | 'token'
  | 'thinking'
  | 'status'
  | 'keepalive'
  | 'completion'
  | 'error'
  | 'turn_start'

/** Per-scope buffer + clocks. */
interface ScopeBuffer {
  events: ActivityEvent[]
  seq: number
  last_event_at: number
  /** 0 ⇒ no non-synthetic event ever recorded for this scope. */
  last_real_activity_at: number
  /** Depth of nested in-flight turns; >0 ⇒ a turn is running. */
  turns_in_flight: number
}

/** Ring capacity per scope. ~200 per Ryan's locked decision. */
export const INSPECTOR_BUFFER_CAP = 200

/**
 * How long a turn may go with NO real activity before the panel calls it wedged.
 * Generous on purpose: a single `Bash bun test` or a big `Read` legitimately runs
 * for a while with no intervening tool event, and crying "wedged" at a slow-but-
 * working session would make this panel exactly as untrustworthy as the dot it
 * exists to verify. 90 s is ~9 keepalive ticks — long enough that a real tool is
 * clearly stuck, short enough to beat a human's patience.
 */
export const WEDGE_AFTER_MS = 90_000

/**
 * How long with NO events AT ALL (not even the ~10 s keepalive) before the panel
 * calls the session dead rather than merely wedged. 3 missed keepalives.
 */
export const DEAD_AFTER_MS = 30_000

/**
 * The honest answer to "hung or working?".
 *
 *  - `idle`    — no turn in flight. The resting state. NOT a problem, and must be
 *                visually distinct from a wedge (acceptance requirement).
 *  - `working` — a turn is in flight and real work happened recently.
 *  - `wedged`  — a turn is in flight, the process is still breathing (keepalives
 *                arriving), but NO real activity for `WEDGE_AFTER_MS`. This is the
 *                ISSUES #386 shape, and the state the whole feature exists to name.
 *  - `dead`    — a turn is in flight and even the keepalive has stopped, so the
 *                child is gone/frozen.
 */
export type InspectorState = 'idle' | 'working' | 'wedged' | 'dead'

export interface InspectorSnapshot {
  scope_key: InspectorScopeKey
  events: ActivityEvent[]
  state: InspectorState
  /** ms since the last event of ANY kind, or null if none ever. */
  last_event_age_ms: number | null
  /** ms since the last NON-synthetic event, or null if none ever. */
  last_real_activity_age_ms: number | null
  /** Server clock at snapshot time, so a client can age rows without clock skew. */
  now: number
  turn_in_flight: boolean
}

/**
 * Pure state derivation. Split out from the store so it is directly testable and
 * so both the HTTP snapshot and the live push agree by construction.
 *
 * ORDER IS LOAD-BEARING. `idle` is checked FIRST: a session with no turn running
 * has stale clocks by definition (the last event could be hours old), and reading
 * those stale clocks as `wedged` would make every resting project scream. Then
 * `dead` before `wedged`, because "no events at all" is strictly worse news than
 * "keepalives but no work" and the operator should see the worse one.
 */
export function deriveInspectorState(input: {
  turn_in_flight: boolean
  last_event_at: number
  last_real_activity_at: number
  now: number
  wedge_after_ms?: number
  dead_after_ms?: number
}): InspectorState {
  const wedgeAfter = input.wedge_after_ms ?? WEDGE_AFTER_MS
  const deadAfter = input.dead_after_ms ?? DEAD_AFTER_MS
  if (!input.turn_in_flight) return 'idle'
  // A turn is in flight but we have literally never seen an event: treat as
  // working (the turn was just injected; the first keepalive is up to 10 s away).
  if (input.last_event_at === 0) return 'working'
  if (input.now - input.last_event_at >= deadAfter) return 'dead'
  // THE WEDGE IS MEASURED FROM THE LAST *REAL* EVENT — never from `last_event_at`.
  //
  // This is the crux. Keepalives keep resetting `last_event_at` forever, so measuring
  // the wedge from it would report a permanently-stalled session as working — the
  // precise lie this feature exists to kill (ISSUES #386). `last_real_activity_at`
  // excludes them, so it stops advancing the moment real work stops.
  //
  // `turnStarted` records a non-synthetic `turn_start` row, so a turn in flight always
  // has a non-zero real-activity clock: the turn's own start is the wedge window's
  // floor, with no separate bookkeeping needed. (An earlier draft carried a
  // `turn_started_at` field for this; mutation testing proved it could not change any
  // outcome, so it is gone rather than left as untested complexity.)
  if (input.last_real_activity_at === 0) {
    // In flight and breathing, but no real event has EVER been recorded for this
    // scope — nothing honest to measure against, so do not accuse it of wedging.
    return 'working'
  }
  if (input.now - input.last_real_activity_at >= wedgeAfter) return 'wedged'
  return 'working'
}

/**
 * The in-memory inspector. One instance per process, owned by the composer.
 *
 * `onRecord` is the live-push seam: the composer wires it to the app-ws fan so an
 * appended row reaches every subscribed client (web + mobile share the transport)
 * without this module importing anything about sockets.
 */
export class ActivityInspector {
  private readonly scopes = new Map<InspectorScopeKey, ScopeBuffer>()
  private readonly cap: number
  private readonly onRecord: ((scope: InspectorScopeKey, ev: ActivityEvent) => void) | undefined
  private readonly clock: () => number

  constructor(opts: {
    onRecord?: (scope: InspectorScopeKey, ev: ActivityEvent) => void
    /** Ring capacity override (tests). Default {@link INSPECTOR_BUFFER_CAP}. */
    cap?: number
    /** Clock override (tests). Default `Date.now`. */
    now?: () => number
  } = {}) {
    this.cap = opts.cap ?? INSPECTOR_BUFFER_CAP
    this.onRecord = opts.onRecord
    this.clock = opts.now ?? ((): number => Date.now())
  }

  private buffer(scope: InspectorScopeKey): ScopeBuffer {
    let b = this.scopes.get(scope)
    if (b === undefined) {
      b = {
        events: [],
        seq: 0,
        last_event_at: 0,
        last_real_activity_at: 0,
        turns_in_flight: 0,
      }
      this.scopes.set(scope, b)
    }
    return b
  }

  /**
   * Append one row. Bounded: the ring drops the OLDEST row past `cap`, so a long
   * autonomous build cannot grow this without limit (live-only means the buffer is
   * the only copy, and an unbounded "only copy" is a memory leak with extra steps).
   */
  record(
    scope: InspectorScopeKey,
    row: { kind: ActivityEventKind; label: string; detail?: string; synthetic?: boolean },
  ): ActivityEvent {
    const b = this.buffer(scope)
    const at = this.clock()
    b.seq += 1
    const ev: ActivityEvent = {
      seq: b.seq,
      at,
      kind: row.kind,
      label: row.label,
      ...(row.detail !== undefined && row.detail !== '' ? { detail: row.detail } : {}),
      ...(row.synthetic === true ? { synthetic: true } : {}),
    }
    b.events.push(ev)
    if (b.events.length > this.cap) b.events.splice(0, b.events.length - this.cap)
    b.last_event_at = at
    // THE TWO CLOCKS (file header): a synthetic keepalive advances only the
    // liveness clock. If this line ever becomes unconditional, the panel starts
    // reporting wedged sessions as working — i.e. it reintroduces ISSUES #386.
    if (row.synthetic !== true) b.last_real_activity_at = at
    this.onRecord?.(scope, ev)
    return ev
  }

  /** Mark a turn as started for a scope (drives `turn_in_flight`). Records a row so
   *  the panel shows the turn boundary. Re-entrant: nested/concurrent turns on one
   *  scope increment a depth counter rather than clobbering a boolean. */
  turnStarted(scope: InspectorScopeKey): void {
    const b = this.buffer(scope)
    b.turns_in_flight += 1
    // Recording a NON-SYNTHETIC row here is load-bearing, not decoration: it is what
    // establishes the wedge window's floor. Make this row synthetic (or drop it) and a
    // turn whose only subsequent traffic is keepalives can never be detected as
    // stalled — the ISSUES #386 lie, rebuilt.
    this.record(scope, { kind: 'turn_start', label: 'turn started' })
  }

  /** Mark a turn as finished. Never drops below 0 (a double-settle must not make a
   *  live scope look idle-negative). */
  turnFinished(scope: InspectorScopeKey): void {
    const b = this.buffer(scope)
    if (b.turns_in_flight > 0) b.turns_in_flight -= 1
  }

  /** Point-in-time view for the HTTP snapshot the panel fetches on open. This is
   *  load-bearing for the WEDGE case: a wedged session emits nothing, so without a
   *  snapshot the panel would open blank and could not say how long ago the last
   *  event was — the exact question it exists to answer. */
  snapshot(scope: InspectorScopeKey): InspectorSnapshot {
    const b = this.scopes.get(scope)
    const now = this.clock()
    if (b === undefined) {
      return {
        scope_key: scope,
        events: [],
        state: 'idle',
        last_event_age_ms: null,
        last_real_activity_age_ms: null,
        now,
        turn_in_flight: false,
      }
    }
    const turn_in_flight = b.turns_in_flight > 0
    return {
      scope_key: scope,
      events: [...b.events],
      state: deriveInspectorState({
        turn_in_flight,
        last_event_at: b.last_event_at,
        last_real_activity_at: b.last_real_activity_at,
        now,
      }),
      last_event_age_ms: b.last_event_at === 0 ? null : now - b.last_event_at,
      last_real_activity_age_ms:
        b.last_real_activity_at === 0 ? null : now - b.last_real_activity_at,
      now,
      turn_in_flight,
    }
  }
}

/**
 * Map a raw substrate `Event` onto an {@link ActivityEvent} row, or `null` for an
 * event with nothing worth showing.
 *
 * Typed structurally (`kind` + the optional fields actually read) instead of
 * importing `Event` from `@neutronai/runtime`, so this Open-band module stays a
 * dependency-free pure leaf that the client-facing wire type can be derived from.
 *
 * `token` is summarised, never echoed in full: the reply body already renders in
 * chat as a message, and duplicating a multi-KB answer into a live-fanned
 * inspector frame would be pure waste.
 */
export function activityRowFromSubstrateEvent(ev: {
  kind: string
  text?: string
  message?: string
  tool_name?: string
  keepalive?: boolean
}): { kind: ActivityEventKind; label: string; detail?: string; synthetic?: boolean } | null {
  switch (ev.kind) {
    case 'status':
      return ev.keepalive === true
        ? { kind: 'keepalive', label: 'alive', synthetic: true }
        : { kind: 'status', label: 'status', detail: ev.message ?? '' }
    case 'thinking':
      return { kind: 'thinking', label: 'thinking', detail: summarize(ev.text ?? '') }
    case 'tool_call':
      return { kind: 'tool_start', label: ev.tool_name ?? 'tool' }
    case 'tool_result_ack':
      return { kind: 'tool_end', label: 'tool result' }
    case 'token':
      return { kind: 'token', label: 'reply', detail: `${(ev.text ?? '').length} chars` }
    case 'completion':
      return { kind: 'completion', label: 'turn complete' }
    case 'error':
      return { kind: 'error', label: 'error', detail: summarize(ev.message ?? '') }
    default:
      return null
  }
}

/** Max chars of any detail string that reaches a client frame. */
const DETAIL_MAX = 160

function summarize(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat
}

/** Map a tool-tap hook POST onto a row. `pre` ⇒ started, `post` ⇒ finished. */
export function activityRowFromToolTap(input: {
  phase: 'pre' | 'post'
  tool_name: string
  detail: string
}): { kind: ActivityEventKind; label: string; detail?: string } {
  return {
    kind: input.phase === 'pre' ? 'tool_start' : 'tool_end',
    label: input.tool_name,
    detail: summarize(input.detail),
  }
}
