/**
 * @neutronai/app — project RAIL live subscriber (M1 UX REDESIGN PR-6).
 *
 * A minimal, read-only WebSocket subscription that delivers the fresh canonical
 * project list whenever the gateway fans a `projects_changed` frame (PR-1
 * #180). The mobile rail (`ProjectRail`) seeds its project SET from the HTTP
 * list (`fetchProjects`) and overlays the PR-1 rail state — `activity` +
 * `live_runs` — from this frame, exactly the way the web rail
 * (`landing/chat-react/controller.ts`) consumes the same frame.
 *
 * It NEVER sends anything: the gateway pushes the list to every session on the
 * per-user app-ws topic via the session registry, so a bare connected socket
 * receives them. Reconnect is best-effort with a fixed backoff. The frame is the
 * full canonical list (not a delta), so every apply is idempotent + order-
 * independent — mirroring `work-board-live.ts`.
 *
 * The `WebSocket` constructor is injectable so this unit-tests with a fake
 * socket — no real network. Structurally a sibling of `work-board-live.ts`.
 */

import type { MinimalSocket, SocketFactory } from './work-board-live';
import type { ProjectActivity } from './project-rail-view';

/**
 * One project's rail state off a `projects_changed` frame. The rail overlays
 * `activity` + `live_runs` onto its HTTP-fetched SET by `id`; `label` / `emoji`
 * / `unread` are carried through for parity with the frame (the rail may prefer
 * the fresher frame values when present).
 */
export interface RailProject {
  id: string;
  label: string;
  emoji: string;
  unread: number;
  activity: ProjectActivity;
  live_runs: number;
}

/**
 * Map an http(s) origin to its ws(s) form. Inlined (rather than imported from
 * `./config`) so this module — and its unit test — stay free of the
 * `expo-constants` import chain that `config.ts` drags in. Identical behaviour
 * to `config.httpToWs` / `work-board-live.ts`.
 */
function httpToWs(base_url: string): string {
  if (base_url.startsWith('http://')) return 'ws://' + base_url.slice('http://'.length);
  if (base_url.startsWith('https://')) return 'wss://' + base_url.slice('https://'.length);
  return base_url;
}

export interface ProjectsRailLiveOptions {
  base_url: string;
  token: string;
  device_id: string;
  /** Called with the full parsed list on every `projects_changed` frame. */
  onSnapshot: (projects: RailProject[]) => void;
  /** Injected in tests; defaults to `globalThis.WebSocket`. */
  socketFactory?: SocketFactory;
  /** Reconnect backoff (ms). Default 3000. */
  reconnectMs?: number;
  /** Injected in tests so reconnect doesn't lean on a real timer. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Build the app-ws URL the same way the chat session does (read-only here). No
 * `project_id` — the `projects_changed` frame is a per-USER broadcast, so we
 * attach to the base per-user topic (General) and receive it there.
 */
function buildWsUrl(base_url: string, token: string, device_id: string): string {
  const wsBase = httpToWs(base_url).replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('token', token);
  params.set('platform', 'native');
  params.set('device_id', device_id);
  return `${wsBase}/ws/app/chat?${params.toString()}`;
}

/** Coerce a wire activity value to the enum, defaulting to `idle`. */
function coerceActivity(raw: unknown): ProjectActivity {
  return raw === 'working' || raw === 'attention' ? raw : 'idle';
}

/**
 * Decode one inbound socket message. Returns the parsed rail projects when the
 * frame is a `projects_changed`, or null to ignore everything else (chat
 * frames, work-board frames, typing, receipts …). Tolerant of missing fields —
 * an older gateway that omits a rail field yields the safe default (idle / 0).
 */
export function decodeProjectsChangedFrame(data: unknown): RailProject[] | null {
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
  if (f['type'] !== 'projects_changed') return null;
  const raw = f['projects'];
  if (!Array.isArray(raw)) return null;
  const out: RailProject[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const id = typeof r['id'] === 'string' ? r['id'] : '';
    if (id.length === 0) continue;
    const liveRaw = r['live_runs'];
    const live_runs =
      typeof liveRaw === 'number' && Number.isFinite(liveRaw) ? Math.max(0, Math.trunc(liveRaw)) : 0;
    const unreadRaw = r['unread'];
    const unread =
      typeof unreadRaw === 'number' && Number.isFinite(unreadRaw)
        ? Math.max(0, Math.trunc(unreadRaw))
        : 0;
    out.push({
      id,
      label: typeof r['label'] === 'string' ? r['label'] : '',
      emoji: typeof r['emoji'] === 'string' ? r['emoji'] : '',
      unread,
      activity: coerceActivity(r['activity']),
      live_runs,
    });
  }
  return out;
}

/** Open the subscription. Returns a handle with `stop()`. Idempotent stop. */
export function startProjectsRailLive(opts: ProjectsRailLiveOptions): { stop: () => void } {
  const factory: SocketFactory =
    opts.socketFactory ??
    ((url) => new (globalThis as { WebSocket: new (u: string) => MinimalSocket }).WebSocket(url));
  const reconnectMs = opts.reconnectMs ?? 3000;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let stopped = false;
  let socket: MinimalSocket | null = null;
  let retryHandle: unknown = null;

  const url = buildWsUrl(opts.base_url, opts.token, opts.device_id);

  const scheduleReconnect = (): void => {
    if (stopped || retryHandle !== null) return;
    retryHandle = setTimer(() => {
      retryHandle = null;
      connect();
    }, reconnectMs);
  };

  const connect = (): void => {
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
      const projects = decodeProjectsChangedFrame(ev.data);
      if (projects !== null) opts.onSnapshot(projects);
    };
    s.onclose = () => {
      if (socket === s) socket = null;
      scheduleReconnect();
    };
    s.onerror = () => {
      // `onclose` follows an error in practice; let it drive the reconnect.
    };
  };

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
