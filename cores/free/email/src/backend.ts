/**
 * @neutronai/email-managed-core — GmailClient interface + reference
 * adapters + EmailSummarizer abstraction.
 *
 * The Tier 1 Email-Managed Core programs against a narrow `GmailClient`
 * (listMessages / getMessage / search / createDraft). Production: a
 * thin Gmail API v1 REST wrapper backed by an OAuth bearer token
 * resolved lazily from the per-Core SecretsAccessor + a refresh-token
 * exchange (handled at the runtime composition layer — for v1 the
 * access token persisted at install time is what we use).
 *
 * Tests never hit the real Gmail API. The Core ships an in-memory
 * `buildInMemoryGmailClient()` that matches the same contract, so the
 * `__tests__/tools.test.ts` suite exercises the full tool wiring
 * end-to-end without network.
 *
 * Why this interface lives in the Core (not under a shared
 * `email/` substrate yet):
 * - There is no canonical `email/` workspace package today. The
 *   Tier 2 Email-Private variant would justify one when send + non-
 *   Gmail providers ship. Until then the Core owns its own client
 *   surface; the substrate-side email package can layer on later.
 *
 * Ordering: list / search return MESSAGES NEWEST-FIRST by Gmail
 * `internalDate` DESCENDING — the natural inbox semantic ("most
 * recent at the top"). Distinct from the Calendar Core's chronological-
 * ascending ordering (meetings face forward; inboxes face backward).
 *
 * SEND IS NOT SUPPORTED. The Core deliberately omits `messages.send` /
 * `drafts.send` from the client surface AND from the manifest's
 * declared capabilities AND from the OAuth scope grant (the
 * 3-scope split is gmail.readonly + gmail.modify + gmail.compose;
 * gmail.send is excluded). A Tier 2 paid Email-Private Core will
 * ship that surface; this one prepares drafts only. Drafts land in
 * the user's Gmail Drafts label and require an explicit human
 * action to send.
 */

// D5 refactor (2026-07-09): this module is now a BARREL. The
// implementation split along its six clean sections into sibling
// modules — `contract.ts` (types/interfaces + shared defaults),
// `errors.ts` (typed error classes), `in-memory.ts` (both in-memory
// fakes), `google-client.ts` (production Gmail v1 REST wrapper),
// `mime.ts` (security-relevant MIME parsing/building) and
// `summarizer.ts` (EmailSummarizer abstraction + stub). The public
// surface re-exported here is byte-identical to the pre-split module.

export {
  DEFAULT_LABEL,
  DEFAULT_LIST_LIMIT,
} from './contract.ts'
export type {
  GmailClient,
  GmailDraftInput,
  GmailDraftResult,
  GmailGetInput,
  GmailLabelEnsureInput,
  GmailLabelEnsureResult,
  GmailListInput,
  GmailListResult,
  GmailMessageFull,
  GmailMessageMeta,
  GmailSearchInput,
  GmailSendInput,
  GmailSendResult,
  GmailThreadFull,
  GmailThreadGetInput,
  GmailThreadModifyInput,
  GmailThreadModifyResult,
} from './contract.ts'

export {
  DraftLabelingError,
  EmailHeaderInjectionError,
  GoogleGmailApiError,
  MessageNotFoundError,
  OAuthMissingError,
  ThreadNotFoundError,
} from './errors.ts'

export {
  buildInMemoryGmailClient,
  buildSeededInMemoryGmailClient,
} from './in-memory.ts'
export type {
  InMemoryGmailSeed,
  SeededInMemoryGmailClient,
} from './in-memory.ts'

export { buildGoogleGmailClient } from './google-client.ts'
export type {
  FetchLike,
  GoogleGmailClientOptions,
} from './google-client.ts'

export { buildRawMessage } from './mime.ts'
export type { BuildRawMessageInput } from './mime.ts'

export { buildStubEmailSummarizer } from './summarizer.ts'
export type { EmailSummarizer, EmailSummary } from './summarizer.ts'
