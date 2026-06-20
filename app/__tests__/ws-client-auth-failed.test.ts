/**
 * @neutronai/app — ws-client auth_failed reconnect gate (Argus r1 MINOR).
 *
 * Before this fix, the first 1006 close set state to `auth_failed` and
 * then immediately called `scheduleReconnect`. The reconnect timer
 * fired, openSocket() flipped state to `reconnecting`, and the
 * `auth_failed` banner the UI watches for vanished within milliseconds.
 * On persistent token rot the banner never re-appeared either
 * (`reconnectAttempts === 0` gate in onclose suppresses subsequent
 * auth_failed signals), so the user just saw a perpetual "reconnecting"
 * spinner with no actionable hint.
 *
 * The fix is a single early-return in `scheduleReconnect`:
 *
 *   if (this.state === 'auth_failed') return
 *
 * Once we're in `auth_failed`, no automatic reconnect is scheduled —
 * the caller has to invoke `connect()` after a token refresh.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { AppWsClient, type AppWsClientState } from '../lib/ws-client';

interface FakeWebSocketCtor {
  new (url: string): FakeWebSocket;
  readonly OPEN: 1;
  readonly CLOSED: 3;
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState: number = 0;
  onopen: ((this: FakeWebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: FakeWebSocket, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: FakeWebSocket, ev: Event) => unknown) | null = null;
  onclose: ((this: FakeWebSocket, ev: CloseEvent) => unknown) | null = null;
  static constructed: FakeWebSocket[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.constructed.push(this);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
  send(_: string): void {
    /* unused in these tests */
  }
}

const FakeCtor = FakeWebSocket as unknown as FakeWebSocketCtor;

function fireClose(ws: FakeWebSocket, code: number): void {
  ws.readyState = FakeWebSocket.CLOSED;
  ws.onclose?.call(
    ws,
    {
      code,
      reason: '',
      wasClean: false,
    } as unknown as CloseEvent,
  );
}

describe('AppWsClient — auth_failed reconnect gate (Argus r1 MINOR)', () => {
  beforeEach(() => {
    FakeWebSocket.constructed = [];
  });

  afterEach(() => {
    // Drain any pending timers from setTimeout-based reconnect schedules
    // so they don't bleed into the next test.
  });

  it('does NOT auto-reconnect after a 1006 first-close (auth_failed sticks)', async () => {
    const states: AppWsClientState[] = [];
    const client = new AppWsClient({
      base_url: 'http://gw',
      token: 'rotten-token',
      websocket_ctor: FakeCtor as unknown as typeof WebSocket,
      min_backoff_ms: 5,
      max_backoff_ms: 10,
    });
    client.on('state', (s) => states.push(s));
    client.connect();
    expect(FakeWebSocket.constructed.length).toBe(1);
    const first = FakeWebSocket.constructed[0];
    if (first === undefined) throw new Error('expected first WS');
    // Simulate the production race: open immediately, then a 1006
    // closure from a 401 reject during the upgrade handshake.
    first.readyState = FakeWebSocket.OPEN;
    first.onopen?.call(first, {} as Event);
    fireClose(first, 1006);
    expect(client.getState()).toBe('auth_failed');
    // Wait beyond the backoff window — no new socket should appear.
    await new Promise((r) => setTimeout(r, 40));
    expect(FakeWebSocket.constructed.length).toBe(1);
    expect(client.getState()).toBe('auth_failed');
    // The banner-watching UI MUST see auth_failed in the state stream.
    expect(states).toContain('auth_failed');
    // Critical: the state must NOT have flipped to 'reconnecting'
    // between the auth_failed signal and the test assertion. That
    // bug was the original symptom (banner flashes briefly then
    // disappears).
    const after_auth_failed = states.indexOf('auth_failed');
    const tail = states.slice(after_auth_failed + 1);
    expect(tail.includes('reconnecting')).toBe(false);
    expect(tail.includes('connecting')).toBe(false);
  });

  it('a fresh connect() call after auth_failed opens a new socket', async () => {
    const states: AppWsClientState[] = [];
    const client = new AppWsClient({
      base_url: 'http://gw',
      token: 'rotten-token',
      websocket_ctor: FakeCtor as unknown as typeof WebSocket,
      min_backoff_ms: 5,
      max_backoff_ms: 10,
    });
    client.on('state', (s) => states.push(s));
    client.connect();
    const first = FakeWebSocket.constructed[0];
    if (first === undefined) throw new Error('expected first WS');
    first.readyState = FakeWebSocket.OPEN;
    first.onopen?.call(first, {} as Event);
    fireClose(first, 1006);
    expect(client.getState()).toBe('auth_failed');
    // Caller refreshed the token; force a fresh connect.
    client.connect();
    expect(FakeWebSocket.constructed.length).toBe(2);
  });

  it('non-auth close codes still trigger reconnect', async () => {
    const client = new AppWsClient({
      base_url: 'http://gw',
      token: 'good-token',
      websocket_ctor: FakeCtor as unknown as typeof WebSocket,
      min_backoff_ms: 5,
      max_backoff_ms: 10,
    });
    client.connect();
    const first = FakeWebSocket.constructed[0];
    if (first === undefined) throw new Error('expected first WS');
    first.readyState = FakeWebSocket.OPEN;
    first.onopen?.call(first, {} as Event);
    // Bump reconnectAttempts past 0 first so 1006 doesn't latch
    // auth_failed (the gate only fires on the first 1006 attempt).
    // Use a benign 1011 close — that's a server-side abnormal close,
    // not an auth failure, and should re-arm reconnect.
    fireClose(first, 1011);
    await new Promise((r) => setTimeout(r, 30));
    // A second socket should have been constructed by the
    // reconnect timer.
    expect(FakeWebSocket.constructed.length).toBeGreaterThanOrEqual(2);
    client.close();
  });
});
