/**
 * @neutronai/app — durable RN local store over SQLite, implementing the
 * `@neutron/chat-core` {@link Store} interface (research doc §5/§6 — "op-
 * sqlite on RN", "the same SQLite model as the server").
 *
 * This is the Phase-2 mobile durable substrate. It is the op-sqlite analog
 * of chat-core's OPFS web store: a SQLite table behind the EXACT same Store
 * seam the sync engine + send-queue depend on, so the mobile client gets
 * offline send, gap-free reconnect, instant cold-open, and multi-device
 * consistency from the EXISTING chat-core engine — nothing in the engine is
 * re-implemented here.
 *
 * Driver-agnostic by design: the class talks to a minimal async
 * {@link SqliteExecutor} interface, NOT to op-sqlite directly. The op-sqlite
 * adapter + the `createMobileStore()` factory live in `./op-sqlite-store.ts`
 * (RN-only, native); a `bun:sqlite` adapter drives the SAME class in the unit
 * suite against a REAL SQLite engine (so the contract is verified on actual
 * SQL, not a mock). A future wasm-SQLite web driver drops in the same way.
 *
 * Contract parity (the reason this can't drift from `InMemoryStore`): the
 * identity key, the optimistic↔echo merge, and the display ordering are NOT
 * re-derived here — they reuse `messageIdentity`, `mergeMessage`, and
 * `compareForDisplay` straight from `@neutron/chat-core`. SQLite is pure
 * storage + lookup; the semantics are the engine's.
 */

import {
  clampSearchLimit,
  compareForDisplay,
  mergeMessage,
  messageIdentity,
  minMaxNormalise,
  sanitizeFtsQuery,
  toHit,
  type ChatMessage,
  type MessageSearchHit,
  type MessageSearchOptions,
  type Store,
} from '@neutron/chat-core';

/** A SQL bind value. Mirrors what op-sqlite / bun:sqlite accept. */
export type SqlValue = string | number | null;

/** One result row as a column→value map. */
export type SqlRow = Record<string, SqlValue>;

/**
 * The minimal SQLite surface {@link SqliteChatStore} drives. Both op-sqlite
 * (`db.execute`) and a bun:sqlite adapter satisfy it; the executor owns the
 * native binding so the store class stays pure + unit-testable.
 */
export interface SqliteExecutor {
  /** Execute one statement. Returns the result rows (empty for writes/DDL). */
  execute(sql: string, params?: readonly SqlValue[]): Promise<{ rows: SqlRow[] }>;
}

const TABLE = 'chat_messages';
const FTS_TABLE = 'chat_fts';

