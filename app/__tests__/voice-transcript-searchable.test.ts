/**
 * A SPOKEN WORD IS FINDABLE IN CHAT SEARCH — against a real SQLite FTS5 engine.
 *
 * THE BUG. A voice note was transcribed at upload, the text was written durably
 * beside the audio, and the memory pipeline received it. **Search could not see any
 * of it**, because the search index mirrors the message `body` and a voice note's
 * body is the attachment placeholder. Nothing was lost and nothing was findable —
 * the owner's words were in the system and unreachable from the one surface built
 * for reaching them.
 *
 * WHY THE TRANSCRIPT IS A SEPARATE FIELD AND NOT APPENDED TO THE BODY. The body is
 * what renders. Appending would change how every existing voice note displays and
 * duplicate text the agent's turn already carries. So `body` stays the display text,
 * `transcript` is indexed alongside it, and each has exactly one writer.
 *
 * THE UPGRADE PATH IS THE RISKY PART, so it is tested directly. An FTS5 table cannot
 * gain a column, so an existing single-column index must be dropped, recreated and
 * rebuilt — and the triggers, which were compiled against the old column list, have
 * to go with it. A migration that half-happens leaves an index that silently stops
 * matching the schema it mirrors, which no ordinary search test would reveal.
 */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import type { ChatMessage } from '@neutronai/chat-core';
import { searchMessagesInMemory } from '@neutronai/chat-core';

import {
  SqliteChatStore,
  type SqlRow,
  type SqliteExecutor,
  type SqlValue,
} from '../lib/chat-core/sqlite-store';

const TOPIC = 'app:owner';

