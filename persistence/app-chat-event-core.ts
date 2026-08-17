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
 *   → replay events after a client's resume cursor (`WHERE seq > after`, bounded
 *     by a per-store limit, delivered seq-ascending)
 *   → fold rows into the per-message aggregate that fans to clients.
 *
 * This module owns that mechanism once. Each store stays a thin wrapper that
 * keeps its PUBLIC interface unchanged and owns only what genuinely differs:
 * its table/columns, its idempotency/upsert SQL (the conflict keys are pinned
 * by the four suites), authorization (edits), and its aggregate fold.
 *
 * Replay comes in two shapes, preserved exactly from the original stores:
 *  - `row`: one aggregate per row; `limit` bounds ROWS and applies in SQL
 *    (messages, edits — their upsert key holds one row per message). A capped
 *    result is the NEWEST `limit` rows STRICTLY BELOW an optional `before_seq`
 *    and after the cursor, re-sorted ascending. The older remainder is omitted
 *    from THAT page and reachable by asking again with `before_seq` set to the
 *    page's lowest seq — which is how a client walks backwards through a
 *    transcript longer than one window ({@link AppChatEventLogCore.rowsAfter}
 *    carries the full argument and the cost of the alternative).
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
 * Clamp an optional EXCLUSIVE upper bound on a replay window — the backwards
 * half of the cursor pair. `undefined` (and any non-finite value) means "no
 * upper bound", which is the whole pre-existing behaviour; a value at or below
 * 1 can never admit a row (seqs start at 1) and is kept as-is so the query
 * returns nothing rather than silently widening to the newest page.
 */
export function clampBeforeSeq(before_seq: number | undefined): number | undefined {
  if (before_seq === undefined || !Number.isFinite(before_seq)) return undefined
  return Math.max(0, Math.trunc(before_seq))
}

/**
 * The `row`-shaped replay statement, as a string, so a test can put EXPLAIN QUERY
 * PLAN in front of the SQL THIS CODE ACTUALLY RUNS rather than in front of a copy
 * of it in the test. {@link AppChatEventLogCore.rowsAfter} is its only caller and
 * carries the reasoning; exported purely so the plan assertion cannot go stale
 * against a re-worded query.
 *
 * DESCENDING, and the caller reverses the (at most `limit`) rows in memory. The
 * obvious alternative — wrapping this in `SELECT * FROM (...) ORDER BY seq ASC` —
 * was written first and measured second: SQLite plans the outer clause as
 * `USE TEMP B-TREE FOR ORDER BY`, re-sorting the page it just read in index order.
 * Bounded, but pointless, and it made the plan assertion read as though the query
 * still sorted. One `Array.prototype.reverse` costs nothing and leaves a plan with
 * no sort in it at all.
 *
 * `bounded` adds the EXCLUSIVE upper bound a backwards page needs (`seq < ?`).
 * Both variants are index-range terminators against the same `(topic_id, seq)`
 * index, so neither sorts nor scans — the EXPLAIN assertion in
 * `app-chat-event-core.test.ts` covers BOTH strings, for both row-shaped tables,
 * because a bounded page is now on the resume path rather than hypothetical.
 *
 * Parameters, in order: `topic_id`, `after_seq`, `before_seq` (only when
 * `bounded`), `limit`.
 */
export function rowReplaySql(table: string, columns: string, bounded = false): string {
  return `SELECT ${columns} FROM ${table}
            WHERE topic_id = ? AND seq > ?${bounded ? ' AND seq < ?' : ''}
            ORDER BY seq DESC
            LIMIT ?`
}

