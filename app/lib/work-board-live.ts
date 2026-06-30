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
 * It NEVER sends anything: the gateway pushes board snapshots to every session
 * on the topic via `InMemoryAppWsSessionRegistry.send`, so a bare connected
 * socket receives them. Reconnect is best-effort with a fixed backoff; on every
 * (re)connect the caller should also re-fetch via the HTTP client so a snapshot
 * missed during a disconnect is filled (the screen does this on mount).
 *
 * The `WebSocket` constructor is injectable so this unit-tests with a fake
 * socket — no real network.
 */

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
 * frame is a `work_board_changed` for THIS project (or one carrying no
 * project_id), or null to ignore everything else.
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
  // The app-ws topic is per-user, so a sibling project's board can arrive on
  // this socket too; drop it when the frame names a different project.
  const framePid = f['project_id'];
  if (typeof framePid === 'string' && framePid.length > 0 && framePid !== project_id) return null;
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
      const items = decodeWorkBoardFrame(ev.data, opts.project_id);
      if (items !== null) opts.onSnapshot(items);
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
