/**
 * @neutronai/persistence — durable per-message edit/delete log for the
 * `app_socket` (Expo / web) WebSocket surface (Track B Phase 4).
 *
 * Backs message edit + delete: a client (or the agent) mutates a message it
 * authored; the server AUTHORIZES the mutation against the message's author,
 * persists the new body / tombstone, bumps a monotonic per-message `rev`, and
 * re-fans the message's current edit state as an `edit_update`; the client's
 * chat-core engine applies it last-writer-wins by `rev` (see
 * {@link pickEditState}). Migration `0087_app_chat_edits.sql` carries the schema
 * rationale.
 *
 * This MIRRORS {@link AppChatReactionStore} (one durable per-message-state log,
 * resume-replayable by `seq`, monotonic `rev`) with one structural difference:
 * an edit/delete is AUTHOR-ONLY. Reactions attribute to a device and any device
 * may react to any message; an edit/delete may only be applied by the message's
 * author. Because the app-chat topic is a single user's DM (`app:<user_id>`),
 * every human socket on the topic belongs to that user, so authorship reduces to
 * the message ROLE: a human device may mutate `user` messages, and the agent
 * (device id {@link APP_CHAT_AGENT_DEVICE_ID}) may mutate `agent` messages. A
 * cross-role mutation (a user editing the agent's message, or vice-versa) is
 * rejected with {@link AppChatEditNotAuthorizedError}.
 *
 * The {@link AppChatEditLog} interface is what the app-ws adapter depends on, so
 * the adapter stays DB-agnostic + unit-testable with an in-memory fake;
 * {@link AppChatEditStore} is the SQLite implementation wired in the gateway
 * composition alongside {@link AppChatStore} + {@link AppChatReactionStore}.
 */

import type { ProjectDb } from './db.ts'

/** Edit (rewrite body) or delete (tombstone) a message. */
export type AppChatEditAction = 'edit' | 'delete'

/**
 * The synthetic device id attributed to the agent loop. An edit/delete from
 * this device is authorized against `agent`-role messages (agent-native parity:
 * the agent can edit/delete a message it sent). Kept in lock-step with
 * chat-core's `AGENT_DEVICE_ID` without importing across the package boundary.
 */
export const APP_CHAT_AGENT_DEVICE_ID = 'agent'

/** Input for {@link AppChatEditLog.record}. */
export interface AppChatEditRecordInput {
  topic_id: string
  message_id: string
  /** Who is mutating: a socket's device id, or {@link APP_CHAT_AGENT_DEVICE_ID}
   *  for an agent-issued edit. Used for authorization, never client-trusted. */
  editor_device_id: string
  action: AppChatEditAction
  /** The new body on an `edit`; ignored (cleared to `''`) on a `delete`. */
  body: string
  /** unix-ms time the edit/delete was observed. */
  at: number
}

/** The current edit state of a single message. */
export interface AppChatEditAggregate {
  message_id: string
  /** The message's per-topic seq (0 when the message isn't in the log). */
  seq: number
  /** Monotonic per-message edit revision (last-writer-wins key). 0 when the
   *  message has never been edited/deleted. */
  rev: number
  /** The message's current body (`''` for a delete tombstone). */
  body: string
  /** True once the message has been tombstoned. */
  deleted: boolean
  /** unix-ms time of the last edit/delete (0 when never). */
  edited_at: number
}

/** Thrown by {@link AppChatEditLog.record} when the editor is not the message's
 *  author (cross-role mutation) or the message doesn't exist. The adapter maps
 *  it to a `not_authorized` error frame rather than persisting/fanning. */
export class AppChatEditNotAuthorizedError extends Error {
  constructor(message = 'not authorized to edit this message') {
    super(message)
    this.name = 'AppChatEditNotAuthorizedError'
  }
}

/**
 * Author-only, resume-replayable edit/delete log. Recording is idempotent at the
 * client (the merge keeps the highest `rev`); a re-edit simply advances `rev`
 * and replaces the body.
 */
export interface AppChatEditLog {
  /**
   * Record an edit/delete, AUTHORIZING it against the message's author, resolving
   * the message's seq from the message log (so a resume replays it in order),
   * and bumping the per-message `rev`. Returns the message's post-record edit
   * aggregate so the caller can fan an `edit_update`. Throws
   * {@link AppChatEditNotAuthorizedError} when the editor isn't the author.
   */
  record(input: AppChatEditRecordInput): Promise<AppChatEditAggregate>
  /** Current edit state for one message (rev 0 / original empty when none). */
  aggregate(topic_id: string, message_id: string): Promise<AppChatEditAggregate>
  /**
   * Edit aggregates for every edited/deleted message whose seq is greater than
   * `after_seq`, ascending by seq. Used to replay edit state to a reconnecting
   * device after the message replay. Bounded by `limit` messages (default
   * {@link DEFAULT_EDIT_REPLAY_LIMIT}).
   */
  aggregatesAfter(
    topic_id: string,
    after_seq: number,
    limit?: number,
  ): Promise<AppChatEditAggregate[]>
}

/** Default replay page size — edited messages whose state replays in one resume. */
export const DEFAULT_EDIT_REPLAY_LIMIT = 500

