/**
 * @neutron/chat-core — the append-only sync engine.
 *
 * Tiny by design (research doc §5: "low hundreds of LOC"). Append-only chat
 * has no write conflicts, so sync reduces to:
 *   - apply each inbound message via an idempotent, identity-keyed UPSERT
 *     (dedup re-delivery; reconcile the optimistic bubble);
 *   - order by `seq`, never by clock;
 *   - track a per-topic `last_seen_seq` cursor (= max applied seq);
 *   - on reconnect, ask the server to replay `WHERE seq > last_seen_seq`.
 *
 * Multi-device falls out for free: two devices each run their own engine +
 * cursor against their own Store; the server fans the same sequenced stream
 * to both, and because apply is identity-idempotent and ordered by `seq`,
 * both converge on byte-identical transcripts regardless of which device
 * originated a given message.
 */

import { InMemoryStore, type Store } from './store.ts'
import type { ChatMessage, InboundChatMessage, OutboundResume } from './types.ts'

export interface ApplyResult {
  /** The seq this message carries (null if the server didn't assign one). */
  seq: number | null
  /** true when this was a fresh apply; false when it de-duped an already
   *  applied message (same identity already at this seq). */
  applied: boolean
  /** true when an existing optimistic/sent row was reconciled (its seq +
   *  message_id stamped, status advanced to acked). */
  reconciled: boolean
}

export class SyncEngine {
  private readonly store: Store

  constructor(store: Store = new InMemoryStore()) {
    this.store = store
  }

  /** Apply one inbound message. Idempotent + order-independent. */
  async applyInbound(topic_id: string, env: InboundChatMessage): Promise<ApplyResult> {
    const existing = await this.findExisting(topic_id, env)
    const deduped = existing !== null && existing.seq !== null && existing.seq === env.seq
    const reconciled = existing !== null && existing.seq === null && env.seq !== null

    const msg: ChatMessage = {
      topic_id,
      client_msg_id: env.client_msg_id ?? '',
      message_id: env.message_id,
      seq: env.seq,
      role: env.role,
      body: env.body,
      project_id: env.project_id,
      attachments: env.attachments,
      created_at: env.created_at,
      status: 'acked',
    }
    await this.store.upsert(msg)
    return { seq: env.seq, applied: !deduped, reconciled }
  }

  /** Build the gap-fill request to send on (re)connect. */
  async resumeRequest(topic_id: string): Promise<OutboundResume> {
    const after_seq = await this.store.lastSeenSeq(topic_id)
    return { v: 1, type: 'resume', after_seq }
  }

  /** Current resume cursor (max applied seq) for a topic. */
  async cursor(topic_id: string): Promise<number> {
    return this.store.lastSeenSeq(topic_id)
  }

  /** Ordered transcript for rendering (seq asc, optimistic tail last). */
  async messages(topic_id: string): Promise<ChatMessage[]> {
    return this.store.list(topic_id)
  }

  private async findExisting(
    topic_id: string,
    env: InboundChatMessage,
  ): Promise<ChatMessage | null> {
    if (env.client_msg_id !== null && env.client_msg_id.length > 0) {
      const byCmid = await this.store.getByClientMsgId(topic_id, env.client_msg_id)
      if (byCmid !== null) return byCmid
    }
    // Fall back to an indexed point lookup by message_id (agent messages, or a
    // re-delivered message whose client_msg_id we never held). This was a
    // `store.list(topic_id)` full scan + `.find()` — O(N) per applied message,
    // so replaying a resume tail of N agent messages was O(N²) (a real cliff at
    // thousands of messages). `getByMessageId` lets a backing store serve it
    // from a `(topic_id, message_id)` index instead.
    return this.store.getByMessageId(topic_id, env.message_id)
  }
}
