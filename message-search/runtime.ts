/**
 * @neutronai/message-search — runtime that backs the `message_search` agent
 * tool.
 *
 * The complement to `@neutronai/doc-search`: that searches the owner's project
 * MARKDOWN; this searches their CHAT HISTORY. The actual full-text index lives
 * in the `@neutronai/chat-core` {@link Store} (SQLite FTS5 on op-sqlite/wasm,
 * tokenised JS in-memory otherwise) — this module is the thin request-mapping
 * + tool-surface layer over it, so nothing here re-implements ranking or
 * highlighting (the Store owns both).
 *
 * Two runtime shapes:
 *
 *   - {@link StoreMessageSearchRuntime} — generic over ANY chat-core Store.
 *     The store holds every topic, so it supports global cross-topic search.
 *     This is what a client (web/RN) uses against its own durable store.
 *   - {@link HistorySourceMessageSearchRuntime} — server-side. The gateway
 *     doesn't keep a chat-core message Store; it keeps per-topic turn history
 *     (e.g. behind ButtonStore). This runtime hydrates an EPHEMERAL in-memory
 *     FTS index from one topic's recent history and searches it, so the live
 *     agent can answer "where did we discuss X in THIS conversation" without a
 *     persistent server-side message index. Cross-topic global search is the
 *     client store's job.
 */

import {
  InMemoryStore,
  type ChatMessage,
  type MessageSearchHit,
  type MessageSearchOptions,
  type Store,
} from '@neutronai/chat-core'

/** A scoped message-search request, as the agent tool issues it. */
export interface MessageSearchRequest {
  /** Free-text query (keywords or a phrase). */
  query: string
  /** Restrict to one topic. The server runtime defaults this to the calling
   *  conversation's topic; omit + set {@link MessageSearchRequest.global} to
   *  search everywhere (store-backed runtime only). */
  topic_id?: string
  /** Restrict to one project. */
  project_id?: string
  /** Max hits; the Store clamps to its own bounds. */
  limit?: number
  /** Search across ALL topics in the backing store. Honoured only by a
   *  store-backed runtime that actually holds every topic. */
  global?: boolean
}

/** What the agent tool calls; both runtime shapes satisfy it. */
export interface MessageSearchRuntime {
  search(req: MessageSearchRequest): Promise<MessageSearchHit[]>
}

/** Map a request onto {@link MessageSearchOptions}, honouring `global`. */
function toOptions(req: MessageSearchRequest, forceTopic?: string): MessageSearchOptions {
  const opts: MessageSearchOptions = {}
  const topic = forceTopic ?? (req.global === true ? undefined : req.topic_id)
  if (topic !== undefined && topic.length > 0) opts.topic_id = topic
  if (req.project_id !== undefined && req.project_id.length > 0) opts.project_id = req.project_id
  if (req.limit !== undefined) opts.limit = req.limit
  return opts
}

/**
 * Generic runtime over any chat-core {@link Store}. The store owns the FTS
 * index across every topic, so this supports topic-scoped, project-scoped, and
 * global search alike — it just translates the request and delegates.
 */
export class StoreMessageSearchRuntime implements MessageSearchRuntime {
  private readonly store: Store
  constructor(store: Store) {
    this.store = store
  }
  search(req: MessageSearchRequest): Promise<MessageSearchHit[]> {
    return this.store.searchMessages(req.query, toOptions(req))
  }
}

/**
 * A per-topic source of chat history, decoupled from any concrete server store
 * (e.g. an adapter over ButtonStore turns). Returns plain {@link ChatMessage}
 * rows; ordering is irrelevant since the FTS re-ranks.
 */
export interface MessageHistorySource {
  loadTopicMessages(topic_id: string, limit: number): Promise<ChatMessage[]>
}

/** Default ceiling on how many recent turns the server hydrates per search. */
export const DEFAULT_HYDRATE_LIMIT = 2000

/**
 * Server-side runtime backed by a per-topic {@link MessageHistorySource}.
 * Hydrates an ephemeral {@link InMemoryStore} from the topic's recent history
 * and searches it — no persistent server FTS DB. Per-topic by design: a
 * `global` request returns nothing here (cross-topic search belongs to the
 * client's own store).
 */
export class HistorySourceMessageSearchRuntime implements MessageSearchRuntime {
  private readonly source: MessageHistorySource
  private readonly hydrateLimit: number
  constructor(source: MessageHistorySource, hydrateLimit: number = DEFAULT_HYDRATE_LIMIT) {
    this.source = source
    this.hydrateLimit = hydrateLimit
  }

  async search(req: MessageSearchRequest): Promise<MessageSearchHit[]> {
    const topic = req.topic_id
    // No topic to anchor on (e.g. a global request, or a system-spawned call
    // with no originating conversation) → nothing to search server-side.
    if (req.global === true || topic === undefined || topic.length === 0) return []
    const messages = await this.source.loadTopicMessages(topic, this.hydrateLimit)
    if (messages.length === 0) return []
    const store = new InMemoryStore()
    for (const m of messages) await store.upsert(m)
    return store.searchMessages(req.query, toOptions(req, topic))
  }
}