/**
 * The `row`-shaped SWEEP statement: EVERY row at or below `max_seq`, ascending.
 * Exported for the same reason {@link rowReplaySql} is — the EXPLAIN QUERY PLAN
 * assertion has to see the string this code runs.
 *
 * DELIBERATELY UNBOUNDED IN COUNT, and that is the whole point of it rather than an
 * oversight, so the reasoning belongs here where the `LIMIT` visibly isn't.
 *
 * {@link rowReplaySql} answers "the newest page", which is the right shape for a
 * range the caller does not yet hold. It is the WRONG shape for a range the caller
 * ALREADY HOLDS AND IS RENDERING, because every row it drops is a row whose state
 * the caller keeps showing from its own store. Cap this and the cap is a starvation
 * budget: the newest `limit` rows win, an OLD row loses every time, and losing every
 * time is permanent. That is not a hypothetical — it is exactly how a tombstone for a
 * low-seq message stayed unsent to a device that had the message on screen, which is
 * a delete that did not happen.
 *
 * SO THE COST IS STATED INSTEAD OF BOUNDED. Rows returned = rows in `table` for this
 * topic at or below `max_seq` — for the edits table, one per message the owner has
 * ever edited or deleted inside the range the device holds.
 *
 * It is an index range scan on `(topic_id, seq)` with NO SORT, PLUS ONE TABLE ROW FETCH
 * PER MATCHED ROW. Not a covering scan, and an earlier version of this paragraph
 * claimed it was: `idx_app_chat_edits_topic_seq` indexes `(topic_id, seq)` only
 * (`migrations/0087_app_chat_edits.sql`) while the sweep selects `message_id`, `rev`,
 * `body`, `deleted` and `edited_at`, so SQLite must visit the table for every row.
 * Measured, with a control that can tell the two apart: the real projection plans as
 * `SEARCH … USING INDEX`, and the same query narrowed to `seq` alone plans as `USING
 * COVERING INDEX`. Making it covering would mean indexing the body, which is the
 * largest column in the table, to save a lookup on a query whose row count is already
 * proportional to real edits — so the fetch stays and the claim is corrected instead.
 *
 * The count is proportional to real edits, not to the transcript. On the longest topic
 * the owner has reported (1,130 rows) a handful of deletes is a handful of rows. A topic
 * with thousands of edited messages pays thousands of rows per forward resume — and that
 * is the honest trade, because the only way to send fewer is to send an incomplete
 * answer, and an incomplete answer here is content the owner deleted staying readable.
 *
 * AND `max_seq` COMES FROM THE CLIENT, so the worst case is not merely eventual — it is
 * reachable on demand. A resume frame carries its own `after_seq`
 * (`channels/adapters/app-ws/envelope.ts`), so any socket can ask for a sweep of the
 * WHOLE topic by naming a cursor above the high-water mark, and pay the full edit count
 * rather than the count below what it actually holds. That is bounded — by this topic's
 * own edit rows, never by the transcript — and the socket is authenticated to a single
 * owner's own topic, so the party who can drive the maximum is the party whose data it
 * is. Worth knowing rather than worth gating: a limit here is the starvation budget the
 * paragraphs above exist to reject.
 *
 * ASCENDING here rather than DESC-then-reverse: with no `LIMIT` there is no page to
 * reverse, and the index already yields this order, so the plan has no sort either
 * way.
 *
 * Parameters, in order: `topic_id`, `max_seq`.
 */
export function rowSweepSql(table: string, columns: string): string {
  return `SELECT ${columns} FROM ${table}
            WHERE topic_id = ? AND seq > 0 AND seq <= ?
            ORDER BY seq ASC`
}

