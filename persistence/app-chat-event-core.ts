/**
 * @neutronai/persistence — the generic per-topic event-log core behind the
 * four app-chat stores (messages, receipts, reactions, edits).
 *
 * All four durable app-chat logs repeat ONE mechanism:
 *
 *   append/record idempotently by a store-specific `(topic_id, key)` identity
 *   → order events by a per-topic monotonic `seq` (assigned as MAX(seq)+1 on
 *     message append; resolved from the durable message log for per-message
 *     state like receipts/reactions/edits — never client-trusted)
 *   → replay events after a client's resume cursor (`WHERE seq > after
 *     ORDER BY seq ASC`, bounded by a per-store limit)
 *   → fold rows into the per-message aggregate that fans to clients.
 *
 * This module owns that mechanism once. Each store stays a thin wrapper that
 * keeps its PUBLIC interface unchanged and owns only what genuinely differs:
 * its table/columns, its idempotency/upsert SQL (the conflict keys are pinned
 * by the four suites), authorization (edits), and its aggregate fold.
 *
 * Replay comes in two shapes, preserved exactly from the original stores:
 *  - `row`: one aggregate per row; `limit` bounds ROWS and applies in SQL
 *    (messages, edits — their upsert key holds one row per message).
 *  - `message-group`: many rows per message (per-device receipts, per-device-
 *    emoji reactions); `limit` bounds DISTINCT MESSAGES, so the scan is
 *    grouped in JS preserving first-seen (seq-ascending) order.
 */

import type { ProjectDb } from './db.ts'

/** Clamp a client-supplied resume cursor to a safe non-negative integer. */
export function clampAfterSeq(after_seq: number): number {
  return Number.isFinite(after_seq) ? Math.max(0, Math.trunc(after_seq)) : 0
}

/** Clamp a replay limit to a positive integer, falling back to the store's
 *  default page size when the caller passed a non-finite value. */
export function clampReplayLimit(limit: number, fallback: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : fallback
}

/** How {@link AppChatEventLogCore.aggregatesAfter} turns seq-ascending rows
 *  into aggregates. */
export type ReplayShape<SqlRow, Agg> =
  | {
      /** One aggregate per row; `limit` bounds rows and is applied in SQL. */
      kind: 'row'
      toAggregate: (row: SqlRow) => Agg
    }
  | {
      /** Many rows per message; `limit` caps DISTINCT messages, so rows are
       *  scanned seq-ascending and grouped in JS (Map insertion order keeps
       *  the aggregates seq-ascending). */
      kind: 'message-group'
      messageIdOf: (row: SqlRow) => string
      fold: (message_id: string, rows: SqlRow[]) => Agg
    }

export interface AppChatEventLogCoreOptions<SqlRow, Agg> {
  db: ProjectDb
  /** This log's table. */
  table: string
  /** The SELECT column list every read of this log uses. */
  columns: string
  /** Replay page-size fallback when the caller passes a non-finite limit. */
  defaultReplayLimit: number
  replay: ReplayShape<SqlRow, Agg>
}

/**
 * The shared per-topic event-log mechanism. Generic over the store's SQL row
 * shape and its fanned aggregate. All reads accept an optional `tx` so the
 * same query serves both the standalone methods and the post-record
 * read-back inside the store's `transaction` (what used to be a duplicated
 * `aggregateInTx`).
 */
export class AppChatEventLogCore<SqlRow, Agg> {
  private readonly db: ProjectDb
  private readonly table: string
  private readonly columns: string
  private readonly defaultReplayLimit: number
  private readonly replay: ReplayShape<SqlRow, Agg>

  constructor(opts: AppChatEventLogCoreOptions<SqlRow, Agg>) {
    this.db = opts.db
    this.table = opts.table
    this.columns = opts.columns
    this.defaultReplayLimit = opts.defaultReplayLimit
    this.replay = opts.replay
  }

  /** Run a store mutation inside the DB's serialized transaction. */
  transaction<T>(fn: (tx: ProjectDb) => T): Promise<T> {
    return this.db.transaction<T>(fn)
  }

  /** Highest seq in THIS log for a topic, or 0 when the topic has no rows. */
  maxTopicSeq(topic_id: string, tx: ProjectDb = this.db): number {
    const row = tx
      .prepare<{ max_seq: number | null }, [string]>(
        `SELECT MAX(seq) AS max_seq FROM ${this.table} WHERE topic_id = ?`,
      )
      .get(topic_id)
    return row?.max_seq ?? 0
  }

  /** Next monotonic per-topic seq for an append into THIS log. */
  nextTopicSeq(topic_id: string, tx: ProjectDb): number {
    return this.maxTopicSeq(topic_id, tx) + 1
  }

