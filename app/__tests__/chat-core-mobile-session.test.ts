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

  it('applies a reaction_update onto a stored message and sends a reaction frame on react() (Track B Phase 4)', async () => {
    const store = await freshStore();
    const { session, sockets } = makeSession(store);
    session.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 1 });
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'a1', seq: 1, body: 'hi', ts: 2 });
    await tick();

    // A reaction_update lands on the stored message.
    sockets[0]!.deliver({
      v: 1,
      type: 'reaction_update',
      message_id: 'a1',
      seq: 1,
      rev: 1,
      reactions: [{ emoji: '👍', device_id: 'devB' }],
      ts: 3,
    });
    await tick();
    let msgs = await session.messages();
    expect(msgs.find((m) => m.message_id === 'a1')?.reactions).toEqual([
      { emoji: '👍', device_id: 'devB' },
    ]);

    // react() puts a reaction frame on the wire.
    session.react('a1', '🎉', 'add');
    expect(sockets[0]!.sentEnvelopes()).toContainEqual({
      v: 1,
      type: 'reaction',
      message_id: 'a1',
      emoji: '🎉',
      action: 'add',
    });

    // A higher-rev empty update clears the reactions (removal).
    sockets[0]!.deliver({ v: 1, type: 'reaction_update', message_id: 'a1', seq: 1, rev: 2, reactions: [], ts: 4 });
    await tick();
    msgs = await session.messages();
    expect(msgs.find((m) => m.message_id === 'a1')?.reactions ?? null).toBeNull();
  });

  it('applies an edit_update + delete tombstone and sends edit/delete frames (Track B Phase 4)', async () => {
    const store = await freshStore();
    const { session, sockets } = makeSession(store);
    session.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 1 });
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'a1', seq: 1, body: 'helo', ts: 2 });
    await tick();

    // An edit_update rewrites the stored message body.
    sockets[0]!.deliver({
      v: 1,
      type: 'edit_update',
      message_id: 'a1',
      seq: 1,
      rev: 1,
      body: 'hello',
      deleted: false,
      edited_at: 50,
      ts: 3,
    });
    await tick();
    let m = (await session.messages()).find((x) => x.message_id === 'a1');
    expect(m?.body).toBe('hello');
    expect(m?.edited_at).toBe(50);

    // editMessage()/deleteMessage() put frames on the wire.
    session.editMessage('a1', 'hello there');
    expect(sockets[0]!.sentEnvelopes()).toContainEqual({ v: 1, type: 'edit', message_id: 'a1', action: 'edit', body: 'hello there' })
    session.deleteMessage('a1');
    expect(sockets[0]!.sentEnvelopes()).toContainEqual({ v: 1, type: 'edit', message_id: 'a1', action: 'delete' })

    // A higher-rev delete tombstones the message (empty body, deleted).
    sockets[0]!.deliver({ v: 1, type: 'edit_update', message_id: 'a1', seq: 1, rev: 2, body: '', deleted: true, edited_at: 60, ts: 4 });
    await tick();
    m = (await session.messages()).find((x) => x.message_id === 'a1');
    expect(m?.deleted).toBe(true);
    expect(m?.body).toBe('');
  });
});

