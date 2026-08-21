/**
 * @neutronai/chat-core — the local message Store interface + a reference
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

import { messageIdentity, sortReactions, type ChatMessage, type MessageReaction } from './types.ts'
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
   *  the FORWARD resume cursor. */
  lastSeenSeq(topic_id: string): Promise<number>
  /**
   * The lowest `seq` of the NEWEST UNBROKEN RUN this device holds — i.e. the
   * smallest `s` such that every seq in `[s, lastSeenSeq]` is present locally.
   * 0 when the topic holds no sequenced row. This is the BACKWARDS cursor
   * (`SyncEngine.backfillFrom`); optimistic rows have no seq and are ignored.
   *
   * IT IS DELIBERATELY NOT "the lowest seq I hold", which is what this used to
   * be, and the difference is a whole class of permanent data loss. Server seqs
   * do run 1..N with no deletes, but THE CLIENT'S COPY OF THEM DOES NOT: a
   * device that held 1..100, went away while the topic grew to 700, and then
   * resumed onto a capped newest-window page comes back holding 1..100 AND
   * 201..700. Its lowest seq is 1, so "my oldest is above 1" answered NO — and
   * 101..200 was stranded for good, because the forward cursor is already at 700
   * and the server only reports a gap for a page it just sent. "Where does my
   * history start" and "is my history contiguous" are different questions, and
   * only the second one is the one the walk needs to ask.
   *
   * COST, stated per implementation rather than in general, because the two
   * differ and the difference is the whole reason this is a store method and not
   * a helper over `list()`:
   *   - {@link InMemoryStore}: O(rows in the topic), ALWAYS — one pass to collect
   *     the sequenced set, then a descending walk. Same order as the `MIN(seq)`
   *     it replaces, one extra Set of numbers. On the longest topic the owner has
   *     reported (1,130 rows) that is ~1k integer inserts per catch-up, not per
   *     message.
   *   - a durable store: O(length of the NEWEST RUN), not of the topic — the SQL
   *     walks `(topic_id, seq)` DESC and stops at the first row whose predecessor
   *     is absent, so a holey store is genuinely cheaper and a hole-free one pays
   *     a full index walk. A store that cannot do better than a whole-topic scan
   *     should say so here rather than let a caller assume the index form.
   * It is NOT free, and it must not be called per applied message — the sessions
   * call it once per forward resume (`SyncEngine.backfillFrom`).
   */
  contiguousFloorSeq(topic_id: string): Promise<number>
  /** Messages still `queued` (not yet handed to the socket), oldest first. */
  pendingSends(topic_id: string): Promise<ChatMessage[]>
  /** Drop all messages for a topic (e.g. account switch). */
  clear(topic_id: string): Promise<void>
  /**
   * Stale-store reset (M1) — drop ONLY the ACKED (server-sequenced) transcript
   * for a topic, preserving un-acked local sends (status `queued`/`sent`, which
   * carry no server seq). Used when a server reinstall is detected
   * ({@link SyncEngine.reconcileServerReset}): the dead server's transcript is
   * wiped while the user's typed-but-undelivered messages survive to be
   * re-driven against the fresh server. A SINGLE store operation (not a
   * read-clear-reinsert cycle), so a send that races the reset can't be lost in
   * a window between snapshot and delete.
   */
  clearAckedTranscript(topic_id: string): Promise<void>
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
    project_id: incoming.project_id ?? existing.project_id,
    attachments: incoming.attachments ?? existing.attachments,
    // The transcript NEVER regresses to null. A later partial (a receipt update, a
    // re-delivery from a server that has not been migrated yet) carries no
    // transcript, and blanking it there would silently un-index a voice note the
    // device had already learned the words for — the same "never regress a known
    // value" rule the server-assigned fields above follow.
    transcript: incoming.transcript ?? existing.transcript ?? null,
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
    // Track B Phase 4 (reactions) — NOT a union: reactions are removable, so the
    // higher-`rev` aggregate replaces the lower one wholesale. A re-delivered
    // message (carrying no reaction info) leaves the stored reactions untouched.
    ...pickReactionState(existing, incoming),
    // Track B Phase 4 (edit/delete) — body + edited_at + deleted are governed by
    // a monotonic edit_rev (last-writer-wins), so an edit/delete update replaces
    // them and a re-delivery of the ORIGINAL body never resurrects an edited one.
    // pickEditState owns `body` (incl. the normal optimistic→echo reconciliation).
    ...pickEditState(existing, incoming),
    // P1b (onboarding / quick-reply buttons) — agent-message metadata is
    // immutable wire data, so a re-delivery / resume carries the same set;
    // preserve whatever's present (incoming wins, falling back to existing) and
    // only include each key when set so a button-less message stays unchanged.
    ...pickAgentMeta(existing, incoming),
  }
}

