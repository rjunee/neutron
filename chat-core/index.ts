/**
 * @neutron/chat-core — transport-agnostic chat-sync client library.
 *
 * The shared logic layer of the web↔mobile chat stack (research doc §7):
 * a reconnecting WS client, an idempotent offline send-queue, an append-only
 * sync engine (server-seq cursor + resume replay + UPSERT dedup + order-by-
 * seq), and a pluggable local Store (OPFS on web today; wasm-SQLite / op-
 * sqlite drop in behind the same interface). Platform UIs (vanilla-TS web,
 * Expo RN) consume this; nothing here imports a UI framework or a transport.
 */

export {
  normalizeInbound,
  messageIdentity,
  type MessageRole,
  type SendStatus,
  type ChatMessage,
  type InboundChatMessage,
  type OutboundUserMessage,
  type OutboundResume,
} from './types.ts'

export {
  InMemoryStore,
  compareForDisplay,
  mergeMessage,
  type Store,
} from './store.ts'

export {
  sanitizeFtsQuery,
  searchMessagesInMemory,
  queryTerms,
  buildSnippet,
  clampSearchLimit,
  minMaxNormalise,
  toHit,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  type MessageSearchHit,
  type MessageSearchOptions,
} from './search.ts'

export { SyncEngine, type ApplyResult } from './sync-engine.ts'

export {
  SendQueue,
  type SendQueueOptions,
  type EnqueueInput,
  type SendFn,
} from './send-queue.ts'

export {
  ChatWsClient,
  type ConnStatus,
  type SocketLike,
  type ChatWsClientOptions,
} from './ws-client.ts'

export { OpfsChatStore, createWebStore } from './stores/opfs-store.ts'

export { WebChatSession, type WebChatSessionOptions } from './web-session.ts'
