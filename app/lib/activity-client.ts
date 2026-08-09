/**
 * @neutronai/app — ACTIVITY INSPECTOR client + live decoder (SPEC § WAVE 3.5).
 *
 * The mobile twin of `landing/chat-react/activity-client.ts`, and the mobile half
 * of the tmux replacement: tap a project's activity dot, see the raw substrate +
 * tool event stream for that scope and how long ago the last one arrived.
 *
 * Two data paths, both required:
 *   1. `GET /api/app/projects/<id>/activity` (or `/api/app/activity` for General)
 *      — the on-open SNAPSHOT: the server's ~200-row in-memory ring plus the derived
 *      state and BOTH clocks. This is the half that answers the wedge question,
 *      because a wedged session emits nothing to stream.
 *   2. Live `activity_event` frames over the shared app-ws socket, appended on top —
 *      the half that makes the panel visibly tick while a turn runs.
 *
 * The transport is platform-agnostic (the `platform === 'web'` topic gate was
 * deleted — `gateway/http/app-ws-surface.ts` `resolveChannelTopicId` takes no
 * platform argument), so this consumes exactly the same server push the web panel
 * does; there is no mobile-specific server path.
 *
 * LIVE-ONLY: nothing is persisted behind this, so an empty buffer after a server
 * restart is correct.
 */

import {
  GatewayClientError,
  GatewayHttpClient,
  type GatewayHttpClientOptions,
} from '@neutronai/client-core';
import { GENERAL_HTTP_ID, httpProjectSegment } from './general-scope';

/**
 * Map an http(s) origin to its ws(s) form. Inlined (rather than imported from
 * `./config`) so this module — and its unit test — stay free of the
 * `expo-constants` import chain that `config.ts` drags in. Same convention +
 * identical behaviour as `work-board-live.ts` / `projects-rail-live.ts`.
 */
function httpToWs(base_url: string): string {
  if (base_url.startsWith('http://')) return 'ws://' + base_url.slice('http://'.length);
  if (base_url.startsWith('https://')) return 'wss://' + base_url.slice('https://'.length);
  return base_url;
}

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
  | 'turn_start';

export interface ActivityRow {
  seq: number;
  at: number;
  kind: ActivityRowKind;
  /** HUMAN tool name or event word — never a raw `mcp__<server>__<tool>` id. */
  label: string;
  /** The collapsed one-liner. */
  detail?: string;
  /** The expanded content: the assistant's actual words, a call's full arguments,
   *  a tool's returned output. Newlines preserved; server-capped. */
  body?: string;
  /** The MCP server a namespaced tool came from — a dim qualifier, never the label. */
  source?: string;
  /** The synthetic liveness keepalive — proves the PROCESS lives, not that work
   *  happened. Rendered faint and excluded from the "last activity" clock. */
  synthetic?: boolean;
}

/** Session verdict, mirroring `open/activity-inspector.ts` `InspectorState`. */
export type ActivityState = 'idle' | 'working' | 'wedged' | 'dead';

export interface ActivitySnapshot {
  scope_key: string;
  events: ActivityRow[];
  state: ActivityState;
  last_event_age_ms: number | null;
  last_real_activity_age_ms: number | null;
  now: number;
  turn_in_flight: boolean;
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
]);

const STATES: ReadonlySet<string> = new Set<ActivityState>(['idle', 'working', 'wedged', 'dead']);

/**
 * The scope key the General (no-project) chat uses ON THE SERVER. Mobile models
 * General with its own real warm session, so it has its own buffer — never assume a
 * project row exists (`app/app/projects/[id]/_layout.tsx` general scope).
 *
 * MIND THE THREE REPRESENTATIONS OF GENERAL. They are not interchangeable and this
 * boundary is where they meet:
 *   - the mobile RAIL id / route segment is `'~general'` (`GENERAL_PROJECT_ID`,
 *     chosen because it must survive being a URL path segment),
 *   - the mobile CHAT SCOPE is `''` (`railIdToScope`),
 *   - the SERVER's inspector scope key is `'general'` (it comes from the live turn's
 *     `turn.project_id ?? 'general'`).
 * So a rail id must be run through `railIdToScope` before it gets here; both `''`
 * and `'~general'` are accepted below so a caller that forgets cannot silently
 * inspect a project literally named "~general".
 */
export const GENERAL_ACTIVITY_SCOPE = GENERAL_HTTP_ID;

