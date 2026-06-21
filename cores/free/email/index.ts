/**
 * @neutronai/email-managed-core — public barrel.
 *
 * Tier 1 free Email-Managed Core. Surfaces six MCP tools to the
 * launcher (list / read / search / summarize / draft_prepare /
 * triage) against Gmail, four `/email` chat commands, a Haiku-driven
 * daily triage agent, a Haiku-driven prose-brief summarizer, and the
 * mandatory owner 4-point draft policy (INBOX + IMPORTANT + UNREAD
 * applied atomically via drafts.create → threads.modify).
 *
 * Bundled into the public OSS repo at
 * `cores/free/email/` per the locked 2-tier Cores model
 * (`docs/research/neutron-cores-marketplace-split-2026-05-17.md`).
 *
 * S1 (sprint email-managed-core-tier1, 2026-05-20): production
 * Gmail v1 REST client wired through OAuthTokenManager, chat
 * commands, daily-triage + prose-brief agents, mandatory the owner
 * 4-point draft policy, per-project Gmail-label filtering, per-
 * project SQLite sidecar.
 *
 * SEND IS NOT SUPPORTED. The Core has no send tool — drafts only.
 * Tier 2 paid Email-Private Core ships send.
 */

export const __MODULE__ = '@neutronai/email-managed-core' as const

export {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  OAUTH_SECRET_LABEL,
  PROJECT_LABEL_PREFIX,
  READ_CAPABILITY,
  SEND_CAPABILITY,
  DEFAULT_DRAFT_LABEL_IDS,
  TOOL_NAMES,
  WRITE_CAPABILITY,
  loadManifest,
  projectLabelName,
  type EmailToolName,
  type OwnerDraftLabel,
} from './src/manifest.ts'

export {
  DEFAULT_LABEL,
  DEFAULT_LIST_LIMIT,
  DraftLabelingError,
  EmailHeaderInjectionError,
  GoogleGmailApiError,
  MessageNotFoundError,
  OAuthMissingError,
  buildGoogleGmailClient,
  buildInMemoryGmailClient,
  buildRawMessage,
  buildSeededInMemoryGmailClient,
  buildStubEmailSummarizer,
  type BuildRawMessageInput,
  type EmailSummarizer,
  type EmailSummary,
  type FetchLike,
  type GmailClient,
  type GmailDraftInput,
  type GmailDraftResult,
  type GmailGetInput,
  type GmailLabelEnsureInput,
  type GmailLabelEnsureResult,
  type GmailListInput,
  type GmailListResult,
  type GmailMessageFull,
  type GmailMessageMeta,
  type GmailSearchInput,
  type GmailSendInput,
  type GmailSendResult,
  type GmailThreadModifyInput,
  type GmailThreadModifyResult,
  type GoogleGmailClientOptions,
  type InMemoryGmailSeed,
  type SeededInMemoryGmailClient,
} from './src/backend.ts'

export {
  applyDraftVisibilityLabels,
  plannedDraftLabels,
  retryDraftLabels,
} from './src/draft-policy.ts'

export {
  buildTools,
  type BuiltTools,
  type EmailDraftPrepareToolInput,
  type EmailDraftPrepareToolOutput,
  type EmailListToolInput,
  type EmailListToolOutput,
  type EmailReadToolInput,
  type EmailReadToolOutput,
  type EmailSearchToolInput,
  type EmailSearchToolOutput,
  type EmailSendToolInput,
  type EmailSendToolOutput,
  type EmailSummarizeToolInput,
  type EmailSummarizeToolOutput,
  type EmailTriageToolInput,
  type EmailTriageToolOutput,
  type ToolDeps,
} from './src/tools.ts'

export {
  EmailProjectCache,
  EmailProjectCacheResolver,
  EMAIL_SCHEMA_VERSION,
  EMAIL_SIDECAR_DB,
  EMAIL_SIDECAR_DIR,
  EmailSidecarMismatchError,
  SUMMARY_CACHE_TTL_MS,
  type DraftAuditRow,
  type EmailProjectCacheOptions,
  type EmailProjectCacheResolverOptions,
  type ProjectLabelCacheRow,
  type SummaryCacheRow,
  type TriageCacheRow,
} from './src/cache.ts'

export {
  previewProjectLabelName,
  resolveProjectLabel,
  type ResolvedProjectLabel,
} from './src/per-project-resolver.ts'

export {
  BRIEF_PROMPT_TEMPLATE,
  briefTemplateHash,
  composeBriefSummary,
  renderBriefPrompt,
  type BriefSummary,
  type ComposeBriefSummaryDeps,
} from './src/summarizer.ts'

export {
  TRIAGE_PROMPT_TEMPLATE,
  TRIAGE_TOP_K,
  composeTriage,
  renderTriagePrompt,
  triagePromptTemplateHash,
  type ComposeTriageDeps,
  type Triage,
  type TriageItem,
} from './src/triage.ts'

export {
  DEFAULT_EMAIL_LLM_MAX_TOKENS,
  buildSubstrateEmailLlm,
  type BuildSubstrateEmailLlmDeps,
} from './src/substrate-llm.ts'

export {
  DEFAULT_DAILY_HOUR,
  DEFAULT_DAILY_MINUTE,
  DEFAULT_LOOKBACK_MESSAGES,
  buildTriageScheduler,
  type TriageFireInput,
  type TriageFireResult,
  type TriageScheduler,
  type TriageSchedulerOpts,
} from './src/triage-scheduler.ts'

export {
  executeEmailCommand,
  parseEmailCommand,
  type EmailCommand,
  type EmailCommandContext,
  type EmailCommandResponse,
} from './src/chat-commands.ts'

export {
  createEmailChatCommandFilter,
  type CreateEmailChatCommandFilterOptions,
  type EmailChatCommandFilter,
  type EmailChatCommandFilterInput,
  type EmailChatCommandFilterResult,
} from './src/chat-bridge.ts'

export { LAUNCHER_ICON, type LauncherIconMeta } from './src/ui/launcher-icon.ts'
export { APP_TAB_META, type AppTabMeta } from './src/ui/app-tab-surface.ts'
