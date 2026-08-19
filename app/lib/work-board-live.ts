/**
 * @neutronai/app — WORK BOARD live subscriber (Work Board Phase 1b).
 *
 * A minimal, read-only WebSocket subscription that delivers the parsed board
 * snapshot whenever the gateway fans a `work_board_changed` frame. The board
 * surface has no shared frame bus across screens (the chat `MobileChatSession`
 * owns its own socket scoped to the chat tab), so the Work Board screen opens
 * its OWN lightweight socket to the SAME per-user app-ws topic and listens for
 * just this one frame type — exactly the way the master plan's §6 "apply
 * work_board_changed live" calls for, mirroring the web controller's frame
 * apply.
 *
 * It also optionally taps the `activity_event` frames already flowing over that
 * same per-user topic (`onActivity`), which is what lets the Work surface show a
 * live "Working" strip without opening a second socket — see the option's doc.
 *
 * It NEVER sends anything: the gateway pushes board snapshots to every session
 * on the topic via `InMemoryAppWsSessionRegistry.send`, so a bare connected
 * socket receives them. Reconnect is best-effort with a fixed backoff; on every
 * (re)connect the caller should also re-fetch via the HTTP client so a snapshot
 * missed during a disconnect is filled (the screen does this on mount).
 *
 * The `WebSocket` constructor is injectable so this unit-tests with a fake
 * socket — no real network.
 */

import { activityScopeKey, decodeActivityFrame, type ActivityRow } from './activity-client';
import { parseWorkBoardItems, type WorkBoardItem } from './work-board-client';

/**
 * Map an http(s) origin to its ws(s) form. Inlined (rather than imported from
 * `./config`) so this module — and its unit test — stay free of the
 * `expo-constants` import chain that `config.ts` drags in. Identical behaviour to
 * `config.httpToWs`.
 */
function httpToWs(base_url: string): string {
  if (base_url.startsWith('http://')) return 'ws://' + base_url.slice('http://'.length);
  if (base_url.startsWith('https://')) return 'wss://' + base_url.slice('https://'.length);
  return base_url;
}

/** The minimal WebSocket surface this subscriber uses (RN + DOM compatible). */
export interface MinimalSocket {
  onopen: ((this: unknown, ev: unknown) => void) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => void) | null;
  onerror: ((this: unknown, ev: unknown) => void) | null;
  onclose: ((this: unknown, ev: unknown) => void) | null;
  close(): void;
}

export type SocketFactory = (url: string) => MinimalSocket;