/**
 * A message-identity continuation cursor for {@link AppChatEventLogCore.aggregatesAfterPage}.
 *
 * The cursor is the composite `(seq, message_id)` — the same shape the SQL orders
 * and bounds by — so a page boundary is a MESSAGE, not a number. Paging by raw
 * `seq` would treat two messages sharing a seq as ONE page slot, silently dropping
 * the second and reporting "done" early.
 *
 * IT IS NOW DEFENCE IN DEPTH RATHER THAN LOAD-BEARING, and the reason is worth
 * writing down because it used to be the other way round. Colliding seqs were
 * REACHABLE: the message lookup was not topic-scoped, so a row recorded under topic
 * C for a `message_id` living in topic A carried topic A's seq — an arbitrary
 * number in C's ordering, and in the edits log a high one sorted newest and evicted
 * a real tombstone from a capped window ({@link AppChatEventLogCore.lookupMessage}
 * has the full cost). With the lookup scoped, a message this topic does not hold
 * resolves to seq 0, and `app_chat_messages` is keyed `(topic_id, seq)`, so within
 * one topic no two replayable messages can share a seq. Seq-0 rows can still
 * collide with each other, but replay is `seq > after_seq` with a floor of 0, so
 * they never enter a page at all.
 *
 * The composite cursor stays because it costs nothing and because the invariant it
 * protects is now enforced by a UNIQUE index rather than by a comment — which is
 * exactly the state in which a defensive mechanism is cheap to keep and expensive
 * to remove.
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
  /**
   * Pass as the next call's `(after_seq, after_message_id)` to fetch the
   * remainder. `null` when everything after the cursor fit within `limit`.
   *
   * EXCEPTION the type cannot express: a `row`-shaped log always reports `null`,
   * capped or not, because it does not page FORWARD. A row log returns the NEWEST
   * `limit` rows in its range ({@link AppChatEventLogCore.rowsAfter}), so its
   * continuation runs BACKWARDS: a full page means older rows may remain, and the
   * caller asks for them by passing that page's lowest seq as the next call's
   * `before_seq`. Reading `null` off a row log as proof of completeness is
   * therefore still wrong — a full page is the signal, and the caller that acts on
   * it is `AppWsAdapter.replayAfter`, which turns it into the wire's
   * `history_gap`. Only `message-group` logs use this cursor, and there it does
   * mean the backlog is drained.
   */
  next_cursor: ReplayCursor | null
}

/** How {@link AppChatEventLogCore.aggregatesAfter} turns seq-ascending rows
 *  into aggregates. */