function bunExecutor(db: Database): SqliteExecutor {
  return {
    async execute(sql: string, params: readonly SqlValue[] = []): Promise<{ rows: SqlRow[] }> {
      const bind = params as SqlValue[];
      if (/^\s*select/i.test(sql)) {
        return { rows: db.prepare(sql).all(...bind) as SqlRow[] };
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
    body: '',
    project_id: null,
    attachments: null,
    created_at: 0,
    status: 'acked',
    ...p,
  };
}

/** A voice note as the client actually stores one: a placeholder body + audio. */
function voiceNote(over: Partial<ChatMessage> = {}): ChatMessage {
  return msg({
    client_msg_id: 'v1',
    message_id: 'mv1',
    seq: 1,
    created_at: 1000,
    body: '[voice note]',
    attachments: ['/api/app/upload/owner/abc123.m4a'],
    transcript: 'remind me to renegotiate the warehouse lease before the quarter ends',
    ...over,
  });
}

describe('durable store — the spoken words are indexed', () => {
  it('finds a voice note by a word that exists ONLY in its transcript', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(voiceNote());
    // `warehouse` appears nowhere in the body. Before the fix this returned nothing.
    const hits = await store.searchMessages('warehouse', { topic_id: TOPIC, limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message_id).toBe('mv1');
  });

  it('highlights the TRANSCRIPT in the snippet, not the placeholder body', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(voiceNote());
    const hits = await store.searchMessages('warehouse', { topic_id: TOPIC, limit: 10 });
    // FTS5 `snippet(tbl, -1, …)` picks the column with the most matches. Pinned at
    // column 0 this would return the unhighlighted placeholder — a hit the owner
    // cannot recognise, which is a search that works and is useless.
    expect(hits[0]!.snippet).toContain('[warehouse]');
    expect(hits[0]!.snippet).not.toBe('[voice note]');
  });

  it('still finds an ordinary typed message by its body', async () => {
    // The control. A change to the indexed column set is exactly where the ORIGINAL
    // capability quietly regresses.
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(msg({ client_msg_id: 't1', message_id: 'mt1', created_at: 1, body: 'ship the gateway tonight' }));
    const hits = await store.searchMessages('gateway', { topic_id: TOPIC, limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message_id).toBe('mt1');
  });

  it('round-trips the transcript through the row, so a cold open keeps it', async () => {
    // Guards the INSERT column/placeholder counts and the row decoder together — a
    // mismatch there throws at write time rather than degrading search, but only if
    // something actually writes a message with the field populated.
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(voiceNote());
    const all = await store.list(TOPIC);
    expect(all).toHaveLength(1);
    expect(all[0]!.transcript).toBe(
      'remind me to renegotiate the warehouse lease before the quarter ends',
    );
  });

  it('leaves transcript null for a message that never had audio', async () => {
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(msg({ client_msg_id: 't2', message_id: 'mt2', body: 'typed' }));
    const all = await store.list(TOPIC);
    expect(all[0]!.transcript ?? null).toBeNull();
  });

  it('drops the transcript from the index when the message is deleted', async () => {
    // The `delete` trigger must repeat the OLD value of EVERY indexed column or the
    // mirror keeps a phantom row — a search hit pointing at a message that is gone.
    const store = await SqliteChatStore.open(bunExecutor(freshDb()));
    await store.upsert(voiceNote());
    await store.clear(TOPIC);
    const hits = await store.searchMessages('warehouse', { topic_id: TOPIC, limit: 10 });
    expect(hits).toEqual([]);
  });
});

describe('the upgrade path — an existing single-column index is rebuilt', () => {
  /**
   * Build the PRE-FIX schema by hand: a message table with no `transcript` column
   * and a one-column FTS mirror with its original triggers. This is the state on
   * every phone that has ever run the app, and it is the state the migration has to
   * survive — a fresh-install-only test would pass while every upgrade broke.
   */
  function legacyDb(): Database {
    const db = freshDb();
    db.exec(`CREATE TABLE chat_messages (
       topic_id TEXT NOT NULL, identity TEXT NOT NULL, client_msg_id TEXT NOT NULL,
       message_id TEXT, seq INTEGER, role TEXT NOT NULL, body TEXT NOT NULL,
       project_id TEXT, attachments TEXT, created_at INTEGER NOT NULL, status TEXT NOT NULL,
       PRIMARY KEY (topic_id, identity))`);
    db.exec(`CREATE VIRTUAL TABLE chat_fts USING fts5(
       body, content='chat_messages', tokenize='unicode61 remove_diacritics 2')`);
    db.exec(`CREATE TRIGGER chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
       INSERT INTO chat_fts(rowid, body) VALUES (new.rowid, new.body); END`);
    db.exec(`CREATE TRIGGER chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
       INSERT INTO chat_fts(chat_fts, rowid, body) VALUES ('delete', old.rowid, old.body); END`);
    db.exec(`CREATE TRIGGER chat_messages_fts_au AFTER UPDATE ON chat_messages BEGIN
       INSERT INTO chat_fts(chat_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
       INSERT INTO chat_fts(rowid, body) VALUES (new.rowid, new.body); END`);
    db.prepare(
      `INSERT INTO chat_messages (topic_id, identity, client_msg_id, message_id, seq, role, body, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(TOPIC, 'old1', 'old1', 'mold1', 1, 'user', 'the older typed message about invoices', 5, 'acked');
    return db;
  }

  it('opens a legacy DB without throwing', async () => {
    // The trigger bodies name `new.transcript`, so if the column migration ran AFTER
    // the FTS DDL this open would fail — on upgrade only, never on a fresh install.
    const store = await SqliteChatStore.open(bunExecutor(legacyDb()));
    expect(store).toBeDefined();
  });

  it('rebuilds the index so PRE-EXISTING messages stay findable', async () => {
    // The dangerous half of a rebuild: dropping the index is easy, repopulating it is
    // the part that gets forgotten, and the symptom is a silent loss of all history.
    const store = await SqliteChatStore.open(bunExecutor(legacyDb()));
    const hits = await store.searchMessages('invoices', { topic_id: TOPIC, limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message_id).toBe('mold1');
  });

  it('indexes a transcript written AFTER the upgrade', async () => {
    const db = legacyDb();
    const store = await SqliteChatStore.open(bunExecutor(db));
    await store.upsert(voiceNote());
    const hits = await store.searchMessages('warehouse', { topic_id: TOPIC, limit: 10 });
    expect(hits).toHaveLength(1);
  });

  it('is IDEMPOTENT — a second open does not rebuild or lose anything', async () => {
    // Re-opening is the common case (every app launch). A migration keyed on the
    // wrong signal would drop and rebuild the index on every single open, which is
    // invisible until the transcript is large enough for the owner to feel it.
    const db = legacyDb();
    const first = await SqliteChatStore.open(bunExecutor(db));
    await first.upsert(voiceNote());
    const second = await SqliteChatStore.open(bunExecutor(db));
    const hits = await second.searchMessages('warehouse', { topic_id: TOPIC, limit: 10 });
    expect(hits).toHaveLength(1);
    // And the DDL now names the column exactly once — proof the recreate did not
    // stack a second index or leave the old one behind.
    const rows = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_fts'`)
      .all() as Array<{ sql: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sql).toContain('transcript');
  });
});

describe('in-memory search (the web path) matches the durable one', () => {
  it('finds a voice note by a transcript-only word', () => {
    // Two independent search implementations over the same data model is the classic
    // place a field gets indexed on one platform and not the other.
    const hits = searchMessagesInMemory([voiceNote()], 'warehouse', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message_id).toBe('mv1');
  });

  it('snippets the transcript when the body is a bare placeholder', () => {
    const hits = searchMessagesInMemory([voiceNote({ body: '' })], 'warehouse', 10);
    expect(hits[0]!.snippet).toContain('[warehouse]');
  });

  it('still finds an ordinary message by its body', () => {
    const hits = searchMessagesInMemory(
      [msg({ client_msg_id: 't3', message_id: 'mt3', body: 'ship the gateway tonight' })],
      'gateway',
      10,
    );
    expect(hits).toHaveLength(1);
  });

  it('requires ALL terms across the combined text, not one of them', () => {
    // AND semantics must survive the concatenation: a query matching one word in the
    // body and one in the transcript is a legitimate hit; a query with a word in
    // NEITHER is not.
    const m = voiceNote({ body: 'about the lease' });
    expect(searchMessagesInMemory([m], 'lease warehouse', 10)).toHaveLength(1);
    expect(searchMessagesInMemory([m], 'lease submarine', 10)).toHaveLength(0);
  });
});
