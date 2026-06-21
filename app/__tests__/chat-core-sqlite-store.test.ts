/**
 * @neutronai/app — SqliteChatStore contract tests.
 *
 * Runs the SAME Store contract chat-core's `store.test.ts` runs against
 * `InMemoryStore` + `createWebStore`, but against {@link SqliteChatStore}
 * driven by a REAL SQLite engine (`bun:sqlite`). This is the on-device
 * op-sqlite store's logic verified on actual SQL — round-trip, seq ordering,
 * idempotent dedup, optimistic↔echo reconcile, pending-queue isolation,
 * resume cursor, attachment round-trip, and cold-open hydration across a
 * fresh store over the same DB file (the "instant cold-open / works offline"
 * guarantee from research doc §2).
 */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import type { ChatMessage } from '@neutron/chat-core';

import {
  SqliteChatStore,
  type SqlRow,
  type SqliteExecutor,
  type SqlValue,
} from '../lib/chat-core/sqlite-store';

const TOPIC = 'app:sam';

/** A `bun:sqlite`-backed {@link SqliteExecutor} — the test analog of the
 *  op-sqlite adapter. Exercises real SQL, real prepared statements. */
function bunExecutor(db: Database): SqliteExecutor {
  return {
    async execute(sql: string, params: readonly SqlValue[] = []): Promise<{ rows: SqlRow[] }> {
      const bind = params as SqlValue[];
      if (/^\s*select/i.test(sql)) {
        const rows = db.prepare(sql).all(...bind) as SqlRow[];
        return { rows };
      }
      db.prepare(sql).run(...bind);
      return { rows: [] };
    },
  };
}

