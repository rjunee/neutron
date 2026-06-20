/**
 * @neutronai/onboarding/history-import — public barrel.
 *
 * P2 S3 surface per docs/plans/P2-onboarding.md § 6 S3 (lines 1990-2052).
 * S4 (wow-moment dispatcher) consumes `ImportJobRunner.status` + the
 * resulting `ImportResult` — see § 8 dependency contracts row 1
 * (`onboarding/history-import/job-runner.ts:ImportResult`).
 *
 * v0.1.78 (2026-05-22) — `BudgetCap` removed. The brief: Max-OAuth
 * owners don't pay marginal cost, so the $X cap subsystem (and the
 * 80% warning / Continue-Stop-Skip prompt) was misleading at best.
 * `dollars_spent` stays on `import_jobs` for telemetry; nothing reads it.
 */

export {
  ImportError,
  CHUNK_TARGET_TOKENS,
  MAX_OAUTH_CHUNK_TARGET_TOKENS,
  APPROX_CHARS_PER_TOKEN,
  DEFAULT_OWNER_CAP_DOLLARS,
  PER_SOURCE_CAPS,
  WARNING_RATIO,
  type CandidateEntity,
  type CandidateTask,
  type CandidateTopic,
  type Chunk,
  type ChunkerInput,
  type ConversationMessage,
  type ConversationRecord,
  type ImportErrorCode,
  type ImportJob,
  type ImportJobStatus,
  type ImportResult,
  type ImportSource,
  type OAuthRefs,
  type Pass1ChunkResult,
  type VoiceSignals,
} from './types.ts'

export {
  parseChatgptExport,
} from './chatgpt-export.ts'

export {
  parseClaudeExport,
} from './claude-export.ts'

export {
  chunkConversations,
  computeChunkHash,
  type ChunkerOptions,
} from './chunker.ts'

export {
  pass1Triage,
  parsePass1Result,
  type Pass1Deps,
  type Pass1LlmCall,
} from './pass1-triage.ts'

export {
  aggregatePass1,
  pass2Synthesize,
  parsePass2Result,
  type AggregatedPass1,
  type Pass2Deps,
  type Pass2LlmCall,
} from './pass2-synthesis.ts'

export {
  ImportJobRunner,
  RATE_LIMIT_BACKOFF_MS_DEFAULT,
  RATE_LIMIT_BACKOFF_TOTAL_MS_DEFAULT,
  is429RetryableError,
  type CredentialKindResolver,
  type EntityPopulatorWriteEntityFn,
  type ImportJobRunnerDeps,
  type ImportPopulatorSyncHook,
  type SourceParser,
  type StartImportInput,
} from './job-runner.ts'

export {
  fetchGmailThreads,
  type FetchGmailThreadsInput,
  type GmailClient,
} from './oauth-gmail.ts'

export {
  fetchCalendarEvents,
  type CalendarClient,
  type FetchCalendarEventsInput,
} from './oauth-calendar.ts'

export { DRIVE_STUB_MESSAGE } from './oauth-drive.ts'
export { NOTION_STUB_MESSAGE } from './oauth-notion.ts'
export { SLACK_STUB_MESSAGE } from './oauth-slack.ts'

export {
  ZipReadError,
  listEntries,
  readEntry,
  findEntry,
  type ZipEntry,
} from './zip-reader.ts'

export { buildDefaultSourceParser, type DefaultParserDeps } from './default-source-parser.ts'

export {
  populateEntitiesFromImport,
  slugify,
  POPULATOR_MENTION_COUNT_MIN,
  type EntityPopulatorDeps,
  type EntityPopulatorInput,
  type EntityPopulatorReport,
  type WriteEntityFn,
} from './entity-populator.ts'

export {
  buildPass1SubstrateCaller,
  buildPass2SubstrateCaller,
  extractJsonObject,
  type BuildPass1SubstrateCallerDeps,
  type BuildPass2SubstrateCallerDeps,
  type Pass2SonnetFallbackHook,
  type Pass2SonnetFallbackInfo,
} from './substrate-callers.ts'
