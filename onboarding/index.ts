/**
 * @neutronai/onboarding — public barrel.
 *
 * P2 S2 surface: interview engine + archetypes + persona-gen + APIs.
 * History import (S3), wow-moment + profile-pic (S4), promote-to-group
 * (S5), and M2 measurement (S6) layer on top of these primitives.
 */

export {
  COOLDOWN_AFTER_PAUSED_MS,
  IMPORT_PARTIAL_THRESHOLD,
  IMPORT_RUNNING_HARD_TIMEOUT_CEILING_MS,
  IMPORT_RUNNING_HARD_TIMEOUT_MS,
  IMPORT_RUNNING_PER_CHUNK_FLOOR_MS,
  IMPORT_RUNNING_SOFT_TIMEOUT_MS,
  MAX_RATE_LIMIT_RESUME_CYCLES,
  InterviewEngine,
  InterviewError,
  DEFAULT_RESUME_GAP_MS,
  computeImportHardTimeoutMs,
  type AdvanceInput,
  type AdvanceResult,
  type AdvanceOutcome,
  type ImportResumeReadinessProbe,
  type InterviewEngineDeps,
  type InterviewErrorCode,
  type PersonaComposerHook,
  type PersonaSyncHook,
  type SendButtonPromptFn,
  type StartInput,
  type StartResult,
} from './interview/engine.ts'

// Deterministic short-question fallback table (the static phase prompts).
export { STATIC_PHASE_SPECS } from './interview/phase-prompts.ts'
// Shared LLM field-extraction primitives. The `promptDriver` seam that
// once lived alongside these was never wired in production and was removed
// in the 2026-06-21 onboarding-engine consolidation; the surviving
// `llmRouter` extraction path consumes `ExtractedFields`.
export { type ExtractedFields } from './interview/extracted-fields.ts'

export {
  ALL_PHASES,
  isLegalTransition,
  LEGAL_TRANSITIONS,
  TERMINAL_PHASES,
  type OnboardingPhase,
} from './interview/phase.ts'

// WAVE 1 credential-management — up-front OPTIONAL key offers (Codex auth /
// OpenAI key), validated + persisted via the existing ApiKeyStore.
export {
  OPTIONAL_KEY_OFFERS,
  ONBOARDING_OPENAI_LABEL,
  detectOptionalKey,
  getOptionalKeyOffer,
  listOptionalKeyOffers,
  looksLikeOpenAiKey,
  storeOptionalKey,
  type OptionalKeyApiKeyStore,
  type OptionalKeyId,
  type OptionalKeyOffer,
  type OptionalKeyProvider,
  type OptionalKeyStorage,
  type OptionalKeyValidation,
  type StoreOptionalKeyInput,
  type StoreOptionalKeyOutcome,
  type StoreOptionalKeyResult,
} from './optional-keys.ts'

export {
  RESUME_PROMPT_OPTIONS,
  RESUME_PROMPT_BODY_PREFIX,
  buildResumePromptBody,
  humanizePhase,
  type PhasePromptSpec,
} from './interview/phase-prompts.ts'

export {
  TranscriptWriter,
  type TranscriptEntry,
  type TranscriptRole,
  type TranscriptWriterOptions,
} from './interview/transcript.ts'

export {
  InMemoryOnboardingStateStore,
  type InMemoryOnboardingStateStoreOptions,
  type OnboardingState,
  type OnboardingStateStore,
  type UpsertOnboardingStateInput,
} from './interview/state-store.ts'

export {
  SqliteOnboardingStateStore,
  type SqliteOnboardingStateStoreOptions,
} from './interview/sqlite-state-store.ts'

export {
  DEFAULT_IMPORT_RUNNING_TICK_INTERVAL_MS,
  ONBOARDING_IMPORT_RUNNING_HANDLER_NAME,
  buildImportRunningHandler,
  buildImportRunningJob,
  registerImportRunningCron,
  type ImportRunningHandlerDeps,
} from './interview/import-running-cron.ts'

export {
  ArchetypeLibrary,
  ArchetypeError,
  diceCoefficient,
  type Archetype,
  type ArchetypeErrorCode,
  type ArchetypeLibraryDeps,
  type ArchetypeSource,
} from './archetypes/library.ts'

export {
  composeArchetypeBlend,
  MIN_BLEND,
  MAX_BLEND,
  type BlendedArchetype,
} from './archetypes/compose.ts'

export {
  buildLlmExtensionParser,
  parseExtensionMarkdown,
  InMemoryExtensionCache,
  type LlmExtensionFn,
  type LlmExtensionInput,
  type LlmExtensionParts,
} from './archetypes/llm-extension.ts'

export {
  buildCringeChecker,
  deterministicCringe,
  CRINGE_PATTERNS,
  type CringeChecker,
  type CringeCheckerDeps,
  type CringeCheckResult,
  type PersonaFile,
} from './persona-gen/cringe-check.ts'

export {
  generateSoulMd,
  type InterviewSignals,
  type SoulGenInput,
} from './persona-gen/soul.ts'

export {
  generateUserMd,
  type UserFacts,
} from './persona-gen/user.ts'

export {
  generatePriorityMapMd,
  type PriorityMapInput,
} from './persona-gen/priority-map.ts'

export {
  PersonaComposer,
  PersonaError,
  type ApplyEditInput,
  type ComposeInput,
  type LineEdit,
  type PersonaComposerDeps,
  type PersonaDraft,
  type PersonaErrorCode,
  type PersonaRegenerator,
} from './persona-gen/compose.ts'

export {
  handlePersonaEdit,
  type PersonaEditStore,
  type PersonaEditRequest,
  type PersonaEditResponse,
  type PersonaEditStatus,
} from './api/persona-edit.ts'

