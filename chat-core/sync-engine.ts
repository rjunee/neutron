/**
 * @neutronai/chat-core — the append-only sync engine.
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
    // P1b (onboarding / quick-reply buttons) — carry the agent-message metadata
    // through to the store so the render layer can show the option row. Only set
    // when present (agent messages) so a user message's row stays unchanged.
    if (env.options !== undefined && env.options !== null) msg.options = env.options
    if (env.prompt_id !== undefined && env.prompt_id !== null) msg.prompt_id = env.prompt_id
    if (env.allow_freeform !== undefined && env.allow_freeform !== null) {
      msg.allow_freeform = env.allow_freeform
    }
    if (env.kind !== undefined && env.kind !== null) msg.kind = env.kind
    if (env.upload_affordance !== undefined && env.upload_affordance !== null) {
      msg.upload_affordance = env.upload_affordance
    }
    // P7.3 — inline images / citations / doc refs / deep-link. Same posture:
    // only set when present so a plain message's row stays unchanged. Without
    // these the socket + resume path would drop them despite the SQLite columns
    // (the rich renderer + deep-link dispatcher would never see them).
    if (env.image_urls !== undefined && env.image_urls !== null) msg.image_urls = env.image_urls
    if (env.citations !== undefined && env.citations !== null) msg.citations = env.citations
    if (env.doc_refs !== undefined && env.doc_refs !== null) msg.doc_refs = env.doc_refs
    if (env.deep_link !== undefined && env.deep_link !== null) msg.deep_link = env.deep_link
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

  /**
   * Stale-store reset detection (M1). Compare the server's reported high-water
   * `seq` (from `session_ready.last_seen_seq`, parsed by
   * {@link parseSessionReadyMaxSeq}) against our local resume cursor. When the
   * server's value is a known number STRICTLY LOWER than a non-zero local
   * cursor, the per-topic seq counter regressed — the server was wiped or
   * reinstalled under us (a fresh install restarts seq at 1) — so the locally
   * cached transcript belongs to a dead server and must be dropped. Clearing the
   * topic resets the cursor to 0, so the `resume` that follows re-syncs the
   * whole fresh transcript (`after_seq: 0`) from the new server.
   *
   * Deliberately conservative — it NEVER clears when:
   *   - the server didn't report a seq (`serverMaxSeq === null`): a fresh topic
   *     or a no-durable-log deployment omits `last_seen_seq`, and clearing there
   *     would wipe the only copy of the transcript;
   *   - the server seq is >= the local cursor: the ordinary reconnect / cold-open
   *     / first-connect case (the server is at or ahead of us — just resume
   *     forward), so a normal reconnect can never false-trigger a wipe;
   *   - the local cursor is 0: there is nothing cached that could be stale.
   *
   * Returns whether a reset was detected (and the topic cleared) so the caller
   * can emit a UI change immediately, before the resume replay arrives.
   */
  async reconcileServerReset(
    topic_id: string,
    serverMaxSeq: number | null,
  ): Promise<{ reset: boolean }> {
    if (serverMaxSeq === null) return { reset: false }
    const localCursor = await this.store.lastSeenSeq(topic_id)
    if (localCursor > 0 && serverMaxSeq < localCursor) {
      // Drop ONLY the dead server's acked transcript, preserving un-acked local
      // sends (status queued/sent — the user's typed-but-undelivered messages,
      // which carry no server seq) so a reset NEVER loses a send: the
      // `resume`/flush that follows re-drives them against the fresh server
      // (idempotent on client_msg_id). A SINGLE store operation, so a send that
      // races the reset can't be lost in a snapshot→clear→reinsert window — it
      // is either already a non-acked row (kept) or arrives after (untouched).
      await this.store.clearAckedTranscript(topic_id)
      return { reset: true }
    }
    return { reset: false }
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