export type ReplayShape<SqlRow, Agg> =
  | {
      /** One aggregate per row; `limit` bounds rows and is applied in SQL, to
       *  the NEWEST `limit` rows after the cursor, returned ascending
       *  ({@link AppChatEventLogCore.rowsAfter} explains why newest). */
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

  /**
   * Look up a message's durable `(seq, role)` from the app_chat_messages log —
   * never trust a client-asserted seq. Null when the message is unknown IN THIS
   * TOPIC.
   *
   * SCOPED BY TOPIC, and that scope is a correctness requirement rather than
   * hygiene. `seq` is monotonic PER TOPIC, so a seq resolved from another topic's
   * message is a number with no meaning in this one — and every row-shaped replay
   * window here is ordered and bounded by `seq`. An unscoped lookup let a client
   * connected to topic C name a `message_id` living in topic A, and the row was
   * then written under topic C carrying topic A's seq. Two consequences, both
   * shipped: topic A's high seqs sort NEWEST in topic C's descending window, so
   * one alien row can evict a real tombstone from a capped edit replay and the
   * DELETED MESSAGE COMES BACK with its original body (the message log is an
   * immutable overlay — migration 0087 — so the body is only struck by the
   * `edit_update` that the eviction dropped); and the delete the owner asked for
   * was filed under the wrong topic, so it never tombstones the message in topic A
   * either. Scoping the lookup makes such a message simply unknown, which the
   * edits store already rejects as `message not found`.
   */
  lookupMessage(
    topic_id: string,
    message_id: string,
    tx: ProjectDb = this.db,
  ): { seq: number | null; role: string | null } | null {
    const row = tx
      .prepare<{ seq: number | null; role: string | null }, [string, string]>(
        `SELECT seq, role FROM app_chat_messages
          WHERE topic_id = ? AND message_id = ? LIMIT 1`,
      )
      .get(topic_id, message_id)
    return row ?? null
  }

  /** A message's durable seq WITHIN THIS TOPIC, 0 when unknown (defensive: such
   *  an event simply won't make the resume replay window — which is exactly what
   *  should happen to a receipt/reaction naming another topic's message; see
   *  {@link lookupMessage} for why a cross-topic seq is not a seq at all). */
  resolveMessageSeq(topic_id: string, message_id: string, tx: ProjectDb = this.db): number {
    return this.lookupMessage(topic_id, message_id, tx)?.seq ?? 0
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

  /**
   * The `row`-shaped replay window: the NEWEST `limit` rows in the half-open
   * range `(after_seq, before_seq)`, returned seq-ASCENDING. Sole owner of that
   * SQL — {@link aggregatesAfter} and {@link aggregatesAfterPage} both call it, so
   * their row-shape output cannot drift apart. (They previously held two
   * hand-copied versions of it, which is how a page could end up ordered one way
   * in one method and the other way in the other.)
   *
   * WHY NEWEST AND NOT OLDEST. The plain `WHERE seq > ? ORDER BY seq ASC LIMIT ?`
   * this replaced returned the OLDEST `limit` rows, so a 1130-row topic answered a
   * cold resume with seq 1..500: the owner's chat rendered the OLDEST 500 and
   * stopped ~630 messages short of the present, with nothing on the wire saying
   * anything was missing. Selecting DESC off the index and reversing the (at most
   * `limit`) rows in memory keeps the wire contract — envelopes ascending, applied
   * in order — while putting the window at the end of the transcript the owner is
   * actually looking at.
   *
   * WHY `before_seq` EXISTS, and why the newest window is no longer lossy. A page
   * bounded on one side only is reachable from one side only. The resume cursor is
   * the client's MAX applied seq and it moves FORWARD, so a capped newest-window
   * page advanced that cursor past the rows it had just skipped, and no later
   * resume could ask for them: a self-healing "missing the newest N" became a
   * permanent "missing a middle N". (That trade was accepted on the premise that
   * resume fires exactly once per socket open. The premise was false — see
   * `app/lib/chat-core/mobile-session.ts` `catchUp`, which re-resumes on every
   * foreground and every foregrounded push over an already-open socket, so the
   * OLD ascending window paged forward and eventually covered everything, slowly.
   * The newest window without a backwards bound was the first shape that could
   * lose a range for good.)
   *
   * `before_seq` is that missing side. A client that received a capped page asks
   * again with `before_seq` = the page's lowest seq and gets the newest `limit`
   * rows below it; each page is contiguous with the last, each request strictly
   * lowers the bound, and the walk terminates at the first page that is not full.
   * `undefined` means no upper bound — byte-identical to the pre-existing query,
   * which is what keeps every forward resume unchanged.
   *
   * BYTE-IDENTICAL AT OR BELOW THE LIMIT: when at most `limit` rows fall in the
   * range, all of them are selected and the reversal restores exactly the
   * ascending page the old SQL produced. Every gap-fill assertion that resumes
   * from a non-zero cursor therefore holds unchanged — this is a no-op until the
   * backlog exceeds one page.
   *
   * NO SCAN REGRESSION: `seq` is the trailing column of the `(topic_id, seq)`
   * PRIMARY KEY on the messages table (`migrations/0079_app_chat_messages.sql`)
   * and of `idx_app_chat_edits_topic_seq` on the edits table
   * (`migrations/0087_app_chat_edits.sql`), so SQLite walks the same index
   * backwards and early-terminates at LIMIT rather than sorting — with or without
   * the upper bound, which only narrows the same range. MEASURED, not assumed:
   * `app-chat-event-core.test.ts` runs EXPLAIN QUERY PLAN over
   * {@link rowReplaySql} — the very string prepared here — and asserts the plan
   * contains no sort and no table scan, for both variants and both row-shaped
   * tables. That test is why the reversal happens in memory: the first draft
   * wrapped the query in an outer `ORDER BY seq ASC` and the plan came back with a
   * temp B-tree.
   *
   * STILL ONE BOUNDED READ. This never drains: one call is one page, and a client
   * walking backwards pays one round trip per page. Draining every row after the
   * cursor inside a single call is what must not happen — it makes one cold resume
   * O(transcript) in rows, JSON bytes and adapter memory, per topic, which the
   * mobile warmer then multiplies by every scope it warms at app open
   * (`app/lib/chat-core/transcript-warmer.ts` sizes its fan-out on exactly that
   * per-topic ceiling).
   */
  private rowsAfter(
    topic_id: string,
    after_seq: number,
    limit: number,
    before_seq?: number,
  ): SqlRow[] {
    const safeAfter = clampAfterSeq(after_seq)
    const safeLimit = clampReplayLimit(limit, this.defaultReplayLimit)
    const safeBefore = clampBeforeSeq(before_seq)
    // Read newest-first off the index, hand back oldest-first: `.all()` returns a
    // fresh array of at most `safeLimit` rows, so reversing it in place is O(limit)
    // and cheaper than asking SQLite to re-sort the page it just read in order.
    const params: Array<string | number> =
      safeBefore === undefined
        ? [topic_id, safeAfter, safeLimit]
        : [topic_id, safeAfter, safeBefore, safeLimit]
    return this.db
      .prepare<SqlRow, Array<string | number>>(
        rowReplaySql(this.table, this.columns, safeBefore !== undefined),
      )
      .all(...params)
      .reverse()
  }

  /**
   * The SWEEP counterpart to {@link rowsAfter}: EVERY row at or below `max_seq`,
   * ascending, with no page limit. `row`-shaped logs only — see
   * {@link aggregatesAtOrBelow}.
   */
  private rowsAtOrBelow(topic_id: string, max_seq: number): SqlRow[] {
    return this.db
      .prepare<SqlRow, [string, number]>(rowSweepSql(this.table, this.columns))
      .all(topic_id, clampAfterSeq(max_seq))
  }

  /**
   * Aggregates for EVERY event at or below `max_seq`, ascending — the complete
   * answer for a seq range, as opposed to {@link aggregatesAfter}'s newest page.
   *
   * WHICH ONE A CALLER WANTS IS DECIDED BY WHO HOLDS THE MESSAGES, not by taste.
   * A page is correct for a range the client does not have yet: it is going to
   * receive those messages in a page too, and the pair is aligned. A page is WRONG
   * for the range the client already holds, because there the omitted rows are
   * state the client keeps rendering from its own store, and a newest-first page
   * omits the same OLD rows on every single resume. See {@link rowSweepSql} for the
   * cost this trades for that completeness, and why no `limit` parameter exists here
   * to be tuned.
   *
   * `row`-shaped logs only. A `message-group` log's `limit` bounds DISTINCT
   * MESSAGES over many rows and its page boundary is the composite
   * `(seq, message_id)` ({@link ReplayCursor}); an unbounded sweep of one is a
   * different query with different failure modes, and no caller needs it — the
   * receipt/reaction replays are the message-group ones and their omissions cost a
   * missing tick or a missing reaction, never content the owner deleted staying
   * readable. It throws rather than silently returning a page, so a future caller
   * cannot get a bounded answer from a method whose contract says complete.
   */
  aggregatesAtOrBelow(topic_id: string, max_seq: number): Agg[] {
    if (this.replay.kind !== 'row') {
      throw new Error(`aggregatesAtOrBelow is row-shaped only (${this.table} is message-group)`)
    }
    const { toAggregate } = this.replay
    return this.rowsAtOrBelow(topic_id, max_seq).map((r) => toAggregate(r))
  }

  /** Replay: aggregates for events after the cursor, seq-ascending, bounded by
   *  `limit` (rows or distinct messages per the replay shape) and optionally by an
   *  exclusive `before_seq` upper bound. A `row`-shaped log returns the NEWEST
   *  `limit` rows in that range, ascending ({@link rowsAfter}) — one bounded query,
   *  and the older remainder is fetched by asking again with `before_seq` set to
   *  the page's lowest seq. A `message-group` log returns a true first page plus a
   *  continuation cursor. Identical output to {@link aggregatesAfterPage}'s
   *  `aggregates` — this is a thin convenience for callers that don't need the
   *  continuation cursor. */
  aggregatesAfter(
    topic_id: string,
    after_seq: number,
    limit: number,
    after_message_id?: string,
    before_seq?: number,
  ): Agg[] {
    if (this.replay.kind === 'row') {
      const { toAggregate } = this.replay
      return this.rowsAfter(topic_id, after_seq, limit, before_seq).map((r) => toAggregate(r))
    }
    return this.aggregatesAfterPage(topic_id, after_seq, limit, after_message_id, before_seq)
      .aggregates
  }

  /**
   * Replay a bounded PAGE of aggregates after the `(after_seq, after_message_id)`
   * cursor, ascending, plus a {@link ReplayCursor} `next_cursor` when more
   * messages exist past the page (call again with its `seq`/`message_id` to
   * fetch the remainder, rather than the tail being silently dropped).
   *
   * Row-shaped logs report `next_cursor: null` unconditionally, and for THEM it
   * carries no information at all — see the exception spelled out on
   * {@link AggregatesPage.next_cursor}. Their result is the NEWEST `limit` rows
   * after the cursor ({@link rowsAfter}), so a capped one has dropped its older
   * rows; do not read a null cursor off a row log as proof of completeness.
   *
   * THE OLDER ROWS ARE REACHABLE, by the OTHER bound. This said "no cursor could
   * fetch them back", which was true of the shape before `before_seq` existed and
   * false the moment it did — the whole point of that parameter is that a caller
   * which received a capped page asks again with `before_seq` set to the page's
   * lowest seq and receives the page below (see {@link rowsAfter}). What remains
   * true is the narrow claim: `next_cursor` is not the thing that fetches them, so
   * a row-log caller that watches only the cursor learns nothing. Left uncorrected
   * this reads as documentation that the backwards walk is impossible, which is
   * the reasoning that produced the permanent hole in the first place.
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
    before_seq?: number,
  ): AggregatesPage<Agg> {
    const safeAfter = clampAfterSeq(after_seq)
    const safeLimit = clampReplayLimit(limit, this.defaultReplayLimit)
    const safeBefore = clampBeforeSeq(before_seq)
    const replay = this.replay
    if (replay.kind === 'row') {
      const { toAggregate } = replay
      const rows = this.rowsAfter(topic_id, after_seq, limit, before_seq)
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
    // The same EXCLUSIVE upper bound the row shape takes, so a caller walking a
    // transcript backwards can pin per-message state to the page it is fetching
    // instead of re-draining the whole topic once per page. Absent → unbounded
    // above, which is the pre-existing query.
    const rangeClause =
      safeBefore === undefined ? lowerClause : `${lowerClause} AND seq < ?`
    const rangeParams: Array<string | number> =
      safeBefore === undefined ? lowerParams : [...lowerParams, safeBefore]

    // The first `limit + 1` DISTINCT messages after the cursor, as `(seq,
    // message_id)` pairs (one pair per message — all of a message's replayed
    // rows share its resolved seq). The `(topic_id, seq, message_id)` index
    // (migration 0101) covers this DISTINCT + ORDER BY so it early-terminates at
    // LIMIT — no `USE TEMP B-TREE FOR DISTINCT` full-backlog materialization.
    const idRows = this.db
      .prepare<{ seq: number; message_id: string }, Array<string | number>>(
        `SELECT DISTINCT seq, message_id FROM ${this.table}
          WHERE topic_id = ? AND ${rangeClause}
          ORDER BY seq ASC, message_id ASC
          LIMIT ?`,
      )
      .all(topic_id, ...rangeParams, safeLimit + 1)
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
            AND ${rangeClause}
            AND message_id IN (${placeholders})
          ORDER BY seq ASC, message_id ASC`,
      )
      .all(topic_id, ...rangeParams, ...pageIds.map((p) => p.message_id))

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
