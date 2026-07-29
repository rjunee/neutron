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
 *    emoji reactions); `limit` bounds DISTINCT MESSAGES. The SQL scan itself
 *    is bounded to the page (a subquery finds the first `limit` distinct
 *    `(seq, message_id)` pairs after the cursor and caps the row range scan
 *    to that boundary pair — it never pulls every row after the cursor into
 *    memory before capping in JS), then rows are grouped preserving first-seen
 *    (seq-, then message_id-ascending) order. See
 *    {@link AppChatEventLogCore.aggregatesAfterPage} for the message-identity
 *    continuation cursor this shape returns when a page is capped.
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

/**
 * A message-identity continuation cursor for {@link AppChatEventLogCore.aggregatesAfterPage}.
 *
 * A plain `seq` is NOT a safe page boundary: `seq` is monotonic PER TOPIC, but
 * a receipt/reaction row stores the caller-supplied `topic_id` while resolving
 * its `seq` from the globally-keyed message log — so a row recorded under topic
 * C for a `message_id` that actually lives in topic A carries topic A's seq.
 * Two DISTINCT messages can therefore collide on one `seq` under a single topic
 * query. Paging by raw `seq` would then treat them as one page slot (silently
 * dropping the second and reporting "done" early). The cursor is the composite
 * `(seq, message_id)` — the same shape the SQL orders + bounds by — so it can
 * disambiguate equal seqs and resume mid-collision without dropping or
 * double-counting.
 */
export interface ReplayCursor {
  seq: number
  message_id: string
}

/** A bounded replay page: at most `limit` DISTINCT-MESSAGE aggregates plus a
 *  continuation cursor when more messages exist past the page. See
 *  {@link AppChatEventLogCore.aggregatesAfterPage}. */
export interface AggregatesPage<Agg> {
  aggregates: Agg[]
  /** Pass as the next call's `(after_seq, after_message_id)` to fetch the
   *  remainder. `null` when everything after the cursor fit within `limit` —
   *  there is genuinely nothing more to fetch. */
  next_cursor: ReplayCursor | null
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