interface EditRow {
  message_id: string
  seq: number
  rev: number
  body: string
  deleted: number
  edited_at: number
}

export interface AppChatEditStoreOptions {
  db: ProjectDb
}

export class AppChatEditStore implements AppChatEditLog {
  private readonly db: ProjectDb

  constructor(opts: AppChatEditStoreOptions) {
    this.db = opts.db
  }

  async record(input: AppChatEditRecordInput): Promise<AppChatEditAggregate> {
    return this.db.transaction<AppChatEditAggregate>((tx) => {
      // Resolve the message's true seq + role from the durable log — never trust
      // a client-asserted seq, and the role is what authorizes the mutation.
      const msgRow = tx
        .prepare<{ seq: number | null; role: string | null }, [string]>(
          `SELECT seq, role FROM app_chat_messages WHERE message_id = ? LIMIT 1`,
        )
        .get(input.message_id)
      if (msgRow === undefined || msgRow === null || msgRow.role === null) {
        // Unknown message → can't establish authorship → reject.
        throw new AppChatEditNotAuthorizedError('message not found')
      }
      // Author-only: a human device may mutate `user` messages; the agent device
      // may mutate `agent` messages. Any cross-role mutation is forbidden.
      const isAgentEditor = input.editor_device_id === APP_CHAT_AGENT_DEVICE_ID
      const allowed = isAgentEditor ? msgRow.role === 'agent' : msgRow.role === 'user'
      if (!allowed) {
        throw new AppChatEditNotAuthorizedError()
      }
      const seq = msgRow.seq ?? 0

      // Monotonic per-message revision: one higher than this message's current
      // edit rev, so every edit/delete strictly advances rev (the LWW key).
      const revRow = tx
        .prepare<{ next: number }, [string, string]>(
          `SELECT COALESCE(MAX(rev), 0) + 1 AS next
             FROM app_chat_edits
            WHERE topic_id = ? AND message_id = ?`,
        )
        .get(input.topic_id, input.message_id)
      const rev = revRow?.next ?? 1

      const deleted = input.action === 'delete' ? 1 : 0
      const body = input.action === 'delete' ? '' : input.body

      // UPSERT on (topic, message): one row holds the latest edit state. `seq`
      // backfills once known (an edit can't really precede its message, but stay
      // defensive — mirrors the reactions store).
      tx.raw().run(
        `INSERT INTO app_chat_edits
           (topic_id, message_id, seq, rev, body, deleted, edited_at, editor_device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(topic_id, message_id) DO UPDATE SET
           rev              = excluded.rev,
           body             = excluded.body,
           deleted          = excluded.deleted,
           edited_at        = excluded.edited_at,
           editor_device_id = excluded.editor_device_id,
           seq              = CASE WHEN excluded.seq > 0 THEN excluded.seq ELSE app_chat_edits.seq END`,
        [input.topic_id, input.message_id, seq, rev, body, deleted, input.at, input.editor_device_id],
      )

      return this.aggregateInTx(tx, input.topic_id, input.message_id)
    })
  }

  async aggregate(topic_id: string, message_id: string): Promise<AppChatEditAggregate> {
    const row = this.db
      .prepare<EditRow, [string, string]>(
        `SELECT message_id, seq, rev, body, deleted, edited_at
           FROM app_chat_edits
          WHERE topic_id = ? AND message_id = ?
          LIMIT 1`,
      )
      .get(topic_id, message_id)
    return rowToAggregate(message_id, row)
  }

  async aggregatesAfter(
    topic_id: string,
    after_seq: number,
    limit: number = DEFAULT_EDIT_REPLAY_LIMIT,
  ): Promise<AppChatEditAggregate[]> {
    const safeAfter = Number.isFinite(after_seq) ? Math.max(0, Math.trunc(after_seq)) : 0
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.trunc(limit))
      : DEFAULT_EDIT_REPLAY_LIMIT
    const rows = this.db
      .prepare<EditRow, [string, number, number]>(
        `SELECT message_id, seq, rev, body, deleted, edited_at
           FROM app_chat_edits
          WHERE topic_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT ?`,
      )
      .all(topic_id, safeAfter, safeLimit)
    return rows.map((r) => rowToAggregate(r.message_id, r))
  }

  private aggregateInTx(
    tx: ProjectDb,
    topic_id: string,
    message_id: string,
  ): AppChatEditAggregate {
    const row = tx
      .prepare<EditRow, [string, string]>(
        `SELECT message_id, seq, rev, body, deleted, edited_at
           FROM app_chat_edits
          WHERE topic_id = ? AND message_id = ?
          LIMIT 1`,
      )
      .get(topic_id, message_id)
    return rowToAggregate(message_id, row)
  }
}

/** Map a single edit row (or its absence) into an aggregate. */
function rowToAggregate(message_id: string, row: EditRow | undefined | null): AppChatEditAggregate {
  if (row === undefined || row === null) {
    return { message_id, seq: 0, rev: 0, body: '', deleted: false, edited_at: 0 }
  }
  return {
    message_id: row.message_id,
    seq: row.seq,
    rev: row.rev,
    body: row.body,
    deleted: row.deleted === 1,
    edited_at: row.edited_at,
  }
}
