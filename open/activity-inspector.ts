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
  /** Short bold label — a HUMAN tool name, or the event kind's word. Never a raw
   *  MCP transport id; see {@link humanizeToolName}. */
  label: string
  /** Optional dim detail — the COLLAPSED one-liner. A file path, a command, the
   *  first line of a reply. Whitespace-flattened and short by construction, so a
   *  row stays one line until the owner expands it. */
  detail?: string
  /**
   * The EXPANDED content: the assistant's actual words, the tool's full arguments,
   * the tool's returned output. This is the field that makes the panel a
   * conversation view rather than a telemetry ticker — `detail` says a Bash call
   * happened, `body` says what it ran and what came back.
   *
   * Newlines are PRESERVED here (unlike `detail`, which is flattened): the shape of
   * a diff, a stack trace or a file listing is most of its meaning. Capped at
   * {@link BODY_MAX}.
   */
  body?: string
  /**
   * Where a namespaced tool came from — the MCP server, with its per-session
   * random incarnation stripped. Rendered as a dim qualifier BESIDE the label, so
   * `mcp__neutron__memory_search` reads as `memory_search · neutron` and the
   * identity is never lost, merely demoted. Absent for a native tool (`Bash`).
   */
  source?: string
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
  /**
   * THE THIRD CLOCK. 0 ⇒ no WRITE-CLASS tool call ever recorded for this scope.
   *
   * `last_real_activity_at` answers "is this session doing anything at all" — it
   * is advanced by `turn_start`, by the agent's own reply, by every status
   * notice. That is exactly right for the wedge verdict and exactly WRONG for the
   * work board: asking the agent a question would otherwise mark every runless
   * in-progress card as being worked on. The board's question is narrower — "is
   * something being REWRITTEN right now" — so it gets a clock advanced only by
   * rows a mapper classified as write-class ({@link isWriteClassTool}).
   */
  last_write_activity_at: number
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
        last_write_activity_at: 0,
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
  /**
   * TWO TAPS SEE THE SAME REPLY. The agent's words reach this ring twice: once as
   * the `reply` TOOL CALL (the hook, at the instant the agent produces them) and
   * once as the substrate's end-of-turn `token` event — because `onReply` is what
   * pushes that token (`repl-session.ts` "the 1:1 bridge: one reply → one token"),
   * so they are the same string microseconds apart. Rendering the owner's message
   * twice in a row would make the transcript look broken.
   *
   * Collapsed on the ONLY shape that artifact can take: an assistant row landing
   * immediately after an assistant row with identical content. Two genuinely
   * repeated assistant messages within one turn would be separated by at least the
   * tool rows that prompted the second, so this cannot swallow real content.
   *
   * Deliberately NOT a time window — the two arrivals are not reliably close (a
   * slow sink POST can lag), and adjacency is the precise property, not recency.
   */
  private isDuplicateAssistantRow(b: ScopeBuffer, row: ActivityRowInput): boolean {
    if (row.kind !== 'token') return false
    const last = b.events[b.events.length - 1]
    if (last === undefined || last.kind !== 'token') return false
    return last.detail === row.detail && last.body === row.body
  }

  record(scope: InspectorScopeKey, row: ActivityRowInput): ActivityEvent {
    const b = this.buffer(scope)
    if (this.isDuplicateAssistantRow(b, row)) {
      // Return the row already held; it is the same content, already fanned.
      return b.events[b.events.length - 1] as ActivityEvent
    }
    const at = this.clock()
    b.seq += 1
    const ev: ActivityEvent = {
      seq: b.seq,
      at,
      kind: row.kind,
      label: row.label,
      ...(row.detail !== undefined && row.detail !== '' ? { detail: row.detail } : {}),
      ...(row.body !== undefined && row.body !== '' ? { body: row.body } : {}),
      ...(row.source !== undefined && row.source !== '' ? { source: row.source } : {}),
      ...(row.synthetic === true ? { synthetic: true } : {}),
    }
    b.events.push(ev)
    if (b.events.length > this.cap) b.events.splice(0, b.events.length - this.cap)
    b.last_event_at = at
    // THE TWO CLOCKS (file header): a synthetic keepalive advances only the
    // liveness clock. If this line ever becomes unconditional, the panel starts
    // reporting wedged sessions as working — i.e. it reintroduces ISSUES #386.
    if (row.synthetic !== true) b.last_real_activity_at = at
    // THE THIRD CLOCK (see ScopeBuffer). Only a mapper-classified write-class tool
    // call advances it, so a pure conversation turn — turn_start, thinking, the
    // reply itself — leaves it untouched and the board stays quiet.
    if (row.write_class === true) b.last_write_activity_at = at
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

  /**
   * O(1) evidence read for the board's derived inline activity
   * (`work-board/inline-activity.ts`). Deliberately NOT `snapshot()`: that copies
   * the whole event ring (~200 rows) and this runs on the rail/board read path per
   * project per refresh.
   *
   * Deliberately the WRITE clock, not `last_real_activity_at`: the board claims a
   * card is being worked, and only a write-class tool call is evidence of that.
   * Returns 0 when the scope has never recorded one (including after a restart —
   * the buffer is live-only, which is exactly the crashed-session semantics the
   * board needs: a stale stored flag reads not-active).
   */
  lastWriteActivityAt(scope: InspectorScopeKey): number {
    return this.scopes.get(scope)?.last_write_activity_at ?? 0
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

/** The shape every mapper returns and {@link ActivityInspector.record} accepts. */
export interface ActivityRowInput {
  kind: ActivityEventKind
  label: string
  detail?: string
  body?: string
  source?: string
  synthetic?: boolean
  /**
   * TRUE for a tool call that MUTATES something (a file write/edit, a mutating
   * shell command). Set by the mappers, never on the wire: it advances the
   * board's write clock only ({@link ScopeBuffer.last_write_activity_at}) and
   * changes nothing about how the row renders.
   */
  write_class?: boolean
}

/**
 * Map a raw substrate `Event` onto an {@link ActivityEvent} row, or `null` for an
 * event with nothing worth showing.
 *
 * Typed structurally (`kind` + the optional fields actually read) instead of
 * importing `Event` from `@neutronai/runtime`, so this Open-band module stays a
 * dependency-free pure leaf that the client-facing wire type can be derived from.
 *
 * THE REPLY IS THE POINT, NOT ITS LENGTH. `token` used to render as
 * `reply — 29 chars`, which reports the SIZE of the answer instead of the answer.
 * Ryan 2026-07-30, on the shipped panel: *"can we see the actual detailed messages
 * like would be shown in a Claude Code session instead of these terse tool calls"*.
 * A character count is the one thing about a reply that is never what you wanted to
 * know. The text now rides in `body` (capped at {@link BODY_MAX}) with its first
 * line as the collapsed `detail`.
 *
 * The earlier rationale for dropping it — "the reply body already renders in chat"
 * — does not survive contact with the actual surface: the inspector is read while a
 * turn is IN FLIGHT, precisely when chat has not rendered anything yet, and it is
 * read on a WEDGED session, where chat will never render it at all.
 */
export function activityRowFromSubstrateEvent(ev: {
  kind: string
  text?: string
  message?: string
  tool_name?: string
  keepalive?: boolean
}): ActivityRowInput | null {
  switch (ev.kind) {
    case 'status':
      return ev.keepalive === true
        ? { kind: 'keepalive', label: 'alive', synthetic: true }
        : { kind: 'status', label: 'status', detail: summarize(ev.message ?? '') }
    case 'thinking':
      return withBody({ kind: 'thinking', label: 'thinking' }, ev.text ?? '')
    case 'tool_call': {
      const named = humanizeToolName(ev.tool_name ?? 'tool')
      // No arguments on this tap, so a shell call cannot be classified here and
      // is left non-write (fails closed); a named write tool still counts.
      return {
        kind: 'tool_start',
        label: named.label,
        ...sourceOf(named),
        ...(isWriteClassTool(ev.tool_name ?? '') ? { write_class: true } : {}),
      }
    }
    case 'tool_result_ack':
      return { kind: 'tool_end', label: 'tool result' }
    case 'token':
      return withBody({ kind: 'token', label: ASSISTANT_LABEL }, ev.text ?? '')
    case 'completion':
      return { kind: 'completion', label: 'turn complete' }
    case 'error':
      return withBody({ kind: 'error', label: 'error' }, ev.message ?? '')
    default:
      return null
  }
}

/**
 * Max chars of the COLLAPSED one-liner. Sized to fill a phone row without
 * wrapping past two lines; the full content lives in `body`.
 */
const DETAIL_MAX = 160

/**
 * Max chars of the EXPANDED body that reaches a client frame.
 *
 * The buffer is live-only and the ONLY copy (file header), so this cap is what
 * bounds its memory: {@link INSPECTOR_BUFFER_CAP} rows × this ≈ 400 KB per scope
 * worst-case, which is the honest price of showing content instead of counts. It
 * is also the per-frame WS payload ceiling, fanned to every subscribed client.
 * Big enough for a real reply, a stack trace or a directory listing; small enough
 * that a 40 KB file read does not become a 40 KB broadcast.
 */
export const BODY_MAX = 2_000

/** Collapse whitespace and clip — for the one-line `detail`. */
function summarize(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat
}

/**
 * Clip for the expanded `body`, PRESERVING newlines. Line structure is most of the
 * meaning of a diff, a stack trace or a file listing, so the `detail` flattening
 * must not be applied here.
 */
export function clipBody(s: string): string {
  const trimmed = s.trim()
  return trimmed.length > BODY_MAX ? `${trimmed.slice(0, BODY_MAX - 1)}…` : trimmed
}

/**
 * Attach `content` to a row as BOTH the collapsed one-liner and the expanded body.
 *
 * The `body` is omitted when it would merely repeat `detail` (a short single-line
 * value is already fully visible collapsed), so the expand affordance appears only
 * where expanding actually reveals something.
 */
function withBody(base: { kind: ActivityEventKind; label: string }, content: string): ActivityRowInput {
  const detail = summarize(content)
  const body = clipBody(content)
  return { ...base, detail, ...(body !== detail ? { body } : {}) }
}

function sourceOf(named: { source?: string }): { source?: string } {
  return named.source !== undefined ? { source: named.source } : {}
}

const MCP_PREFIX = 'mcp__'

/**
 * A per-session MCP server incarnation suffix — `spawn.ts` names the dev-channel
 * server `neutron-<randomBytes(16).toString('hex')>` (32 hex chars; it was 4 bytes
 * / 8 hex before the 2026-07-20 security review, and a session spawned by an older
 * build can still be in the pool). Matching `{8,}` covers both without any
 * plausible false positive: a human-chosen server name does not end in a long run
 * of hex preceded by a hyphen.
 */
const INCARNATION_SUFFIX = /-[0-9a-f]{8,}$/i

/**
 * Turn a raw on-wire tool name into something a human can read.
 *
 * THE BUG THIS FIXES. The panel rendered `mcp__neutron-<32 hex>…__reply` — clipped
 * mid-id, running off the right edge, with the ONE informative token (`reply`) at
 * the far end where the truncation ate it. That string is not a tool name, it is a
 * transport address: `mcp__<server>__<tool>`, where `<server>` for the dev-channel
 * is a per-session RANDOM value (`spawn.ts` `channelName`) that is different on
 * every spawn and means nothing to anyone. Rendering it as the primary label makes
 * two different calls to the same tool look like two different tools.
 *
 * So: the TOOL is the label, the server is demoted to a dim `source` qualifier
 * (kept, not discarded — `memory_search` from the Neutron bridge and a
 * same-named tool from some other server must stay distinguishable), and the
 * random incarnation is stripped so the qualifier is stable across spawns.
 *
 *   `mcp__neutron__memory_search`       → { label: 'memory_search', source: 'neutron' }
 *   `mcp__neutron-<32 hex>…__reply`     → { label: 'reply',         source: 'neutron' }
 *   `Bash`                              → { label: 'Bash' }
 *
 * Anything that does not parse falls through UNCHANGED rather than being mangled:
 * showing an odd name truthfully beats inventing a pretty wrong one.
 */
export function humanizeToolName(raw: string): { label: string; source?: string } {
  if (!raw.startsWith(MCP_PREFIX)) return { label: raw }
  const rest = raw.slice(MCP_PREFIX.length)
  const sep = rest.indexOf('__')
  // `mcp__` with no `__<tool>` half is not the namespaced form — leave it alone.
  if (sep <= 0) return { label: raw }
  const tool = rest.slice(sep + 2)
  if (tool === '') return { label: raw }
  const server = rest.slice(0, sep).replace(INCARNATION_SUFFIX, '')
  return { label: tool, ...(server !== '' ? { source: server } : {}) }
}

/**
 * The dev-channel's reply tool — the seam through which the agent's ACTUAL WORDS
 * reach the owner. `dev-channel-impl.ts` registers it as `reply` with a single
 * `text` argument ("your COMPLETE response for this turn"), and `spawn.ts` mounts
 * that server under the per-session random name, so on the wire it is
 * `mcp__neutron-<incarnation>__reply` — which is exactly the unreadable row in the
 * screenshot. Matched on the HUMANISED pair so the random half cannot defeat it.
 */
const REPLY_TOOL = 'reply'
const NEUTRON_SOURCE = 'neutron'

function isReplyTool(named: { label: string; source?: string }): boolean {
  return named.label === REPLY_TOOL && named.source === NEUTRON_SOURCE
}

/**
 * Map a tool-tap hook POST onto a row. `pre` ⇒ started, `post` ⇒ finished.
 *
 * THE INTERLEAVE (Ryan 2026-07-30: *"interleaved with the actual messages the model
 * is outputting, not just the size"*). The assistant's words are not a separate
 * stream that has to be merged in — they arrive HERE, as the `reply` tool call, at
 * the exact chronological instant the agent produces them. The previous build saw
 * that call and threw the words away twice over: `summarizeToolInput` had no `text`
 * in its pick list, so the row carried NO detail, and the label was the raw
 * transport id. That is the mystery `mcp__neutron-<32 hex>…` row in the screenshot —
 * the whole assistant message, rendered as an opaque id with the content dropped.
 *
 * So a `reply` call becomes an ASSISTANT MESSAGE row (`kind: 'token'`), peer to the
 * tool rows on one timeline, and its `post` phase is dropped entirely — the tool
 * returns a bare ack, and "finished replying" is noise next to the reply itself.
 *
 * WHICH CONTENT EACH PHASE CARRIES for every other tool. On `pre` the interesting
 * thing is the CALL — what is about to run, with what arguments. On `post` it is the
 * RETURN — what came back, which the previous build showed nothing of at all
 * (`tasks_list` with no hint of what it listed). So `post` prefers the result and
 * falls back to the arguments when a tool returned nothing, rather than rendering a
 * bare tool name.
 *
 * Returns `null` for a row that should not be shown at all.
 */
export function activityRowFromToolTap(input: {
  phase: 'pre' | 'post'
  tool_name: string
  detail: string
  /** Full arguments of the call, pre-rendered by the hook. */
  args?: string
  /** Full output the tool returned, pre-rendered by the hook (`post` only). */
  result?: string
}): ActivityRowInput | null {
  const named = humanizeToolName(input.tool_name)
  const isPre = input.phase === 'pre'

  if (isReplyTool(named)) {
    // The `post` ack carries nothing the owner wants; the words already landed.
    if (!isPre) return null
    return withBody({ kind: 'token', label: ASSISTANT_LABEL }, input.args ?? input.detail)
  }

  const content = isPre ? (input.args ?? '') : (input.result ?? input.args ?? '')
  const detail = summarize(input.detail !== '' ? input.detail : content)
  const body = clipBody(content)
  const shellLabel = isPre ? commandLabelForShellTool(named.label, input.args) : null
  return {
    kind: isPre ? 'tool_start' : 'tool_end',
    label: shellLabel ?? named.label,
    ...sourceOf(named),
    // The board's write clock. Classified from the RAW tool name + arguments,
    // which only this mapper has — by the time a row reaches the ring, a Bash
    // call has been relabelled to its command and the arguments are display text.
    ...(isWriteClassTool(input.tool_name, input.args ?? input.detail) ? { write_class: true } : {}),
    ...(detail !== '' ? { detail } : {}),
    ...(body !== '' && body !== detail ? { body } : {}),
  }
}

const SHELL_TOOLS = new Set(['bash', 'shell', 'sh', 'zsh'])
const MULTIPLEXERS = new Set(['bun', 'git', 'npm', 'pnpm', 'yarn', 'gh', 'docker'])
const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'node', 'python', 'python3', 'ruby'])

