/**
 * @neutronai/chat-core — transport-agnostic chat-sync client library.
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
  normalizeReceiptUpdate,
  normalizeReactionUpdate,
  normalizeEditUpdate,
  parseSessionReadyMaxSeq,
  parseReactions,
  parseOptions,
  parseUploadAffordance,
  parseCitations,
  parseDocRefs,
  sortReactions,
  messageIdentity,
  AGENT_DEVICE_ID,
  type MessageRole,
  type SendStatus,
  type ReceiptState,
  type ReactionAction,
  type EditAction,
  type MessageReaction,
  type ChatMessage,
  type ChatMessageOption,
  type ChatMessageUploadAffordance,
  type ChatMessageCitation,
  type ChatMessageDocRef,
  type PromptKind,
  type InboundChatMessage,
  type InboundReceiptUpdate,
  type InboundReactionUpdate,
  type InboundEditUpdate,
  type OutboundUserMessage,
  type OutboundResume,
  type OutboundReceipt,
  type OutboundReaction,
  type OutboundEdit,
  type OutboundButtonChoice,
} from './types.ts'

export {
  InMemoryStore,
  compareForDisplay,
  mergeMessage,
  unionDeviceIds,
  pickReactionState,
  pickEditState,
  pickAgentMeta,
  normalizeReactions,
  groupReactions,
  type ReactionChip,
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
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  type ConnStatus,
  type SocketLike,
  type ChatWsClientOptions,
} from './ws-client.ts'

export { OpfsChatStore, createWebStore } from './stores/opfs-store.ts'

export {
  WebChatSession,
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_RESUME_FALLBACK_MS,
  type WebChatSessionOptions,
} from './web-session.ts'
