/**
 * @neutronai/app — SqliteChatStore FTS5 message-search tests (real bun:sqlite).
 *
 * Verifies the durable store's `searchMessages` against a REAL SQLite FTS5
 * engine (the op-sqlite logic, exercised on actual SQL): the external-content
 * mirror is kept in lock-step with the message table by triggers, so a search
 * returns the right messages, ranked + highlighted, and stays consistent when
 * a message is edited (re-upsert), reconciled (optimistic→echo), or its topic
 * is cleared. Also covers scoping (topic / project / global) and the
 * cold-open backfill for a DB written before the FTS index existed.
 */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import type { ChatMessage } from '@neutronai/chat-core';

import {
  SqliteChatStore,
  type SqlRow,
  type SqliteExecutor,
  type SqlValue,
} from '../lib/chat-core/sqlite-store';

const TOPIC = 'app:sam';

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
    status: 'acked',
    ...p,
  };
}

async function seed(store: SqliteChatStore): Promise<void> {
  await store.upsert(msg({ client_msg_id: 'a', message_id: 'm1', seq: 1, created_at: 100, body: 'Deploy the gateway to production tonight' }));
  await store.upsert(msg({ client_msg_id: 'b', message_id: 'm2', seq: 2, created_at: 200, role: 'agent', body: 'The gateway deploy succeeded and production is green' }));
  await store.upsert(msg({ client_msg_id: 'c', message_id: 'm3', seq: 3, created_at: 300, body: 'Lunch plans for tomorrow afternoon' }));
}

describe('SqliteChatStore.searchMessages — real FTS5', () => {
  it('returns only messages matching ALL terms, ranked + highlighted', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await seed(store);

    const hits = await store.searchMessages('gateway deploy');
    expect(hits.map((h) => h.id).sort()).toEqual(['m1', 'm2']);
    // No false positive from the unrelated lunch message.
    expect(hits.some((h) => h.id === 'm3')).toBe(false);
    // Highlighted snippet + bounded [0,1] score.
    const top = hits[0]!;
    expect(top.snippet).toMatch(/\[(gateway|deploy)\]/i);
    expect(top.score).toBeGreaterThanOrEqual(0);
    expect(top.score).toBeLessThanOrEqual(1);
    // Carries the full row metadata, not just the snippet.
    expect(top.body.length).toBeGreaterThan(0);
    expect(typeof top.created_at).toBe('number');
  });

  it('scopes by topic, by project, and globally', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(msg({ topic_id: 'app:a', client_msg_id: 'a1', message_id: 'm1', body: 'shared keyword here', project_id: 'p1' }));
    await store.upsert(msg({ topic_id: 'app:b', client_msg_id: 'b1', message_id: 'm2', body: 'shared keyword here', project_id: 'p2' }));

    expect((await store.searchMessages('keyword')).length).toBe(2); // global
    expect((await store.searchMessages('keyword', { topic_id: 'app:a' })).map((h) => h.id)).toEqual(['m1']);
    expect((await store.searchMessages('keyword', { project_id: 'p2' })).map((h) => h.id)).toEqual(['m2']);
  });

  it('keeps the FTS index in sync when a message is edited in place', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await seed(store);
    // m3 did not match "gateway"; re-upsert its body (same identity) so it does.
    await store.upsert(msg({ client_msg_id: 'c', message_id: 'm3', seq: 3, created_at: 300, body: 'Actually the gateway lunch is cancelled' }));
    expect((await store.searchMessages('gateway')).map((h) => h.id).sort()).toEqual(['m1', 'm2', 'm3']);
    // The OLD body's distinctive term ("tomorrow") is gone from the index.
    expect(await store.searchMessages('tomorrow')).toEqual([]);
  });

  it('keeps the FTS index in sync across an optimistic→echo reconcile', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    // Optimistic row keyed by client_msg_id only (identity = c:opt).
    await store.upsert(msg({ client_msg_id: 'opt', created_at: 100, status: 'queued', body: 'searching for elephants' }));
    expect((await store.searchMessages('elephants')).length).toBe(1);
    // Server echo carries message_id → identity flips to m:srv; the store
    // DELETEs the old identity row and writes the new one. FTS must follow.
    await store.upsert(msg({ client_msg_id: 'opt', message_id: 'srv', seq: 5, created_at: 100, status: 'acked', body: 'searching for elephants' }));
    const hits = await store.searchMessages('elephants');
    expect(hits.length).toBe(1); // not duplicated, not lost
    expect(hits[0]?.id).toBe('srv');
    expect(hits[0]?.seq).toBe(5);
  });

  it('drops cleared messages from search', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await seed(store);
    await store.clear(TOPIC);
    expect(await store.searchMessages('gateway')).toEqual([]);
  });

  it('isolates topics — a topic clear does not evict another topic', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(msg({ topic_id: 'app:a', client_msg_id: 'a1', message_id: 'm1', body: 'gateway alpha' }));
    await store.upsert(msg({ topic_id: 'app:b', client_msg_id: 'b1', message_id: 'm2', body: 'gateway beta' }));
    await store.clear('app:a');
    expect((await store.searchMessages('gateway')).map((h) => h.id)).toEqual(['m2']);
  });

  it('returns nothing for empty / whitespace queries', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await seed(store);
    expect(await store.searchMessages('   ')).toEqual([]);
    expect(await store.searchMessages('')).toEqual([]);
  });

  it('does not let FTS5 query syntax (a stray hyphen) throw', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(msg({ client_msg_id: 'a', message_id: 'm1', body: 'my daily-driver setup' }));
    // Unsanitised, "daily-driver" is an FTS5 column-filter/NOT expression and
    // would throw; sanitizeFtsQuery phrase-quotes it.
    const hits = await store.searchMessages('daily-driver');
    expect(hits.map((h) => h.id)).toEqual(['m1']);
  });

  it('backfills the FTS index on cold-open of a pre-search DB', async () => {
    const db = freshDb();
    const exec = bunExecutor(db);
    // Build ONLY the base message table + insert a row, simulating a DB
    // written before the FTS mirror existed (no triggers fired for it).
    await exec.execute(
      `CREATE TABLE chat_messages (
         topic_id TEXT NOT NULL, identity TEXT NOT NULL, client_msg_id TEXT NOT NULL,
         message_id TEXT, seq INTEGER, role TEXT NOT NULL, body TEXT NOT NULL,
         project_id TEXT, attachments TEXT, created_at INTEGER NOT NULL, status TEXT NOT NULL,
         PRIMARY KEY (topic_id, identity))`,
    );
    await exec.execute(
      `INSERT INTO chat_messages (topic_id, identity, client_msg_id, message_id, seq, role, body, project_id, attachments, created_at, status)
       VALUES ('app:sam', 'm:legacy', '', 'legacy', 1, 'agent', 'a legacy gateway message', NULL, NULL, 50, 'acked')`,
    );
    // Opening the store creates the FTS schema and backfills from content.
    const store = await SqliteChatStore.open(exec);
    expect((await store.searchMessages('gateway')).map((h) => h.id)).toEqual(['legacy']);
  });
});
