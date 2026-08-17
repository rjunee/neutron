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
  /**
   * W3a — structured agent-message presentation metadata (button `options`,
   * `prompt_id`, `kind`, `citations`, `image_urls`, `doc_refs`,
   * `allow_freeform`, `upload_affordance`), or null. Opaque here: the app-ws
   * adapter owns the shape and re-validates on replay. Always null for user
   * messages.
   */
  meta: Readonly<Record<string, unknown>> | null
  /**
   * Auto-transcript of an audio attachment on this message, or null.
   *
   * Persisted so it survives the DEVICE. A voice note's body is deliberately empty
   * (the bubble renders a player), so without this column `replayAfter` would hand a
   * fresh device the audio and none of the words — searchable on whichever phone did
   * the upload and nowhere else. Never rendered in place of the body.
   */
  transcript: string | null
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
  /** W3a — structured agent-message metadata; see {@link AppChatRow.meta}. */
  meta?: Readonly<Record<string, unknown>> | null
  /** Auto-transcript of an audio attachment; see {@link AppChatRow.transcript}. */
  transcript?: string | null
  created_at: number
}

/**
 * ISSUES #419 — the outcome of stamping a prompt's answer onto its message.
 * Identifies the row so the caller can fan a `prompt_resolved` frame at it, and
 * reports the value that is now recorded — which on a re-tap is the FIRST tap's
 * value, not the one just offered.
 */
export interface AppChatPromptChoiceResult {
  topic_id: string
  message_id: string
  seq: number
  /** The value now durably recorded against this prompt. */
  chosen_value: string
  /** false when the row already carried a `chosen_value` (first-write-wins). */
  was_new: boolean
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
   * Replay messages after `after_seq` for a topic, ascending by seq, bounded by
   * `limit` (default {@link DEFAULT_REPLAY_LIMIT}). `after_seq <= 0` (or a cold
   * client) returns the whole transcript when it fits within `limit`, and its
   * NEWEST `limit` messages when it does not.
   */
  replayAfter(topic_id: string, after_seq: number, limit?: number): Promise<AppChatRow[]>
  /** Highest seq persisted for a topic, or 0 when the topic has no messages. */
  maxSeq(topic_id: string): Promise<number>
  /**
   * ISSUES #419 — record that the prompt carried by an agent message has been
   * ANSWERED, by stamping `chosen_value` into that row's `meta` blob.
   *
   * This is what turns spent-ness into SERVER state. #415 made a second tap
   * inert (`ButtonStore.resolve`'s `was_new` gates the dispatch) but left the
   * clients drawing the button as live, because the only record of the answer
   * was a session-scoped React value that any remount discarded — and a reply
   * row's TTL is ten years, so the button never ages out on its own. Stamping
   * it here puts the answer on the message itself, so it rides the ordinary
   * replay path to every device and every future cold open.
   *
   * FIRST-WRITE-WINS: a row that already carries a `chosen_value` is left
   * exactly as it is and returned with `was_new:false`. A re-tap therefore
   * cannot rewrite history, and the caller can still fan the recorded value
   * back — which is what lets a stale surface heal itself on the tap that the
   * server refuses.
   *
   * Returns `null` when no message in this topic carries the prompt (the emit
   * failed and shipped buttonless, or the id is client-minted): there is
   * nothing to stamp, and inventing a row would be worse than doing nothing.
   */
  markPromptChosen(input: {
    topic_id: string
    prompt_id: string
    chosen_value: string
  }): Promise<AppChatPromptChoiceResult | null>
}

/**
 * Default replay page size — bounds a single resume so a long-offline client
 * can't pull an unbounded transcript in one frame burst.
 *
 * A topic with more than this many messages after the cursor replays the
 * NEWEST 500 (`AppChatEventLogCore.rowsAfterNewest`), and the rest is SKIPPED,
 * not paged: `resume` fires once per socket open, and there is no wire signal
 * for "older messages exist above this". Raising this number is not the fix for
 * a truncated transcript — it only moves the threshold.
 *
 * (An earlier version of this comment claimed "the client re-issues resume from
 * the new high-water mark to page the rest." No client ever did. It described an
 * intended design, not the code, and it is what made the ordering bug read as
 * harmless for as long as it did.)
 */
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
  meta_json: string | null
  transcript: string | null
  created_at: number
}