/** Tools whose whole purpose is to modify a file. Matched on the HUMANISED name
 *  (lower-cased), so an MCP-namespaced `mcp__x__edit_file` classifies too. */
const WRITE_CLASS_TOOLS = new Set([
  'write',
  'edit',
  'multiedit',
  'edit_file',
  'write_file',
  'create_file',
  'notebookedit',
  'notebook_edit',
  'apply_patch',
  'str_replace_editor',
  'str_replace_based_edit_tool',
])

/** Leading shell words that only ever mutate the filesystem. */
const WRITE_SHELL_COMMANDS = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'mkdir',
  'touch',
  'ln',
  'chmod',
  'chown',
  'truncate',
  'tee',
  'patch',
  'dd',
])

/** `git <sub>` forms that write the worktree, the index or a ref. */
const WRITE_GIT_SUBCOMMANDS = new Set([
  'add',
  'am',
  'apply',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'init',
  'merge',
  'mv',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'switch',
  'tag',
  'worktree',
])

/**
 * Best-effort: pull the shell line out of a tap's rendered arguments. The hook
 * renders a single-key argument object as the bare string but a multi-key one
 * (Bash carries `command` + `description`) as pretty JSON, so both shapes arrive.
 */
function shellCommandFromArgs(args: string): string {
  const t = args.trim()
  if (t.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(t)
      if (parsed !== null && typeof parsed === 'object') {
        const cmd = (parsed as { command?: unknown }).command
        if (typeof cmd === 'string') return cmd
      }
    } catch {
      // Clipped/invalid JSON falls through to the raw text, which still classifies.
    }
  }
  return t
}