/** DDL applied once on open. Idempotent. */
const SCHEMA = [
  // PK is (topic_id, identity), NOT identity alone: the Store contract is
  // topic-scoped (InMemoryStore keys per topic), so the same message identity
  // may legitimately exist in two topics. A global identity PK would let
  // INSERT OR REPLACE clobber another topic's row → silent data loss.
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
     topic_id      TEXT NOT NULL,
     identity      TEXT NOT NULL,
     client_msg_id TEXT NOT NULL,
     message_id    TEXT,
     seq           INTEGER,
     role          TEXT NOT NULL,
     body          TEXT NOT NULL,
     project_id    TEXT,
     attachments   TEXT,
     created_at    INTEGER NOT NULL,
     status        TEXT NOT NULL,
     PRIMARY KEY (topic_id, identity)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_${TABLE}_topic_seq ON ${TABLE} (topic_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_${TABLE}_topic_cmid ON ${TABLE} (topic_id, client_msg_id)`,
  // Backs `getByMessageId` — the sync engine's resume-replay point lookup for
  // agent messages. Without it, replaying N messages was O(N²) (full scans).
  `CREATE INDEX IF NOT EXISTS idx_${TABLE}_topic_mid ON ${TABLE} (topic_id, message_id)`,

  // ── Full-text MESSAGE search (Track B Phase 4) ─────────────────────────
  // `chat_fts` is an EXTERNAL-CONTENT FTS5 mirror over the message `body`.
  // External content means the index stores NO copy of the text — it points
  // back at `chat_messages` by rowid, so the only write path is still the
  // message table; the triggers below keep the index in lock-step on every
  // insert / delete (and the explicit reconcile DELETE in `upsert`). This is
  // the canonical FTS5 contentless-sync pattern (same as `doc-search`).
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
     body,
     content='${TABLE}',
     tokenize='unicode61 remove_diacritics 2'
   )`,
  // INSERT OR REPLACE (the store's only write) fires DELETE-then-INSERT on a
  // PK conflict, so the AI + AD triggers alone keep the mirror exact; the AU
  // trigger covers any future in-place UPDATE for completeness.
  `CREATE TRIGGER IF NOT EXISTS ${TABLE}_fts_ai AFTER INSERT ON ${TABLE} BEGIN
     INSERT INTO ${FTS_TABLE}(rowid, body) VALUES (new.rowid, new.body);
   END`,
  `CREATE TRIGGER IF NOT EXISTS ${TABLE}_fts_ad AFTER DELETE ON ${TABLE} BEGIN
     INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, body) VALUES ('delete', old.rowid, old.body);
   END`,
  `CREATE TRIGGER IF NOT EXISTS ${TABLE}_fts_au AFTER UPDATE ON ${TABLE} BEGIN
     INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, body) VALUES ('delete', old.rowid, old.body);
     INSERT INTO ${FTS_TABLE}(rowid, body) VALUES (new.rowid, new.body);
   END`,
];

/** Hard cap on BM25-ordered candidate rows pulled before the recency re-sort
 *  + final limit. Bounds a pathologically broad query over a large transcript
 *  to a fixed working set rather than loading the whole match set into JS. */
const SEARCH_CANDIDATE_CAP = 1000;

export class SqliteChatStore implements Store {
  private readonly db: SqliteExecutor;

  private constructor(db: SqliteExecutor) {
    this.db = db;
  }

  /**
   * Open a store over an already-constructed executor, applying the schema.
   * The executor (op-sqlite, bun:sqlite, …) is supplied by the platform
   * factory so this stays driver-agnostic.
   */
  static async open(db: SqliteExecutor): Promise<SqliteChatStore> {
    // Did the FTS mirror exist BEFORE this open? If not, and the message table
    // already holds rows (a DB written by a build that predates message
    // search), we must one-shot backfill the index — the sync triggers only
    // index rows written after they exist. Checked before the DDL because the
    // CREATE below would otherwise make it exist unconditionally.
    const ftsPreexisted = await tableExists(db, FTS_TABLE);
    for (const stmt of SCHEMA) {
      await db.execute(stmt);
    }
    if (!ftsPreexisted) {
      await backfillFts(db);
    }
    return new SqliteChatStore(db);
  }

  async upsert(msg: ChatMessage): Promise<void> {
    const identity = messageIdentity(msg.client_msg_id, msg.message_id);
    if (identity === null) return;

    // Reconcile path (mirrors InMemoryStore): match the existing row by
    // identity first, then fall back to the same topic's client_msg_id so a
    // server echo collapses onto the optimistic bubble instead of inserting a
    // duplicate.
    const existing =
      (await this.rowByIdentity(msg.topic_id, identity)) ??
      (await this.rowByClientMsgId(msg.topic_id, msg.client_msg_id));

    if (existing === null) {
      await this.write(identity, msg);
      return;
    }

    const merged = mergeMessage(existing, msg);
    const mergedIdentity = messageIdentity(merged.client_msg_id, merged.message_id) ?? identity;
    const existingIdentity = messageIdentity(existing.client_msg_id, existing.message_id);
    if (existingIdentity !== null && existingIdentity !== mergedIdentity) {
      await this.db.execute(`DELETE FROM ${TABLE} WHERE topic_id = ? AND identity = ?`, [
        msg.topic_id,
        existingIdentity,
      ]);
    }
    await this.write(mergedIdentity, merged);
  }

  async list(topic_id: string): Promise<ChatMessage[]> {
    const { rows } = await this.db.execute(
      `SELECT * FROM ${TABLE} WHERE topic_id = ?`,
      [topic_id],
    );
    // Order with the engine's canonical comparator (seq asc, optimistic tail
    // last) rather than a SQL ORDER BY — the null-seq tiebreak rules live in
    // chat-core and must not be re-encoded here.
    return rows.map(rowToMessage).sort(compareForDisplay);
  }

  async getByClientMsgId(topic_id: string, client_msg_id: string): Promise<ChatMessage | null> {
    return this.rowByClientMsgId(topic_id, client_msg_id);
  }

  async getByMessageId(topic_id: string, message_id: string): Promise<ChatMessage | null> {
    if (message_id.length === 0) return null;
    // Indexed point lookup (idx_chat_messages_topic_mid) — keeps the sync
    // engine's resume replay linear instead of a full-table scan per message.
    const { rows } = await this.db.execute(
      `SELECT * FROM ${TABLE} WHERE topic_id = ? AND message_id = ? LIMIT 1`,
      [topic_id, message_id],
    );
    const row = rows[0];
    return row !== undefined ? rowToMessage(row) : null;
  }

  async lastSeenSeq(topic_id: string): Promise<number> {
    const { rows } = await this.db.execute(
      `SELECT MAX(seq) AS max_seq FROM ${TABLE} WHERE topic_id = ? AND seq IS NOT NULL`,
      [topic_id],
    );
    const raw = rows[0]?.['max_seq'];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  }

  async pendingSends(topic_id: string): Promise<ChatMessage[]> {
    const { rows } = await this.db.execute(
      `SELECT * FROM ${TABLE} WHERE topic_id = ? AND status = 'queued' ORDER BY created_at ASC`,
      [topic_id],
    );
    return rows.map(rowToMessage);
  }

  async clear(topic_id: string): Promise<void> {
    // The AFTER DELETE trigger evicts every cleared row from the FTS mirror,
    // so a topic wipe leaves no orphaned index entries to surface in search.
    await this.db.execute(`DELETE FROM ${TABLE} WHERE topic_id = ?`, [topic_id]);
  }

  async searchMessages(
    query: string,
    opts: MessageSearchOptions = {},
  ): Promise<MessageSearchHit[]> {
    const limit = clampSearchLimit(opts.limit);
    const match = sanitizeFtsQuery(query);
    if (match.length === 0) return [];

    const params: SqlValue[] = [match];
    let scope = '';
    if (opts.topic_id !== undefined && opts.topic_id.length > 0) {
      scope += ' AND m.topic_id = ?';
      params.push(opts.topic_id);
    }
    if (opts.project_id !== undefined && opts.project_id.length > 0) {
      scope += ' AND m.project_id = ?';
      params.push(opts.project_id);
    }
    params.push(SEARCH_CANDIDATE_CAP);

    // bm25() returns a score where MORE-negative is a better match; we pull
    // BM25-ordered candidates, normalise -bm25 into a [0,1] relevance, then
    // re-sort relevance-desc with a recency tiebreak (newest first) — the
    // "recency/relevance" ordering the Store contract promises. snippet()
    // emits the `[`…`]` highlight markers, matching the JS path + doc-search.
    const sql =
      `SELECT m.topic_id AS topic_id, m.client_msg_id AS client_msg_id,
              m.message_id AS message_id, m.seq AS seq, m.role AS role,
              m.body AS body, m.project_id AS project_id, m.created_at AS created_at,
              bm25(${FTS_TABLE}) AS bm25,
              snippet(${FTS_TABLE}, 0, '[', ']', ' … ', 12) AS snippet
         FROM ${FTS_TABLE}
         JOIN ${TABLE} m ON m.rowid = ${FTS_TABLE}.rowid
        WHERE ${FTS_TABLE} MATCH ?${scope}
        ORDER BY bm25
        LIMIT ?`;

    let rows: SqlRow[];
    try {
      ({ rows } = await this.db.execute(sql, params));
    } catch {
      // Malformed MATCH expression / FTS5 unavailable — treat as no results
      // rather than throwing into the agent turn or the UI search box.
      return [];
    }
    if (rows.length === 0) return [];

    const relNorm = minMaxNormalise(
      rows.map((r) => -(typeof r['bm25'] === 'number' ? r['bm25'] : 0)),
    );
    return rows
      .map((r, i) => {
        const snippet = typeof r['snippet'] === 'string' ? r['snippet'] : '';
        return toHit(rowToMessage(r), relNorm[i]!, snippet);
      })
      .sort((a, b) => b.score - a.score || b.created_at - a.created_at)
      .slice(0, limit);
  }

  private async rowByIdentity(topic_id: string, identity: string): Promise<ChatMessage | null> {
    const { rows } = await this.db.execute(
      `SELECT * FROM ${TABLE} WHERE topic_id = ? AND identity = ? LIMIT 1`,
      [topic_id, identity],
    );
    const row = rows[0];
    return row !== undefined ? rowToMessage(row) : null;
  }

  private async rowByClientMsgId(
    topic_id: string,
    client_msg_id: string,
  ): Promise<ChatMessage | null> {
    if (client_msg_id.length === 0) return null;
    const { rows } = await this.db.execute(
      `SELECT * FROM ${TABLE} WHERE topic_id = ? AND client_msg_id = ? LIMIT 1`,
      [topic_id, client_msg_id],
    );
    const row = rows[0];
    return row !== undefined ? rowToMessage(row) : null;
  }

  private async write(identity: string, msg: ChatMessage): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO ${TABLE}
         (identity, topic_id, client_msg_id, message_id, seq, role, body, project_id, attachments, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity,
        msg.topic_id,
        msg.client_msg_id,
        msg.message_id,
        msg.seq,
        msg.role,
        msg.body,
        msg.project_id,
        msg.attachments !== null ? JSON.stringify(msg.attachments) : null,
        msg.created_at,
        msg.status,
      ],
    );
  }
}

