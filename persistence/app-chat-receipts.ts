/**
 * @neutronai/persistence — durable per-(message, device) receipt log for the
 * `app_socket` (Expo / web) WebSocket surface (Track B Phase 4).
 *
 * Backs delivery + read receipts: the gateway records a `delivered` receipt
 * for every device connected at a message's fan-out time, the agent loop
 * records `read` the moment it picks up an inbound user message, and a client
 * reports `read` when a message is viewed. The aggregate (`delivered_by[]` /
 * `read_by[]`) is stamped inline on the outbound message envelope and re-fanned
 * as a `receipt_update`; the client's chat-core engine set-unions it onto the
 * local row so the per-message ladder advances. See migration
 * `0081_app_chat_receipts.sql` for the schema rationale.
 *
 * The {@link AppChatReceiptLog} interface is what the app-ws adapter depends
 * on, so the adapter stays DB-agnostic and unit-testable with an in-memory
 * fake; {@link AppChatReceiptStore} is the SQLite implementation wired in the
 * gateway composition alongside {@link AppChatStore}. The seq-resolution and
 * replay mechanics live in the shared {@link AppChatEventLogCore}; this
 * wrapper owns the monotonic `(topic, message, device)` upsert and the
 * delivered/read fold.
 */

import { AppChatEventLogCore } from './app-chat-event-core.ts'
import type { ProjectDb } from './db.ts'

/** A receipt state a device can report / the server can record. */
export type AppChatReceiptState = 'delivered' | 'read'

/** Input for {@link AppChatReceiptLog.record}. */
export interface AppChatReceiptRecordInput {
  topic_id: string
  message_id: string
  device_id: string
  state: AppChatReceiptState
  /** unix-ms time the receipt was observed. */
  at: number
}

/** The full current receipt aggregate for a single message. */
export interface AppChatReceiptAggregate {
  message_id: string
  /** The message's per-topic seq (0 when the message isn't in the log). */
  seq: number
  /** Device ids that have received the message. */
  delivered_by: string[]
  /** Device ids (incl. the synthetic `agent`) that have read the message. */
  read_by: string[]
}

/**
 * Append-/merge-only receipt log. Recording is idempotent + monotonic per
 * (topic, message, device): a receipt can advance delivered → read but never
 * regress, and a re-report is a no-op.
 */
export interface AppChatReceiptLog {
  /**
   * Record a receipt, resolving the message's seq from the message log so a
   * resume can replay it in order. `read` implies `delivered` (backfills
   * delivered_at when unset). Returns the message's full post-record aggregate
   * so the caller can fan a `receipt_update` carrying the latest state.
   */
  record(input: AppChatReceiptRecordInput): Promise<AppChatReceiptAggregate>
  /** Current aggregate for one message (empty arrays when none recorded). */
  aggregate(topic_id: string, message_id: string): Promise<AppChatReceiptAggregate>
  /**
   * Aggregates for every message with a receipt whose seq is greater than
   * `after_seq`, ascending by seq. Used to replay receipt state to a
   * reconnecting device after the message replay. Bounded by `limit` distinct
   * messages (default {@link DEFAULT_RECEIPT_REPLAY_LIMIT}).
   */
  aggregatesAfter(
    topic_id: string,
    after_seq: number,
    limit?: number,
  ): Promise<AppChatReceiptAggregate[]>
}

/** Default replay page size — distinct messages whose receipts replay in one
 *  resume. Bounds a long-offline client's receipt catch-up. */
export const DEFAULT_RECEIPT_REPLAY_LIMIT = 500

interface ReceiptRow {
  message_id: string
  device_id: string
  seq: number
  delivered_at: number | null
  read_at: number | null
}

const RECEIPT_COLUMNS = `message_id, device_id, seq, delivered_at, read_at`

export interface AppChatReceiptStoreOptions {
  db: ProjectDb
}

export class AppChatReceiptStore implements AppChatReceiptLog {
  private readonly core: AppChatEventLogCore<ReceiptRow, AppChatReceiptAggregate>

  constructor(opts: AppChatReceiptStoreOptions) {
    this.core = new AppChatEventLogCore<ReceiptRow, AppChatReceiptAggregate>({
      db: opts.db,
      table: 'app_chat_receipts',
      columns: RECEIPT_COLUMNS,
      defaultReplayLimit: DEFAULT_RECEIPT_REPLAY_LIMIT,
      replay: {
        kind: 'message-group',
        messageIdOf: (r) => r.message_id,
        fold: aggregateFromRows,
      },
    })
  }

  async record(input: AppChatReceiptRecordInput): Promise<AppChatReceiptAggregate> {
    return this.core.transaction<AppChatReceiptAggregate>((tx) => {
      // Resolve the message's true seq from the durable log — never trust a
      // client-asserted seq. 0 when the message isn't present (defensive: such
      // a receipt simply won't make the resume replay window).
      const seq = this.core.resolveMessageSeq(input.message_id, tx)

      // `read` implies `delivered`: stamp both on a read so a device that only
      // ever reports read still counts as delivered. COALESCE in the conflict
      // clause keeps the first timestamp so receipts are monotonic.
      const deliveredAt = input.at
      const readAt = input.state === 'read' ? input.at : null

      tx.runSync(
        `INSERT INTO app_chat_receipts
           (topic_id, message_id, device_id, seq, delivered_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(topic_id, message_id, device_id) DO UPDATE SET
           delivered_at = COALESCE(app_chat_receipts.delivered_at, excluded.delivered_at),
           read_at      = COALESCE(app_chat_receipts.read_at, excluded.read_at),
           seq          = CASE WHEN excluded.seq > 0 THEN excluded.seq ELSE app_chat_receipts.seq END`,
        [input.topic_id, input.message_id, input.device_id, seq, deliveredAt, readAt],
      )

      return aggregateFromRows(
        input.message_id,
        this.core.rowsForMessage(input.topic_id, input.message_id, tx),
      )
    })
  }

  async aggregate(topic_id: string, message_id: string): Promise<AppChatReceiptAggregate> {
    return aggregateFromRows(message_id, this.core.rowsForMessage(topic_id, message_id))
  }

  async aggregatesAfter(
    topic_id: string,
    after_seq: number,
    limit: number = DEFAULT_RECEIPT_REPLAY_LIMIT,
  ): Promise<AppChatReceiptAggregate[]> {
    return this.core.aggregatesAfter(topic_id, after_seq, limit)
  }
}

/** Fold the receipt rows for ONE message into its aggregate. */
function aggregateFromRows(message_id: string, rows: ReceiptRow[]): AppChatReceiptAggregate {
  const delivered_by: string[] = []
  const read_by: string[] = []
  let seq = 0
  for (const r of rows) {
    if (r.seq > seq) seq = r.seq
    if (r.delivered_at !== null) delivered_by.push(r.device_id)
    if (r.read_at !== null) read_by.push(r.device_id)
  }
  delivered_by.sort()
  read_by.sort()
  return { message_id, seq, delivered_by, read_by }
}
