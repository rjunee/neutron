/**
 * @neutronai/persistence — durable per-(message, device, emoji) reaction log
 * for the `app_socket` (Expo / web) WebSocket surface (Track B Phase 4).
 *
 * Backs emoji reactions: a client adds/removes a reaction on a message; the
 * server attributes it to the socket's device id, persists it, and re-fans the
 * FULL current reaction aggregate (plus a monotonic `rev`) as a
 * `reaction_update`; the client's chat-core engine applies it last-writer-wins
 * by `rev`. See migration `0083_app_chat_reactions.sql` for the schema
 * rationale.
 *
 * This mirrors {@link AppChatReceiptStore} (one durable per-message-state log,
 * resume-replayable by `seq`) with two deliberate differences, because
 * reactions are REMOVABLE where receipts are monotonic:
 *  - a `remove` flips a row to `active = 0` (a tombstone, not a DELETE), so the
 *    per-message `rev` stays monotonic across adds AND removes;
 *  - the fanned aggregate is the higher-`rev` snapshot the client REPLACES
 *    its set with, not a union it accumulates.
 *
 * The {@link AppChatReactionLog} interface is what the app-ws adapter depends
 * on, so the adapter stays DB-agnostic + unit-testable with an in-memory fake;
 * {@link AppChatReactionStore} is the SQLite implementation wired in the gateway
 * composition alongside {@link AppChatStore} + {@link AppChatReceiptStore}. The
 * seq/rev/replay mechanics live in the shared {@link AppChatEventLogCore};
 * this wrapper owns the tombstoning `(topic, message, device, emoji)` upsert
 * and the active-set fold.
 */

import { AppChatEventLogCore } from './app-chat-event-core.ts'
import type { ProjectDb } from './db.ts'

/** Add or remove an emoji reaction. */
export type AppChatReactionAction = 'add' | 'remove'

/** One active reaction in an aggregate: an emoji + the device that added it. */
export interface AppChatReaction {
  emoji: string
  device_id: string
}

/** Input for {@link AppChatReactionLog.record}. */
export interface AppChatReactionRecordInput {
  topic_id: string
  message_id: string
  device_id: string
  emoji: string
  action: AppChatReactionAction
  /** unix-ms time the reaction change was observed. */
  at: number
}

/** The full current reaction aggregate for a single message. */
export interface AppChatReactionAggregate {
  message_id: string
  /** The message's per-topic seq (0 when the message isn't in the log). */
  seq: number
  /** Monotonic per-message reaction revision (last-writer-wins key). Advances
   *  on every add/remove; the highest rev's `reactions` is authoritative. */
  rev: number
  /** The active `(emoji, device_id)` reactions, canonically sorted. */
  reactions: AppChatReaction[]
}

/**
 * Add-/remove-/replay-able reaction log. Recording is idempotent per
 * (topic, message, device, emoji): re-adding is a no-op on the active set
 * (the `rev` still advances, which is harmless — the client merge is
 * idempotent), and removing a reaction that was never added is a no-op.
 */
export interface AppChatReactionLog {
  /**
   * Record an add/remove, resolving the message's seq from the message log so a
   * resume can replay it in order, and bumping the per-message `rev`. Returns
   * the message's full post-record aggregate so the caller can fan a
   * `reaction_update`.
   */
  record(input: AppChatReactionRecordInput): Promise<AppChatReactionAggregate>
  /** Current aggregate for one message (empty `reactions`, rev 0 when none). */
  aggregate(topic_id: string, message_id: string): Promise<AppChatReactionAggregate>
  /**
   * Aggregates for every message with a reaction whose seq is greater than
   * `after_seq`, ascending by seq. Used to replay reaction state to a
   * reconnecting device after the message replay. Bounded by `limit` distinct
   * messages (default {@link DEFAULT_REACTION_REPLAY_LIMIT}).
   */
  aggregatesAfter(
    topic_id: string,
    after_seq: number,
    limit?: number,
  ): Promise<AppChatReactionAggregate[]>
}

