/**
 * @neutronai/persistence — durable per-topic chat-message log for the
 * `app_socket` (Expo / web) WebSocket surface.
 *
 * Backs the chat-sync foundation (Phase 1): a monotonic, per-topic `seq`
 * assigned on persist, surfaced on every outbound envelope, and replayed on
 * `{ type:'resume', after_seq:N }` so a reconnecting (or second) device gets
 * a gap-free, correctly-ordered transcript. See migration
 * `0079_app_chat_messages.sql` for the schema rationale.
 *
 * The {@link AppChatMessageLog} interface is what the app-ws adapter depends
 * on, so the adapter stays DB-agnostic and unit-testable with an in-memory
 * fake; {@link AppChatStore} is the SQLite implementation wired in the
 * gateway composition. The per-topic seq/replay mechanics live in the shared
 * {@link AppChatEventLogCore}; this wrapper owns the message schema and the
 * `(topic_id, client_msg_id)` idempotency identity.
 */

import { AppChatEventLogCore } from './app-chat-event-core.ts'
import type { ProjectDb } from './db.ts'
import { parseJsonColumn } from './sidecar.ts'

/** A persisted chat message as stored / replayed. */
export interface AppChatRow {
  topic_id: string
  /** Monotonic per-topic sequence assigned on persist. */
  seq: number
  message_id: string
  role: 'user' | 'agent'
  body: string
  client_msg_id: string | null
  project_id: string | null
  /** Attachment URLs, or null when the message carried none. */
  attachments: ReadonlyArray<string> | null
  created_at: number
}

/** Input for {@link AppChatMessageLog.append}. */
export interface AppChatAppendInput {
  topic_id: string
  message_id: string
  role: 'user' | 'agent'
  body: string
  client_msg_id?: string | null
  project_id?: string | null
  attachments?: ReadonlyArray<string> | null
  created_at: number
}

/** Result of an append: the assigned row plus whether it was newly written. */
export interface AppChatAppendResult {
  row: AppChatRow
  /** false when an existing `(topic_id, client_msg_id)` row was returned. */
  was_new: boolean
}

/**
 * Append-only, per-topic message log. The adapter depends on this interface
 * (not the concrete store) so the seq/resume behaviour can be unit-tested
 * against an in-memory fake.
 */
export interface AppChatMessageLog {
  /**
   * Persist a message, assigning the next monotonic `seq` for its topic.
   * Idempotent on `(topic_id, client_msg_id)`: re-appending the same
   * client_msg_id returns the existing row with `was_new:false` and does
   * NOT advance the sequence.
   */
  append(input: AppChatAppendInput): Promise<AppChatAppendResult>
  /**
   * Replay every message after `after_seq` for a topic, ascending by seq.
   * `after_seq <= 0` (or a cold client) returns the whole transcript up to
   * `limit`.
   */
  replayAfter(topic_id: string, after_seq: number, limit?: number): Promise<AppChatRow[]>
  /** Highest seq persisted for a topic, or 0 when the topic has no messages. */
  maxSeq(topic_id: string): Promise<number>
}

/** Default replay page size — bounds a single resume so a long-offline
 *  client can't pull an unbounded transcript in one frame burst. The
 *  client re-issues resume from the new high-water mark to page the rest. */
export const DEFAULT_REPLAY_LIMIT = 500

interface MessageRow {
  topic_id: string
  seq: number
  message_id: string
  role: 'user' | 'agent'
  body: string
  client_msg_id: string | null
  project_id: string | null
  attachments_json: string | null
  created_at: number
}

const MESSAGE_COLUMNS = `topic_id, seq, message_id, role, body, client_msg_id, project_id,
                    attachments_json, created_at`

export interface AppChatStoreOptions {
  db: ProjectDb
}

export class AppChatStore implements AppChatMessageLog {
  private readonly core: AppChatEventLogCore<MessageRow, AppChatRow>

  constructor(opts: AppChatStoreOptions) {
    this.core = new AppChatEventLogCore<MessageRow, AppChatRow>({
      db: opts.db,
      table: 'app_chat_messages',
      columns: MESSAGE_COLUMNS,
      defaultReplayLimit: DEFAULT_REPLAY_LIMIT,
      replay: { kind: 'row', toAggregate: rowFrom },
    })
  }

  async append(input: AppChatAppendInput): Promise<AppChatAppendResult> {
    const client_msg_id = input.client_msg_id ?? null
    const project_id = input.project_id ?? null
    const attachments_json =
      input.attachments !== undefined && input.attachments !== null && input.attachments.length > 0
        ? JSON.stringify([...input.attachments])
        : null

    return this.core.transaction<AppChatAppendResult>((tx) => {
      // Idempotency: a re-sent user message (offline-queue flush, double-tap,
      // HTTP-fallback racing the WS echo) collapses to the existing row.
      if (client_msg_id !== null) {
        const existing = this.core.firstRowByKey(input.topic_id, 'client_msg_id', client_msg_id, tx)
        if (existing !== null) {
          return { row: rowFrom(existing), was_new: false }
        }
      }

      const seq = this.core.nextTopicSeq(input.topic_id, tx)

      tx.runSync(
        `INSERT INTO app_chat_messages
           (topic_id, seq, message_id, role, body, client_msg_id, project_id,
            attachments_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.topic_id,
          seq,
          input.message_id,
          input.role,
          input.body,
          client_msg_id,
          project_id,
          attachments_json,
          input.created_at,
        ],
      )

      const row: AppChatRow = {
        topic_id: input.topic_id,
        seq,
        message_id: input.message_id,
        role: input.role,
        body: input.body,
        client_msg_id,
        project_id,
        attachments: input.attachments !== undefined ? (input.attachments ?? null) : null,
        created_at: input.created_at,
      }
      return { row, was_new: true }
    })
  }

  async replayAfter(
    topic_id: string,
    after_seq: number,
    limit: number = DEFAULT_REPLAY_LIMIT,
  ): Promise<AppChatRow[]> {
    return this.core.aggregatesAfter(topic_id, after_seq, limit)
  }

  async maxSeq(topic_id: string): Promise<number> {
    return this.core.maxTopicSeq(topic_id)
  }
}

function rowFrom(r: MessageRow): AppChatRow {
  let attachments: ReadonlyArray<string> | null = null
  if (r.attachments_json !== null) {
    // Corrupt-policy: silent reset to null (leave attachments unset).
    const parsed = parseJsonColumn(r.attachments_json, { onCorrupt: 'fallback', fallback: null })
    if (Array.isArray(parsed)) {
      attachments = parsed.filter((x): x is string => typeof x === 'string')
    }
  }
  return {
    topic_id: r.topic_id,
    seq: r.seq,
    message_id: r.message_id,
    role: r.role,
    body: r.body,
    client_msg_id: r.client_msg_id,
    project_id: r.project_id,
    attachments,
    created_at: r.created_at,
  }
}
