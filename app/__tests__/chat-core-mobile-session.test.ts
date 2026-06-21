/**
 * @neutronai/app — MobileChatSession integration tests.
 *
 * Verifies that the RN client's offline send-queue + reconnect-resume
 * actually integrate with the chat-core engine (research doc §7/§8 Phase 2),
 * backed by the REAL on-device store path (`SqliteChatStore` over bun:sqlite)
 * and a fake socket. Covers the four Telegram-grade guarantees:
 *   - optimistic send works offline (queued, rendered, durable);
 *   - the queue auto-flushes on (re)connect and the echo reconciles to acked;
 *   - reconnect resumes gap-free from the LOCAL seq cursor;
 *   - a fresh session cold-opens the transcript + re-drives a stranded send;
 *   - push catch-up gap-fills a live socket.
 */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import type { SocketLike } from '@neutron/chat-core';

import { MobileChatSession } from '../lib/chat-core/mobile-session';
import {
  SqliteChatStore,
  type SqlRow,
  type SqliteExecutor,
  type SqlValue,
} from '../lib/chat-core/sqlite-store';

const TOPIC = 'app:sam';
const URL = 'wss://host/ws/app/chat?token=t&platform=native';

function bunExecutor(db: Database): SqliteExecutor {
  return {
    async execute(sql: string, params: readonly SqlValue[] = []): Promise<{ rows: SqlRow[] }> {
      const bind = params as SqlValue[];
      if (/^\s*select/i.test(sql)) return { rows: db.prepare(sql).all(...bind) as SqlRow[] };
      db.prepare(sql).run(...bind);
      return { rows: [] };
    },
  };
}