/**
 * Does this shell line mutate anything? Segment-wise so `git log | grep rm` is not
 * mistaken for `rm`: each `;`/`|`/`&`-separated segment is judged on its LEADING
 * word (after env assignments and a leading paren), plus two forms that hide the
 * write in the arguments — an output redirect and `sed -i`.
 *
 * FAILS CLOSED BY DESIGN. Anything unrecognised is NOT write-class, so an exotic
 * write goes unnoticed (the board simply keeps saying quiet) rather than a read
 * being reported as work. Acceptance (c) — quiet means quiet — is the property
 * worth protecting; a missed row costs at most a late ▶ suppression.
 */
export function isWriteClassShellCommand(command: string): boolean {
  for (const raw of command.split(/[;|&\n]+/)) {
    const segment = raw
      .trim()
      .replace(/^\(+\s*/, '')
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)+/, '')
    if (segment === '') continue
    // `> file` / `>> file` — the shell's own write verb.
    if (/(^|\s)>>?\s*\S/.test(segment)) return true
    const tokens = segment.split(/\s+/)
    const head = (tokens[0] ?? '').toLowerCase().replace(/^.*\//, '')
    if (WRITE_SHELL_COMMANDS.has(head)) return true
    if (head === 'git' && WRITE_GIT_SUBCOMMANDS.has((tokens[1] ?? '').toLowerCase())) return true
    if (head === 'sed' && tokens.slice(1).some((t) => /^-[a-z]*i$/.test(t) || t === '--in-place')) {
      return true
    }
  }
  return false
}