/** Normalize any client-side General spelling (`null`, `''`, `'~general'`) to the
 *  server's scope key; anything else is a project id and passes through. The
 *  mapping itself lives in `general-scope.ts`, shared with every other client
 *  that talks to a project-scoped surface. */
export function activityScopeKey(project_id: string | null | undefined): string {
  return httpProjectSegment(project_id);
}

/** Snapshot URL path for a scope. */
export function activityPath(project_id: string | null | undefined): string {
  const scope = activityScopeKey(project_id);
  return scope === GENERAL_ACTIVITY_SCOPE
    ? '/api/app/activity'
    : `/api/app/projects/${encodeURIComponent(scope)}/activity`;
}

/** Validate one wire row; null when malformed (the panel renders these as text). */
export function parseActivityRow(raw: unknown): ActivityRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const seq = r['seq'];
  const at = r['at'];
  const kind = r['kind'];
  const label = r['label'];
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (typeof kind !== 'string' || !ROW_KINDS.has(kind)) return null;
  if (typeof label !== 'string') return null;
  const row: ActivityRow = { seq, at, kind: kind as ActivityRowKind, label };
  if (typeof r['detail'] === 'string' && r['detail'].length > 0) row.detail = r['detail'];
  if (typeof r['body'] === 'string' && r['body'].length > 0) row.body = r['body'];
  if (typeof r['source'] === 'string' && r['source'].length > 0) row.source = r['source'];
  if (r['synthetic'] === true) row.synthetic = true;
  return row;
}