  /** Replay: aggregates for events after the cursor, seq-ascending, bounded by
   *  `limit` (rows or distinct messages per the replay shape). Identical output
   *  to {@link aggregatesAfterPage}'s `aggregates` — this is a thin convenience
   *  for callers that don't need the continuation cursor. */
  aggregatesAfter(
    topic_id: string,
    after_seq: number,
    limit: number,
    after_message_id?: string,
  ): Agg[] {
    if (this.replay.kind === 'row') {
      const safeAfter = clampAfterSeq(after_seq)
      const safeLimit = clampReplayLimit(limit, this.defaultReplayLimit)
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
    return this.aggregatesAfterPage(topic_id, after_seq, limit, after_message_id).aggregates
  }

  /**
   * Replay a bounded PAGE of aggregates after the `(after_seq, after_message_id)`
   * cursor, ascending, plus a {@link ReplayCursor} `next_cursor` when more
   * messages exist past the page (call again with its `seq`/`message_id` to
   * fetch the remainder, rather than the tail being silently dropped).
   *
   * Row-shaped logs (`limit` bounds rows directly in SQL) never have a "tail"
   * beyond what `LIMIT` already fetched in one pass — a capped result there just
   * means "call again with the last row's seq", which `aggregatesAfter` already
   * supports — so this always reports `next_cursor: null` for them.
   *
   * `message-group` logs are where the cursor matters: many rows can share one
   * message, so `limit` bounds DISTINCT MESSAGES, not rows. Crucially the page
   * boundary is the composite `(seq, message_id)`, NOT raw `seq`: because a
   * row's stored `topic_id` is caller-supplied while its `seq` is resolved from
   * the globally-keyed message log, two distinct messages can collide on one
   * `seq` under a single topic query (see {@link ReplayCursor}). The page is
   * found in two steps: a probe selects the first `limit + 1` DISTINCT `(seq,
   * message_id)` pairs after the cursor (the `+1` proves whether more exist,
   * mirroring `ButtonStore.listHistoryByTopic`'s `LIMIT + 1` "has more" trick —
   * no second round trip), then the row scan fetches EXACTLY those probed
   * message ids. Scanning the pinned id set (rather than re-deriving a
   * `(seq, message_id) <= boundary` range) makes the two-statement read
   * snapshot-independent: a concurrent write inserting a late older-seq message
   * between probe and scan cannot displace a page member and silently drop the
   * boundary. This also never materializes rows beyond the page (unlike the old
   * unconditional `WHERE seq > ?` scan) and never miscounts colliding seqs as
   * one page slot (which would drop a message and report "done" early).
   */
  aggregatesAfterPage(
    topic_id: string,
    after_seq: number,
    limit: number,
    after_message_id?: string,
  ): AggregatesPage<Agg> {
    const safeAfter = clampAfterSeq(after_seq)
    const safeLimit = clampReplayLimit(limit, this.defaultReplayLimit)
    const replay = this.replay
    if (replay.kind === 'row') {
      const rows = this.db
        .prepare<SqlRow, [string, number, number]>(
          `SELECT ${this.columns} FROM ${this.table}
            WHERE topic_id = ? AND seq > ?
            ORDER BY seq ASC
            LIMIT ?`,
        )
        .all(topic_id, safeAfter, safeLimit)
      const { toAggregate } = replay
      return { aggregates: rows.map((r) => toAggregate(r)), next_cursor: null }
    }

    // Lower bound — rows strictly after the cursor. A bare numeric `after_seq`
    // (first-page, or a client resume that only tracks seq) means "everything
    // with seq strictly greater" — it must NOT re-include messages AT
    // `after_seq`. Only a resume from a real `(seq, message_id)` boundary adds
    // the tuple tiebreaker to walk the rest of a partially-consumed seq. Both
    // forms are index-range terminators against the `(topic_id, seq,
    // message_id)` index (SQLite row-value `(a, b) > (?, ?)`), so the scan
    // starts inside the page — never a topic-wide walk. (Same branch-on-
    // tiebreaker shape as `ButtonStore.listHistoryByTopic`.)
    const hasTiebreak = after_message_id !== undefined
    const lowerClause = hasTiebreak ? '(seq, message_id) > (?, ?)' : 'seq > ?'
    const lowerParams: Array<string | number> = hasTiebreak
      ? [safeAfter, after_message_id as string]
      : [safeAfter]

    // The first `limit + 1` DISTINCT messages after the cursor, as `(seq,
    // message_id)` pairs (one pair per message — all of a message's replayed
    // rows share its resolved seq). The `(topic_id, seq, message_id)` index
    // (migration 0101) covers this DISTINCT + ORDER BY so it early-terminates at
    // LIMIT — no `USE TEMP B-TREE FOR DISTINCT` full-backlog materialization.
    const idRows = this.db
      .prepare<{ seq: number; message_id: string }, Array<string | number>>(
        `SELECT DISTINCT seq, message_id FROM ${this.table}
          WHERE topic_id = ? AND ${lowerClause}
          ORDER BY seq ASC, message_id ASC
          LIMIT ?`,
      )
      .all(topic_id, ...lowerParams, safeLimit + 1)
    if (idRows.length === 0) return { aggregates: [], next_cursor: null }

    const has_more = idRows.length > safeLimit
    // The page is exactly the first `safeLimit` probed messages (or all of them
    // when not capped); the boundary is the last one.
    const pageIds = has_more ? idRows.slice(0, safeLimit) : idRows
    const boundary = pageIds[pageIds.length - 1]!

    // Scan EXACTLY the probed page's messages by their ids — NOT a re-derived
    // `(seq, message_id) <= boundary` range. The probe and this scan are
    // separate statements with no shared snapshot; a concurrent write could
    // insert a row for an OLDER message (a late receipt/reaction for a
    // lower-seq message) between them. A re-derived range scan would then pick
    // that extra message up, and the `groupIntoAggregates` cap would evict the
    // boundary message from the page while `next_cursor` still advanced past it
    // — silently dropping it forever. Pinning the scan to the probed ids makes
    // it snapshot-independent: the message SET is fixed by the probe, so a
    // late older row can't displace a page member. `${lowerClause}` is retained
    // so a rare seq-0 straggler row for a page message stays excluded (exact
    // pre-existing aggregate for the common case). The `(topic_id, message_id)`
    // PK prefix indexes the IN-list, so the scan stays bounded to the page.
    const placeholders = pageIds.map(() => '?').join(', ')
    const rows = this.db
      .prepare<SqlRow, Array<string | number>>(
        `SELECT ${this.columns} FROM ${this.table}
          WHERE topic_id = ?
            AND ${lowerClause}
            AND message_id IN (${placeholders})
          ORDER BY seq ASC, message_id ASC`,
      )
      .all(topic_id, ...lowerParams, ...pageIds.map((p) => p.message_id))

    const aggregates = groupIntoAggregates(rows, safeLimit, replay)
    return {
      aggregates,
      next_cursor: has_more ? { seq: boundary.seq, message_id: boundary.message_id } : null,
    }
  }
}

/** Group `(seq, message_id)`-ordered rows (spanning many messages) into
 *  per-message aggregates, preserving that order and capping at `limit`
 *  distinct messages (a defensive net — the SQL scan already bounds the input
 *  to exactly one page of messages). */
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
  // Map preserves first-seen (seq-, then message_id-ascending) insertion order.
  return out
}