  /** First row matching this log's `(topic_id, keyColumn)` identity — the
   *  store-specific idempotency key (e.g. a re-sent `client_msg_id`). */
  firstRowByKey(
    topic_id: string,
    keyColumn: string,
    key: string,
    tx: ProjectDb = this.db,
  ): SqlRow | null {
    const row = tx
      .prepare<SqlRow, [string, string]>(
        `SELECT ${this.columns} FROM ${this.table}
          WHERE topic_id = ? AND ${keyColumn} = ?`,
      )
      .get(topic_id, key)
    return row ?? null
  }

  /** All rows in THIS log for one message (per-device / per-emoji state). */
  rowsForMessage(topic_id: string, message_id: string, tx: ProjectDb = this.db): SqlRow[] {
    return tx
      .prepare<SqlRow, [string, string]>(
        `SELECT ${this.columns} FROM ${this.table}
          WHERE topic_id = ? AND message_id = ?`,
      )
      .all(topic_id, message_id)
  }

  /** The single row in THIS log for one message (upsert key = one row). */
  firstRowForMessage(
    topic_id: string,
    message_id: string,
    tx: ProjectDb = this.db,
  ): SqlRow | null {
    const row = tx
      .prepare<SqlRow, [string, string]>(
        `SELECT ${this.columns} FROM ${this.table}
          WHERE topic_id = ? AND message_id = ?
          LIMIT 1`,
      )
      .get(topic_id, message_id)
    return row ?? null
  }

  /** Look up a message's durable `(seq, role)` from the app_chat_messages
   *  log — never trust a client-asserted seq. Null when the message is
   *  unknown. */
  lookupMessage(
    message_id: string,
    tx: ProjectDb = this.db,
  ): { seq: number | null; role: string | null } | null {
    const row = tx
      .prepare<{ seq: number | null; role: string | null }, [string]>(
        `SELECT seq, role FROM app_chat_messages WHERE message_id = ? LIMIT 1`,
      )
      .get(message_id)
    return row ?? null
  }

  /** A message's durable seq, 0 when unknown (defensive: such an event simply
   *  won't make the resume replay window). */
  resolveMessageSeq(message_id: string, tx: ProjectDb = this.db): number {
    return this.lookupMessage(message_id, tx)?.seq ?? 0
  }

  /** Next monotonic per-(topic, message) rev in THIS log: one higher than any
   *  rev the message has seen (active or tombstoned), so every change
   *  strictly advances rev — the last-writer-wins key clients order by. */
  nextMessageRev(topic_id: string, message_id: string, tx: ProjectDb): number {
    const row = tx
      .prepare<{ next: number }, [string, string]>(
        `SELECT COALESCE(MAX(rev), 0) + 1 AS next
           FROM ${this.table}
          WHERE topic_id = ? AND message_id = ?`,
      )
      .get(topic_id, message_id)
    return row?.next ?? 1
  }

  /** Replay: aggregates for events with `seq > after_seq`, seq-ascending,
   *  bounded by `limit` (rows or distinct messages per the replay shape). */
  aggregatesAfter(topic_id: string, after_seq: number, limit: number): Agg[] {
    const safeAfter = clampAfterSeq(after_seq)
    const safeLimit = clampReplayLimit(limit, this.defaultReplayLimit)
    if (this.replay.kind === 'row') {
      const rows = this.db
        .prepare<SqlRow, [string, number, number]>(
          `SELECT ${this.columns} FROM ${this.table}
            WHERE topic_id = ? AND seq > ?
            ORDER BY seq ASC
            LIMIT ?`,
        )
        .all(topic_id, safeAfter, safeLimit)
      const { toAggregate } = this.replay
      return rows.map((r) => toAggregate(r))
    }
    const rows = this.db
      .prepare<SqlRow, [string, number]>(
        `SELECT ${this.columns} FROM ${this.table}
          WHERE topic_id = ? AND seq > ?
          ORDER BY seq ASC`,
      )
      .all(topic_id, safeAfter)
    return groupIntoAggregates(rows, safeLimit, this.replay)
  }
}

/** Group seq-ordered rows (spanning many messages) into per-message
 *  aggregates, preserving seq order and capping at `limit` distinct
 *  messages. */
function groupIntoAggregates<SqlRow, Agg>(
  rows: SqlRow[],
  limit: number,
  shape: {
    messageIdOf: (row: SqlRow) => string
    fold: (message_id: string, rows: SqlRow[]) => Agg
  },
): Agg[] {
  const byMessage = new Map<string, SqlRow[]>()
  for (const r of rows) {
    const message_id = shape.messageIdOf(r)
    let list = byMessage.get(message_id)
    if (list === undefined) {
      if (byMessage.size >= limit) continue
      list = []
      byMessage.set(message_id, list)
    }
    list.push(r)
  }
  const out: Agg[] = []
  for (const [message_id, group] of byMessage) {
    out.push(shape.fold(message_id, group))
  }
  // Map preserves first-seen (seq-ascending) insertion order.
  return out
}