/** Default replay page size — distinct messages whose reactions replay in one
 *  resume. Bounds a long-offline client's reaction catch-up. */
export const DEFAULT_REACTION_REPLAY_LIMIT = 500

interface ReactionRow {
  message_id: string
  device_id: string
  emoji: string
  seq: number
  active: number
  rev: number
}

const REACTION_COLUMNS = `message_id, device_id, emoji, seq, active, rev`

export interface AppChatReactionStoreOptions {
  db: ProjectDb
}

export class AppChatReactionStore implements AppChatReactionLog {
  private readonly core: AppChatEventLogCore<ReactionRow, AppChatReactionAggregate>

  constructor(opts: AppChatReactionStoreOptions) {
    this.core = new AppChatEventLogCore<ReactionRow, AppChatReactionAggregate>({
      db: opts.db,
      table: 'app_chat_reactions',
      columns: REACTION_COLUMNS,
      defaultReplayLimit: DEFAULT_REACTION_REPLAY_LIMIT,
      replay: {
        kind: 'message-group',
        messageIdOf: (r) => r.message_id,
        fold: aggregateFromRows,
      },
    })
  }

  async record(input: AppChatReactionRecordInput): Promise<AppChatReactionAggregate> {
    return this.core.transaction<AppChatReactionAggregate>((tx) => {
      // Resolve the message's true seq from the durable log — never trust a
      // client-asserted seq. 0 when the message isn't present (defensive: such
      // a reaction simply won't make the resume replay window).
      const seq = this.core.resolveMessageSeq(input.message_id, tx)

      // Monotonic per-message revision: one higher than any rev this message has
      // seen (active or tombstoned), so every change strictly advances rev. This
      // is the last-writer-wins key the client orders updates by.
      const rev = this.core.nextMessageRev(input.topic_id, input.message_id, tx)

      const active = input.action === 'add' ? 1 : 0

      // UPSERT on (topic, message, device, emoji): a remove flips `active` to 0
      // (tombstone) rather than deleting the row, which keeps `rev` monotonic
      // across removes. `rev` + `updated_at` always take the new values; `seq`
      // updates once known (a reaction can arrive before its message persisted
      // in a degenerate race — backfill seq when it shows up).
      tx.runSync(
        `INSERT INTO app_chat_reactions
           (topic_id, message_id, device_id, emoji, seq, active, rev, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(topic_id, message_id, device_id, emoji) DO UPDATE SET
           active     = excluded.active,
           rev        = excluded.rev,
           updated_at = excluded.updated_at,
           seq        = CASE WHEN excluded.seq > 0 THEN excluded.seq ELSE app_chat_reactions.seq END`,
        [input.topic_id, input.message_id, input.device_id, input.emoji, seq, active, rev, input.at],
      )

      return aggregateFromRows(
        input.message_id,
        this.core.rowsForMessage(input.topic_id, input.message_id, tx),
      )
    })
  }

  async aggregate(topic_id: string, message_id: string): Promise<AppChatReactionAggregate> {
    return aggregateFromRows(message_id, this.core.rowsForMessage(topic_id, message_id))
  }

  async aggregatesAfter(
    topic_id: string,
    after_seq: number,
    limit: number = DEFAULT_REACTION_REPLAY_LIMIT,
  ): Promise<AppChatReactionAggregate[]> {
    return this.core.aggregatesAfter(topic_id, after_seq, limit)
  }
}

/** Fold the reaction rows for ONE message into its aggregate: active rows
 *  become the reaction set; `rev`/`seq` are the max across ALL rows (incl.
 *  tombstones) so they stay monotonic. */
function aggregateFromRows(message_id: string, rows: ReactionRow[]): AppChatReactionAggregate {
  const reactions: AppChatReaction[] = []
  let seq = 0
  let rev = 0
  for (const r of rows) {
    if (r.seq > seq) seq = r.seq
    if (r.rev > rev) rev = r.rev
    if (r.active === 1) reactions.push({ emoji: r.emoji, device_id: r.device_id })
  }
  reactions.sort((a, b) =>
    a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0,
  )
  return { message_id, seq, rev, reactions }
}