/**
 * P1b (onboarding / quick-reply buttons) — pick an agent message's button
 * metadata (options / prompt_id / allow_freeform / kind / upload_affordance)
 * when merging `incoming` onto `existing`. Immutable wire data: incoming wins
 * where present, else the existing value survives a metadata-less re-delivery
 * (e.g. a receipt/reaction/edit re-upsert). Returns only the keys that are set
 * so a message with no buttons doesn't grow null fields.
 */
type AgentMetaKeys =
  | 'options'
  | 'prompt_id'
  | 'allow_freeform'
  | 'kind'
  | 'upload_affordance'
  | 'chosen_value'
  | 'image_urls'
  | 'citations'
  | 'doc_refs'
  | 'deep_link'

export function pickAgentMeta(
  existing: Pick<ChatMessage, AgentMetaKeys>,
  incoming: Pick<ChatMessage, AgentMetaKeys>,
): Partial<Pick<ChatMessage, AgentMetaKeys>> {
  const out: Partial<Pick<ChatMessage, AgentMetaKeys>> = {}
  const options = incoming.options ?? existing.options
  if (options !== null && options !== undefined) out.options = options
  const promptId = incoming.prompt_id ?? existing.prompt_id
  if (promptId !== null && promptId !== undefined) out.prompt_id = promptId
  const allowFreeform = incoming.allow_freeform ?? existing.allow_freeform
  if (allowFreeform !== null && allowFreeform !== undefined) out.allow_freeform = allowFreeform
  const kind = incoming.kind ?? existing.kind
  if (kind !== null && kind !== undefined) out.kind = kind
  const upload = incoming.upload_affordance ?? existing.upload_affordance
  if (upload !== null && upload !== undefined) out.upload_affordance = upload
  // ISSUES #419 — a prompt's resolution is TERMINAL and first-write-wins on the
  // server, so `incoming ?? existing` is the right merge: a later metadata-less
  // re-delivery (receipt / reaction / edit re-upsert) can never un-spend an
  // already-answered prompt and resurrect a live button.
  const chosenValue = incoming.chosen_value ?? existing.chosen_value
  if (chosenValue !== null && chosenValue !== undefined) out.chosen_value = chosenValue
  const imageUrls = incoming.image_urls ?? existing.image_urls
  if (imageUrls !== null && imageUrls !== undefined) out.image_urls = imageUrls
  const citations = incoming.citations ?? existing.citations
  if (citations !== null && citations !== undefined) out.citations = citations
  const docRefs = incoming.doc_refs ?? existing.doc_refs
  if (docRefs !== null && docRefs !== undefined) out.doc_refs = docRefs
  const deepLink = incoming.deep_link ?? existing.deep_link
  if (deepLink !== null && deepLink !== undefined) out.deep_link = deepLink
  return out
}

