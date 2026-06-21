/**
 * @neutron/chat-core — the idempotent offline send-queue.
 *
 * Keyed by `client_msg_id` (research doc §5: "idempotency-keyed
 * (client_msg_id) send-queue"). Enqueue writes the message to the local
 * store as `queued` and renders it optimistically; `flush` drains every
 * queued message to the socket on (re)connect and marks them `sent`; the
 * server echo (applied via the sync engine, which shares the same Store)
 * reconciles them to `acked`.
 *
 * Idempotency guarantees:
 *  - enqueue with an already-known `client_msg_id` returns the existing row
 *    and does NOT duplicate (double-tap, retried submit).
 *  - flush only drains `queued` rows, so a redundant flush (two reconnects
 *    racing) never double-sends.
 */

import type { Store } from './store.ts'
import type { ChatMessage, OutboundUserMessage } from './types.ts'

export interface SendQueueOptions {
  /** Override id generation (tests). Default: crypto.randomUUID(). */
  generateId?: () => string
  /** Override the clock (tests). Default: Date.now(). */
  now?: () => number
}

export interface EnqueueInput {
  topic_id: string
  body: string
  /** Supply to make the enqueue idempotent against a known id; otherwise one
   *  is generated. */
  client_msg_id?: string
  project_id?: string | null
  attachments?: readonly string[] | null
}

/** A function that hands one envelope to the transport. May throw/reject
 *  when the socket is down — flush stops and leaves the rest queued. */
export type SendFn = (env: OutboundUserMessage) => void | Promise<void>

export class SendQueue {
  private readonly store: Store
  private readonly generateId: () => string
  private readonly now: () => number

  constructor(store: Store, opts: SendQueueOptions = {}) {
    this.store = store
    this.generateId = opts.generateId ?? (() => crypto.randomUUID())
    this.now = opts.now ?? (() => Date.now())
  }

  /**
   * Queue a user message for delivery. Optimistically persisted as `queued`
   * so the UI renders it immediately and it survives a reload while offline.
   * Idempotent on `client_msg_id`.
   */
  async enqueue(input: EnqueueInput): Promise<ChatMessage> {
    const client_msg_id = input.client_msg_id ?? this.generateId()
    const existing = await this.store.getByClientMsgId(input.topic_id, client_msg_id)
    if (existing !== null) return existing

    const msg: ChatMessage = {
      topic_id: input.topic_id,
      client_msg_id,
      message_id: null,
      seq: null,
      role: 'user',
      body: input.body,
      project_id: input.project_id ?? null,
      attachments: input.attachments ?? null,
      created_at: this.now(),
      status: 'queued',
    }
    await this.store.upsert(msg)
    return msg
  }

  /**
   * Drain every `queued` message for a topic to the socket, oldest first,
   * marking each `sent`. Returns the messages actually flushed. If `send`
   * throws (socket died mid-drain) flushing stops and the remaining
   * messages stay `queued` for the next reconnect — preserving order and
   * never dropping a send.
   */
  async flush(send: SendFn, topic_id: string): Promise<ChatMessage[]> {
    const pending = await this.store.pendingSends(topic_id)
    const flushed: ChatMessage[] = []
    for (const msg of pending) {
      const env = toEnvelope(msg)
      try {
        await send(env)
      } catch {
        // Socket down — leave this and the rest queued; next flush retries.
        break
      }
      await this.store.upsert({ ...msg, status: 'sent' })
      flushed.push({ ...msg, status: 'sent' })
    }
    return flushed
  }

  /** Count of messages still awaiting delivery (queued) for a topic. */
  async pendingCount(topic_id: string): Promise<number> {
    return (await this.store.pendingSends(topic_id)).length
  }
}

function toEnvelope(msg: ChatMessage): OutboundUserMessage {
  const env: OutboundUserMessage = {
    v: 1,
    type: 'user_message',
    body: msg.body,
    client_msg_id: msg.client_msg_id,
  }
  if (msg.project_id !== null) env.project_id = msg.project_id
  if (msg.attachments !== null && msg.attachments.length > 0) env.attachments = msg.attachments
  return env
}