/** A controllable fake socket implementing chat-core's SocketLike. */
class FakeSocket implements SocketLike {
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    if (this.closed) throw new Error('socket closed');
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
  /** Test helper: drive the open handshake. */
  open(): void {
    this.onopen?.();
  }
  /** Test helper: deliver a server frame. */
  deliver(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** Parsed view of everything the client sent. */
  sentEnvelopes(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const dbs: Database[] = [];
function freshStore(): Promise<SqliteChatStore> {
  const db = new Database(':memory:');
  dbs.push(db);
  return SqliteChatStore.open(bunExecutor(db));
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

/** Build a session over a store, capturing the sockets it creates. */
function makeSession(store: SqliteChatStore, frames: unknown[] = []) {
  const sockets: FakeSocket[] = [];
  let changes = 0;
  const session = new MobileChatSession({
    url: URL,
    topic_id: TOPIC,
    store,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onChange: () => {
      changes += 1;
    },
    onFrame: (data) => frames.push(data),
    // Fire the reconnect backoff on the next microtask so reconnection is
    // deterministic in tests (no real 500ms+ wait).
    setTimeoutFn: (fn: () => void) => {
      queueMicrotask(fn);
      return 0;
    },
    clearTimeoutFn: () => {},
    generateId: (() => {
      let n = 0;
      return () => `cmid-${++n}`;
    })(),
    now: (() => {
      let t = 1000;
      return () => (t += 1);
    })(),
  });
  return { session, sockets, changeCount: () => changes };
}

describe('MobileChatSession — offline send-queue + resume', () => {
  it('optimistically persists a send while the socket is down', async () => {
    const store = await freshStore();
    const { session } = makeSession(store);
    session.start(); // socket created but not opened → offline

    await session.send('hello while offline');

    const msgs = await session.messages();
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.body).toBe('hello while offline');
    expect(msgs[0]?.status).toBe('queued');
    expect(await session.pendingCount()).toBe(1);
    // It is durable — a brand-new store over the same DB still has it.
  });

  it('flushes the queue on connect and reconciles the echo to acked', async () => {
    const store = await freshStore();
    const { session, sockets } = makeSession(store);
    session.start();
    await session.send('deliver me', { client_msg_id: 'fixed-1' });

    // Connect: open + server announces the session.
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 1 });
    await tick();

    const envs = sockets[0]!.sentEnvelopes();
    // First a resume from cursor 0, then the queued user_message.
    expect(envs[0]).toMatchObject({ type: 'resume', after_seq: 0 });
    const userSend = envs.find((e) => e['type'] === 'user_message');
    expect(userSend).toMatchObject({ body: 'deliver me', client_msg_id: 'fixed-1' });

    // Server echo with seq + message_id reconciles the optimistic bubble.
    sockets[0]!.deliver({
      v: 1,
      type: 'user_message',
      message_id: 'srv-1',
      client_msg_id: 'fixed-1',
      seq: 1,
      body: 'deliver me',
      ts: 2,
    });
    await tick();

    const msgs = await session.messages();
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.status).toBe('acked');
    expect(msgs[0]?.seq).toBe(1);
    expect(await session.pendingCount()).toBe(0);
  });

  it('resumes gap-free from the LOCAL seq cursor on reconnect', async () => {
    const store = await freshStore();
    const { session, sockets } = makeSession(store);
    session.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 1 });
    await tick();

    // Agent messages arrive carrying seq 1 then 2.
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'a1', seq: 1, body: 'one', ts: 2 });
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'a2', seq: 2, body: 'two', ts: 3 });
    await tick();
    expect((await session.messages()).map((m) => m.body)).toEqual(['one', 'two']);

    // Drop + reconnect: the resume must ask for everything AFTER seq 2.
    sockets[0]!.close();
    await tick();
    const reconnected = sockets[sockets.length - 1]!;
    reconnected.open();
    reconnected.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 4 });
    await tick();

    const resume = reconnected.sentEnvelopes().find((e) => e['type'] === 'resume');
    expect(resume).toMatchObject({ after_seq: 2 });

    // The replay of seq 3 applies idempotently + in order.
    reconnected.deliver({ v: 1, type: 'agent_message', message_id: 'a3', seq: 3, body: 'three', ts: 5 });
    // A duplicate re-delivery of seq 2 must NOT duplicate the row.
    reconnected.deliver({ v: 1, type: 'agent_message', message_id: 'a2', seq: 2, body: 'two', ts: 3 });
    await tick();
    expect((await session.messages()).map((m) => m.body)).toEqual(['one', 'two', 'three']);
  });

  it('cold-opens the transcript + re-drives a stranded send in a fresh session', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    const store1 = await SqliteChatStore.open(bunExecutor(db));

    // Session A sends while offline, then dies before ever connecting.
    const a = makeSession(store1);
    a.session.start();
    await a.session.send('survive restart', { client_msg_id: 'persist-1' });

    // Session B: brand-new session over the SAME db (app relaunch).
    const store2 = await SqliteChatStore.open(bunExecutor(db));
    const b = makeSession(store2);
    // Cold-open already shows the queued message before any network.
    expect((await b.session.messages()).map((m) => m.body)).toEqual(['survive restart']);
    expect(await b.session.pendingCount()).toBe(1);

    b.session.start();
    b.sockets[0]!.open();
    b.sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 1 });
    await tick();

    // The send stranded across the restart is re-driven on reconnect.
    const userSend = b.sockets[0]!.sentEnvelopes().find((e) => e['type'] === 'user_message');
    expect(userSend).toMatchObject({ body: 'survive restart', client_msg_id: 'persist-1' });
  });

  it('catchUp() gap-fills a live socket (foreground push catch-up)', async () => {
    const store = await freshStore();
    const { session, sockets } = makeSession(store);
    session.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 1 });
    await tick();
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'a1', seq: 5, body: 'hi', ts: 2 });
    await tick();
    sockets[0]!.sent.length = 0; // clear prior sends

    await session.catchUp();
    await tick();
    const resume = sockets[0]!.sentEnvelopes().find((e) => e['type'] === 'resume');
    expect(resume).toMatchObject({ after_seq: 5 });
  });

  it('catchUp() is a safe no-op when the socket is not open (foreground push, offline)', async () => {
    // The foreground push listener calls catchUp() on every received
    // notification; when the socket isn't open it must not throw or send a
    // resume on a dead socket — it wakes the socket and the resume rides the
    // next session_ready instead.
    const store = await freshStore();
    const { session, sockets } = makeSession(store);
    session.start(); // socket created but never opened → offline

    await session.catchUp();
    await tick();

    const resumes = (sockets[0]?.sentEnvelopes() ?? []).filter((e) => e['type'] === 'resume');
    expect(resumes.length).toBe(0);

    // And once it DOES open, the resume is sent on session_ready — proving the
    // deferred catch-up actually gap-fills rather than being lost.
    sockets[sockets.length - 1]!.open();
    sockets[sockets.length - 1]!.deliver({
      v: 1,
      type: 'session_ready',
      user_id: 'sam',
      topic_id: TOPIC,
      ts: 1,
    });
    await tick();
    const afterOpen = sockets[sockets.length - 1]!
      .sentEnvelopes()
      .find((e) => e['type'] === 'resume');
    expect(afterOpen).toMatchObject({ type: 'resume', after_seq: 0 });
  });

  it('hands every raw inbound frame to onFrame (streaming/typing seam)', async () => {
    const store = await freshStore();
    const frames: unknown[] = [];
    const sockets: FakeSocket[] = [];
    const session = new MobileChatSession({
      url: URL,
      topic_id: TOPIC,
      store,
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      onFrame: (d) => frames.push(d),
    });
    session.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 1 });
    sockets[0]!.deliver({ v: 1, type: 'agent_message_partial', message_id: 'p1', body_delta: 'typ', ts: 2 });
    await tick();
    const types = frames.map((f) => (f as { type?: string }).type);
    expect(types).toContain('session_ready');
    expect(types).toContain('agent_message_partial'); // partials reach the UI even though they aren't persisted
  });
});

/** Let the session's async apply/flush microtasks settle. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