export function parseActivitySnapshot(raw: unknown): ActivitySnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const state = r['state'];
  if (typeof state !== 'string' || !STATES.has(state)) return null;
  const rawEvents = Array.isArray(r['events']) ? (r['events'] as unknown[]) : [];
  const events: ActivityRow[] = [];
  for (const e of rawEvents) {
    const row = parseActivityRow(e);
    if (row !== null) events.push(row);
  }
  const num = (k: string): number | null => {
    const v = r[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  return {
    scope_key: typeof r['scope_key'] === 'string' ? (r['scope_key'] as string) : '',
    events,
    state: state as ActivityState,
    last_event_age_ms: num('last_event_age_ms'),
    last_real_activity_age_ms: num('last_real_activity_age_ms'),
    now: num('now') ?? Date.now(),
    turn_in_flight: r['turn_in_flight'] === true,
  };
}

/**
 * Decode one inbound socket message into a row for THIS subscriber's scope.
 * Returns null for anything else.
 *
 * The scope filter is required, not defensive: the app-ws topic is per-user, so a
 * sibling project's rows (and General's) arrive on this same socket — the identical
 * hazard `decodeWorkBoardFrame` guards.
 */
export function decodeActivityFrame(data: unknown, scope_key: string): ActivityRow | null {
  let obj: unknown = data;
  if (typeof data === 'string') {
    try {
      obj = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const f = obj as Record<string, unknown>;
  if (f['type'] !== 'activity_event') return null;
  if (f['scope_key'] !== scope_key) return null;
  return parseActivityRow(f['event']);
}

/** Human age string. Coarse and ALWAYS shown — it is the number that answers
 *  "hung or working?", so it is never hidden behind a threshold. */
export function formatAge(ms: number | null): string {
  if (ms === null) return 'never';
  if (ms < 1000) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

/** The one-line verdict the panel headlines. Plain language: the owner opens this
 *  because they already distrust the dot, so the answer is a sentence not a colour. */
export function describeState(state: ActivityState): string {
  switch (state) {
    case 'idle':
      return 'Idle — no turn running';
    case 'working':
      return 'Working';
    case 'wedged':
      return 'Stalled — alive but no activity';
    case 'dead':
      return 'Not responding — no signal at all';
  }
}

/**
 * Merge a live row, keeping the list `seq`-ordered and bounded.
 *
 * Idempotent on `seq` because the snapshot fetch and the live subscription overlap
 * by design (subscribe first, then fetch, so no row is lost in the gap) — which
 * means the same row legitimately arrives twice.
 */
export function mergeActivityRow(
  rows: readonly ActivityRow[],
  row: ActivityRow,
  cap: number,
): ActivityRow[] {
  if (rows.some((r) => r.seq === row.seq)) return rows as ActivityRow[];
  const next = [...rows, row];
  next.sort((a, b) => a.seq - b.seq);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Age of the newest held row against the CLIENT clock, falling back to the
 * snapshot's clock offset.
 *
 * Why not render `snapshot.last_event_age_ms` directly? It is frozen at fetch time.
 * The panel must keep counting up as time passes with no new event — that rising
 * number IS the wedge signal, and a frozen "12s ago" would be the same lie as a
 * frozen dot.
 */
export function liveAge(
  rows: readonly ActivityRow[],
  snapshot: ActivitySnapshot | null,
  now: number,
  opts: { realOnly: boolean },
): number | null {
  const candidates = opts.realOnly ? rows.filter((r) => r.synthetic !== true) : rows;
  const newest = candidates.length > 0 ? candidates[candidates.length - 1] : undefined;
  if (newest !== undefined) {
    // Clamp: server `at` vs device clock can be skewed, and a negative age would
    // read as broken rather than as skew.
    return Math.max(0, now - newest.at);
  }
  if (snapshot === null) return null;
  const base = opts.realOnly ? snapshot.last_real_activity_age_ms : snapshot.last_event_age_ms;
  if (base === null) return null;
  return base + Math.max(0, now - snapshot.now);
}

/* ─── snapshot fetch ─── */

export class ActivityClientError extends GatewayClientError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status);
    this.name = 'ActivityClientError';
  }
}

export type ActivityClientOptions = GatewayHttpClientOptions;

export class AppActivityClient extends GatewayHttpClient {
  protected override readonly guardNetworkErrors = true;

  protected override makeError(code: string, message: string, status: number): GatewayClientError {
    return new ActivityClientError(code, message, status);
  }

  /** Fetch the current snapshot for a scope (`null`/`''` ⇒ General). */
  async snapshot(project_id: string | null): Promise<ActivitySnapshot> {
    const body = await this.req<unknown>(activityPath(project_id));
    const parsed = parseActivitySnapshot(body);
    if (parsed === null) {
      throw new ActivityClientError('bad_snapshot', 'malformed activity snapshot', 502);
    }
    return parsed;
  }
}

/* ─── live subscription ─── */

interface MinimalSocket {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

type SocketFactory = (url: string) => MinimalSocket;

export interface ActivityLiveOptions {
  base_url: string;
  token: string;
  /** Inspector scope key ('general' or a project id). */
  scope_key: string;
  device_id: string;
  onRow: (row: ActivityRow) => void;
  socketFactory?: SocketFactory;
  reconnectMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Build the app-ws URL the same way the chat session does (read-only here). */
function buildWsUrl(base_url: string, token: string, scope_key: string, device_id: string): string {
  const wsBase = httpToWs(base_url).replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('token', token);
  // General has no `project_id` on the socket (it is the base user topic).
  if (scope_key !== GENERAL_ACTIVITY_SCOPE) params.set('project_id', scope_key);
  params.set('platform', 'native');
  params.set('device_id', device_id);
  return `${wsBase}/ws/app/chat?${params.toString()}`;
}

/** Open the live subscription. Returns a handle with an idempotent `stop()`. */
export function startActivityLive(opts: ActivityLiveOptions): { stop: () => void } {
  const factory: SocketFactory =
    opts.socketFactory ??
    ((url) => new (globalThis as { WebSocket: new (u: string) => MinimalSocket }).WebSocket(url));
  const reconnectMs = opts.reconnectMs ?? 3000;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let stopped = false;
  let socket: MinimalSocket | null = null;
  let retryHandle: unknown = null;

  const url = buildWsUrl(opts.base_url, opts.token, opts.scope_key, opts.device_id);

  const scheduleReconnect = (): void => {
    if (stopped || retryHandle !== null) return;
    retryHandle = setTimer(() => {
      retryHandle = null;
      connect();
    }, reconnectMs);
  };

  function connect(): void {
    if (stopped) return;
    let s: MinimalSocket;
    try {
      s = factory(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = s;
    s.onmessage = (ev) => {
      const row = decodeActivityFrame(ev.data, opts.scope_key);
      if (row !== null) opts.onRow(row);
    };
    s.onclose = () => {
      if (socket === s) socket = null;
      scheduleReconnect();
    };
    s.onerror = () => {
      // `onclose` follows an error in practice; let it drive the reconnect.
    };
  }

  connect();

  return {
    stop: () => {
      stopped = true;
      if (retryHandle !== null) {
        clearTimer(retryHandle);
        retryHandle = null;
      }
      if (socket !== null) {
        try {
          socket.close();
        } catch {
          /* best-effort */
        }
        socket = null;
      }
    },
  };
}
