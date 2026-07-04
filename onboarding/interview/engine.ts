/**
 * @neutronai/onboarding — interview engine.
 *
 * Per docs/plans/P2-onboarding.md § 4.5 + § 6 S2.
 *
 * S1 SKELETON (preserved verbatim on this class):
 *   - `start(...)` emits the hardcoded "What's your name?" prompt for the
 *     `signup → name_chosen` transition.
 *
 * S2 EXTENSION (this commit adds):
 *   - `advance(...)` walks every phase in `phase.ts:LEGAL_TRANSITIONS`.
 *     Button choices are threaded in via `AdvanceInput.choice`; this is the
 *     production entry point (chat-bridge drives `advance`, never the removed
 *     legacy single-prompt `acceptChoice`).
 *     For each phase with an entry in `phase-prompts.ts:PHASE_PROMPTS`, the
 *     engine emits the prompt, persists it via ButtonStore, accepts the
 *     inbound ButtonChoice or freeform reply, walks the legal transition,
 *     and re-enters with the next phase's prompt.
 *   - `tick()` is the cron-tick handle for resume-on-reconnect: when an
 *     instance's `last_advanced_at` is older than the resume window
 *     (default 24h), `advance(...)` emits a "welcome back" prompt before
 *     consuming the inbound. The user can Continue / Restart / Pause.
 *
 * Phases without prompts (`identity_oauth`, `import_running`,
 * `persona_synthesizing`, `wow_fired`, `completed`, `failed`) are driven
 * by external modules (identity service, import-job-runner, persona-gen,
 * wow-dispatcher). The engine's `advance` is a no-op at those phases.
 */

import {
  buildButtonPrompt,
  canonicalPromptSeed,
  deriveIdempotencyKey,
  type ButtonChoice,
  type ButtonPrompt,
  type ChannelKindForButton,
} from '../../channels/button-primitive.ts'
import type { ButtonStore } from '../../channels/button-store.ts'
import {
  isLegalTransition,
  LEGAL_TRANSITIONS,
  TERMINAL_PHASES,
  type OnboardingPhase,
  type OnboardingDeploymentMode,
} from './phase.ts'
import {
  buildAgentNameChosenPromptSpec,
  buildImportAnalysisPresentedPromptSpec,
  buildImportUploadPendingPromptSpec,
  buildMaxOauthOfferedPromptSpec,
  buildPersonalityOfferedPromptSpec,
  buildProjectsProposedPromptSpec,
  buildResumePromptBody,
  buildSlugChosenPromptSpec,
  firstNLines,
  IMPORT_RESUME_CHOICE_VALUE,
  parseCharacterChoiceIndex,
  parsePersonalitySuggestionIndex,
  PERSONALITY_CHARACTER_PREFIX,
  PERSONALITY_SUGGESTION_PREFIX,
  DEFAULT_PERSONALITY_SUGGESTIONS,
  PROJECTS_PROPOSED_CONFIRM,
  PROJECTS_PROPOSED_REVIEW,
  PROJECTS_PROPOSED_SHARE_WORK,
  PROJECTS_PROPOSED_SKIP_AHEAD,
  RESUME_PROMPT_OPTIONS,
  STATIC_PHASE_SPECS,
  stripPersonaFileH1,
  validateAgentName,
  type AiSubstrateSource,
  type BuildPersonaReviewedPromptSpecInput,
  type ImportResultForAnalysisBuilder,
  type PersonaReviewSubStep,
  type PhasePromptSpec,
} from './phase-prompts.ts'
import {
  characterNamesInRenderOrder,
  readMemoizedCharacterSuggestions,
  type CharacterSuggesterResult,
  type PersonalityCharacterSuggester,
  type PersonalityCharacterSuggestions,
} from './personality-character-suggester.ts'
import {
  readMemoizedAgentNameSuggestions,
  renderAgentNameBullets,
  type AgentNameSuggester,
  type AgentNameSuggesterResult,
  type AgentNameSuggestions,
} from './agent-name-suggester.ts'
import {
  staticPersonaSummary,
  type PersonaSummarizer,
} from '../persona-gen/summarize.ts'
import type { OnboardingStateStore, OnboardingState } from './state-store.ts'
import type { TranscriptWriter } from './transcript.ts'
// Sprint B (2026-05-20) — engine-facing slug-picker types lifted to
// `runtime/slug-picker-types.ts` so this Open-classified module no
// longer takes an import edge on the Managed provisioning layer. The
// Managed bridge (slug-picker-bridge.ts in onboarding-api)
// returns the same `SlugPickerOutcome` shape via the
// `SlugPickerEngineHook` DI seam below.
import {
  suggestedSlugFromAgentName,
} from '../../runtime/slug-picker-types.ts'
import type {
  PlatformAdapter,
  SlugAvailabilityProbe,
} from '../../runtime/platform-adapter.ts'
import { extractAgentNameFromFreeform } from './extract-agent-name.ts'
import {
  getKnowledgeForPhase,
  PHASE_INTENTS,
  type PhaseContextBundle,
  type PhaseRecentTurn,
  type PhaseSpecResolver,
} from './phase-spec-resolver.ts'
import type {
  LlmRouter,
  RouterDecision,
  RouterRecentTurn,
} from './llm-router.ts'
import {
  sanitizeUserFirstName,
  type ExtractedFields,
} from './extracted-fields.ts'
// 2026-05-28 final-handoff sprint — post-`wow_fired → completed` emit
// in the General topic. Surfaces the 3-button (web) / 2-button
// (telegram) handoff prompt the user sees as the final agent line of
// onboarding.
import {
  buildFinalHandoffPromptSpec,
  buildFinalHandoffMobileAppFollowupPromptSpec,
  buildFinalHandoffSkipFollowupPromptSpec,
  buildFinalHandoffTelegramBindFollowupPromptSpec,
  FINAL_HANDOFF_DONE_CHOICE,
  FINAL_HANDOFF_MOBILE_APP_CHOICE,
  FINAL_HANDOFF_SKIP_CHOICE,
  FINAL_HANDOFF_TELEGRAM_BIND_CHOICE,
  routeFinalHandoffFreeform,
  type FinalHandoffShape,
} from './final-handoff-prompts.ts'
import { MOBILE_APP_URL, resolveTelegramBotUsername } from './final-handoff-config.ts'
import {
  BUTTONS_ONLY_NUDGE_TEXT,
  NO_BUTTONS_FALLBACK_NUDGE_TEXT,
  IMPORT_SOURCE_SWITCH_ACK,
  LATE_UPLOAD_SOURCE_MISMATCH_NOTICE,
  detectImportSourceMention,
  deriveActiveSubStep,
  isFreeformSubStep,
  resolveInteractionMode,
  validateMixedTextInput,
} from './interaction-mode.ts'
import { auditRequiredFields } from './required-fields-audit.ts'
import type {
  ApplyEditInput as PersonaApplyEditInput,
  ComposeInput as PersonaComposeInput,
  LineEdit as PersonaLineEdit,
  PersonaDraft,
} from '../persona-gen/compose.ts'
import { looksLikeOpenAiKey } from '../optional-keys.ts'
import { PersonaError } from '../persona-gen/compose.ts'
// v0.1.80 — `PersonaFile` import dropped (Kieran r1 I1) along with the
// `readPersonaFile` / `sectionToFile` / `parseLineSelection` helpers
// the legacy `pick_replacement` flow used. The conversational tweak
// path (`pending_regen_hint`) re-composes via PersonaComposer.compose
// and never touches a specific file enum.
import type { BlendedArchetype } from '../archetypes/compose.ts'
import {
  buildPersonaReviewedPromptSpec,
  buildPersonaSynthesizingFallbackPromptSpec,
  PERSONA_MAX_RESTARTS,
  PERSONA_REVIEWED_EDIT_LINE,
  PERSONA_REVIEWED_LOOKS_GOOD,
  PERSONA_REVIEWED_RESTART,
  PERSONA_SYNTH_RETRY,
  PERSONA_SYNTH_SKIP,
  PERSONA_SYNTH_USE_BASIC,
} from './phase-prompts.ts'
import type {
  CapturedProject,
  GmailScopeState,
  RitualEntry,
  StalledEmailThread,
  WowInterviewState,
} from '../wow-moment/action-types.ts'
import {
  MAX_OAUTH_CHUNK_TARGET_TOKENS,
  type ChunkerInput,
  type ImportJob,
  type ImportResult,
  type ImportSource,
} from '../history-import/types.ts'
import {
  buildImportRunningPromptSpec,
  IMPORT_RUNNING_RETRY,
  IMPORT_RUNNING_SKIP,
  MAX_ANALYSIS_PROJECTS,
  type ImportRunningSubStep,
} from './phase-prompts.ts'
// R5 / audit P2-4 — InterviewEngineDeps + hook interfaces + public
// Start/Advance types + InterviewError + the import-routing
// constants/helpers were relocated to the dependency-free leaf
// `engine-internals.ts` so the import-routing free functions in
// `engine-import-routing.ts` can consume them without an engine.ts import
// cycle. PURE MOVE. Re-exported below for API compatibility (onboarding/
// index.ts + tests import these names from engine.ts).
import {
  AUTO_SKIP_PHASES,
  COOLDOWN_AFTER_PAUSED_MS,
  computeImportHardTimeoutMs,
  computeSwitchIntent,
  dedupeStringsCaseInsensitive,
  DEFAULT_RESUME_GAP_MS,
  IMPORT_PARTIAL_THRESHOLD,
  IMPORT_RUNNING_SOFT_TIMEOUT_MS,
  importResultHasSignal,
  InterviewError,
  isValidImportUrl,
  MAX_RATE_LIMIT_RESUME_CYCLES,
  NON_ADVANCING_CHOICE_VALUES,
  PASS2_EXPECTED_DURATION_MS,
  readImportSource,
  readNonWorkInterests,
  readNumber,
  readPersonaDraft,
  readPersonaReviewSubStep,
  readString,
  sanitizeBrowserTimezone,
  serializeDraft,
  readStringArray,
  type AdvanceInput,
  type AdvanceResult,
  type EngineInternals,
  type InterviewEngineDeps,
  type SlugPickerEngineHookInput,
  type StartInput,
  type StartResult,
  type WowDispatcherHookInput,
  type WowDispatcherHookOutcome,
  type WowDispatcherSignals,
} from './engine-internals.ts'
// Re-export the relocated public surface so external importers
// (onboarding/index.ts, tests, composer) keep importing from engine.ts.
export {
  AUTO_SKIP_PHASES,
  COOLDOWN_AFTER_PAUSED_MS,
  computeImportHardTimeoutMs,
  DEFAULT_RESUME_GAP_MS,
  evaluateImportTimeout,
  IMPORT_CONSOLIDATE_NO_PROGRESS_WINDOW_MS,
  IMPORT_NO_PROGRESS_WINDOW_MS,
  IMPORT_PARTIAL_THRESHOLD,
  IMPORT_RUNNING_HARD_TIMEOUT_CEILING_MS,
  IMPORT_RUNNING_HARD_TIMEOUT_MS,
  IMPORT_RUNNING_PER_CHUNK_FLOOR_MS,
  IMPORT_RUNNING_SOFT_TIMEOUT_MS,
  InterviewError,
  MAX_RATE_LIMIT_RESUME_CYCLES,
  type ImportTimeoutDecision,
  type ImportTimeoutReason,
} from './engine-internals.ts'
export type {
  AdvanceInput,
  AdvanceOutcome,
  AdvanceResult,
  EngineInternals,
  ImportJobRunnerHook,
  ImportPayloadResolver,
  ImportResumeReadinessProbe,
  InterviewEngineDeps,
  InterviewErrorCode,
  MaxOAuthEngineHook,
  MaxOauthSecretsStore,
  OnboardingHandoffHook,
  PersonaComposerHook,
  PersonaSyncHook,
  ProfilePicEngineHook,
  ProfilePicHookCommitInput,
  ProfilePicHookCommitOutcome,
  ProfilePicHookEnsureInput,
  ProfilePicHookEnsureOutcome,
  ProfilePicHookRegenInput,
  SendButtonPromptFn,
  SendImportProgressFn,
  SlugHistoryLookup,
  SlugPickerEngineHook,
  SlugPickerEngineHookInput,
  StartInput,
  StartResult,
  WowDispatcherHook,
  WowDispatcherHookInput,
  WowDispatcherHookOutcome,
  WowDispatcherSignals,
  WowPushEmitter,
  WowPushEmitterInput,
} from './engine-internals.ts'
// Import the extracted import-routing free functions; the class methods
// below are now one-line delegators that pass `this`.
import {
  reconcileSwitchIntentFromFreeform as importRoutingReconcileSwitchIntentFromFreeform,
  reEmitImportSourceSelection as importRoutingReEmitImportSourceSelection,
  consumeAiSubstrateOfferedChoice as importRoutingConsumeAiSubstrateOfferedChoice,
  emitImportOfferedPastePrompt as importRoutingEmitImportOfferedPastePrompt,
  reEmitImportOfferedPaste as importRoutingReEmitImportOfferedPaste,
  acceptPastedImportUrlAndStart as importRoutingAcceptPastedImportUrlAndStart,
  advanceFromAiSubstrateOfferedToUpload as importRoutingAdvanceFromAiSubstrateOfferedToUpload,
  advanceFromAiSubstrateOffered as importRoutingAdvanceFromAiSubstrateOffered,
  pollImportRunningAndAdvance as importRoutingPollImportRunningAndAdvance,
  attemptAutoResumeFromPaused as importRoutingAttemptAutoResumeFromPaused,
  degradeRateLimitExhausted as importRoutingDegradeRateLimitExhausted,
  advanceFromImportRunningOnComplete as importRoutingAdvanceFromImportRunningOnComplete,
  consumeImportAnalysisPresentedChoice as importRoutingConsumeImportAnalysisPresentedChoice,
  emitImportRunningPromptSpec as importRoutingEmitImportRunningPromptSpec,
  consumeImportRunningChoice as importRoutingConsumeImportRunningChoice,
  retryImportRunning as importRoutingRetryImportRunning,
  startImportAndAdvanceToRunning as importRoutingStartImportAndAdvanceToRunning,
  advanceToImportRunningFailed as importRoutingAdvanceToImportRunningFailed,
} from './engine-import-routing.ts'
// R5 / audit P2-4 — import the extracted persona free functions; the
// class methods below are now one-line delegators that pass `this`.
import {
  synthesizePersona as personaSynthesizePersona,
  consumePersonaReviewedChoice as personaConsumePersonaReviewedChoice,
  consumePersonaSynthesizingChoice as personaConsumePersonaSynthesizingChoice,
  advancePersonaSynthToReviewed as personaAdvancePersonaSynthToReviewed,
  advanceFromPersonaReviewed as personaAdvanceFromPersonaReviewed,
  reEmitPersonaReviewed as personaReEmitPersonaReviewed,
  shouldRetrySynthesizePersonaOnResume as personaShouldRetrySynthesizePersonaOnResume,
  consumePersonalityOfferedChoice as personaConsumePersonalityOfferedChoice,
} from './engine-persona.ts'
// R5 / audit P2-4 — import the extracted slug free functions; the class
// methods below are now one-line delegators that pass `this`.
import {
  consumeAgentNameChosenChoice as slugConsumeAgentNameChosenChoice,
  getOrStartCharacterSuggestions as slugGetOrStartCharacterSuggestions,
  getOrStartAgentNameSuggestions as slugGetOrStartAgentNameSuggestions,
  computeSlugSuggestionsForPhase as slugComputeSlugSuggestionsForPhase,
  consumeSlugChosenChoice as slugConsumeSlugChosenChoice,
  advanceFromSlugChosen as slugAdvanceFromSlugChosen,
  persistRejectionAndReEmit as slugPersistRejectionAndReEmit,
  reEmitSlugChosen as slugReEmitSlugChosen,
  maybeAutoAdvancePastMaxOauthOffered as slugMaybeAutoAdvancePastMaxOauthOffered,
  suggestionFingerprint as slugSuggestionFingerprint,
  suggestionKeyPrefix as slugSuggestionKeyPrefix,
} from './engine-slug.ts'


/**
 * P2-v3 S2 — Argus r2 [BLOCKING #2]: keys the LLM router is permitted to
 * write into `phase_state` via `RouterDecision.state_delta` (amend
 * action). The TS surface on `RouterDecision.state_delta` is
 * `Partial<RequiredFieldsState>`, but that cast is compile-time only —
 * the router's JSON-shaped LLM output can carry arbitrary keys, and any
 * key the engine doesn't reject lands in `phase_state_json`. Bookkeeping
 * fields (`created_at`, `owner_id`, `phase`, `active_prompt_id`, etc.)
 * MUST never be touched by the router.
 *
 * Allowed keys map to per-design § 4 surface:
 *   - 5 `RequiredFieldsState` fields (the user-visible "fill these out"
 *     surface the audit at § 4.4 tracks)
 *   - `auxiliary_facts` (sparse out-of-turn preference object, § 4.2(b))
 *   - `ai_substrate_available` (§ 4.3 explicit example — what substrates
 *     the user mentioned having)
 *
 * Anything else is dropped before the `stateStore.upsert` call with a
 * `[interview-engine] router state_delta rejected non-whitelisted keys
 * ...` console.warn. See `dispatchRouterDecision` for the call site.
 */
export const ROUTER_AMEND_ALLOWED_KEYS: ReadonlySet<string> = new Set<string>([
  // RequiredFieldsState keyof union — the 5 user-visible required fields.
  'user_first_name',
  'primary_projects',
  'non_work_interests',
  'agent_personality',
  'agent_name',
  // Spec § 4.2(b) — sparse object for out-of-turn user preferences.
  'auxiliary_facts',
  // Spec § 4.3 — substrate availability mentioned in passing.
  'ai_substrate_available',
  // freeform-intent-spec.md (2026-06-03) — the import SOURCE the user
  // wants to upload from. An amend on `import_upload_pending` carrying
  // this key is a source-SWITCH ("actually can I upload Claude instead");
  // `dispatchRouterDecision` value-validates it (only 'chatgpt' / 'claude'
  // are accepted) and re-renders the dynamic upload body so the
  // user sees the NEW source's instructions. Without this the freeform
  // switch was mis-routed to `advance` → import_running (the 2026-06-03
  // onboarding incident). See ROUTER_AMEND_SUBSTRATE_VALUES.
  'ai_substrate_used',
])

/**
 * Valid values for a `ai_substrate_used` amend (source switch on
 * `import_upload_pending`). Anything else is rejected before it reaches
 * `stateStore.upsert` — an adversarial / hallucinated source would
 * otherwise let the resolver silently fall back to ChatGPT and strand the
 * user on the wrong instructions. Mirrors the `AiSubstrateSource` union
 * the dynamic body resolver accepts.
 */
export const ROUTER_AMEND_SUBSTRATE_VALUES: ReadonlySet<string> = new Set<string>([
  'chatgpt',
  'claude',
])

/**
 * 2026-06-05 (amend-redisplay typing-indicator fix) — generic
 * acknowledgement emitted on an `amend` when the LLM router returns NO
 * `response` text. Carries a FRESH `prompt_id` (via `sendAgentText`'s
 * `router_text:` seed) so the web client renders it and clears the
 * optimistic typing indicator that would otherwise hang forever (the
 * stored-keyboard re-emit collapses on the unchanged `prompt_id` and the
 * client dedupes it). The router's own `response`, when present, supplies
 * the specific wording; this is only the floor for the empty-response case.
 */
export const AMEND_ACK_FALLBACK_TEXT = 'Got it — I updated that.'



/**
 * Allowed `choice_value`s on a final-handoff prompt — the four
 * `FINAL_HANDOFF_*` constants plus the `__freeform__` sentinel that a
 * freeform reply lands with (see channels/button-routing.ts:130).
 * Consumed by `handleFinalHandoffOnCompleted` as a pre-`buttonStore.
 * resolve()` membership guard so a malformed tap (e.g.
 * `totally_made_up_value`) does NOT stamp `resolved_at` and lock the
 * prompt row against a legitimate retap. Codex r2 P0 (2026-05-29).
 *
 * Each follow-up shape only legitimately accepts a subset (initial:
 * mobile-app/telegram-bind/skip/__freeform__; mobile-app/telegram-
 * bind/skip follow-ups: done). The dispatch-site `if/else if` chain
 * in `consumeFinalHandoffChoice` enforces the per-shape subset; this
 * set is the broader "could conceivably belong to ANY handoff shape"
 * filter that protects the resolve slot.
 */
const VALID_FINAL_HANDOFF_CHOICE_VALUES: ReadonlySet<string> = new Set([
  FINAL_HANDOFF_MOBILE_APP_CHOICE,
  FINAL_HANDOFF_TELEGRAM_BIND_CHOICE,
  FINAL_HANDOFF_SKIP_CHOICE,
  FINAL_HANDOFF_DONE_CHOICE,
  '__freeform__',
])


/**
 * T2 (2026-05-13) — wow_fired fallback prompt options. Emitted when
 * `WowDispatcher.dispatch(...)` throws so the user can retry the
 * dispatch (re-enter the wow-moment flow) or skip past it (advance to
 * `completed` with a partial / null wow_report). See § 2.5 + § 4.10
 * for the dispatch contract.
 */
const WOW_FALLBACK_OPTIONS: ReadonlyArray<{ label: string; body: string; value: string }> = [
  { label: 'A', body: 'Try again', value: 'wow-retry' },
  { label: 'B', body: 'Skip', value: 'wow-skip' },
]

/**
 * Sprint 2026-05-10 — the static fallback spec for the very first
 * `signup` prompt. Used by `start()` (idempotency anchor) AND by
 * `resolvePhasePromptSpec` when the LLM driver is unwired / falls back.
 *
 * The body intentionally combines persona-discovery + name capture in
 * one open-ended question (per Sam's verbatim example 2026-05-10). The
 * LLM driver replaces this with a more conversational variant when
 * wired; this static fallback is the deterministic safety net so a
 * model outage never strands the user.
 *
 * Both Telegram and Web see the same fallback body — no per-channel
 * filter. The LLM, when wired, sees `signup_via` in the bundle and
 * adjusts ("Want me to call you Anna, or something else?" for Telegram
 * users with a captured first_name; generic free-text ask for web).
 */
const SIGNUP_FALLBACK_SPEC: PhasePromptSpec = STATIC_PHASE_SPECS['signup'] ?? {
  phase: 'signup',
  body: 'Hey, what should I call you?',
  options: [],
  allow_freeform: true,
  // P2 v2 § 2.8: signup routes through instance_provisioned (auto-
  // skipped) → ai_substrate_offered (user-visible). identity_oauth is
  // also auto-skipped; the walker chains through both.
  next_phase_on_default: 'instance_provisioned',
}

/**
 * 2026-05-21 (Bug 1 — blank-chat-on-reconnect P0) — gate the
 * "always re-emit unresolved active prompt on session-open" contract
 * to channels where every session-open is a fresh DOM that has zero
 * transcript visible until the engine pushes it.
 *
 * Web (`web:<user_id>`): every WS open lands on a brand-new
 * `landing/chat.html` paint with an empty `#log` element. Re-emit is
 * REQUIRED — otherwise the user stares at a blank chat (Sam's
 * 2026-05-21 incident).
 *
 * Telegram (`tg:<chat_id>[:<thread_id>]`): bubbles persist client-side;
 * a duplicate `/start` tap shouldn't spam the user with the same
 * message. The pre-Bug-1 gate (`undelivered || topic_id_changed`) is
 * the right contract here — we only re-send if the original delivery
 * didn't reach the channel or the user reconnected on a different
 * chat_id.
 *
 * Unknown prefix (test fixtures, future channels): default to the
 * Telegram-style gate so a misconfigured channel doesn't suddenly
 * start spamming users. New channels opt into "always-re-emit"
 * explicitly by adding their prefix to this helper.
 */
function topicHasEphemeralTranscript(topic_id: string): boolean {
  return topic_id.startsWith('web:')
}

/**
 * 2026-05-21 (Bug 2, v0.1.75) — pending-inbound window for the
 * `engine.start` re-emit gate.
 *
 * PR #261 (commit 22050a8, v0.1.74) added an unconditional ephemeral-
 * channel re-emit-on-reconnect so a fresh WS doesn't stare at a blank
 * chat. That broke a follow-on case: if the user typed a reply on
 * session A and the WS reconnected within ~1 second BEFORE the engine
 * processed it, session B's `engine.start` would see the still-
 * unresolved prompt and re-paint it on top of the user's typed text —
 * silently clobbering the answer.
 *
 * Fix: `chat-bridge.handleInbound` writes `phase_state.last_inbound_received_at`
 * BEFORE calling `engine.advance(...)` (via the new `recordInboundReceived`
 * method). On the next `engine.start`, if a recent inbound landed AFTER
 * the active prompt's `delivered_at`, skip the re-emit — the in-flight
 * `engine.advance` is authoritative for the next channel emit.
 *
 * 5 s is empirically right: long enough to cover a slow `engine.advance`
 * (Pass-1 mapper, ~2-3 s typical; signup LLM resolver, ~1-2 s) but short
 * enough that a genuinely lost inbound surfaces a re-emit before the
 * user starts wondering whether they need to retype. Worst case (advance
 * crashed silently): the next `engine.start` after 5 s re-emits the
 * original prompt — same fallback as pre-PR-#261.
 */
const PENDING_INBOUND_WINDOW_MS = 5_000


export class InterviewEngine implements EngineInternals {
  // R5 / audit P2-4 — visibility relaxed from `private` to public on the
  // members the extracted import-routing free functions access via the
  // `EngineInternals` structural interface. TypeScript requires interface
  // members be public; this is a visibility-only change — runtime behavior
  // is identical (these were only ever touched within this module).
  readonly deps: InterviewEngineDeps
  readonly now: () => number
  readonly uuid: () => string
  /**
   * Resolved deployment mode for this engine instance. Unset dep → managed
   * (preserves every pre-2026-06-13 managed caller/test). Drives the
   * Open-mode phase-sequence cuts via `nextPhaseForMode` + the open
   * `max_oauth_offered` setup-token variant.
   */
  readonly deploymentMode: OnboardingDeploymentMode

  /**
   * Per-(project_slug, user_id) serialization tail for `notifyImportUpload`.
   * Single-owner Open runs in ONE process, so chaining same-user upload
   * notifications here fully eliminates the upload-vs-upload race in the
   * no-state import-start path (Codex r1 P2): two simultaneous fresh-install
   * uploads can no longer both observe `state===null` and start duplicate /
   * mutually-downgrading import jobs — the second runs only after the first has
   * committed `import_running`, so it takes the `alreadyHasImportJob` guard.
   * Mirrors the post-turn extractor's per-user `chains` map.
   */
  private readonly importUploadSerial = new Map<string, Promise<unknown>>()

  constructor(deps: InterviewEngineDeps) {
    this.deps = deps
    this.now = deps.now ?? ((): number => Date.now())
    this.uuid = deps.uuid ?? ((): string => crypto.randomUUID())
    this.deploymentMode = deps.deploymentMode ?? 'managed'
  }

  /**
   * Apply the Open-mode phase-sequence cuts to a freshly-computed
   * `next_phase`. In managed mode this is the identity function, so the
   * hosted sequence is unchanged. In open mode it rewrites the two edges
   * that route THROUGH a managed-only cut phase:
   *
   *   - `signup → instance_provisioned`  ⇒  `signup → ai_substrate_offered`
   *     (no fleet provisioning / identity OAuth locally)
   *   - `agent_name_chosen → slug_chosen`  ⇒  `agent_name_chosen →
   *     projects_proposed` (no subdomain to pick)
   *
   * `identity_oauth`, `instance_provisioned`, and `slug_chosen` are never
   * selected as a `next_phase` in open mode as a result, so they are
   * never entered. The rewritten edges are made legal by
   * `OPEN_MODE_EXTRA_TRANSITIONS` (consulted by `isLegalTransition` when
   * the engine passes `this.deploymentMode`).
   */
  private nextPhaseForMode(
    from: OnboardingPhase,
    computed: OnboardingPhase,
  ): OnboardingPhase {
    if (this.deploymentMode !== 'open') return computed
    if (from === 'signup' && computed === 'instance_provisioned') {
      return 'ai_substrate_offered'
    }
    if (from === 'agent_name_chosen' && computed === 'slug_chosen') {
      return 'projects_proposed'
    }
    return computed
  }

  /**
   * Returns the frozen identity to key SecretsStore rows by. Per
   * `auth/secrets-store.ts:11-26` (2026-05-12 rename-canonicalisation
   * fix) callers MUST pass the FROZEN `internal_handle` — NOT the
   * mutable `url_slug` (== `project_slug` post-canonicalisation) — so
   * that secret rows survive an instance rename. When this engine is
   * wired with `deps.internal_handle` (production via
   * `build-landing-stack.ts`), that frozen value is used. Tests and
   * legacy callers that don't supply it fall back to `project_slug`
   * for back-compat: pre-rename, the two values are identical, so the
   * fallback is harmless until a rename occurs (and those legacy
   * callers don't exercise the rename path).
   */
  secretsIdentity(project_slug: string): string {
    if (
      typeof this.deps.internal_handle === 'string' &&
      this.deps.internal_handle.length > 0
    ) {
      return this.deps.internal_handle
    }
    return project_slug
  }

  /**
   * 2026-05-21 (Bug 2, v0.1.75) — record an inbound user_message /
   * button_choice from the chat-bridge BEFORE `engine.advance(...)` runs.
   *
   * Writes `phase_state.last_inbound_received_at = received_at` via the
   * stateStore's shallow-merge upsert. The next `engine.start` call (on
   * a fresh WS session) reads this value in its re-emit branch — if the
   * timestamp is newer than the active prompt's `delivered_at` AND less
   * than `PENDING_INBOUND_WINDOW_MS` (5 s) old, the gate fires and the
   * re-emit is skipped. The in-flight `engine.advance` for the prior
   * inbound is authoritative for the next channel emit.
   *
   * Idempotent on multiple inbounds for the same (project_slug, user_id) —
   * `last_inbound_received_at` is monotonic, just overwritten on each
   * call. Failures (e.g. state row missing for an inbound on a never-
   * provisioned instance) are caught + logged; the bridge proceeds to
   * `engine.advance` which will surface a more actionable error.
   */
  async recordInboundReceived(input: {
    project_slug: string
    user_id: string
    received_at: number
  }): Promise<void> {
    try {
      const existing = await this.deps.stateStore.get(input.project_slug, input.user_id)
      if (existing === null) {
        // No state row yet — engine.start hasn't run for this user. The
        // inbound is anomalous (start() should always precede inbounds);
        // log + continue. engine.advance will surface the real error.
        console.warn(
          `[engine.recordInboundReceived] event=no-state project=${input.project_slug} user_id=${input.user_id}`,
        )
        return
      }
      await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: existing.phase,
        phase_state_patch: { last_inbound_received_at: input.received_at },
        advanced_at: existing.last_advanced_at,
      })
    } catch (err) {
      // Best-effort marker write. A failure here just means the next
      // reconnect re-emits, which is the pre-Bug-2 behaviour.
      console.warn(
        `[engine.recordInboundReceived] event=write-failed project=${input.project_slug} user_id=${input.user_id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  /**
   * Emit the hardcoded first prompt + advance state to phase=`signup`.
   * Idempotent on (project_slug, topic_id) — the prompt's idempotency_key
   * is derived from those + the canonical prompt seed so a re-start
   * collapses onto the existing prompt without double-rendering.
   */
  async start(input: StartInput): Promise<StartResult> {
    this.clearResolvedSpecCache()
    // 2026-05-13 — no-restart-rename lazy rekey. Before the first state
    // read, check whether the in-progress onboarding row is keyed under
    // an OLD slug for this instance. This protects the "deploy / reboot
    // mid-onboarding after a slug rename" path: the gateway boots with
    // `expected_project_slug = NEW` (read from `.url_slug`), JWTs collapse
    // to NEW, and the engine receives `start(NEW)` — but the row was
    // written under OLD. Without this rekey the user resets to S1.
    //
    // Scoped by `internal_handle` (frozen per-gateway identifier), so a
    // misrouted or cross-project call cannot pull state from a different
    // instance's history. When `slugHistory` or `internal_handle` is
    // unwired (older tests), the fallback is inert and behaviour matches
    // pre-2026-05-13.
    //
    // Per Codex r2: lazy. We only fire when `stateStore.get(input.project_slug, input.user_id)`
    // returns null — the live gateway (no restart) collapses JWTs to OLD,
    // hits the row directly under OLD, and never enters this branch.
    if (
      this.deps.slugHistory !== undefined &&
      typeof this.deps.internal_handle === 'string' &&
      this.deps.internal_handle.length > 0
    ) {
      const direct = await this.deps.stateStore.get(input.project_slug, input.user_id)
      if (direct === null) {
        const old_slugs =
          await this.deps.slugHistory.listOldSlugsForInternalHandle(this.deps.internal_handle)
        for (const old_slug of old_slugs) {
          if (old_slug === input.project_slug) continue
          const old_row = await this.deps.stateStore.get(old_slug, input.user_id)
          if (old_row !== null) {
            await this.deps.stateStore.rekey(old_slug, input.project_slug, input.user_id)
            break
          }
        }
      }
    }
    // Codex r3 P1 — if onboarding has already advanced past `signup` for
    // this instance (e.g. duplicate signup trigger or process restart),
    // start() MUST NOT roll the phase back. Surface the existing state
    // and skip the emit + send entirely.
    //
    // Sprint 21 (Codex P1 #3) — exception: when the user just reconnected
    // after a slug rename, the post-rename advance left `active_prompt_id`
    // null AND the current phase has prompt content the user has not yet
    // seen. The renamed gateway's first start() call must re-emit so the
    // user lands at the new URL with a visible prompt instead of staring
    // at an empty chat. We reuse `emitCurrentPhasePrompt` for the
    // existing prompt-emission contract (idempotent, race-safe).
    const existing = await this.deps.stateStore.get(input.project_slug, input.user_id)
    // T2 r2 (2026-05-13) — Argus IMPORTANT: wow_fired crash-resume.
    // If the process died between the `phase=wow_fired` upsert and
    // WowDispatcher.dispatch(...) resolving, the row sits at
    // `phase=wow_fired` with NO `wow_report` and NO `wow_dispatch_error`.
    // Without this branch the user is stranded forever (the wow_fired
    // entry body has no choices — it's a freeform "drafting..." body —
    // so no inbound tap can re-route them, and engine.start's existing
    // re-emit branch just re-sends the body without re-firing dispatch).
    //
    // Watermark: presence of `wow_report` proves dispatch landed (set in
    // the same upsert that advances to `completed`); presence of
    // `wow_dispatch_error` proves dispatch failed AND the retry/skip
    // fallback prompt was emitted (the user owns that surface now —
    // don't auto-retry under them). Re-fire only when both are absent.
    // T4 (2026-05-13) — import_running crash-resume. Mirrors the
    // wow_fired branch below: if the engine crashed between the
    // `phase=import_running` upsert and the runner status flipping to
    // a terminal value (completed / failed / cancelled), the row sits
    // at `phase=import_running` with no
    // `import_result` and no `import_failure_reason`. The static
    // status body has no choices (allow_freeform=true, zero options)
    // so an inbound tap cannot re-route the user. The fix: re-enter
    // the poll path so the engine re-checks runner status, lands on a
    // terminal state if one's available, and emits the appropriate
    // prompt body. Per docs/plans/P2-onboarding.md § 4.7.
    if (
      existing !== null &&
      existing.phase === 'import_running' &&
      this.deps.importJobRunner !== undefined
    ) {
      const ps = existing.phase_state
      const has_result =
        ps['import_result'] !== undefined && ps['import_result'] !== null
      const has_failure =
        typeof ps['import_failure_reason'] === 'string' &&
        (ps['import_failure_reason'] as string).length > 0
      const has_job_id =
        typeof ps['import_job_id'] === 'string' &&
        (ps['import_job_id'] as string).length > 0
      const has_active_prompt =
        typeof ps['active_prompt_id'] === 'string' &&
        (ps['active_prompt_id'] as string).length > 0
      const observed_at = this.now()
      const advanceInput: AdvanceInput = {
        project_slug: input.project_slug,
        topic_id: input.topic_id,
        user_id: input.user_id,
        channel_kind: input.signup_via === 'telegram' ? 'telegram' : 'app-socket',
        observed_at,
      }
      if (has_job_id && !has_result && !has_failure) {
        // Status-poll path: runner status is still live, re-poll +
        // emit whatever sub_step the result maps to.
        const result = await this.pollImportRunningAndAdvance(
          advanceInput,
          existing,
          observed_at,
        )
        const next_state = result.state ?? existing
        return {
          prompt_id: result.prompt_id ?? '',
          was_new: false,
          state: next_state,
        }
      }
      // Codex r4 P2 (post-T4) — terminal-state crash-resume. The
      // engine landed `import_result` or `import_failure_reason` on
      // phase_state but died before persisting `active_prompt_id`.
      // The generic `emitCurrentPhasePrompt` fallback would emit the
      // static "Reading through your export now..." body with NO
      // options — stranding the user. Rebuild the right dynamic prompt
      // based on the persisted `import_running_sub_step`.
      const sub_step = readString(existing.phase_state, 'import_running_sub_step')
      if (!has_active_prompt && (has_result || has_failure)) {
        const source = readImportSource(existing.phase_state, 'import_source')
        if (sub_step === 'failed' || has_failure) {
          const reason =
            typeof ps['import_failure_reason'] === 'string'
              ? (ps['import_failure_reason'] as string)
              : 'unknown'
          const result = await this.emitImportRunningPromptSpec(
            advanceInput,
            existing,
            observed_at,
            { sub_step: 'failed', source, failure_reason: reason },
          )
          return {
            prompt_id: result.prompt_id ?? '',
            was_new: false,
            state: result.state ?? existing,
          }
        }
        // has_result but neither sub_step matches → completed shape,
        // safe to advance to archetype_picked.
        if (has_result) {
          const advanced = await this.advanceFromImportRunningOnComplete(
            advanceInput,
            existing,
            observed_at,
            ps['import_result'] as ImportResult,
            ps['import_partial'] === true,
          )
          return {
            prompt_id: advanced.prompt_id ?? '',
            was_new: false,
            state: advanced.state ?? existing,
          }
        }
      }
    }
    if (
      existing !== null &&
      existing.phase === 'wow_fired' &&
      this.deps.wowDispatcher !== undefined
    ) {
      const ps = existing.phase_state
      const wow_report = ps['wow_report']
      const has_report = wow_report !== undefined && wow_report !== null
      const has_error =
        typeof ps['wow_dispatch_error'] === 'string' &&
        (ps['wow_dispatch_error'] as string).length > 0
      if (!has_report && !has_error) {
        const observed_at = this.now()
        const advanceInput: AdvanceInput = {
          project_slug: input.project_slug,
          topic_id: input.topic_id,
          user_id: input.user_id,
          channel_kind: input.signup_via === 'telegram' ? 'telegram' : 'app-socket',
          observed_at,
        }
        const result = await this.dispatchWowAndAdvance(
          advanceInput,
          existing,
          observed_at,
        )
        const next_state = result.state ?? existing
        return {
          prompt_id: result.prompt_id ?? '',
          was_new: false,
          state: next_state,
        }
      }
    }
    // Gate-collapse (#93) — projects_proposed auto-confirm on reconnect.
    // The slug-rename redirect (v0.1.133) rekeys the row to the new slug,
    // parks it on `projects_proposed`, and suppresses the live-socket emit
    // because the WS is being torn down by the gateway restart. The
    // renamed gateway's FIRST start() lands here. Rather than re-emit the
    // redundant "Good to go" gate for a list the user already reviewed at
    // import_analysis_presented, auto-confirm the reviewed list and
    // advance to persona_synthesizing — same helper the live-socket
    // skip-slug / no-restart paths use in advanceFromSlugChosen. Mirrors
    // the import_running / wow_fired phase-specific auto-advance guards
    // above. After this fires the phase is persona_reviewed, so a later
    // reconnect falls through to the generic re-emit path below.
    //
    // Argus r1 IMPORTANT — gate the auto-confirm on the PARKED shape only.
    // The intended post-rename parked state has `active_prompt_id == null`
    // (the live-socket emit was suppressed by the gateway restart) and is
    // NOT in the `share_freeform` edit sub_step. A session that DOES have an
    // active prompt, or one parked mid-edit in `share_freeform` (the user
    // tapped "Share what I'm working on" and is typing a project edit), must
    // NOT be silently auto-confirmed — that would drop the pending edit.
    // Such sessions fall through to the generic re-emit path below, which
    // puts the in-flight prompt back on the screen. consumeProjectsProposed-
    // Choice then handles the freeform edit when the user submits.
    if (existing !== null && existing.phase === 'projects_proposed') {
      const active_prompt_id = existing.phase_state.active_prompt_id
      const has_active_prompt =
        typeof active_prompt_id === 'string' && active_prompt_id.length > 0
      const active_sub_step = deriveActiveSubStep(existing.phase, existing.phase_state)
      if (!has_active_prompt && active_sub_step !== 'share_freeform') {
        const observed_at = this.now()
        const advanceInput: AdvanceInput = {
          project_slug: input.project_slug,
          topic_id: input.topic_id,
          user_id: input.user_id,
          channel_kind: input.signup_via === 'telegram' ? 'telegram' : 'app-socket',
          observed_at,
        }
        const result = await this.autoConfirmProjectsProposedAndAdvance(
          advanceInput,
          existing,
          observed_at,
        )
        return {
          prompt_id: result.prompt_id ?? '',
          was_new: false,
          state: result.state ?? existing,
        }
      }
    }
    if (existing !== null && existing.phase !== 'signup') {
      const existing_prompt_id = existing.phase_state.active_prompt_id
      const has_active_prompt = typeof existing_prompt_id === 'string' && existing_prompt_id.length > 0
      const has_phase_prompt = !TERMINAL_PHASES.has(existing.phase) && STATIC_PHASE_SPECS[existing.phase] !== undefined
      if (!has_active_prompt && has_phase_prompt) {
        const reemit = await this.emitCurrentPhasePrompt({
          project_slug: input.project_slug,
          user_id: input.user_id,
          topic_id: input.topic_id,
        })
        const reemit_prompt_id = reemit.prompt_id ?? ''
        return {
          prompt_id: reemit_prompt_id,
          was_new: false,
          state: reemit.state ?? existing,
        }
      }
      // 2026-05-21 (Bug 1 — blank-chat-on-reconnect P0):
      // engine.start is the entry-point fired by chat-bridge.startSession
      // on EVERY new WS open. The web channel is stateless: a fresh WS
      // connection has zero transcript history on screen until the engine
      // pushes something. So whenever start() finds an UNRESOLVED active
      // prompt, the contract is "put it back on the screen" — independent
      // of whether `delivered_at` is set or `topic_id` changed.
      //
      // Pre-fix the gate was `if (undelivered || topic_id_changed)` —
      // which strands the common reconnect case (`delivered_at != null`
      // because a prior session received the bubble; `topic_id` unchanged
      // because `webTopicId(user_id)` is stable per-user) on a blank chat.
      // Sam hit this 2026-05-21 at `import_upload_pending`: closed the
      // tab after seeing the upload affordance, came back, saw an empty
      // composer with no agent message. Spec contract:
      // docs/plans/P2-onboarding.md § engine.start contract.
      //
      // We still preserve the original audit invariants:
      //   - `delivered_at` is set EXACTLY once, on first successful
      //     delivery. Subsequent re-emits do NOT touch it (the row's
      //     "first reached a live channel" timestamp stays authoritative).
      //   - The transcript agent-turn is appended EXACTLY once, on first
      //     successful delivery. Re-emits to a still-fresh client must
      //     NOT duplicate the audit line.
      //   - `topic_id_changed` reconciliation (rebind button row +
      //     state.topic_id) still fires the first time the live topic
      //     diverges from the stored one, so subsequent autonomous
      //     emits target the correct socket.
      //
      // CRITICAL — route the re-emit to `input.topic_id` (the CURRENT
      // connection's topic_id, registered by chat-bridge's startSession
      // before engine.start was invoked), NOT `meta.topic_id` (whatever
      // was stored at original emit).
      //
      // Historical context preserved:
      //   - Codex r4 BLOCKING — no-restart slug rename silent advance
      //     introduced the original undelivered-gate; that case is a
      //     subset of "always re-emit when unresolved".
      //   - S16 (2026-05-17) — slug-rename WS reconnect topic_id rebind;
      //     the topic_id reconciliation block below is unchanged from
      //     S16 except that we no longer gate the OUTER re-send on it.
      //   - T10 (2026-05-14) — `markDelivered` gated on `was_new` so a
      //     drop on send doesn't fake delivery. Still required.
      //
      // Risks considered:
      //   - Transcript duplication: only the FIRST delivery
      //     (`undelivered === true && was_new === true`) appends. Repeat
      //     re-emits short-circuit on `undelivered === false`.
      //   - Telegram-channel spam: today's prod has no
      //     `telegramSender` wired (per `signup/post-signin-router.ts`
      //     diagnosis 2026-05-21), so `topic_id.startsWith('tg:')` paths
      //     return `was_new=false` from the routed sender (the
      //     `event=drop reason=unknown-channel-or-no-sender` log line).
      //     The web path is the only one that actually delivers. When
      //     `telegramSender` lands, the adapter MUST be idempotent on
      //     duplicate `prompt_id` sends (Telegram's `sendMessage` is
      //     not naturally idempotent; the adapter will need to remember
      //     "I already sent this prompt_id to this chat" — captured in
      //     the TG signup investigation doc as an explicit constraint).
      if (has_active_prompt && typeof existing_prompt_id === 'string') {
        const meta = await this.deps.buttonStore.peek(existing_prompt_id)
        if (meta !== null && meta.resolved_at === null) {
          const topic_id_changed = meta.topic_id !== input.topic_id
          const undelivered = meta.delivered_at === null
          // 2026-05-21 (Bug 2, v0.1.75) — pending-inbound gate.
          // chat-bridge.handleInbound writes `last_inbound_received_at`
          // BEFORE calling engine.advance. If an inbound landed AFTER
          // the active prompt's delivered_at AND less than
          // PENDING_INBOUND_WINDOW_MS (5s) ago, an engine.advance call
          // is in flight for the user's typed reply. Re-emitting here
          // would clobber the typed text with a stale duplicate prompt.
          // Skip the re-emit; advance will emit the next prompt onto
          // whichever WS is live when it returns.
          //
          // Outside the window (advance never wrote anything, e.g. it
          // crashed silently), the gate releases and the next start()
          // call re-emits — graceful fallback, never strands the user.
          //
          // Codex r1 P1 (2026-05-21) — only apply the gate when
          // `meta.delivered_at` is non-null. An UNDELIVERED active
          // prompt (delivered_at === null because the prior send
          // returned was_new=false or the socket closed before
          // markDelivered) MUST be delivered on this reconnect — gating
          // it with `last_inbound > 0` would strand the user with no
          // visible prompt AND no future trigger to retry. The
          // "user typed a reply" race only applies when the user could
          // have answered the prompt, which requires it to have been
          // delivered first.
          const last_inbound_at = readNumber(
            existing.phase_state,
            'last_inbound_received_at',
          )
          const inbound_after_delivery =
            meta.delivered_at !== null &&
            last_inbound_at !== null &&
            last_inbound_at > meta.delivered_at
          const recent =
            last_inbound_at !== null &&
            this.now() - last_inbound_at < PENDING_INBOUND_WINDOW_MS
          const pending_inbound = inbound_after_delivery && recent
          if (pending_inbound) {
            console.info(
              `[engine.start] event=skip-reemit-pending-inbound project=${input.project_slug} ` +
                `phase=${existing.phase} prompt=${existing_prompt_id} ` +
                `delivered_at=${meta.delivered_at ?? 'null'} last_inbound_at=${last_inbound_at ?? 'null'} ` +
                `age_ms=${last_inbound_at !== null ? this.now() - last_inbound_at : 'null'} — ` +
                `engine.advance for prior inbound has the floor`,
            )
            return {
              prompt_id: existing_prompt_id,
              was_new: false,
              state: existing,
            }
          }
          // 2026-05-21 (Bug 1) — re-emit gate combines:
          //   - "always-re-emit on session-open" for ephemeral-transcript
          //     channels (web), so a fresh WS isn't left staring at a
          //     blank chat
          //   - the pre-Bug-1 gate (`undelivered || topic_id_changed`)
          //     for persistent-transcript channels (Telegram), so a
          //     duplicate /start doesn't spam the user
          const ephemeral = topicHasEphemeralTranscript(input.topic_id)
          const should_reemit = ephemeral || undelivered || topic_id_changed
          const stored_prompt = should_reemit ? await this.deps.buttonStore.get(existing_prompt_id) : null
          if (stored_prompt !== null) {
            if (topic_id_changed) {
              console.info(
                `[engine.start] event=reemit-topic-rebind project=${input.project_slug} phase=${existing.phase} prompt=${existing_prompt_id} stored_topic=${meta.topic_id} live_topic=${input.topic_id} — routing re-emit to live topic`,
              )
            } else if (undelivered) {
              console.info(
                `[engine.start] event=reemit-undelivered project=${input.project_slug} phase=${existing.phase} prompt=${existing_prompt_id} — first delivery on reconnect`,
              )
            } else {
              console.info(
                `[engine.start] event=reemit-reconnect project=${input.project_slug} phase=${existing.phase} prompt=${existing_prompt_id} — repainting prior delivery on fresh WS`,
              )
            }
            let reemitResult
            try {
              reemitResult = await this.deps.sendButtonPrompt({
                project_slug: input.project_slug,
                topic_id: input.topic_id,
                prompt: stored_prompt,
              })
            } catch (err) {
              throw new InterviewError(
                existing.phase,
                'send_failed',
                true,
                `failed to re-emit unresolved prompt on reconnect for project=${input.project_slug} phase=${existing.phase}`,
                err,
              )
            }
            let final_state: OnboardingState = existing
            if (reemitResult.was_new) {
              // Audit invariants: markDelivered + transcript.append fire
              // EXACTLY once, on the first successful delivery. Repeat
              // re-emits skip both so the audit trail stays clean.
              if (undelivered) {
                await this.deps.buttonStore.markDelivered(existing_prompt_id, this.now())
                this.deps.transcript.append({
                  role: 'agent',
                  body: stored_prompt.body,
                  phase: existing.phase,
                  button_prompt_id: existing_prompt_id,
                })
              }
              if (topic_id_changed) {
                // S16 — rebind the button row + the state's topic_id
                // so subsequent autonomous emits (pollImportRunningTick
                // etc.) target the live socket instead of the dead one.
                // See lines 1474-1496 of the pre-2026-05-21
                // implementation for the original motivation; the call
                // sites below are unchanged.
                await this.deps.buttonStore.rebindTopicId(existing_prompt_id, input.topic_id)
                final_state = await this.deps.stateStore.upsert({
                  project_slug: input.project_slug,
                  user_id: input.user_id,
                  phase: existing.phase,
                  phase_state_patch: { topic_id: input.topic_id },
                  advanced_at: existing.last_advanced_at,
                })
              }
            } else {
              console.warn(
                `[engine.start] event=reemit-send-failed project=${input.project_slug} stored_topic=${meta.topic_id} live_topic=${input.topic_id} prompt=${existing_prompt_id} phase=${existing.phase} — leaving delivered_at=${meta.delivered_at ?? 'null'} so future reconnect catches it`,
              )
            }
            return {
              prompt_id: existing_prompt_id,
              was_new: false,
              state: final_state,
            }
          }
        }
      }
      return {
        prompt_id: typeof existing_prompt_id === 'string' ? existing_prompt_id : '',
        was_new: false,
        state: existing,
      }
    }

    // Codex r5 P2 — if state already has a still-active prompt, reuse
    // that prompt_id rather than emit a fresh one. Two callers (e.g.
    // duplicate signup trigger) must not produce two competing keyboards.
    //
    // Codex r9 P1 — handle the crash-recovery case: if `store.resolve`
    // landed but the engine died before advancing phase, we'd otherwise
    // reuse a resolved prompt forever. Inspect the row's resolution
    // state and recover:
    //   - resolved by user answer → advance phase + write transcript
    //   - resolved by sentinel (__timeout__/__cancel__) → clear
    //     active_prompt_id + fall through to fresh emit
    //   - unresolved → reuse + retry send if undelivered
    // Cross-channel resume guard (Codex r1 P1, 2026-05-09): if the stored
    // signup_via differs from the incoming token's signup_via, reusing
    // the existing UNRESOLVED prompt would re-render the wrong-channel
    // spec — e.g. an owner who started on Telegram (Option A = "Use my
    // Telegram display name") and later resumed via /chat?start=<token>
    // (signup_via='web') would still see Option A. Clear
    // `active_prompt_id` so the reuse branches below skip and the new
    // spec is re-derived through the LLM driver (which sees signup_via
    // in the bundle). See § 8.1 of
    // `docs/research/onboarding-llm-prompts-architecture-2026-05-09.md`.
    //
    // Codex r2 P2 (2026-05-09): preserve already-resolved answers. If
    // the user answered the prior-channel prompt and the process died
    // before advancing, the reuse branch's `recoverResolvedAnswer` path
    // is the only place that lifts that answer onto the transcript +
    // advances the phase. Clearing `active_prompt_id` when the prompt
    // is resolved would silently drop a submitted answer on a
    // crash-recovery + channel-switch scenario. Peek first; only clear
    // when the prompt is genuinely unresolved.
    let existing_after_channel_guard = existing
    if (existing_after_channel_guard !== null && existing_after_channel_guard.phase === 'signup') {
      const stored_signup_via = readString(existing_after_channel_guard.phase_state, 'signup_via')
      const apid = existing_after_channel_guard.phase_state.active_prompt_id
      if (
        stored_signup_via !== null &&
        stored_signup_via !== input.signup_via &&
        typeof apid === 'string' &&
        apid.length > 0
      ) {
        const meta = await this.deps.buttonStore.peek(apid)
        // peek === null: row already deleted (expired-and-replaced); the
        // reuse branch's existing fall-through covers it. resolved_at
        // !== null: the user answered or the prompt timed out; the
        // reuse branch's recoverResolvedAnswer / sentinel paths own it.
        // Either way, do NOT touch state here.
        if (meta !== null && meta.resolved_at === null) {
          existing_after_channel_guard = await this.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: 'signup',
            phase_state_patch: { active_prompt_id: null },
            advanced_at: this.now(),
          })
        }
      }
    }
    if (existing_after_channel_guard !== null) {
      const apid = existing_after_channel_guard.phase_state.active_prompt_id
      if (typeof apid === 'string' && apid.length > 0) {
        const meta = await this.deps.buttonStore.peek(apid)
        if (meta !== null) {
          if (meta.resolved_at === null) {
            const stored_prompt = await this.deps.buttonStore.get(apid)
            if (stored_prompt !== null) {
              return await this.reuseActivePrompt(input, existing_after_channel_guard, apid, stored_prompt, meta.topic_id)
            }
          } else if (
            meta.resolution_value !== null &&
            !NON_ADVANCING_CHOICE_VALUES.has(meta.resolution_value)
          ) {
            // The user answered before the engine could advance. Recover
            // by writing the user transcript line + advancing phase.
            // Codex r10 P1 — preserve resolution_freeform_text so a
            // typed-text answer is not silently dropped on restart.
            return await this.recoverResolvedAnswer(
              input,
              existing_after_channel_guard,
              apid,
              meta.resolution_value,
              meta.resolution_freeform_text,
            )
          } else {
            // Sentinel resolution (timeout/cancel) — clear active prompt
            // so the next branch emits a fresh keyboard.
            await this.deps.stateStore.upsert({
              project_slug: input.project_slug,
              user_id: input.user_id,
              phase: 'signup',
              phase_state_patch: { active_prompt_id: null },
              advanced_at: this.now(),
            })
          }
        }
        // peek === null: row was deleted (e.g. expired-and-replaced via
        // emit's stale-replace path). Fall through to emit a fresh prompt.
      }
    }

    // 2026-05-10 sprint — the LLM driver is the single entry point for
    // prompt body generation. `resolveLlmSpec` calls the new
    // `generatePromptForPhase` path when wired AND the phase is in the
    // enabled set; on null (driver unwired, phase not enabled, model
    // error) we fall back to the static `SIGNUP_FALLBACK_SPEC` so a
    // model outage never strands signup. State is read once here so the
    // bundle reflects any pre-existing phase_state (e.g. tg_first_name
    // set by the telegram-start handler before engine.start fires).
    const pre_state = await this.deps.stateStore.get(input.project_slug, input.user_id)
    const startTgFirstName =
      typeof input.tg_first_name === 'string' && input.tg_first_name.length > 0
        ? input.tg_first_name
        : null
    const resolved_spec = await this.resolveLlmSpec({
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      user_id: input.user_id,
      phase: 'signup',
      signup_via: input.signup_via,
      state: pre_state,
      tg_first_name_override: startTgFirstName,
    })
    const effective_body = resolved_spec?.body ?? SIGNUP_FALLBACK_SPEC.body
    const effective_options =
      resolved_spec !== null
        ? resolved_spec.options.map((o) => ({
            label: o.label,
            body: o.body,
            value: o.value,
          }))
        : SIGNUP_FALLBACK_SPEC.options.map((o) => ({ ...o }))
    const effective_allow_freeform = resolved_spec?.allow_freeform ?? true
    // Idempotency seed — anchor on the STATIC fallback body regardless
    // of what the LLM driver returned, so two concurrent `start()` calls
    // collapse onto the same idempotency_key + ButtonStore row even when
    // the driver returns slightly different body copy on each call.
    const seed = canonicalPromptSeed({
      body: SIGNUP_FALLBACK_SPEC.body,
      options: SIGNUP_FALLBACK_SPEC.options.map((o) => ({ value: o.value })),
    })
    const idempotency_key = deriveIdempotencyKey({
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      seed,
    })

    const prompt = buildButtonPrompt({
      body: effective_body,
      options: effective_options,
      allow_freeform: effective_allow_freeform,
      idempotency_key,
      uuid: this.uuid,
    })

    let emit: Awaited<ReturnType<ButtonStore['emit']>>
    try {
      emit = await this.deps.buttonStore.emit(prompt, { topic_id: input.topic_id })
    } catch (err) {
      throw new InterviewError(
        'signup',
        'prompt_emit_failed',
        true,
        `failed to persist S1 prompt for project=${input.project_slug}`,
        err,
      )
    }

    // Codex r8 P1 — write state BEFORE sending so a fast tap that
    // arrives between sendMessage's success and the post-send state
    // upsert can find onboarding state and advance. Without this, the
    // engine.acceptChoice path threw `owner_state_missing`, the
    // ButtonStore had already resolved the row, and the retry stayed
    // deduped — onboarding stuck.
    const start_phase_state_patch: Record<string, unknown> = {
      active_prompt_id: emit.prompt_id,
      signup_via: input.signup_via,
      user_id: input.user_id,
      topic_id: input.topic_id,
    }
    if (
      typeof input.tg_first_name === 'string' &&
      input.tg_first_name.length > 0
    ) {
      // LLM-driven prompts sprint — persist the Telegram first_name so
      // the resolver bundle can surface it as a suggestion in the
      // opening prompt for telegram signups.
      start_phase_state_patch['tg_first_name'] = input.tg_first_name
    }
    // #306 (2026-06-19) — stamp the auto-detected browser timezone onto
    // `phase_state.timezone` on the first start so persona-gen renders it
    // into USER.md and the interview never has to ask. Server-side
    // re-validation (`sanitizeBrowserTimezone`) is the trust boundary; an
    // invalid / oversize / wrong-shape value is dropped (key stays absent →
    // the agent falls back to its ask-nothing behaviour). The shallow-merge
    // upsert means a later reconnect that omits `?tz=` never clobbers a
    // value stamped on the first connect.
    const stamped_timezone = sanitizeBrowserTimezone(input.timezone)
    if (stamped_timezone !== null) {
      start_phase_state_patch['timezone'] = stamped_timezone
    }
    let state = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'signup',
      phase_state_patch: start_phase_state_patch,
      advanced_at: this.now(),
    })

    // We render upstream when this is a fresh emit OR when an existing
    // row has not yet been delivered (e.g. previous start hit a Telegram
    // 5xx after persistence). A row that landed in the DB but never
    // reached the channel is NOT yet delivered, and skipping the send
    // on retry would strand the instance with an active prompt that the
    // user never saw.
    const should_send = emit.was_new || !emit.was_delivered
    let delivered_now = false
    let was_new = emit.was_new
    if (should_send) {
      let sendResult
      try {
        sendResult = await this.deps.sendButtonPrompt({
          project_slug: input.project_slug,
          topic_id: input.topic_id,
          prompt: emit.prompt,
        })
      } catch (err) {
        throw new InterviewError(
          'signup',
          'send_failed',
          true,
          `failed to send S1 prompt for project=${input.project_slug}`,
          err,
        )
      }
      // T10 (2026-05-14) — silent-drop fix. The routed `SendButtonPromptFn`
      // returns `was_new=false` when no live sender owns the topic_id
      // (web registry missing the entry, telegram sender unwired, or an
      // unknown channel prefix). Pre-T10 the engine treated that as
      // success: it marked `delivered_at` on the button_prompts row and
      // returned to the caller, leaving the user with NO bubble + a
      // delivered=non-null row that the reconnect re-emit branch would
      // skip on the next start(). On synthetic-auth fresh instances this
      // surfaced as "WS upgrade succeeds, banner shows connected, #log
      // stays empty" with zero engine-side error and zero retry path —
      // the exact failure mode the T10 brief documents.
      //
      // Fix: when sendResult.was_new is false on a fresh emit, treat the
      // send as not-yet-delivered. Skip `markDelivered`; the row's
      // `delivered_at` stays null. On reconnect, engine.start's existing
      // "active_prompt_id set but unresolved" branch picks the row up
      // and re-sends. This restores forward progress without burning the
      // prompt_id or duplicating the transcript line.
      //
      // We still log loud so prod regressions surface in journalctl: the
      // routed-sender helper above already emits `event=drop reason=...`
      // for the unknown-channel path; this catches the web-registry-
      // had-no-sender path too.
      if (!sendResult.was_new) {
        was_new = false
        console.warn(
          `[engine.start] event=send-undelivered project=${input.project_slug} topic=${input.topic_id} prompt=${emit.prompt_id} — leaving delivered_at=null so reconnect re-emit catches it`,
        )
      } else {
        await this.deps.buttonStore.markDelivered(emit.prompt_id, this.now())
        delivered_now = true
      }
    }

    // Codex r2 P2.2 — transcript line is gated on "this run delivered
    // the prompt for the first time," NOT on emit.was_new. If the prior
    // start persisted the row but failed to send, the retry IS the first
    // successful delivery and MUST land in the transcript; otherwise the
    // onboarding history is silently missing the opening agent message.
    //
    // T10 (Codex r1 P2) — also gate the fresh-emit branch on
    // `delivered_now`. Pre-T10 fix this read `emit.was_new || ...`, which
    // appended the transcript line even when sendButtonPrompt returned
    // `was_new=false` (no live sender). The transcript would record an
    // agent turn the user never saw; on reconnect the re-emit path
    // would append a SECOND identical agent turn for the same prompt_id,
    // leaving a duplicated / misleading onboarding history. Combined
    // shape: append iff this run actually pushed the body to a live
    // channel — covers both fresh-emit-just-delivered and
    // retry-after-prior-failure-finally-delivered.
    if (delivered_now) {
      this.deps.transcript.append({
        role: 'agent',
        body: effective_body,
        phase: 'signup',
        button_prompt_id: emit.prompt_id,
      })
    }

    return { prompt_id: emit.prompt_id, was_new, state }
  }

  /**
   * Codex r5 P2 + r8 P1 + r9 P2 — duplicate-start path: an existing
   * `active_prompt_id` points at a still-active button_prompts row, so
   * we reuse it instead of emitting a competing keyboard. If the prior
   * attempt failed before delivery (delivered_at is null), we retry
   * the send.
   *
   * Codex r9 P2 — the retry MUST send to the row's stored topic_id,
   * NOT the caller's `input.topic_id`. A duplicate start with a
   * different topic_id (process restart with a fresh chat surface)
   * would otherwise leak the prompt into the wrong channel while the
   * row still belongs to the original topic.
   */
  private async reuseActivePrompt(
    input: StartInput,
    existing: OnboardingState,
    prompt_id: string,
    stored_prompt: ButtonPrompt,
    persisted_topic_id: string,
  ): Promise<StartResult> {
    // 2026-05-21 (Bug 1 — blank-chat-on-reconnect P0): mirror the
    // non-signup branch's channel-gated "re-emit on session-open"
    // contract. The duplicate-start path is reached when state has an
    // `active_prompt_id` AND the button row is unresolved (the call
    // site at engine.start checks `meta.resolved_at === null` before
    // delegating here).
    //
    // For ephemeral-transcript channels (web), every WS open is a
    // fresh DOM with zero history — re-emit regardless of delivery
    // state so the user isn't left staring at a blank chat.
    //
    // For persistent-transcript channels (Telegram), bubbles persist
    // client-side — only re-emit when the original delivery didn't
    // land (delivered_at === null) to preserve the "duplicate /start
    // is idempotent" contract from Codex r5 P2.
    //
    // Preserves the original audit invariants: `markDelivered` +
    // `transcript.append` fire EXACTLY once on first successful
    // delivery; subsequent re-emits short-circuit on
    // `was_delivered_before === true`.
    //
    // The persisted topic_id from `meta.topic_id` is honored here
    // (rather than `input.topic_id`) to preserve the Codex r9 P2
    // contract — a process-restart that hands a fresh chat surface a
    // different topic_id MUST NOT leak the prompt to the wrong
    // channel. The non-signup branch above already rebinds the row
    // when the topic_id diverges; the signup branch deliberately does
    // not, because signup is the very first phase and topic_id_change
    // before the first user choice is a recoverable state.
    const delivered_at = await this.deps.buttonStore.deliveredAt(prompt_id)
    const was_delivered_before = delivered_at !== null
    // 2026-05-21 (Bug 2, v0.1.75) — pending-inbound gate. Mirrors the
    // non-signup branch's gate above. If a user_message landed AFTER
    // `delivered_at` AND less than PENDING_INBOUND_WINDOW_MS ago, an
    // engine.advance call is in flight for the typed reply — skip the
    // re-emit to avoid clobbering the user's text.
    //
    // Codex r1 P1 (2026-05-21) — only fire when `delivered_at !== null`.
    // An undelivered active prompt MUST be delivered on this reconnect;
    // gating it on a stale inbound marker would strand the user with
    // no visible prompt + no retry trigger.
    const last_inbound_at = readNumber(
      existing.phase_state,
      'last_inbound_received_at',
    )
    const inbound_after_delivery =
      delivered_at !== null &&
      last_inbound_at !== null &&
      last_inbound_at > delivered_at
    const recent =
      last_inbound_at !== null &&
      this.now() - last_inbound_at < PENDING_INBOUND_WINDOW_MS
    const pending_inbound = inbound_after_delivery && recent
    if (pending_inbound) {
      console.info(
        `[engine.start.reuse] event=skip-reemit-pending-inbound project=${input.project_slug} ` +
          `topic=${persisted_topic_id} prompt=${prompt_id} ` +
          `delivered_at=${delivered_at ?? 'null'} last_inbound_at=${last_inbound_at ?? 'null'} — ` +
          `engine.advance for prior inbound has the floor`,
      )
      // Touch state.last_advanced_at so the duplicate-start signal is
      // observable, but skip the channel emit.
      const state = await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'signup',
        phase_state_patch: { active_prompt_id: prompt_id },
        advanced_at: this.now(),
      })
      return { prompt_id, was_new: false, state }
    }
    // Re-emit channel gate. Note: we evaluate against `input.topic_id`
    // (the live request's channel) NOT `persisted_topic_id`. The web
    // reconnect case sets both to `web:<user_id>`; the Telegram
    // duplicate-start case sets `input.topic_id` to the new chat_id
    // and `persisted_topic_id` to the original — either way the
    // ephemeral check fires on the live request's channel, which is
    // the user-facing surface that needs the prompt.
    const ephemeral = topicHasEphemeralTranscript(input.topic_id)
    const should_reemit = ephemeral || !was_delivered_before
    if (should_reemit) {
      let resendResult
      try {
        resendResult = await this.deps.sendButtonPrompt({
          project_slug: input.project_slug,
          topic_id: persisted_topic_id,
          prompt: stored_prompt,
        })
      } catch (err) {
        throw new InterviewError(
          'signup',
          'send_failed',
          true,
          `failed to re-send S1 prompt for project=${input.project_slug}`,
          err,
        )
      }
      if (resendResult.was_new) {
        if (!was_delivered_before) {
          await this.deps.buttonStore.markDelivered(prompt_id, this.now())
          this.deps.transcript.append({
            role: 'agent',
            body: stored_prompt.body,
            phase: 'signup',
            button_prompt_id: prompt_id,
          })
        } else {
          console.info(
            `[engine.start.reuse] event=reemit-reconnect project=${input.project_slug} topic=${persisted_topic_id} prompt=${prompt_id} — repainting prior delivery on fresh WS`,
          )
        }
      } else {
        console.warn(
          `[engine.start.reuse] event=resend-send-failed project=${input.project_slug} topic=${persisted_topic_id} prompt=${prompt_id} — leaving delivered_at=${delivered_at ?? 'null'} so future reconnect catches it`,
        )
      }
    }
    // Touch state.last_advanced_at so the duplicate-start signal is observable.
    const state = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'signup',
      phase_state_patch: { active_prompt_id: prompt_id },
      advanced_at: this.now(),
    })
    return { prompt_id, was_new: false, state }
  }

  /**
   * Codex r9 P1 — crash-recovery: the user answered (store.resolve
   * committed) but the engine died before advancing phase. Recover by
   * writing a system transcript line + advancing state to
   * `name_chosen` here, so the next start() (or any caller) sees a
   * consistent post-answer state instead of a permanently stuck
   * `signup` row pointing at a resolved prompt.
   */
  private async recoverResolvedAnswer(
    input: StartInput,
    existing: OnboardingState,
    prompt_id: string,
    choice_value: string,
    freeform_text: string | null,
  ): Promise<StartResult> {
    // Recovery on a resolved prompt — the user answered before the
    // process died. Advance to the static spec's default target so the
    // engine reaches a consistent post-answer state regardless of which
    // entry point (acceptChoice / advance / start-on-recovery) ran first.
    // Recovery is intentionally a "static spec" path: no LLM round-trip
    // happens here because we're reconciling on restart, not driving a
    // fresh user turn.
    // 2026-05-14 — T9: the fallback default is the spec'd post-signup
    // target. Pre-T9 this defaulted to `name_chosen`, which was the same
    // shortcut bug the rest of T9 fixed. The static spec is the source
    // of truth; the literal fallback only fires if STATIC_PHASE_SPECS
    // is somehow stripped (theoretically impossible — it's a const).
    const recovery_next_phase: OnboardingPhase = this.nextPhaseForMode(
      existing.phase,
      STATIC_PHASE_SPECS['signup']?.next_phase_on_default ?? 'instance_provisioned',
    )
    if (!isLegalTransition(existing.phase, recovery_next_phase, this.deploymentMode)) {
      throw new InterviewError(
        existing.phase,
        'illegal_transition',
        false,
        `recovery from resolved prompt: illegal transition ${existing.phase} → ${recovery_next_phase}`,
      )
    }
    // Codex r11 P2 — append role='user' (NOT 'system') so downstream
    // consumers reading the user-line stream (resume context, audit,
    // S2 persona synthesis) see the recovered answer the same way they
    // see a normally-handled answer. A separate role='system' note
    // tags the entry as recovered for observability.
    const body =
      choice_value === '__freeform__' && freeform_text !== null && freeform_text.length > 0
        ? freeform_text
        : choice_value
    this.deps.transcript.append({
      role: 'user',
      body,
      phase: 'signup',
      button_prompt_id: prompt_id,
      button_choice: choice_value,
    })
    this.deps.transcript.append({
      role: 'system',
      body: `recovery: re-applied resolved prompt during start() (the reply was not consumed before restart)`,
      phase: 'signup',
      button_prompt_id: prompt_id,
      button_choice: choice_value,
    })
    // 2026-05-14 — T9: extract a name from the freeform reply rather
    // than writing the entire persona-discovery answer as `agent_name`.
    // Pre-T9 the recovery path treated `freeform_text` as the literal
    // name (because recovery ran into name_chosen via the shortcut). The
    // live consumeChoice path always extracted via
    // `extractAgentNameFromFreeform`; the recovery path now matches it.
    // Persist the extracted name to `phase_state.agent_name` so the
    // downstream archetype_picked → name_chosen handoff picks it up via
    // its `persisted_name` lookup.
    const recovered_agent_name =
      choice_value === '__freeform__' &&
      freeform_text !== null &&
      freeform_text.length > 0
        ? extractAgentNameFromFreeform(freeform_text)
        : null
    const state = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: recovery_next_phase,
      phase_state_patch: {
        chosen_value: choice_value,
        ...(freeform_text !== null && freeform_text.length > 0
          ? { chosen_freeform: freeform_text }
          : {}),
        ...(recovered_agent_name !== null
          ? { agent_name: recovered_agent_name }
          : {}),
      },
      advanced_at: this.now(),
    })
    // Sprint 30 (Codex r3 P2) — fire personaSync on the crash-recovery
    // path too. Without this, a process restart between resolution +
    // acceptChoice leaves the `agent_name` registry row stale even though
    // onboarding successfully advances. Same null-skip guard as the
    // live acceptChoice / consumeChoice paths.
    if (this.deps.personaSync !== undefined && recovered_agent_name !== null) {
      try {
        await this.deps.personaSync.recordAgentName({
          project_slug: input.project_slug,
          agent_name: recovered_agent_name,
        })
      } catch (err) {
        console.warn(
          `[engine] personaSync.recordAgentName (recovery) failed for project=${input.project_slug}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }
    return { prompt_id, was_new: false, state }
  }

  // ----- S2: full state machine driver -----

  /**
   * Drive the interview from any phase forward. Called by the channel
   * layer for every inbound message during onboarding. Idempotent on
   * duplicate inbounds because ButtonStore.resolve dedupes; freeform
   * messages without an active prompt re-emit the current phase.
   *
   * Resume-on-reconnect (§ 2.8): if `now - last_advanced_at > resume_gap_ms`
   * and no resume prompt is active, the engine emits a "Welcome back, we
   * left off at <X>" prompt and returns. The next `advance(...)` consumes
   * the resume choice: Continue advances out of the stuck phase, Restart
   * re-emits the current phase, Pause leaves state untouched.
   */
  async advance(input: AdvanceInput): Promise<AdvanceResult> {
    this.clearResolvedSpecCache()
    const observed_at = input.observed_at ?? this.now()
    const state = await this.deps.stateStore.get(input.project_slug, input.user_id)
    if (state === null) {
      return { outcome: 'noop_no_state', state: null }
    }
    // 2026-05-28 final-handoff sprint — `completed` is terminal for the
    // phase machine but the engine still consumes button taps + freeform
    // replies on the final-handoff prompt (3 buttons web / 2 buttons
    // telegram) so the user can pick mobile-app / telegram-bind / skip.
    // The phase NEVER advances out of `completed`; only `active_prompt_id`
    // rotates. Legacy completed rows (pre-sprint) and rows whose active
    // prompt isn't a handoff prompt fall through to the standard
    // `noop_terminal` below.
    if (state.phase === 'completed') {
      return await this.handleFinalHandoffOnCompleted(input, state, observed_at)
    }
    if (TERMINAL_PHASES.has(state.phase)) {
      return { outcome: 'noop_terminal', state }
    }

    // Resume-on-reconnect detection. The structured-state's
    // `last_advanced_at` is the watchdog signal per § 2.8; we compare
    // against the observation time threaded by the caller so a slow
    // queue does not artificially trip the gate.
    const resume_gap_ms = this.deps.resume_gap_ms ?? DEFAULT_RESUME_GAP_MS
    const stale = observed_at - state.last_advanced_at >= resume_gap_ms
    const resume_active_id = readString(state.phase_state, 'resume_active_prompt_id')

    // Path A: a resume prompt is already active and the inbound resolves it.
    if (resume_active_id !== null && input.choice !== undefined && input.choice.prompt_id === resume_active_id) {
      return await this.handleResumeChoice(input, state, resume_active_id, observed_at)
    }

    // Path B: stale gap + no active resume prompt yet → emit one.
    if (stale && resume_active_id === null) {
      return await this.emitResumePrompt(input, state, observed_at)
    }

    // Path C: resume prompt is active but inbound is for some other (or no)
    // prompt — re-emit the resume prompt rather than accepting unrelated
    // input.
    if (resume_active_id !== null) {
      return await this.reemitResumePrompt(input, state, resume_active_id, observed_at)
    }

    // Normal advance through the phase machine.
    return await this.normalAdvance(input, state, observed_at)
  }

  /**
   * Emit (or re-emit) the current phase's prompt without consuming an
   * inbound. Useful for the post-signin landing path that wants the agent
   * to greet the user even before any inbound arrives. Idempotent — the
   * idempotency_key is derived from (instance, topic, phase) so a duplicate
   * call collapses on the existing button_prompts row.
   */
  async emitCurrentPhasePrompt(input: {
    project_slug: string
    /**
     * ISSUES #2 (2026-05-19) — second PK component on `onboarding_state`.
     * Required so the post-signin landing path emits for the correct
     * user when an instance has multiple onboarded users.
     */
    user_id: string
    topic_id: string
    observed_at?: number
  }): Promise<AdvanceResult> {
    this.clearResolvedSpecCache()
    const observed_at = input.observed_at ?? this.now()
    let state = await this.deps.stateStore.get(input.project_slug, input.user_id)
    if (state === null) return { outcome: 'noop_no_state', state: null }
    if (TERMINAL_PHASES.has(state.phase)) return { outcome: 'noop_terminal', state }
    // Auto-skip past gateless phases so the post-signin landing emits the
    // first interactive prompt instead of the suppressed gate body. See
    // `AUTO_SKIP_PHASES`.
    if (AUTO_SKIP_PHASES.has(state.phase)) {
      state = await this.walkAutoSkip(input.project_slug, state, observed_at)
      if (TERMINAL_PHASES.has(state.phase)) return { outcome: 'noop_terminal', state }
    }
    // ISSUES #1 (2026-05-19) — resume-path synthesis trigger.
    // See `normalAdvance` for the rationale: same guard, same risk
    // (post-signin landing on an instance whose prior compose was
    // interrupted). `synthesizePersona` only reads
    // `project_slug` + `topic_id` off its input, so we synthesise a
    // minimal AdvanceInput-shaped envelope here without inventing a
    // `user_id` / `channel_kind` we don't have on this code path.
    if (await this.shouldRetrySynthesizePersonaOnResume(state)) {
      // ISSUES #2 (2026-05-19) — source user_id from the SQL column
      // (state.user_id), not phase_state.user_id. Reading from state
      // matches the new (project_slug, user_id) PK; the phase_state
      // copy is the legacy compat shim per brief § 4.6.
      const synthesize_input: AdvanceInput = {
        project_slug: input.project_slug,
        topic_id: input.topic_id,
        user_id: input.user_id,
        channel_kind: 'app-socket',
      }
      state = await this.synthesizePersona(synthesize_input, state, observed_at)
      if (TERMINAL_PHASES.has(state.phase)) return { outcome: 'noop_terminal', state }
    }
    // 2026-05-28 — same auto-skip on the resume / post-signin landing
    // path as `normalAdvance`. An instance whose Max attached during a
    // prior session should never re-see the connect prompt on
    // reconnect.
    if (state.phase === 'max_oauth_offered') {
      const advance_input: AdvanceInput = {
        project_slug: input.project_slug,
        topic_id: input.topic_id,
        user_id: input.user_id,
        channel_kind: 'app-socket',
      }
      state = await this.maybeAutoAdvancePastMaxOauthOffered(advance_input, state, observed_at)
      if (TERMINAL_PHASES.has(state.phase)) return { outcome: 'noop_terminal', state }
    }
    const spec = STATIC_PHASE_SPECS[state.phase]
    if (spec === undefined) return { outcome: 'no_active_prompt', state }
    // Codex r6 P1: persist active_prompt_id BEFORE the channel send by
    // routing the upsert through emitPhasePrompt's pre_send hook. Codex
    // r3 P2: preserve `last_advanced_at` so a stale owner who reconnects
    // after the 24h window still trips resume-on-reconnect on the next
    // real advance().
    let updated: OnboardingState | null = null
    const result = await this.emitPhasePrompt({
      project_slug: input.project_slug,
      user_id: input.user_id,
      topic_id: input.topic_id,
      phase: state.phase,
      observed_at,
      pre_send_state_upsert: async (prompt_id: string) => {
        updated = await this.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: state.phase,
          phase_state_patch: { active_prompt_id: prompt_id, topic_id: input.topic_id },
          advanced_at: state.last_advanced_at,
        })
      },
    })
    if (updated === null) {
      // pre_send_state_upsert is always called by emitPhasePrompt; this is
      // defensive in case the implementation drifts.
      updated = await this.deps.stateStore.get(input.project_slug, input.user_id) as OnboardingState
    }
    return { outcome: 'reemitted_current', state: updated, prompt_id: result.prompt_id }
  }

  /**
   * Cron-tick handle. Currently a no-op stub: the actual resume-prompt
   * emit happens inline on `advance(...)` because the engine cannot post
   * to a channel without an inbound user_id. The hook is exported so the
   * gateway tick can call it for future watchdog responsibilities (e.g.
   * sweeping stuck phases past 5 min, per § 7 risk row "state machine
   * drift").
   */
  async tick(): Promise<void> {
    // Reserved for future stuck-phase detection. Today, advance() handles
    // the resume-on-reconnect emit lazily on inbound. See § 2.8.
  }

  /**
   * S12 (2026-05-16) — import-running cron-tick handle.
   *
   * Per docs/plans/P2-onboarding-v2.md § 3.4 + § S5: `import_running` is a
   * transit phase that must advance to `import_analysis_presented` when
   * the ImportJobRunner reaches `completed` / `failed` / `cancelled` /
   * hard-timeout. The original wiring polled exactly
   * once inside `notifyImportUpload`, so the engine never detected the
   * runner's terminal state — Pass-1 + Pass-2 finished, the result row
   * landed in `import_results`, but the engine stayed at `import_running`
   * forever (v0.1.33 live walkthrough stall, root cause).
   *
   * This method is invoked by the per-instance import-running cron
   * (`onboarding/interview/import-running-cron.ts`) every 15 s while an
   * instance is at `phase=import_running` with `import_job_id` set. It:
   *
   *   1. Reads state. If the instance is not at `import_running` OR has no
   *      `import_job_id`, returns a `no_active_job` no-op. The cron
   *      registry's SQL filter already pre-filters these rows; the guard
   *      is belt-and-braces for unit-test callers + race against an
   *      advance that landed between scan + tick.
   *
   *   2. If `import_running_sub_step` is `failed`, the user has been
   *      shown a retry/skip keyboard and we're waiting on a tap. Returns
   *      `awaiting_user_choice` so the cron does not re-emit (which
   *      would burn a new button row per tick).
   *
   *   3. Resolves `topic_id` / `user_id` / `signup_via` from
   *      `phase_state` (the engine.start path writes these on every
   *      instance so the cron handler doesn't need its own resolver).
   *      Missing context → `missing_channel_context` no-op.
   *
   *   4. Calls `pollImportRunningAndAdvance` with
   *      `suppress_in_progress_status_emit: true` so the in-progress
   *      branch silently no-ops while terminal branches still fire the
   *      advance + analysis-prompt as if a user inbound had triggered
   *      the poll.
   *
   * Idempotency: the cron may fire concurrently with a user inbound that
   * also calls `pollImportRunningAndAdvance`. Both paths route through
   * `stateStore.upsert` + `buttonStore.emit` which are idempotent on the
   * (instance, prompt-id) and (instance, phase, idempotency_key) keys. A
   * double-fire collapses to a single channel send.
   */
  async pollImportRunningTick(input: {
    project_slug: string
    /**
     * ISSUES #2 (2026-05-19) — second PK component. The cron's row scan
     * (see `import-running-cron.ts`) now projects (project_slug, user_id)
     * pairs and calls this method once per pair.
     */
    user_id: string
    observed_at?: number
  }): Promise<{
    outcome:
      | 'no_active_job'
      | 'awaiting_user_choice'
      | 'missing_channel_context'
      | 'in_progress'
      | 'advanced'
      | 'emitted_terminal_prompt'
    state: OnboardingState | null
  }> {
    const observed_at = input.observed_at ?? this.now()
    const state = await this.deps.stateStore.get(input.project_slug, input.user_id)
    if (state === null) return { outcome: 'no_active_job', state: null }
    if (state.phase !== 'import_running') {
      return { outcome: 'no_active_job', state }
    }
    const job_id = readString(state.phase_state, 'import_job_id')
    if (job_id === null) return { outcome: 'no_active_job', state }

    const sub_step = readString(state.phase_state, 'import_running_sub_step')
    if (sub_step === 'failed') {
      return { outcome: 'awaiting_user_choice', state }
    }

    const topic_id = readString(state.phase_state, 'topic_id')
    // ISSUES #2 (2026-05-19) — source user_id from the SQL column
    // (state.user_id), not phase_state.user_id. The phase_state copy
    // stays as a one-release compat shim per the brief § 4.6.
    const user_id = state.user_id
    const signup_via = readString(state.phase_state, 'signup_via')
    // ND-A (2026-06-28) — single-owner Open Path-1 (the freeform app-ws
    // onboarding drive) never runs `engine.start`, so it never stamps
    // `signup_via` into phase_state. The old guard ALSO required
    // `signup_via ∈ {telegram,web}` here, so an Open import was stranded at
    // `import_running` forever: every 5s cron tick returned
    // `missing_channel_context` and the engine never advanced → projects never
    // registered, memory never materialized (docs/research/fullpipe-e2e-2026-06-28.md
    // § Stage 3). In single-owner Open the channel is ALWAYS the app-socket, so
    // a missing/garbled `signup_via` must NEVER strand the user: we only need
    // `topic_id` + `user_id` to advance. `channel_kind` below already routes
    // every non-`telegram` value (including absent/`web`) to `app-socket`, so an
    // explicit telegram signup still routes to telegram and the existing
    // button-driven web flow is unchanged.
    if (topic_id === null || user_id === null) {
      return { outcome: 'missing_channel_context', state }
    }
    const advanceInput: AdvanceInput = {
      project_slug: input.project_slug,
      topic_id,
      user_id,
      channel_kind: signup_via === 'telegram' ? 'telegram' : 'app-socket',
      observed_at,
    }

    const result = await this.pollImportRunningAndAdvance(
      advanceInput,
      state,
      observed_at,
      { suppress_in_progress_status_emit: true },
    )
    const next_state = result.state
    if (next_state !== null && next_state.phase !== 'import_running') {
      return { outcome: 'advanced', state: next_state }
    }
    // Still at import_running. Inspect sub_step to distinguish a silent
    // in-progress tick (no emit) from a fresh failed emit the terminal
    // branch just fired.
    const next_sub_step =
      next_state !== null ? readString(next_state.phase_state, 'import_running_sub_step') : null
    if (next_sub_step === 'failed') {
      return { outcome: 'emitted_terminal_prompt', state: next_state }
    }
    return { outcome: 'in_progress', state: next_state }
  }

  /**
   * P2 v2 § 3.5 / § 6.1 — upload-handler bridge. The HTTP upload handler
   * (`gateway/upload/import-upload-handler.ts`) writes the user's ZIP to
   * `<owner_home>/imports/<source>.zip` and then calls this entry point
   * so the engine can start the import job and transition the user out
   * of `import_upload_pending` without requiring a follow-up button tap.
   *
   * Per spec § 3.5 advance criterion: "Upload handler fires
   * `import_upload_ready` event → engine reads
   * `<owner_home>/imports/<source>.zip` → advances to `import_running`
   * and starts the ImportJobRunner."
   *
   * Source is the upload-route enum (`chatgpt` / `claude`) which we map
   * to the existing `ImportSource` payload-runner enum (`chatgpt-zip`
   * / `claude-zip`) so the wired `FilesystemImportPayloadResolver` and
   * `ImportJobRunner.start(...)` keep working unchanged.
   *
   * Returns:
   *   - `outcome: 'advanced'` + `prompt_id` when the runner started AND
   *     the engine emitted the `import_running` status prompt.
   *   - `outcome: 'noop_no_state'` when the instance has no onboarding
   *     state AND the upload is NOT a solicited open-mode Path-1 upload
   *     (managed mode, or open mode with the affordance not offered).
   *   - In open mode with the upload affordance offered, a NO-state upload is
   *     a solicited Path-1 export (the live flow seeds the row lazily/async via
   *     the post-turn extractor, and #130 offers the import right after the
   *     name — so the upload can beat the row): the engine SEEDS the
   *     onboarding_state row at `work_interview_gap_fill` and starts the import
   *     (same outcome shape as the non-null open-mode solicited path) rather
   *     than returning `noop_no_state` and orphaning the export.
   *   - `outcome: 'advanced'` ALSO when a late upload races a freeform
   *     reroute: the user typed at `import_upload_pending`, flipping phase
   *     to `ai_substrate_offered` (non-destructive — `ai_substrate_used`
   *     preserved), and the upload completed afterward with a source that
   *     MATCHES the retained substrate. We start the import for that source
   *     rather than orphaning the staged zip (Argus r1 concurrent-upload
   *     race fix).
   *   - `outcome: 'no_active_prompt'` when the instance's phase is NOT
   *     `import_upload_pending` and the late-upload-at-`ai_substrate_offered`
   *     recovery above does not apply (different phase, or the uploaded
   *     source no longer matches `ai_substrate_used` — in which case we first
   *     surface a visible confirm/re-pick notice so the file is never silently
   *     dropped behind an ok-looking response).
   *   - `outcome: 'reemitted_current'` when the runner is unwired OR
   *     the payload resolver returned null. The engine surfaces the
   *     failed-sub-step prompt on `import_running` so the user has a
   *     visible recovery path.
   */
  async notifyImportUpload(input: {
    project_slug: string
    topic_id: string
    user_id: string
    channel_kind: ChannelKindForButton
    source: 'chatgpt' | 'claude'
    observed_at?: number
  }): Promise<AdvanceResult> {
    // Serialize per (project_slug, user_id) so concurrent uploads for the same
    // fresh-install owner can't race the no-state import-start path (Codex r1
    // P2). The body (`notifyImportUploadLocked`) is the real logic; the recheck
    // re-entry inside it calls the locked body DIRECTLY (not this wrapper) so it
    // never re-acquires this tail and deadlocks.
    const key = `${input.project_slug}:${input.user_id}`
    const prev = this.importUploadSerial.get(key) ?? Promise.resolve()
    const run = prev
      .catch(() => undefined)
      .then(() => this.notifyImportUploadLocked(input))
    this.importUploadSerial.set(key, run)
    try {
      return await run
    } finally {
      if (this.importUploadSerial.get(key) === run) this.importUploadSerial.delete(key)
    }
  }

  private async notifyImportUploadLocked(input: {
    project_slug: string
    topic_id: string
    user_id: string
    channel_kind: ChannelKindForButton
    source: 'chatgpt' | 'claude'
    observed_at?: number
  }): Promise<AdvanceResult> {
    this.clearResolvedSpecCache()
    const observed_at = input.observed_at ?? this.now()
    const state = await this.deps.stateStore.get(input.project_slug, input.user_id)
    if (state === null) {
      // M1 (#130 regression) — open-mode Path-1 upload with NO onboarding_state
      // row yet. The open-mode live-agent onboarding (open/composer.ts) NEVER
      // calls `engine.start()` (managed mode's row-seeding entry, :676). The
      // row is instead created LAZILY + ASYNCHRONOUSLY by the fire-and-forget
      // post-turn extractor (`post-turn-extractor.ts` — a multi-second
      // background LLM call that only upserts the row once it extracts a field).
      // #130 moved the history-import offer to immediately after the name, so a
      // fresh-install owner can upload their export BEFORE that background
      // extractor has created the row. Pre-fix this hit the `noop_no_state`
      // early-return below → the upload handler returned `job_id: null` and the
      // client showed "Couldn't start the import — no import job started": the
      // banned silent-no-op-that-looks-like-success.
      //
      // The upload is genuinely SOLICITED — we key on the SAME signal as the
      // non-null open-mode gate below (`deploymentMode === 'open'` AND
      // `importAffordanceOffered`, the exact condition under which the live-agent
      // seam renders the 📎 affordance). So seed the onboarding_state row at the
      // conversational interview marker and start the import here, rather than
      // orphaning the staged export. A STRAY upload (affordance NOT offered, e.g.
      // no synthesis substrate) still falls through to `noop_no_state`.
      //
      // We seed the row ourselves (rather than letting
      // `startImportAndAdvanceToRunning`'s own upsert create it) so the
      // import-running cron's channel-context invariant holds on disk: it needs
      // `signup_via` to advance `import_running`, and the open Path-1 flow has no
      // `engine.start` to stamp it — the post-turn extractor stamps the same
      // `signup_via='web'` default (ND-A, post-turn-extractor.ts).
      if (this.deploymentMode === 'open' && this.deps.importAffordanceOffered === true) {
        // Concurrency + downgrade guard (Codex r1 P2). Between the `state===null`
        // read above and here, a concurrent fresh-install upload (double-submit /
        // client retry) — or the post-turn extractor — may have created the row.
        // Re-read; if it now exists, RE-ENTER the normal flow so every non-null
        // guard applies: `noop_terminal`, and crucially `alreadyHasImportJob`
        // (the non-null open-mode gate) — so we never start a DUPLICATE job and
        // never let our `work_interview_gap_fill` seed below DOWNGRADE a live
        // `import_running` row off the import cron. The row now exists, so the
        // re-entry takes the non-null path, never this branch again (bounded —
        // no unbounded recursion). The residual truly-simultaneous window (both
        // requests read null twice before either writes) matches the non-null
        // path's own non-atomic `alreadyHasImportJob` check.
        const recheck = await this.deps.stateStore.get(input.project_slug, input.user_id)
        if (recheck !== null) {
          // Call the LOCKED body, not the public wrapper — we already hold the
          // per-user serialization tail; re-acquiring it would deadlock.
          return await this.notifyImportUploadLocked({ ...input, observed_at })
        }
        const advanceInput: AdvanceInput = {
          project_slug: input.project_slug,
          topic_id: input.topic_id,
          user_id: input.user_id,
          channel_kind: input.channel_kind,
          observed_at,
        }
        const seeded = await this.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          // Same non-terminal conversational marker the extractor creates the
          // row at (so `isOnboardingActive` stays true and persona-gen reads it
          // identically). `startImportAndAdvanceToRunning` upserts straight to
          // `import_running` from here.
          phase: 'work_interview_gap_fill',
          phase_state_patch: {
            topic_id: input.topic_id,
            user_id: input.user_id,
            signup_via: input.channel_kind === 'telegram' ? 'telegram' : 'web',
          },
          advanced_at: observed_at,
        })
        this.deps.transcript.append({
          role: 'system',
          body: `import: solicited Path-1 upload source=${input.source} landed with NO onboarding_state row (open-mode live flow seeds it lazily/async; #130 offers import right after the name); seeded row at work_interview_gap_fill + starting import rather than orphaning the export`,
          phase: seeded.phase,
        })
        return await this.startImportAndAdvanceToRunning(
          advanceInput,
          seeded,
          observed_at,
          input.source,
        )
      }
      return { outcome: 'noop_no_state', state: null }
    }
    if (TERMINAL_PHASES.has(state.phase)) return { outcome: 'noop_terminal', state }
    const advanceInput: AdvanceInput = {
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      user_id: input.user_id,
      channel_kind: input.channel_kind,
      observed_at,
    }
    if (state.phase !== 'import_upload_pending') {
      // Concurrent-upload race recovery (Argus r1 BLOCKER). Fix 1 routes ALL
      // freeform at `import_upload_pending` to the source picker, flipping
      // phase to `ai_substrate_offered`. The composer is NOT locked during an
      // in-flight upload (`sendInput` guards only `inFlight`), and multi-GB
      // exports upload for minutes — so a user who types ANYTHING ("is it
      // done?") mid-upload flips the phase BEFORE the upload POST completes.
      // The upload then lands HERE, at `ai_substrate_offered`. Returning a
      // bare `no_active_prompt` (HTTP 200 ok:true) would orphan the file: the
      // client renders success but no `import_running` ever fires and the
      // import silently never runs — a banned silent-no-op-that-looks-like-
      // success.
      //
      // The reroute is NON-DESTRUCTIVE: `reEmitImportSourceSelection`
      // deliberately preserves `ai_substrate_used`. So when the late upload's
      // source MATCHES the preserved substrate, honor it — start the import
      // for the retained source, taking the exact path
      // `import_upload_pending` would have. (`startImportAndAdvanceToRunning`
      // upserts phase to `import_running` regardless of the current phase; it
      // reads `state.phase` only for transcript context.)
      if (state.phase === 'ai_substrate_offered') {
        const ps = state.phase_state as Record<string, unknown>
        const recordedSubstrate = readString(ps, 'ai_substrate_used')
        // ISSUES #98 — explicit-switch guard. When the user typed a freeform
        // that named a DIFFERENT source than the staged one, the reroute
        // recorded `source_switch_intent` (the source they moved TO). A late
        // upload of the source they ABANDONED must NOT be auto-honored just
        // because `ai_substrate_used` was preserved (non-destructive re-emit).
        // If the intent points somewhere other than this upload's source, fall
        // through to the visible re-pick notice instead of importing the stale
        // source. (A bare clarification records no intent → auto-honor below
        // still fires, preserving the Argus r1 concurrent-upload recovery.)
        const switchIntent = readString(ps, 'source_switch_intent')
        const honorsLateUpload =
          recordedSubstrate === input.source &&
          (switchIntent === null || switchIntent === input.source)
        if (honorsLateUpload) {
          this.deps.transcript.append({
            role: 'system',
            body: `import: late upload source=${input.source} landed after freeform reroute to ai_substrate_offered (ai_substrate_used=${recordedSubstrate} preserved); honoring it rather than orphaning the staged zip`,
            phase: state.phase,
          })
          return await this.startImportAndAdvanceToRunning(
            advanceInput,
            state,
            observed_at,
            input.source,
          )
        }
        // Source mismatch OR explicit-switch intent (ISSUES #98): the user
        // genuinely moved to a DIFFERENT source after the reroute — either the
        // late upload's source already differs from the staged one, or they
        // typed an explicit switch (`source_switch_intent`) and this upload is
        // of the source they abandoned. Importing the stale upload would
        // violate their switch — but a silent `no_active_prompt` would orphan
        // the file with no user-visible signal. Surface a visible notice
        // instead so the upload is acknowledged and the user can confirm/re-pick.
        await this.sendAgentText(
          advanceInput,
          state.phase,
          LATE_UPLOAD_SOURCE_MISMATCH_NOTICE(input.source),
          observed_at,
        )
        this.deps.transcript.append({
          role: 'system',
          body: `import: late upload source=${input.source} landed after reroute but the user moved to a different source (ai_substrate_used=${recordedSubstrate ?? 'unknown'}, source_switch_intent=${switchIntent ?? 'none'}); surfaced confirm/re-pick notice rather than importing the abandoned source or silently dropping the upload`,
          phase: state.phase,
        })
        return { outcome: 'no_active_prompt', state }
      }
      // ND2 (dogfood 2026-06-27) — Path-1 (open-mode conversational onboarding)
      // solicited-upload routing. In open mode the live-agent onboarding seam
      // attaches the zip-import upload affordance to EVERY onboarding
      // agent_message whenever an import substrate is wired (see
      // `LiveAgentOnboardingSeam.uploadAffordance()` in open/composer.ts — it
      // returns non-null iff `importSubstrate !== null`, the SAME substrate that
      // wires `importJobRunner` on this engine). The engine therefore never
      // enters the legacy `import_upload_pending` phase: it sits at a
      // conversational phase (`work_interview_gap_fill`, etc.) while the client
      // renders the 📎 "attach your export" affordance. A zip the user uploads
      // THROUGH that affordance is genuinely SOLICITED and must start the
      // import — pre-fix it fell through to a 200-OK no-op and the file was
      // orphaned (`import_jobs` empty forever) behind a false "reading your
      // history now" banner: the banned silent-no-op-that-looks-like-success.
      //
      // Solicited signal we key on (so a STRAY / unsolicited upload still
      // no-ops safely — NOT a blanket "import from any phase"):
      //   1. `deploymentMode === 'open'` — Path-1 conversational onboarding,
      //      where the affordance is offered on every turn. Managed mode only
      //      offers it at `import_upload_pending` / `ai_substrate_offered` (both
      //      handled above), so we never honor a sideways upload there.
      //   2. `importAffordanceOffered` — the EXACT condition under which the
      //      live-agent seam's `uploadAffordance()` returns non-null and the
      //      client renders the affordance (`importSubstrate !== null`, wired in
      //      build-landing-stack.ts). We must NOT key on `importJobRunner`
      //      presence: the Open composer ALWAYS wires a synthesis runner (over
      //      `importSubstrate ?? null`), so the runner exists even when no
      //      substrate exists and the affordance is HIDDEN — keying on it would
      //      start (then fail) a job for a stray upload (Codex review, PR #94).
      //   3. non-terminal state — already enforced above via TERMINAL_PHASES
      //      (`noop_terminal`), so a post-onboarding upload never reaches here.
      //   4. no import job already started (`import_job_id` null AND phase is
      //      not already `import_running`) — a re-upload mid/post-import must
      //      not spawn a duplicate job over a live one.
      //
      // `startImportAndAdvanceToRunning` upserts to `import_running` regardless
      // of the current phase (it reads `state.phase` only for transcript
      // context), so the conversational → import_running hop is safe.
      const alreadyHasImportJob =
        readString(state.phase_state, 'import_job_id') !== null ||
        state.phase === 'import_running'
      if (
        this.deploymentMode === 'open' &&
        this.deps.importAffordanceOffered === true &&
        !alreadyHasImportJob
      ) {
        this.deps.transcript.append({
          role: 'system',
          body: `import: solicited Path-1 upload source=${input.source} landed at conversational phase=${state.phase}; starting import (open-mode upload affordance is offered on every onboarding turn)`,
          phase: state.phase,
        })
        return await this.startImportAndAdvanceToRunning(
          advanceInput,
          state,
          observed_at,
          input.source,
        )
      }
      // Upload landed when we're at some other phase with no active affordance
      // (managed mode, runner unwired, or a job already running). Don't drive a
      // sideways transition; let the caller log + surface a non-fatal notice.
      return { outcome: 'no_active_prompt', state }
    }

    // Single-source import: one upload advances straight to analysis. (A
    // "Both" two-upload flow was removed 2026-06-06 — the importer only
    // ever processed a single source per job; see remove-both-import-option.)
    return await this.startImportAndAdvanceToRunning(
      advanceInput,
      state,
      observed_at,
      input.source,
    )
  }

  /**
   * Shared "start the import job for `effectiveSource` and advance to
   * import_running" core, factored out of `notifyImportUpload` so the
   * upload path and the skip-with-staged-upload path reuse the identical
   * runner-unwired / payload-missing / runner-threw fallbacks.
   */
  async startImportAndAdvanceToRunning(
    advanceInput: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    effectiveSource: 'chatgpt' | 'claude',
  ): Promise<AdvanceResult> {
    return importRoutingStartImportAndAdvanceToRunning(this, advanceInput, state, observed_at, effectiveSource)
  }

  /**
   * Helper for `notifyImportUpload` failure branches. Advances state to
   * `import_running` with a failure reason stamped so the engine's
   * `emitImportRunningPromptSpec` surfaces the retry/skip affordance.
   */
  async advanceToImportRunningFailed(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
    failure_reason: string,
  ): Promise<AdvanceResult> {
    return importRoutingAdvanceToImportRunningFailed(this, input, state, observed_at, source, failure_reason)
  }

  /**
   * Walk forward through `AUTO_SKIP_PHASES` so the engine never emits a
   * prompt body for one of those phases. Each step takes the legal
   * default-route target (`STATIC_PHASE_SPECS[phase].next_phase_on_default`),
   * runs `isLegalTransition`, applies the per-target entry-side patch the
   * non-skip path would have written (currently just clearing
   * `slug_picker_rejection` when crossing into `slug_chosen`), and persists
   * the new phase via `stateStore.upsert`. The loop exits on the first
   * phase that is NOT in `AUTO_SKIP_PHASES` (or is terminal).
   *
   * Returns the final post-skip state. The caller emits its prompt as if
   * the user had landed on that phase organically.
   */
  async walkAutoSkip(
    project_slug: string,
    state: OnboardingState,
    observed_at: number,
  ): Promise<OnboardingState> {
    let cur = state
    while (
      AUTO_SKIP_PHASES.has(cur.phase) &&
      !TERMINAL_PHASES.has(cur.phase)
    ) {
      const spec = STATIC_PHASE_SPECS[cur.phase]
      if (spec === undefined) break
      const next_phase = spec.next_phase_on_default
      if (!isLegalTransition(cur.phase, next_phase, this.deploymentMode)) {
        throw new InterviewError(
          cur.phase,
          'illegal_transition',
          false,
          `auto-skip illegal transition ${cur.phase} → ${next_phase}`,
        )
      }
      const entry_patch: Record<string, unknown> = { active_prompt_id: null }
      if (next_phase === 'slug_chosen') {
        // Mirror the consumeChoice slug_chosen entry side-effect so a
        // stale rejection from a prior visit doesn't surface in the body.
        entry_patch['slug_picker_rejection'] = null
      }
      cur = await this.deps.stateStore.upsert({
        project_slug,
        user_id: cur.user_id,
        phase: next_phase,
        phase_state_patch: entry_patch,
        advanced_at: observed_at,
      })
    }
    return cur
  }

  private async normalAdvance(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult> {
    // Auto-skip past gateless phases on resumed state so a reconnecting
    // user lands on the next interactive prompt rather than the suppressed
    // gate body. See `AUTO_SKIP_PHASES`.
    if (AUTO_SKIP_PHASES.has(state.phase)) {
      state = await this.walkAutoSkip(input.project_slug, state, observed_at)
      if (TERMINAL_PHASES.has(state.phase)) {
        return { outcome: 'advanced', state }
      }
    }
    // 2026-05-28 — auto-skip past `max_oauth_offered` when the instance
    // already has Max attached (substrate-credentials check; env stop-
    // gap on unwired secrets). Prevents the connect prompt from ever
    // appearing for instances that attached Max during the import phase.
    //
    // Gated on `input.choice === undefined` so a user-driven Done-tap
    // routes through `consumeMaxOauthChoice` (which has its own
    // identical auto-skip check) and returns `outcome: 'advanced'`
    // rather than this branch's "advance + emit wow_fired status body"
    // shape which would return `outcome: 'reemitted_current'`. Both
    // paths land on the same final state, but the choice-driven
    // outcome matters for the caller (Test 9 of the max-oauth-offered
    // regression suite pins `outcome === 'advanced'` for max_done →
    // wow_fired).
    if (state.phase === 'max_oauth_offered' && input.choice === undefined) {
      state = await this.maybeAutoAdvancePastMaxOauthOffered(input, state, observed_at)
      if (TERMINAL_PHASES.has(state.phase)) {
        return { outcome: 'advanced', state }
      }
    }
    // ISSUES #1 (2026-05-19) — resume-path synthesis trigger.
    //
    // If we land here at `persona_synthesizing` with no draft AND no
    // failure flag, the previous turn was interrupted between
    // `consumeChoice` firing `synthesizePersona` and the compose()
    // call returning (gateway restart, dropped socket, etc.). The
    // pre-fix behaviour was: re-emit tries to render a static body for
    // the phase, the body doesn't exist, resolver returns null,
    // `emitPhasePrompt` throws `prompt_emit_failed`, and the literal
    // error string surfaces as a chat bubble. With § 4.2's fall-through
    // the user would instead see the spec § 3.13 status body
    // ("Composing your persona...") indefinitely on every reconnect
    // because nothing would ever re-fire compose. The guard below
    // closes that gap by re-firing `synthesizePersona` on the resume.
    if (await this.shouldRetrySynthesizePersonaOnResume(state)) {
      state = await this.synthesizePersona(input, state, observed_at)
      if (TERMINAL_PHASES.has(state.phase)) {
        return { outcome: 'advanced', state }
      }
    }
    let spec = STATIC_PHASE_SPECS[state.phase] as PhasePromptSpec | undefined
    if (spec === undefined) {
      // T1 (2026-05-13) — `persona_synthesizing` has no STATIC spec
      // (it's a transit phase) but DOES have a dynamic fallback spec
      // when a prior compose attempt failed. Resolve dynamically so
      // the user's tap on the Retry / Use basic template / Skip persona
      // keyboard routes into `consumePersonaSynthesizingChoice` instead
      // of stranding at `no_active_prompt`.
      if (state.phase === 'persona_synthesizing' && this.deps.personaComposer !== undefined) {
        const dyn = await this.resolvePhasePromptSpec(input.project_slug, input.user_id, state.phase)
        if (dyn !== null) spec = dyn
      }
      if (spec === undefined) {
        // Phase has no prompt content (advances are external — e.g.
        // import_running, wow_fired). Caller is expected to drive these
        // directly via stateStore.
        return { outcome: 'no_active_prompt', state }
      }
    }

    const active_prompt_id = readString(state.phase_state, 'active_prompt_id')

    // No active prompt → emit one for the current phase + return.
    if (active_prompt_id === null) {
      // Codex r6 P1: persist active_prompt_id BEFORE the channel send.
      let updated: OnboardingState | null = null
      const emit = await this.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: state.phase,
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          updated = await this.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: state.phase,
            phase_state_patch: { active_prompt_id: prompt_id, topic_id: input.topic_id },
            advanced_at: observed_at,
          })
        },
      })
      if (updated === null) {
        updated = await this.deps.stateStore.get(input.project_slug, input.user_id) as OnboardingState
      }
      return { outcome: 'reemitted_current', state: updated, prompt_id: emit.prompt_id }
    }

    // Inbound choice for the active prompt.
    if (input.choice !== undefined && input.choice.prompt_id === active_prompt_id) {
      return await this.consumeChoice(input, state, spec, input.choice, observed_at)
    }

    // Inbound freeform that the channel didn't route to a ButtonChoice.
    if (input.freeform_text !== undefined && input.freeform_text.length > 0) {
      // Sprint 2026-06-03 (onboarding-buttons-only-tweak-later) — resolve
      // the phase's interaction mode BEFORE the legacy freeform path.
      //   - buttons-only: emit the canned nudge, keep the live keyboard,
      //     do NOT advance, do NOT call the LLM router.
      //   - mixed: validate the text against the phase's declared
      //     text-input field. Valid → existing synthetic-`__freeform__`
      //     → consumeChoice path (still NO router). Invalid → canned nudge.
      //   - freeform: fall through to the legacy router / synthetic path
      //     unchanged.
      // Argus r1 BLOCKER 1 + 2 / r4 BLOCKER — resolve the active sub_step so
      // phases whose buttons-only classification carries freeform sub_steps
      // (persona_reviewed pick_replacement / pending_regen_hint;
      // import_running rate_limit_paused / failed; projects_proposed
      // share_freeform; max_oauth_offered awaiting_byo_paste) are NOT
      // stranded by the canned nudge — and (for the non-null-pack phases)
      // not routed to the LLM router either. `deriveActiveSubStep`
      // centralizes the per-phase `phase_state`-key knowledge (string keys
      // for persona_reviewed / import_running; boolean flags mapped to
      // canonical strings for projects_proposed / max_oauth_offered) so this
      // call site stays generic and adding a sub_step is a one-place change.
      // `resolveInteractionMode` returns `'freeform'` for those sub_steps;
      // everything else keeps the per-phase mode.
      const active_sub_step = deriveActiveSubStep(state.phase, state.phase_state)
      let interaction_mode = resolveInteractionMode(spec, state.phase, active_sub_step)
      // ISSUES #117 — route a POPULATED projects_proposed list-review edit to
      // the prod-wired llmRouter. `projects_proposed` is classified
      // `'buttons-only'` (the deliberate 2026-06-03 "tweak later, defer real
      // edits to the post-onboarding owner tools" decision), so a typed
      // "drop X / add Y" on the populated list hit the canned buttons-only
      // nudge and was IGNORED. The GAP1 additive union (added 2026-06-09)
      // originally landed only on the now-removed `promptDriver` extraction
      // path, which PRODUCTION never wired — so the edit fell back to
      // confirming the seeded list verbatim. The `llmRouter` is the single
      // extraction seam; route the edit to it instead. Treat
      // the populated list-review like its sibling review phase
      // `import_analysis_presented` (itself reclassified buttons-only →
      // 'freeform' for the same strand class, Argus r3 2026-06-03): override to
      // 'freeform' so the edit reaches `shouldConsultRouter` →
      // `dispatchRouterDecision`, where an `amend` applies the additive
      // `(seeded ∪ adds) minus removed_projects` union (below) and an `advance`
      // ("…go ahead") unions via `mergeAdvanceProjectsAdditively`. Scoped to the
      // POPULATED list with NO active sub_step: the ZERO-STATE share/skip screen
      // and the `share_freeform` sub-step keep their buttons-only handling, and
      // real post-onboarding edits still flow through delete_project /
      // merge_projects.
      if (
        interaction_mode === 'buttons-only' &&
        state.phase === 'projects_proposed' &&
        active_sub_step === null &&
        (readStringArray(state.phase_state as Record<string, unknown>, 'primary_projects') ?? [])
          .length > 0 &&
        // Codex r1 [P2] — ONLY override when the router will ACTUALLY be
        // consulted. Without this guard, a non-router deployment (flag off /
        // phase not in `getOnboardingConversationalPhases()` / no `llmRouter`
        // wired) would flip to 'freeform', skip the router gate below, and fall
        // through to the synthetic-`__freeform__` → `consumeProjectsProposedChoice`
        // path — which treats the typed edit as a CONFIRM and advances to
        // persona synthesis with the UNCHANGED list (a silent worse-than-nudge
        // regression). When the router is unavailable, keep the buttons-only
        // nudge. Mirrors the exact gate the freeform router-consultation block
        // applies (`shouldConsultRouter` + non-null pack + `llmRouter`).
        this.shouldConsultRouter(state.phase, active_sub_step) &&
        getKnowledgeForPhase(state.phase) !== null &&
        this.deps.llmRouter !== undefined
      ) {
        interaction_mode = 'freeform'
      }
      if (interaction_mode === 'buttons-only') {
        // ISSUES #84 (reopened 2026-06-06, import-screen-deadend sprint;
        // Sam real-signup) — import_upload_pending dead-end. Buttons-only
        // phases bypass the LLM router, so a freeform message at this phase
        // used to hit the bare buttons-only nudge with no way back to the
        // source picker. The earlier verb-gated `detectImportSourceSwitch`
        // only matched explicit switches (switch/swap/change/instead/…) +
        // a source token, so a bare clarification ("actually can I do
        // chatgpt?", "go back", "wrong one", "hmm") dead-ended.
        //
        // Fix: route ALL non-upload freeform here back to the source
        // picker (ChatGPT/Claude/Neither) unconditionally. Uploads never
        // reach this branch (they arrive as upload events, not
        // `freeform_text`), and the re-emit is NON-DESTRUCTIVE — it
        // preserves `uploads_received` / `ai_substrate_used`
        // (reEmitImportSourceSelection), so a user who only had a
        // clarification just re-taps their source and gets the
        // instructions again. Worst case is a harmless re-display; there is
        // no dead-end and no data loss. (Skip is a button tap, not freeform,
        // and is handled on the ButtonChoice path before this point.)
        if (state.phase === 'import_upload_pending') {
          return await this.reEmitImportSourceSelection(input, state, observed_at)
        }
        // ISSUES #98 (Argus r1b MINOR): at `ai_substrate_offered` the source
        // picker is live with a possibly-stale `source_switch_intent` recorded
        // by the earlier reroute. A freeform that RE-AFFIRMS the staged source
        // ("no, keep chatgpt") falls through to the buttons-only nudge, which
        // never reconciles the intent — so the user's in-flight upload of that
        // very source is then refused by `notifyImportUpload`'s explicit-switch
        // guard despite the restated intent. Reconcile the intent from the new
        // freeform before nudging (mirrors the reroute's set/clear semantics).
        if (state.phase === 'ai_substrate_offered') {
          state = await this.reconcileSwitchIntentFromFreeform(
            input,
            state,
            observed_at,
          )
        }
        return await this.emitButtonsOnlyNudge(
          input,
          state,
          active_prompt_id,
          observed_at,
        )
      }
      if (interaction_mode === 'mixed') {
        const validated = validateMixedTextInput(state.phase, input.freeform_text)
        if (!validated.valid) {
          // Argus r5 BLOCKER (2026-06-03): when the phase's canonical
          // validator produced a specific reason (agent_name_chosen →
          // validateAgentName), surface THAT instead of the generic
          // buttons-only nudge. The nudge ("Tap one of the buttons
          // above") is a hard stall on agent_name_chosen, which emits
          // `options:[]` — there are no buttons to tap. The canonical
          // reason ("…try another?") tells the user how to recover via
          // another typed name (mixed mode keeps freeform live). When
          // `error` is null (slug_chosen / personality_offered) the
          // generic nudge stands — those phases carry buttons on the
          // rejection screen.
          return await this.emitButtonsOnlyNudge(
            input,
            state,
            active_prompt_id,
            observed_at,
            validated.error,
          )
        }
        // Valid targeted text-input → capture via the existing synthetic
        // `__freeform__` → consumeChoice cascade. The LLM router is
        // deliberately bypassed for mixed phases (brief § 3): the text IS
        // the answer to the declared field, not an intent to classify.
        const mixed_synth: ButtonChoice = {
          prompt_id: active_prompt_id,
          choice_value: '__freeform__',
          freeform_text: input.freeform_text,
          chosen_at: observed_at,
          speaker_user_id: input.user_id,
          channel_kind: input.channel_kind,
        }
        return await this.consumeChoice(input, state, spec, mixed_synth, observed_at)
      }
      // interaction_mode === 'freeform' — legacy behavior below. NB this
      // branch is reached for TWO distinct reasons: (1) the phase is
      // genuinely freeform (signup / work_interview_gap_fill /
      // import_analysis_presented), where the router SHOULD run — its
      // verdicts (answer = FAQ deflection, amend = edit a captured field,
      // advance = feed the dedicated handler) are all wanted; (2) a
      // buttons-only phase whose active sub_step is freeform
      // (persona_reviewed pick_*/pending_regen_hint; import_running
      // rate_limit_paused/failed), where the router MUST be bypassed — the
      // typed text IS the answer to that sub_step's dedicated handler
      // (recompose / retry / re-poll), not an intent to classify.
      // `shouldConsultRouter` distinguishes the two via `active_sub_step`
      // (Argus r2 BLOCKER — same rationale the 'mixed' branch documents).
      // Argus r4 BLOCKER — gate on the LIVE emitted prompt's `allow_freeform`,
      // NOT the `STATIC_PHASE_SPECS` entry `spec` points at. The static entry
      // can disagree with the dynamically-built prompt the user is actually
      // looking at: `max_oauth_offered`'s static spec is `allow_freeform:false`
      // (the single-CTA "Connect" shape), but its `awaiting_byo_paste` shape —
      // built by `buildMaxOauthOfferedPromptSpec` and emitted with
      // `allow_freeform:true` — invites a typed key. Reading the static
      // `false` here skipped the synthetic-`__freeform__` capture below and
      // re-emitted the prompt, so the pasted API key never reached
      // `persistByoApiKeyAndAdvance` (BYO fully broken on the real
      // `freeform_text` channel path — the existing max-oauth Test 5 missed
      // it because it routes via a synthetic `__freeform__` *choice*, which
      // hits `consumeChoice` directly and skips this gate).
      // `projects_proposed` worked only because ITS static spec is already
      // `allow_freeform:true`. The ButtonStore row is the source of truth for
      // what was emitted; fall back to the static spec when the row is gone
      // (expired / swept). NB only `allow_freeform` comes from the live
      // prompt — the router still reads `spec.body` / `spec.options` so its
      // behavior on genuinely-freeform phases is byte-for-byte unchanged.
      const live_prompt = await this.deps.buttonStore.get(
        active_prompt_id,
        observed_at,
      )
      const prompt_allows_freeform = live_prompt?.allow_freeform ?? spec.allow_freeform
      if (prompt_allows_freeform) {
        // P2-v3 S2 — LLM router consultation. Fires only when (a) the
        // env flag is on AND (b) the phase has a non-null
        // PHASE_KNOWLEDGE pack AND (c) the engine is wired with a
        // router instance AND (d) we are NOT on a freeform sub_step.
        // Otherwise falls through to the v2 synthetic-`__freeform__`
        // path unchanged.
        if (this.shouldConsultRouter(state.phase, active_sub_step)) {
          const knowledge = getKnowledgeForPhase(state.phase)
          if (knowledge !== null && this.deps.llmRouter !== undefined) {
            // Pre-warm sprint (2026-06-05) — flag the FIRST router call of a
            // session (no prior USER turn in transcript) so the router applies
            // the cold-spawn-aware first-turn budget. The pre-warm spawned at
            // session-open normally makes turn 1 warm, but if the user replied
            // before the spawn finished, the wider budget lets the (coldish)
            // first call complete instead of timing out at the tight 6000ms.
            const recent_turns = recentTurnsForRouter(this.deps.transcript, 6)
            const first_turn = !recent_turns.some((t) => t.role === 'user')
            const decision = await this.deps.llmRouter.route({
              phase: state.phase,
              active_prompt: {
                body: spec.body,
                options: spec.options.map((o) => ({
                  label: o.label,
                  body: o.body,
                  value: o.value,
                })),
                allow_freeform: spec.allow_freeform,
                pick_only: !spec.allow_freeform,
              },
              user_text: input.freeform_text,
              knowledge,
              captured: extractCapturedFromState(state.phase_state),
              recent_turns,
              project_slug: input.project_slug,
              user_id: input.user_id,
              first_turn,
            })
            return await this.dispatchRouterDecision(
              input,
              state,
              spec,
              decision,
              active_prompt_id,
              observed_at,
            )
          }
        }
        const synth: ButtonChoice = {
          prompt_id: active_prompt_id,
          choice_value: '__freeform__',
          freeform_text: input.freeform_text,
          chosen_at: observed_at,
          speaker_user_id: input.user_id,
          channel_kind: input.channel_kind,
        }
        return await this.consumeChoice(input, state, spec, synth, observed_at)
      }
      // Freeform on a non-freeform prompt → record + re-emit.
      this.deps.transcript.append({
        role: 'user',
        body: input.freeform_text,
        phase: state.phase,
      })
      // Codex r6 P2: persist the new active_prompt_id BEFORE returning so
      // a re-rendered keyboard whose prompt_id differs from the prior one
      // (e.g. stale-rotated row in ButtonStore) doesn't strand the user
      // tapping a prompt the engine still considers stale.
      let updated: OnboardingState | null = null
      const emit = await this.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: state.phase,
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          updated = await this.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: state.phase,
            phase_state_patch: { active_prompt_id: prompt_id, topic_id: input.topic_id },
            advanced_at: observed_at,
          })
        },
      })
      if (updated === null) {
        updated = await this.deps.stateStore.get(input.project_slug, input.user_id) as OnboardingState
      }
      return { outcome: 'reemitted_current', state: updated, prompt_id: emit.prompt_id }
    }

    // Inbound for a different (stale) prompt or empty — no-op.
    return { outcome: 'no_active_prompt', state, prompt_id: active_prompt_id }
  }

  /**
   * P2-v3 S2 (2026-05-18) — per-phase gate for the LLM router. True when
   * (a) the env flag is bool-on OR includes this phase, AND (b) the
   * engine was constructed with a `platform` adapter exposing the
   * accessor. When the adapter is absent OR returns "no phases", this
   * returns false and the freeform fall-through takes the v2 path.
   *
   * Argus r2 BLOCKER (2026-06-03) — `activeSubStep` short-circuits to
   * false when the phase+sub_step is a freeform sub_step
   * (`FREEFORM_SUB_STEPS_BY_PHASE`). Those sub_steps have a dedicated
   * handler (recompose / retry / re-poll); the typed text is its answer,
   * not an intent to classify. Without this guard, `persona_reviewed`
   * (non-null knowledge pack) would route a typed tweak to
   * `llmRouter.route()`, and a non-`advance` verdict would re-emit the
   * keyboard and never recompose — the r1 stranding symptom via a new
   * mechanism. `import_running` is safe-by-accident today (null pack) but
   * is guarded too so adding a pack later can't silently re-break it.
   */
  private shouldConsultRouter(
    phase: OnboardingPhase,
    activeSubStep?: string | null,
  ): boolean {
    if (isFreeformSubStep(phase, activeSubStep)) return false
    if (this.deps.platform === undefined) return false
    const phases = this.deps.platform.getOnboardingConversationalPhases()
    if (phases === 'all') {
      return this.deps.platform.getOnboardingConversational()
    }
    return phases.has(phase)
  }

  /**
   * P2-v3 S2 (2026-05-18) — Dispatch a finalised `RouterDecision` per
   * design § 2.3. Three branches:
   *
   *  - `advance` — feed the router's choice_value (or freeform_text)
   *    into the existing `consumeChoice` cascade. Send `decision.response`
   *    first as an ack when non-null (e.g. "Got it, importing now").
   *  - `answer`  — send the in-context reply, re-attach the active
   *    keyboard, NO phase advance, NO state update.
   *  - `amend`   — merge `decision.state_delta` via `stateStore.upsert`,
   *    send `decision.response`, stay on phase.
   *
   * Telemetry: the router's `onRouteCompleted` hook is the canonical
   * `onboarding.router_decision` emit site (wired in the composer at
   * `gateway/realmode-composer/build-llm-router.ts`). The engine does
   * NOT re-emit here — keeps the router as single source of truth for
   * "what happened in routing" and the engine as single source of
   * truth for "what happens NEXT".
   */
  /**
   * Whitelist a router `state_delta` before it reaches the state store.
   * Shared by the `amend` branch AND the hybrid amend+advance merge in the
   * `advance` branch (envelope-conformance round 2). A TS cast on
   * `Partial<RequiredFieldsState>` is compile-time only — an adversarial LLM
   * delta could otherwise write bookkeeping columns (created_at, owner_id, …)
   * into phase_state_json. We keep only the per-design § 4 keys
   * (`ROUTER_AMEND_ALLOWED_KEYS`); `ai_substrate_used` is value-validated (not
   * merely whitelisted) so a hallucinated source can't strand the user on the
   * wrong upload instructions. Rejected keys are logged for the operator.
   * Returns the sanitised patch (empty object when nothing survives).
   */
  /**
   * Additive `primary_projects` merge for a REVIEW/CORRECTION *advance*
   * `state_delta` (GAP1 live-path, Argus r2 — see the call site in
   * `dispatchRouterDecision` for the full rationale). Returns a new
   * `state_delta` whose `primary_projects` is the case-insensitive UNION of
   * the router's extracted picks with the list already persisted in
   * `phase_state` — so a confirm/restate advance can only ADD projects, never
   * silently shrink the seeded list (the 7→3 regression). Every other key
   * passes through untouched. A `null` delta, or one touching neither
   * `primary_projects` nor `removed_projects`, is returned unchanged.
   *
   * REMOVAL on the advance path (Argus r3 BLOCKER, r4 fix). The blind
   * `(prior ∪ adds)` union re-adds EVERY prior project on every advance — but
   * the router legitimately classifies a REVIEW-completing *removal* ("drop the
   * Marina screenplay, the rest are good, go ahead") as an `advance`, NOT an
   * amend (see llm-router.ts § REVIEW/CORRECTION). Without a removal channel on
   * the advance path, that explicitly-dropped project is silently re-added by
   * the union and gets a shell — regressing the exact ISSUES #92 flow. So the
   * router now carries a TRANSIENT `removed_projects` on such an advance and the
   * merge becomes `(prior ∪ adds) MINUS removals` (case-insensitive). The
   * `removed_projects` key is a signal only — it is STRIPPED from the returned
   * delta so it never persists to `phase_state` (and `whitelistRouterStateDelta`
   * does not allow it through either). An `amend` ("drop X" as an off-screen
   * fact change) still keeps its plain overwrite — it never reaches this merge.
   */
  private mergeAdvanceProjectsAdditively(
    state_delta: RouterDecision['state_delta'],
    phase_state: Record<string, unknown>,
  ): RouterDecision['state_delta'] {
    if (state_delta === null) return state_delta
    const extracted = state_delta.primary_projects
    const removed = state_delta.removed_projects
    const has_extracted = Array.isArray(extracted)
    const has_removed = Array.isArray(removed)
    // No project signal at all (neither adds nor removals) → pass through.
    if (!has_extracted && !has_removed) return state_delta
    const extracted_strings = has_extracted
      ? extracted.filter(
          (p): p is string => typeof p === 'string' && p.trim().length > 0,
        )
      : []
    const removed_strings = has_removed
      ? removed.filter(
          (p): p is string => typeof p === 'string' && p.trim().length > 0,
        )
      : []
    const prior = readStringArray(phase_state, 'primary_projects') ?? []
    const union = dedupeStringsCaseInsensitive([...prior, ...extracted_strings])
    const removed_keys = new Set(
      removed_strings.map((p) => p.trim().toLowerCase()),
    )
    const merged =
      removed_keys.size === 0
        ? union
        : union.filter((p) => !removed_keys.has(p.trim().toLowerCase()))
    // Strip the transient removal signal so it never lands in phase_state.
    const { removed_projects: _removed, ...rest } = state_delta
    return { ...rest, primary_projects: merged }
  }

  private whitelistRouterStateDelta(
    state_delta: RouterDecision['state_delta'],
    phase: OnboardingPhase,
    project_slug: string,
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    const rejected_keys: string[] = []
    if (state_delta !== null) {
      for (const [k, v] of Object.entries(state_delta)) {
        if (k === 'ai_substrate_used') {
          if (typeof v === 'string' && ROUTER_AMEND_SUBSTRATE_VALUES.has(v)) {
            patch[k] = v
          } else {
            rejected_keys.push(k)
          }
        } else if (ROUTER_AMEND_ALLOWED_KEYS.has(k)) {
          patch[k] = v
        } else {
          rejected_keys.push(k)
        }
      }
    }
    if (rejected_keys.length > 0) {
      console.warn(
        `[interview-engine] router state_delta rejected non-whitelisted keys ${JSON.stringify(
          rejected_keys,
        )} on phase=${phase} project_slug=${project_slug}`,
      )
    }
    return patch
  }

  /**
   * BUG 1 FIX (onboarding-opening-fix, 2026-06-19) — try to advance signup
   * from a non-`advance` router decision (`amend` / low-confidence
   * `answer`). Returns an `AdvanceResult` when a valid `user_first_name`
   * signal is present (and the engine should advance off signup); returns
   * `null` when there is no name to act on (caller falls through to the
   * normal amend/answer handling).
   *
   * Name signal precedence (the first that yields a sanitized name wins):
   *   1. the router's whitelisted `state_delta.user_first_name`
   *   2. a `user_first_name` already persisted on `phase_state`
   *   3. the freeform reply, via the proven
   *      `extractAgentNameFromFreeform` → `sanitizeUserFirstName` pipeline
   *      (the SAME helpers the non-router `consumeChoice` name-guard uses).
   *
   * When a name is found we route through `consumeChoice` with a synthetic
   * `__freeform__` choice and the router's `state_delta` (re-whitelisted
   * inside `consumeChoice`), so the signup→instance_provisioned→
   * ai_substrate_offered cascade fires exactly as it does on a genuine
   * `advance`. The router `response` (when present) is sent first as the
   * acknowledgement, mirroring the `advance` / `import_analysis_presented`
   * branches.
   */
  private async tryAdvanceSignupFromRouter(
    input: AdvanceInput,
    state: OnboardingState,
    spec: PhasePromptSpec,
    decision: RouterDecision,
    active_prompt_id: string,
    observed_at: number,
  ): Promise<AdvanceResult | null> {
    // 1. Whitelisted state_delta user_first_name (rejects bookkeeping keys).
    const whitelisted = this.whitelistRouterStateDelta(
      decision.state_delta,
      state.phase,
      input.project_slug,
    )
    const deltaName =
      typeof whitelisted['user_first_name'] === 'string'
        ? sanitizeUserFirstName(whitelisted['user_first_name'] as string)
        : null
    // 2. Already persisted on phase_state.
    const persistedName = readString(state.phase_state, 'user_first_name')
    // 3. Extract from the freeform reply (router-supplied or raw input).
    const freeformText = decision.freeform_text ?? input.freeform_text ?? ''
    const extracted =
      freeformText.length > 0 ? extractAgentNameFromFreeform(freeformText) : null
    const freeformName = extracted === null ? null : sanitizeUserFirstName(extracted)

    const name = deltaName ?? persistedName ?? freeformName
    if (name === null) {
      // No name signal — let the caller run the normal amend/answer path
      // (FAQ deflection, clarify-reprompt, etc).
      return null
    }

    // Ack first (router wording when present) so it lands before the
    // next-phase prompt the advance emits.
    if (decision.response !== null && decision.response.length > 0) {
      await this.sendAgentText(input, state.phase, decision.response, observed_at)
    }
    const synth: ButtonChoice = {
      prompt_id: active_prompt_id,
      choice_value: '__freeform__',
      // Carry the name-bearing freeform so the consumeChoice signup
      // name-guard + heuristic capture re-derive user_first_name. Fall
      // back to the resolved name when neither the router nor the raw
      // input carried usable text.
      freeform_text: freeformText.length > 0 ? freeformText : name,
      chosen_at: observed_at,
      speaker_user_id: input.user_id,
      channel_kind: input.channel_kind,
    }
    return await this.consumeChoice(
      input,
      state,
      spec,
      synth,
      observed_at,
      decision.state_delta,
    )
  }

  private async dispatchRouterDecision(
    input: AdvanceInput,
    state: OnboardingState,
    spec: PhasePromptSpec,
    decision: RouterDecision,
    active_prompt_id: string,
    observed_at: number,
  ): Promise<AdvanceResult> {
    // BUG 1 FIX (onboarding-opening-fix, 2026-06-19) — signup auto-advance
    // on a non-`advance` classification. Production wires
    // `phaseSpecResolver` + `llmRouter`, and
    // `PACK_SIGNUP.advance_examples` was empty, so the router routinely
    // classified a bare typed name ("Ryan") as `amend` (it volunteers a
    // fact) or a low-confidence `answer` rather than `advance`. On signup
    // those fell to the generic amend/answer tails, which persisted
    // `user_first_name` but RE-EMITTED + STAYED on signup → the
    // double-ask. Signup is a single free-text question whose ONLY job is
    // to capture the name; once we have a valid name (from the whitelisted
    // `state_delta`, a value already persisted, or extractable from the
    // freeform), advancing IS the correct outcome regardless of the
    // router's action label. Route through the SAME `consumeChoice` path
    // the working `advance` branch + the test use, so the
    // signup→instance_provisioned→ai_substrate_offered cascade fires.
    // Returns null (fall through to the normal amend/answer handling) when
    // there is no name signal — so a genuine tangent ("why do you need my
    // name?") still gets its FAQ answer and an unparseable reply still hits
    // the clarify-reprompt guard inside consumeChoice.
    if (
      state.phase === 'signup' &&
      (decision.action === 'amend' || decision.action === 'answer')
    ) {
      const signupAdvance = await this.tryAdvanceSignupFromRouter(
        input,
        state,
        spec,
        decision,
        active_prompt_id,
        observed_at,
      )
      if (signupAdvance !== null) return signupAdvance
    }
    if (decision.action === 'advance') {
      // DECISION doc Part 2 — input-preserving fallback. A `synthesised`
      // advance is NOT a real classification: it is the escape hatch returned
      // by `synthesiseFallback` when the LLM call failed entirely (Haiku
      // timeout or unparseable output, with NO Sonnet escalation as of Part 1).
      // Blind-advancing here would force-fit the user's text as a
      // `__freeform__` advance of the CURRENT phase, silently discarding their
      // real intent (an `amend`/`answer` becomes a wrong advance — the root
      // cause of "the agent ignores what I type"). Instead we:
      //   1. preserve the user's text by appending it to the transcript (so the
      //      next, now-warm, turn re-classifies with full context),
      //   2. send a brief "say it again" re-prompt,
      //   3. re-emit the current keyboard and stay on phase.
      // Real (non-synthesised) advances fall through unchanged below.
      if (decision.synthesised !== undefined) {
        if (input.freeform_text !== undefined && input.freeform_text.length > 0) {
          this.deps.transcript.append({
            role: 'user',
            body: input.freeform_text,
            phase: state.phase,
          })
        }
        await this.sendAgentText(
          input,
          state.phase,
          `One sec — I didn't quite catch that. Mind saying it again?`,
          observed_at,
        )
        // Safety net (2026-06-06) — re-emit the live prompt with a FRESH
        // prompt_id (when it carries buttons) so the keyboard renders at
        // the bottom; the stale-prompt-id `reEmitKeyboard` would dedupe to
        // nothing on the web client. Falls back to reEmitKeyboard for
        // options-less freeform phases.
        const fresh = await this.reEmitCurrentPhasePromptFresh(
          input,
          state,
          active_prompt_id,
          observed_at,
        )
        return {
          outcome: 'reemitted_current',
          state: fresh.state,
          prompt_id: fresh.prompt_id,
        }
      }
      if (decision.response !== null && decision.response.length > 0) {
        await this.sendAgentText(input, state.phase, decision.response, observed_at)
      }
      // Hybrid amend+advance (§ 2.3 — envelope-conformance round 2). A real
      // advance MAY carry a non-empty `state_delta` when the user's reply both
      // answers the phase question AND records facts (canonical case:
      // import_analysis_presented — "I'm working on Northwind, Acme, a book"
      // advances the review step AND populates primary_projects/non_work_interests).
      // The whitelisted delta is merged into phase_state INSIDE consumeChoice,
      // AFTER buttonStore.resolve computes was_new — so the idempotency barrier
      // gates it. A duplicate/redelivered inbound that the dedup swallows must
      // NOT re-run the merge (it would bump last_advanced_at + replay
      // user_supplied_corrections[] on a turn that never reaches the user). The
      // merge still lands BEFORE the per-phase handler's required-fields audit
      // (e.g. consumeImportAnalysisPresentedChoice) so it sees the recorded
      // fields and routes correctly. Uses the SAME whitelist discipline as the
      // amend branch (no bookkeeping-column writes). Argus r2-round2 [IMPORTANT].
      const synth: ButtonChoice = {
        prompt_id: active_prompt_id,
        choice_value:
          decision.choice_value !== null && decision.choice_value.length > 0
            ? decision.choice_value
            : '__freeform__',
        freeform_text: decision.freeform_text ?? input.freeform_text ?? '',
        chosen_at: observed_at,
        speaker_user_id: input.user_id,
        channel_kind: input.channel_kind,
      }
      // GAP1 LIVE-PATH FIX (onboarding-wow-handoff-fix r3, 2026-06-09 — Argus
      // r2 BLOCKER). The capture path on a REVIEW/CORRECTION phase
      // (canonically import_analysis_presented) is THIS router `state_delta`.
      // (The older drain-based GAP1 merge in consumeProjectsProposedChoice
      // ran only on the `promptDriver` extraction seam, which production never
      // wired and which was removed in the 2026-06-21 consolidation — the
      // router `state_delta` is now the single capture path.)
      // On a confirm/restate *advance* ("go with
      // A, B, C, D, E") the router's extracted `primary_projects` routinely
      // ANCHORS to the proposed list and DROPS the user's net-new additions,
      // returning a SHORTER set; consumeChoice → whitelistRouterStateDelta then
      // PLAIN-OVERWRITES the seeded list with it (patch[k]=v). That is the exact
      // 7→3 shrink Sam hit on his 2026-06-09 signup (seeded 7, shelled 3).
      // An advance is a CONFIRM — never a removal (removals arrive as an `amend`
      // "drop X" below, which intentionally keeps the overwrite so the drop is
      // honored) — so the merge is purely ADDITIVE: union the router's picks
      // with the already-seeded `primary_projects` so a confirm can only ADD,
      // never silently shrink. `autoConfirmProjectsProposedAndAdvance` later
      // copies `primary_projects` → `primary_projects_confirmed` → wow
      // `03-project-shells`, so preserving the full list HERE is what gets ALL
      // selected projects their shells.
      const advance_state_delta = this.mergeAdvanceProjectsAdditively(
        decision.state_delta,
        state.phase_state as Record<string, unknown>,
      )
      return await this.consumeChoice(
        input,
        state,
        spec,
        synth,
        observed_at,
        advance_state_delta,
      )
    }

    if (decision.action === 'answer') {
      // Always append the user's inbound to the transcript so the
      // router has it on the next call. The v2 path does this via
      // consumeChoice → buttonStore.resolve; the answer branch never
      // reaches there.
      if (input.freeform_text !== undefined && input.freeform_text.length > 0) {
        this.deps.transcript.append({
          role: 'user',
          body: input.freeform_text,
          phase: state.phase,
        })
      }
      // Safety net (2026-06-06; brief — llm-router.ts ~1326 parse-fail
      // nudge). A SYNTHESISED answer is the parse-fail / timeout fallback,
      // whose canned text ("…tap one of the buttons above?") points at
      // scrolled-away buttons. Replace it with the brief tweak-later line
      // and re-render the live prompt with a fresh prompt_id. A genuine
      // (non-synthesised) answer keeps its real response text (FAQ
      // deflection) and ALSO gets a fresh keyboard re-emit so the buttons
      // are tappable instead of deduped-away by the client.
      const responseText =
        decision.synthesised !== undefined
          ? BUTTONS_ONLY_NUDGE_TEXT
          : decision.response
      if (responseText !== null && responseText.length > 0) {
        await this.sendAgentText(input, state.phase, responseText, observed_at)
      }
      const fresh = await this.reEmitCurrentPhasePromptFresh(
        input,
        state,
        active_prompt_id,
        observed_at,
      )
      return {
        outcome: 'reemitted_current',
        state: fresh.state,
        prompt_id: fresh.prompt_id,
      }
    }

    // decision.action === 'amend' — TS-narrowed by the discriminated
    // RouterAction union; the parser rejects any other value.

    // Gate-collapse (#92, 2026-06-05) — kill the amend dead-screen at
    // `import_analysis_presented`. A bare `amend` on this review phase
    // previously merged the correction, emitted an ack, then RE-EMITTED
    // the SAME (client-deduped) keyboard and STAYED on the phase: the ack
    // bubble showed but nothing advanced and the prompt_id was unchanged,
    // so the web client (which dedupes by prompt_id) rendered nothing —
    // the "dead screen" Sam hit on his 2026-06-05 signup ("anything I
    // missed?" → corrected the list → screen silently waited). Per his
    // verbatim directive ("ideally just move straight on to the next
    // step"), a correction at this single content-review gate should
    // APPLY and AUTO-ADVANCE. We route a bare amend here through the
    // EXACT same hybrid amend+advance tail the `advance` branch uses:
    // build a synthetic `__freeform__` choice carrying the user's reply +
    // the router's `state_delta`, then call `consumeChoice`, which merges
    // the whitelisted delta into phase_state FIRST (same
    // `whitelistRouterStateDelta` discipline) and hands off to
    // `consumeImportAnalysisPresentedChoice` → `auditRequiredFields` →
    // advance to `personality_offered` / `work_interview_gap_fill`. The
    // ack text is preserved (sent first when the router supplied one);
    // the next-phase prompt is the visible continuation that clears the
    // typing indicator, so no separate fallback ack is needed. Scoped to
    // this one phase — every other phase keeps the legacy stay-on-amend
    // behaviour (e.g. import_upload_pending source-switch below).
    if (state.phase === 'import_analysis_presented') {
      if (decision.response !== null && decision.response.length > 0) {
        await this.sendAgentText(input, state.phase, decision.response, observed_at)
      }
      const synth: ButtonChoice = {
        prompt_id: active_prompt_id,
        choice_value:
          decision.choice_value !== null && decision.choice_value.length > 0
            ? decision.choice_value
            : '__freeform__',
        freeform_text: decision.freeform_text ?? input.freeform_text ?? '',
        chosen_at: observed_at,
        speaker_user_id: input.user_id,
        channel_kind: input.channel_kind,
      }
      return await this.consumeChoice(
        input,
        state,
        spec,
        synth,
        observed_at,
        decision.state_delta,
      )
    }

    // ISSUES #117 — projects_proposed list-review edit (prod-wired GAP1 union).
    // A freeform "drop X / add Y" edit the router classifies as a bare `amend`
    // (a correction that does NOT complete the review — the user still has to
    // tap "Good to go") on the POPULATED projects_proposed list reaches HERE
    // via the interaction-mode override in `normalAdvance`. The generic amend
    // tail below `whitelistRouterStateDelta`-PLAIN-OVERWRITES `primary_projects`
    // with the router's extraction; when that extraction ANCHORS to a SHORTER
    // subset (the 7→3 shrink) the seeded additions are silently lost and the
    // `removed_projects` signal is whitelist-stripped. Apply the SAME additive
    // union as the `advance` branch (`mergeAdvanceProjectsAdditively`): union the
    // router's adds onto the seeded `primary_projects` and subtract explicit
    // `removed_projects` — so the edit can only ADD, never silently shrink, and
    // a named drop is honored. STAY on the phase (it is a confirm gate) and
    // re-emit a FRESH prompt: `buildProjectsProposedPromptSpec` ENUMERATES the
    // list in the body, so a bare `reEmitKeyboard` (same prompt_id) would re-
    // send the STALE pre-edit list. `autoConfirmProjectsProposedAndAdvance`
    // later copies `primary_projects` → `primary_projects_confirmed` → wow
    // shells, so the merged list HERE is what gets every kept project a shell.
    if (state.phase === 'projects_proposed') {
      if (input.freeform_text !== undefined && input.freeform_text.length > 0) {
        this.deps.transcript.append({
          role: 'user',
          body: input.freeform_text,
          phase: state.phase,
        })
      }
      const merged_delta = this.mergeAdvanceProjectsAdditively(
        decision.state_delta,
        state.phase_state as Record<string, unknown>,
      )
      const patch = this.whitelistRouterStateDelta(
        merged_delta,
        state.phase,
        input.project_slug,
      )
      let updated = state
      if (Object.keys(patch).length > 0) {
        updated = await this.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: state.phase,
          phase_state_patch: patch,
          advanced_at: observed_at,
        })
      }
      // Ack first (router wording when present, generic floor otherwise) so the
      // user sees an acknowledgement before the re-rendered list re-emits.
      if (decision.response !== null && decision.response.length > 0) {
        await this.sendAgentText(input, state.phase, decision.response, observed_at)
      } else {
        await this.sendAgentText(
          input,
          state.phase,
          AMEND_ACK_FALLBACK_TEXT,
          observed_at,
        )
      }
      // Re-render the list body with the merged `primary_projects` — drop the
      // cached resolved spec warmed from the pre-edit list (mirrors the
      // share-freeform re-emit in consumeProjectsProposedChoice).
      this.invalidateResolvedSpec(input.project_slug, 'projects_proposed')
      let final_state: OnboardingState | null = null
      const emit = await this.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: 'projects_proposed',
        observed_at,
        // Argus r1 BLOCKER 1 (2026-06-10, #117 fix-round) — when the merged
        // list renders a body BYTE-IDENTICAL to an already-delivered prompt
        // (a no-op edit whose extraction ⊆ the seeded list, an oscillating
        // drop-then-re-add, or a non-project amend), the body+options seed
        // collapses onto the prior delivered row (was_new=false,
        // was_delivered=true) and `sendButtonPrompt` is SKIPPED — the user
        // gets the ack but never sees the re-rendered list (the web client
        // dedupes by prompt_id). Same idempotency bug class as #115/#116.
        // Fold observed_at into the seed (mirrors the sibling
        // `switched_source` re-emit below) so every edit forces a fresh
        // delivered row; a same-inbound retry reuses the same observed_at
        // and still dedupes.
        seed_suffix: `projects_edit:${observed_at}`,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await this.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: 'projects_proposed',
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final_state === null) {
        final_state =
          (await this.deps.stateStore.get(input.project_slug, input.user_id)) ?? updated
      }
      return {
        outcome: 'reemitted_current',
        state: final_state,
        prompt_id: emit.prompt_id,
      }
    }

    if (input.freeform_text !== undefined && input.freeform_text.length > 0) {
      this.deps.transcript.append({
        role: 'user',
        body: input.freeform_text,
        phase: state.phase,
      })
    }
    // P2-v3 S2 — Argus r2 [BLOCKING #2]: whitelist amend keys before
    // they reach the state store. A TS cast on `Partial<RequiredFieldsState>`
    // is compile-time only — an adversarial LLM amend could write
    // bookkeeping columns (created_at, owner_id, ...) into
    // phase_state_json via state_delta. The router has no business
    // touching anything outside the per-design § 4 surface, so we
    // reject everything else here and log the rejected keys for the
    // operator. See ROUTER_AMEND_ALLOWED_KEYS for the canonical set.
    // Shared with the hybrid amend+advance merge in the `advance` branch
    // above (envelope-conformance round 2) — same whitelist discipline.
    const patch = this.whitelistRouterStateDelta(
      decision.state_delta,
      state.phase,
      input.project_slug,
    )
    const updated = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: state.phase,
      phase_state_patch: patch,
      advanced_at: observed_at,
    })
    // freeform-intent-spec.md (2026-06-03) — source-switch re-render.
    // When an amend on `import_upload_pending` changes `ai_substrate_used`
    // to a DIFFERENT valid source, the user asked to upload from a
    // different service ("actually can I upload Claude instead"). The
    // generic `reEmitKeyboard` below would re-send the STALE keyboard
    // (old source's instructions); instead we invalidate the cached
    // dynamic spec and emit a fresh `import_upload_pending` prompt so the
    // body now renders the NEW source's download steps. This is the fix
    // for the 2026-06-03 onboarding incident (the switch was mis-routed
    // to `advance` → import_running, leaving the jobs table empty).
    //
    // Computed BEFORE the ack emit below (Argus #3, 2026-06-05): the
    // fresh import_upload_pending re-render IS the acknowledgement on the
    // switch path, so the `AMEND_ACK_FALLBACK_TEXT` floor must be
    // suppressed there to avoid a double-message.
    const prior_source = state.phase_state['ai_substrate_used']
    const new_source = patch['ai_substrate_used']
    const switched_source =
      state.phase === 'import_upload_pending' &&
      typeof new_source === 'string' &&
      ROUTER_AMEND_SUBSTRATE_VALUES.has(new_source) &&
      new_source !== prior_source
    if (decision.response !== null && decision.response.length > 0) {
      await this.sendAgentText(input, state.phase, decision.response, observed_at)
    } else if (!switched_source) {
      // 2026-06-05 (amend-redisplay typing-indicator fix) — when the router
      // classifies a freeform reply as `amend` (e.g. "also add a Sound
      // Ceremony project" at import_analysis_presented) but returns NO
      // `response` text, the only emit below is `reEmitKeyboard`, which
      // re-sends the STORED prompt with the SAME `prompt_id`. The web client
      // dedupes by `prompt_id` (`renderedPromptIds`) → renders nothing → the
      // optimistic typing indicator hangs forever, though the state_delta
      // merge above DID persist (the analysis silently updated). Emit a
      // generic acknowledgement with a FRESH `prompt_id` (sendAgentText folds
      // `router_text:<phase>:<observed_at>` into the idempotency seed) so the
      // client renders something and clears the indicator. The router's own
      // `response` (when present) already supplies the specific wording
      // ("Added Studio Sessions to your projects."); this is the floor.
      //
      // Argus #3 (2026-06-05) — GATED to the non-switched path. On a
      // source switch the fresh `import_upload_pending` emit below renders
      // a brand-new prompt (the real acknowledgement), so adding this
      // generic ack on top double-messages the user. The bug was latent —
      // masked by `describe.skip` + non-null `response` fixtures — until a
      // `response:null` + source-switch reply hit both branches.
      await this.sendAgentText(input, state.phase, AMEND_ACK_FALLBACK_TEXT, observed_at)
    }
    if (switched_source) {
      this.invalidateResolvedSpec(input.project_slug, 'import_upload_pending')
      let final_state: OnboardingState | null = null
      const emit = await this.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: 'import_upload_pending',
        observed_at,
        // Argus r1 BLOCKER (2026-06-03) — on a switch-BACK oscillation
        // (chatgpt → claude → chatgpt) the chatgpt instructions body is
        // BYTE-IDENTICAL to the earlier chatgpt emit, so without a
        // distinguishing seed the idempotency key collapses onto the
        // prior delivered row (was_new=false, was_delivered=true) and
        // `sendButtonPrompt` is SKIPPED — the user gets the ack but no
        // re-pushed upload affordance. Fold the new source + observed_at
        // into the seed so every switch forces a fresh delivered row.
        seed_suffix: `switch:${new_source}:${observed_at}`,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await this.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: 'import_upload_pending',
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final_state === null) {
        final_state = (await this.deps.stateStore.get(
          input.project_slug,
          input.user_id,
        )) as OnboardingState
      }
      return {
        outcome: 'reemitted_current',
        state: final_state,
        prompt_id: emit.prompt_id,
      }
    }
    await this.reEmitKeyboard(input, updated, active_prompt_id, observed_at)
    return {
      outcome: 'reemitted_current',
      state: updated,
      prompt_id: active_prompt_id,
    }
  }

  /**
   * Sprint 2026-06-03 (onboarding-buttons-only-tweak-later) — emit the
   * canned "tap a button" nudge for a buttons-only phase (or a mixed
   * phase whose freeform didn't match a declared text-input field).
   *
   * Records the user's text in the transcript (so it isn't lost), sends
   * the message as a plain agent line via `sendAgentText`, and returns
   * WITHOUT advancing the phase, WITHOUT rotating `active_prompt_id`, and
   * WITHOUT calling the LLM router. The keyboard from the prior emit
   * stays the live anchor — `sendAgentText` intentionally does not
   * persist its own prompt_id — so the user can still tap a button. The
   * brief (§ 4) is explicit that we must NOT restate the phase prompt
   * here.
   *
   * `message_override` (Argus r5 BLOCKER, 2026-06-03): when a mixed
   * phase's canonical validator produced a specific reason
   * (agent_name_chosen → validateAgentName), pass it here so the user
   * sees the real, recoverable error instead of `BUTTONS_ONLY_NUDGE_TEXT`
   * — which references buttons that don't exist on `agent_name_chosen`
   * (it emits `options:[]`). Null/undefined/empty → the canned nudge.
   */
  private async emitButtonsOnlyNudge(
    input: AdvanceInput,
    state: OnboardingState,
    active_prompt_id: string,
    observed_at: number,
    message_override?: string | null,
  ): Promise<AdvanceResult> {
    if (input.freeform_text !== undefined && input.freeform_text.length > 0) {
      this.deps.transcript.append({
        role: 'user',
        body: input.freeform_text,
        phase: state.phase,
      })
    }
    // Resolve the live spec FIRST so the nudge COPY matches the rendered
    // button state. Served from the per-instance resolved-spec cache, so
    // the resolve is effectively free.
    const liveSpec = await this.resolvePhasePromptSpec(
      input.project_slug,
      input.user_id,
      state.phase,
    )
    const liveHasButtons = liveSpec !== null && liveSpec.options.length > 0
    // BUG 2 FIX (onboarding-opening-fix, 2026-06-19) — never ship the
    // "tap one of the buttons above" copy when there are NO buttons to
    // render. `BUTTONS_ONLY_NUDGE_TEXT` promises buttons; if the resolved
    // spec came back option-stripped (the materializeSpec hardening below
    // restores static options for option-bearing phases, but a phase that
    // legitimately resolves option-less must not strand the user), fall
    // back to the button-free `NO_BUTTONS_FALLBACK_NUDGE_TEXT` so the
    // nudge copy matches reality. A `message_override` (a mixed phase's
    // recoverable validator reason, e.g. agent_name_chosen) always wins.
    const body =
      message_override !== undefined &&
      message_override !== null &&
      message_override.length > 0
        ? message_override
        : liveHasButtons
          ? BUTTONS_ONLY_NUDGE_TEXT
          : NO_BUTTONS_FALLBACK_NUDGE_TEXT
    await this.sendAgentText(input, state.phase, body, observed_at)
    // Safety net (2026-06-06, Sam real-signup; ISSUES #84) — THE fix for
    // the buttons-only dead-end. A bare text nudge points at buttons that
    // have scrolled away in history; the web client dedupes by prompt_id,
    // so re-sending the stored keyboard renders nothing. If the live phase
    // prompt carries button options, re-emit it in full — body + options —
    // with a FRESH prompt_id so the client renders the buttons at the
    // bottom. Phases that emit `options:[]` (agent_name_chosen, whose
    // `message_override` is a recoverable validator reason) keep the
    // text-only behavior — there are no buttons to render.
    //
    // This options-guard is NOT redundant with the same check inside
    // `reEmitCurrentPhasePromptFresh` (Argus r1 MINOR): that helper FALLS
    // BACK to `reEmitKeyboard` when options are empty, which would re-send
    // the stale buttonless prompt as a DUPLICATE message right after the
    // validator-reason text we just sent. Guarding here means an
    // options-less nudge returns text-only (no duplicate).
    if (liveHasButtons) {
      const fresh = await this.reEmitCurrentPhasePromptFresh(
        input,
        state,
        active_prompt_id,
        observed_at,
      )
      return { outcome: 'reemitted_current', state: fresh.state, prompt_id: fresh.prompt_id }
    }
    return { outcome: 'reemitted_current', state, prompt_id: active_prompt_id }
  }

  /**
   * Re-emit the CURRENT phase's prompt — full body + button options — with
   * a FRESH `prompt_id`, repointing `active_prompt_id` at it. This is the
   * shared mechanism behind the buttons-only safety net (Sam real-signup
   * 2026-06-06) and the router nudge re-render: the web client dedupes by
   * `prompt_id` (`renderedPromptIds`), so `reEmitKeyboard` (which re-sends
   * the SAME stored prompt_id) renders nothing and the buttons stay
   * scrolled away — a dead-end. A fresh prompt_id forces the client to
   * render the keyboard at the bottom. Mirrors the existing
   * "freeform on a non-freeform prompt" re-emit (advance() body) and the
   * AMEND_ACK / switched_source fresh-prompt-id pattern.
   *
   * When the live spec carries NO button options, falls back to
   * `reEmitKeyboard` (the legacy stored re-send) — there are no buttons to
   * re-render, and the genuinely-freeform phases (signup,
   * work_interview_gap_fill) must not gain a spurious body re-render.
   *
   * The wall-clock `observed_at` (`advance()` derives it from `this.now()`)
   * is folded into the `safety-net:<observed_at>` seed_suffix so each
   * re-emit lands on a fresh delivered row instead of collapsing onto the
   * prior one — the same de-collision trick the switched_source re-emit
   * uses. (Two re-emits within the same millisecond would still collapse;
   * that is acceptable — it only means the user double-tapped faster than
   * the clock ticks, and one render is the correct outcome there.)
   * `last_advanced_at` is deliberately PRESERVED (not bumped): the user is
   * stuck, and the gap is the watchdog's stall signal — a safety-net
   * re-emit must not erase it (same rationale as `emitResumePrompt`).
   */
  private async reEmitCurrentPhasePromptFresh(
    input: AdvanceInput,
    state: OnboardingState,
    active_prompt_id: string,
    observed_at: number,
  ): Promise<{ prompt_id: string; state: OnboardingState }> {
    const liveSpec = await this.resolvePhasePromptSpec(
      input.project_slug,
      input.user_id,
      state.phase,
    )
    if (liveSpec === null || liveSpec.options.length === 0) {
      await this.reEmitKeyboard(input, state, active_prompt_id, observed_at)
      return { prompt_id: active_prompt_id, state }
    }
    let updated: OnboardingState | null = null
    const emit = await this.emitPhasePrompt({
      project_slug: input.project_slug,
      user_id: input.user_id,
      topic_id: input.topic_id,
      phase: state.phase,
      observed_at,
      seed_suffix: `safety-net:${observed_at}`,
      pre_send_state_upsert: async (prompt_id: string) => {
        updated = await this.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: state.phase,
          phase_state_patch: { active_prompt_id: prompt_id, topic_id: input.topic_id },
          // Preserve the stall signal — do NOT bump last_advanced_at.
          advanced_at: state.last_advanced_at,
        })
      },
    })
    if (updated === null) {
      updated = (await this.deps.stateStore.get(
        input.project_slug,
        input.user_id,
      )) as OnboardingState
    }
    return { prompt_id: emit.prompt_id, state: updated }
  }

  /**
   * ISSUES #98 (Argus r1b MINOR) — reconcile `source_switch_intent` from a
   * freeform typed at `ai_substrate_offered` (the source picker), so a stale
   * intent recorded by the earlier reroute does not wrongly refuse the user's
   * in-flight upload.
   *
   * Mirrors the reroute's set/clear semantics exactly
   * (`reEmitImportSourceSelection`): the intent is the source the user named
   * when it DIFFERS from the staged `ai_substrate_used`, else `null`. A
   * freeform that re-affirms the staged source ("no, keep chatgpt") therefore
   * CLEARS the stale intent; one that names the other source UPDATES it. A
   * freeform that names NO source (or names both) leaves the recorded intent
   * untouched — "is it done?" must not silently clear a genuine switch.
   *
   * Returns the (possibly updated) state so the caller nudges against fresh
   * phase_state.
   */
  async reconcileSwitchIntentFromFreeform(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<OnboardingState> {
    return importRoutingReconcileSwitchIntentFromFreeform(this, input, state, observed_at)
  }

  /**
   * ISSUES #84 (2026-06-06, Sam real-signup) — re-offer the import-source
   * SELECTION buttons (ChatGPT/Claude/Neither) when the user types a
   * source-switch intent at `import_upload_pending`. Parks the session on
   * `ai_substrate_offered` and emits its 3-button prompt with a FRESH
   * prompt_id so a tap re-runs the normal source-selection consume path
   * (which advances forward again with the new source's upload
   * instructions). Reuses the tested ai_substrate_offered handler rather
   * than inventing a new consume branch at import_upload_pending.
   *
   * NON-DESTRUCTIVE re-emit (Argus r2, 2026-06-06): this path does NOT
   * clear `ai_substrate_used` or `uploads_received`. Re-showing the source
   * buttons is the entire point of the safety net and must NEVER lose a
   * completed upload. The actual reset lives in the CONSUME handler
   * (`advanceFromAiSubstrateOfferedToUpload`), so it fires ONLY when the
   * user genuinely TAPS a source button — a deliberate re-pick starts
   * clean, while a re-display the user ignores (or a detector false
   * positive) preserves the prior upload by construction. This closes the
   * r1/r2 silent-data-loss hole independent of detector precision: the
   * worst case is a harmless re-display, never a wipe.
   *
   * Unlike `reEmitCurrentPhasePromptFresh` (which PRESERVES
   * `last_advanced_at` because the user is stuck and the gap is the
   * watchdog's stall signal), this path BUMPS `advanced_at` to
   * `observed_at`: a deliberate source switch IS real forward motion (the
   * session is leaving import_upload_pending for a fresh ai_substrate_offered
   * prompt), so the stall clock should reset — matching the switched_source
   * re-emit in the router branch.
   */
  async reEmitImportSourceSelection(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult> {
    return importRoutingReEmitImportSourceSelection(this, input, state, observed_at)
  }

  /**
   * Send a plain-text agent message via the same `sendButtonPrompt`
   * channel adapter used by the rest of the engine. The message is
   * encoded as a transient freeform-only `ButtonPrompt` (no options,
   * `allow_freeform=true`) so both the Telegram and web channels render
   * it as text. The new prompt_id is intentionally NOT persisted onto
   * `phase_state.active_prompt_id` — the existing active prompt's
   * keyboard remains the canonical "what should the user tap?" anchor.
   *
   * Mirrors the discipline in `emitPhasePrompt` (idempotency via
   * `deriveIdempotencyKey`) so a duplicate router call with the same
   * response body collapses to one rendered message.
   */
  async sendAgentText(
    input: AdvanceInput,
    phase: OnboardingPhase,
    body: string,
    observed_at: number,
  ): Promise<void> {
    const seed = canonicalPromptSeed({ body, options: [] })
    const idempotency_key = deriveIdempotencyKey({
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      seed: `router_text:${phase}:${observed_at}:${seed}`,
    })
    const prompt = buildButtonPrompt({
      body,
      options: [],
      allow_freeform: true,
      idempotency_key,
      uuid: this.uuid,
    })
    const emit = await this.deps.buttonStore.emit(prompt, { topic_id: input.topic_id })
    if (emit.was_new || !emit.was_delivered) {
      try {
        const sendResult = await this.deps.sendButtonPrompt({
          project_slug: input.project_slug,
          topic_id: input.topic_id,
          prompt: emit.prompt,
        })
        if (sendResult.was_new) {
          await this.deps.buttonStore.markDelivered(emit.prompt_id, this.now())
          this.deps.transcript.append({
            role: 'agent',
            body,
            phase,
            button_prompt_id: emit.prompt_id,
          })
        }
      } catch (err) {
        // A send failure on the router's ack is recoverable — the
        // engine has not advanced state and the user can retry. Log
        // and continue so the engine still returns a meaningful
        // AdvanceResult.
        console.warn(
          `[engine.sendAgentText] project=${input.project_slug} phase=${phase} send failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  /**
   * Re-render the active prompt's keyboard. Fetches the persisted
   * ButtonPrompt for `active_prompt_id` via ButtonStore.get(...) and
   * re-sends it through the channel adapter. The body has already been
   * rendered earlier; this is the "the keyboard should still be the
   * thing you tap" refresh used by the answer + amend router branches
   * (per design § 2.3 step 3).
   */
  private async reEmitKeyboard(
    input: AdvanceInput,
    state: OnboardingState,
    active_prompt_id: string,
    observed_at: number,
  ): Promise<void> {
    const stored = await this.deps.buttonStore.get(active_prompt_id, observed_at)
    if (stored === null) return
    try {
      await this.deps.sendButtonPrompt({
        project_slug: input.project_slug,
        topic_id: input.topic_id,
        prompt: stored,
      })
    } catch (err) {
      console.warn(
        `[engine.reEmitKeyboard] project=${input.project_slug} phase=${state.phase} re-send failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private async consumeChoice(
    input: AdvanceInput,
    state: OnboardingState,
    spec: (typeof STATIC_PHASE_SPECS)[string],
    choice: ButtonChoice,
    observed_at: number,
    routerStateDelta: RouterDecision['state_delta'] = null,
  ): Promise<AdvanceResult> {
    // Resolve the active prompt via ButtonStore for idempotency — duplicate
    // callbacks return was_new=false and the resolved-prior choice.
    let resolved: { was_new: boolean; choice: ButtonChoice }
    try {
      const r = await this.deps.buttonStore.resolve({ choice })
      resolved = { was_new: r.was_new, choice: r.choice }
    } catch (err) {
      throw new InterviewError(
        state.phase,
        'unknown_prompt',
        true,
        `failed to resolve prompt for project=${input.project_slug} phase=${state.phase}`,
        err,
      )
    }
    const choice_value = resolved.choice.choice_value

    // Hybrid amend+advance merge (§ 2.3 — envelope-conformance round 2). A
    // router `advance` may carry a whitelisted state_delta; merge it into
    // phase_state HERE — downstream of buttonStore.resolve so the idempotency
    // barrier gates it. `was_new=false` means a duplicate/redelivered inbound
    // that the dedup swallows: re-merging would bump last_advanced_at and
    // replay user_supplied_corrections[] on a turn that never reaches the user,
    // so we skip it. On a genuine (was_new) advance the merge lands before every
    // per-phase handler below, so each handler's required-fields audit sees the
    // recorded fields. Same whitelist discipline as the amend branch (no
    // bookkeeping-column writes). Argus r2-round2 [IMPORTANT].
    if (routerStateDelta !== null && resolved.was_new) {
      const patch = this.whitelistRouterStateDelta(
        routerStateDelta,
        state.phase,
        input.project_slug,
      )
      if (Object.keys(patch).length > 0) {
        state = await this.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: state.phase,
          phase_state_patch: patch,
          advanced_at: observed_at,
        })
      }
    }

    // P1.5 / Sprint 21 — slug_chosen branch. The user just resolved the
    // slug-picker prompt. Route through the slug-picker hook BEFORE
    // walking the phase machine so a `rejected` outcome keeps us at
    // slug_chosen with a re-prompt instead of advancing.
    if (state.phase === 'slug_chosen') {
      return await this.consumeSlugChosenChoice(input, state, resolved.choice, resolved.was_new, observed_at)
    }

    // T4 (2026-05-13) — import_offered branch. The user is picking a
    // history-import source (`chatgpt_zip` / `claude_zip` / `skip`).
    // Each substrate option has its own follow-up shape (kick off the
    // runner + advance to `import_running`); skip routes past to
    // `archetype_picked`. We own the routing BEFORE the generic
    // next_phase_on_default flow so the runner.start side-effect is
    // never skipped. Per docs/plans/P2-onboarding.md § 2.3 + § 4.7.
    if (state.phase === 'ai_substrate_offered') {
      return await this.consumeAiSubstrateOfferedChoice(
        input,
        state,
        resolved.choice,
        resolved.was_new,
        observed_at,
      )
    }

    // Deploy-window robustness (remove-both-import-option, 2026-06-06): a
    // instance parked at `import_upload_pending` with a STALE
    // `ai_substrate_used='both'` (from the removed two-upload flow) who
    // already staged ONE zip on disk and then taps/types `skip` AFTER this
    // release must NOT fall through to the generic skip → work_interview_gap_fill
    // route, which would silently discard the uploaded zip. The old 'both'
    // graceful-skip branch (ISSUES #85) that handled this was deleted with
    // the flow; this mirrors it for the stale deploy-window shape — symmetric
    // with the stale-'both' source-screen *tap* recovery in
    // consumeAiSubstrateOfferedChoice (commit 69f28ef). Treat the single
    // staged upload as the chosen source and advance to import_running:
    // self-healing, no data loss (the zip is on disk). The signal is
    // `uploads_received` (only ever written by the now-removed 'both' flow);
    // a normal single-source pick advances out of import_upload_pending on
    // upload, so the only way to be HERE with a staged upload is the stale
    // deploy-window case. Every other skip (no upload staged) falls through
    // to the standard skip → gap-fill path below.
    if (
      state.phase === 'import_upload_pending' &&
      resolved.choice.choice_value === 'skip'
    ) {
      const ps = state.phase_state as Record<string, unknown>
      const received = (readStringArray(ps, 'uploads_received') ?? []).filter(
        (s): s is 'chatgpt' | 'claude' => s === 'chatgpt' || s === 'claude',
      )
      // Argus r2 belt-and-suspenders: only treat a staged upload as the
      // chosen source when it is CONSISTENT with `ai_substrate_used`. The
      // PRIMARY fix (advanceFromAiSubstrateOfferedToUpload) already clears
      // `uploads_received` when a re-pick switches to a different single
      // source, so a mismatch shouldn't survive — but if a stale single
      // `ai_substrate_used` ever diverges from the staged zip (user moved
      // AWAY from that source), importing it would violate the user's
      // switch + the Skip. Permit the recovery only when the staged source
      // matches the recorded substrate, when the substrate is the stale
      // 'both' (the original deploy-window shape — single zip staged under
      // the removed two-upload flow), or when no substrate is recorded.
      // Any concrete single substrate that DIFFERS from the staged source
      // falls through to the standard skip → gap-fill path.
      const recordedSubstrate = readString(ps, 'ai_substrate_used')
      const staged_is_consistent =
        received.length >= 1 &&
        (recordedSubstrate === null ||
          recordedSubstrate === 'both' ||
          recordedSubstrate === received[0])
      if (staged_is_consistent) {
        const effectiveSource = received[0] as 'chatgpt' | 'claude'
        if (resolved.was_new) {
          this.deps.transcript.append({
            role: 'user',
            body: 'skip',
            phase: state.phase,
            button_prompt_id: resolved.choice.prompt_id,
            button_choice: 'skip',
          })
        }
        this.deps.transcript.append({
          role: 'system',
          body: `import: deploy-window skip with staged upload(s) [${received.join(',')}] (stale ai_substrate_used=${readString(ps, 'ai_substrate_used') ?? 'unknown'}); importing ${effectiveSource} rather than dropping the staged zip to gap-fill`,
          phase: state.phase,
        })
        return await this.startImportAndAdvanceToRunning(
          input,
          state,
          observed_at,
          effectiveSource,
        )
      }
    }

    // T4 (2026-05-13), simplified v0.1.78 (2026-05-22) — import_running
    // branch. After the budget-cap kill the only button-carrying shape
    // is the `failed` sub_step (retry/skip); status + rate_limit_paused
    // are freeform-only and route through the __freeform__ branch.
    if (state.phase === 'import_running') {
      return await this.consumeImportRunningChoice(
        input,
        state,
        resolved.choice,
        resolved.was_new,
        observed_at,
      )
    }

    // P2 v2 § 2.4 + § 3.7 / S5 — import_analysis_presented branch. The
    // user is replying freeform to "anything important I missed?"
    // (corrections + additions). We capture the reply into
    // `phase_state.user_supplied_corrections[]`, then run the
    // required-fields audit. The audit's priority order is
    // (user_first_name, primary_projects, non_work_interests,
    // agent_personality, agent_name) — the first three are filled by
    // import + this gap-fill step; the last two are collected at
    // later phases. So routing is "are the first three filled?":
    //   - yes (audit's next_to_collect ∈ {null, agent_personality,
    //     agent_name}) → advance to `personality_offered`
    //   - no  → advance to `work_interview_gap_fill` so S6 can drive
    //     the LLM-picked single-question gap-fill loop
    if (state.phase === 'import_analysis_presented') {
      return await this.consumeImportAnalysisPresentedChoice(
        input,
        state,
        resolved.choice,
        resolved.was_new,
        observed_at,
      )
    }

    // P2 v2 § 2.4 + § 3.8 / S6 — work_interview_gap_fill self-loop.
    // The user is replying freeform to whatever question the LLM
    // surfaced last turn (targeting the highest-priority missing
    // required field). The handler:
    //   1. appends the user reply to transcript
    //   2. resolves the next spec → LLM extracts whatever the user
    //      volunteered into ExtractedFields
    //   3. merges (append-not-overwrite for arrays) into phase_state
    //   4. re-runs auditRequiredFields() over the merged view
    //   5. advances to `personality_offered` when the first three
    //      required fields are all filled
    //   6. otherwise stays on `work_interview_gap_fill` and re-emits
    //      with a fresh LLM-picked question (next iteration)
    //   7. enforces a 5-iteration cap; cap-hit with missing required
    //      fields routes to `phase='failed'` per spec § 3.8 +
    //      § 12 trapdoor fix (NO synthetic-placeholder paths)
    if (state.phase === 'work_interview_gap_fill') {
      return await this.consumeWorkInterviewGapFillChoice(
        input,
        state,
        resolved.choice,
        resolved.was_new,
        observed_at,
      )
    }

    // 2026-05-13 — T3 max_oauth_offered branch. The user is picking
    // a substrate (attach Max, BYO key, or skip). Each option has its
    // own follow-up shape (Max needs a Done-tap, BYO needs a paste,
    // skip just advances) so we own the routing here BEFORE the
    // generic next_phase_on_default flow advances to wow_fired on every
    // choice.
    if (state.phase === 'max_oauth_offered') {
      return await this.consumeMaxOauthChoice(input, state, resolved.choice, resolved.was_new, observed_at)
    }

    // P2 v2 § 2.10 — profile_pic phase is removed from the v2 enum.
    // The Sprint 28 image-gallery picker stays on disk (handlers /
    // hooks) but is now unreachable through the legal-transition table;
    // it returns when the Cores Image-gen substrate ships.

    // T1 (2026-05-13) — persona_reviewed branch. The user is either
    // tapping one of the [A][B][C] options on the review prompt, OR
    // they're inside one of the sub-flows (`pick_line`,
    // `pick_replacement`, `pending_regen_hint`) replying with freeform
    // text. Route through `consumePersonaReviewedChoice` so the engine
    // can call composer.applyEdit / composer.compose / composer.commit
    // without competing with the LLM-driven phase resolver.
    if (state.phase === 'persona_reviewed' && this.deps.personaComposer !== undefined) {
      return await this.consumePersonaReviewedChoice(
        input,
        state,
        resolved.choice,
        resolved.was_new,
        observed_at,
      )
    }

    // T1 (2026-05-13) — persona_synthesizing fallback branch. Only
    // reachable when the compose attempt threw `cringe_cap_exceeded`
    // (or another PersonaError) and the engine emitted the
    // Retry / Use basic template / Skip persona fallback prompt. The
    // handler routes each choice through composer.compose / a basic
    // template fallback / a skip-with-stub path so the user always has
    // a way forward.
    if (state.phase === 'persona_synthesizing' && this.deps.personaComposer !== undefined) {
      return await this.consumePersonaSynthesizingChoice(
        input,
        state,
        resolved.choice,
        resolved.was_new,
        observed_at,
      )
    }

    // T2 (2026-05-13) — wow_fired retry / skip branch. Only reachable
    // when a prior dispatch attempt threw and `emitWowFallbackPrompt`
    // staged the active_prompt_id. The user picks Try-again
    // (re-fires dispatch) or Skip (advances to completed with a
    // partial wow_report — null when no prior outcome landed).
    if (state.phase === 'wow_fired') {
      return await this.consumeWowFallbackChoice(
        input,
        state,
        resolved.choice,
        resolved.was_new,
        observed_at,
      )
    }

    // P2 v2 § 0 locked decision #9 + § 3.9 — `personality_offered` is a
    // free-text, single-handler phase. The user replies in natural
    // language describing the desired agent personality; the engine
    // captures it as a string on `phase_state.agent_personality` (+
    // mirrors via `personaSync.recordAgentPersonality`) and advances to
    // `agent_name_chosen`. Curated archetype blending happens later at
    // synthesis time inside `PersonaComposer.compose` via
    // `archetypes/compose.composeFromFreeText` — NOT here.
    if (state.phase === 'personality_offered') {
      return await this.consumePersonalityOfferedChoice(
        input,
        state,
        resolved.choice,
        resolved.was_new,
        observed_at,
      )
    }

    // P2 v2 § 3.10 / S7 — agent_name_chosen free-text path. Captures the
    // reply as `agent_name`, validates length / charset / reserved-name
    // list (per § 2.7), and on success derives `suggested_slug` +
    // advances to `slug_chosen`. On failure, stays + re-emits with a
    // rejection reason.
    if (state.phase === 'agent_name_chosen') {
      return await this.consumeAgentNameChosenChoice(
        input,
        state,
        resolved.choice,
        resolved.was_new,
        observed_at,
      )
    }

    // P2 v2 § 3.12 / S7 — projects_proposed path. Surfaces the collected
    // project list + handles the single confirm button + freeform tweaks
    // ("drop X", "rename Y", etc.) via the LLM-router amend pipeline.
    //
    // 2026-05-28 — the legacy [B] Review each one button is dropped; the
    // engine still defensively accepts the `review` choice value from
    // any stale in-flight prompt by treating it as confirm-equivalent.
    // The confirm path writes `primary_projects_confirmed[]` and
    // advances to `persona_synthesizing`.
    if (state.phase === 'projects_proposed') {
      return await this.consumeProjectsProposedChoice(
        input,
        state,
        resolved.choice,
        resolved.was_new,
        observed_at,
      )
    }

    // Argus r1 (2026-05-10) — append the user reply to the transcript
    // BEFORE asking the LLM driver for the next spec. The driver's
    // bundle reads `recent_turns` from the transcript; without this
    // ordering it would never see the latest user reply and could
    // not make an informed stay/advance decision.
    if (resolved.was_new) {
      const body =
        choice_value === '__freeform__' && resolved.choice.freeform_text !== undefined
          ? resolved.choice.freeform_text
          : choice_value
      this.deps.transcript.append({
        role: 'user',
        body,
        phase: state.phase,
        button_prompt_id: choice.prompt_id,
        button_choice: choice_value,
      })
    }

    // Resolve the prompt spec (LLM driver / phaseSpecResolver / static
    // fallback) and route via THAT spec's `next_phase_on_default`. The
    // static `spec` argument is still used for the freeform-allowance
    // gate in `normalAdvance`, but routing belongs to the LLM-driven
    // path so multi-turn phases (signup) can stay across user turns.
    // Argus r1 (2026-05-10) — the prior code used the static spec for
    // routing, which always advanced signup → name_chosen on the first
    // user reply.
    const drivenSpec = (await this.resolvePhasePromptSpec(input.project_slug, input.user_id, state.phase)) ?? spec
    let next_phase: OnboardingPhase = this.nextPhaseForMode(
      state.phase,
      drivenSpec.next_phase_overrides?.[choice_value] ?? drivenSpec.next_phase_on_default,
    )

    // 2026-05-12 (Bug C) — signup-advance name guard: if the user's
    // freeform reply doesn't yield a resolvable agent name AND no name
    // has been captured on a prior turn, do NOT advance off signup with
    // `agent_name = <persona prose>`. Override next_phase to stay at
    // signup; the stay-at-phase branch below re-emits the prompt.
    // resolvePhasePromptSpec reads `phase_state.clarify_name_reprompt`
    // and substitutes a clarifying body ("Got it. What should I call
    // you?") on this re-emit so the user sees a single-question
    // follow-up rather than the original persona-discovery question.
    //
    // Pre-fix: extractAgentNameFromFreeform's whole-reply fallback
    // meant the engine always advanced and seeded
    // `phase_state.agent_name = "a warm collaborator with Marcus
    // Aurelius vibes"`; the slug picker then suggested
    // `a-warm-collaborator-with-marcus-aurelius-vibes`. Argus r2 on
    // PR #71 flagged this; the fix lives in both the heuristic (now
    // returns null on persona-only replies) and here (the engine
    // honours the null by re-prompting).
    //
    // 2026-05-14 — T9: trigger condition is "advancing OUT of signup"
    // (next_phase !== state.phase), not the literal `next_phase ===
    // 'agent_name_chosen'`. Pre-T9 signup → name_chosen was the shortcut
    // route, so the guard checked for that target. Post-T9 signup
    // routes to `instance_provisioned` (auto-skipped) by default; the
    // guard MUST fire on any forward transition out of signup so the
    // name-extraction safety net still applies.
    let clarify_name_reprompt = false
    if (
      state.phase === 'signup' &&
      next_phase !== state.phase &&
      next_phase !== 'failed' &&
      choice_value === '__freeform__'
    ) {
      // P2 v2 S3 (2026-05-16) — `user_first_name` is the v2-canonical
      // signal at signup. `agent_name` is still honoured for backward
      // compat with v1 LLM responses (the v1 envelope used agent_name
      // ambiguously for the user's name at signup).
      const persisted_user_first_name = readString(state.phase_state, 'user_first_name')
      const persisted_name = readString(state.phase_state, 'agent_name')
      const freeform =
        resolved.choice.freeform_text !== undefined &&
        resolved.choice.freeform_text.length > 0
          ? extractAgentNameFromFreeform(resolved.choice.freeform_text)
          : null
      // P2 v2 S3 — tighten the freeform-name signal with the same
      // stop-word filter the user_first_name extraction uses, so a
      // single-word reply that looksLikeBareName (e.g. "yes", "what",
      // "idk") doesn't satisfy the guard and let the engine advance
      // with a non-name. Spec § 3.1 edge case: those replies trigger
      // the clarify-reprompt branch, not advancement.
      const freeform_sanitized = freeform === null ? null : sanitizeUserFirstName(freeform)
      if (
        persisted_user_first_name === null &&
        persisted_name === null &&
        freeform_sanitized === null
      ) {
        next_phase = state.phase
        clarify_name_reprompt = true
      }
    }

    // Stay-at-phase: the LLM (or static fallback for a phase that
    // explicitly stays) decided this turn is not the advance turn.
    // Re-emit the current phase's prompt with a fresh keyboard so the
    // conversation continues. The resolved spec is already in the
    // cache; emitPhasePrompt reuses it without a second LLM call.
    if (next_phase === state.phase) {
      // 2026-05-12 (Bug C) — when the stay branch is for the name re-
      // prompt, clear the cached spec so resolvePhasePromptSpec rebuilds
      // and picks up `clarify_name_reprompt` in phase_state.
      if (clarify_name_reprompt) {
        this.invalidateResolvedSpec(input.project_slug, state.phase)
      }
      const stay_patch: Record<string, unknown> = {
        active_prompt_id: null,
        last_choice_value: choice_value,
        ...(resolved.choice.freeform_text !== undefined
          ? { last_choice_freeform: resolved.choice.freeform_text }
          : {}),
        ...(clarify_name_reprompt ? { clarify_name_reprompt: true } : {}),
      }
      const stayed = await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: state.phase,
        phase_state_patch: stay_patch,
        advanced_at: observed_at,
      })
      let final_state: OnboardingState | null = null
      const emit = await this.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: state.phase,
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await this.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: state.phase,
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final_state === null) {
        final_state = (await this.deps.stateStore.get(input.project_slug, input.user_id)) ?? stayed
      }
      return { outcome: 'reemitted_current', state: final_state, prompt_id: emit.prompt_id }
    }

    if (!isLegalTransition(state.phase, next_phase, this.deploymentMode)) {
      throw new InterviewError(
        state.phase,
        'illegal_transition',
        false,
        `illegal transition ${state.phase} → ${next_phase}`,
      )
    }
    // P1.5 / Sprint 21 — capture the agent name at the transition INTO
    // `name_chosen` (the agent-naming step is `archetype_picked` per
    // PHASE_PROMPTS). Codex r6 [P1] — relying on `last_choice_freeform`
    // at the slug_chosen entry was unreliable: that field is set on
    // ANY freeform answer and is never cleared on button-only choices.
    // A user who typed archetypes freeform in `import_offered` and
    // then tapped "Keep my display name" in `archetype_picked` would
    // have the slug suggestion derived from the archetype text.
    // Explicit capture at the name_chosen entry uses ONLY the
    // freeform_text attached to the choice that resolved the
    // agent-naming prompt; button-only choices leave agent_name=null
    // (the slug picker drops option A and the user types freeform).
    // Signup name capture falls back to the freeform_text heuristic below
    // (the router-extracted name, when the conversational path is active,
    // is already merged into `phase_state` upstream).
    const slug_chosen_patch: Record<string, unknown> = {}
    // 2026-05-14 — T9: capture agent_name at the signup-advance turn
    // too. Pre-T9 the only place name capture happened was the
    // signup → name_chosen shortcut path; after T9 the spec'd flow is
    // signup → instance_provisioned (auto-skipped) → import_offered, so
    // extraction needs to land on phase_state at THIS upsert (not at
    // some downstream name_chosen transition the user may take many
    // turns to reach). The downstream archetype_picked → name_chosen
    // handler still picks the persisted value via its
    // `persisted_name = readString(state.phase_state, 'agent_name')`
    // lookup. Skip when the LLM-extracted patch already supplied one
    // (so we don't overwrite with a worse heuristic extraction).
    // P2 v2 S3 (2026-05-16, Codex r1 P1) — signup-advance NO LONGER
    // writes the user's first name into `phase_state.agent_name`. v1
    // overloaded `agent_name` to hold the user's reply at signup
    // because the v1 prompt was ambiguous ("what should I call
    // you?"). v2 separates the two concepts: `user_first_name` is set
    // at signup (this branch + the user_first_name capture below);
    // `agent_name` is set at the dedicated `agent_name_chosen` phase.
    //
    // Why the rewrite: `auditRequiredFields()` (S3 NEW) considers
    // `agent_name` filled when it holds any non-empty string. Writing
    // the user's first name to that key at signup would let the audit
    // mark `agent_name_chosen` as "already filled" with the user's
    // own name, so S5/S6 gating would skip the dedicated agent-
    // naming phase. Removing the write here matches the v2 spec
    // (§ 3.1 + § 3.10) and keeps the audit's signal honest.
    //
    // P2 v2 S3 — `user_first_name` heuristic capture at the signup-
    // advance turn. Routes to the v2-canonical
    // `phase_state.user_first_name` key. Skip when the LLM-extracted
    // patch already supplied a value (don't overwrite a structured
    // extraction with a worse heuristic).
    if (
      state.phase === 'signup' &&
      next_phase !== state.phase &&
      next_phase !== 'failed' &&
      typeof slug_chosen_patch['user_first_name'] !== 'string' &&
      choice_value === '__freeform__' &&
      resolved.choice.freeform_text !== undefined &&
      resolved.choice.freeform_text.length > 0
    ) {
      const persisted_user_first_name = readString(state.phase_state, 'user_first_name')
      // Best-effort: run the proven extract-agent-name heuristic to
      // peel the user's first token out of "Sam Doe" / "call me
      // Sam" / "I'm Sam" replies, then narrow to first token + the
      // sanitizer (stop-words, length, charset). When neither lands,
      // leave the field unset; the clarify-reprompt branch above
      // already covers the truly-unparseable case.
      const heuristic = extractAgentNameFromFreeform(resolved.choice.freeform_text)
      const sanitized_heuristic = heuristic === null ? null : sanitizeUserFirstName(heuristic)
      const user_first_name = persisted_user_first_name ?? sanitized_heuristic
      if (user_first_name !== null) {
        slug_chosen_patch['user_first_name'] = user_first_name
      }
    }
    // P2 v2 S3 (Codex r1 P2) — backfill `user_first_name` from the
    // legacy `agent_name` extraction signal when advancing past
    // signup with no user_first_name landed. Covers two cases:
    //   1. A v1-shaped LLM response that only emitted `agent_name`
    //      (persisted as `phase_state.agent_name`, no user_first_name).
    //   2. A resumed pre-S3 instance whose prior turn wrote
    //      `phase_state.agent_name` but never set
    //      `phase_state.user_first_name`.
    // Without this backfill those instances would advance past signup
    // with `phase_state.user_first_name === undefined` AND
    // the `user_first_name` registry row === null, breaking the structural-
    // drift contract from spec § 2.1.
    if (
      state.phase === 'signup' &&
      next_phase !== state.phase &&
      next_phase !== 'failed' &&
      typeof slug_chosen_patch['user_first_name'] !== 'string'
    ) {
      const candidate =
        (typeof slug_chosen_patch['agent_name'] === 'string'
          ? (slug_chosen_patch['agent_name'] as string)
          : null) ??
        readString(state.phase_state, 'user_first_name') ??
        readString(state.phase_state, 'agent_name')
      if (candidate !== null) {
        const backfilled = sanitizeUserFirstName(candidate)
        if (backfilled !== null) {
          slug_chosen_patch['user_first_name'] = backfilled
        }
      }
    }
    // P2 v2 § 3.10 — agent_name_chosen is the dedicated user-visible
    // name-picker phase. P2 v2 / S7 — the dedicated
    // `consumeAgentNameChosenChoice` handler (above, runs before the
    // generic flow) now owns this capture path, so the legacy branch
    // below is unreachable. Left in place behind a cast as defense-in-
    // depth in case the S7 dedicated handler is ever removed; TS
    // narrows `state.phase` so the comparison would otherwise be
    // flagged TS2367.
    const _legacyPhase: string = state.phase
    if (
      _legacyPhase === 'agent_name_chosen' &&
      next_phase !== state.phase &&
      next_phase !== 'failed' &&
      typeof slug_chosen_patch['agent_name'] !== 'string' &&
      choice_value === '__freeform__' &&
      resolved.choice.freeform_text !== undefined &&
      resolved.choice.freeform_text.length > 0
    ) {
      const heuristic_name = extractAgentNameFromFreeform(resolved.choice.freeform_text)
      const agent_name = heuristic_name
      if (agent_name !== null) {
        slug_chosen_patch['agent_name'] = agent_name
        if (typeof slug_chosen_patch['suggested_slug'] !== 'string') {
          const persisted_slug = readString(state.phase_state, 'suggested_slug')
          slug_chosen_patch['suggested_slug'] =
            persisted_slug ?? suggestedSlugFromAgentName(agent_name)
        }
      }
    }
    if (next_phase === 'agent_name_chosen') {
      // Argus r1 (2026-05-10) — honour an agent_name that was extracted on
      // a PRIOR turn (by the router on the conversational path) and
      // persisted into phase_state. Without this, a multi-turn signup that
      // gathers the name early ("I'm Sam") and advances later (after
      // archetype talk) would derive the slug from the most recent reply
      // (archetype text) instead of the name.
      const persisted_name = readString(state.phase_state, 'agent_name')
      // 2026-05-11 — bug fix: the persona-discovery signup fallback body
      // invites multi-field replies ("Sherlock Holmes but warmer, call me
      // Sam") where the user's name is a slice of the text, not the
      // whole reply. Run a best-effort heuristic so the slug picker
      // doesn't seed `suggested_slug` off archetype text. The helper
      // falls back to the whole trimmed reply when no pattern matches,
      // preserving the legacy single-question contract.
      //
      // P2 v2 § 0 #9 — `personality_offered` is now a single-handler
      // phase (the dedicated `consumePersonalityOfferedChoice` at the
      // top of `consumeChoice` always returns before this generic flow
      // runs), so the previous `_personalityPhase === 'personality_offered'`
      // archetype-text-into-archetype_hint write at this branch is
      // unreachable and removed. The wow-dispatcher signal builder
      // still falls back to `phase_state.archetype_hint` when an
      // LLM-driver extraction landed one — that path is untouched.
      const freeform_name =
        choice_value === '__freeform__' &&
        resolved.choice.freeform_text !== undefined &&
        resolved.choice.freeform_text.length > 0
          ? extractAgentNameFromFreeform(resolved.choice.freeform_text)
          : null
      const agent_name = persisted_name ?? freeform_name
      slug_chosen_patch['agent_name'] = agent_name
      // Honour a router-extracted slug ('nova' in Sam's example) over
      // the agent-name-derived fallback. Source precedence:
      //   1. phase_state.suggested_slug (extracted on a PRIOR turn)
      //   2. derive-from-name fallback
      if (typeof slug_chosen_patch['suggested_slug'] !== 'string') {
        const persisted_slug = readString(state.phase_state, 'suggested_slug')
        slug_chosen_patch['suggested_slug'] =
          persisted_slug ?? suggestedSlugFromAgentName(agent_name)
      }
      // Sprint 30 — persona-sync. Land the chosen agent_name on the
      // canonical agent_name registry row at the same transition
      // the engine captures it locally. Production wiring is the
      // registry setAgentName hook in build-landing-stack.ts;
      // tests inject a recorder.
      //
      // Codex r1 P2 — skip the registry write when agent_name is null:
      // the user picked a button-only option ("Use my Telegram display
      // name", "Keep my display name") that does not carry the literal
      // text yet. Pulling the actual Telegram first_name across the
      // engine seam needs more plumbing than fits in S30; until then,
      // overwriting the `agent_name` registry row with NULL would clobber any
      // provisioning-time default OR a name set by an earlier resume
      // attempt. The engine still records the choice locally in
      // `phase_state.agent_name=null` so a follow-up sprint can detect
      // and back-fill from channel context.
      if (this.deps.personaSync !== undefined && agent_name !== null) {
        try {
          await this.deps.personaSync.recordAgentName({
            project_slug: input.project_slug,
            agent_name,
          })
        } catch (err) {
          // Best-effort: a registry write failure must not block the
          // interview from advancing. The engine logs and continues.
          console.warn(
            `[engine] personaSync.recordAgentName failed for project=${input.project_slug}:`,
            err instanceof Error ? err.message : err,
          )
        }
      }
    }
    // T4 (2026-05-13) — the legacy "capture archetype_hint at the
    // import_offered → archetype_picked transition" branch was removed
    // because `import_offered` no longer allows freeform replies (it's
    // a pick-only history-import substrate choice per § 2.3). The
    // dedicated `consumeAiSubstrateOfferedChoice` branch above intercepts
    // every choice on this phase, so this generic-route tail is dead
    // for `import_offered`. T5 will wire proper archetype capture into
    // `archetype_picked` per § 2.2.
    if (next_phase === 'slug_chosen') {
      // Clear any stale rejection reason from a prior visit. The
      // agent_name + suggested_slug were already captured at the
      // name_chosen entry above.
      slug_chosen_patch['slug_picker_rejection'] = null
    }
    // 2026-05-12 (Bug C) — when we successfully advance from signup
    // (with the clarifying re-prompt active) to the next spec'd phase,
    // clear the flag so a future resume doesn't accidentally re-render
    // the clarifying body in a context where it makes no sense.
    // 2026-05-14 — T9: trigger condition is "advancing OUT of signup"
    // (the post-T9 default route is `instance_provisioned`, not
    // `name_chosen`).
    if (state.phase === 'signup' && next_phase !== state.phase) {
      slug_chosen_patch['clarify_name_reprompt'] = null
    }
    // P2 v2 S3 (2026-05-16) — persona-sync: write the captured
    // `user_first_name` to the canonical `user_first_name` registry row
    // registry row. Mirrors the `recordAgentName` hook firing pattern.
    // Best-effort: a registry write failure does NOT block the
    // interview from advancing (the user can still chat with their
    // agent; the registry row's null `user_first_name` is repaired on
    // the next attempt or via admin reconciliation).
    //
    // Fires only when:
    //   - we're advancing OUT of signup (state.phase === 'signup' AND
    //     next_phase !== 'signup' AND next_phase !== 'failed'),
    //   - a `user_first_name` value is in the about-to-be-persisted
    //     patch (LLM-extracted OR heuristic-captured above).
    if (
      state.phase === 'signup' &&
      next_phase !== state.phase &&
      next_phase !== 'failed' &&
      typeof slug_chosen_patch['user_first_name'] === 'string' &&
      (slug_chosen_patch['user_first_name'] as string).length > 0 &&
      this.deps.personaSync !== undefined &&
      this.deps.personaSync.recordUserFirstName !== undefined
    ) {
      const user_first_name = slug_chosen_patch['user_first_name'] as string
      try {
        await this.deps.personaSync.recordUserFirstName({
          project_slug: input.project_slug,
          user_first_name,
        })
      } catch (err) {
        console.warn(
          `[engine] personaSync.recordUserFirstName failed for project=${input.project_slug}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }
    // P2 v2 § 4.4 (S3) — required-fields audit observability. Runs at
    // the signup-advance commit so a future regression that fails to
    // collect `user_first_name` lands noisily in logs. Downstream
    // sprints (S5 work_interview_gap_fill, S6 personality_offered)
    // wire the audit to GATE advancement; S3 only logs.
    if (state.phase === 'signup' && next_phase !== state.phase && next_phase !== 'failed') {
      const projected_state = { ...state.phase_state, ...slug_chosen_patch }
      const audit = auditRequiredFields(projected_state as Record<string, unknown>)
      if (audit.next_to_collect !== null) {
        // user_first_name still missing post-signup is the expected
        // case ONLY for the no-name-extracted branch above (which sets
        // next_phase=state.phase and never reaches here). Any other
        // miss at this point is a spec-conformance bug.
        console.info(
          `[engine] required-fields-audit at signup-advance: missing=${audit.missing.join(',')} next_to_collect=${audit.next_to_collect} project=${input.project_slug}`,
        )
      }
    }
    // Advance state to the next phase. Clear active_prompt_id so the new
    // phase's emit creates a fresh keyboard.
    const advanced = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: next_phase,
      phase_state_patch: {
        active_prompt_id: null,
        last_choice_value: choice_value,
        ...(resolved.choice.freeform_text !== undefined
          ? { last_choice_freeform: resolved.choice.freeform_text }
          : {}),
        ...slug_chosen_patch,
      },
      advanced_at: observed_at,
    })
    // Auto-skip past gateless phases (e.g. `name_chosen`) before emitting
    // the next prompt. The transition-into-name_chosen side effects above
    // (capturing agent_name, suggested_slug, firing personaSync) already
    // ran during the upsert; the skip just chains forward to the next
    // interactive phase so the user never sees the suppressed gate body.
    let advanced_final = AUTO_SKIP_PHASES.has(next_phase)
      ? await this.walkAutoSkip(input.project_slug, advanced, observed_at)
      : advanced
    // T1 (2026-05-13) — persona synthesis fires inline on the transition
    // INTO persona_synthesizing, per docs/plans/P2-onboarding.md § 2.6 +
    // § 4.8. Before T1 this phase was a no-op transit step and
    // PersonaComposer.compose() had zero production call sites. The
    // handler reads the captured signals out of phase_state, invokes
    // compose() (which runs the cringe-check loop internally), persists
    // the returned draft, and advances state to persona_reviewed so the
    // post-upsert emit path renders the dynamic review prompt with the
    // generated content.
    if (advanced_final.phase === 'persona_synthesizing') {
      // synthesizePersona handles BOTH branches: composer wired (runs
      // compose() inline + advances to persona_reviewed) and composer
      // unwired (skeleton path advances directly to persona_reviewed).
      advanced_final = await this.synthesizePersona(
        input,
        advanced_final,
        observed_at,
      )
    }
    const next_phase_final = advanced_final.phase
    // Emit the next phase's prompt if it has one. Codex r6 P1: thread
    // the next active_prompt_id through emitPhasePrompt's pre_send hook
    // so a fast tap on the freshly rendered keyboard always finds the
    // correct pointer in onboarding_state.
    const next_spec = STATIC_PHASE_SPECS[next_phase_final]
    // T2 r2 (2026-05-13) — wow_fired entry body is gated on the
    // WowDispatcher hook being wired. Argus r1 [BLOCKING] called out
    // that emitting "Setting up your first week — drafting your brief..."
    // when nothing is wired behind the body is a textbook active lie
    // (CLAUDE.md spec-conformance hard rule). When the hook is absent,
    // the engine falls back to the prior silent-transit: phase advances,
    // no entry body. Production composer ALWAYS wires the hook (see
    // gateway/index.ts) so users always see the body + dispatch fires.
    const skip_wow_entry_emit =
      next_phase_final === 'wow_fired' && this.deps.wowDispatcher === undefined
    if (next_spec !== undefined && !TERMINAL_PHASES.has(next_phase_final) && !skip_wow_entry_emit) {
      let final_state: OnboardingState | null = null
      const emit = await this.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: next_phase_final,
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await this.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: next_phase_final,
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final_state === null) {
        final_state = await this.deps.stateStore.get(input.project_slug, input.user_id) as OnboardingState
      }
      // T2 (2026-05-13) — once we've emitted the wow_fired entry body,
      // fire the WowDispatcher. The dispatcher's actions then post the
      // user-visible per-action content (lifestyle reminders, project
      // shells, overdue task, follow-up draft, dharma reframe,
      // overnight pass cron, first-week brief — per § 2.5 catalogue).
      // On success we write the report to phase_state and advance to
      // `completed`; on error we stay at wow_fired and emit a retry/
      // skip fallback prompt.
      if (next_phase_final === 'wow_fired' && this.deps.wowDispatcher !== undefined) {
        return await this.dispatchWowAndAdvance(
          input,
          final_state,
          observed_at,
        )
      }
      return { outcome: 'advanced', state: final_state, prompt_id: emit.prompt_id }
    }
    // Terminal next-phase or no prompt content (e.g. persona_synthesizing),
    // OR wow_fired with no hook wired (silent transit) — return the
    // advanced state without emitting.
    return { outcome: 'advanced', state: advanced_final }
  }

  /**
   * T2 (2026-05-13) — wow_fired entry handler.
   *
   * The caller has already upserted state to `phase=wow_fired` and
   * emitted the entry body via the standard `emitPhasePrompt` path
   * (the user sees "Setting up your first week... one moment..."). This
   * method then:
   *
   *   1. Builds the dispatcher input from `phase_state` — pulls
   *      whatever signals are present (rituals, captured_projects,
   *      contemplative_keywords, import_result, gmail_scopes). Empties
   *      for absent keys; T1 / T4 wire the upstream phases that
   *      populate these. Always-fire actions (#1 brief, #7 overnight
   *      pass) run regardless; conditional actions skip gracefully
   *      with `no_trigger` when their signal is empty.
   *   2. Calls `deps.wowDispatcher.dispatch(...)`. The dispatcher
   *      walks the 7-action catalogue in fixed order (7 → 2 → 6 → 3
   *      → 4 → 5 → 1) and resolves with `{fired, skipped_no_trigger,
   *      failed, rescheduled}`.
   *   3. On success — writes the report to `phase_state.wow_report`
   *      and upserts state to `phase=completed` with `wow_fired=true`
   *      and `completed_at=observed_at`.
   *   4. On dispatch error — does NOT advance. Emits a retry / skip
   *      fallback prompt and returns with the state still at
   *      `wow_fired` so the user can pick.
   */
  private async dispatchWowAndAdvance(
    input: AdvanceInput,
    state_after_entry: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult> {
    if (this.deps.wowDispatcher === undefined) {
      // Defensive — caller should already have gated on this. Keep
      // state at wow_fired (the entry body has already emitted).
      return { outcome: 'advanced', state: state_after_entry }
    }
    // 2026-05-22 (push-deeplink-wow sprint) — wow-moment push trigger.
    // Fires AT MOST ONCE per (instance, user) onboarding row. Gated on
    // `wow_pushed_at === null` so crash-resume of `wow_fired` (the
    // existing has_report/has_error watermark above) never re-pushes.
    //
    // Mark-BEFORE-attempt: we PERSIST `wow_pushed_at = observed_at`
    // BEFORE awaiting the emitter so:
    //   * a Expo outage doesn't cause an infinite retry storm on
    //     resume (the row records the attempt regardless of outcome).
    //   * a gateway crash AFTER Expo accepts the push BUT BEFORE the
    //     stamp commit doesn't cause a re-fire (Codex r1 P2 — the
    //     original "stamp after await" shape lost the bookkeeping in
    //     exactly that window).
    //
    // The wrapping try/catch is belt-and-braces: `emitWowPush` itself
    // already swallows network errors via `PushDispatcher`, but a
    // future emitter wired by a Core MUST NOT be able to wedge the
    // wow_fired transition.
    let state_for_dispatch: OnboardingState = state_after_entry
    if (
      this.deps.wowPushEmitter !== undefined &&
      state_for_dispatch.wow_pushed_at === null
    ) {
      // Persist FIRST so a crash anywhere from here through the
      // emitter await is durable + bookkept.
      state_for_dispatch = await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'wow_fired',
        wow_pushed_at: observed_at,
        advanced_at: observed_at,
      })
      try {
        // Argus r1 BLOCKER (2026-05-22 round 2): forward `topic_id`
        // unchanged — the production emitter resolves the deep-link
        // `project_id` via the canonical projects store. The engine
        // no longer assumes the topic_id encodes a project_id (web
        // chat-bridge passes `web:<user_id>`, which carries none).
        await this.deps.wowPushEmitter({
          project_slug: input.project_slug,
          user_id: input.user_id,
          topic_id: input.topic_id,
        })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err ?? 'unknown')
        console.warn(
          `[engine] wow_push_emitter failed for project=${input.project_slug} user=${input.user_id} reason=${reason}`,
        )
      }
    }
    const signals = this.buildWowSignalsFromState(state_for_dispatch)
    // T2 r2 (2026-05-13) — Argus BLOCKING #2: the dispatch identity
    // MUST be the FROZEN `internal_handle`, NOT the mutable `url_slug`.
    // Reminders, cron jobs, and wow_events rows are keyed by this value;
    // if a rename happens across the wow_fired transition, the
    // pre-rename rows would be orphaned. Fall back to url_slug only
    // when internal_handle is unwired (older tests).
    const dispatch_identity =
      typeof this.deps.internal_handle === 'string' && this.deps.internal_handle.length > 0
        ? this.deps.internal_handle
        : input.project_slug
    const hookInput: WowDispatcherHookInput = {
      project_slug: dispatch_identity,
      topic_id: input.topic_id,
      signals,
    }
    let outcome: WowDispatcherHookOutcome
    try {
      outcome = await this.deps.wowDispatcher.dispatch(hookInput)
    } catch (err) {
      // Dispatch failed mid-flight. Stay at wow_fired, emit the
      // retry / skip fallback prompt so the user can re-trigger or
      // give up gracefully. The error is captured in phase_state
      // for observability + a future retry's debug context.
      const reason =
        err instanceof Error ? err.message : String(err ?? 'unknown')
      const cleared = await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'wow_fired',
        phase_state_patch: {
          active_prompt_id: null,
          wow_dispatch_error: reason,
        },
        advanced_at: observed_at,
      })
      return await this.emitWowFallbackPrompt(input, cleared, observed_at, reason)
    }
    // 2026-06-10 (wow-hang-resilience, prod incident t-33333333) —
    // Day-1 actions are BEST-EFFORT. The engine ALWAYS advances to
    // `completed` + emits the final-handoff guide once the dispatcher
    // resolves, recording any failures (including a failed/timed-out
    // 01-first-week-brief) in `wow_report.failed` instead of blocking.
    //
    // This deliberately supersedes the T2-r3 (2026-05-13) "brief in
    // failed[] → stay at wow_fired + retry/skip fallback" policy. Two
    // things changed since r3:
    //   1. GAP3 (2026-06-09) made the final-handoff GUIDE the
    //      guaranteed terminal user-visible message on every success
    //      path — so completing with a failed brief no longer leaves
    //      the user with NOTHING (the r3 active-lie concern); the
    //      guide still lands (durably, via ButtonStore, so it survives
    //      a WS reconnect).
    //   2. The 2026-06-10 prod hang showed the stay-at-wow_fired shape
    //      is strictly worse when the failure is a HANG: Sam's real
    //      signup wedged forever at the spinner because a hung action
    //      neither resolved nor threw. Per the sprint brief:
    //      brief/overnight/seed are best-effort and must NOT block
    //      completion. The per-action timeout in the ActionRunner
    //      converts hang → `failed[] reason:'timeout'`, and this path
    //      carries the user to `completed` regardless.
    //
    // The dispatch-level catch above (whole-dispatcher THROW) keeps the
    // retry/skip fallback — that path is reachable (it's a throw, not a
    // hang) and a full-dispatch crash means nothing fired at all, so
    // offering a retry there is still the right UX.
    const report = {
      fired: [...outcome.fired],
      skipped_no_trigger: [...outcome.skipped_no_trigger],
      failed: outcome.failed.map((f) => ({ ...f })),
      ...(outcome.rescheduled !== undefined ? { rescheduled: outcome.rescheduled } : {}),
      fired_at: observed_at,
    }
    if (outcome.failed.length > 0) {
      console.warn(
        `[engine] wow dispatch completed with ${outcome.failed.length} failed action(s) for project=${input.project_slug} user=${input.user_id}: ${outcome.failed
          .map((f) => `${f.action_id} (${f.reason})`)
          .join(', ')} — advancing to completed anyway (best-effort policy)`,
      )
    }
    // 2026-05-28 sidebar sprint — onboarding-to-General-and-per-project
    // handoff. Fires BEFORE the upsert to `completed` so a re-entry to
    // dispatchWowAndAdvance after a crash mid-flight is naturally
    // idempotent — the SECOND call won't re-fire because state is
    // already `completed` and the existing wow_fired re-entry guard at
    // `start()` short-circuits. The hook is best-effort: a throw is
    // caught + logged here so a sidebar-seed hiccup never blocks the
    // user's completion. Real per-project chat continuation can still
    // be re-seeded by a follow-up admin reconciliation pass.
    if (this.deps.onboardingHandoff !== undefined) {
      const primary_projects = readStringArray(
        state_for_dispatch.phase_state as Record<string, unknown>,
        'primary_projects_confirmed',
      ) ?? readStringArray(
        state_for_dispatch.phase_state as Record<string, unknown>,
        'primary_projects',
      ) ?? []
      if (primary_projects.length > 0) {
        // 2026-05-29 content-aware seeds — pass through the cached
        // `import_result` so the handoff helper has Pass-2 synthesis
        // (rationale, suggested_topics, etc.) to compose per-project
        // summaries against. Null when the user skipped the import; the
        // helper falls back to the "no history yet" stub for each
        // project.
        const ps_handoff = state_for_dispatch.phase_state as Record<string, unknown>
        const import_result_for_handoff =
          typeof ps_handoff['import_result'] === 'object' &&
          ps_handoff['import_result'] !== null
            ? (ps_handoff['import_result'] as ImportResult)
            : null
        try {
          // 2026-06-10 (wow-hang-resilience) — bound the seed pass with
          // a hard timeout. The existing try/catch only protects against
          // a THROW; a seed hook that HANGS (e.g. a wedged downstream
          // sync) would block the `completed` advance forever — the same
          // spinner-of-death class as the hung Day-1 action. Seeding is
          // best-effort per the sprint brief: on timeout we log and
          // complete anyway; a follow-up reconciliation pass can re-seed.
          await raceWithTimeout(
            this.deps.onboardingHandoff.emitProjectSeeds({
              project_slug: input.project_slug,
              user_id: input.user_id,
              primary_projects,
              import_result: import_result_for_handoff,
              observed_at,
            }),
            WOW_SEED_TIMEOUT_MS,
            'onboardingHandoff.emitProjectSeeds',
          )
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err ?? 'unknown')
          console.warn(
            `[engine] onboardingHandoff.emitProjectSeeds failed for project=${input.project_slug} user=${input.user_id} reason=${reason}`,
          )
        }
      }
    }
    // 2026-05-28 Argus r2 BLOCKER fix — success path.
    //
    // Pre-r2: dispatch success auto-advanced to `completed`, which
    // left action 01's [A] Start overnight pass affordance prompt
    // pointing at a terminal phase. Every tap returned `noop_terminal`
    // (no routing, no acknowledgement). Argus r1 verbatim: "every tap
    // returns noop_terminal — strictly worse UX than what we shipped
    // to fix."
    //
    // r2: when the dispatcher reports a `brief_prompt_id` (action 01
    // emitted its affordance prompt), STAY at `wow_fired` with the
    // brief's prompt_id stamped as `active_prompt_id`. The user's tap
    // on [A] (or freeform reply) then routes through `normalAdvance` →
    // `consumeWowFallbackChoice` (which handles `wow_brief_accept` and
    // freeform by acking + advancing to `completed`).
    //
    // Back-compat: when `brief_prompt_id` is absent (older dispatcher
    // hooks, brief skipped/failed, test recorders that don't surface
    // it), preserve the legacy auto-advance-to-completed behavior so
    // unwired callers don't regress.
    // GAP3 (onboarding-wow-handoff-fix, 2026-06-09) — the final-handoff
    // GUIDE must be the guaranteed terminal General message on BOTH the
    // brief and no-brief paths.
    //
    // Pre-fix: when action-01 emitted a `brief_prompt_id` (its [A] Start
    // overnight pass affordance) the engine STAYED at `wow_fired` with that
    // affordance stamped as `active_prompt_id` and `return`ed HERE —
    // BEFORE `emitFinalHandoffPrompt`. So on the live brief path the guide
    // never fired as the terminal message; the user's last General message
    // was the (now-silenced) shells receipt + the brief affordance, never
    // the "click into each project" guide. Sam hit exactly this in his
    // 2026-06-09 signup, AND `consumeWowFallbackChoice`'s brief-accept
    // branch advanced to `completed` WITHOUT emitting the guide either, so
    // a second interaction didn't surface it.
    //
    // Fix: do NOT special-case `brief_prompt_id`. Fall through to the
    // `completed` upsert + `emitFinalHandoffPrompt` below — identical to the
    // no-brief path — so the guide ALWAYS fires once as the terminal
    // General message. action-01 delivers the first-week brief TEXT
    // (the wow content) during dispatch; the guide is emitted AFTER the
    // dispatch returns, so the guide is the last (terminal) message and
    // the active_prompt_id.
    //
    // Argus r1 BLOCKER #2 (2026-06-09) follow-up: action-01 no longer
    // emits ANY tappable affordance. The first cut of this fix left
    // action-01's [A] Start overnight pass button in chat; once the engine
    // advanced past `wow_fired` to `completed`, that button became a stale
    // tappable surface whose taps returned `noop_terminal` (no ack → the
    // deterministic typing indicator spins forever — the r4 stuck-typing
    // class / ISSUES #115). The brief warned against "a separate competing
    // prompt." So the affordance is removed at its SOURCE (see
    // `wow-moment/actions/01-first-week-brief.ts`): the brief is text-only,
    // `brief_prompt_id` is never produced, and the GUIDE is the single
    // tappable surface after completion. The overnight pass is still
    // registered unconditionally by action-07. This `brief_prompt_id`
    // fall-through is retained as defense-in-depth so a FUTURE last-action
    // that does emit a followup can never re-introduce the stuck-typing
    // regression — the engine ignores it and fires the guide regardless.
    // Idempotency is preserved: the `onboarding_handoff_emitted_at`
    // once-per-instance gate inside `emitFinalHandoffPrompt` makes a
    // crash-resume re-entry a no-op, so the guide is never double-emitted.
    // `report` (with the brief outcome) still lands in `wow_report` via the
    // completed upsert below.

    // Success — persist the report + advance to completed.
    const completed = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'completed',
      phase_state_patch: {
        active_prompt_id: null,
        wow_report: report,
        wow_dispatch_error: null,
      },
      wow_fired: true,
      completed_at: observed_at,
      advanced_at: observed_at,
    })
    // 2026-05-28 final-handoff sprint — fire the post-completion handoff
    // prompt (3 buttons web / 2 buttons telegram + freeform) in the
    // General topic. Best-effort: a failure here does not roll back the
    // completion (the user is technically done), but the engine logs a
    // warning so operators can spot the regression. The prompt is what
    // tells the user "I've spun up <N> projects for you on the left",
    // surfaces the mobile-app CTA, and offers Telegram-bot binding.
    const handoff_state = await this.emitFinalHandoffPrompt(
      input,
      completed,
      observed_at,
    )
    return { outcome: 'advanced', state: handoff_state, ...(handoff_state.phase_state['active_prompt_id'] !== null ? { prompt_id: handoff_state.phase_state['active_prompt_id'] as string } : {}) }
  }

  /**
   * Build dispatcher signals from `phase_state`. T2 reads what the
   * existing phase machine writes; unwired upstream phases (T1
   * persona, T4 import) leave their keys absent → conditional actions
   * skip gracefully. Always-fire actions (#1 brief, #7 overnight
   * pass) still run.
   */
  private buildWowSignalsFromState(
    state: OnboardingState,
  ): WowDispatcherSignals {
    const ps = state.phase_state
    const agent_name = readString(ps, 'agent_name')
    const user_first_name = readString(ps, 'user_first_name')
    // The wow-moment brief addresses the USER, not the agent. Prefer the
    // user's captured first name; fall back to agent_name only when the
    // user name is missing (legacy rows that predate the gap-fill phase),
    // and project_slug as a last resort so the template never renders
    // "Welcome undefined." Incident 2026-05-28: Sam saw "Welcome rainman"
    // — display_name was being populated from agent_name. See ISSUES.md.
    const display_name = user_first_name ?? agent_name ?? state.project_slug
    // T5 Codex r4 P2: prefer the structured `phase_state.archetype_blend`
    // (the BlendedArchetype the engine stashes at archetype_picked) so
    // each pick is a separate entry the wow-action copy can render
    // individually ("through Musashi's lens" rather than "through a
    // musashi/odin lens"). Falls back to the legacy single-string
    // `archetype_hint` shape for pre-T5 / library-unwired flows.
    const blend = readBlendedArchetype(ps as Record<string, unknown>)
    let archetype_blend: string[] = []
    if (blend !== null) {
      archetype_blend = blend.display_label
        .split(' / ')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    } else {
      const archetype_hint = readString(ps, 'archetype_hint')
      if (archetype_hint !== null && archetype_hint.length > 0) {
        archetype_blend = [archetype_hint]
      }
    }
    const interview: WowInterviewState = {
      display_name,
      archetype_blend,
      phase_state_json: ps,
    }
    const rituals = readArray<RitualEntry>(ps, 'rituals_captured')
    // 2026-05-28 sprint — the user's confirmed project list at
    // `projects_proposed` is the authoritative source for downstream
    // wow-actions (notably 03-project-shells). Pre-fix the engine
    // surfaced `phase_state.captured_projects` (which is never written
    // by the engine), so 03-project-shells fell through to merging
    // `import_result.proposed_projects` only — silently dropping any
    // project the user added via freeform amend at projects_proposed.
    // Sam walkthrough 2026-05-28: confirmed 7 projects, post-Max
    // OAuth emit showed only 5 because Home Assistant + Side Project
    // were freeform-added (kind: 'concept') and never landed in
    // import_result. Source of truth: `primary_projects_confirmed[]`
    // (set by consumeProjectsProposedChoice). Fall back to
    // `captured_projects` for back-compat with any non-onboarding
    // caller that wrote that field directly.
    //
    // Codex review (2026-05-28) caught the zero-state skip-ahead edge:
    // `PROJECTS_PROPOSED_SKIP_AHEAD` deliberately writes
    // `primary_projects_confirmed: []`. `readStringArray` returns null
    // for ANY empty array, so we'd conflate "deliberately empty
    // confirm" with "never reached confirmation" and fall back to
    // `import_result.proposed_projects` — creating shells for the
    // imported candidate set the user just declined. We detect the
    // empty-confirm state explicitly by checking for the array on
    // phase_state directly (not via readStringArray, which strips it).
    const confirmed_raw = ps['primary_projects_confirmed']
    const projects_confirmed_present = Array.isArray(confirmed_raw)
    const captured_projects: CapturedProject[] = projects_confirmed_present
      ? (confirmed_raw as ReadonlyArray<unknown>)
          .filter((v): v is string => typeof v === 'string')
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
          .map((name) => ({ name }))
      : readArray<CapturedProject>(ps, 'captured_projects')
    const contemplative_keywords = readArray<string>(ps, 'contemplative_keywords')
    const stalled_threads = readArray<StalledEmailThread>(ps, 'stalled_threads')
    const import_result =
      typeof ps['import_result'] === 'object' && ps['import_result'] !== null
        ? (ps['import_result'] as ImportResult)
        : null
    const gmail_scopes =
      typeof ps['gmail_scopes'] === 'object' && ps['gmail_scopes'] !== null
        ? (ps['gmail_scopes'] as GmailScopeState)
        : null
    return {
      interview,
      import_result,
      rituals,
      captured_projects,
      projects_confirmed: projects_confirmed_present,
      contemplative_keywords,
      stalled_threads,
      gmail_scopes,
    }
  }

  /**
   * Emit the retry / skip fallback prompt when WowDispatcher.dispatch
   * threw. The user can re-fire the dispatch or accept the partial
   * outcome and complete. Bookkeeping: persists active_prompt_id so
   * the choice routes back here through normalAdvance →
   * consumeChoice's wow_fired branch.
   */
  private async emitWowFallbackPrompt(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    reason: string,
  ): Promise<AdvanceResult> {
    const baseBody =
      "I had trouble setting up your Day-1 brief — want me to try again or skip?"
    const body =
      reason.length > 0 ? `${baseBody}\n\n(reason: ${reason})` : baseBody
    const options = WOW_FALLBACK_OPTIONS.map((o) => ({ ...o }))
    const seed = canonicalPromptSeed({
      body,
      options: options.map((o) => ({ value: o.value })),
    })
    const prior_attempts = readNumber(state.phase_state, 'wow_fallback_attempt_count') ?? 0
    const next_attempts = prior_attempts + 1
    const idempotency_key = deriveIdempotencyKey({
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      seed: `wow_fired_fallback:${next_attempts}:${seed}`,
    })
    const prompt = buildButtonPrompt({
      body,
      options,
      allow_freeform: false,
      idempotency_key,
      uuid: this.uuid,
    })
    const emit = await this.deps.buttonStore.emit(prompt, { topic_id: input.topic_id })
    const updated = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'wow_fired',
      phase_state_patch: {
        active_prompt_id: emit.prompt_id,
        topic_id: input.topic_id,
        wow_fallback_attempt_count: next_attempts,
      },
      advanced_at: observed_at,
    })
    if (emit.was_new || !emit.was_delivered) {
      try {
        await this.deps.sendButtonPrompt({
          project_slug: input.project_slug,
          topic_id: input.topic_id,
          prompt: emit.prompt,
        })
        await this.deps.buttonStore.markDelivered(emit.prompt_id, this.now())
      } catch (err) {
        throw new InterviewError(
          'wow_fired',
          'send_failed',
          true,
          `failed to send wow_fired fallback prompt for project=${input.project_slug}`,
          err,
        )
      }
      this.deps.transcript.append({
        role: 'agent',
        body,
        phase: 'wow_fired',
        button_prompt_id: emit.prompt_id,
      })
    }
    return { outcome: 'reemitted_current', state: updated, prompt_id: emit.prompt_id }
  }

  /**
   * T2 (2026-05-13) — handle the user's pick on the wow_fired retry /
   * skip fallback prompt.
   *
   *   - `wow-retry` → re-fire the dispatcher (clear the active_prompt
   *     pointer, call dispatchWowAndAdvance again).
   *   - `wow-skip`  → advance to `completed` with a sentinel
   *     `wow_report` recording the skip + the prior error reason.
   *
   * Synthetic non-advancing values (`__timeout__`, `__cancel__`) and
   * unknown values land here as no-ops — the user re-taps and we
   * route again.
   */
  private async consumeWowFallbackChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const choice_value = choice.choice_value
    // Translate `__freeform__` back into the user's typed reply for
    // transcript fidelity (mirrors the discipline in `consumeChoice`).
    const transcript_body =
      choice_value === '__freeform__' && typeof choice.freeform_text === 'string' && choice.freeform_text.length > 0
        ? choice.freeform_text
        : choice_value
    if (was_new) {
      this.deps.transcript.append({
        role: 'user',
        body: transcript_body,
        phase: 'wow_fired',
        button_prompt_id: choice.prompt_id,
        button_choice: choice_value,
      })
    }
    if (NON_ADVANCING_CHOICE_VALUES.has(choice_value)) {
      return { outcome: 'no_active_prompt', state }
    }

    // 2026-05-28 Argus r2 BLOCKER fix — brief-affordance acceptance.
    //
    // Action 01 emits a [A] Start overnight pass button (+ allow_freeform)
    // after rendering the first-week brief. On success path the engine
    // stays at `wow_fired` with the brief's prompt_id as
    // `active_prompt_id`. The user's tap on [A] (value=`wow_brief_accept`)
    // OR any freeform reply lands here.
    //
    // Both shapes:
    //   1. Ack ("Got it — I'll start the overnight pass tonight.")
    //   2. Persist `phase_state.user_accepted_overnight_queue = true`
    //      so observability + a future overnight-pass sprint can read
    //      "user accepted the queue."
    //   3. Advance to `completed` with `wow_fired: true`.
    //
    // The actual overnight-pass mechanics (queue persistence + nightly
    // cron + morning brief) are a future sprint per the brief's
    // out-of-scope section. This handler closes the routing gap without
    // shipping mechanics that aren't designed yet.
    const is_brief_accept = choice_value === 'wow_brief_accept'
    const is_brief_freeform =
      choice_value === '__freeform__' &&
      // Only route freeform via the brief-accept path when there's NO
      // active dispatch error. If `wow_dispatch_error` is set we're on
      // the retry/skip fallback prompt path, which doesn't accept
      // freeform — fall through to the unknown-value branch instead.
      readString(state.phase_state, 'wow_dispatch_error') === null
    if (is_brief_accept || is_brief_freeform) {
      const ack_body = is_brief_accept
        ? "Got it — I'll run the overnight pass tonight."
        : "Got it. I'll fold that in before tomorrow's pass."
      await this.sendAgentText(input, 'wow_fired', ack_body, observed_at)
      const wow_report =
        typeof state.phase_state['wow_report'] === 'object' && state.phase_state['wow_report'] !== null
          ? (state.phase_state['wow_report'] as Record<string, unknown>)
          : null
      const completed = await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'completed',
        phase_state_patch: {
          active_prompt_id: null,
          user_accepted_overnight_queue: true,
          ...(wow_report !== null ? { wow_report } : {}),
          wow_dispatch_error: null,
        },
        wow_fired: true,
        completed_at: observed_at,
        advanced_at: observed_at,
      })
      return { outcome: 'advanced', state: completed }
    }

    if (choice_value === 'wow-skip') {
      const completed = await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'completed',
        phase_state_patch: {
          active_prompt_id: null,
          wow_report: {
            fired: [],
            skipped_no_trigger: [],
            failed: [],
            skipped_by_user: true,
            wow_dispatch_error: readString(state.phase_state, 'wow_dispatch_error'),
            fired_at: observed_at,
          },
        },
        wow_fired: false,
        completed_at: observed_at,
        advanced_at: observed_at,
      })
      // 2026-05-28 final-handoff sprint — same emit as the success path
      // above. The user still lands at `completed` even when they skipped
      // the wow dispatcher, so they should still see the General-topic
      // pointer + mobile-app / Telegram-bot CTAs.
      const handoff_state = await this.emitFinalHandoffPrompt(
        input,
        completed,
        observed_at,
      )
      return { outcome: 'advanced', state: handoff_state, ...(handoff_state.phase_state['active_prompt_id'] !== null ? { prompt_id: handoff_state.phase_state['active_prompt_id'] as string } : {}) }
    }
    if (choice_value === 'wow-retry') {
      // Clear the fallback prompt pointer + last dispatch error so a
      // fresh attempt isn't tagged with the stale reason on success.
      const cleared = await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'wow_fired',
        phase_state_patch: {
          active_prompt_id: null,
          wow_dispatch_error: null,
        },
        advanced_at: observed_at,
      })
      return await this.dispatchWowAndAdvance(input, cleared, observed_at)
    }
    // Unknown value — keep state at wow_fired so a follow-up tap can
    // route through this branch again.
    return { outcome: 'no_active_prompt', state }
  }

  /**
   * 2026-05-28 final-handoff sprint — emit the post-completion handoff
   * prompt (3 buttons web / 2 buttons telegram + freeform) in the
   * General topic. Called by `dispatchWowAndAdvance` (success path) and
   * `consumeWowFallbackChoice` (skip path) AFTER the engine has upserted
   * `phase: 'completed'`.
   *
   * Reads `phase_state.user_first_name` + `phase_state.primary_projects_confirmed`
   * for the body, then renders via `buildFinalHandoffPromptSpec`. Emits
   * via the same `buttonStore.emit` + `sendButtonPrompt` plumbing
   * `emitPhasePrompt` uses, but lives outside the generic
   * `resolvePhasePromptSpec` cache because `completed` is a terminal
   * phase the cache deliberately doesn't index.
   *
   * Returns the post-emit state with `active_prompt_id` rotated to the
   * handoff prompt. A best-effort failure (send error) is swallowed
   * with a warning — the user is technically `completed` either way,
   * and the rest of the chat surface still works.
   */
  private async emitFinalHandoffPrompt(
    input: AdvanceInput,
    completed_state: OnboardingState,
    observed_at: number,
  ): Promise<OnboardingState> {
    // Sprint 2026-06-03 (onboarding-buttons-only-tweak-later) § 5 —
    // once-per-instance idempotency gate. The initial post-completion
    // handoff (with the "tweak later" promise + project list) must fire
    // AT MOST ONCE. If a prior attempt already stamped
    // `onboarding_handoff_emitted_at`, skip re-emitting on any
    // crash-resume re-entry into the completion path. (The follow-up
    // shapes emitted by button taps go through `emitFinalHandoffSpec`
    // directly and are NOT gated here — they should always render.)
    if (completed_state.onboarding_handoff_emitted_at !== null) {
      return completed_state
    }
    const ps = completed_state.phase_state
    const user_first_name = readString(ps, 'user_first_name')
    const project_names = readStringArray(ps, 'primary_projects_confirmed') ?? []
    // ChannelKindForButton has three legal values (telegram / app-socket /
    // webhook). Telegram collapses to the 2-button variant; every other
    // value renders the full 3-button shape (web chat AND any future
    // webhook integration get the Telegram-bot CTA — the URL still works
    // even when the user is on a non-Telegram channel).
    const channel_kind: 'app-socket' | 'telegram' =
      input.channel_kind === 'telegram' ? 'telegram' : 'app-socket'
    const spec = buildFinalHandoffPromptSpec({
      channel_kind,
      user_first_name,
      project_names,
    })
    // `stamp_handoff_emitted: true` folds the once-per-instance marker into
    // the pre-send upsert inside emitFinalHandoffSpec — mark-on-attempt
    // (before the channel send) so a send failure never re-emits on resume.
    const sent = await this.emitFinalHandoffSpec(input, spec, observed_at, true)
    if (sent === null) return completed_state
    return sent
  }

  /**
   * Inner emit helper used by every final-handoff phase emission
   * (initial 3-button shape + 3 follow-up shapes). Builds the
   * idempotency key, mints the ButtonPrompt, persists active_prompt_id,
   * pushes to the channel, and writes the agent line to the transcript.
   *
   * Returns the post-upsert state on success or `null` when the
   * underlying `sendButtonPrompt` failed (warning logged; phase stays
   * at `completed` regardless).
   */
  private async emitFinalHandoffSpec(
    input: AdvanceInput,
    spec: PhasePromptSpec,
    observed_at: number,
    /**
     * Sprint 2026-06-03 — when true, stamp `onboarding_handoff_emitted_at`
     * on the row in the same pre-send upsert (mark-on-attempt). Only the
     * INITIAL handoff passes this; the follow-up shapes leave it unset so
     * they never re-stamp the once-per-instance marker.
     */
    stamp_handoff_emitted = false,
  ): Promise<OnboardingState | null> {
    const shape: FinalHandoffShape =
      typeof spec.metadata?.['final_handoff_shape'] === 'string'
        ? (spec.metadata!['final_handoff_shape'] as FinalHandoffShape)
        : 'initial'
    const seed = canonicalPromptSeed({
      body: spec.body,
      options: spec.options.map((o) => ({ value: o.value })),
    })
    const idempotency_key = deriveIdempotencyKey({
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      seed: `final_handoff:${shape}:${seed}`,
    })
    const promptInput: Parameters<typeof buildButtonPrompt>[0] = {
      body: spec.body,
      options: spec.options.map((o) => ({
        label: o.label,
        body: o.body,
        value: o.value,
      })),
      allow_freeform: spec.allow_freeform,
      idempotency_key,
      uuid: this.uuid,
    }
    if (spec.metadata !== undefined) promptInput.metadata = spec.metadata
    const prompt = buildButtonPrompt(promptInput)
    const emit = await this.deps.buttonStore.emit(prompt, { topic_id: input.topic_id })
    // Persist active_prompt_id BEFORE the channel send so a fast tap
    // routes through the active_prompt_id-aware handler. Also stamp the
    // handoff shape on phase_state — `ButtonStore` doesn't persist a
    // prompt's `metadata` bag (the schema only has body / options / kind),
    // so the engine carries the shape on the onboarding row instead. This
    // is also the marker that distinguishes our active_prompt_id from any
    // stale pre-sprint completed-row prompt the engine might encounter.
    const updated = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'completed',
      phase_state_patch: {
        active_prompt_id: emit.prompt_id,
        final_handoff_active: true,
        final_handoff_shape: shape,
      },
      advanced_at: observed_at,
      ...(stamp_handoff_emitted
        ? { onboarding_handoff_emitted_at: observed_at }
        : {}),
    })
    if (emit.was_new || !emit.was_delivered) {
      try {
        const sendResult = await this.deps.sendButtonPrompt({
          project_slug: input.project_slug,
          topic_id: input.topic_id,
          prompt: emit.prompt,
        })
        if (sendResult.was_new) {
          await this.deps.buttonStore.markDelivered(emit.prompt_id, this.now())
          this.deps.transcript.append({
            role: 'agent',
            body: spec.body,
            phase: 'completed',
            button_prompt_id: emit.prompt_id,
          })
        }
      } catch (err) {
        console.warn(
          `[engine.emitFinalHandoffSpec] project=${input.project_slug} shape=${shape} send failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        return null
      }
    }
    return updated
  }

  /**
   * 2026-05-28 final-handoff sprint — top-of-`advance()` handler that
   * catches an inbound landing on a `completed` row whose
   * `active_prompt_id` points at a final-handoff prompt. Routes button
   * taps to the right follow-up emit (mobile-app / telegram-bind / skip
   * / done) and the phase NEVER advances out of `completed`.
   *
   * Returns `noop_terminal` for an inbound on a `completed` row that
   * is NOT a final-handoff tap (legacy completed rows from before this
   * sprint, or a stray inbound on a follow-up's `[A] Done` after the
   * skip-ack already landed). Preserves byte-identical pre-sprint
   * behaviour for those flows.
   */
  private async handleFinalHandoffOnCompleted(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const active_prompt_id = readString(state.phase_state, 'active_prompt_id')
    if (active_prompt_id === null) {
      // Pre-sprint completed row — no handoff prompt was emitted.
      return { outcome: 'noop_terminal', state }
    }
    if (state.phase_state['final_handoff_active'] !== true) {
      // The active prompt on this completed row isn't ours — likely a
      // stale pre-sprint row. Don't try to consume it.
      return { outcome: 'noop_terminal', state }
    }
    const shape: FinalHandoffShape =
      typeof state.phase_state['final_handoff_shape'] === 'string'
        ? (state.phase_state['final_handoff_shape'] as FinalHandoffShape)
        : 'initial'
    // Resolve the user's reply. A button tap arrives as `input.choice`;
    // a freeform channel reply (no associated prompt_id, e.g. plain text
    // on the chat surface) arrives via `input.freeform_text`.
    //
    // PR #331 fast-follower (2026-05-28): button taps route through
    // `buttonStore.resolve` for idempotency parity with `consumeChoice`
    // at engine.ts:3846. Without the resolve round-trip a near-simultaneous
    // double-tap on the initial handoff prompt walked the mint+emit cycle
    // twice (the channel-level idempotency on `buttonStore.emit` still
    // collapsed the wire-side send, but the engine did redundant work and
    // the prompt row stayed `resolved_at IS NULL` indefinitely — until the
    // sweep eventually synthesized a `__timeout__` callback for it).
    // Going through resolve():
    //   - First tap → was_new=true, proceed to mint+emit.
    //   - Duplicate tap → was_new=false, return noop_terminal without a
    //     second emit cycle and the row's `resolved_at` is stamped exactly
    //     once.
    //   - Expired / missing prompt → log + noop. Unlike `consumeChoice`
    //     we don't throw `InterviewError('unknown_prompt')` because the
    //     user is on the terminal `completed` row; bubbling as a fatal
    //     would tear down the chat surface for a benign stale tap.
    // Freeform-only inbounds (no `input.choice`) have no prompt_id to
    // resolve against, so they skip the buttonStore round-trip entirely.
    let choice_value: string | null = null
    let freeform_text: string | null = null
    if (input.choice !== undefined) {
      if (input.choice.prompt_id !== active_prompt_id) {
        // Tap on a stale prior prompt — no-op.
        return { outcome: 'noop_terminal', state }
      }
      if (NON_ADVANCING_CHOICE_VALUES.has(input.choice.choice_value)) {
        return { outcome: 'noop_terminal', state }
      }
      // Membership guard BEFORE `buttonStore.resolve()` — Codex cross-
      // model review (r2 P0, 2026-05-29) caught that `resolve()`
      // (channels/button-store.ts:467-480) does NO option-membership
      // check and unconditionally stamps `resolved_at` +
      // `resolution_value` on the prompt row. A malformed tap with a
      // `choice_value` like `totally_made_up_value` therefore burned
      // the resolve slot: the post-resolve membership guard at the
      // dispatch site (consumeFinalHandoffChoice) correctly returned
      // `noop_terminal`, but a subsequent legitimate Mobile/Telegram/
      // Skip retap on the same `prompt_id` returned `was_new=false`
      // and silently noop'd — locking the user out for the rest of
      // the prompt TTL. By rejecting unknown values BEFORE the
      // resolve round-trip, the prompt stays `resolved_at IS NULL`
      // and the legitimate retap walks the mint+emit cycle as
      // intended. `__freeform__` is in the allowed set because a
      // freeform reply lands here with that sentinel value plus a
      // `freeform_text` payload (see channels/button-routing.ts:130).
      if (!VALID_FINAL_HANDOFF_CHOICE_VALUES.has(input.choice.choice_value)) {
        return { outcome: 'noop_terminal', state }
      }
      // Codex cross-model review r3 (2026-05-29): admitting `__freeform__`
      // into VALID_FINAL_HANDOFF_CHOICE_VALUES is required for the legit
      // freeform-routed path (channels/button-routing.ts:130 sets the
      // sentinel together with a `freeform_text` payload). But an app-
      // socket client can send `{type: 'button_choice', prompt_id:
      // <live>, choice_value: '__freeform__'}` with NO `freeform_text` —
      // `gateway/http/chat-bridge.ts:1131-1138` forwards verbatim. Without
      // this check the same lockout shape the r2 guard closed would
      // recur: `buttonStore.resolve()` would stamp `resolved_at` on the
      // prompt row, `consumeFinalHandoffChoice` would fall through the
      // unknown-value `else` and return `noop_terminal`, and a
      // subsequent legitimate Mobile/Telegram/Skip retap would return
      // `was_new=false` → silent noop, locking the user out for the
      // remainder of the prompt TTL. Reject BEFORE `resolve()` so the
      // row stays `resolved_at IS NULL`.
      if (
        input.choice.choice_value === '__freeform__' &&
        (typeof input.choice.freeform_text !== 'string' ||
          input.choice.freeform_text.length === 0)
      ) {
        return { outcome: 'noop_terminal', state }
      }
      let resolved: { was_new: boolean; choice: ButtonChoice }
      try {
        const r = await this.deps.buttonStore.resolve({ choice: input.choice })
        resolved = { was_new: r.was_new, choice: r.choice }
      } catch (err) {
        console.warn(
          `[engine.handleFinalHandoffOnCompleted] project=${input.project_slug} buttonStore.resolve failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        return { outcome: 'noop_terminal', state }
      }
      if (!resolved.was_new) {
        // Duplicate channel callback — the first tap already wrote the
        // transcript line + emitted the follow-up. Returning early skips
        // the mint+emit cycle entirely and leaves the prompt row's
        // `resolved_at` stamp from the first tap untouched.
        return { outcome: 'noop_terminal', state }
      }
      if (
        resolved.choice.choice_value === '__freeform__' &&
        resolved.choice.freeform_text !== undefined
      ) {
        freeform_text = resolved.choice.freeform_text
      } else {
        choice_value = resolved.choice.choice_value
      }
    } else if (typeof input.freeform_text === 'string' && input.freeform_text.length > 0) {
      freeform_text = input.freeform_text
    } else {
      return { outcome: 'noop_terminal', state }
    }
    if (freeform_text !== null) {
      choice_value = routeFinalHandoffFreeform(freeform_text, shape)
    }
    if (choice_value === null) {
      // Couldn't make sense of the reply. Append to transcript so the
      // operator can see it, but don't emit a follow-up. The user can
      // tap a real button or rephrase.
      this.deps.transcript.append({
        role: 'user',
        body: freeform_text ?? '<empty>',
        phase: 'completed',
        button_prompt_id: active_prompt_id,
      })
      return { outcome: 'noop_terminal', state }
    }
    return await this.consumeFinalHandoffChoice(
      input,
      state,
      active_prompt_id,
      shape,
      choice_value,
      freeform_text,
      observed_at,
    )
  }

  /**
   * Apply a resolved final-handoff choice value. Writes the transcript
   * line for the user reply, picks the follow-up shape, mints any
   * needed tokens (Telegram bind), and emits the follow-up via
   * `emitFinalHandoffSpec`. State never leaves `completed`.
   */
  private async consumeFinalHandoffChoice(
    input: AdvanceInput,
    state: OnboardingState,
    active_prompt_id: string,
    shape: FinalHandoffShape,
    choice_value: string,
    freeform_text: string | null,
    observed_at: number,
  ): Promise<AdvanceResult> {
    this.deps.transcript.append({
      role: 'user',
      body: freeform_text ?? choice_value,
      phase: 'completed',
      button_prompt_id: active_prompt_id,
      button_choice: choice_value,
    })
    if (choice_value === FINAL_HANDOFF_DONE_CHOICE) {
      // The user acknowledged a follow-up (mobile-app or telegram-bind).
      // Clear active_prompt_id so a stray future re-tap doesn't loop +
      // tear down the final-handoff flag so the engine stops short-
      // circuiting `completed` advances.
      const cleared = await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'completed',
        phase_state_patch: {
          active_prompt_id: null,
          final_handoff_active: false,
        },
        advanced_at: observed_at,
      })
      return { outcome: 'advanced', state: cleared }
    }
    // Choice values reaching this point SHOULD be one of the three
    // remaining FINAL_HANDOFF_* constants (MOBILE_APP, TELEGRAM_BIND,
    // SKIP) — the DONE branch returned at the top. But the membership
    // guard is required, not theoretical: Codex cross-model review
    // (r1 P2, 2026-05-28) caught that `buttonStore.resolve()`
    // (channels/button-store.ts:417) does NO option-membership check
    // against the spec'd options list, and `chat-bridge.ts` forwards
    // the client-supplied `choice_value` verbatim. A stale or
    // malformed tap that still hits a live `prompt_id` therefore lands
    // here as `was_new=true` with an unexpected value. Without an
    // explicit `else if` + `else return noop_terminal`, the previous
    // refactor's bare `else` would mis-route it to the SKIP follow-up.
    // The earlier "dead code" rationale was wrong; restore the guard.
    let follow_spec: PhasePromptSpec
    if (choice_value === FINAL_HANDOFF_MOBILE_APP_CHOICE) {
      const mobile_spec = buildFinalHandoffMobileAppFollowupPromptSpec(
        this.resolveFinalHandoffMobileAppUrl(),
      )
      if (mobile_spec === null) {
        // Open default: `NEUTRON_WEB_APP_BASE` unset → no mobile page to
        // point at. Suppress the follow-up entirely rather than emit a
        // dangling "Open that link" with no link (repo-forbidden
        // phase-prompt-lies-to-user pattern). Leave the initial handoff
        // prompt active so the user can still pick another option.
        return { outcome: 'noop_terminal', state }
      }
      follow_spec = mobile_spec
    } else if (choice_value === FINAL_HANDOFF_TELEGRAM_BIND_CHOICE) {
      const bot_username = this.resolveFinalHandoffBotUsername()
      const bind_token = await this.mintFinalHandoffTelegramBindToken(input)
      follow_spec = buildFinalHandoffTelegramBindFollowupPromptSpec({
        bot_username,
        bind_token,
      })
    } else if (choice_value === FINAL_HANDOFF_SKIP_CHOICE) {
      follow_spec = buildFinalHandoffSkipFollowupPromptSpec()
    } else {
      // Unknown / stale / malformed value that bypassed
      // `routeFinalHandoffFreeform` (button-tap path) and was not
      // filtered by `buttonStore.resolve()`. Drop it silently — the
      // initial prompt remains active until expiry, so the user can
      // retap a legitimate option.
      return { outcome: 'noop_terminal', state }
    }
    const sent = await this.emitFinalHandoffSpec(input, follow_spec, observed_at)
    if (sent === null) return { outcome: 'noop_terminal', state }
    const next_prompt_id =
      typeof sent.phase_state['active_prompt_id'] === 'string'
        ? (sent.phase_state['active_prompt_id'] as string)
        : undefined
    return {
      outcome: 'advanced',
      state: sent,
      ...(next_prompt_id !== undefined ? { prompt_id: next_prompt_id } : {}),
    }
  }

  /**
   * Resolve the mobile-app page URL for the final-handoff follow-up.
   * Prefers the injected dep (tests / configured deploys); falls back to
   * the env-derived `MOBILE_APP_URL`. Empty string on an unconfigured Open
   * install — the caller suppresses the follow-up in that case.
   */
  private resolveFinalHandoffMobileAppUrl(): string {
    if (typeof this.deps.mobileAppUrl === 'string') {
      return this.deps.mobileAppUrl
    }
    return MOBILE_APP_URL
  }

  /**
   * Resolve the Telegram bot username for the bind-handoff URL. Prefers
   * the engine dep, falls back to the env-aware resolver, finally
   * returns the default. Centralised so tests can inject + production
   * pulls from env without rebuilding the dep tree.
   */
  private resolveFinalHandoffBotUsername(): string {
    if (
      typeof this.deps.telegramBotUsername === 'string' &&
      this.deps.telegramBotUsername.length > 0
    ) {
      return this.deps.telegramBotUsername
    }
    return resolveTelegramBotUsername()
  }

  /**
   * Mint a Telegram-bind token for the deep link. When the dep is
   * wired AND returns a non-empty string, that's the canonical token.
   * Otherwise the engine falls back to a per-(instance, user, observed_at)
   * opaque nonce so the link still renders — the bot-side
   * `/start bind:<token>` handler is a follow-up sprint, so a
   * non-verifiable nonce is functionally identical pending that work.
   */
  private async mintFinalHandoffTelegramBindToken(
    input: AdvanceInput,
  ): Promise<string> {
    // Codex review (2026-05-28): Telegram restricts `start` payloads to
    // `[A-Za-z0-9_-]` and 64 chars total. After we tack the `bind_`
    // prefix on inside `buildTelegramBindDeepLink`, the token itself
    // must be ≤ 58 chars and grammar-conformant. We validate every
    // returned value here so a future production minter that accidentally
    // ships a JWT (dots, slashes, equals) fails fast → fallback nonce
    // → bot link still resolves rather than silently 404'ing on Start.
    if (this.deps.mintTelegramBindToken !== undefined) {
      try {
        const minted = await this.deps.mintTelegramBindToken({
          project_slug: input.project_slug,
          user_id: input.user_id,
        })
        if (typeof minted === 'string' && isTelegramBindTokenShape(minted)) {
          return minted
        }
        if (typeof minted === 'string' && minted.length > 0) {
          console.warn(
            `[engine.mintFinalHandoffTelegramBindToken] project=${input.project_slug} minted token violates Telegram start-payload grammar (got ${minted.length} chars, needs <=58 + [A-Za-z0-9_-]); falling back to nonce`,
          )
        }
      } catch (err) {
        console.warn(
          `[engine.mintFinalHandoffTelegramBindToken] project=${input.project_slug} mint failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    // Fallback nonce — URL-safe alphanumeric only so the final
    // `bind_<token>` payload stays inside Telegram's grammar. Length
    // capped via `slice(0, 16)` so even a wild uuid implementation
    // can't push past the 58-char ceiling. Deterministic per (instance,
    // user, attempt) so a duplicate tap renders the same URL during
    // the same engine process lifetime.
    const raw = this.uuid().replace(/-/g, '').slice(0, 16)
    return `nonce${raw}`
  }


  /**
   * P2 v2 § 0 locked decision #9 + § 3.9 + § 4.1 — sole handler for the
   * `personality_offered` phase.
   *
   * The user replies in natural language describing the desired agent
   * personality. Per spec § 2.6 (Sam-locked 2026-05-15) the engine does
   * NOT show a curated A/B/C/D archetype menu — the LLM may suggest
   * examples in the prompt body, but the user's reply is treated as
   * free-form text that lands on `phase_state.agent_personality`.
   *
   * Curated archetype blending (e.g. "Sherlock Holmes meets Marcus
   * Aurelius" → BlendedArchetype with the curated voice fragments)
   * happens later, at `persona_synthesizing` time, inside
   * `PersonaComposer.compose` via `composeFromFreeText`. The engine
   * carries NO ArchetypeLibrary dependency — see spec § 7.1 +
   * § 7.2.
   *
   * Advance gate (§ 3.9): extracted `agent_personality` must be ≥ 4
   * chars after trim. On failure, stay + re-emit with a rejection
   * reason. On success, persist locally + via `personaSync` and route
   * to `agent_name_chosen`.
   */
  async consumePersonalityOfferedChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    return personaConsumePersonalityOfferedChoice(this, input, state, choice, was_new, observed_at)
  }

  /**
   * P2 v2 § 3.10 / S7 — `agent_name_chosen` handler. Captures the
   * user's chosen agent name (LLM-extracted OR freeform), runs the
   * locked validators (length / charset / reserved-name set), and on
   * success derives `suggested_slug` + advances to `slug_chosen`. On
   * failure, stays + re-emits with a rejection reason that surfaces
   * the failure mode (too short / reserved / bad chars).
   */
  async consumeAgentNameChosenChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    return slugConsumeAgentNameChosenChoice(this, input, state, choice, was_new, observed_at)
  }

  /**
   * P2 v2 § 3.12 / S7 — `projects_proposed` handler. The user is
   * confirming the project list. 2026-05-28 the [B] Review each one
   * button is gone from the surface (Sam walkthrough — clicking it
   * did nothing, just advanced); the engine still defensively accepts
   * a stale `value: 'review'` submission and treats it as a
   * confirm-equivalent (marker preserved as `review-deferred` for
   * downstream analytics). Freeform tweaks ("drop n8n", "rename A to
   * B") arrive via `__freeform__` + the LLM-router amend pipeline,
   * which mutates `phase_state.primary_projects[]` before this handler
   * lands. Confirm writes `primary_projects_confirmed[]` so persona-gen
   * + wow-action 03-project-shells consume a stable confirmed list.
   */
  private async consumeProjectsProposedChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const choice_value = choice.choice_value
    const freeform =
      choice.freeform_text !== undefined && choice.freeform_text.length > 0
        ? choice.freeform_text.trim()
        : null
    if (was_new) {
      this.deps.transcript.append({
        role: 'user',
        body: freeform ?? choice_value,
        phase: 'projects_proposed',
        button_prompt_id: choice.prompt_id,
        button_choice: choice_value,
      })
    }

    // v0.1.80 — zero-state share-work button. Flip the share-freeform
    // sub-state and re-emit; the resolver morphs the body into a
    // "tell me what you're working on" freeform prompt.
    const phase_state_pre = state.phase_state as Record<string, unknown>
    const awaiting_share_freeform =
      phase_state_pre['projects_proposed_share_freeform'] === true

    // v0.1.80 — share-freeform sub-state. User previously tapped
    // "Share what I'm working on" and is now sending the project list.
    // Split the freeform reply on newline/semicolon/comma so the user is
    // never stuck. After persisting, re-emit `projects_proposed` (do NOT
    // advance) so they see the populated body + standard confirm/review
    // buttons. (When the conversational router is active it handles the
    // share-freeform reply upstream; this is the deterministic capture.)
    if (awaiting_share_freeform && choice_value === '__freeform__') {
      this.invalidateResolvedSpec(input.project_slug, 'projects_proposed')
      await this.resolvePhasePromptSpec(
        input.project_slug,
        input.user_id,
        'projects_proposed',
      )
      const final_projects =
        freeform !== null ? splitFreeformProjectList(freeform) : []
      if (final_projects.length === 0) {
        // Couldn't pick anything out. Re-emit with a rejection that
        // hints at the expected format.
        const stay_patch: Record<string, unknown> = {
          active_prompt_id: null,
          last_choice_value: choice_value,
          ...(freeform !== null ? { last_choice_freeform: freeform } : {}),
          projects_proposed_rejection:
            "I couldn't pick out specific projects from that. Try listing one per line, or comma-separated.",
        }
        const stayed = await this.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: 'projects_proposed',
          phase_state_patch: stay_patch,
          advanced_at: observed_at,
        })
        // Codex r1 (PR #270 carry-over) — drop the resolved-spec cache
        // that the pre-resolve at the top of this branch warmed with
        // the PRE-rejection phase_state (no `projects_proposed_rejection`
        // text). Without this, `emitPhasePrompt` re-uses the cached
        // spec and never renders the rejection guidance into the body
        // — the user sees the same "share your projects" body they
        // tapped through to land here.
        this.invalidateResolvedSpec(input.project_slug, 'projects_proposed')
        let final_state: OnboardingState | null = null
        const emit = await this.emitPhasePrompt({
          project_slug: input.project_slug,
          user_id: input.user_id,
          topic_id: input.topic_id,
          phase: 'projects_proposed',
          observed_at,
          pre_send_state_upsert: async (prompt_id: string) => {
            final_state = await this.deps.stateStore.upsert({
              project_slug: input.project_slug,
              user_id: input.user_id,
              phase: 'projects_proposed',
              phase_state_patch: { active_prompt_id: prompt_id },
              advanced_at: observed_at,
            })
          },
        })
        return {
          outcome: 'reemitted_current',
          state: final_state ?? stayed,
          prompt_id: emit.prompt_id,
        }
      }
      const stay_patch: Record<string, unknown> = {
        active_prompt_id: null,
        last_choice_value: choice_value,
        ...(freeform !== null ? { last_choice_freeform: freeform } : {}),
        primary_projects: [...final_projects],
        projects_proposed_share_freeform: null,
        projects_proposed_rejection: null,
      }
      const stayed = await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'projects_proposed',
        phase_state_patch: stay_patch,
        advanced_at: observed_at,
      })
      // Codex r1 (PR #270 carry-over) — drop the resolved-spec cache
      // that the pre-resolve at the top of this branch warmed BEFORE
      // `primary_projects` was persisted. Without this, the cached
      // spec snapshots the pre-share zero-state projects and
      // `emitPhasePrompt` re-emits the empty "share what you're
      // working on" body even though the user just listed real
      // projects.
      this.invalidateResolvedSpec(input.project_slug, 'projects_proposed')
      let final_state: OnboardingState | null = null
      const emit = await this.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: 'projects_proposed',
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await this.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: 'projects_proposed',
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      return {
        outcome: 'reemitted_current',
        state: final_state ?? stayed,
        prompt_id: emit.prompt_id,
      }
    }

    if (choice_value === PROJECTS_PROPOSED_SHARE_WORK && !awaiting_share_freeform) {
      this.invalidateResolvedSpec(input.project_slug, 'projects_proposed')
      const stay_patch: Record<string, unknown> = {
        active_prompt_id: null,
        last_choice_value: choice_value,
        projects_proposed_share_freeform: true,
        projects_proposed_rejection: null,
      }
      const stayed = await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'projects_proposed',
        phase_state_patch: stay_patch,
        advanced_at: observed_at,
      })
      let final_state: OnboardingState | null = null
      const emit = await this.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: 'projects_proposed',
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await this.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: 'projects_proposed',
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      return {
        outcome: 'reemitted_current',
        state: final_state ?? stayed,
        prompt_id: emit.prompt_id,
      }
    }

    // v0.1.80 — zero-state skip-ahead button. Advance directly with
    // empty primary_projects_confirmed[]; the user opted to set things
    // up as they go.
    if (choice_value === PROJECTS_PROPOSED_SKIP_AHEAD) {
      if (!isLegalTransition('projects_proposed', 'persona_synthesizing')) {
        throw new InterviewError(
          'projects_proposed',
          'illegal_transition',
          false,
          'projects_proposed → persona_synthesizing is not legal',
        )
      }
      const advance_patch: Record<string, unknown> = {
        active_prompt_id: null,
        last_choice_value: choice_value,
        primary_projects_confirmed: [],
        projects_proposed_confirm_kind: 'skip-ahead-zero-state',
        projects_proposed_rejection: null,
        projects_proposed_share_freeform: null,
      }
      const advanced = await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: 'persona_synthesizing',
        phase_state_patch: advance_patch,
        advanced_at: observed_at,
      })
      let advanced_final = AUTO_SKIP_PHASES.has(advanced.phase)
        ? await this.walkAutoSkip(input.project_slug, advanced, observed_at)
        : advanced
      if (advanced_final.phase === 'persona_synthesizing') {
        advanced_final = await this.synthesizePersona(input, advanced_final, observed_at)
      }
      const next_phase_final = advanced_final.phase
      const next_spec = STATIC_PHASE_SPECS[next_phase_final]
      if (next_spec !== undefined && !TERMINAL_PHASES.has(next_phase_final)) {
        let final_state: OnboardingState | null = null
        const emit = await this.emitPhasePrompt({
          project_slug: input.project_slug,
          user_id: input.user_id,
          topic_id: input.topic_id,
          phase: next_phase_final,
          observed_at,
          pre_send_state_upsert: async (prompt_id: string) => {
            final_state = await this.deps.stateStore.upsert({
              project_slug: input.project_slug,
              user_id: input.user_id,
              phase: next_phase_final,
              phase_state_patch: { active_prompt_id: prompt_id },
              advanced_at: observed_at,
            })
          },
        })
        if (final_state === null) {
          final_state =
            (await this.deps.stateStore.get(input.project_slug, input.user_id)) ??
            advanced_final
        }
        return { outcome: 'advanced', state: final_state, prompt_id: emit.prompt_id }
      }
      return { outcome: 'advanced', state: advanced_final }
    }

    // The confirmed list is the projects already seeded on `phase_state`.
    // GAP1 (onboarding-wow-handoff-fix, 2026-06-09) — confirm is ADDITIVE:
    // freeform edits ("drop #2, add Studio Sessions") on the conversational
    // path are extracted + unioned-minus-removals upstream by
    // `dispatchRouterDecision`'s projects_proposed branch before this
    // handler runs, so the persisted `primary_projects` is already the
    // post-edit view. Confirm it here; never silently shrink it.
    const merged_projects =
      readStringArray(state.phase_state as Record<string, unknown>, 'primary_projects') ?? []
    const review_requested = choice_value === PROJECTS_PROPOSED_REVIEW
    // GAP1 — project funnel telemetry: make proposed → confirmed divergence
    // observable instead of silent. `presented` is what the user could see
    // (capped at MAX_ANALYSIS_PROJECTS); `confirmed` is what we shell.
    logProjectFunnel({
      project_slug: input.project_slug,
      stage: 'projects_proposed_confirm',
      proposed: importProposedCount(state.phase_state as Record<string, unknown>),
      presented: Math.min(
        importProposedCount(state.phase_state as Record<string, unknown>),
        MAX_ANALYSIS_PROJECTS,
      ),
      confirmed: merged_projects.length,
    })

    if (!isLegalTransition('projects_proposed', 'persona_synthesizing')) {
      throw new InterviewError(
        'projects_proposed',
        'illegal_transition',
        false,
        'projects_proposed → persona_synthesizing is not legal',
      )
    }
    const advance_patch: Record<string, unknown> = {
      active_prompt_id: null,
      last_choice_value: choice_value,
      ...(freeform !== null ? { last_choice_freeform: freeform } : {}),
      primary_projects_confirmed: [...merged_projects],
      projects_proposed_confirm_kind:
        choice_value === PROJECTS_PROPOSED_CONFIRM
          ? 'auto-create'
          : review_requested
            ? 'review-deferred'
            : 'freeform',
      projects_proposed_rejection: null,
    }
    const advanced = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'persona_synthesizing',
      phase_state_patch: advance_patch,
      advanced_at: observed_at,
    })
    let advanced_final = AUTO_SKIP_PHASES.has(advanced.phase)
      ? await this.walkAutoSkip(input.project_slug, advanced, observed_at)
      : advanced
    if (advanced_final.phase === 'persona_synthesizing') {
      advanced_final = await this.synthesizePersona(input, advanced_final, observed_at)
    }
    const next_phase_final = advanced_final.phase
    const next_spec = STATIC_PHASE_SPECS[next_phase_final]
    if (next_spec !== undefined && !TERMINAL_PHASES.has(next_phase_final)) {
      let final_state: OnboardingState | null = null
      const emit = await this.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: next_phase_final,
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await this.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: next_phase_final,
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final_state === null) {
        final_state = (await this.deps.stateStore.get(input.project_slug, input.user_id)) ?? advanced_final
      }
      return { outcome: 'advanced', state: final_state, prompt_id: emit.prompt_id }
    }
    return { outcome: 'advanced', state: advanced_final }
  }

  /**
   * Gate-collapse (#93, 2026-06-05) — auto-confirm `projects_proposed`.
   *
   * Sam's 2026-06-05 signup hit a redundant second approval gate: after
   * reviewing the project list at `import_analysis_presented` (the single
   * content-review gate), he was shown the SAME list again at
   * `projects_proposed` behind a "Good to go" button — "Why do I have to
   * approve them twice." This helper collapses that gate: on landing on
   * `projects_proposed` we auto-confirm the already-reviewed list
   * (`primary_projects`, falling back to `import_result.proposed_projects`)
   * by writing `primary_projects_confirmed[]` and advancing straight to
   * `persona_synthesizing` → `synthesizePersona`. No button is emitted.
   *
   * `projects_proposed` is DELIBERATELY kept in the enum and as the
   * slug-rename redirect anchor (v0.1.133): `advanceFromSlugChosen` still
   * lands the rekeyed row here so the renamed gateway finds it on
   * reconnect. This helper is invoked at the THREE points where the gate
   * button would otherwise be shown — the skip-slug inline advance, the
   * no-restart slug-rename inline advance, and the renamed gateway's
   * post-redirect `start()` — so the phase is traversed but never
   * surfaced. `consumeProjectsProposedChoice` is retained intact for the
   * defensive case where a freeform "drop X / add Y" reply still reaches
   * the phase (e.g. a stale in-flight prompt).
   *
   * Shell creation is unaffected: project shells are built later in the
   * wow-moment from `primary_projects_confirmed[]` (fallback
   * `import_result.proposed_projects`, MIN 2 — `wow-moment/actions/
   * 03-project-shells.ts`), so writing the confirmed list here preserves
   * the wow-moment's inputs.
   *
   * Argus r2 zero-state guard — the auto-confirm ONLY fires when there is a
   * reviewed list to collapse the redundant gate on. If BOTH `primary_projects`
   * and `import_result.proposed_projects` are empty, auto-confirming would
   * write `primary_projects_confirmed: []` and commit the user to an empty
   * workspace (confirmed+empty reads as "explicitly declined" downstream → 0
   * shells). In that case we re-emit the zero-state `projects_proposed` prompt
   * ("Share what I'm working on" / "Skip for now") and leave the row parked so
   * the user chooses, rather than silently advancing.
   */
  async autoConfirmProjectsProposedAndAdvance(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const phase_state = state.phase_state as Record<string, unknown>
    const reviewed = readStringArray(phase_state, 'primary_projects') ?? []
    const import_result = phase_state['import_result']
    const proposed_from_import: ReadonlyArray<string> =
      import_result !== null &&
      typeof import_result === 'object' &&
      Array.isArray((import_result as Record<string, unknown>)['proposed_projects'])
        ? ((import_result as Record<string, unknown>)['proposed_projects'] as unknown[]).filter(
            (p): p is string => typeof p === 'string' && p.trim().length > 0,
          )
        : []
    const confirmed = reviewed.length > 0 ? reviewed : proposed_from_import

    // Argus r2 — zero-state guard. When BOTH the reviewed list
    // (`primary_projects`) and the import-proposed list
    // (`import_result.proposed_projects`) are empty there is NO
    // already-reviewed content to silently auto-confirm. Writing
    // `primary_projects_confirmed: []` here and advancing would commit the
    // user to an empty workspace: `buildWowSignalsFromState` flips
    // `projects_confirmed: true` on the present-but-empty array, and
    // `wow-moment/actions/03-project-shells.ts` reads confirmed+empty as
    // "user explicitly declined" → ZERO shells created. The user would
    // never see the retained zero-state prompt ("Share what I'm working
    // on" / "Skip for now"). So do NOT auto-confirm: re-emit the zero-state
    // `projects_proposed` prompt and leave the row parked there so the user
    // makes the call (share work → shells, or skip → explicit decline).
    // The auto-confirm gate-collapse only applies when there IS a reviewed
    // list to collapse the redundant second approval on.
    if (confirmed.length === 0) {
      this.invalidateResolvedSpec(input.project_slug, 'projects_proposed')
      let final_state: OnboardingState | null = null
      const emit = await this.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: 'projects_proposed',
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await this.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: 'projects_proposed',
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final_state === null) {
        final_state =
          (await this.deps.stateStore.get(input.project_slug, input.user_id)) ?? state
      }
      return {
        outcome: 'reemitted_current',
        state: final_state,
        prompt_id: emit.prompt_id,
      }
    }

    if (!isLegalTransition('projects_proposed', 'persona_synthesizing')) {
      throw new InterviewError(
        'projects_proposed',
        'illegal_transition',
        false,
        'projects_proposed → persona_synthesizing is not legal',
      )
    }
    // GAP1 — funnel telemetry on the gate-collapse (the live auto-confirm
    // path Sam hit on 2026-06-09). `confirmed` here is the reviewed
    // `primary_projects`; with the additive-merge + extraction-prompt fixes
    // upstream it should equal the user's full named set (picks + additions).
    logProjectFunnel({
      project_slug: input.project_slug,
      stage: 'gate_collapse_auto_confirm',
      proposed: importProposedCount(phase_state),
      presented: Math.min(importProposedCount(phase_state), MAX_ANALYSIS_PROJECTS),
      confirmed: confirmed.length,
    })
    const advance_patch: Record<string, unknown> = {
      active_prompt_id: null,
      primary_projects_confirmed: [...confirmed],
      projects_proposed_confirm_kind: 'auto-confirm-post-review',
      projects_proposed_rejection: null,
      projects_proposed_share_freeform: null,
    }
    const advanced = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'persona_synthesizing',
      phase_state_patch: advance_patch,
      advanced_at: observed_at,
    })
    let advanced_final = AUTO_SKIP_PHASES.has(advanced.phase)
      ? await this.walkAutoSkip(input.project_slug, advanced, observed_at)
      : advanced
    if (advanced_final.phase === 'persona_synthesizing') {
      advanced_final = await this.synthesizePersona(input, advanced_final, observed_at)
    }
    const next_phase_final = advanced_final.phase
    const next_spec = STATIC_PHASE_SPECS[next_phase_final]
    if (next_spec !== undefined && !TERMINAL_PHASES.has(next_phase_final)) {
      let final_state: OnboardingState | null = null
      const emit = await this.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: next_phase_final,
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await this.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: next_phase_final,
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final_state === null) {
        final_state = (await this.deps.stateStore.get(input.project_slug, input.user_id)) ?? advanced_final
      }
      return { outcome: 'advanced', state: final_state, prompt_id: emit.prompt_id }
    }
    return { outcome: 'advanced', state: advanced_final }
  }

  /**
   * T4 (2026-05-13) — import_offered handler. The user is picking a
   * history-import source. Per docs/plans/P2-onboarding.md § 2.3 + § 4.7:
   *
   *   - `skip` → record `import_result=null`, advance to `archetype_picked`,
   *     do NOT call `importJobRunner.start`.
   *   - `chatgpt_zip` / `claude_zip` → resolve the payload via
   *     `importPayloadResolver` (or fall through to an empty buffer when
   *     unwired), call `importJobRunner.start(...)`, stash the
   *     `job_id` + `source` in phase_state, advance to `import_running`,
   *     then poll once so a fast-completing job (cached chunks, empty
   *     export) lands on `archetype_picked` in the same turn.
   *   - Unknown / non-advancing values → re-emit the import_offered
   *     spec via the standard emit path.
   *
   * When `importJobRunner` is unwired (composer drift / dev mode), the
   * zip choices collapse to the skip path with a soft log so the user
   * is never stranded.
   */
  async consumeAiSubstrateOfferedChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    return importRoutingConsumeAiSubstrateOfferedChoice(this, input, state, choice, was_new, observed_at)
  }

  /**
   * T4 / Codex r3 P1 (post-T4) — paste-URL prompt per the P2 spec
   * § 2.3 v1 contract. After the user picks ChatGPT/Claude zip, if
   * the payload resolver has not yet landed a Buffer for that source,
   * emit a prompt asking the user to paste a presigned URL pointing
   * to their export zip. The next freeform inbound is the URL; the
   * paste sub-flow (`acceptPastedImportUrlAndStart`) fetches the
   * bytes and kicks off the runner.
   *
   * `phase_state.import_pending_source` is the marker for the sub-flow.
   * On Skip, the engine clears it and advances to archetype_picked.
   */
  async emitImportOfferedPastePrompt(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
  ): Promise<AdvanceResult> {
    return importRoutingEmitImportOfferedPastePrompt(this, input, state, observed_at, source)
  }

  async reEmitImportOfferedPaste(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
    rejection: string | null,
  ): Promise<AdvanceResult> {
    return importRoutingReEmitImportOfferedPaste(this, input, state, observed_at, source, rejection)
  }

  /**
   * T4 / Codex r3 P1 (post-T4) — handle the user's freeform URL paste
   * on the import_offered paste prompt. Persists the URL to
   * `phase_state.import_paste_url_<source>` so the
   * `UrlPasteImportPayloadResolver` can read it on the resolve call,
   * clears the pending-source marker, then delegates back through the
   * normal start path which calls resolver.resolve and kicks off
   * runner.start with the fetched Buffer.
   */
  async acceptPastedImportUrlAndStart(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
    url: string,
  ): Promise<AdvanceResult> {
    return importRoutingAcceptPastedImportUrlAndStart(this, input, state, observed_at, source, url)
  }

  /**
   * P2 v2 § 2.8 — common tail for `ai_substrate_offered` → next-phase
   * transitions that don't kick off a job. The legacy "skip" path
   * (formerly `import_offered → archetype_picked`) now routes to
   * `work_interview_gap_fill` so the engine collects the missing
   * required fields via the LLM-driven gap-fill loop (S5). The runner
   * kickoff still routes through this helper via the import_upload_pending
   * branch — but in S2 the skeleton wires the substrate-choice +
   * runner-start path; the upload UX lands in S3.
   */
  /**
   * P2 v2 § 3.4 → § 3.5 — when the user picks a v2 substrate
   * (`chatgpt` / `claude`) the engine advances to
   * `import_upload_pending` so the next bubble shows download
   * instructions + the upload affordance. S3 wires the actual upload
   * endpoint + dynamic body (renders the correct download block
   * depending on `ai_substrate_used`). The skeleton parks the chosen
   * substrate on `phase_state.ai_substrate_used` so S3 has the input
   * it needs.
   */
  async advanceFromAiSubstrateOfferedToUpload(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    ai_substrate_used: 'chatgpt' | 'claude',
  ): Promise<AdvanceResult> {
    return importRoutingAdvanceFromAiSubstrateOfferedToUpload(this, input, state, observed_at, ai_substrate_used)
  }

  async advanceFromAiSubstrateOffered(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    opts: { skipped: boolean; source: ImportSource | null; job_id: string | null },
  ): Promise<AdvanceResult> {
    return importRoutingAdvanceFromAiSubstrateOffered(this, input, state, observed_at, opts)
  }

  /**
   * T4 (2026-05-13) — poll the runner and decide what to surface to
   * the user. Called from:
   *
   *   1. The `import_offered` → `import_running` transition right
   *      after `runner.start(...)`.
   *   2. `engine.start(...)` crash-resume when phase=import_running
   *      and no terminal status has landed on phase_state yet.
   *   3. A user inbound on the import_running status body (re-emit).
   *
   * Routing per runner.status (v0.1.78 — `budget-exceeded` no longer
   * exists; replaced by `rate_limit_cooling_off` / `rate_limit_paused`):
   *   - `queued` / `pass1-running` / `pass2-running` / `rate_limit_cooling_off`
   *     → emit live status body (progress, with cooling-off framing
   *     when applicable) + stay at `import_running`.
   *   - `rate_limit_paused` → emit the quieter "still waiting on
   *     Claude's rate limit" body; stay at `import_running`. The runner
   *     gave up after the ~30 min backoff window but the cached Pass-1
   *     work survives — a future runner.start resumes at $0.
   *   - `completed` → stash `import_result`, advance to `import_analysis_presented`.
   *   - `failed` → advance to `import_analysis_presented` with
   *     `import_failed=true` so the body renders the graceful
   *     "couldn't analyze" framing.
   *   - `cancelled` → advance to archetype_picked with `import_result=null`.
   *
   * Hard-timeout suppression: when status is rate_limit_* the engine
   * BYPASSES the `IMPORT_RUNNING_HARD_TIMEOUT_MS` fallback (would
   * otherwise advance to gap-fill at 15 min). The brief mandates NO
   * automatic fallback to gap_fill on rate limit.
   */
  async pollImportRunningAndAdvance(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    opts?: { suppress_in_progress_status_emit?: boolean },
  ): Promise<AdvanceResult> {
    return importRoutingPollImportRunningAndAdvance(this, input, state, observed_at, opts)
  }

  /**
   * Argus r1 fix (PR #271, 2026-05-22) — auto-resume a paused job.
   *
   * Called by `pollImportRunningAndAdvance` after observing
   * `status='rate_limit_paused'` AND `now - last_paused_at >=
   * COOLDOWN_AFTER_PAUSED_MS`. Re-resolves the payload via the wired
   * `importPayloadResolver` (which already handles both the upload-zip
   * filesystem path and the OAuth refs path) and dispatches a fresh
   * `runner.start(...)`. The runner creates a NEW job_id; the engine
   * stitches it onto `phase_state.import_job_id` so subsequent poll
   * ticks see the new job. The cached Pass-1 chunks survive across
   * `runner.start` calls (per-chunk dedup is keyed by
   * `(project_slug, source, chunk_hash)`, not by job_id), so the new
   * attempt picks up at $0 from wherever the prior one paused.
   *
   * Returns `{ state }` (the freshly upserted onboarding-state row with
   * the new job_id stitched in) on success. Returns `null` on any
   * failure — the caller falls through to the existing paused-body
   * emit and the cron retries on the next tick.
   *
   * Idempotency: the per-chunk dedup table makes a duplicate
   * `runner.start` call against the same payload safe even under a
   * cron-vs-user-inbound race. The transcript logs both start events
   * so operators can audit the resume cycle in journald.
   */
  async attemptAutoResumeFromPaused(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    source: ImportSource,
    prior_job_id: string,
    prior_job: ImportJob | null,
    opts: { reset_cycle_counter?: boolean } = {},
  ): Promise<{ state: OnboardingState } | null> {
    return importRoutingAttemptAutoResumeFromPaused(this, input, state, observed_at, source, prior_job_id, prior_job, opts)
  }

  /**
   * ISSUES #91 — terminal degrade path for the bounded auto-resume loop.
   * Fires once `import_rate_limit_resume_count` reaches
   * MAX_RATE_LIMIT_RESUME_CYCLES with no forward Pass-1 progress: the rate
   * limit is genuinely saturated and no amount of additional backoff will
   * clear it. Rather than loop forever (or strand the user) we:
   *
   *   1. Cancel the paused runner so no stray cron tick resumes it again.
   *   2. Salvage whatever Pass-1 signal reached the cache via
   *      `synthesizeOnDemand` (preferDegraded — under sustained rate limit a
   *      fresh Pass-2 would just 429 too; the cheap aggregated-from-cache
   *      path surfaces the extracted entities/topics without spend).
   *   3. Advance to `import_analysis_presented` with `import_partial=true`
   *      when there is real signal to show, else `import_failed=true` (the
   *      graceful "couldn't analyze the export, but let's chat it through"
   *      framing). Either way the user is unstranded and the cached Pass-1
   *      work is NOT discarded — directly fixing the prod symptom where the
   *      import "fell through to gap-fill with no extracted signals".
   */
  async degradeRateLimitExhausted(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    job_id: string,
    job: ImportJob,
    resume_count: number,
  ): Promise<AdvanceResult> {
    return importRoutingDegradeRateLimitExhausted(this, input, state, observed_at, job_id, job, resume_count)
  }

  /**
   * P2 v2 § 3.7 / S5 — tail for the runner's `completed` (and hard-
   * timeout) status. Persists the ImportResult to
   * `phase_state.import_result` (downstream wow-moment dispatcher +
   * analysis presentation both read this) and advances to
   * `import_analysis_presented` so the user sees the "anything I
   * missed?" wow moment.
   *
   * S5 additions:
   *   - When `import_result` is non-null, populates
   *     `phase_state.primary_projects` from
   *     `import_result.proposed_projects[*].name` (verbatim) and
   *     `phase_state.non_work_interests` from
   *     `import_result.inferred_interests` (verbatim). This is what
   *     `auditRequiredFields` reads at the analysis-presented advance
   *     turn to decide whether to route into `personality_offered`
   *     (audit clean for those two fields) or `work_interview_gap_fill`
   *     (audit reports missing).
   *   - When `failure_reason` is non-null, stamps
   *     `phase_state.import_failed=true` + `import_failure_reason=<reason>`.
   *     The dynamic body builder renders the graceful "couldn't
   *     analyze" framing in that case (§ 3.6 fail-path).
   */
  async advanceFromImportRunningOnComplete(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    import_result: ImportResult | null,
    partial: boolean,
    failure_reason: string | null = null,
  ): Promise<AdvanceResult> {
    return importRoutingAdvanceFromImportRunningOnComplete(this, input, state, observed_at, import_result, partial, failure_reason)
  }

  /**
   * P2 v2 § 2.4 + § 3.7 / S5 — handle the user's freeform reply to the
   * import_analysis_presented wow-moment body. The reply is appended to
   * `phase_state.user_supplied_corrections[]`; the engine then runs
   * `auditRequiredFields(...)` over the merged phase_state and routes:
   *
   *   - audit's `next_to_collect` ∈ {null, agent_personality, agent_name}
   *     (i.e. the first three required fields are filled — those are
   *     all that import + this turn can fill) → advance to
   *     `personality_offered` directly. The downstream phases pick up
   *     the remaining two fields.
   *   - else → advance to `work_interview_gap_fill` so S6's LLM-driven
   *     self-loop can ask for the missing required fields one at a
   *     time.
   *
   * The handler does NOT run the LLM extractor over the freeform reply
   * — that's the gap-fill phase's job (S6). The corrections array is
   * persisted as raw text so the gap-fill handler can see the user's
   * own words when composing the next question.
   *
   * Button-tap path: the spec doesn't define button options for this
   * phase. If a tap somehow lands here (e.g. an instrumentation
   * harness firing a synthetic option), we still capture and route —
   * the button value is recorded as a correction so nothing is lost.
   */
  async consumeImportAnalysisPresentedChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    return importRoutingConsumeImportAnalysisPresentedChoice(this, input, state, choice, was_new, observed_at)
  }

  /**
   * P2 v2 § 2.4 / S6 — handle the user's freeform reply to the gap-fill
   * question. EXTRACT-then-ADVANCE (the shipped ISSUES #323 / PR #20
   * behavior). The handler:
   *
   *   1. Appends the user reply to transcript so the router sees it in
   *      `recent_turns`.
   *   2. Extracts the volunteered fields (primary_projects /
   *      non_work_interests) via the `llmRouter` — best-effort: when the
   *      conversational router was already consulted upstream
   *      (`shouldConsultRouter` true) the fields were merged into
   *      `phase_state` before this handler ran, so we skip the re-call;
   *      otherwise we consult the router directly here.
   *   3. Merges the extraction into a phase_state patch (array-shape
   *      fields APPEND, deduped) and advances to `personality_offered`.
   *
   * 2026-06-21 consolidation: the old driver-only audit-clean / 5-iteration
   * cap / stay-and-loop self-loop was removed. It was only ever reachable
   * when the (never-wired-in-prod) `promptDriver` fired, so the live engine
   * has always advanced after one extraction turn. Collapsing onto the
   * single `llmRouter` seam keeps exactly that — the user is never trapped
   * in a loop or stranded in a `phase='failed'` dead-end.
   */
  private async consumeWorkInterviewGapFillChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const reply_text =
      choice.choice_value === '__freeform__' &&
      typeof choice.freeform_text === 'string' &&
      choice.freeform_text.trim().length > 0
        ? choice.freeform_text.trim()
        : choice.choice_value

    // Codex r1 P1 (2026-05-16) — duplicate-callback idempotency. When
    // `ButtonStore.resolve()` returns `was_new=false`, the choice has
    // already been consumed on a prior advance call (typical cause:
    // a webhook re-delivery or a client-side resend after a flaky
    // socket reconnect). Re-running extraction / bumping the
    // iteration counter / re-routing would burn a turn the user never
    // took and could spuriously advance to `personality_offered` or
    // transition to `failed`. Return the current state untouched so
    // the engine's documented at-least-once delivery contract stays
    // safe.
    if (!was_new) {
      return { outcome: 'no_active_prompt', state }
    }

    this.deps.transcript.append({
      role: 'user',
      body: reply_text,
      phase: state.phase,
      button_prompt_id: choice.prompt_id,
      button_choice: choice.choice_value,
    })

    // Extract gap-fill fields from the just-appended reply via the LLM
    // router — the SINGLE extraction seam for the onboarding engine. The
    // older `promptDriver` envelope (which also returned `extracted_fields`)
    // was removed in the 2026-06-21 consolidation; the router is now the
    // only path that pulls `primary_projects` / `non_work_interests` out of
    // a freeform answer.
    //
    // The gap-fill turn EXTRACTS-then-ADVANCES to `personality_offered`
    // (the shipped ISSUES #323 / PR #20 behavior). Production never wired
    // the old `promptDriver`, so the driver-only "audit-clean / 5-iteration
    // cap / stay-and-loop" self-loop was dead code on every real install —
    // gap-fill has always advanced after one extraction turn. Consolidating
    // onto the single router seam keeps exactly that: never strand the user
    // in a loop or a `phase='failed'` dead-end.
    //
    // ISSUES #323 — best-effort by contract: a missing router, a router
    // error, a parse-fail, or a no-delta classification yields a `null`
    // extraction → an empty merge → still advance (the deterministic
    // LLM-less / E2E-mock walk just advances with `{}`). We do NOT route
    // through `dispatchRouterDecision`'s synthesised-advance re-prompt path,
    // so a garbage/unparseable model reply can never trap the user.
    //
    // Guard against a double router call: when the conversational router IS
    // consulted for this phase, `advance` already routed the reply upstream
    // and `consumeChoice` merged its `state_delta` into `phase_state` BEFORE
    // this handler ran — so the fields are already persisted and re-calling
    // here would double-bill the LLM. Only extract directly when the router
    // was NOT consulted upstream (`shouldConsultRouter` false).
    const active_sub_step = deriveActiveSubStep(state.phase, state.phase_state)
    const extracted = this.shouldConsultRouter(state.phase, active_sub_step)
      ? null
      : await this.extractGapFillFieldsViaRouterBestEffort(input, state, reply_text)

    // Merge the extracted fields into the advance patch. Array-shape fields
    // APPEND (deduped case-insensitively) to whatever was there before;
    // single-value fields overwrite (the LLM sanitized them). Returns `{}`
    // when nothing was extracted, so we always advance with a safe patch.
    const merge_patch = this.mergeGapFillExtractedFields(state.phase_state, extracted)
    return await this.advanceFromGapFillToPersonality(
      input,
      observed_at,
      merge_patch,
      choice,
    )
  }

  /**
   * Merge S6 gap-fill ExtractedFields into a phase_state patch. Array-
   * shape fields are APPENDED to any prior list on `phase_state`
   * (deduped case-insensitively); single-value fields overwrite. The
   * caller spreads the result into the `phase_state_patch` of the next
   * upsert. Always non-null (returns an empty patch when `fields` is
   * null) so the caller can spread unconditionally.
   */
  private mergeGapFillExtractedFields(
    prior_phase_state: Record<string, unknown>,
    fields: ExtractedFields | null,
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    if (fields === null) return patch
    // Single-value fields — latest wins (LLM sanitized).
    if (fields.user_first_name !== undefined) patch['user_first_name'] = fields.user_first_name
    if (fields.agent_personality !== undefined) {
      patch['agent_personality'] = fields.agent_personality
    }
    if (fields.agent_name !== undefined) patch['agent_name'] = fields.agent_name
    if (fields.time_style !== undefined) patch['time_style'] = fields.time_style
    if (fields.work_pattern !== undefined) patch['work_pattern'] = fields.work_pattern
    // Slug + archetypes also fold via the normal route (the LLM may
    // smuggle these into a gap-fill reply if the user volunteers them).
    if (fields.slug !== undefined) patch['suggested_slug'] = fields.slug
    if (fields.archetypes !== undefined) {
      patch['archetype_hint'] = fields.archetypes.join(', ')
    }
    if (fields.goal_one_liner !== undefined) patch['goal_one_liner'] = fields.goal_one_liner
    // Array-shape fields — append to prior list, dedupe case-
    // insensitively.
    if (fields.primary_projects !== undefined) {
      const prior = readGapFillStringArray(prior_phase_state, 'primary_projects')
      patch['primary_projects'] = dedupeStringsCaseInsensitive([
        ...prior,
        ...fields.primary_projects,
      ])
    }
    if (fields.non_work_interests !== undefined) {
      const prior = readNonWorkInterests(prior_phase_state)
      patch['non_work_interests'] = mergeNonWorkInterests(prior, fields.non_work_interests)
    }
    if (fields.rituals !== undefined) {
      const prior = readGapFillStringArray(prior_phase_state, 'rituals')
      patch['rituals'] = dedupeStringsCaseInsensitive([...prior, ...fields.rituals])
    }
    if (fields.inner_circle !== undefined) {
      const prior = readGapFillStringArray(prior_phase_state, 'inner_circle')
      patch['inner_circle'] = dedupeStringsCaseInsensitive([...prior, ...fields.inner_circle])
    }
    if (fields.companies !== undefined) {
      const prior = readGapFillStringArray(prior_phase_state, 'companies')
      patch['companies'] = dedupeStringsCaseInsensitive([...prior, ...fields.companies])
    }
    if (fields.user_supplied_corrections !== undefined) {
      const prior = readGapFillStringArray(prior_phase_state, 'user_supplied_corrections')
      patch['user_supplied_corrections'] = dedupeStringsCaseInsensitive([
        ...prior,
        ...fields.user_supplied_corrections,
      ])
    }
    return patch
  }

  /**
   * Upsert state → `personality_offered` with the merged gap-fill
   * fields, then emit the next phase's prompt. Mirrors the advance
   * tail in `consumeImportAnalysisPresentedChoice`.
   */
  private async advanceFromGapFillToPersonality(
    input: AdvanceInput,
    observed_at: number,
    merge_patch: Record<string, unknown>,
    choice: ButtonChoice,
  ): Promise<AdvanceResult> {
    const next_phase: OnboardingPhase = 'personality_offered'
    if (!isLegalTransition('work_interview_gap_fill', next_phase)) {
      throw new InterviewError(
        'work_interview_gap_fill',
        'illegal_transition',
        false,
        `gap_fill: illegal transition → ${next_phase}`,
      )
    }
    const advanced = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: next_phase,
      phase_state_patch: {
        ...merge_patch,
        active_prompt_id: null,
        last_choice_value: choice.choice_value,
        ...(choice.choice_value === '__freeform__' && typeof choice.freeform_text === 'string'
          ? { last_choice_freeform: choice.freeform_text }
          : {}),
      },
      advanced_at: observed_at,
    })
    // The next phase's spec is cached separately (different cache key);
    // we don't need to invalidate the gap_fill entry. Emit its prompt.
    let final_state: OnboardingState | null = null
    const emit = await this.emitPhasePrompt({
      project_slug: input.project_slug,
      user_id: input.user_id,
      topic_id: input.topic_id,
      phase: next_phase,
      observed_at,
      pre_send_state_upsert: async (prompt_id: string) => {
        final_state = await this.deps.stateStore.upsert({
          project_slug: input.project_slug,
          user_id: input.user_id,
          phase: next_phase,
          phase_state_patch: { active_prompt_id: prompt_id },
          advanced_at: observed_at,
        })
      },
    })
    if (final_state === null) {
      final_state = (await this.deps.stateStore.get(input.project_slug, input.user_id)) ?? advanced
    }
    return { outcome: 'advanced', state: final_state, prompt_id: emit.prompt_id }
  }

  /**
   * ISSUES #323 — best-effort gap-fill extraction via the LLM router.
   *
   * The `llmRouter` is the single extraction seam (the `promptDriver` envelope
   * was removed in the 2026-06-21 consolidation). In `advance`, the router is
   * gated behind `NEUTRON_ONBOARDING_CONVERSATIONAL` (`shouldConsultRouter`),
   * which now defaults ON. This helper consults the router DIRECTLY to pull
   * `primary_projects` / `non_work_interests` out of the reply on the path
   * where `shouldConsultRouter` is false (the explicit flag-OFF / freeform
   * sub_step bypass) so the freeform reply (e.g. an explicit project list) is
   * never dropped — gap-fill is fundamentally an extraction phase.
   *
   * Best-effort by contract: returns `null` (→ the caller advances with an
   * empty patch, the prior behavior) when no router is wired, the router throws,
   * the model output doesn't parse, or the decision carries no usable
   * `state_delta`. It does NOT re-prompt or loop on a parse-fail/synthesised
   * decision (unlike `dispatchRouterDecision`'s input-preserving advance), so an
   * unparseable model reply can never trap the user in a gap-fill loop — the
   * deterministic LLM-less / E2E-mock walk just advances with `{}` as before.
   */
  private async extractGapFillFieldsViaRouterBestEffort(
    input: AdvanceInput,
    state: OnboardingState,
    user_text: string | null,
  ): Promise<ExtractedFields | null> {
    const router = this.deps.llmRouter
    if (router === undefined) return null
    if (typeof user_text !== 'string' || user_text.trim().length === 0) return null
    const knowledge = getKnowledgeForPhase(state.phase)
    if (knowledge === null) return null
    const spec = STATIC_PHASE_SPECS[state.phase]
    if (spec === undefined) return null
    let decision: RouterDecision
    try {
      decision = await router.route({
        phase: state.phase,
        active_prompt: {
          body: spec.body,
          options: spec.options.map((o) => ({
            label: o.label,
            body: o.body,
            value: o.value,
          })),
          allow_freeform: spec.allow_freeform,
          pick_only: !spec.allow_freeform,
        },
        user_text,
        knowledge,
        captured: extractCapturedFromState(state.phase_state),
        recent_turns: recentTurnsForRouter(this.deps.transcript, 6),
        project_slug: input.project_slug,
        user_id: input.user_id,
        // Gap-fill is never the first session turn (signup precedes it), so the
        // steady-state budget is correct; never widen to the cold-spawn ceiling.
        first_turn: false,
      })
    } catch (err) {
      console.warn(
        `[engine] gap-fill best-effort router extraction threw for project=${input.project_slug}:`,
        err instanceof Error ? err.message : err,
      )
      return null
    }
    // Codex r1 [P2] — a SYNTHESISED advance is the router's timeout/parse-fail
    // fallback (`synthesised: 'timeout' | 'unparseable'`), whose `freeform_text`
    // is just the echoed/truncated user input, NOT a real classification.
    // `dispatchRouterDecision` treats it as a re-prompt, never an extraction, so
    // we must not persist projects parsed from an unclassified fallback (it could
    // be truncated, or a tangent/clarifying question the router couldn't read).
    // Bail to the existing advance-with-empty-patch path (the share-work flow at
    // projects_proposed still catches the list on a later, now-warm turn).
    if (decision.synthesised !== undefined) return null
    const extracted: ExtractedFields = {}
    // A non-null `state_delta` only ever arrives here in the REVIEW/CORRECTION
    // hybrid case (or a future amend smuggled onto this best-effort path); read
    // it first so that envelope still works.
    const delta = decision.state_delta
    if (delta !== null && delta !== undefined) {
      const deltaRec = delta as Record<string, unknown>
      const raw_projects = deltaRec['primary_projects']
      const projects = Array.isArray(raw_projects)
        ? raw_projects.filter(
            (p): p is string => typeof p === 'string' && p.trim().length > 0,
          )
        : []
      if (projects.length > 0) extracted.primary_projects = projects
      const interests = normalizeNonWorkInterestsForExtraction(
        deltaRec['non_work_interests'],
      )
      if (interests.length > 0) extracted.non_work_interests = interests
    }

    // ISSUES #323 (Argus r1 BLOCKER 1) — the real prod extraction seam.
    // The router contract reserves a non-null `state_delta` on an `advance`
    // for REVIEW/CORRECTION phases ONLY (llm-router.ts § REVIEW/CORRECTION —
    // "the one case where an advance carries a non-null state_delta").
    // `work_interview_gap_fill` is an OPEN ask ("what are you working on?"), so
    // the prompt-faithful envelope a real Haiku/Sonnet emits is
    // `action:'advance' + freeform_text:<verbatim reply> + state_delta:null`
    // (phase-spec-resolver.ts advance_examples teach a state_delta-FREE
    // free-text advance — "Topline, Northwind, Beacon, CC" → projects list →
    // free-text advance). Reading `state_delta` ALONE therefore extracts
    // nothing on the live path → the user's explicit project list is dropped →
    // the "I didn't pin down concrete projects" re-ask. When the delta carried
    // nothing, parse the field the gap-fill is currently collecting directly out
    // of the model's `freeform_text` — the only structured signal the contract
    // guarantees for this phase. Mirrors the established projects_proposed
    // share-freeform fallback (`splitFreeformProjectList`), but uses the
    // gap-fill list parser (`parseGapFillFreeformList`), which splits a direct
    // list reply on every comma / sentence boundary / "and" + strips list
    // lead-ins ("running three companies:", "side project", …). Gated on
    // `action === 'advance'` so a tangent ("why three projects?", classified
    // `answer`) is never mis-captured as the projects answer.
    if (
      Object.keys(extracted).length === 0 &&
      decision.action === 'advance' &&
      typeof decision.freeform_text === 'string' &&
      decision.freeform_text.trim().length > 0
    ) {
      const target = auditRequiredFields(state.phase_state).next_to_collect
      const items = parseGapFillFreeformList(decision.freeform_text)
      if (items.length > 0) {
        if (target === 'primary_projects') {
          extracted.primary_projects = items
        } else if (target === 'non_work_interests') {
          extracted.non_work_interests = items.map((name) => ({ name }))
        }
      }
    }

    return Object.keys(extracted).length > 0 ? extracted : null
  }

  /**
   * T4 (2026-05-13), rewritten v0.1.78 (2026-05-22) — render and emit
   * one of the `import_running` sub-prompts (status /
   * rate_limit_paused / failed). Bumps an attempt counter in the
   * idempotency seed so a re-emit of the same body+options doesn't
   * collapse onto a prior resolved row.
   */
  async emitImportRunningPromptSpec(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    opts: {
      sub_step: ImportRunningSubStep
      source: ImportSource | null
      pass1_chunks_done?: number
      pass1_chunks_total?: number
      failure_reason?: string
      is_long_running?: boolean
      is_rate_limit_cooling_off?: boolean
      using_max_oauth_chunking?: boolean
    },
  ): Promise<AdvanceResult> {
    return importRoutingEmitImportRunningPromptSpec(this, input, state, observed_at, opts)
  }

  /**
   * T4 (2026-05-13), rewritten v0.1.78 (2026-05-22) — handle the user's
   * pick on one of the `import_running` button prompts. After the
   * v0.1.78 budget-cap kill, only ONE prompt shape carries buttons:
   *
   *   - failed: retry / skip. Same as pre-v0.1.78.
   *
   * The status + rate_limit_paused sub-steps are freeform-only (no
   * buttons), so this method's button branches are exclusively the
   * failed-prompt routes.
   */
  async consumeImportRunningChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    return importRoutingConsumeImportRunningChoice(this, input, state, choice, was_new, observed_at)
  }

  /**
   * T4 (2026-05-13) — retry path for the failed prompt. Kicks off a
   * fresh `runner.start` with the same source (re-resolves payload via
   * the resolver) and polls.
   */
  async retryImportRunning(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult> {
    return importRoutingRetryImportRunning(this, input, state, observed_at)
  }

  /**
   * Emit a phase prompt with a strict ordering contract that prevents the
   * fast-tap race Codex r6 P1 flagged: the user can answer the moment
   * the channel renders the keyboard, but the engine must not receive
   * that answer before `phase_state.active_prompt_id` points at the new
   * prompt. Sequence:
   *
   *   1. Persist the prompt to ButtonStore (idempotent).
   *   2. Run the optional `pre_send_state_upsert(prompt_id)` callback so
   *      the caller can land the new active_prompt_id BEFORE the user
   *      ever sees the keyboard.
   *   3. Send the prompt to the channel.
   *   4. Mark delivered + append transcript line.
   *
   * Without step 2 in the middle, an inbound tap that arrives between
   * the channel send and the post-send state upsert finds
   * `active_prompt_id = null` and gets routed as no-active-prompt.
   */
  async emitPhasePrompt(input: {
    project_slug: string
    /**
     * ISSUES #2 (2026-05-19) — second PK component on `onboarding_state`.
     * Threaded so the spec resolver can read the correct (instance, user)
     * state when computing dynamic prompt bodies.
     */
    user_id: string
    topic_id: string
    phase: OnboardingPhase
    observed_at: number
    pre_send_state_upsert?: (prompt_id: string) => Promise<void>
    /**
     * Sprint 28 Codex r5 P1 — optional attempt-counter folded into the
     * idempotency seed so a re-emit with the same body+options does
     * NOT collapse onto a prior resolved row. Mirrors the slug-picker
     * `attempt_count` pattern. Pass when the same prompt may be
     * emitted multiple times within the same phase (e.g. Wait → Wait
     * → Wait while pipeline still pending).
     */
    seed_suffix?: string
  }): Promise<{ prompt_id: string }> {
    // P2 v2 — profile_pic_generating is removed from the v2 phase enum
    // (re-add when the Cores image-gen substrate ships). The
    // Sprint 28 `ensureProfilePicCandidates` pre-emit hook is no longer
    // reachable from any v2 phase.
    const spec = await this.resolvePhasePromptSpec(input.project_slug, input.user_id, input.phase)
    if (spec === null) {
      throw new InterviewError(
        input.phase,
        'prompt_emit_failed',
        false,
        `no prompt content for phase=${input.phase}`,
      )
    }
    // Idempotency seed: keep the legacy spec-body+options seed for
    // emitPhasePrompt. Re-emits within the same active_prompt_id span
    // serialize through the engine's `active_prompt_id` guard, so the
    // narrow race the LLM-driven start() path needed to defend against
    // (two concurrent first emits before active_prompt_id is persisted)
    // does NOT apply here. Letting the spec body drive the seed
    // preserves the property that an LLM re-emit with a legitimately
    // different body (e.g. user typed freeform on a non-freeform
    // prompt + the LLM's recent_turns now reflects that) creates a
    // new prompt row instead of silently collapsing onto the prior
    // delivered keyboard. The `start()` path uses a STATIC seed for
    // its own race-safety reasons (see `start()` body).
    const seed = canonicalPromptSeed({
      body: spec.body,
      options: spec.options.map((o) => ({ value: o.value })),
    })
    const seedTail =
      typeof input.seed_suffix === 'string' && input.seed_suffix.length > 0
        ? `:${input.seed_suffix}`
        : ''
    const idempotency_key = deriveIdempotencyKey({
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      seed: `${input.phase}:${seed}${seedTail}`,
    })
    const promptInput: Parameters<typeof buildButtonPrompt>[0] = {
      body: spec.body,
      options: spec.options.map((o) => {
        const opt: Parameters<typeof buildButtonPrompt>[0]['options'][number] = {
          label: o.label,
          body: o.body,
          value: o.value,
        }
        if (o.image_url !== undefined) opt.image_url = o.image_url
        return opt
      }),
      allow_freeform: spec.allow_freeform,
      idempotency_key,
      uuid: this.uuid,
    }
    if (spec.kind !== undefined) promptInput.kind = spec.kind
    if (spec.metadata !== undefined) promptInput.metadata = spec.metadata
    const prompt = buildButtonPrompt(promptInput)
    const emit = await this.deps.buttonStore.emit(prompt, { topic_id: input.topic_id })
    // Codex r6 P1 fix: persist the new active_prompt_id BEFORE sending
    // so a fast tap that arrives mid-send can resolve correctly.
    if (input.pre_send_state_upsert !== undefined) {
      await input.pre_send_state_upsert(emit.prompt_id)
    }
    if (emit.was_new || !emit.was_delivered) {
      let sendResult: Awaited<ReturnType<typeof this.deps.sendButtonPrompt>>
      try {
        sendResult = await this.deps.sendButtonPrompt({
          project_slug: input.project_slug,
          topic_id: input.topic_id,
          prompt: emit.prompt,
        })
      } catch (err) {
        throw new InterviewError(
          input.phase,
          'send_failed',
          true,
          `failed to send prompt for phase=${input.phase}`,
          err,
        )
      }
      // S16 (2026-05-17) — gate markDelivered + transcript-append on the
      // routed-sender's confirmation of actual delivery (mirrors the T10
      // fix in `start()` at the signup-phase emit). When the WS is dead
      // mid-flow (slug-rename race, user-closed-tab between an LLM
      // resolver's typing-indicator and the body landing) the routed
      // sender returns `was_new: false` silently. Pre-S16 the engine
      // marked the row delivered + appended a phantom agent line to the
      // transcript — leaving `start()`'s reconnect re-emit branch unable
      // to detect the silent drop. Now `delivered_at` stays null until
      // a real delivery confirms, so the next reconnect re-emits via
      // the `undelivered || topic_id_changed` branch above.
      if (sendResult.was_new) {
        await this.deps.buttonStore.markDelivered(emit.prompt_id, this.now())
        this.deps.transcript.append({
          role: 'agent',
          body: spec.body,
          phase: input.phase,
          button_prompt_id: emit.prompt_id,
        })
      } else {
        console.warn(
          `[engine.emitPhasePrompt] event=send-undelivered project=${input.project_slug} topic=${input.topic_id} prompt=${emit.prompt_id} phase=${input.phase} — leaving delivered_at=null so reconnect re-emit catches it`,
        )
      }
    }
    return { prompt_id: emit.prompt_id }
  }

  private async emitResumePrompt(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const body = buildResumePromptBody({ current_phase: state.phase })
    const seed = canonicalPromptSeed({
      body,
      options: RESUME_PROMPT_OPTIONS.map((o) => ({ value: o.value })),
    })
    // Codex r5 P1 fix: include a per-attempt counter in the idempotency
    // seed so a fresh resume cycle never reuses an already-resolved
    // button_prompts row. Without the counter, an owner who taps
    // resume-pause once would be permanently locked: the next stale
    // inbound rebuilds the SAME (state.phase, last_advanced_at) seed and
    // ButtonStore.emit() returns the prior prompt (now resolved with
    // 'resume-pause') instead of a fresh keyboard.
    const prior_attempt_count =
      typeof state.phase_state['resume_attempt_count'] === 'number'
        ? (state.phase_state['resume_attempt_count'] as number)
        : 0
    const next_attempt_count = prior_attempt_count + 1
    const idempotency_key = deriveIdempotencyKey({
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      seed: `resume:${state.phase}:${state.last_advanced_at}:${next_attempt_count}:${seed}`,
    })
    const prompt = buildButtonPrompt({
      body,
      options: RESUME_PROMPT_OPTIONS.map((o) => ({ ...o })),
      allow_freeform: false,
      idempotency_key,
      uuid: this.uuid,
    })
    const emit = await this.deps.buttonStore.emit(prompt, { topic_id: input.topic_id })
    // Codex r6 P1: persist resume_active_prompt_id BEFORE the channel
    // send so a fast tap finds the right pointer.
    const updated = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: state.phase,
      phase_state_patch: {
        resume_active_prompt_id: emit.prompt_id,
        topic_id: input.topic_id,
        resume_attempt_count: next_attempt_count,
      },
      // IMPORTANT: do NOT bump last_advanced_at here — the gap is the
      // signal that something stalled, and a fresh emit must NOT erase
      // the watchdog signal. Pass the existing last_advanced_at through.
      advanced_at: state.last_advanced_at,
    })
    if (emit.was_new || !emit.was_delivered) {
      try {
        await this.deps.sendButtonPrompt({
          project_slug: input.project_slug,
          topic_id: input.topic_id,
          prompt: emit.prompt,
        })
        await this.deps.buttonStore.markDelivered(emit.prompt_id, this.now())
      } catch (err) {
        throw new InterviewError(
          state.phase,
          'send_failed',
          true,
          `failed to send resume prompt for project=${input.project_slug}`,
          err,
        )
      }
      this.deps.transcript.append({
        role: 'agent',
        body,
        phase: state.phase,
        button_prompt_id: emit.prompt_id,
      })
    }
    return { outcome: 'resume_prompt_emitted', state: updated, prompt_id: emit.prompt_id }
  }

  private async reemitResumePrompt(
    input: AdvanceInput,
    state: OnboardingState,
    resume_active_id: string,
    observed_at: number,
  ): Promise<AdvanceResult> {
    // Codex r3 P2: actually re-render the resume prompt so a user who
    // missed / scrolled past the original message sees a fresh keyboard.
    // The prior implementation only appended a transcript line and
    // returned the stale prompt_id, leaving onboarding visibly stuck.
    if (input.freeform_text !== undefined && input.freeform_text.length > 0) {
      this.deps.transcript.append({
        role: 'user',
        body: input.freeform_text,
        phase: state.phase,
      })
    }
    const stored = await this.deps.buttonStore.get(resume_active_id, observed_at)
    if (stored !== null) {
      try {
        await this.deps.sendButtonPrompt({
          project_slug: input.project_slug,
          topic_id: input.topic_id,
          prompt: stored,
        })
      } catch (err) {
        throw new InterviewError(
          state.phase,
          'send_failed',
          true,
          `failed to re-send resume prompt for project=${input.project_slug}`,
          err,
        )
      }
      return { outcome: 'resume_prompt_emitted', state, prompt_id: resume_active_id }
    }
    // The prior resume prompt expired between emits — clear the marker so
    // the next advance() falls back into the stale-detection path and
    // emits a fresh resume prompt instead of looping forever on a dead id.
    const cleared = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: state.phase,
      phase_state_patch: { resume_active_prompt_id: null },
      advanced_at: state.last_advanced_at,
    })
    return await this.emitResumePrompt(input, cleared, observed_at)
  }

  private async handleResumeChoice(
    input: AdvanceInput,
    state: OnboardingState,
    resume_active_id: string,
    observed_at: number,
  ): Promise<AdvanceResult> {
    if (input.choice === undefined) {
      return { outcome: 'resume_prompt_emitted', state, prompt_id: resume_active_id }
    }
    let resolved: { was_new: boolean; choice: ButtonChoice }
    try {
      const r = await this.deps.buttonStore.resolve({ choice: input.choice })
      resolved = { was_new: r.was_new, choice: r.choice }
    } catch (err) {
      throw new InterviewError(
        state.phase,
        'unknown_prompt',
        true,
        `failed to resolve resume prompt`,
        err,
      )
    }
    if (resolved.was_new) {
      this.deps.transcript.append({
        role: 'user',
        body: resolved.choice.choice_value,
        phase: state.phase,
        button_prompt_id: input.choice.prompt_id,
        button_choice: resolved.choice.choice_value,
      })
    }
    const choice_value = resolved.choice.choice_value
    if (choice_value === 'resume-pause') {
      // Pause: clear the resume prompt id but keep state where it is.
      const updated = await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: state.phase,
        phase_state_patch: { resume_active_prompt_id: null },
        advanced_at: state.last_advanced_at,
      })
      return { outcome: 'resume_handled', state: updated }
    }
    if (choice_value === 'resume-restart') {
      // Restart: re-emit the current phase's prompt.
      let cleared = await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: state.phase,
        phase_state_patch: { resume_active_prompt_id: null, active_prompt_id: null },
        advanced_at: observed_at,
      })
      // 2026-05-12 (Codex r1) — an instance persisted directly on an
      // AUTO_SKIP_PHASE (e.g. name_chosen) at 24h+ inactivity will
      // surface the welcome-back prompt and the user may tap Restart.
      // Without the walker the engine re-emits the auto-skip phase
      // here, the guard at resolvePhasePromptSpecUncached returns null,
      // and emitPhasePrompt throws `no prompt content for phase=...`.
      // Walking past advances cleanly to the next user-visible phase
      // (slug_chosen) and emits its prompt — the same behaviour as
      // resume-continue from a stale `archetype_picked`.
      if (AUTO_SKIP_PHASES.has(cleared.phase)) {
        cleared = await this.walkAutoSkip(input.project_slug, cleared, observed_at)
      }
      const restart_phase = cleared.phase
      const spec = STATIC_PHASE_SPECS[restart_phase]
      if (spec === undefined) return { outcome: 'resume_handled', state: cleared }
      let final: OnboardingState | null = null
      const emit = await this.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: restart_phase,
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final = await this.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: restart_phase,
            phase_state_patch: { active_prompt_id: prompt_id, topic_id: input.topic_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final === null) {
        final = await this.deps.stateStore.get(input.project_slug, input.user_id) as OnboardingState
      }
      return { outcome: 'resume_handled', state: final, prompt_id: emit.prompt_id }
    }
    // Default = resume-continue. Advance out of the stalled phase.
    const spec = STATIC_PHASE_SPECS[state.phase]
    if (spec === undefined) {
      const updated = await this.deps.stateStore.upsert({
        project_slug: input.project_slug,
        user_id: input.user_id,
        phase: state.phase,
        phase_state_patch: { resume_active_prompt_id: null },
        advanced_at: observed_at,
      })
      return { outcome: 'resume_handled', state: updated }
    }
    const next_phase = spec.next_phase_on_default
    if (!isLegalTransition(state.phase, next_phase)) {
      throw new InterviewError(
        state.phase,
        'illegal_transition',
        false,
        `resume-continue: illegal transition ${state.phase} → ${next_phase}`,
      )
    }
    let advanced = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: next_phase,
      phase_state_patch: { resume_active_prompt_id: null, active_prompt_id: null },
      advanced_at: observed_at,
    })
    // 2026-05-12 — if the resume-continue target is in AUTO_SKIP_PHASES
    // (`name_chosen` today), walk past it so the next user-visible
    // prompt is the slug-picker body. Without this the resume path lands
    // the user on the suppressed gate and emitPhasePrompt throws
    // "no prompt content for phase=name_chosen" (the belt-and-braces
    // guard at resolvePhasePromptSpecUncached returns null for auto-skip
    // phases). Mirrors the normalAdvance walker invocation at the top
    // of normalAdvance().
    if (AUTO_SKIP_PHASES.has(advanced.phase)) {
      advanced = await this.walkAutoSkip(input.project_slug, advanced, observed_at)
    }
    const emit_phase = advanced.phase
    const next_spec = STATIC_PHASE_SPECS[emit_phase]
    if (next_spec !== undefined && !TERMINAL_PHASES.has(emit_phase)) {
      let final_state: OnboardingState | null = null
      const emit = await this.emitPhasePrompt({
        project_slug: input.project_slug,
        user_id: input.user_id,
        topic_id: input.topic_id,
        phase: emit_phase,
        observed_at,
        pre_send_state_upsert: async (prompt_id: string) => {
          final_state = await this.deps.stateStore.upsert({
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: emit_phase,
            phase_state_patch: { active_prompt_id: prompt_id },
            advanced_at: observed_at,
          })
        },
      })
      if (final_state === null) {
        final_state = await this.deps.stateStore.get(input.project_slug, input.user_id) as OnboardingState
      }
      return { outcome: 'resume_handled', state: final_state, prompt_id: emit.prompt_id }
    }
    return { outcome: 'resume_handled', state: advanced }
  }

  /**
   * Resolve the effective phase prompt spec. Order of preference:
   *
   *   1. LLM driver (when wired AND the phase is in the enabled set)
   *   2. Dynamic builder for special-cased phases (`slug_chosen`,
   *      `profile_pic_generating`)
   *   3. `STATIC_PHASE_SPECS` deterministic fallback
   *
   * 2026-05-10 — the per-signup_via static filter is gone. The new
   * static fallback body is generic across both channels; the LLM
   * driver handles per-channel context (sees `signup_via` in the
   * bundle) when wired. A model outage no longer reverts to a stale
   * "Use my Telegram display name" option — the static fallback
   * itself is now a clean free-text question.
   */
  async resolvePhasePromptSpec(
    project_slug: string,
    user_id: string,
    phase: OnboardingPhase,
  ): Promise<PhasePromptSpec | null> {
    // Argus r1 (2026-05-10) — same-turn cache. consumeChoice resolves
    // the spec to pick the routing branch; emitPhasePrompt later
    // resolves the SAME (instance, phase) to render the body. Without
    // the cache we'd hit the LLM twice per user turn for the stay
    // case — once for routing, once for the re-emit. Cache lives for
    // the duration of one public entry-point call and is cleared at
    // the top of `advance` / `acceptChoice` / `start`.
    const cached = this.readResolvedSpec(project_slug, phase)
    if (cached !== null) return cached
    const spec = await this.resolvePhasePromptSpecUncached(project_slug, user_id, phase)
    if (spec !== null) this.writeResolvedSpec(project_slug, phase, spec)
    return spec
  }

  private async resolvePhasePromptSpecUncached(
    project_slug: string,
    user_id: string,
    phase: OnboardingPhase,
  ): Promise<PhasePromptSpec | null> {
    // 2026-05-12 belt-and-braces — auto-skip phases must never have their
    // prompt body resolved. walkAutoSkip walks past auto-skip phases
    // before any emit path runs, so reaching this point with phase ∈
    // AUTO_SKIP_PHASES would mean a caller bypassed the walker (or a
    // future code path landed here without going through normalAdvance /
    // emitCurrentPhasePrompt). Returning null forces the caller to no-op
    // rather than ship a redundant gate body to the user.
    if (AUTO_SKIP_PHASES.has(phase)) return null
    // 2026-06-04 (onboarding-suggester-llm-timeout) — background pre-compute
    // of the character suggestions WHILE the user is still in the work-
    // interview / import-analysis phase. The interview spans several
    // human-time turns, so the ~15-30s CC-spawn generation (Opus is
    // slower than the legacy Haiku path) completes and memoizes before
    // personality_offered renders → that phase reads the
    // memoized picks instantly instead of blocking on a cold spawn (or, in
    // the legacy 6s-timeout world, always shipping the monotone fallback).
    // Fire-and-forget + in-flight deduped; only fires once there is real
    // signal so we never spend a spawn on empty input; failures swallowed.
    if (
      phase === 'work_interview_gap_fill' ||
      phase === 'import_analysis_presented'
    ) {
      try {
        const s = await this.deps.stateStore.get(project_slug, user_id)
        const ps = (s?.phase_state ?? {}) as Record<string, unknown>
        const already = readMemoizedCharacterSuggestions(
          ps['personality_character_suggestions'],
        )
        const hasSignal =
          (readStringArray(ps, 'primary_projects') ?? []).length > 0 ||
          (readStringArray(ps, 'non_work_interests') ?? []).length > 0 ||
          (readStringArray(ps, 'user_supplied_corrections') ?? []).length > 0
        if (already === null && hasSignal) {
          void this.getOrStartCharacterSuggestions(project_slug, user_id, ps)
        }
      } catch {
        // Non-fatal — the personality_offered render falls back to its own
        // bounded await if the pre-compute didn't run.
      }
    }
    if (phase === 'signup') {
      // 2026-05-12 (Bug C) — when the engine flipped
      // `phase_state.clarify_name_reprompt = true` on the prior turn,
      // emit a clarifying body INSTEAD of the persona-discovery prompt.
      // This is the recovery path after extractAgentNameFromFreeform
      // returned null and the engine stayed at signup rather than
      // advancing with garbage `agent_name`.
      const state = await this.deps.stateStore.get(project_slug, user_id)
      if (
        state !== null &&
        (state.phase_state as Record<string, unknown>)['clarify_name_reprompt'] === true
      ) {
        const fallback = STATIC_PHASE_SPECS['signup']
        if (fallback !== undefined) {
          return {
            ...fallback,
            body: 'Got it. What should I call you?',
          }
        }
      }
      const llmSpec = await this.resolveLlmSpec({
        project_slug,
        topic_id: null,
        user_id,
        phase,
        signup_via: null,
        state: null,
      })
      if (llmSpec !== null) return llmSpec
      return STATIC_PHASE_SPECS[phase] ?? null
    }
    if (phase === 'slug_chosen') {
      const state = await this.deps.stateStore.get(project_slug, user_id)
      const phase_state = state?.phase_state ?? {}
      const ps = phase_state as Record<string, unknown>
      const rejection = readString(ps, 'slug_picker_rejection')
      const agent_name = readString(ps, 'agent_name')
      const user_first_name = readString(ps, 'user_first_name')
      const persisted_suggested = readString(ps, 'suggested_slug')
      // P2 v2 § 2.8 / S7 — agent-name-primary slug suggestions. When the
      // registry + history + reserved-set deps are wired, compute up to
      // three candidates per the locked algorithm. Otherwise fall back to
      // the legacy single-suggestion path (`suggested_slug` derived from
      // the agent name) so existing tests + the slug-picker bridge keep
      // working byte-for-byte.
      const computed = this.computeSlugSuggestionsForPhase({
        project_slug,
        agent_name,
        user_first_name,
      })
      const primary = computed.primary ?? persisted_suggested
      return buildSlugChosenPromptSpec({
        suggested_slug: primary,
        rejection_reason: rejection,
        slug_picker_configured: this.deps.slugPicker !== undefined,
        alt_suggestions: computed.alts,
      })
    }
    // P2 v2 § 3.12 / S7 — projects_proposed dynamic body. Renders the
    // collected `phase_state.primary_projects[]` as a numbered list +
    // confirm/review buttons. Fallback bodies for the empty case live in
    // the builder.
    if (phase === 'projects_proposed') {
      // Edits in the user's most-recent transcript turn (e.g. "drop #2, add
      // Studio Sessions") are extracted + merged into `phase_state` upstream
      // by the `llmRouter` (`dispatchRouterDecision`); this body builder just
      // renders the persisted `primary_projects` via
      // `buildProjectsProposedPromptSpec`.
      const state = await this.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const rejection = readString(phase_state, 'projects_proposed_rejection')
      const projects = readStringArray(phase_state, 'primary_projects') ?? []
      const awaiting_share_freeform =
        phase_state['projects_proposed_share_freeform'] === true
      const builderInput: Parameters<typeof buildProjectsProposedPromptSpec>[0] = {
        primary_projects: projects,
      }
      if (rejection !== null) builderInput.rejection_reason = rejection
      if (awaiting_share_freeform) builderInput.awaiting_share_freeform = true
      return buildProjectsProposedPromptSpec(builderInput)
    }
    // P2 v2 § 3.5 / § 6.4 — import_upload_pending dynamic builder.
    // Renders the verbatim ChatGPT / Claude download-instructions
    // off `phase_state.ai_substrate_used` (set by
    // `advanceFromAiSubstrateOfferedToUpload` at the prior phase).
    if (phase === 'import_upload_pending') {
      const state = await this.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const raw = phase_state['ai_substrate_used']
      const ai_substrate_used: AiSubstrateSource | null =
        raw === 'chatgpt' || raw === 'claude' ? raw : null
      return buildImportUploadPendingPromptSpec({ ai_substrate_used })
    }
    // P2 v2 § 2.3 + § 3.7 / S5 — import_analysis_presented dynamic
    // builder. Renders the wow-moment bullets (projects + interests +
    // low-confidence callout) off `phase_state.import_result`. The
    // failure branch (`import_failed=true`) emits the graceful
    // "couldn't analyze" framing instead. The builder NEVER paraphrases
    // project / interest names — they pass through verbatim because
    // they're signals from the user's own data.
    if (phase === 'import_analysis_presented') {
      const state = await this.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const user_first_name = readString(phase_state, 'user_first_name')
      const import_source = readImportSource(phase_state, 'import_source')
      const builder_source: 'chatgpt-zip' | 'claude-zip' | null =
        import_source === 'chatgpt-zip' || import_source === 'claude-zip'
          ? import_source
          : null
      const import_failed = phase_state['import_failed'] === true
      const import_partial = phase_state['import_partial'] === true
      const import_result_raw = phase_state['import_result'] as unknown
      const import_result = coerceImportResultForBuilder(import_result_raw)
      // Derive month span from topic recency timestamps when the
      // Pass-2 result carried them; otherwise pass null and let the
      // builder fall back to the no-months clause. Defensive parse —
      // the JSON blob may carry any shape.
      const import_months_span = deriveImportMonthsSpan(import_result_raw)
      // 2026-05-25 (import-pipeline-resilience sprint, Part G.2) —
      // surface the `resume_import` button ONLY when (a) the last
      // import landed in a failed/partial terminal state AND (b) the
      // readiness probe confirms the job is resumable (status in
      // {cancelled, rate_limit_paused, failed} AND, for *-zip
      // sources, the source ZIP is still on disk). Once a resumed
      // run lands `completed` the engine clears `import_failed` +
      // `import_partial`, so the button auto-disappears on the
      // next re-emit.
      const last_import_job_id = readString(phase_state, 'last_import_job_id')
      const probe_job_id =
        readString(phase_state, 'import_job_id') ?? last_import_job_id
      let can_resume_import = false
      if (
        (import_failed || import_partial) &&
        import_source !== null &&
        probe_job_id !== null &&
        this.deps.importResumeReadiness !== undefined
      ) {
        try {
          can_resume_import = await this.deps.importResumeReadiness.isResumable({
            project_slug,
            user_id,
            source: import_source,
            job_id: probe_job_id,
          })
        } catch (err) {
          // Best-effort — a probe failure leaves the button hidden
          // (the safe default). Log to stderr for ops debugging but
          // do NOT bubble; the analysis-presented body still ships.
          // eslint-disable-next-line no-console
          console.warn(
            `[engine] importResumeReadiness.isResumable threw for ` +
              `project=${project_slug} job=${probe_job_id}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      return buildImportAnalysisPresentedPromptSpec({
        user_first_name,
        import_source: builder_source,
        import_result,
        import_failed,
        import_partial,
        import_months_span,
        can_resume_import,
      })
    }
    // 2026-05-13 — T3 max_oauth_offered dynamic builder. The phase has
    // three shapes (initial / awaiting Max handoff Done / awaiting BYO
    // paste); the builder collapses to the static spec when no sub-state
    // flag is set so the initial three-option prompt ships byte-for-byte
    // identical to STATIC_PHASE_SPECS.max_oauth_offered.
    if (phase === 'max_oauth_offered') {
      const state = await this.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const max_handoff_url = readString(phase_state, 'max_handoff_url')
      const awaiting_byo_paste = phase_state['awaiting_byo_paste'] === true
      const rejection = readString(phase_state, 'max_oauth_rejection')
      // 2026-06-03 (max-oauth-autoskip-wiring) — thread the chosen
      // substrate so the initial connect CTA acknowledges a Claude user
      // (see buildMaxOauthOfferedPromptSpec Shape 1).
      const raw_substrate = phase_state['ai_substrate_used']
      const ai_substrate_used: AiSubstrateSource | null =
        raw_substrate === 'chatgpt' || raw_substrate === 'claude'
          ? raw_substrate
          : null
      return buildMaxOauthOfferedPromptSpec({
        max_handoff_url,
        awaiting_byo_paste,
        rejection_reason: rejection,
        ai_substrate_used,
        // Open self-host (2026-06-13) — initial shape becomes a local
        // setup-token paste instead of the hosted Claude-Max OAuth handoff.
        deployment_mode: this.deploymentMode,
      })
    }
    // P2 v2 § 0 #9 + § 3.9 — personality_offered dynamic rejection
    // path. Short-circuits the resolver ONLY when the dedicated handler
    // wrote a `personality_offered_rejection` (too short / unparseable
    // free-text reply). The happy path falls through to the LLM driver /
    // static fallback so the body can be user-tuned.
    //
    // v0.1.80 (2026-05-22) — character suggester. When the suggester
    // dep is wired AND no memoized picks live on phase_state yet, fire
    // the LLM call to generate 5 character anchors and persist into
    // `phase_state.personality_character_suggestions`. On reload the
    // memoized picks are read back; the suggester is never re-rolled.
    // On suggester failure the static fallback constant ships — the
    // user always sees a 5-character body.
    if (phase === 'personality_offered') {
      const state = await this.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const v2_rejection = readString(phase_state, 'personality_offered_rejection')

      // Read the memoized picks (set by the foreground persist on a prior
      // render, or warmed by the pre-compute then persisted here). We
      // memoize WHAT WE RENDER together with its `source` so the consume
      // handler can map a `character:<index>` tap against the exact list
      // that shipped (closed validation — Codex P2) WITHOUT trusting the
      // client. A real ('llm') memo short-circuits instantly; a memoized
      // FALLBACK is re-attempted below so a transient failure re-rolls.
      const memoized = readMemoizedCharacterSuggestions(
        phase_state['personality_character_suggestions'],
      )
      const memoized_source = readString(
        phase_state,
        'personality_character_suggestions_source',
      )
      let character_suggestions: PersonalityCharacterSuggestions | null =
        memoized !== null && memoized_source === 'llm' ? memoized : null
      if (character_suggestions === null && this.deps.personalityCharacterSuggester !== undefined) {
        // No real memo yet — await the in-flight generation (dedupes with
        // the pre-compute promise; starts one if none is running). Bounded
        // by the suggester's 45s timeout (raised for cold Opus spawns when
        // the suggester moved to BEST_MODEL). 2026-06-04: replaces the old
        // 6s-timeout inline call that fell back to the monotone static list
        // 100% of the time (suggester-timeout incident).
        const pending = this.getOrStartCharacterSuggestions(
          project_slug,
          user_id,
          phase_state,
        )
        if (pending !== null) {
          const result = await pending
          character_suggestions = result.suggestions
          // Persist WHAT WE RENDER (+ source) on the CURRENT consuming
          // phase — so this upsert never writes a stale phase from a
          // background read (Codex P1) AND the consume handler can map the
          // index against the exact memoized list (Codex P2). Memoizing the
          // fallback does NOT freeze the user on it: the short-circuit above
          // only fires for `source==='llm'`, so a memoized fallback is
          // re-attempted on the next render until the LLM lands. Preserve
          // `last_advanced_at` so the memoization upsert doesn't reset the
          // resume-window timer. Best-effort.
          try {
            await this.deps.stateStore.upsert({
              project_slug,
              user_id,
              phase: 'personality_offered',
              phase_state_patch: {
                personality_character_suggestions: result.suggestions,
                personality_character_suggestions_source: result.source,
              },
              advanced_at: state?.last_advanced_at ?? this.now(),
            })
          } catch (err) {
            console.warn(
              `[engine] persist personality_character_suggestions failed for project=${project_slug}: ${err instanceof Error ? err.message : err}`,
            )
          }
          if (result.source === 'llm') {
            this.clearPendingSuggestions(
              this.pendingCharacterSuggestions as Map<string, Promise<unknown>>,
              project_slug,
              user_id,
            )
          }
        }
      }
      // Last resort: suggester unwired but a prior fallback is memoized —
      // render it rather than dropping to the legacy freeform body.
      if (character_suggestions === null && memoized !== null) {
        character_suggestions = memoized
      }

      if (character_suggestions !== null) {
        const builderInput: Parameters<typeof buildPersonalityOfferedPromptSpec>[0] = {
          character_suggestions,
        }
        if (v2_rejection !== null && v2_rejection.length > 0) {
          builderInput.rejection_reason = v2_rejection
        }
        return buildPersonalityOfferedPromptSpec(builderInput)
      }

      if (v2_rejection !== null && v2_rejection.length > 0) {
        return buildPersonalityOfferedPromptSpec({ rejection_reason: v2_rejection })
      }
      // No suggester, no memoized picks, no rejection — fall through to
      // the LLM driver / static fallback. The legacy 3-example freeform
      // body keeps the deterministic walk valid.
    }
    // P2 v2 § 3.10 / S7 — agent_name_chosen dynamic rejection path.
    // Short-circuits the resolver ONLY when a prior reply failed the
    // validators (length / charset / reserved-name list). The happy
    // path used to fall through to the LLM driver / static fallback —
    // 2026-05-27 it now ALWAYS routes through the AgentNameSuggester
    // (mirrors the personality_offered character-suggester wiring just
    // above) so the bullet list is built deterministically off a
    // memoized BEST_MODEL (Opus 4.7) call instead of an LLM driver that
    // can silently drop the bullets (Sam-incident 2026-05-27).
    //
    // When the suggester dep is absent (test harnesses, dev environments
    // without an Anthropic client), the engine still falls through to
    // the LLM driver / static spec — and Part C's
    // `agentNameBodyLooksValid` post-resolve validator backstops the
    // missing-bullets case by returning null to force the static
    // bullet-bearing fallback.
    if (phase === 'agent_name_chosen') {
      const state = await this.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const rejection = readString(phase_state, 'agent_name_chosen_rejection')

      // Read the memoized picks first (set by the foreground persist on a
      // prior render, or warmed by the pre-compute then persisted here). We
      // memoize WHAT WE RENDER together with its `source` (mirrors the
      // character path above) so a stale FALLBACK memo never freezes the
      // user. A real ('llm') memo short-circuits instantly; a memoized
      // fallback — including a legacy provenance-less memo persisted by
      // pre-patch code — is re-attempted below so a transient failure (or
      // an old Sage/Vera/Orin freeze) re-rolls until the LLM lands.
      const memoized = readMemoizedAgentNameSuggestions(
        phase_state['agent_name_suggestions'],
      )
      const memoized_source = readString(
        phase_state,
        'agent_name_suggestions_source',
      )
      let name_suggestions: AgentNameSuggestions | null =
        memoized !== null && memoized_source === 'llm' ? memoized : null
      if (name_suggestions === null && this.deps.agentNameSuggester !== undefined) {
        // No real memo yet — await the in-flight generation (dedupes with
        // the pre-compute promise). Bounded by the suggester's 45s timeout
        // (raised for cold Opus spawns when the suggester moved to
        // BEST_MODEL). 2026-06-04: replaces the old 6s-timeout inline call
        // that fell back to Sage/Vera/Orin 100% of the time.
        const pending = this.getOrStartAgentNameSuggestions(
          project_slug,
          user_id,
          phase_state,
        )
        if (pending !== null) {
          const result = await pending
          name_suggestions = result.suggestions
          // Foreground-only persist on the CURRENT consuming phase (Codex
          // P1 — never a stale background phase). We persist WHAT WE RENDER
          // together with its `source`. Memoizing the fallback does NOT
          // freeze the user on it: the short-circuit above only fires for
          // `source==='llm'`, so a memoized fallback is re-attempted on the
          // next render until the LLM lands. Preserve `last_advanced_at` so
          // the upsert doesn't reset the resume-window timer. Best-effort.
          try {
            await this.deps.stateStore.upsert({
              project_slug,
              user_id,
              phase: 'agent_name_chosen',
              phase_state_patch: {
                agent_name_suggestions: result.suggestions,
                agent_name_suggestions_source: result.source,
              },
              advanced_at: state?.last_advanced_at ?? this.now(),
            })
          } catch (err) {
            console.warn(
              `[engine] persist agent_name_suggestions failed for project=${project_slug}: ${err instanceof Error ? err.message : err}`,
            )
          }
          if (result.source === 'llm') {
            this.clearPendingSuggestions(
              this.pendingAgentNameSuggestions as Map<string, Promise<unknown>>,
              project_slug,
              user_id,
            )
          }
        }
      }
      // Last resort: suggester unwired but a prior fallback is memoized —
      // render it rather than dropping to the legacy freeform body.
      if (name_suggestions === null && memoized !== null) {
        name_suggestions = memoized
      }

      if (name_suggestions !== null) {
        const builderInput: Parameters<typeof buildAgentNameChosenPromptSpec>[0] = {
          name_suggestions: renderAgentNameBullets(name_suggestions),
        }
        if (rejection !== null && rejection.length > 0) {
          builderInput.rejection_reason = rejection
        }
        return buildAgentNameChosenPromptSpec(builderInput)
      }

      // No suggester wired AND no memoized picks. Honour the legacy
      // rejection short-circuit so a prior-attempt's rejection still
      // surfaces; otherwise fall through to the LLM driver / static
      // fallback (which Part C's validator backstops).
      if (rejection !== null && rejection.length > 0) {
        return buildAgentNameChosenPromptSpec({ rejection_reason: rejection })
      }
    }
    // P2 v2 — profile_pic_generating dynamic spec removed (phase
    // dropped from the v2 enum per § 2.10). Re-add when the Cores
    // image-gen substrate ships.
    // T1 (2026-05-13) — dynamic persona_reviewed body. Renders the
    // first 30 lines of each generated persona file (SOUL.md / USER.md
    // / priority-map.md) as the review prompt body. Sub-flow states
    // (`pick_line`, `pick_replacement`, `pending_regen_hint`) emit
    // their own bodies so the user always knows what they're being
    // asked.
    //
    // When `personaComposer` is unwired OR no draft has been
    // persisted yet, fall through to the static placeholder spec so
    // a misconfigured environment still advances the user instead of
    // stalling on an empty body.
    if (phase === 'persona_reviewed' && this.deps.personaComposer !== undefined) {
      const state = await this.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const draft = readPersonaDraft(phase_state)
      const sub_step = readPersonaReviewSubStep(phase_state)
      const rejection = readString(phase_state, 'persona_review_rejection')
      if (draft === null && sub_step === 'idle') {
        // Composer is wired but no draft on file — e.g. operator-time
        // drift where the engine was upgraded mid-onboarding and the
        // user resumed after the synthesis side-effect failed silently.
        // Fall through to the static spec so they advance forward.
        return STATIC_PHASE_SPECS[phase] ?? null
      }

      // v0.1.80 (2026-05-22) — conversational summary body. When the
      // user is on the idle (top-level) review screen, render a 3-4
      // sentence plain-English summary instead of the raw .md dump.
      // Memoized in `phase_state.persona_reviewed_summary` so reloads
      // don't re-roll; cleared by the re-emit-after-regen path so a
      // tweaked draft gets a fresh summary.
      let summary: string | null = readString(phase_state, 'persona_reviewed_summary')
      if (summary === null && draft !== null && sub_step === 'idle') {
        const summarizer_input = {
          user_first_name: readString(phase_state, 'user_first_name'),
          agent_personality: readString(phase_state, 'agent_personality'),
          soul_md: draft.soul_md,
          user_md: draft.user_md,
          priority_map_md: draft.priority_map_md,
        }
        if (this.deps.personaSummarizer !== undefined) {
          try {
            summary = await this.deps.personaSummarizer.summarize(summarizer_input)
          } catch (err) {
            console.warn(
              `[engine] personaSummarizer.summarize failed for project=${project_slug}: ${err instanceof Error ? err.message : err}`,
            )
            summary = staticPersonaSummary(summarizer_input)
          }
        } else {
          summary = staticPersonaSummary(summarizer_input)
        }
        // Persist memoized summary so reload doesn't re-roll. Best-effort.
        // Kieran r1 I3 — preserve `last_advanced_at` so the body-render
        // memoization upsert doesn't reset the resume-window timer.
        try {
          await this.deps.stateStore.upsert({
            project_slug,
            user_id,
            phase: 'persona_reviewed',
            phase_state_patch: { persona_reviewed_summary: summary },
            advanced_at: state?.last_advanced_at ?? Date.now(),
          })
        } catch (err) {
          console.warn(
            `[engine] persist persona_reviewed_summary failed for project=${project_slug}: ${err instanceof Error ? err.message : err}`,
          )
        }
      }

      const builderInput: BuildPersonaReviewedPromptSpecInput = {
        sub_step,
      }
      if (summary !== null && sub_step === 'idle') {
        builderInput.summary = summary
      } else if (draft !== null) {
        // Legacy raw-excerpt body. Reached only on sub-step screens
        // (where summary doesn't apply) — or, defensively, when the
        // summarizer path persisted nothing. T11 (2026-05-15) — strip
        // the canonical persona-file H1 from each excerpt before
        // rendering so the user-visible bubble shows friendly section
        // titles ("Voice + style", "About you", "What matters")
        // instead of the internal filename.
        builderInput.voice_excerpt = firstNLines(
          stripPersonaFileH1(draft.soul_md),
          30,
        )
        builderInput.about_excerpt = firstNLines(
          stripPersonaFileH1(draft.user_md),
          30,
        )
        builderInput.what_matters_excerpt = firstNLines(
          stripPersonaFileH1(draft.priority_map_md),
          30,
        )
      }
      const target_section = readPersonaEditTargetSection(phase_state)
      const target_line = readNumber(phase_state, 'persona_edit_target_line')
      if (target_section !== null) builderInput.edit_target_section = target_section
      if (target_line !== null) builderInput.edit_target_line = target_line
      if (rejection !== null) builderInput.rejection_reason = rejection
      return buildPersonaReviewedPromptSpec(builderInput)
    }
    // T1 (2026-05-13) — dynamic persona_synthesizing fallback body.
    // Only emitted when a prior compose attempt failed and the engine
    // persisted `persona_compose_failure_reason`. ISSUES #1 fix
    // (2026-05-19): when no failure flag is set, fall through to the
    // STATIC_PHASE_SPECS entry at the bottom of this function so the
    // user sees the spec § 3.13 status body ("Composing your persona
    // — this takes about 10 sec.") while the inline synthesizePersona
    // hook (consumeChoice + normalAdvance + emitCurrentPhasePrompt
    // resume-trigger) runs in the same turn / re-runs on resume.
    // Pre-fix the branch returned `null`, which made emitPhasePrompt
    // throw `prompt_emit_failed` and the literal error string surfaced
    // to the user as a chat bubble — the exact "placeholder phase-
    // prompt bodies that ship as no-ops" anti-pattern CLAUDE.md
    // forbids (root § "Spec is the source of truth — HARD RULE").
    if (phase === 'persona_synthesizing' && this.deps.personaComposer !== undefined) {
      const state = await this.deps.stateStore.get(project_slug, user_id)
      const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
      const failure = readString(phase_state, 'persona_compose_failure_reason')
      if (failure !== null) {
        return buildPersonaSynthesizingFallbackPromptSpec({
          failure_reason: failure,
        })
      }
      // No failure flag → fall through to STATIC_PHASE_SPECS at the
      // bottom of this function (NOT into the LLM-driven resolver:
      // PHASE_INTENTS['persona_synthesizing'] === null, so the
      // resolveLlmSpec call below opts out for this phase).
    }
    // LLM-driven resolver (sprint: 2026-05-09). When wired AND the phase
    // is in the resolver's enabled set, ask it to generate the body +
    // curated options. Returns null if the resolver opted out (phase not
    // enabled, LLM error) — fall through to the static `PHASE_PROMPTS`
    // table so a partial rollout / model outage stays user-invisible.
    const llmSpec = await this.resolveLlmSpec({
      project_slug,
      topic_id: null,
      user_id,
      phase,
      signup_via: null,
      state: null,
    })
    if (llmSpec !== null) return llmSpec
    const spec = STATIC_PHASE_SPECS[phase]
    return spec ?? null
  }

  /**
   * LLM-driven resolver path. Builds a `PhaseContextBundle` from the
   * engine's existing state + transcript, then asks the resolver. Returns
   * `null` when the resolver is unwired, the phase is not enabled, OR
   * the LLM call failed — caller falls through to the static spec.
   *
   * `topic_id` / `user_id` / `signup_via` come from the start() input
   * directly when the engine is mid-start; otherwise (advance / re-emit
   * paths) they are read from the persisted phase_state.
   */
  private async resolveLlmSpec(input: {
    project_slug: string
    topic_id: string | null
    user_id: string | null
    phase: OnboardingPhase
    signup_via: 'telegram' | 'web' | null
    state: OnboardingState | null
    /**
     * `start()` can pass `StartInput.tg_first_name` here so the resolver
     * sees it on the very first emit (before the upsert that persists it
     * into `phase_state` lands). Subsequent emits read it from
     * `phase_state.tg_first_name` directly.
     */
    tg_first_name_override?: string | null
  }): Promise<PhasePromptSpec | null> {
    // 2026-06-21 (onboarding-engine consolidation) — the warm conversational
    // body copy is produced solely by `phaseSpecResolver`. The older
    // `promptDriver` extraction-envelope seam (which also returned
    // `extracted_fields`) was never wired in production and has been removed;
    // freeform-field extraction now flows exclusively through `llmRouter`.
    if (this.deps.phaseSpecResolver === undefined) {
      return null
    }
    // ISSUES #2 (2026-05-19) — when `input.user_id` is null (legacy
    // pre-fix call-site), the state-store lookup is impossible (the row
    // PK is composite). Skip the state preload; the resolver's own
    // fallbacks (phase_state-recovered topic_id / signup_via) only run
    // when we have a state row anyway.
    const state =
      input.state ??
      (input.user_id !== null && input.user_id.length > 0
        ? await this.deps.stateStore.get(input.project_slug, input.user_id)
        : null)
    const phase_state = (state?.phase_state ?? {}) as Record<string, unknown>
    const signup_via =
      input.signup_via ??
      (readString(phase_state, 'signup_via') === 'web'
        ? 'web'
        : readString(phase_state, 'signup_via') === 'telegram'
          ? 'telegram'
          : 'web')
    const topic_id = input.topic_id ?? readString(phase_state, 'topic_id') ?? ''
    const user_id = input.user_id ?? readString(phase_state, 'user_id') ?? ''
    const tg_first_name =
      input.tg_first_name_override ?? readString(phase_state, 'tg_first_name')

    const intent = PHASE_INTENTS[input.phase]
    if (intent === null || intent === undefined) return null
    const attempt_count = readNumber(phase_state, 'attempt_count') ?? 0
    const rejection_reason = readString(phase_state, 'rejection_reason')
    const captured: PhaseContextBundle['captured'] = {
      agent_name: readString(phase_state, 'agent_name'),
      archetype_hint: readString(phase_state, 'archetype_hint'),
      suggested_slug: readString(phase_state, 'suggested_slug'),
      chosen_slug: readString(phase_state, 'chosen_slug'),
      last_choice_value: readString(phase_state, 'last_choice_value'),
      last_choice_freeform: readString(phase_state, 'last_choice_freeform'),
    }
    const recent_turns = this.readRecentTurns(6)
    const bundle: PhaseContextBundle = {
      project_slug: input.project_slug,
      topic_id,
      user_id,
      signup_via,
      telegram_display_name: tg_first_name,
      phase: input.phase,
      intent,
      captured,
      recent_turns,
      attempt_count,
      rejection_reason,
    }
    try {
      return await this.deps.phaseSpecResolver.resolve(bundle)
    } catch (err) {
      console.warn(
        `[engine] phaseSpecResolver.resolve threw for phase=${input.phase} project=${input.project_slug}:`,
        err instanceof Error ? err.message : err,
      )
      return null
    }
  }

  /**
   * 2026-06-04 (onboarding-suggester-llm-timeout) — in-flight suggester
   * generations keyed by `${project_slug}::${user_id}`. The suggester LLM
   * call runs on the CC-spawn substrate and takes seconds; these maps let
   * the engine (a) start a generation EARLY (background pre-compute during
   * the work-interview phase) and (b) dedupe so the later body-render
   * awaits the SAME in-flight promise instead of spawning a second
   * subprocess. Entries are deleted on settle so a later phase can re-roll
   * after a fallback. The promises persist real (`source==='llm'`) results
   * to phase_state themselves; the render path memoizes nothing extra.
   */
  readonly pendingCharacterSuggestions: Map<
    string,
    Promise<CharacterSuggesterResult>
  > = new Map()
  readonly pendingAgentNameSuggestions: Map<
    string,
    Promise<AgentNameSuggesterResult>
  > = new Map()

  /**
   * Argus r1 (2026-05-10) — per-(instance, phase) cache of the most
   * recent resolved PhasePromptSpec. Populated by
   * `resolvePhasePromptSpec` on first call and consulted on subsequent
   * calls in the SAME public-method-call lifetime so we never hit the
   * LLM twice for one user turn. Cleared at the start of every public
   * engine entry point (`start`, `advance`, `acceptChoice`).
   *
   * Cache key: `${project_slug}:${phase}`. The cache is intentionally
   * scoped per call, NOT a long-lived memoization — the bundle the
   * driver sees includes the transcript-so-far, which changes between
   * user turns; a long-lived cache would serve stale prompts.
   */
  private readonly resolvedSpecCache: Map<string, PhasePromptSpec> = new Map()

  /**
   * Cache helpers — guarded `get` / `set` / `clear` so call sites do
   * not stringify the key inline.
   */
  private readResolvedSpec(project_slug: string, phase: OnboardingPhase): PhasePromptSpec | null {
    return this.resolvedSpecCache.get(`${project_slug}:${phase}`) ?? null
  }
  private writeResolvedSpec(project_slug: string, phase: OnboardingPhase, spec: PhasePromptSpec): void {
    this.resolvedSpecCache.set(`${project_slug}:${phase}`, spec)
  }
  private clearResolvedSpecCache(): void {
    this.resolvedSpecCache.clear()
  }
  /**
   * Invalidate a single (instance, phase) entry in the resolved-spec
   * cache. Used by the 2026-05-12 signup name-reprompt branch so the
   * next `resolvePhasePromptSpec` call rebuilds and picks up the
   * fresh `clarify_name_reprompt` flag.
   */
  invalidateResolvedSpec(project_slug: string, phase: OnboardingPhase): void {
    this.resolvedSpecCache.delete(`${project_slug}:${phase}`)
  }

  // ----------------------------------------------------------------------
  // 2026-06-04 (onboarding-suggester-llm-timeout) — background pre-compute
  // + in-flight dedupe for the two suggesters. See the field declarations
  // for the rationale. The promises persist real (`source==='llm'`)
  // results to phase_state themselves so a reload reads the memoized picks.
  // ----------------------------------------------------------------------

  suggestionKeyPrefix(project_slug: string, user_id: string): string {
    return slugSuggestionKeyPrefix(this, project_slug, user_id)
  }

  /**
   * Deterministic compact fingerprint of the SIGNAL fields a suggester
   * input depends on (Codex P2, 2026-06-04). The warm cache is keyed by
   * `instance::user::<fingerprint>` so that when a later work-interview turn
   * adds `non_work_interests` / `user_supplied_corrections` / etc., the key
   * changes — a stale partial-signal pre-compute is never reused for the
   * `personality_offered` render, which always reflects the CURRENT
   * (final) collected answers. Stable fields only; FNV-1a → base36.
   */
  suggestionFingerprint(
    parts: ReadonlyArray<string | ReadonlyArray<string>>,
  ): string {
    return slugSuggestionFingerprint(this, parts)
  }

  /** Drop every warm-cache entry for this instance/user (across all
   *  fingerprints). Called when a NEWER-fingerprint pre-compute supersedes
   *  the old one, and by the foreground render once it has consumed +
   *  persisted a real result. */
  clearPendingSuggestions(
    map: Map<string, Promise<unknown>>,
    project_slug: string,
    user_id: string,
    except?: string,
  ): void {
    const prefix = this.suggestionKeyPrefix(project_slug, user_id)
    for (const k of [...map.keys()]) {
      if (k.startsWith(prefix) && k !== except) map.delete(k)
    }
  }

  /**
   * Bound cross-project accumulation in a warm-cache map (Codex P2,
   * 2026-06-04). A successful ('llm') pre-compute for a user who ABANDONS
   * before the foreground render consumes it would otherwise live forever
   * in this singleton-engine map. Map iteration is insertion-ordered, so
   * evicting from the front drops the oldest entries first. Eviction only
   * costs an abandoned instance a re-spawn if they later resume.
   */
  capPendingSuggestions(map: Map<string, Promise<unknown>>): void {
    const MAX = 256
    while (map.size > MAX) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  /**
   * Return the in-flight character-suggester promise for this instance/user,
   * starting one if none is running. Returns null only when no suggester
   * dep is wired (test/dev). Fire-and-forget callers (pre-compute) ignore
   * the returned promise; the body-render path awaits it.
   *
   * IMPORTANT (Codex P1, 2026-06-04): this NEVER writes to the state store.
   * A background pre-compute can resolve at any time — including AFTER a
   * foreground handler has advanced the user's phase — so a write here that
   * replays a previously-read `phase` would regress `onboarding_state.phase`
   * and could strand the flow. Persistence happens EXCLUSIVELY in the
   * foreground body-render path (`resolvePhasePromptSpecUncached`), which is
   * always executing on the correct consuming phase. This map is a pure
   * latency-hiding warm cache.
   */
  getOrStartCharacterSuggestions(
    project_slug: string,
    user_id: string,
    phase_state: Record<string, unknown>,
  ): Promise<CharacterSuggesterResult> | null {
    return slugGetOrStartCharacterSuggestions(this, project_slug, user_id, phase_state)
  }

  /** Agent-name mirror of `getOrStartCharacterSuggestions` (same no-DB-write
   *  contract — persistence is foreground-only). */
  getOrStartAgentNameSuggestions(
    project_slug: string,
    user_id: string,
    phase_state: Record<string, unknown>,
  ): Promise<AgentNameSuggesterResult> | null {
    return slugGetOrStartAgentNameSuggestions(this, project_slug, user_id, phase_state)
  }

  /**
   * P2 v2 § 2.8 / S7 — pre-LLM slug candidate computation for the
   * `slug_chosen` resolver. Wraps `computeSlugSuggestionsForAgentName`
   * with the `slugAvailability` probe so the resolver can pass a pure
   * `isAvailable` predicate without re-implementing the availability
   * check at the call site.
   *
   * Returns `{ primary: null, alts: [] }` when `agent_name` is null /
   * empty (no signal to derive a candidate from). When no
   * `slugAvailability` probe is wired (the single-owner Open production
   * path), falls back to the single-suggestion path (agent-name-derived
   * primary, no alts).
   *
   * `selfInternalHandle` is intentionally omitted — the picker computes
   * suggestions BEFORE the user accepts; the active instance's `url_slug`
   * is included in the availability check exactly once (when the user
   * actually picks the slug, via `processSlugPickerReply`).
   */
  computeSlugSuggestionsForPhase(input: {
    project_slug: string
    agent_name: string | null
    user_first_name: string | null
  }): { primary: string | null; alts: ReadonlyArray<string> } {
    return slugComputeSlugSuggestionsForPhase(this, input)
  }

  /**
   * Read the last N agent+user lines from the transcript, dropping
   * system entries (recovery / sentinel notes the LLM does not need).
   * Truncates each body to ~80 chars at the bundle boundary so the
   * upstream prompt stays under the per-call token budget.
   */
  private readRecentTurns(n: number): ReadonlyArray<PhaseRecentTurn> {
    let entries: ReturnType<TranscriptWriter['readAll']>
    try {
      entries = this.deps.transcript.readAll()
    } catch {
      return []
    }
    const out: PhaseRecentTurn[] = []
    for (let i = entries.length - 1; i >= 0 && out.length < n; i--) {
      const e = entries[i]!
      if (e.role !== 'agent' && e.role !== 'user') continue
      const phase = (e.phase ?? 'signup') as OnboardingPhase
      out.unshift({ role: e.role, body: e.body, phase })
    }
    return out
  }

  /**
   * P1.5 / Sprint 21 — slug_chosen branch of consumeChoice. Routes the
   * resolved choice through the slug-picker hook so:
   *
   *   - `skip-slug` → advance to profile_pic_generating (current url_slug
   *     stays as the t-handle; user can rename later via settings).
   *   - `use-suggested` → call hook with the previously persisted
   *     `suggested_slug` as raw_input.
   *   - `type-different` (button tap) → re-emit the prompt asking the
   *     user to type their slug; no rename attempted yet.
   *   - `__freeform__` (typed text on the prompt) → call hook with the
   *     typed text as raw_input.
   *
   * On `renamed`/`skipped` outcomes we advance to profile_pic_generating
   * + emit its prompt. On `rejected` outcomes we keep state at
   * slug_chosen + persist the typed reason into phase_state so the
   * dynamic prompt builder surfaces it.
   *
   * Telemetry: every outcome lands a role='system' transcript line
   * tagged with the old/new slug + outcome kind so the per-instance
   * onboarding-transcript.jsonl captures the rename history.
   */
  async consumeSlugChosenChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    return slugConsumeSlugChosenChoice(this, input, state, choice, was_new, observed_at)
  }

  /**
   * Advance from slug_chosen → profile_pic_generating. `kept` records
   * whether the user kept the existing url_slug (skip path) vs. rename
   * succeeded; surfaced via phase_state for downstream consumers.
   *
   * Codex P1 #2 + P1 #3: when `new_slug` is set (rename succeeded), the
   * onboarding_state row has already been rekeyed by the caller from
   * `input.project_slug` (OLD) to `new_slug`. The advance writes under
   * `new_slug` so the renamed gateway can find the row on reconnect.
   * The next-phase prompt is intentionally NOT emitted on the live
   * socket because the redirect envelope has already fired and the WS
   * is being torn down by the systemd restart — the renamed gateway's
   * `engine.start()` re-emits the profile_pic_generating prompt on the
   * fresh WS via the `active_prompt_id == null` branch (see
   * `start()`'s post-existing path).
   */
  async advanceFromSlugChosen(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    kept: boolean,
    new_slug?: string,
    emitNextPromptOnLiveSocket?: boolean,
    restartCommitted?: boolean,
  ): Promise<AdvanceResult> {
    return slugAdvanceFromSlugChosen(this, input, state, observed_at, kept, new_slug, emitNextPromptOnLiveSocket, restartCommitted)
  }

  /**
   * Persist a rejection reason into phase_state and re-emit the
   * slug_chosen prompt with a fresh idempotency key (the rejection
   * counter advances so ButtonStore.emit returns a new row instead of
   * collapsing onto the prior resolved one).
   */
  async persistRejectionAndReEmit(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    reason: string,
  ): Promise<AdvanceResult> {
    return slugPersistRejectionAndReEmit(this, input, state, observed_at, reason)
  }

  /**
   * Re-emit the slug_chosen prompt, threading an attempt-counter into
   * the idempotency seed so a prior resolved-rejected row in
   * ButtonStore doesn't shadow the new keyboard.
   */
  async reEmitSlugChosen(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    reason: string | null,
  ): Promise<AdvanceResult> {
    return slugReEmitSlugChosen(this, input, state, observed_at, reason)
  }

  /**
   * 2026-05-13 — T3 max_oauth_offered branch of consumeChoice. Routes
   * the resolved choice to one of four sub-paths:
   *
   *   - `attach_max` → call `deps.maxOauth.startHandoff(...)`, stash the
   *      returned URL in `phase_state.max_handoff_url`, re-emit the
   *      phase with the dynamic "Open <url>, tap Done" body.
   *   - `byo_key` → stash `phase_state.awaiting_byo_paste=true`, re-emit
   *      with the dynamic paste body (`allow_freeform=true`, no buttons).
   *   - `skip` → stash `phase_state.max_substrate='free'`, advance to
   *      `wow_fired`.
   *   - `max_done` (Done tap on the Max-handoff re-emit) → verify the
   *      SecretsStore has a `max_oauth_refresh` row for the instance; on
   *      success advance to `wow_fired`, on failure re-emit with a
   *      rejection reason.
   *   - `__freeform__` (paste on the BYO re-emit) → validate `sk-ant-`
   *      prefix, persist via `secrets.put`, advance to `wow_fired`.
   *
   * Mirrors the consumeSlugChosenChoice pattern — we own the routing
   * before the generic next_phase_on_default flow runs.
   */
  /**
   * 2026-05-28 — auto-skip past `max_oauth_offered` when the instance
   * already has a Max-OAuth refresh secret persisted (e.g. the import
   * phase attached Max upstream, or the user completed the connect on a
   * prior session). Returns the post-advance state when auto-skip
   * fires, or the input state unchanged when there's nothing to skip /
   * detection isn't possible.
   *
   * Detection order:
   *   1. `secrets.list({ kind: 'max_oauth_refresh', ... })` — the
   *      canonical store the Max-OAuth handoff writes into.
   *   2. Process env `CLAUDE_CODE_OAUTH_TOKEN` (stop-gap per Sam's
   *      2026-05-28 brief): when secrets is unwired or returns no rows,
   *      a non-empty env token is treated as "Max attached" because the
   *      pre-2026-05-28 substrate refactor wired the CLI subprocess
   *      transport off the env, not the SecretsStore. This keeps the
   *      auto-skip working for self-hosted / dev instances whose
   *      substrate is env-driven.
   *
   * Any thrown error (secrets.list throws, env read fails, etc.) is
   * swallowed — we return the input state and let the regular prompt
   * fire. Auto-skip is best-effort; a flaky detection MUST NEVER
   * strand an instance on a phase with a non-functional CTA.
   *
   * On a positive detection we reuse `advanceFromMaxOauthOffered(...,
   * 'max_oauth')` so the wow_fired dispatcher fires inline (when
   * wired), exactly mirroring the post-Done-tap success path.
   */
  async maybeAutoAdvancePastMaxOauthOffered(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<OnboardingState> {
    return slugMaybeAutoAdvancePastMaxOauthOffered(this, input, state, observed_at)
  }

  private async consumeMaxOauthChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const choice_value = choice.choice_value
    const phase_state = state.phase_state as Record<string, unknown>

    // 2026-05-28 — defensive auto-skip on stale clicks. An instance whose
    // Max-OAuth completed between emit + this click should advance
    // immediately rather than re-firing the connect handoff. Mirrors
    // the auto-skip the resume paths run in `normalAdvance` +
    // `emitCurrentPhasePrompt`.
    const auto_skipped = await this.maybeAutoAdvancePastMaxOauthOffered(
      input,
      state,
      observed_at,
    )
    if (auto_skipped.phase !== 'max_oauth_offered') {
      return { outcome: 'advanced', state: auto_skipped }
    }

    // Append the resolved transcript line on first resolution.
    if (was_new) {
      const body =
        choice_value === '__freeform__' && choice.freeform_text !== undefined
          ? choice.freeform_text
          : choice_value
      this.deps.transcript.append({
        role: 'user',
        body,
        phase: state.phase,
        button_prompt_id: choice.prompt_id,
        button_choice: choice_value,
      })
    }

    // Open self-host (2026-06-13) — the local setup-token paste flow. The
    // open prompt (buildMaxOauthOfferedPromptSpec deployment_mode='open')
    // offers ONLY a freeform paste + "Skip for now"; there is no hosted
    // OAuth handoff. A freeform paste is the `claude setup-token`; persist
    // it to the local SecretsStore and advance. `skip` drops onto the free
    // tier. Any other value (e.g. a stale `attach_max` from a managed
    // keyboard) re-emits the open paste prompt rather than starting a
    // handoff that makes no sense locally.
    if (this.deploymentMode === 'open') {
      if (
        choice_value === '__freeform__' &&
        typeof choice.freeform_text === 'string' &&
        choice.freeform_text.trim().length > 0
      ) {
        return await this.persistSetupTokenAndAdvance(
          input,
          state,
          choice.freeform_text.trim(),
          observed_at,
        )
      }
      if (choice_value === 'skip') {
        return await this.advanceFromMaxOauthOffered(
          input,
          state,
          observed_at,
          'free',
        )
      }
      return await this.reEmitMaxOauthOffered(input, state, observed_at, null)
    }

    const awaiting_byo_paste = phase_state['awaiting_byo_paste'] === true
    const max_handoff_url = readString(phase_state, 'max_handoff_url')

    // Branch: user is mid-byo-paste → validate the freeform paste.
    if (
      awaiting_byo_paste &&
      choice_value === '__freeform__' &&
      typeof choice.freeform_text === 'string' &&
      choice.freeform_text.length > 0
    ) {
      return await this.persistByoApiKeyAndAdvance(
        input,
        state,
        choice.freeform_text.trim(),
        observed_at,
      )
    }

    // Branch: user tapped Done on the Max-handoff re-emit.
    if (
      max_handoff_url !== null &&
      max_handoff_url.length > 0 &&
      choice_value === 'max_done'
    ) {
      return await this.verifyMaxHandoffAndAdvance(input, state, observed_at)
    }

    // Branch: initial choice.
    if (choice_value === 'attach_max') {
      return await this.startMaxOauthHandoff(input, state, observed_at)
    }
    if (choice_value === 'byo_key') {
      return await this.startByoApiKeyPaste(input, state, observed_at)
    }
    if (choice_value === 'skip') {
      return await this.advanceFromMaxOauthOffered(
        input,
        state,
        observed_at,
        'free',
      )
    }

    // Unknown choice — re-emit the current prompt so the user gets a fresh
    // keyboard rather than silently advancing.
    return await this.reEmitMaxOauthOffered(input, state, observed_at, null)
  }

  /**
   * `attach_max` initial branch. Calls the hook to start the upstream
   * exchange, stashes the returned URL in phase_state, then re-emits
   * the dynamic max_oauth_offered prompt with the "Open <url>, tap Done"
   * body.
   */
  private async startMaxOauthHandoff(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult> {
    if (this.deps.maxOauth === undefined) {
      this.deps.transcript.append({
        role: 'system',
        body: `max-oauth: hook not configured; offering byo/skip`,
        phase: state.phase,
      })
      // 2026-05-28 — single-CTA collapse. Pre-2026-05-28 this rejection
      // text said "Max attach is temporarily unavailable. Use your own
      // API key or skip for now." referencing buttons that no longer
      // exist (Sam walkthrough hit a 3x stuck loop here). The new copy
      // points at the only remaining action — retry the connect.
      return await this.reEmitMaxOauthOffered(
        input,
        state,
        observed_at,
        "Connect failed; tap to try again.",
      )
    }
    let handoff: { url: string }
    try {
      handoff = await this.deps.maxOauth.startHandoff({
        project_slug: input.project_slug,
        user_id: input.user_id,
      })
    } catch (err) {
      this.deps.transcript.append({
        role: 'system',
        body: `max-oauth: startHandoff threw: ${err instanceof Error ? err.message : String(err)}`,
        phase: state.phase,
      })
      return await this.reEmitMaxOauthOffered(
        input,
        state,
        observed_at,
        "Connect failed; tap to try again.",
      )
    }
    const url = handoff.url.length > 0 ? handoff.url : null
    if (url === null) {
      return await this.reEmitMaxOauthOffered(
        input,
        state,
        observed_at,
        "Connect failed; tap to try again.",
      )
    }
    const updated = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'max_oauth_offered',
      phase_state_patch: {
        active_prompt_id: null,
        max_handoff_url: url,
        max_handoff_started: true,
        max_oauth_rejection: null,
      },
      advanced_at: observed_at,
    })
    return await this.reEmitMaxOauthOffered(input, updated, observed_at, null)
  }

  /**
   * `max_done` branch — user has (per the prior re-emit) opened the URL
   * and is reporting completion. Verify the SecretsStore has a
   * `max_oauth_refresh` row for the instance; on success advance to
   * `wow_fired` and clear the `max_substrate` to `max_oauth`. On
   * failure re-emit with a rejection reason.
   */
  private async verifyMaxHandoffAndAdvance(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult> {
    if (this.deps.secrets === undefined) {
      // No store wired (test/dev mode) — trust the handoff was completed
      // upstream and advance. Production wires the per-instance secrets
      // store so this branch never fires.
      return await this.advanceFromMaxOauthOffered(
        input,
        state,
        observed_at,
        'max_oauth',
      )
    }
    let rows: ReadonlyArray<{ id: string; label: string; kind: string }>
    try {
      rows = await this.deps.secrets.list({
        internal_handle: this.secretsIdentity(input.project_slug),
        kind: 'max_oauth_refresh',
      })
    } catch (err) {
      this.deps.transcript.append({
        role: 'system',
        body: `max-oauth: secrets.list threw: ${err instanceof Error ? err.message : String(err)}`,
        phase: state.phase,
      })
      return await this.reEmitMaxOauthOffered(
        input,
        state,
        observed_at,
        "Couldn't verify the Max attach yet — tap Done again once the link is finished.",
      )
    }
    if (rows.length === 0) {
      return await this.reEmitMaxOauthOffered(
        input,
        state,
        observed_at,
        "I don't see your Max sub yet. Make sure you finished the link, then tap Done again.",
      )
    }
    return await this.advanceFromMaxOauthOffered(
      input,
      state,
      observed_at,
      'max_oauth',
    )
  }

  /**
   * `byo_key` initial branch — stash awaiting_byo_paste=true and re-emit
   * the dynamic phase prompt with the paste body (`allow_freeform=true`,
   * zero options).
   */
  private async startByoApiKeyPaste(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const updated = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'max_oauth_offered',
      phase_state_patch: {
        active_prompt_id: null,
        awaiting_byo_paste: true,
        max_handoff_url: null,
        max_oauth_rejection: null,
      },
      advanced_at: observed_at,
    })
    return await this.reEmitMaxOauthOffered(input, updated, observed_at, null)
  }

  /**
   * Freeform-paste branch on the BYO re-emit. Validates the `sk-ant-`
   * prefix, persists via `secrets.put({ kind: 'byo_api_key', ... })`,
   * then advances to `wow_fired`.
   */
  private async persistByoApiKeyAndAdvance(
    input: AdvanceInput,
    state: OnboardingState,
    raw_key: string,
    observed_at: number,
  ): Promise<AdvanceResult> {
    if (!raw_key.startsWith('sk-ant-')) {
      return await this.reEmitMaxOauthOffered(
        input,
        state,
        observed_at,
        "That doesn't look like an Anthropic API key (they start with sk-ant-). Paste the full key to try again.",
      )
    }
    if (this.deps.secrets === undefined) {
      this.deps.transcript.append({
        role: 'system',
        body: `byo-api-key: secrets store not configured; advancing without persisting`,
        phase: state.phase,
      })
      return await this.advanceFromMaxOauthOffered(
        input,
        state,
        observed_at,
        'byo_api_key',
      )
    }
    try {
      await this.deps.secrets.put({
        internal_handle: this.secretsIdentity(input.project_slug),
        kind: 'byo_api_key',
        label: 'anthropic:default',
        plaintext: raw_key,
      })
    } catch (err) {
      this.deps.transcript.append({
        role: 'system',
        body: `byo-api-key: persist failed: ${err instanceof Error ? err.message : String(err)}`,
        phase: state.phase,
      })
      return await this.reEmitMaxOauthOffered(
        input,
        state,
        observed_at,
        'Could not save that key. Try pasting again.',
      )
    }
    return await this.advanceFromMaxOauthOffered(
      input,
      state,
      observed_at,
      'byo_api_key',
    )
  }

  /**
   * Open self-host (2026-06-13) — freeform-paste branch on the open
   * `max_oauth_offered` setup-token prompt. The user ran `claude
   * setup-token` locally and pasted the result; persist it to the local
   * SecretsStore under kind `max_oauth_refresh` (the same kind the runtime
   * Max substrate + `maybeAutoAdvancePastMaxOauthOffered` auto-skip key
   * off, so a resume after paste auto-skips this phase), then advance to
   * `wow_fired` with substrate `max_oauth`.
   *
   * Light validation only: setup-tokens are opaque, so we reject obvious
   * non-tokens (too short) and re-emit. When `secrets` is unwired
   * (dev/test) we advance treating the paste as accepted, mirroring the
   * BYO path's unwired branch.
   */
  private async persistSetupTokenAndAdvance(
    input: AdvanceInput,
    state: OnboardingState,
    raw_token: string,
    observed_at: number,
  ): Promise<AdvanceResult> {
    const token = raw_token.trim()
    if (token.length < 16) {
      return await this.reEmitMaxOauthOffered(
        input,
        state,
        observed_at,
        "That doesn't look like a setup-token. Run `claude setup-token` and paste the full result to try again.",
      )
    }
    // Guard: an OpenAI key (sk-…, not sk-ant-…) pasted at the setup-token step
    // would pass the length check and be persisted as a Claude
    // `max_oauth_refresh`/`claude-setup-token` credential, then falsely
    // reported as success — silently corrupting the substrate credential so the
    // agent's premium-model calls fail later with no explanation. Reject it with
    // a clear message instead of mis-storing it (symmetric to the OpenAI offer,
    // which rejects an sk-ant- Anthropic key, and to the managed BYO path, which
    // rejects a non-sk-ant- key). A real `claude setup-token` is an Anthropic
    // OAuth token (sk-ant-…), so this never false-positives on a valid token.
    if (looksLikeOpenAiKey(token)) {
      return await this.reEmitMaxOauthOffered(
        input,
        state,
        observed_at,
        "That's an OpenAI key (sk-…), not a Claude setup-token. Your Claude substrate needs the " +
          'output of `claude setup-token` (an Anthropic token, sk-ant-…). Paste that to continue, ' +
          'or tap “Skip for now” to use the free tier.',
      )
    }
    if (this.deps.secrets === undefined) {
      this.deps.transcript.append({
        role: 'system',
        body: `setup-token: secrets store not configured; advancing without persisting`,
        phase: state.phase,
      })
      return await this.advanceFromMaxOauthOffered(
        input,
        state,
        observed_at,
        'max_oauth',
      )
    }
    try {
      await this.deps.secrets.put({
        internal_handle: this.secretsIdentity(input.project_slug),
        kind: 'max_oauth_refresh',
        label: 'claude-setup-token',
        plaintext: token,
      })
    } catch (err) {
      this.deps.transcript.append({
        role: 'system',
        body: `setup-token: persist failed: ${err instanceof Error ? err.message : String(err)}`,
        phase: state.phase,
      })
      return await this.reEmitMaxOauthOffered(
        input,
        state,
        observed_at,
        'Could not save that token. Try pasting again.',
      )
    }
    return await this.advanceFromMaxOauthOffered(
      input,
      state,
      observed_at,
      'max_oauth',
    )
  }

  /**
   * Common tail: advance from max_oauth_offered → wow_fired and
   * record the chosen substrate in phase_state for downstream
   * consumers. The legal-transition guard mirrors consumeChoice's
   * generic path.
   */
  async advanceFromMaxOauthOffered(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    substrate: 'free' | 'byo_api_key' | 'max_oauth',
  ): Promise<AdvanceResult> {
    const next_phase: OnboardingPhase = 'wow_fired'
    if (!isLegalTransition(state.phase, next_phase)) {
      throw new InterviewError(
        state.phase,
        'illegal_transition',
        false,
        `max-oauth: illegal transition ${state.phase} → ${next_phase}`,
      )
    }
    const advanced = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: next_phase,
      phase_state_patch: {
        active_prompt_id: null,
        awaiting_byo_paste: null,
        max_handoff_url: null,
        max_handoff_started: null,
        max_oauth_rejection: null,
        max_substrate: substrate,
      },
      advanced_at: observed_at,
    })
    // T2 (2026-05-13) — when wow_fired entry is wired, fire the
    // dispatcher inline so the user's "skip" / "Done" / paste choice
    // walks the full max_oauth_offered → wow_fired → completed path in
    // a single advance call (mirrors the wow_fired-entry hook in the
    // normalAdvance path at line ~2304). When the dispatcher is
    // unwired we fall back to silent-transit: phase advances, no entry
    // body emit, no dispatch.
    if (next_phase === 'wow_fired' && this.deps.wowDispatcher !== undefined) {
      return await this.dispatchWowAndAdvance(input, advanced, observed_at)
    }
    return { outcome: 'advanced', state: advanced }
  }

  /**
   * Re-emit the max_oauth_offered prompt with a fresh idempotency key.
   * The dynamic builder picks up the current phase_state (max_handoff_url
   * / awaiting_byo_paste / max_oauth_rejection) so the body + options
   * reflect the current sub-state. Bumps an attempt counter on the
   * idempotency seed so a prior resolved row in ButtonStore doesn't
   * shadow the new keyboard.
   */
  private async reEmitMaxOauthOffered(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    rejection: string | null,
  ): Promise<AdvanceResult> {
    // Persist the rejection (or clear it) before resolving the spec so
    // the dynamic builder sees the fresh reason.
    const prior_attempts =
      readNumber(state.phase_state, 'max_oauth_attempt_count') ?? 0
    const next_attempts = prior_attempts + 1
    const pre_emit_state = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'max_oauth_offered',
      phase_state_patch: {
        active_prompt_id: null,
        max_oauth_rejection: rejection,
        max_oauth_attempt_count: next_attempts,
      },
      advanced_at: observed_at,
    })
    // Drop the cached spec so resolvePhasePromptSpec rebuilds with the
    // fresh phase_state (the cache key is instance+phase, not phase_state).
    this.invalidateResolvedSpec(input.project_slug, 'max_oauth_offered')
    const spec = await this.resolvePhasePromptSpec(
      input.project_slug,
      input.user_id,
      'max_oauth_offered',
    )
    if (spec === null) {
      return { outcome: 'no_active_prompt', state: pre_emit_state }
    }
    const seed = canonicalPromptSeed({
      body: spec.body,
      options: spec.options.map((o) => ({ value: o.value })),
    })
    const idempotency_key = deriveIdempotencyKey({
      project_slug: input.project_slug,
      topic_id: input.topic_id,
      seed: `max_oauth_offered:${next_attempts}:${seed}`,
    })
    const prompt = buildButtonPrompt({
      body: spec.body,
      options: spec.options.map((o) => ({ ...o })),
      allow_freeform: spec.allow_freeform,
      idempotency_key,
      uuid: this.uuid,
    })
    const emit = await this.deps.buttonStore.emit(prompt, { topic_id: input.topic_id })
    const updated = await this.deps.stateStore.upsert({
      project_slug: input.project_slug,
      user_id: input.user_id,
      phase: 'max_oauth_offered',
      phase_state_patch: { active_prompt_id: emit.prompt_id, topic_id: input.topic_id },
      advanced_at: observed_at,
    })
    if (emit.was_new || !emit.was_delivered) {
      try {
        await this.deps.sendButtonPrompt({
          project_slug: input.project_slug,
          topic_id: input.topic_id,
          prompt: emit.prompt,
        })
        await this.deps.buttonStore.markDelivered(emit.prompt_id, this.now())
      } catch (err) {
        throw new InterviewError(
          'max_oauth_offered',
          'send_failed',
          true,
          `failed to re-emit max_oauth_offered prompt`,
          err,
        )
      }
      this.deps.transcript.append({
        role: 'agent',
        body: spec.body,
        phase: 'max_oauth_offered',
        button_prompt_id: emit.prompt_id,
      })
    }
    return { outcome: 'reemitted_current', state: updated, prompt_id: emit.prompt_id }
  }


  /**
   * ISSUES #1 (2026-05-19) — resume-path guard for `synthesizePersona`.
   * Returns `true` iff the engine should fire `synthesizePersona` for a
   * instance that is sitting at `persona_synthesizing` WITHOUT a freshly
   * arriving inbound choice (i.e. a reconnect / re-emit / normalAdvance
   * landing on the phase from a prior interrupted run, OR a gateway
   * restart mid-compose).
   *
   * Returns `false` when:
   *   - the phase is not `persona_synthesizing` (defensive),
   *   - no composer is wired (the unwired skeleton path advances
   *     directly to `persona_reviewed` from inside `synthesizePersona`;
   *     we don't run that branch on resume because there is no draft
   *     to publish — the resume just re-emits the static body),
   *   - a prior compose failure persisted `persona_compose_failure_reason`
   *     (the fallback prompt is the right user-facing artefact; the
   *     auto-retry is the user's call via the Try-again button), OR
   *   - a `persona_draft` is already on phase_state (rare race: compose
   *     succeeded but the advance upsert never completed in the prior
   *     turn — don't re-compose, let the caller advance through).
   *
   * Idempotency: at most one in-flight compose per (project_slug,
   * observed_at) window. Both call-sites (`normalAdvance` and
   * `emitCurrentPhasePrompt`) run inside `advance()` which holds the
   * per-instance ordering via `clearResolvedSpecCache` + sequential
   * awaits; a second concurrent advance() would read `persona_draft`
   * (or `persona_compose_failure_reason`) from the now-updated state
   * and short-circuit here.
   */
  async shouldRetrySynthesizePersonaOnResume(
    state: OnboardingState,
  ): Promise<boolean> {
    return personaShouldRetrySynthesizePersonaOnResume(this, state)
  }

  /**
   * T1 (2026-05-13) — fire `PersonaComposer.compose()` on the transition
   * INTO `persona_synthesizing` per docs/plans/P2-onboarding.md § 2.6 +
   * § 4.8. The caller has already advanced state to `persona_synthesizing`
   * and persisted the captured signals on phase_state. This method:
   *
   *   1. Builds a `ComposeInput` from the persisted signals + fallback
   *      blend (T5 wires the real archetype lookup; until then a
   *      `PERSONA_FALLBACK_BLEND` keeps the pipeline runnable so
   *      downstream wiring lands in front of every archetype + import
   *      branch).
   *   2. Calls `personaComposer.compose(...)` which runs the cringe-
   *      check loop internally and throws `PersonaError` on cap
   *      exceeded.
   *   3. On success: stashes the returned `PersonaDraft` into
   *      phase_state (so the dynamic `persona_reviewed` body can render
   *      first-30-line slices) and advances the state to
   *      `persona_reviewed` so the caller's emit branch fires the
   *      review prompt.
   *   4. On failure: stays at `persona_synthesizing`, persists
   *      `persona_compose_failure_reason`, and directly emits the
   *      Try-again / Use-basic-template / Skip-persona fallback prompt.
   */
  async synthesizePersona(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<OnboardingState> {
    return personaSynthesizePersona(this, input, state, observed_at)
  }

  /**
   * T1 (2026-05-13) — dispatch a button choice on the `persona_reviewed`
   * phase. Handles the [A] Looks good / [B] Edit one line / [C] Restart
   * options on the top-level review prompt AND the freeform replies
   * inside the `pick_line`, `pick_replacement`, and `pending_regen_hint`
   * sub-flows.
   */
  async consumePersonaReviewedChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    return personaConsumePersonaReviewedChoice(this, input, state, choice, was_new, observed_at)
  }

  /**
   * T1 (2026-05-13) — handle the fallback prompt on `persona_synthesizing`
   * when a prior compose attempt failed. Three options:
   *
   *   - Try again → re-invoke `compose()` with the same inputs
   *   - Use basic template → commit a stub draft + advance to
   *     persona_reviewed
   *   - Skip persona → commit a stub draft tagged `skipped` + advance
   */
  async consumePersonaSynthesizingChoice(
    input: AdvanceInput,
    state: OnboardingState,
    choice: ButtonChoice,
    was_new: boolean,
    observed_at: number,
  ): Promise<AdvanceResult> {
    return personaConsumePersonaSynthesizingChoice(this, input, state, choice, was_new, observed_at)
  }

  async advancePersonaSynthToReviewed(
    input: AdvanceInput,
    observed_at: number,
    serialized_draft: ReturnType<typeof serializeDraft> | null,
  ): Promise<AdvanceResult> {
    return personaAdvancePersonaSynthToReviewed(this, input, observed_at, serialized_draft)
  }

  async advanceFromPersonaReviewed(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
  ): Promise<AdvanceResult> {
    return personaAdvanceFromPersonaReviewed(this, input, state, observed_at)
  }

  async reEmitPersonaReviewed(
    input: AdvanceInput,
    state: OnboardingState,
    observed_at: number,
    patch: Record<string, unknown>,
  ): Promise<AdvanceResult> {
    return personaReEmitPersonaReviewed(this, input, state, observed_at, patch)
  }
}

/**
 * 2026-06-10 (wow-hang-resilience) — hard timeout for the best-effort
 * project-seed pass inside `dispatchWowAndAdvance`. Generous: seeding
 * walks N projects with template composition + SQLite writes (sub-second
 * each); anything past this is a wedged downstream dependency, not work.
 */
const WOW_SEED_TIMEOUT_MS = 60_000

/**
 * Race a promise against a hard deadline. Rejects with a tagged Error on
 * timeout (caller catches + logs — every use site here is best-effort).
 * The timer is cleared on the win path so a fast promise doesn't leave a
 * live timer keeping the event loop awake. The losing promise (if it
 * ever settles) is ignored.
 */
async function raceWithTimeout<T>(p: Promise<T>, timeout_ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeout_ms}ms`)),
      timeout_ms,
    )
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}



/**
 * Final-handoff sprint (2026-05-28) — guard the Telegram-bind token
 * against Telegram's `start` payload grammar. After the `bind_` prefix
 * is concatenated inside `buildTelegramBindDeepLink`, the full payload
 * must be `[A-Za-z0-9_-]+` and ≤ 64 chars. The token itself therefore
 * must be `[A-Za-z0-9_-]+` and ≤ 58 chars (64 minus the 6-char prefix).
 *
 * `TELEGRAM_BIND_START_PAYLOAD_PREFIX` + `TELEGRAM_START_PAYLOAD_MAX_LEN`
 * + `TELEGRAM_START_PAYLOAD_GRAMMAR` live in
 * `final-handoff-config.ts`; we re-derive the cap here so the engine
 * stays self-contained for inlining.
 */
const TELEGRAM_BIND_TOKEN_MAX_LEN = 58
const TELEGRAM_BIND_TOKEN_GRAMMAR = /^[A-Za-z0-9_-]+$/

function isTelegramBindTokenShape(token: string): boolean {
  if (token.length === 0 || token.length > TELEGRAM_BIND_TOKEN_MAX_LEN) {
    return false
  }
  return TELEGRAM_BIND_TOKEN_GRAMMAR.test(token)
}

/**
 * P2-v3 S2 (2026-05-18) — narrow projection from the open-shape
 * `phase_state_json` into the typed `RequiredFieldsState` the router's
 * `captured` field expects. The router's prompt template embeds this as
 * a compact JSON blob (bounded ≤ 800 chars) so the LLM can reason
 * about what's already known without us pasting every key on the
 * state bag.
 */
function extractCapturedFromState(
  phase_state: Record<string, unknown>,
): Partial<import('./required-fields-audit.ts').RequiredFieldsState> {
  const out: {
    user_first_name?: string | null
    primary_projects?: ReadonlyArray<unknown>
    non_work_interests?: ReadonlyArray<unknown>
    agent_personality?: string | null
    agent_name?: string | null
  } = {}
  const first = phase_state['user_first_name']
  if (typeof first === 'string') out.user_first_name = first
  const ap = phase_state['agent_personality']
  if (typeof ap === 'string') out.agent_personality = ap
  const an = phase_state['agent_name']
  if (typeof an === 'string') out.agent_name = an
  const pp = phase_state['primary_projects']
  if (Array.isArray(pp)) out.primary_projects = pp
  const nwi = phase_state['non_work_interests']
  if (Array.isArray(nwi)) out.non_work_interests = nwi
  return out as Partial<import('./required-fields-audit.ts').RequiredFieldsState>
}

/**
 * ISSUES #323 — normalize a router `state_delta.non_work_interests` (which a
 * real model emits as either plain strings — "meditation" — or `{name}` objects)
 * into the `ExtractedFields.non_work_interests` `{name, cadence_hint?}[]` shape
 * `mergeGapFillExtractedFields` expects. Drops empty/blank entries; preserves a
 * valid `cadence_hint` when present. Returns `[]` on a non-array input.
 */
function normalizeNonWorkInterestsForExtraction(
  raw: unknown,
): Array<{ name: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{
    name: string
    cadence_hint?: 'weekly' | 'monthly' | 'occasional'
  }> = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const name = entry.trim()
      if (name.length > 0) out.push({ name })
      continue
    }
    if (entry !== null && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>
      const rawName = rec['name']
      if (typeof rawName !== 'string' || rawName.trim().length === 0) continue
      const item: { name: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' } = {
        name: rawName.trim(),
      }
      const cadence = rec['cadence_hint']
      if (cadence === 'weekly' || cadence === 'monthly' || cadence === 'occasional') {
        item.cadence_hint = cadence
      }
      out.push(item)
    }
  }
  return out
}

/**
 * P2-v3 S2 (2026-05-18) — read the last N transcript turns + project
 * to the router's `RouterRecentTurn` shape (drops `system` entries +
 * collapses `phase` / `button_prompt_id` fields the router doesn't
 * need). Returns an empty array when the transcript file is empty or
 * unreadable.
 */
function recentTurnsForRouter(
  transcript: TranscriptWriter,
  n: number,
): ReadonlyArray<RouterRecentTurn> {
  let all: ReturnType<TranscriptWriter['readAll']>
  try {
    all = transcript.readAll()
  } catch {
    return []
  }
  const filtered: RouterRecentTurn[] = []
  for (const entry of all) {
    if (entry.role !== 'agent' && entry.role !== 'user') continue
    filtered.push({ role: entry.role, body: entry.body })
  }
  if (filtered.length <= n) return filtered
  return filtered.slice(filtered.length - n)
}



/**
 * P2 v2 S5 — narrows the persisted `phase_state.import_result` blob
 * into the slim shape the analysis-presentation builder consumes.
 * Tolerant: returns null on missing / malformed input so the failure
 * path collapses to the graceful "couldn't analyze" body instead of
 * crashing in the prompt resolver.
 */
function coerceImportResultForBuilder(
  raw: unknown,
): ImportResultForAnalysisBuilder | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const proposed_raw = r['proposed_projects']
  if (!Array.isArray(proposed_raw)) return null
  const proposed_projects: Array<{ name: string; rationale: string }> = []
  for (const p of proposed_raw) {
    if (typeof p !== 'object' || p === null) continue
    const pp = p as Record<string, unknown>
    if (typeof pp['name'] !== 'string') continue
    if (pp['name'].trim().length === 0) continue
    proposed_projects.push({
      name: pp['name'],
      rationale: typeof pp['rationale'] === 'string' ? pp['rationale'] : '',
    })
  }
  const out: ImportResultForAnalysisBuilder = { proposed_projects }
  const interests_raw = r['inferred_interests']
  if (Array.isArray(interests_raw)) {
    const interests: Array<{ name: string; basis?: string }> = []
    for (const i of interests_raw) {
      if (typeof i === 'string' && i.trim().length > 0) {
        interests.push({ name: i.trim() })
        continue
      }
      if (typeof i !== 'object' || i === null) continue
      const ii = i as Record<string, unknown>
      if (typeof ii['name'] !== 'string' || ii['name'].trim().length === 0) continue
      const entry: { name: string; basis?: string } = { name: ii['name'].trim() }
      if (typeof ii['basis'] === 'string' && ii['basis'].length > 0) entry.basis = ii['basis']
      interests.push(entry)
    }
    if (interests.length > 0) out.inferred_interests = interests
  }
  const confidence_raw = r['confidence_by_inference']
  if (Array.isArray(confidence_raw)) {
    const confidence: Array<{ field: string; score: number; basis?: string }> = []
    for (const c of confidence_raw) {
      if (typeof c !== 'object' || c === null) continue
      const cc = c as Record<string, unknown>
      if (typeof cc['field'] !== 'string') continue
      if (typeof cc['score'] !== 'number' || !Number.isFinite(cc['score'])) continue
      const entry: { field: string; score: number; basis?: string } = {
        field: cc['field'],
        score: cc['score'],
      }
      if (typeof cc['basis'] === 'string' && cc['basis'].length > 0) entry.basis = cc['basis']
      confidence.push(entry)
    }
    if (confidence.length > 0) out.confidence_by_inference = confidence
  }
  // Conversation count — the bullet body's intro clause uses it as
  // the "Based on N conversations" anchor. Honest grounding: ONLY
  // accept the explicit `conversation_count` set by the runner from
  // `aggregated.totals.chunks`. The earlier draft fell back to
  // `entities.length`, but `entities` is the deduped top-50 list
  // (NOT one row per conversation), so the body would systematically
  // misreport ("Based on 2 conversations") for normal imports — Codex
  // r1 P2 flagged this on the S5 PR. When the count is absent
  // (legacy result row pre-`0026_p2_v2_import_results_interests_confidence`),
  // the body collapses to the no-count clause via the builder's
  // `intro_count` check.
  const cc = r['conversation_count']
  if (typeof cc === 'number' && Number.isFinite(cc) && cc > 0) {
    out.conversation_count = cc
  }
  return out
}

/**
 * P2 v2 S5 — derive the rough month span of the Pass-2 result from the
 * topic recency timestamps. Returns null when no usable timestamp is
 * present so the builder falls back to the "(Based on N conversations.)"
 * clause without a months tail.
 *
 * The recency_score field in `import_result.topics` is normalized to
 * [0..1] (per `aggregatePass1`), so we can't derive months from it
 * directly. The engine relies on the post-aggregation persistence
 * layer to also stash the raw min/max timestamps under
 * `import_result.timespan_ms` when available; absent that, return
 * null (current shipped Pass-2 doesn't yet populate that field, so
 * the bullet body simply omits the months clause — see § 2.3 "Based
 * on N conversations" as the minimum honest grounding).
 */
function deriveImportMonthsSpan(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const ts = r['timespan_ms']
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null
  const months = ts / (30 * 24 * 60 * 60 * 1_000)
  if (months < 1) return Math.max(1, Math.round(months))
  return Math.round(months)
}


/**
 * GAP1 (onboarding-wow-handoff-fix, 2026-06-09) — count of projects the
 * import proposed for this instance, read defensively off `phase_state`.
 * Feeds the project-funnel telemetry so a future proposed→shelled
 * divergence is observable instead of silent (Sam's 7-proposed→3-shelled
 * regression shipped with zero counters to catch it).
 */
function importProposedCount(phase_state: Record<string, unknown>): number {
  const ir = phase_state['import_result']
  if (ir === null || typeof ir !== 'object') return 0
  const proposed = (ir as Record<string, unknown>)['proposed_projects']
  return Array.isArray(proposed) ? proposed.length : 0
}

/**
 * GAP1 — emit the project funnel counter as a single structured log line.
 * `proposed` (import) → `presented` (capped at MAX_ANALYSIS_PROJECTS) →
 * `confirmed` (what we will shell). A drop at any hop is now grep-able
 * (`grep 'project_funnel'`) rather than invisible. Kept to a log line (no
 * new table) per the brief's "make divergence observable" scope.
 */
function logProjectFunnel(args: {
  project_slug: string
  stage: string
  proposed: number
  presented: number
  confirmed: number
}): void {
  console.info(
    `[onboarding] project_funnel project=${args.project_slug} stage=${args.stage} ` +
      `proposed=${args.proposed} presented=${args.presented} confirmed=${args.confirmed}`,
  )
}

/** Read an array of strings off `phase_state`. Returns [] on missing /
 *  non-array / empty. Filters out non-string + empty entries. Note: a
 *  sibling helper `readStringArray` further down the file returns
 *  `null` on missing — this one returns `[]` so the gap-fill merge can
 *  spread unconditionally. */
function readGapFillStringArray(
  obj: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> {
  const v = obj[key]
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
}

/** Read the structured non_work_interests array off `phase_state`.
 *  Returns [] on missing / non-array. Each entry per spec § 9.3 is
 *  `{ name, cadence_hint? }`; bare strings get coerced into
 *  `{ name }` for back-compat with v1 imports. */
/** Merge two non_work_interests arrays. Dedupes by case-insensitive
 *  `name`, preserves the first-seen entry's cadence_hint (the LLM may
 *  add a cadence_hint on a follow-up turn for an interest that landed
 *  bare on a prior turn — the cadence_hint is taken from the prior
 *  entry only when the new one omits it). */
function mergeNonWorkInterests(
  prior: ReadonlyArray<{ name: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' }>,
  next: ReadonlyArray<{ name: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' }>,
): ReadonlyArray<{ name: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' }> {
  const seen = new Map<
    string,
    { name: string; cadence_hint?: 'weekly' | 'monthly' | 'occasional' }
  >()
  for (const entry of [...prior, ...next]) {
    const key = entry.name.toLowerCase()
    const existing = seen.get(key)
    if (existing === undefined) {
      seen.set(key, { ...entry })
    } else if (existing.cadence_hint === undefined && entry.cadence_hint !== undefined) {
      seen.set(key, { ...existing, cadence_hint: entry.cadence_hint })
    }
  }
  return Array.from(seen.values())
}

function readPersonaEditTargetSection(
  phase_state: Record<string, unknown>,
): 'voice' | 'about' | 'what-matters' | null {
  const v = phase_state['persona_edit_target_section']
  if (v === 'voice' || v === 'about' || v === 'what-matters') return v
  return null
}

// v0.1.80 (Kieran r1 I1, 2026-05-22) — removed:
//   - `readPersonaFile(phase_state, key)` — was the typed reader for
//     `persona_edit_target_file` used by the legacy `pick_replacement`
//     `applyEdit` flow.
//   - `sectionToFile(section)` — translated `voice|about|what-matters`
//     to the `PersonaFile` enum for the same legacy flow.
//   - `parseLineSelection(reply)` — parsed the user's `voice 3` /
//     `about 7` freeform reply on the `pick_line` sub-flow.
// All three were dead code after the new conversational `Tweak one
// line → pending_regen_hint` path replaced the line-coordinate sub-
// flow. Stale state files that resume in `pick_line` /
// `pick_replacement` are now funneled into the conversational tweak
// path by the consume handler (see `consumePersonaReviewedChoice`).

/**
 * v0.1.80 (2026-05-22) — fallback splitter for the
 * `projects_proposed.share_work` path. Used only when the LLM driver
 * extracts nothing from a freeform reply. The user-facing rejection
 * hint advertises both "one per line" and "comma-separated", so this
 * splits on newlines, semicolons, AND a comma followed by whitespace +
 * a capital letter or digit. Plain mid-sentence commas like "Topline, Inc."
 * stay glued (Kieran r1 I2 — original splitter contradicted the hint).
 * Strips leading numeric / bullet markers, dedupes case-insensitively,
 * caps at 10 entries.
 */
export function splitFreeformProjectList(raw: string): string[] {
  const candidates = raw
    .split(/[\n;]+|,\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .map((s) => s.replace(/^(?:\d+[.)]\s+|[-*•]\s+)/, '').trim())
    .filter((s) => s.length > 0 && s.length <= 120)
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of candidates) {
    const key = c.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
    if (out.length >= 10) break
  }
  return out
}

/**
 * ISSUES #323 — best-effort extract a `work_interview_gap_fill` freeform answer
 * into a clean list of project/interest names. Unlike `splitFreeformProjectList`
 * (which splits a comma ONLY before a capitalised token, so "Topline, Inc."
 * stays glued), a gap-fill reply to "what are you working on?" is a DIRECT list
 * answer, so we split on EVERY comma, semicolon, newline, sentence boundary, and
 * " and "/" & " conjunction, then strip the natural-language wrappers a real
 * reply carries — leading bullet/number markers, parenthetical asides ("Neutron
 * (open source agent harness)" → "Neutron"), and list lead-ins ("running three
 * companies:", "side project", "my projects are", "I'm working on", "also",
 * "plus").
 *
 * CONSERVATIVE by design (Argus r1 — avoid garbage extraction from prose). The
 * heuristic CANNOT reliably pull names out of a prose sentence ("I run Caldera,
 * a fragrance brand, and I am building out its ops and automation" would yield
 * fragments like "I run Caldera"), so we only emit a result when the answer is
 * genuinely LIST-SHAPED: a MAJORITY of its segments must be "name-like" — short
 * (≤ 6 words) and not opening with a pronoun/article/aux ("I", "a", "the",
 * "we", …). When that bar isn't met we return `[]`, and the caller falls back to
 * the unchanged advance-with-empty-patch behaviour (which parks at
 * `projects_proposed` where the share-work flow + `splitFreeformProjectList` can
 * still catch it). This recovers a tidy comma list ("Tabs, Pristine, Amascence,
 * Neutron, Robobuddha, meditation") AND the proper-noun-rich shape Ryan actually
 * typed ("Running three companies: Tabs, Pristine and Amascence. Side project
 * Neutron (open source agent harness), side project Robobuddha, and
 * meditation.") to the same six items, while leaving a single-company prose
 * answer to the existing fallback rather than fabricating junk projects. Returns
 * only the name-like segments (drops the prose ones), dedupes
 * case-insensitively, caps at 10. Fine-grained project-vs-interest separation
 * within one answer needs real LLM extraction (follow-up); everything kept maps
 * to the single field the gap-fill is currently collecting.
 */
export function parseGapFillFreeformList(raw: string): string[] {
  const candidates = raw
    .split(/[\n;,.]+|\s+(?:and|&)\s+/i)
    .map((s) => s.trim())
    .map((s) => s.replace(/^(?:\d+[.)]\s*|[-*•]\s*)/, '').trim())
    .map((s) => s.replace(/\([^)]*\)/g, '').trim())
    .map((s) =>
      s
        .replace(
          /^(?:running\s+(?:\w+\s+)?companies?:?\s*|side\s+projects?:?\s*|my\s+projects?\s+(?:are|is):?\s*|i'?m\s+working\s+on:?\s*|i\s+am\s+working\s+on:?\s*|working\s+on:?\s*|projects?:?\s*|also\s+|plus\s+)/i,
          '',
        )
        .trim(),
    )
    .filter((s) => s.length > 0 && s.length <= 120)
  if (candidates.length === 0) return []
  // Stop-words a project name never opens with — their presence at the start of
  // a segment marks it as a prose fragment, not a name.
  const STOP_WORDS = new Set<string>([
    'i',
    'im',
    'we',
    'us',
    'my',
    'our',
    'a',
    'an',
    'the',
    'it',
    'its',
    'they',
    'their',
    'this',
    'that',
    'building',
    'doing',
    'making',
  ])
  const isNameLike = (s: string): boolean => {
    const words = s.split(/\s+/)
    if (words.length > 6) return false
    const first = (words[0] ?? '').toLowerCase().replace(/[^a-z']/g, '')
    return first.length > 0 && !STOP_WORDS.has(first)
  }
  const nameLike = candidates.filter(isNameLike)
  // Require a list-shaped answer: at least one name-like segment AND a majority
  // of all segments name-like. Prose ("I run Caldera, …") fails this and yields
  // []; a clean list or a single bare name passes.
  if (nameLike.length === 0 || nameLike.length * 2 < candidates.length) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of nameLike) {
    const key = c.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
    if (out.length >= 10) break
  }
  return out
}

/**
 * T2 (2026-05-13) — defensive read for an array of records stashed in
 * `phase_state`. Returns `[]` when the key is absent or the value is
 * not an array. Callers cast to the target row shape — phase-state is
 * intentionally untyped JSON, so per-entry validation is the action's
 * responsibility (every wow-action `triggerCondition` guards against
 * malformed entries).
 */
function readArray<T>(obj: Record<string, unknown>, key: string): T[] {
  const v = obj[key]
  if (!Array.isArray(v)) return []
  return v as T[]
}

// P2 v2 § 0 #9 — archetype-blend serializer + parser helpers removed
// with the deletion of the engine-side archetype dispatch. The
// surviving helper is `readBlendedArchetype`, used by the wow-dispatcher
// signal builder to read pre-stashed blends from migration 0025 phase
// state. New flows never write `phase_state.archetype_blend` from the
// engine; the curated blend lives only inside `PersonaComposer.compose`.

function readBlendedArchetype(
  phase_state: Record<string, unknown>,
): BlendedArchetype | null {
  const v = phase_state['archetype_blend']
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (
    !Array.isArray(o['slugs']) ||
    typeof o['display_label'] !== 'string' ||
    typeof o['voice_md'] !== 'string' ||
    typeof o['comm_md'] !== 'string' ||
    typeof o['decision_md'] !== 'string'
  ) {
    return null
  }
  const slugs = (o['slugs'] as unknown[]).filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  )
  if (slugs.length === 0) return null
  return {
    slugs,
    display_label: o['display_label'],
    voice_md: o['voice_md'],
    comm_md: o['comm_md'],
    decision_md: o['decision_md'],
  }
}

// Codex r6 [P1] — resolveAgentName helper removed. Agent name is now
// captured explicitly at the name_chosen transition (when next_phase
// is 'agent_name_chosen' inside consumeChoice) using ONLY the freeform_text
// attached to the resolving choice. Button-only choices leave
// agent_name null. This avoids drift from stale `last_choice_freeform`
// state that survived earlier freeform answers (e.g. archetypes typed
// in import_offered).

// R5 / audit P2-4 — `describeRejection` relocated to engine-internals.ts
// (consumed by the extracted slug free functions in engine-slug.ts).
