/**
 * @neutronai/app — ws-client `chat_command_result` decode + emit (M1 E2E r3).
 *
 * THE BUG: the app-ws surface answers a matched slash command (`/note`,
 * `/remind`, `/cal`, `/skills`, …) with exactly ONE `chat_command_result`
 * frame and SKIPS the agent dispatch — so no `agent_message` follows. The
 * native client's frame switch had no case for it, so the frame hit the
 * forward-compat `default: drop quietly` branch and the command's
 * confirmation/output was silently lost on the native surface.
 *
 * THE FIX: decode the frame and emit a typed `chat_command_result` event the
 * chat-state provider renders as a system bubble.
 */
import { describe, expect, it } from 'bun:test';

import { AppWsClient } from '../lib/ws-client';
import type { AppWsOutboundChatCommandResult } from '../lib/ws-envelope';

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
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.constructed.push(this);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
  send(_: string): void {
    /* unused */
  }
  deliver(obj: unknown): void {
    this.onmessage?.call(this, { data: JSON.stringify(obj) } as MessageEvent);
  }
}

const FakeCtor = FakeWebSocket as unknown as FakeWebSocketCtor;

function connectedClient(): { client: AppWsClient; ws: FakeWebSocket } {
  FakeWebSocket.constructed = [];
  const client = new AppWsClient({
    base_url: 'http://gw',
    token: 'good-token',
    websocket_ctor: FakeCtor as unknown as typeof WebSocket,
  });
  client.connect();
  const ws = FakeWebSocket.constructed[0];
  if (ws === undefined) throw new Error('expected a socket');
  ws.readyState = FakeWebSocket.OPEN;
  ws.onopen?.call(ws, {} as Event);
  return { client, ws };
}

describe('AppWsClient — chat_command_result decode + emit', () => {
  it('emits chat_command_result with the result text (no agent_message follows)', () => {
    const { client, ws } = connectedClient();
    const got: AppWsOutboundChatCommandResult[] = [];
    client.on('chat_command_result', (m) => got.push(m));
    ws.deliver({
      v: 1,
      type: 'chat_command_result',
      channel_topic_id: 'app:sam',
      text: '📝 Saved note: buy milk',
      ts: 5,
      client_msg_id: 'cmid-1',
    });
    expect(got.length).toBe(1);
    expect(got[0]?.text).toBe('📝 Saved note: buy milk');
    expect(got[0]?.client_msg_id).toBe('cmid-1');
  });

  it('carries the error payload through when the command failed', () => {
    const { client, ws } = connectedClient();
    const got: AppWsOutboundChatCommandResult[] = [];
    client.on('chat_command_result', (m) => got.push(m));
    ws.deliver({
      v: 1,
      type: 'chat_command_result',
      channel_topic_id: 'app:sam',
      text: '',
      error: { code: 'unsupported_recurrence', message: 'Recurring reminders are not supported in v1.' },
      ts: 6,
    });
    expect(got.length).toBe(1);
    expect(got[0]?.error?.message).toBe('Recurring reminders are not supported in v1.');
  });
});
