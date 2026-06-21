/**
 * @neutron/chat-core — the local message Store interface + a reference
 * in-memory implementation.
 *
 * The Store is the only persistence seam the sync engine + send-queue
 * depend on, so a platform-specific durable store (wasm-SQLite/OPFS on web,
 * op-sqlite on RN) drops in without touching the engine. {@link
 * InMemoryStore} is the always-available fallback (used directly when no
 * durable store is available, and as the substrate that
 * {@link InMemoryStore}-backed unit tests exercise).
 *
 * Ordering contract (research doc §5 — "order-by-seq, never clock"):
 * {@link Store.list} returns messages ordered by `seq` ascending; messages
 * with no `seq` yet (locally queued, not server-acked) sort AFTER all
 * sequenced messages, by `created_at` — i.e. the optimistic tail.
 *
 * Identity contract: a message's primary identity is its `client_msg_id`
 * (user sends) or `message_id` (agent messages). An UPSERT keyed on that
 * identity is what makes apply idempotent: the optimistic bubble and its
 * server echo collapse into one row, and a re-delivered message overwrites
 * rather than duplicates.
 */

import { messageIdentity, type ChatMessage } from './types.ts'
import {
  clampSearchLimit,
  searchMessagesInMemory,
  type MessageSearchHit,
  type MessageSearchOptions,
} from './search.ts'

export interface Store {
  /**
   * Insert or merge a message by its primary identity. Merge semantics: the
   * incoming fields win where present (a server echo's `seq` / `message_id`
   * overwrite the optimistic nulls; a stored `created_at` is preserved when
   * the incoming one is 0).
   */
  upsert(msg: ChatMessage): Promise<void>
  /** All messages for a topic, ordered by seq asc then optimistic tail. */
  list(topic_id: string): Promise<ChatMessage[]>
  /** Look up by client idempotency key (reconcile / dedup). */
  getByClientMsgId(topic_id: string, client_msg_id: string): Promise<ChatMessage | null>
  /**
   * Look up by server `message_id` (agent messages, or a re-delivered message
   * whose `client_msg_id` we never held). A point lookup so the sync engine's
   * resume replay stays O(N) — a backing store should index `(topic_id,
   * message_id)` rather than scan the whole topic per applied message.
   */
  getByMessageId(topic_id: string, message_id: string): Promise<ChatMessage | null>
  /** Highest `seq` applied for a topic; 0 when the topic has none. This is
   *  the resume cursor. */
  lastSeenSeq(topic_id: string): Promise<number>
  /** Messages still `queued` (not yet handed to the socket), oldest first. */
  pendingSends(topic_id: string): Promise<ChatMessage[]>
  /** Drop all messages for a topic (e.g. account switch). */
  clear(topic_id: string): Promise<void>
  /**
   * Full-text search the transcript. `query` is free text; results are ranked
   * by relevance + recency with `[`…`]`-highlighted snippets (research doc §5
   * — "FTS5 over the local message store"). Scope with
   * {@link MessageSearchOptions} (single topic / project, or omit both for a
   * global search across the whole local store). A durable store backs this
   * with SQLite FTS5; {@link InMemoryStore} with an equivalent tokenised scan.
   */
  searchMessages(query: string, opts?: MessageSearchOptions): Promise<MessageSearchHit[]>
}

/** Order two messages by the engine's ordering contract. */
export function compareForDisplay(a: ChatMessage, b: ChatMessage): number {
  if (a.seq !== null && b.seq !== null) {
    if (a.seq !== b.seq) return a.seq - b.seq
    return a.created_at - b.created_at
  }
  // Sequenced messages always precede un-sequenced (optimistic) ones.
  if (a.seq !== null) return -1
  if (b.seq !== null) return 1
  if (a.created_at !== b.created_at) return a.created_at - b.created_at
  return a.client_msg_id < b.client_msg_id ? -1 : a.client_msg_id > b.client_msg_id ? 1 : 0
}

/** Merge an incoming message onto an existing row by the identity contract. */
export function mergeMessage(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  return {
    topic_id: existing.topic_id,
    client_msg_id: existing.client_msg_id,
    // Server-assigned fields win once present; never regress a known value
    // back to null on a later partial.
    message_id: incoming.message_id ?? existing.message_id,
    seq: incoming.seq ?? existing.seq,
    role: existing.role,
    body: incoming.body.length > 0 ? incoming.body : existing.body,
    project_id: incoming.project_id ?? existing.project_id,
    attachments: incoming.attachments ?? existing.attachments,
    // Keep the original optimistic timestamp so the bubble doesn't jump.
    created_at: existing.created_at !== 0 ? existing.created_at : incoming.created_at,
    // Status only ever advances queued → sent → acked.
    status: advanceStatus(existing.status, incoming.status),
    // Track B Phase 4 — receipts accumulate by set-union, so applying a
    // receipt_update (or a re-delivered message carrying inline receipts) is
    // idempotent + order-independent: a device can never "un-deliver" or
    // "un-read" a message, and two devices' acks both survive.
    delivered_to: unionDeviceIds(existing.delivered_to, incoming.delivered_to),
    read_by: unionDeviceIds(existing.read_by, incoming.read_by),
  }
}

