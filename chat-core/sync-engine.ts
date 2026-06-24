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
import type {
  ChatMessage,
  InboundChatMessage,
  InboundEditUpdate,
  InboundReactionUpdate,
  InboundReceiptUpdate,
  OutboundResume,
} from './types.ts'

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
    // Track B Phase 4 — carry inline receipt state through to the store, which
    // set-unions it onto any existing row (the optimistic bubble, or a prior
    // delivery). Only set when present so we never clobber accumulated receipts
    // with an empty list on a later partial.
    if (env.delivered_to !== undefined && env.delivered_to !== null) {
      msg.delivered_to = env.delivered_to
    }
    if (env.read_by !== undefined && env.read_by !== null) {
      msg.read_by = env.read_by
    }
    await this.store.upsert(msg)
    return { seq: env.seq, applied: !deduped, reconciled }
  }

  /**
   * Apply a receipt-state update for an already-delivered message (Track B
   * Phase 4). Looks the message up by its server `message_id` and set-unions
   * the new aggregate onto it via the same idempotent UPSERT path messages use
   * — NOT a fork of the apply logic. Returns `{ applied:false }` when the
   * message isn't in the local store yet (a receipt can't precede its message
   * on the wire: the server only fans a receipt after the message persisted,
   * and a resume replays messages before their receipts), so the update is
   * harmlessly dropped rather than creating a bodyless placeholder row.
   */
  async applyReceiptUpdate(
    topic_id: string,
    update: InboundReceiptUpdate,
  ): Promise<{ applied: boolean }> {
    if (update.message_id.length === 0) return { applied: false }
    const existing = await this.store.getByMessageId(topic_id, update.message_id)
    if (existing === null) return { applied: false }
    const patch: ChatMessage = { ...existing }
    if (update.delivered_by.length > 0) patch.delivered_to = update.delivered_by
    if (update.read_by.length > 0) patch.read_by = update.read_by
    await this.store.upsert(patch)
    return { applied: true }
  }

  /**
   * Apply a reaction-state update for an already-delivered message (Track B
   * Phase 4). Looks the message up by `message_id` and writes the new aggregate
   * via the same idempotent UPSERT path messages use (NOT a fork): the Store's
   * {@link pickReactionState} keeps whichever aggregate has the higher `rev`, so
   * a stale (lower-rev) update is a no-op and an empty higher-rev set clears all
   * reactions. Returns `{ applied:false }` when the message isn't local yet (a
   * reaction can't precede its message on the wire) or the update is stale.
   */
  async applyReactionUpdate(
    topic_id: string,
    update: InboundReactionUpdate,
  ): Promise<{ applied: boolean }> {
    if (update.message_id.length === 0) return { applied: false }
    const existing = await this.store.getByMessageId(topic_id, update.message_id)
    if (existing === null) return { applied: false }
    // Stale-update short-circuit: don't churn the store / re-render for an
    // update we'd discard anyway. (mergeMessage would keep the existing state,
    // but avoiding the upsert keeps applyReactionUpdate's verdict honest.)
    if (existing.reactions_rev !== null && existing.reactions_rev !== undefined) {
      if (update.rev < existing.reactions_rev) return { applied: false }
    }
    const patch: ChatMessage = {
      ...existing,
      reactions: update.reactions.length > 0 ? update.reactions : null,
      reactions_rev: update.rev,
    }
    await this.store.upsert(patch)
    return { applied: true }
  }

  /**
   * Apply an edit/delete update for an already-delivered message (Track B
   * Phase 4). Looks the message up by `message_id` and writes the new body +
   * tombstone via the same idempotent UPSERT path messages use (NOT a fork):
   * the Store's {@link pickEditState} keeps whichever aggregate has the higher
   * `rev`, so a stale (lower-rev) update is a no-op. Returns `{ applied:false }`
   * when the message isn't local yet (an edit can't precede its message on the
   * wire) or the update is stale.
   */
  async applyEditUpdate(
    topic_id: string,
    update: InboundEditUpdate,
  ): Promise<{ applied: boolean }> {
    if (update.message_id.length === 0) return { applied: false }
    const existing = await this.store.getByMessageId(topic_id, update.message_id)
    if (existing === null) return { applied: false }
    // Stale-update short-circuit: skip the store churn / re-render for an update
    // we'd discard anyway (mergeMessage would keep existing, but this keeps the
    // applied verdict honest — same posture as applyReactionUpdate).
    if (existing.edit_rev !== null && existing.edit_rev !== undefined) {
      if (update.rev < existing.edit_rev) return { applied: false }
    }
    const patch: ChatMessage = {
      ...existing,
      body: update.deleted ? '' : update.body,
      edited_at: update.edited_at,
      deleted: update.deleted,
      edit_rev: update.rev,
    }
    await this.store.upsert(patch)
    return { applied: true }
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
