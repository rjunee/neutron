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

import type { SocketLike } from '@neutronai/chat-core';

import { appWsProjectTopicId, appWsTopicId } from '@neutronai/wire-types/topic-id.ts';
import { parseDevTokenUserId } from '../lib/auth-helpers';
import { MobileChatSession } from '../lib/chat-core/mobile-session';
import {
  SqliteChatStore,
  contiguousFloorSql,
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
  /**
   * FORWARD resume frames — `after_seq` with no `before_seq`. `resume` has a
   * second form that asks BACKWARDS for the history below a seq, and a session
   * whose oldest applied seq is above 1 sends one of those per catch-up; the
   * assertions that say "resumed from N" mean the forward cursor.
   */
  forwardResumes(): Record<string, unknown>[] {
    return this.sentEnvelopes().filter(
      (e) => e['type'] === 'resume' && e['before_seq'] === undefined,
    );
  }
  /** BACKWARDS resume frames — the history walk (`before_seq` present). */
  backwardsResumes(): Record<string, unknown>[] {
    return this.sentEnvelopes().filter(
      (e) => e['type'] === 'resume' && e['before_seq'] !== undefined,
    );
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
    // The injected timer below fires on the next microtask (so the reconnect
    // backoff is deterministic without a real wait); a real-cadence heartbeat
    // would therefore mis-fire immediately on open, so disable it here. The
    // heartbeat has its own dedicated coverage in chat-core/__tests__/resilience.test.ts.
    heartbeatIntervalMs: 0,
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

  it('clears the on-device acked transcript (keeping queued sends) + resumes from 0 on regression', async () => {
    const store = await seeded();
    const { session, sockets } = makeSession(store);
    session.start();
    // A user message queued offline before the reinstall is detected.
    await session.send('keep me', { client_msg_id: 'cmid-keep' });
    sockets[0]!.open();
    // Reinstalled server announces a LOWER high-water seq.
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 1, last_seen_seq: 2 });
    await tick();
    expect(await store.lastSeenSeq(TOPIC)).toBe(0);
    const resume = sockets[0]!.forwardResumes().at(-1);
    expect(resume).toMatchObject({ type: 'resume', after_seq: 0 });
    // Stale acked rows gone, but the queued send survived the on-device wipe …
    expect((await session.messages()).map((m) => m.body)).toEqual(['keep me']);
    // … and was re-driven to the fresh server (idempotent on client_msg_id).
    expect(sockets[0]!.sentEnvelopes().filter((e) => e['type'] === 'user_message').map((e) => e['body'])).toContain('keep me');
    // The fresh transcript then replays cleanly with no stale rows.
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'new1', seq: 1, body: 'fresh welcome', ts: 3 });
    await tick();
    const bodies = (await session.messages()).map((m) => m.body);
    expect(bodies).toContain('fresh welcome');
    expect(bodies.some((b) => b === 'stale a' || b === 'stale b')).toBe(false);
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
    const resume = sockets[0]!.forwardResumes().at(-1);
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

/** A virtual clock: single-shot timers fired by `advance`, re-queried each step
 *  so rescheduled timers (the ws heartbeat) fire correctly. */
class VirtualClock {
  now = 0;
  private nextId = 1;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  readonly set = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.push({ id, at: this.now + ms, fn });
    return id;
  };
  readonly clear = (h: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== h);
  };
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.now = due.at;
      due.fn();
    }
    this.now = target;
  }
}

