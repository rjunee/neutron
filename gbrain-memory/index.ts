export const __MODULE__ = '@neutronai/gbrain-memory' as const

export type { MemoryStore, McpClient } from './memory-store.ts'
export { GBrainUnavailableError, isGbrainBinaryMissingError } from './memory-store.ts'
export {
  GBrainSyncHook,
  type GBrainSyncHookOptions,
  type SyncHookFailureEvent,
} from './GBrainSyncHook.ts'
export { GBrainMemoryStore } from './gbrain-memory-store.ts'
export {
  resolveEmbedderConfig,
  type EmbedderConfig,
} from './embedder-config.ts'
export {
  GBrainStdioMcpClient,
  type GBrainStdioMcpClientOptions,
} from './gbrain-stdio-client.ts'
export {
  GBrainVersionNotice,
  parseUpgradeMarker,
  type GBrainUpgradeMode,
  type GBrainUpgradeNotice,
} from './version-notice.ts'
