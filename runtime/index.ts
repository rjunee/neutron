/**
 * @neutronai/runtime — public barrel.
 *
 * Substrate dispatcher contract + shared runtime primitives. Adapters live as
 * sibling subdirectories under `runtime/adapters/<substrate-kind>/` and import
 * the locked types from this package.
 */

export const __MODULE__ = '@neutronai/runtime' as const

export type { Substrate, AgentSpec, Message } from './substrate.ts'
export type { SessionHandle } from './session-handle.ts'
export type { Event, TokenUsage, SubstrateErrorClass } from './events.ts'

export { NeutronError, SubstrateCallError, SUBSTRATE_ERROR_CODES } from './errors.ts'
export type { SubstrateErrorCodeSpec } from './errors.ts'

export { drainToText, drainToOutcome } from './substrate-text.ts'
export type { DrainOptions, DrainOutcome, DrainStatus } from './substrate-text.ts'

export {
  selectCredential,
  reportFailure,
  reportSuccess,
  newCredentialPool,
  COOLDOWN_429_MS,
  COOLDOWN_402_MS,
  COOLDOWN_401_MS,
  MAX_CONSECUTIVE_FAILURES,
} from './credential-pool.ts'
export type {
  PooledCredential,
  CredentialPool,
  CredentialKind,
  CredentialStrategy,
  CooldownReason,
} from './credential-pool.ts'

export {
  newDetectorState,
  checkToolCall,
  REPEAT_IDENTICAL_LIMIT,
  PINGPONG_LIMIT,
  COOLDOWN_WINDOW_MS,
  COOLDOWN_MAX_PER_WINDOW,
} from './tool-loop-detection.ts'
export type { DetectorState, LoopGuardDecision, ToolCallProbe } from './tool-loop-detection.ts'

export {
  KNOWN_PLATFORM_HINTS,
  selectPlatformHints,
  getPlatformHint,
} from './platform-hints.ts'
export type { ChannelKind, PlatformHintName } from './platform-hints.ts'

export { assembleSystemPrompt } from './system-prompt.ts'
export type { SystemPromptInput } from './system-prompt.ts'

export {
  buildDocLink,
  findInlineDocLinks,
  parseDocLink,
  rewriteDocRefsInBody,
  resolveDocRefs,
  deriveLabel,
  DocLinkError,
  NEUTRON_SCHEME,
  WEB_APP_BASE,
  VAULT_REDIRECTOR_BASE,
  MAX_DOC_PATH_LEN,
  MAX_PROJECT_ID_LEN as MAX_DOC_LINK_PROJECT_ID_LEN,
} from './doc-links.ts'
export type {
  DocLinkChannel,
  BuildDocLinkInput,
  InlineDocLinkMatch,
  ParsedDocLink,
  DocRef,
  ResolvedDocRef,
} from './doc-links.ts'