/** Map a raw SQL row back into the canonical {@link ChatMessage}. */
function rowToMessage(row: SqlRow): ChatMessage {
  return {
    topic_id: String(row['topic_id'] ?? ''),
    client_msg_id: String(row['client_msg_id'] ?? ''),
    message_id: row['message_id'] === null || row['message_id'] === undefined
      ? null
      : String(row['message_id']),
    seq: typeof row['seq'] === 'number' ? row['seq'] : null,
    role: row['role'] === 'agent' ? 'agent' : 'user',
    body: String(row['body'] ?? ''),
    project_id: row['project_id'] === null || row['project_id'] === undefined
      ? null
      : String(row['project_id']),
    attachments: parseAttachments(row['attachments']),
    created_at: typeof row['created_at'] === 'number' ? row['created_at'] : 0,
    status: normalizeStatus(row['status']),
  };
}

function parseAttachments(raw: SqlValue | undefined): readonly string[] | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const cleaned = parsed.filter((x): x is string => typeof x === 'string');
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

function normalizeStatus(raw: SqlValue | undefined): ChatMessage['status'] {
  return raw === 'sent' || raw === 'acked' ? raw : 'queued';
}

/** True iff a table (or FTS5 virtual table) named `name` already exists. */
async function tableExists(db: SqliteExecutor, name: string): Promise<boolean> {
  try {
    const { rows } = await db.execute(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
      [name],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Re-derive the FTS mirror from the message table in one pass. Used once, when
 * the index is first created over a message table that already holds rows.
 * `'rebuild'` is FTS5's external-content backfill command; `numberOf` cannot
 * be used to gate this because `COUNT(*)` on an external-content FTS reports
 * the CONTENT row count, not the indexed-doc count (so it can read non-zero
 * while the index is empty). Failure-isolated: if FTS5 isn't compiled in,
 * search simply returns nothing rather than failing the store open.
 */
async function backfillFts(db: SqliteExecutor): Promise<void> {
  try {
    const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    const messages = typeof rows[0]?.['n'] === 'number' ? (rows[0]['n'] as number) : 0;
    if (messages === 0) return;
    await db.execute(`INSERT INTO ${FTS_TABLE}(${FTS_TABLE}) VALUES ('rebuild')`);
  } catch {
    // FTS5 unavailable / transient error — degrade to "no results".
  }
}