const MESSAGE_COLUMNS = `topic_id, seq, message_id, role, body, client_msg_id, project_id,
                    attachments_json, meta_json, transcript, created_at`

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
    const meta = input.meta ?? null
    const meta_json =
      meta !== null && Object.keys(meta).length > 0 ? JSON.stringify(meta) : null
    // Whitespace-only counts as ABSENT. An empty transcript stored as '' would be
    // indistinguishable from "transcribed to nothing" downstream, and the ASR does
    // return an empty result for silence.
    const rawTranscript = typeof input.transcript === 'string' ? input.transcript.trim() : ''
    const transcript = rawTranscript.length > 0 ? rawTranscript : null

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
            attachments_json, meta_json, created_at, transcript)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.topic_id,
          seq,
          input.message_id,
          input.role,
          input.body,
          client_msg_id,
          project_id,
          attachments_json,
          meta_json,
          input.created_at,
          transcript,
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
        meta: meta_json !== null ? meta : null,
        transcript,
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

  /** ISSUES #419 — see {@link AppChatMessageLog.markPromptChosen}. */
  async markPromptChosen(input: {
    topic_id: string
    prompt_id: string
    chosen_value: string
  }): Promise<AppChatPromptChoiceResult | null> {
    if (input.prompt_id.length === 0 || input.chosen_value.length === 0) return null
    return this.core.transaction<AppChatPromptChoiceResult | null>((tx) => {
      // The prompt id lives INSIDE the opaque `meta` blob (see
      // `agentMessageMetaFromEnvelope`), not in a column, so the lookup goes
      // through SQLite's JSON1 `json_extract` rather than a LIKE over the raw
      // text — a substring match would happily hit a prompt id embedded in a
      // doc-ref URL or a citation title.
      const row = tx
        .prepare<
          { seq: number; message_id: string; meta_json: string | null },
          [string, string]
        >(
          `SELECT seq, message_id, meta_json FROM app_chat_messages
            WHERE topic_id = ?
              AND meta_json IS NOT NULL
              AND json_extract(meta_json, '$.prompt_id') = ?
            ORDER BY seq DESC
            LIMIT 1`,
        )
        .get(input.topic_id, input.prompt_id)
      if (row === null || row === undefined || row.meta_json === null) return null

      const parsed = parseJsonColumn(row.meta_json, { onCorrupt: 'fallback', fallback: null })
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const meta = parsed as Record<string, unknown>

      const existing = meta['chosen_value']
      if (typeof existing === 'string' && existing.length > 0) {
        // Already answered. Report the RECORDED value (not the one just
        // offered) so a re-tap can only ever re-broadcast the truth.
        return {
          topic_id: input.topic_id,
          message_id: row.message_id,
          seq: row.seq,
          chosen_value: existing,
          was_new: false,
        }
      }

      meta['chosen_value'] = input.chosen_value
      tx.runSync(
        `UPDATE app_chat_messages SET meta_json = ? WHERE topic_id = ? AND seq = ?`,
        [JSON.stringify(meta), input.topic_id, row.seq],
      )
      return {
        topic_id: input.topic_id,
        message_id: row.message_id,
        seq: row.seq,
        chosen_value: input.chosen_value,
        was_new: true,
      }
    })
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
  let meta: Readonly<Record<string, unknown>> | null = null
  if (r.meta_json !== null) {
    // Corrupt-policy: silent reset to null (replay degrades to a plain bubble).
    const parsed = parseJsonColumn(r.meta_json, { onCorrupt: 'fallback', fallback: null })
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as Readonly<Record<string, unknown>>
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
    meta,
    transcript: r.transcript,
    created_at: r.created_at,
  }
}
