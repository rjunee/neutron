export const __MODULE__ = '@neutronai/gbrain-memory' as const

export type { MemoryStore } from './memory-store.ts'
export { GBrainUnavailableError, isGbrainBinaryMissingError } from './memory-store.ts'
export type { McpClient } from './mcp-client.ts'
export {
  GBrainSyncHook,
  type GBrainSyncHookOptions,
  type SyncHookFailureEvent,
  type GbrainSyncStateSnapshot,
  type GbrainSyncStateSink,
} from './GBrainSyncHook.ts'
export { GBrainMemoryStore } from './gbrain-memory-store.ts'
export {
  resolveEmbedderConfig,
  buildOpenAiEmbedderConfig,
  probeOllamaHealth,
  type EmbedderConfig,
  type OllamaHealthCheck,
} from './embedder-config.ts'
export {
  ensureBrainInitialized,
  isBrainInitialized,
  brainConfigPath,
  resolveInitEmbeddingTarget,
  type EnsureBrainInitInput,
  type EnsureBrainInitResult,
  type EnsureBrainInitStatus,
} from './ensure-brain-init.ts'
export {
  GBrainStdioMcpClient,
  type GBrainStdioMcpClientOptions,
} from './gbrain-stdio-client.ts'
export {
  resolveGbrainCommand,
  resolveGbrainChildPath,
  resolveBunDir,
  gbrainProbePaths,
} from './resolve-gbrain-command.ts'
export {
  GBrainVersionNotice,
  parseUpgradeMarker,
  type GBrainUpgradeMode,
  type GBrainUpgradeNotice,
} from './version-notice.ts'
export {
  GBRAIN_REF,
  GBRAIN_GIT_URL,
  runDoctor,
  decideUpgrade,
  runUpgrade,
  realProbes,
  shortRef,
  renderDoctorReport,
  resolveStatePath,
  readDoctorState,
  writeDoctorState,
  resolveLatestUpstreamRef,
  buildInstallCommand,
  bunCommandRunner,
  type DoctorCheck,
  type DoctorCheckName,
  type DoctorReport,
  type DoctorProbes,
  type ProbeResult,
  type UpgradeDecision,
  type UpgradeOptions,
  type UpgradeResult,
  type DoctorState,
  type CommandRunner,
  type CommandResult,
} from './gbrain-doctor.ts'