const STATUS_RANK = { queued: 0, sent: 1, acked: 2 } as const
function advanceStatus(a: ChatMessage['status'], b: ChatMessage['status']): ChatMessage['status'] {
  return STATUS_RANK[b] >= STATUS_RANK[a] ? b : a
}

/**
 * Set-union two device-id lists into a sorted, de-duplicated array (or `null`
 * when both are empty). Tolerant of `null`/`undefined`/absent (an older
 * persisted row predating receipts) so the merge never throws. Sorted output
 * keeps the stored value canonical regardless of arrival order — handy for
 * byte-stable persistence + deterministic tests.
 */
export function unionDeviceIds(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): readonly string[] | null {
  const set = new Set<string>()
  if (a) for (const id of a) if (id.length > 0) set.add(id)
  if (b) for (const id of b) if (id.length > 0) set.add(id)
  if (set.size === 0) return null
  return [...set].sort()
}

export class InMemoryStore implements Store {
  // topic_id → (identity → message)
  private readonly byTopic = new Map<string, Map<string, ChatMessage>>()

  async upsert(msg: ChatMessage): Promise<void> {
    const identity = messageIdentity(msg.client_msg_id, msg.message_id)
    if (identity === null) return
    let topic = this.byTopic.get(msg.topic_id)
    if (topic === undefined) {
      topic = new Map()
      this.byTopic.set(msg.topic_id, topic)
    }
    // Reconcile: if the optimistic row was keyed by client_msg_id and this
    // identity differs but the client_msg_id matches an existing row, merge
    // into that one instead of creating a duplicate.
    const existing =
      topic.get(identity) ?? this.findByClientMsgId(topic, msg.client_msg_id)
    if (existing !== undefined) {
      const merged = mergeMessage(existing, msg)
      const existingIdentity = messageIdentity(existing.client_msg_id, existing.message_id)
      if (existingIdentity !== null && existingIdentity !== identity) {
        topic.delete(existingIdentity)
      }
      topic.set(messageIdentity(merged.client_msg_id, merged.message_id) ?? identity, merged)
      return
    }
    topic.set(identity, { ...msg })
  }

  private findByClientMsgId(
    topic: Map<string, ChatMessage>,
    client_msg_id: string,
  ): ChatMessage | undefined {
    if (client_msg_id.length === 0) return undefined
    for (const m of topic.values()) {
      if (m.client_msg_id === client_msg_id) return m
    }
    return undefined
  }

  async list(topic_id: string): Promise<ChatMessage[]> {
    const topic = this.byTopic.get(topic_id)
    if (topic === undefined) return []
    return [...topic.values()].map((m) => ({ ...m })).sort(compareForDisplay)
  }

  async getByClientMsgId(topic_id: string, client_msg_id: string): Promise<ChatMessage | null> {
    const topic = this.byTopic.get(topic_id)
    if (topic === undefined) return null
    const found = this.findByClientMsgId(topic, client_msg_id)
    return found !== undefined ? { ...found } : null
  }

  async getByMessageId(topic_id: string, message_id: string): Promise<ChatMessage | null> {
    if (message_id.length === 0) return null
    const topic = this.byTopic.get(topic_id)
    if (topic === undefined) return null
    // A scan, but bounded to a single pass with no clone-all / sort — strictly
    // cheaper than the old `list()` (which sorted + cloned the whole topic) the
    // sync engine used to call per applied message.
    for (const m of topic.values()) {
      if (m.message_id === message_id) return { ...m }
    }
    return null
  }

  async lastSeenSeq(topic_id: string): Promise<number> {
    const topic = this.byTopic.get(topic_id)
    if (topic === undefined) return 0
    let max = 0
    for (const m of topic.values()) {
      if (m.seq !== null && m.seq > max) max = m.seq
    }
    return max
  }

  async pendingSends(topic_id: string): Promise<ChatMessage[]> {
    const topic = this.byTopic.get(topic_id)
    if (topic === undefined) return []
    return [...topic.values()]
      .filter((m) => m.status === 'queued')
      .map((m) => ({ ...m }))
      .sort((a, b) => a.created_at - b.created_at)
  }

  async clear(topic_id: string): Promise<void> {
    this.byTopic.delete(topic_id)
  }

  async searchMessages(
    query: string,
    opts: MessageSearchOptions = {},
  ): Promise<MessageSearchHit[]> {
    const limit = clampSearchLimit(opts.limit)
    const wantTopic = opts.topic_id !== undefined && opts.topic_id.length > 0 ? opts.topic_id : null
    const wantProject =
      opts.project_id !== undefined && opts.project_id.length > 0 ? opts.project_id : null

    // Scope the candidate set first (topic and/or project), then hand the
    // match + rank + highlight to the shared in-memory search so the JS path
    // and the FTS path produce the same {@link MessageSearchHit} shape.
    const candidates: ChatMessage[] = []
    const topics = wantTopic !== null ? [this.byTopic.get(wantTopic)] : this.byTopic.values()
    for (const topic of topics) {
      if (topic === undefined) continue
      for (const m of topic.values()) {
        if (wantProject !== null && m.project_id !== wantProject) continue
        candidates.push(m)
      }
    }
    return searchMessagesInMemory(candidates, query, limit)
  }
}