/**
 * Is this tool call EVIDENCE OF A WRITE — the only thing the work board treats as
 * proof that a card is being worked (`work-board/inline-activity.ts`)?
 *
 * The bar is deliberately higher than "the session did something". A question
 * answered, a file read, a search — those advance `last_real_activity_at` and
 * belong in the panel, but they are not somebody rewriting the repo, and letting
 * them light the board up is the flag's original lie wearing a new hat.
 */
export function isWriteClassTool(tool_name: string, args?: string): boolean {
  const label = humanizeToolName(tool_name).label.toLowerCase()
  if (WRITE_CLASS_TOOLS.has(label)) return true
  if (SHELL_TOOLS.has(label)) {
    return args !== undefined && args !== '' && isWriteClassShellCommand(shellCommandFromArgs(args))
  }
  return false
}

/** Best-effort inline label for a shell call. Ambiguous control flow stays generic. */
export function commandLabelForShellTool(tool: string, command: string | undefined): string | null {
  if (!SHELL_TOOLS.has(tool.toLowerCase()) || command === undefined) return null
  let s = command.trim()
  if (s === '' || /^(case|function|select)\b/.test(s)) return null
  s = s.replace(/^\(+\s*/, '')
  s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)+/, '')
  s = s.replace(/^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*&&\s*/, '')
  s = s.replace(/^set\s+(?:-[A-Za-z]+|-[A-Za-z]+\s+\S+|\+\S+)(?:\s+\S+)*?\s*;\s*/, '')
  if (/^(for|while)\b/.test(s)) {
    const match = s.match(/\bdo\s+([^;|&]+)/)
    if (match === null) return null
    s = match[1]!.trim()
  } else if (/^if\b/.test(s)) {
    const match = s.match(/^if\s+([^;]+)(?:;\s*then\b)?/)
    if (match === null) return null
    s = match[1]!.trim()
  }
  const segment = s.split('|', 1)[0]!.replace(/^\(+\s*/, '').trim()
  const tokens = segment.match(/(?:"[^"]*"|'[^']*'|[^\s;&]+)/g)?.map((t) => t.replace(/^['"]|['"]$/g, '')) ?? []
  while (tokens[0]?.startsWith('-')) tokens.shift()
  if (tokens.length === 0) return null
  let first = tokens.shift()!
  first = first.split('/').pop() ?? first
  if (INTERPRETERS.has(first) && tokens[0] !== undefined && !tokens[0].startsWith('-')) {
    const script = tokens[0].split('/').pop()!
    if (/\.[A-Za-z0-9]+$/.test(script)) return script
  }
  if (MULTIPLEXERS.has(first)) {
    const meaningful = tokens.filter((t) => !t.startsWith('-'))
    let sub = meaningful[0]
    if (first === 'npm' && sub === 'run') sub = meaningful[1] === undefined ? 'run' : `run ${meaningful[1]}`
    if (first === 'docker' && sub === 'compose') sub = 'compose'
    if (sub === undefined) return null
    const label = `${first} ${sub}`
    return label.split(/\s+/).slice(0, 3).join(' ')
  }
  return first.length > 0 && !/[$`{}]/.test(first) ? first : null
}

/** The label every assistant-message row carries, from either source. Shared so the
 *  duplicate-suppression below can recognise the pair. */
export const ASSISTANT_LABEL = 'assistant'