describe('MobileChatSession — W5 GAP-4 ack-timeout (parity with WebChatSession)', () => {
  it('flips a never-acked send sent → failed, then re-drives it on reconnect (never a stuck clock)', async () => {
    const store = await freshStore();
    const clock = new VirtualClock();
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
      generateId: () => 'ack-x',
      now: (() => {
        let t = 1000;
        return () => (t += 1);
      })(),
      ackTimeoutMs: 15_000,
      heartbeatIntervalMs: 0, // isolate GAP-4 from the GAP-1 heartbeat
      setTimeoutFn: clock.set,
      clearTimeoutFn: clock.clear,
    });

    session.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 1 });
    await tick();

    // Send while open → delivered, marked `sent` (the 🕓 clock).
    await session.send('important', { client_msg_id: 'ack-x' });
    await tick();
    expect((await session.messages())[0]?.status).toBe('sent');

    // The echo never arrives → after the ack-timeout the clock is NOT stuck:
    // it flips to `failed` so the render layer shows a retry affordance.
    clock.advance(15_000);
    await tick();
    expect((await session.messages())[0]?.status).toBe('failed');

    // Reconnect: a fresh socket opens and the failed send is re-driven idempotently.
    sockets[0]!.close();
    clock.advance(1_000); // fire the reconnect backoff → new socket
    await tick();
    const s2 = sockets.at(-1)!;
    s2.open();
    s2.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 2 });
    await tick();
    const resent = s2.sentEnvelopes().filter((e) => e['type'] === 'user_message');
    expect(resent.length).toBe(1); // exactly one resend
    expect(resent[0]).toMatchObject({ body: 'important', client_msg_id: 'ack-x' });

    // The echo finally lands → reconciles to a single acked row (no dup, no stuck clock).
    s2.deliver({
      v: 1,
      type: 'user_message',
      message_id: 'srv-1',
      client_msg_id: 'ack-x',
      seq: 7,
      body: 'important',
      ts: 3,
    });
    await tick();
    const msgs = await session.messages();
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.status).toBe('acked');
    expect(msgs[0]?.seq).toBe(7);
    session.stop();
  });
});

describe('MobileChatSession — W5 GAP-4 per-message retry (FIX 11 parity)', () => {
  function failedRow(client_msg_id: string, body: string, created_at: number) {
    return {
      topic_id: TOPIC,
      client_msg_id,
      message_id: null,
      seq: null,
      role: 'user' as const,
      body,
      project_id: null,
      attachments: null,
      created_at,
      status: 'failed' as const,
    };
  }

  it('retry(idA) re-drives ONLY message A, never its siblings', async () => {
    const store = await freshStore();
    await store.upsert(failedRow('A', 'alpha', 1));
    await store.upsert(failedRow('B', 'beta', 2));
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
      // Open WITHOUT a session_ready so the resume path (re-drives ALL unacked)
      // can't confound the per-message retry; no ack timers / heartbeat noise.
      heartbeatIntervalMs: 0,
      ackTimeoutMs: 0,
    });
    session.start();
    sockets[0]!.open();
    await tick();
    expect(sockets[0]!.sentEnvelopes().filter((e) => e['type'] === 'user_message').length).toBe(0);

    await session.retry('A');
    await tick();
    const sent = sockets[0]!.sentEnvelopes().filter((e) => e['type'] === 'user_message');
    expect(sent.map((e) => e['body'])).toEqual(['alpha']);
    expect(sent[0]?.['client_msg_id']).toBe('A');
    expect((await session.messages()).find((m) => m.client_msg_id === 'B')?.status).toBe('failed');
    session.stop();
  });
});

/**
 * ISSUES #398 mechanism test — ROTATION ORPHANING.
 *
 * The client derives its storage key as `app:${user.id}`
 * (`use-mobile-chat.ts:131`), and for an OPAQUE owner bearer `user.id` is the
 * TOKEN ITSELF (confirmed by executing `parseDevTokenUserId` against the live
 * bearer). The local store's primary key is `(topic_id, identity)`
 * (`sqlite-store.ts:100`).
 *
 * So the key is a function of the CREDENTIAL. This asks the question that
 * follows: when the bearer changes — a rotation, or a re-paste after the #395
 * id-derivation change — does previously hydrated history become unreachable
 * on the SAME device and the SAME store?
 *
 * This is the difference between "history never arrives" and "history arrived
 * and is now stranded under a key nothing reads". Those need different fixes.
 */