const openDbs: Database[] = [];
function freshDb(): Database {
  const db = new Database(':memory:');
  openDbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function msg(p: Partial<ChatMessage> & { client_msg_id: string }): ChatMessage {
  return {
    topic_id: TOPIC,
    message_id: null,
    seq: null,
    role: 'user',
    body: 'x',
    project_id: null,
    attachments: null,
    created_at: 0,
    status: 'queued',
    ...p,
  };
}

describe('SqliteChatStore — Store contract (real bun:sqlite)', () => {
  it('satisfies ordering / idempotency / pending / lookup / clear', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));

    await store.upsert(msg({ client_msg_id: 'c1', seq: 2, message_id: 'm2', body: 'two', status: 'acked' }));
    await store.upsert(msg({ client_msg_id: 'c2', seq: 1, message_id: 'm1', body: 'one', status: 'acked' }));

    const list = await store.list(TOPIC);
    expect(list.map((m) => m.body)).toEqual(['one', 'two']); // seq order
    expect(await store.lastSeenSeq(TOPIC)).toBe(2);

    // Idempotent re-apply by identity — no duplicate row.
    await store.upsert(msg({ client_msg_id: 'c1', seq: 2, message_id: 'm2', body: 'two', status: 'acked' }));
    expect((await store.list(TOPIC)).length).toBe(2);

    // Pending-queue isolation: only `queued` rows show up.
    await store.upsert(msg({ client_msg_id: 'c3', body: 'pending', status: 'queued' }));
    expect((await store.pendingSends(TOPIC)).map((m) => m.body)).toEqual(['pending']);

    expect((await store.getByClientMsgId(TOPIC, 'c2'))?.body).toBe('one');
    // Indexed point lookup by message_id (idx_chat_messages_topic_mid) — the
    // resume-replay path; bounds it to O(1) per message instead of a scan.
    expect((await store.getByMessageId(TOPIC, 'm1'))?.body).toBe('one');
    expect(await store.getByMessageId(TOPIC, 'no-such-id')).toBeNull();

    await store.clear(TOPIC);
    expect((await store.list(TOPIC)).length).toBe(0);
  });

  it('reconciles an optimistic row keyed by client_msg_id with a server echo', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(msg({ client_msg_id: 'c1', body: 'hi', created_at: 100, status: 'queued' }));
    await store.upsert(
      msg({ client_msg_id: 'c1', message_id: 'srv', seq: 9, body: 'hi', created_at: 999, status: 'acked' }),
    );
    const list = await store.list(TOPIC);
    expect(list.length).toBe(1); // collapsed, not duplicated
    expect(list[0]?.seq).toBe(9);
    expect(list[0]?.message_id).toBe('srv');
    expect(list[0]?.status).toBe('acked');
    // Original optimistic timestamp preserved so the bubble doesn't jump.
    expect(list[0]?.created_at).toBe(100);
  });

  it('sorts optimistic (un-sequenced) messages after sequenced ones', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(msg({ client_msg_id: 'seqd', seq: 5, message_id: 'm5', body: 'sequenced', created_at: 1, status: 'acked' }));
    await store.upsert(msg({ client_msg_id: 'opt', seq: null, body: 'optimistic', created_at: 2, status: 'queued' }));
    expect((await store.list(TOPIC)).map((m) => m.body)).toEqual(['sequenced', 'optimistic']);
  });

  it('round-trips attachments + project_id + agent role', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(
      msg({
        client_msg_id: '',
        message_id: 'agent-1',
        seq: 3,
        role: 'agent',
        body: 'see these',
        project_id: 'proj-42',
        attachments: ['https://x/a.png', 'https://x/b.png'],
        created_at: 5,
        status: 'acked',
      }),
    );
    const [row] = await store.list(TOPIC);
    expect(row?.role).toBe('agent');
    expect(row?.project_id).toBe('proj-42');
    expect(row?.attachments).toEqual(['https://x/a.png', 'https://x/b.png']);
    // Agent messages carry no client_msg_id — identity falls back to message_id.
    expect(row?.client_msg_id).toBe('');
  });

  it('round-trips + set-unions receipt fields (Track B Phase 4)', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(
      msg({ client_msg_id: 'c1', message_id: 'm1', seq: 1, status: 'acked', delivered_to: ['devA'] }),
    );
    // A later receipt partial unions devB delivered + agent read onto the row.
    await store.upsert(
      msg({
        client_msg_id: 'c1',
        message_id: 'm1',
        seq: 1,
        status: 'acked',
        delivered_to: ['devB'],
        read_by: ['agent'],
      }),
    );
    const [row] = await store.list(TOPIC);
    expect(row?.delivered_to).toEqual(['devA', 'devB']);
    expect(row?.read_by).toEqual(['agent']);
  });

  it('persists receipts across a cold reopen (migrated columns)', async () => {
    const db = freshDb();
    const first = await SqliteChatStore.open(bunExecutor(db));
    await first.upsert(
      msg({ client_msg_id: 'c1', message_id: 'm1', seq: 1, status: 'acked', read_by: ['agent'] }),
    );
    const reopened = await SqliteChatStore.open(bunExecutor(db));
    const [row] = await reopened.list(TOPIC);
    expect(row?.read_by).toEqual(['agent']);
  });

  it('migrates a pre-receipts DB by adding the columns on open (idempotent ALTER)', async () => {
    const db = freshDb();
    // Simulate a DB written by a build that predates receipts: the message
    // table without delivered_to / read_by, holding one row.
    db.run(`CREATE TABLE chat_messages (
       topic_id TEXT NOT NULL, identity TEXT NOT NULL, client_msg_id TEXT NOT NULL,
       message_id TEXT, seq INTEGER, role TEXT NOT NULL, body TEXT NOT NULL,
       project_id TEXT, attachments TEXT, created_at INTEGER NOT NULL, status TEXT NOT NULL,
       PRIMARY KEY (topic_id, identity))`);
    db.run(
      `INSERT INTO chat_messages (topic_id, identity, client_msg_id, message_id, seq, role, body, created_at, status)
       VALUES (?, 'c:c1', 'c1', 'm1', 1, 'user', 'legacy', 1, 'acked')`,
      [TOPIC],
    );
    // Opening the store adds the columns; the legacy row reads back with null
    // receipts, and a receipt upsert then sticks.
    const store = await SqliteChatStore.open(bunExecutor(db));
    let [row] = await store.list(TOPIC);
    expect(row?.body).toBe('legacy');
    expect(row?.read_by ?? null).toBeNull();
    await store.upsert(msg({ client_msg_id: 'c1', message_id: 'm1', seq: 1, status: 'acked', read_by: ['agent'] }));
    [row] = await store.list(TOPIC);
    expect(row?.read_by).toEqual(['agent']);
  });

  it('does not regress status or known fields on a later partial', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(msg({ client_msg_id: 'c1', message_id: 'm1', seq: 7, body: 'final', status: 'acked' }));
    // A late, lower-status re-delivery must not knock it back to queued/sent.
    await store.upsert(msg({ client_msg_id: 'c1', message_id: 'm1', seq: 7, body: 'final', status: 'sent' }));
    const [row] = await store.list(TOPIC);
    expect(row?.status).toBe('acked');
  });

  it('cold-opens from a persisted DB file (instant restart, offline read)', async () => {
    const db = freshDb();
    const first = await SqliteChatStore.open(bunExecutor(db));
    await first.upsert(msg({ client_msg_id: 'c1', seq: 1, message_id: 'm1', body: 'persisted', status: 'acked' }));
    await first.upsert(msg({ client_msg_id: 'c2', body: 'still-queued', created_at: 10, status: 'queued' }));

    // Simulate an app restart: a brand-new store instance over the SAME db.
    const reopened = await SqliteChatStore.open(bunExecutor(db));
    const list = await reopened.list(TOPIC);
    expect(list.map((m) => m.body)).toEqual(['persisted', 'still-queued']);
    expect(await reopened.lastSeenSeq(TOPIC)).toBe(1);
    // The offline send survived the restart and is still pending delivery.
    expect((await reopened.pendingSends(TOPIC)).map((m) => m.body)).toEqual(['still-queued']);
  });

  it('isolates topics (multi-project transcripts never bleed)', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(msg({ topic_id: 'app:a', client_msg_id: 'a1', seq: 1, message_id: 'm1', body: 'in-a', status: 'acked' }));
    await store.upsert(msg({ topic_id: 'app:b', client_msg_id: 'b1', seq: 1, message_id: 'm2', body: 'in-b', status: 'acked' }));
    expect((await store.list('app:a')).map((m) => m.body)).toEqual(['in-a']);
    expect((await store.list('app:b')).map((m) => m.body)).toEqual(['in-b']);
    expect(await store.lastSeenSeq('app:a')).toBe(1);
    await store.clear('app:a');
    expect((await store.list('app:a')).length).toBe(0);
    expect((await store.list('app:b')).length).toBe(1); // untouched
  });

  it('keeps rows with the SAME identity in different topics (no PK clobber)', async () => {
    // Codex P2 regression: a global identity PK would let topic B's upsert
    // INSERT-OR-REPLACE topic A's row out of existence. The PK is (topic_id,
    // identity), so a shared client_msg_id / message_id across topics coexists.
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(msg({ topic_id: 'app:a', client_msg_id: 'shared', seq: 1, message_id: 'same', body: 'a-body', status: 'acked' }));
    await store.upsert(msg({ topic_id: 'app:b', client_msg_id: 'shared', seq: 1, message_id: 'same', body: 'b-body', status: 'acked' }));
    expect((await store.list('app:a')).map((m) => m.body)).toEqual(['a-body']);
    expect((await store.list('app:b')).map((m) => m.body)).toEqual(['b-body']);
    // A reconcile in B (identity change cmid→message_id path) must not touch A.
    await store.upsert(msg({ topic_id: 'app:b', client_msg_id: 'shared', seq: 2, message_id: 'same2', body: 'b-updated', status: 'acked' }));
    expect((await store.list('app:a')).map((m) => m.body)).toEqual(['a-body']);
    expect((await store.list('app:b')).map((m) => m.body)).toEqual(['b-updated']);
  });
});
