/**
 * @neutronai/message-search — full-text search over the user's CHAT HISTORY.
 *
 * The chat-history twin of `@neutronai/doc-search`. The full-text index lives
 * in the `@neutron/chat-core` {@link Store} (SQLite FTS5 on op-sqlite/wasm,
 * tokenised JS in-memory otherwise); this package is the runtime + agent-tool
 * surface over it, exposing the `message_search` tool so the live agent can
 * recall what was said earlier mid-conversation.
 *
 * See docs/SYSTEM-OVERVIEW.md § Message search for the subsystem overview.
 */

export {
  StoreMessageSearchRuntime,
  HistorySourceMessageSearchRuntime,
  DEFAULT_HYDRATE_LIMIT,
  type MessageSearchRuntime,
  type MessageSearchRequest,
  type MessageHistorySource,
} from './runtime.ts'

export { registerMessageSearchToolSurface, MESSAGE_SEARCH_TOOL } from './tool.ts'