/** Same as `makeSession` but with an explicit topic, to model a rotated bearer. */
function sessionOnTopic(store: SqliteChatStore, topic_id: string) {
  const sockets: FakeSocket[] = [];
  const session = new MobileChatSession({
    url: URL,
    topic_id,
    store,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onChange: () => {},
    onFrame: () => {},
    heartbeatIntervalMs: 0,
    setTimeoutFn: (fn: () => void) => {
      queueMicrotask(fn);
      return 0;
    },
    clearTimeoutFn: () => {},
  });
  return { session, sockets };
}

describe('MobileChatSession — history survives a changed user.id? (#398)', () => {
  it('two DIFFERENT opaque bearers derive the SAME topic, so history survives rotation', async () => {
    // The real derivation — this is the property the fix guarantees. Before it,
    // an opaque bearer returned ITSELF, so these two produced different keys.
    const bearerA = 'nbt_9k2rFpQ7Kw5eem6BG4I4iSTtezt6ikTY';
    const bearerB = 'nbt_TOTALLY_DIFFERENT_ROTATED_VALUE';
    const topicA = `app:${parseDevTokenUserId(bearerA)}`;
    const topicB = `app:${parseDevTokenUserId(bearerB)}`;

    expect(topicA).toBe(topicB);
    // And it agrees with what the gateway reports in `session_ready`.
    expect(topicA).toBe('app:owner');

    // End-to-end over the real store: hydrate under bearer A, then re-open a
    // session as if the bearer had rotated. The history must still be there.
    const store = await freshStore();
    const a = sessionOnTopic(store, topicA);
    a.session.start();
    a.sockets[0]!.open();
    a.sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'owner', topic_id: 'app:owner', ts: 1 });
    await tick();
    a.sockets[0]!.deliver({
      v: 1, type: 'agent_message', message_id: 'srv-1', seq: 1, body: 'history line one', ts: 10,
    });
    await tick();
    expect((await a.session.messages()).map((m) => m.body)).toEqual(['history line one']);
    a.session.stop();

    const b = sessionOnTopic(store, topicB);
    expect((await b.session.messages()).map((m) => m.body)).toEqual(['history line one']);
  });

  it('a credential never becomes the identity', () => {
    // The #395/#398 root, pinned. An opaque bearer must not appear in the id.
    const bearer = 'nbt_9k2rFpQ7Kw5eem6BG4I4iSTtezt6ikTY';
    expect(parseDevTokenUserId(bearer)).not.toContain('nbt_');
    // The named lanes still behave.
    expect(parseDevTokenUserId('dev:sam')).toBe('sam');
  });
});

/**
 * ISSUES #399 — per-project topics, the SAME derivation the web client uses.
 * This replaces the #398 `rehomeLegacyTopics` coverage: that repair was deleted
 * because its `app:%` pattern would have collapsed every `app:<user>:<project>`
 * row into General under this model.
 */
describe('per-project topic derivation matches web (#399)', () => {
  it('General is user-scoped and a project gets its own topic', () => {
    expect(appWsTopicId('owner')).toBe('app:owner');
    expect(appWsProjectTopicId('owner', 'willow')).toBe('app:owner:willow');
  });

  it('two projects never share a topic, so their histories cannot merge', () => {
    const a = appWsProjectTopicId('owner', 'willow');
    const b = appWsProjectTopicId('owner', 'tabs');
    expect(a).not.toBe(b);
    expect(a).not.toBe(appWsTopicId('owner'));
  });

  it('a project scope keeps its own history separate in the store', async () => {
    const store = await freshStore();
    const general = sessionOnTopic(store, appWsTopicId('owner'));
    const willow = sessionOnTopic(store, appWsProjectTopicId('owner', 'willow'));

    general.session.start();
    general.sockets[0]!.open();
    general.sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'owner', topic_id: 'app:owner', ts: 1 });
    await tick();
    general.sockets[0]!.deliver({
      v: 1, type: 'agent_message', message_id: 'g-1', seq: 1, body: 'general message', ts: 10,
    });
    await tick();

    // The project scope must NOT see General's transcript — that was the bug:
    // every project rendered General's messages under its own heading.
    expect((await willow.session.messages()).length).toBe(0);
    expect((await general.session.messages()).map((m) => m.body)).toEqual(['general message']);
  });
});