/**
 * Pick a message's edit state (body + edited_at + deleted + edit_rev) when
 * merging `incoming` onto `existing`. Like reactions, edits are NOT a union: the
 * aggregate carrying the higher monotonic `edit_rev` wins (last-writer-wins).
 * This function OWNS the merged `body` so an edit/delete replaces it and a plain
 * re-delivery of the original body never clobbers an edited/tombstoned one:
 *
 *   - incoming has NO edit info (`edit_rev` absent) → keep existing edit state;
 *     body follows the normal optimistic→echo merge ONLY when nothing was edited;
 *   - incoming `rev` >= existing `rev` (or existing has none) → take incoming
 *     (a delete normalizes body to `''`, the tombstone);
 *   - otherwise the incoming edit is stale → keep existing.
 *
 * Idempotent + order-independent: replaying the same or an older update is a
 * no-op on the rendered body.
 */
export function pickEditState(
  existing: Pick<ChatMessage, 'body' | 'edited_at' | 'deleted' | 'edit_rev'>,
  incoming: Pick<ChatMessage, 'body' | 'edited_at' | 'deleted' | 'edit_rev'>,
): { body: string; edited_at: number | null; deleted: boolean; edit_rev: number | null } {
  const incomingRev = incoming.edit_rev
  const existingRev = existing.edit_rev
  if (incomingRev === null || incomingRev === undefined) {
    // No edit authority on incoming (plain apply / re-delivery / receipt /
    // reaction update). Preserve any edit we already hold; otherwise the body
    // follows the normal optimistic-bubble → server-echo reconciliation.
    if (existingRev !== null && existingRev !== undefined) {
      return {
        body: existing.body,
        edited_at: existing.edited_at ?? null,
        deleted: existing.deleted ?? false,
        edit_rev: existingRev,
      }
    }
    return {
      body: incoming.body.length > 0 ? incoming.body : existing.body,
      edited_at: existing.edited_at ?? null,
      deleted: existing.deleted ?? false,
      edit_rev: null,
    }
  }
  if (existingRev === null || existingRev === undefined || incomingRev >= existingRev) {
    return {
      body: incoming.deleted === true ? '' : incoming.body,
      edited_at: incoming.edited_at ?? null,
      deleted: incoming.deleted ?? false,
      edit_rev: incomingRev,
    }
  }
  return {
    body: existing.body,
    edited_at: existing.edited_at ?? null,
    deleted: existing.deleted ?? false,
    edit_rev: existingRev,
  }
}

/**
 * Pick a message's reaction state when merging an `incoming` onto an `existing`
 * row. Reactions can be removed, so — unlike receipts — they are NOT unioned;
 * the aggregate carrying the higher monotonic `rev` wins (last-writer-wins),
 * which is what lets a removal actually clear a reaction:
 *
 *   - incoming has NO reaction info (`reactions_rev` absent) → keep existing
 *     (a normal message apply / re-delivery never clobbers reactions);
 *   - incoming `rev` >= existing `rev` (or existing has none) → take incoming
 *     (an empty incoming set with a higher rev correctly clears everything);
 *   - otherwise the incoming update is stale → keep existing.
 *
 * Idempotent + order-independent: replaying the same or an older update is a
 * no-op on the rendered set.
 */
export function pickReactionState(
  existing: Pick<ChatMessage, 'reactions' | 'reactions_rev'>,
  incoming: Pick<ChatMessage, 'reactions' | 'reactions_rev'>,
): { reactions: readonly MessageReaction[] | null; reactions_rev: number | null } {
  const incomingRev = incoming.reactions_rev
  if (incomingRev === null || incomingRev === undefined) {
    return {
      reactions: normalizeReactions(existing.reactions),
      reactions_rev: existing.reactions_rev ?? null,
    }
  }
  const existingRev = existing.reactions_rev
  if (existingRev === null || existingRev === undefined || incomingRev >= existingRev) {
    return { reactions: normalizeReactions(incoming.reactions), reactions_rev: incomingRev }
  }
  return {
    reactions: normalizeReactions(existing.reactions),
    reactions_rev: existingRev,
  }
}

/**
 * Track B Phase 4 (reactions) — one rendered reaction chip: an emoji, how many
 * devices reacted with it, and whether THIS device is among them (so a UI can
 * highlight the chip + know a tap should REMOVE rather than add). Framework-free
 * so web (React) and mobile (RN) render from the same derivation.
 */
