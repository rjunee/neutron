/**
 * @neutronai/app — ws-client `agent_typing` decode + resume-on-reconnect.
 *
 * TASK 1 (typing): the gateway emits an ephemeral
 * `{ v:1, type:'agent_typing', state:'start'|'end' }` frame the moment it picks
 * up a live-agent turn and again when it settles. The client decodes it and
 * emits a typed `agent_typing` event the chat-state provider turns into the
 * server-authoritative "Replying…" affordance.
 *
 * TASK 2 (resume): on every socket (re)open — AFTER `session_ready` — the
 * client sends `{ v:1, type:'resume', after_seq:N }` where `N` is the highest
 * server `seq` it has applied across inbound user_message / agent_message
 * frames. That recovers any reply emitted during a socket blip. Cold clients
 * resume from 0 (full-transcript replay); warm reconnects only pull the gap.
 */
import { describe, expect, it } from 'bun:test';

import { AppWsClient } from '../lib/ws-client';
import type { AppWsOutboundAgentTyping } from '../lib/ws-envelope';

interface FakeWebSocketCtor {
  new (url: string): FakeWebSocket;
  readonly OPEN: 1;
  readonly CLOSED: 3;
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState = 0;
  onopen: ((this: FakeWebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: FakeWebSocket, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: FakeWebSocket, ev: Event) => unknown) | null = null;
  onclose: ((this: FakeWebSocket, ev: CloseEvent) => unknown) | null = null;
  static constructed: FakeWebSocket[] = [];
  /** Every JSON frame the client sent on this socket. */
  sent: unknown[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.constructed.push(this);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }
  deliver(obj: unknown): void {
    this.onmessage?.call(this, { data: JSON.stringify(obj) } as MessageEvent);
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.call(this, {} as Event);
  }
  fireClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.call(this, { code, reason: '', wasClean: false } as unknown as CloseEvent);
  }
}

const FakeCtor = FakeWebSocket as unknown as FakeWebSocketCtor;

function readyFrame(seq?: number): Record<string, unknown> {
  return {
    v: 1,
    type: 'session_ready',
    user_id: 'u',
    project_slug: 'p',
    topic_id: 'app:u',
    ts: 1,
    ...(seq !== undefined ? { last_seen_seq: seq } : {}),
  };
}

function newClient(): AppWsClient {
  FakeWebSocket.constructed = [];
  return new AppWsClient({
    base_url: 'http://gw',
    token: 'good-token',
    websocket_ctor: FakeCtor as unknown as typeof WebSocket,
    min_backoff_ms: 5,
    max_backoff_ms: 10,
  });
}

describe('AppWsClient — agent_typing decode + emit (TASK 1)', () => {
  it('emits a start frame then an end frame as typed agent_typing events', () => {
    const client = newClient();
    const got: AppWsOutboundAgentTyping[] = [];
    client.on('agent_typing', (m) => got.push(m));
    client.connect();
    const ws = FakeWebSocket.constructed[0]!;
    ws.open();
    ws.deliver(readyFrame());
    ws.deliver({ v: 1, type: 'agent_typing', state: 'start', ts: 2 });
    ws.deliver({ v: 1, type: 'agent_typing', state: 'end', ts: 3 });
    expect(got.map((f) => f.state)).toEqual(['start', 'end']);
  });
});

describe('AppWsClient — resume on (re)open (TASK 2)', () => {
  it('sends resume after_seq:0 on the cold session_ready', () => {
    const client = newClient();
    client.connect();
    const ws = FakeWebSocket.constructed[0]!;
    ws.open();
    ws.deliver(readyFrame());
    const resumes = ws.sent.filter(
      (f): f is { type: string; after_seq: number } =>
        typeof f === 'object' && f !== null && (f as { type?: string }).type === 'resume',
    );
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.after_seq).toBe(0);
  });

  it('resumes from the max seq seen across user_message + agent_message frames', async () => {
    const client = newClient();
    client.connect();
    const first = FakeWebSocket.constructed[0]!;
    first.open();
    first.deliver(readyFrame());
    // Apply a couple of seq-stamped messages, then drop the socket.
    first.deliver({ v: 1, type: 'agent_message', body: 'a', message_id: 'm1', ts: 2, seq: 5 });
    first.deliver({
      v: 1,
      type: 'user_message',
      user_id: 'u',
      body: 'b',
      message_id: 'm2',
      ts: 3,
      seq: 7,
    });
    first.fireClose(1011); // benign abnormal close → schedules a reconnect
    // Wait past the backoff window for the reconnect socket.
    await new Promise((r) => setTimeout(r, 30));
    const second = FakeWebSocket.constructed[1];
    if (second === undefined) throw new Error('expected a reconnect socket');
    second.open();
    second.deliver(readyFrame());
    const resume = second.sent.find(
      (f): f is { type: string; after_seq: number } =>
        typeof f === 'object' && f !== null && (f as { type?: string }).type === 'resume',
    );
    expect(resume?.after_seq).toBe(7);
    client.close();
  });

  it('a legacy message with no seq leaves the cursor at 0', () => {
    const client = newClient();
    client.connect();
    const ws = FakeWebSocket.constructed[0]!;
    ws.open();
    ws.deliver(readyFrame());
    ws.deliver({ v: 1, type: 'agent_message', body: 'a', message_id: 'm1', ts: 2 });
    // Re-deliver session_ready (e.g. a duplicate) — the resume cursor is still 0.
    ws.deliver(readyFrame());
    const resumes = ws.sent.filter(
      (f): f is { type: string; after_seq: number } =>
        typeof f === 'object' && f !== null && (f as { type?: string }).type === 'resume',
    );
    expect(resumes.every((r) => r.after_seq === 0)).toBe(true);
  });
});