// Sprint B (2026-05-20) — admin-observability moved to the Managed
// provisioning module (`provisioning/onboarding-api/admin-observability.ts`).
// The re-export here was removed to satisfy the Open/Managed import gate
// (`runtime|gateway|channels|onboarding|persistence|cores` must not
// import from the Managed provisioning layer). The two known callers (P8
// admin UI + `scripts/onboarding-report.sh`) import the Managed
// module directly.

export {
  ALL_ONBOARDING_EVENT_NAMES,
  DEFAULT_CHECK_INTERVAL_MS,
  FOUR_WEEKS_MS,
  LEGACY_ATTEMPT_ID,
  OnboardingTelemetry,
  SEAN_ELLIS_HANDLER_NAME,
  SEAN_ELLIS_PROMPT_BODY,
  SEAN_ELLIS_PROMPT_OPTIONS,
  SeanEllisStore,
  bridgeArchetypeTelemetry,
  bridgeCompletionTelemetry,
  bridgeImportTelemetry,
  bridgeInterviewTelemetry,
  bridgePersonaTelemetry,
  bridgeProfilePicTelemetry,
  bridgeSignupTelemetry,
  bridgeWowEventLogger,
  buildSeanEllisHandler,
  buildSeanEllisJob,
  buildStdoutEventLogger,
  composeOnboardingTelemetrySinks,
  moduleForEventName,
  registerSeanEllisCron,
  type ArchetypeTelemetrySink,
  type BridgeWowDefaults,
  type CompletionTelemetrySink,
  type ComposedTelemetrySinks,
  type EventLogger,
  type ImportTelemetrySink,
  type InterviewTelemetrySink,
  type OnboardingEvent,
  type OnboardingEventLevel,
  type OnboardingEventModule,
  type OnboardingEventName,
  type OnboardingEventPayloadByName,
  type OnboardingTelemetryDeps,
  type PersistedOnboardingEvent,
  type PersonaTelemetrySink,
  type ProfilePicTelemetrySink,
  type SeanEllisChannel,
  type SeanEllisHandlerDeps,
  type SeanEllisResponsePayload,
  type SeanEllisRow,
  type SignupTelemetrySink,
} from './telemetry/index.ts'

export {
  DEFAULT_M2_FEEDBACK_PATH,
  M2FeedbackCollector,
  applySeanEllisFreeform,
  formatMarkdownEntry,
  routeSeanEllisChoice,
  type M2FeedbackCollectorDeps,
  type M2ResponseKind,
  type RecordResponseInput,
  type RecordResponseResult,
  type SeanEllisChoiceOutcome,
  type SeanEllisChoiceRouterInput,
  type SeanEllisFreeformInput,
} from './feedback/m2-week-4-collector.ts'

export {
  ActionRunner,
  WowTelemetry,
  ALL_WOW_ACTION_IDS,
  pickWowActions,
  type WowActionContext,
  type WowActionId,
  type WowActionModule,
  type WowActionResult,
  type WowChannelAdapter,
  type WowEngagement,
  type WowEventRow,
  type WowFiredEvent,
  type WowEngagedEvent,
  type WowInterviewState,
  type WowTelemetryDeps,
  type WowSelectorCollectedData,
  type WowSelectorInput,
  type WowSelectorResult,
  type RitualEntry,
  type CapturedProject,
  type StalledEmailThread,
  type GmailScopeState,
  type GmailDraftClient,
  type BriefSubstrate,
  type NonWorkInterest,
} from './wow-moment/index.ts'

export {
  ProfilePicPipeline,
  ProfilePicError,
  GeminiImagenClient,
  GeminiImagenError,
  FallbackGallery,
  FallbackGalleryError,
  FALLBACK_ARCHETYPE_SLUGS,
  FALLBACK_DEFAULT_SLUG,
  archetypeHintToFallbackSlug,
  buildPortraitPickPrompt,
  buildPortraitWaitPrompt,
  normalizeArchetype,
  PORTRAIT_PICK_PROMPT_BODY,
  PORTRAIT_WAIT_PROMPT_BODY,
  type FallbackArchetypeSlug,
  type FallbackPortrait,
  type GeminiImagenClientDeps,
  type GeminiImagenFn,
  type GeminiImagenInput,
  type GeminiImagenOutput,
  type GeminiImageCandidate,
  type ProfilePicErrorCode,
  type ProfilePicJob,
  type ProfilePicJobStatus,
  type ProfilePicPipelineDeps,
  type StartProfilePicInput,
  type StartProfilePicResult,
} from './profile-pic/index.ts'

// multi-sub (Managed-only credential-pool UI) relocated to the Managed
// provisioning layer (provisioning/multi-sub/ at C2) — Managed consumers
// import the barrel there; the Open onboarding barrel no longer re-exports it.

export {
  CHUNK_TARGET_TOKENS,
  DEFAULT_OWNER_CAP_DOLLARS,
  ImportError,
  PER_SOURCE_CAPS,
  RATE_LIMIT_BACKOFF_MS_DEFAULT,
  RATE_LIMIT_BACKOFF_TOTAL_MS_DEFAULT,
  WARNING_RATIO,
  ZipReadError,
  buildDefaultSourceParser,
  chunkConversations,
  computeChunkHash,
  is429RetryableError,
  parseChatgptExport,
  parseClaudeExport,
  type CandidateEntity,
  type CandidateTask,
  type CandidateTopic,
  type Chunk,
  type ChunkerInput,
  type ChunkerOptions,
  type ConversationMessage,
  type ConversationRecord,
  type ImportErrorCode,
  type ImportJob,
  type ImportJobStatus,
  type ImportResult,
  type ImportSource,
  type Pass1ChunkResult,
  type SourceParser,
  type VoiceSignals,
  type ZipEntry,
} from './history-import/index.ts'