export interface ReactionChip {
  emoji: string
  count: number
  reactedBySelf: boolean
}

/**
 * Group a message's flat `(emoji, device_id)` reaction set into the per-emoji
 * chips a UI renders ("👍 3"), ordered by descending count then emoji so the
 * row is stable. `selfDeviceId` marks the chips this device contributed to.
 */
export function groupReactions(
  reactions: readonly MessageReaction[] | null | undefined,
  selfDeviceId?: string,
): ReactionChip[] {
  const byEmoji = new Map<string, { count: number; reactedBySelf: boolean }>()
  for (const r of reactions ?? []) {
    if (r.emoji.length === 0) continue
    const entry = byEmoji.get(r.emoji) ?? { count: 0, reactedBySelf: false }
    entry.count += 1
    if (selfDeviceId !== undefined && r.device_id === selfDeviceId) entry.reactedBySelf = true
    byEmoji.set(r.emoji, entry)
  }
  const chips: ReactionChip[] = []
  for (const [emoji, { count, reactedBySelf }] of byEmoji) {
    chips.push({ emoji, count, reactedBySelf })
  }
  chips.sort((a, b) => (b.count !== a.count ? b.count - a.count : a.emoji < b.emoji ? -1 : 1))
  return chips
}

/** Clean + canonically sort a reaction list, returning `null` when empty (so an
 *  all-removed message persists as "no reactions"). */
export function normalizeReactions(
  reactions: readonly MessageReaction[] | null | undefined,
): readonly MessageReaction[] | null {
  if (reactions === null || reactions === undefined) return null
  const seen = new Set<string>()
  const cleaned: MessageReaction[] = []
  for (const r of reactions) {
    if (r.emoji.length === 0 || r.device_id.length === 0) continue
    const key = `${r.emoji} ${r.device_id}`
    if (seen.has(key)) continue
    seen.add(key)
    cleaned.push({ emoji: r.emoji, device_id: r.device_id })
  }
  return cleaned.length > 0 ? sortReactions(cleaned) : null
}

// GAP-4 — `failed` ranks ABOVE `sent` (an ack-timeout flips sent → failed) but
// BELOW `acked` (a late echo still wins, resolving a failed row to acked). This
// keeps status strictly monotonic, so the merge never regresses: a re-delivery /
// resume echo (born `acked`) always beats a local `failed`, and a re-sent failed
// row simply stays `failed` on the wire until its echo lands.
const STATUS_RANK = { queued: 0, sent: 1, failed: 2, acked: 3 } as const
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

  async contiguousFloorSeq(topic_id: string): Promise<number> {
    const topic = this.byTopic.get(topic_id)
    if (topic === undefined) return 0
    // One pass to collect the sequenced set and its high-water mark, then walk
    // DOWN from that mark while the predecessor is present. `seq > 0` and not
    // merely non-null: an un-acked row carries no server seq and must never
    // become the backwards cursor.
    const seqs = new Set<number>()
    let max = 0
    for (const m of topic.values()) {
      if (m.seq !== null && m.seq > 0) {
        seqs.add(m.seq)
        if (m.seq > max) max = m.seq
      }
    }
    if (max === 0) return 0
    let floor = max
    // Terminates at 1 without a special case: `has(0)` is false for any store,
    // because seq 0 is not a server seq.
    while (seqs.has(floor - 1)) floor -= 1
    return floor
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

  async clearAckedTranscript(topic_id: string): Promise<void> {
    const topic = this.byTopic.get(topic_id)
    if (topic === undefined) return
    // Single pass: drop every server-acked row (the dead server's transcript),
    // keep un-acked local sends (queued/sent) so a reset never loses them.
    for (const [identity, m] of topic) {
      if (m.status === 'acked') topic.delete(identity)
    }
    if (topic.size === 0) this.byTopic.delete(topic_id)
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