/** Let the session's async apply/flush microtasks settle. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('MobileChatSession — slash commands + button choices (parity with the deleted surface)', () => {
  it('renders a chat_command_result as an agent message tagged with the view project', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    const store = await SqliteChatStore.open(bunExecutor(db));
    const sockets: FakeSocket[] = [];
    const session = new MobileChatSession({
      url: URL,
      topic_id: TOPIC,
      project_id: 'proj-7',
      store,
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    session.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', project_slug: 'p', topic_id: TOPIC, ts: 1 });
    await tick();
    sockets[0]!.deliver({
      v: 1,
      type: 'chat_command_result',
      channel_topic_id: TOPIC,
      text: '✅ Reminder set for 9am.',
      ts: 42,
      client_msg_id: 'cmd-abc',
    });
    await tick();
    const m = (await session.messages()).find((x) => x.message_id === 'cmd:cmd-abc');
    expect(m).toBeDefined();
    expect(m?.role).toBe('agent');
    expect(m?.body).toBe('✅ Reminder set for 9am.');
    expect(m?.project_id).toBe('proj-7');
  });

  it('falls back to the error message, then a generic line, for an empty command result', async () => {
    const store = await freshStore();
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
    });
    session.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'chat_command_result', channel_topic_id: TOPIC, ts: 1, error: { message: 'nope' } });
    sockets[0]!.deliver({ v: 1, type: 'chat_command_result', channel_topic_id: TOPIC, ts: 2 });
    await tick();
    const bodies = (await session.messages()).map((x) => x.body);
    expect(bodies).toContain('nope');
    expect(bodies).toContain('Command completed.');
  });

  it('chooseOption puts a button_choice frame on the wire', async () => {
    const store = await freshStore();
    const { session, sockets } = makeSession(store);
    session.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', project_slug: 'p', topic_id: TOPIC, ts: 1 });
    await tick();
    expect(session.chooseOption('prompt-1', 'claude')).toBe(true);
    expect(sockets[0]!.sentEnvelopes()).toContainEqual({
      v: 1,
      type: 'button_choice',
      prompt_id: 'prompt-1',
      choice_value: 'claude',
    });
  });
});

describe('MobileChatSession — rich agent metadata survives the inbound path (Codex P1 regression)', () => {
  it('persists options / image_urls / citations / doc_refs / deep_link from a live agent_message', async () => {
    const store = await freshStore();
    const { session, sockets } = makeSession(store);
    session.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', project_slug: 'p', topic_id: TOPIC, ts: 1 });
    await tick();
    sockets[0]!.deliver({
      v: 1,
      type: 'agent_message',
      message_id: 'rich-1',
      seq: 5,
      body: 'choose + look',
      ts: 10,
      options: [{ label: 'Yes', body: 'Yes', value: 'yes' }],
      prompt_id: 'p-9',
      kind: 'buttons',
      upload_affordance: { source: 'claude' },
      image_urls: ['https://x/i.png'],
      citations: [{ title: 'Src', url: 'https://x/src' }],
      doc_refs: [{ label: 'Doc', url: 'neutron://docs/d', project_id: 'pr', path: 'd.md' }],
      deep_link: 'neutron://docs/d',
    });
    await tick();
    const m = (await session.messages()).find((x) => x.message_id === 'rich-1');
    expect(m).toBeDefined();
    expect(m?.options?.[0]?.value).toBe('yes');
    expect(m?.prompt_id).toBe('p-9');
    expect(m?.upload_affordance).toEqual({ source: 'claude' });
    expect(m?.image_urls).toEqual(['https://x/i.png']);
    expect(m?.citations).toEqual([{ title: 'Src', url: 'https://x/src' }]);
    expect(m?.doc_refs?.[0]?.path).toBe('d.md');
    expect(m?.deep_link).toBe('neutron://docs/d');
  });
});

describe('MobileChatSession — stale-store reset on server reinstall (M1)', () => {
  /** Seed the on-device store with an old transcript (cursor at seq 40). */
  async function seeded(): Promise<SqliteChatStore> {
    const store = await freshStore();
    await store.upsert({
      topic_id: TOPIC, client_msg_id: '', message_id: 'old1', seq: 39, role: 'agent',
      body: 'stale a', project_id: null, attachments: null, created_at: 1, status: 'acked',
    });
    await store.upsert({
      topic_id: TOPIC, client_msg_id: '', message_id: 'old2', seq: 40, role: 'agent',
      body: 'stale b', project_id: null, attachments: null, created_at: 2, status: 'acked',
    });
    return store;
  }

  it('clears the on-device transcript + resumes from 0 when the fresh server seq regressed', async () => {
    const store = await seeded();
    const { session, sockets } = makeSession(store);
    session.start();
    sockets[0]!.open();
    // Reinstalled server announces a LOWER high-water seq.
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 1, last_seen_seq: 2 });
    await tick();
    expect(await store.lastSeenSeq(TOPIC)).toBe(0);
    const resume = sockets[0]!.sentEnvelopes().filter((e) => e['type'] === 'resume').at(-1);
    expect(resume).toMatchObject({ type: 'resume', after_seq: 0 });
    // The fresh transcript then replays cleanly with no stale rows.
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'new1', seq: 1, body: 'fresh welcome', ts: 3 });
    await tick();
    const bodies = (await session.messages()).map((m) => m.body);
    expect(bodies).toEqual(['fresh welcome']);
  });

  it('does NOT clear on a normal reconnect (server seq >= local cursor)', async () => {
    const store = await seeded();
    const { session, sockets } = makeSession(store);
    session.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 1, last_seen_seq: 40 });
    await tick();
    expect(await store.lastSeenSeq(TOPIC)).toBe(40);
    expect((await session.messages()).length).toBe(2);
    const resume = sockets[0]!.sentEnvelopes().filter((e) => e['type'] === 'resume').at(-1);
    expect(resume).toMatchObject({ type: 'resume', after_seq: 40 });
  });

  it('does NOT clear when the server omits last_seen_seq (absent → never a wipe)', async () => {
    const store = await seeded();
    const { session, sockets } = makeSession(store);
    session.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 1 });
    await tick();
    expect(await store.lastSeenSeq(TOPIC)).toBe(40);
    expect((await session.messages()).length).toBe(2);
  });
});