describe('MobileChatSession — the backwards history walk', () => {
  /** One page of a transcript of seqs 1..total, exactly as the surface answers a
   *  `resume`: the newest `page` rows of the requested range, then a `history_gap`
   *  when that page came back full. */
  function answer(total: number, page: number, frame: Record<string, unknown>): object[] {
    const after = typeof frame['after_seq'] === 'number' ? frame['after_seq'] : 0;
    const before = typeof frame['before_seq'] === 'number' ? (frame['before_seq'] as number) : total + 1;
    const range: number[] = [];
    for (let seq = 1; seq <= total; seq++) if (seq > after && seq < before) range.push(seq);
    const sent = range.slice(-page);
    const out: object[] = sent.map((seq) => ({
      v: 1, type: 'agent_message', message_id: `m${seq}`, seq, body: `msg-${seq}`, ts: seq,
    }));
    if (sent.length >= page && sent[0] !== undefined) {
      out.push({ v: 1, type: 'history_gap', older_than: sent[0], ts: 0 });
    }
    return out;
  }

  /** Serve every unanswered `resume` on this socket until the client stops asking. */
  async function pump(socket: FakeSocket, total: number, page: number): Promise<void> {
    let served = 0;
    for (let guard = 0; guard < 30; guard++) {
      const pending = socket.sentEnvelopes().filter((e) => e['type'] === 'resume').slice(served);
      if (pending.length === 0) return;
      for (const frame of pending) {
        served += 1;
        for (const out of answer(total, page, frame)) socket.deliver(out);
        await tick();
      }
    }
    throw new Error('the client never stopped requesting history');
  }

  it('walks a capped replay back to seq 1 on this device', async () => {
    // The mobile store is the real on-device SQLite one, so this also pins that
    // `contiguousFloorSeq` is answerable from it — the read the walk restarts from,
    // and the one place its SQL (a correlated `NOT EXISTS` over the `(topic_id, seq)`
    // index) runs against a real op-sqlite database rather than the in-memory store.
    const store = await freshStore();
    const { session, sockets } = makeSession(store);
    session.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 1 });
    await tick();

    await pump(sockets[0]!, 25, 10);

    const seqs = (await session.messages()).map((m) => m.seq ?? 0).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(sockets[0]!.backwardsResumes().map((f) => f['before_seq'])).toEqual([16, 6]);
  });

  it('restarts the walk on a foreground catchUp over the SAME open socket', async () => {
    // THE PLURALITY THAT BROKE THE ORIGINAL PREMISE, asserted directly. `catchUp`
    // runs on every foreground and every foregrounded push
    // (`app/lib/chat-core/use-mobile-chat.ts`) and re-drives `resumeAndFlush` on an
    // already-open socket — there is no per-open guard on this session at all. So a
    // walk that ran out of budget is resumed by the next foreground, from this
    // device's own oldest applied seq rather than from a server signal.
    //
    // MUTATION-PROVED: remove the `backfillFrom` kick-off in `resumeAndFlush` and the
    // second catch-up sends no backwards request, leaving seqs 1..5 unreachable.
    const store = await freshStore();
    const { session, sockets } = makeSession(store);
    session.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 1 });
    await tick();

    // 45 rows at a 10-row page: one catch-up covers the forward page plus the round
    // budget (3), so it stops with the oldest 5 still missing.
    await pump(sockets[0]!, 45, 10);
    const afterFirst = (await session.messages()).map((m) => m.seq ?? 0).sort((a, b) => a - b);
    expect(afterFirst.length).toBe(40);
    expect(afterFirst[0]).toBe(6);

    // A foreground catch-up on the SAME socket picks the walk up where it stopped.
    await session.catchUp();
    await tick();
    await pump(sockets[0]!, 45, 10);

    const seqs = (await session.messages()).map((m) => m.seq ?? 0).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    expect(sockets[0]!.backwardsResumes().at(-1)).toMatchObject({ after_seq: 0, before_seq: 6 });
  });

  it('sees an INTERIOR hole in the on-device SQLite store, not just a missing prefix', async () => {
    // `SqliteChatStore.contiguousFloorSeq` is a SECOND implementation of the
    // contiguity read — a correlated `NOT EXISTS` walked backwards off the
    // `(topic_id, seq)` index — so it needs its own hole fixture rather than
    // inheriting the in-memory store's coverage. Two implementations of one
    // predicate is exactly where a divergence hides.
    //
    // MUTATION-PROVED: revert the SQL to `SELECT MIN(seq)` and this returns 1, so
    // the mobile client asks for nothing and the hole is permanent on device.
    const store = await freshStore();
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => i + 1), // an old prefix: 1..5
      ...Array.from({ length: 10 }, (_, i) => i + 20), // and a recent run: 20..29
    ];
    for (const seq of rows) {
      await store.upsert({
        topic_id: TOPIC,
        client_msg_id: '',
        message_id: `m${seq}`,
        seq,
        role: 'agent',
        body: `msg-${seq}`,
        project_id: null,
        attachments: null,
        created_at: seq,
        status: 'acked',
      });
    }

    // The forward cursor is above the hole, and seq 1 IS held — the exact shape that
    // made the old `MIN(seq) > 1` test answer "nothing is missing".
    expect(await store.lastSeenSeq(TOPIC)).toBe(29);
    expect(await store.contiguousFloorSeq(TOPIC)).toBe(20);

    // Filling the hole makes it silent again, so a healthy device stops asking.
    for (const seq of Array.from({ length: 14 }, (_, i) => i + 6)) {
      await store.upsert({
        topic_id: TOPIC,
        client_msg_id: '',
        message_id: `m${seq}`,
        seq,
        role: 'agent',
        body: `msg-${seq}`,
        project_id: null,
        attachments: null,
        created_at: seq,
        status: 'acked',
      });
    }
    expect(await store.contiguousFloorSeq(TOPIC)).toBe(1);
  });

  it('answers contiguity off the (topic_id, seq) index — no table access, no sort', async () => {
    // THE COST CLAIM, MEASURED. `Store.contiguousFloorSeq` documents the device read
    // as an index walk bounded by the newest run's length. The shape that makes that
    // true is a covering-index walk on the outer row plus an EQUALITY point probe on
    // the predecessor; the shape that quietly destroys it is a RANGE probe, which
    // turns the subquery into a per-row walk of the topic and the whole read into
    // O(rows^2) on exactly the long transcript it exists to repair.
    //
    // That is not hypothetical. Adding a defensive `AND p.seq > 0` to the subquery
    // during this build made SQLite prefer the range constraint over the equality,
    // and only the plan showed it — every behavioural assertion above stayed green.
    // So the plan is pinned, over the very string the store prepares.
    const db = new Database(':memory:');
    dbs.push(db);
    await SqliteChatStore.open(bunExecutor(db));
    const details = (
      db.prepare(`EXPLAIN QUERY PLAN ${contiguousFloorSql()}`).all() as Array<
        Record<string, unknown>
      >
    ).map((r) => String(r['detail']));

    const outer = details.find((d) => d.includes(' m USING'));
    const inner = details.find((d) => d.includes(' p USING'));
    // The outer walk: covered by the index, bounded above by the ORDER BY + LIMIT.
    expect(outer).toContain('COVERING INDEX idx_chat_messages_topic_seq');
    // The predecessor probe: an EQUALITY, which is the whole measurement. A range
    // here (`seq>?`) is the regression described above.
    expect(inner).toContain('COVERING INDEX idx_chat_messages_topic_seq');
    expect(inner).toContain('seq=?');
    // No sort (`ORDER BY seq DESC` is served by walking the index backwards) and no
    // table access on either leg.
    const joined = details.join(' | ');
    expect(joined).not.toContain('TEMP B-TREE');
    expect(joined).not.toContain('SCAN');
  });
});