export interface WorkBoardLiveOptions {
  base_url: string;
  token: string;
  project_id: string;
  device_id: string;
  /** Called with the full parsed board on every `work_board_changed` frame. */
  onSnapshot: (items: WorkBoardItem[]) => void;
  /**
   * Called on every (RE)CONNECT of the socket, including the first. The caller
   * MUST use this to re-fetch the board over HTTP.
   *
   * THIS IS THE FIX FOR AN EMPTY BOARD THAT NEVER SELF-HEALS, and the reason it
   * is a required-in-practice callback rather than a nicety. A push-only board
   * loses any item written while the socket was down, permanently — the client
   * never learns, because nothing re-asks. Observed 2026-08-11: the owner's app
   * closed every project session at 19:36:43, the first of five board items was
   * written at 19:36:47 — four seconds later — and his board stayed empty until
   * he manually reloaded the page.
   *
   * This module's header has ALWAYS said the caller "should also re-fetch on
   * every (re)connect", and it was not possible to comply: `connect()` never
   * assigned `s.onopen`, so no connect notification existed to hang a re-fetch
   * on. The doc described a mode the code could not enter, and the screen's
   * mount-time fetch was mistaken for satisfying it — mount is not reconnect.
   */
  onConnect?: () => void;
  /**
   * Called with each `activity_event` row for THIS scope — the signal behind the
   * Work surface's live status strip (`work-board-activity.ts`).
   *
   * Deliberately taps the socket this subscriber ALREADY holds rather than
   * opening a second one. `/ws/app/chat` is a per-USER topic, so the activity
   * rows for every scope are already arriving here; `startActivityLive` would
   * open an identical connection to receive the identical frames. One socket per
   * screen, two frame types.
   *
   * Optional — omit it and this module behaves exactly as it did before (a board
   * subscriber that ignores everything else on the topic).
   */
  onActivity?: (row: ActivityRow) => void;
  /** Injected in tests; defaults to `globalThis.WebSocket`. */
  socketFactory?: SocketFactory;
  /** Reconnect backoff (ms). Default 3000. */
  reconnectMs?: number;
  /** Injected in tests so reconnect doesn't lean on a real timer. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Build the app-ws URL the same way the chat session does (read-only here). */
function buildWsUrl(
  base_url: string,
  token: string,
  project_id: string,
  device_id: string,
): string {
  const wsBase = httpToWs(base_url).replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('token', token);
  if (project_id.length > 0) params.set('project_id', project_id);
  params.set('platform', 'native');
  params.set('device_id', device_id);
  return `${wsBase}/ws/app/chat?${params.toString()}`;
}

/**
 * Decode one inbound socket message. Returns the parsed board items when the
 * frame is a `work_board_changed` for THIS subscriber's board, or null to ignore
 * everything else. A frame's board is its `project_id` (absent/empty ⇒ the
 * General board); it is applied ONLY when that matches `project_id`, so a General
 * or sibling-project board can never overwrite a per-project view.
 */
export function decodeWorkBoardFrame(data: unknown, project_id: string): WorkBoardItem[] | null {
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
  if (f['type'] !== 'work_board_changed') return null;
  // The app-ws topic is per-user, so a sibling project's board (and the untagged
  // General board) can arrive on this socket too; apply only an EXACT board match.
  const rawPid = f['project_id'];
  const framePid = typeof rawPid === 'string' ? rawPid : '';
  if (framePid !== project_id) return null;
  return parseWorkBoardItems(f['items']);
}

/**
 * Open the subscription. Returns a handle with `stop()`. Idempotent stop.
 */
export function startWorkBoardLive(opts: WorkBoardLiveOptions): { stop: () => void } {
  const factory: SocketFactory =
    opts.socketFactory ??
    ((url) => new (globalThis as { WebSocket: new (u: string) => MinimalSocket }).WebSocket(url));
  const reconnectMs = opts.reconnectMs ?? 3000;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let stopped = false;
  let socket: MinimalSocket | null = null;
  let retryHandle: unknown = null;

  const url = buildWsUrl(opts.base_url, opts.token, opts.project_id, opts.device_id);
  // The INSPECTOR's spelling of this scope ('general' or the project id) — a
  // third spelling of the same board, and not the one on the wire for the board
  // frames. See `activity-client.ts` for why the three exist.
  const activityScope = activityScopeKey(opts.project_id);
  const onActivity = opts.onActivity;

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
    // FIRES ON EVERY CONNECT, including reconnects — this is what lets the
    // caller close the gap between "socket was down" and "an item was written".
    // Guarded on `socket === s` so a stale socket that opens after we have moved
    // on cannot trigger a re-fetch attributed to the current connection.
    s.onopen = () => {
      if (socket !== s) return;
      opts.onConnect?.();
    };
    s.onmessage = (ev) => {
      const items = decodeWorkBoardFrame(ev.data, opts.project_id);
      if (items !== null) {
        opts.onSnapshot(items);
        return;
      }
      if (onActivity === undefined) return;
      const row = decodeActivityFrame(ev.data, activityScope);
      if (row !== null) onActivity(row);
    };
    s.onclose = () => {
      if (socket === s) socket = null;
      scheduleReconnect();
    };
    s.onerror = () => {
      // `onclose` follows an error in practice; let it drive the reconnect.
    };
  };

  const scheduleReconnect = (): void => {
    if (stopped || retryHandle !== null) return;
    retryHandle = setTimer(() => {
      retryHandle = null;
      connect();
    }, reconnectMs);
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
