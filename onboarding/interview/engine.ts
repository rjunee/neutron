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
  IMPORT_SOURCE_SWITCH_ACK,
  LATE_UPLOAD_SOURCE_MISMATCH_NOTICE,
  detectImportSourceMention,
} from './import-source-copy.ts'
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
// K11a5 — the LIVE open-mode agent-name half was split out to
// `./engine-agent-name.ts`; the managed `slug_chosen` remainder stays in
// `./engine-slug.ts`. Aliases are unchanged.
import {
  consumeAgentNameChosenChoice as slugConsumeAgentNameChosenChoice,
  getOrStartCharacterSuggestions as slugGetOrStartCharacterSuggestions,
  getOrStartAgentNameSuggestions as slugGetOrStartAgentNameSuggestions,
  maybeAutoAdvancePastMaxOauthOffered as slugMaybeAutoAdvancePastMaxOauthOffered,
  suggestionFingerprint as slugSuggestionFingerprint,
  suggestionKeyPrefix as slugSuggestionKeyPrefix,
} from './engine-agent-name.ts'
import {
  computeSlugSuggestionsForPhase as slugComputeSlugSuggestionsForPhase,
  consumeSlugChosenChoice as slugConsumeSlugChosenChoice,
  advanceFromSlugChosen as slugAdvanceFromSlugChosen,
  persistRejectionAndReEmit as slugPersistRejectionAndReEmit,
  reEmitSlugChosen as slugReEmitSlugChosen,
} from './engine-slug.ts'



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
    // freeform edits ("drop #2, add Studio Sessions") are extracted +
    // unioned-minus-removals upstream on the live CC session
    // (`post-turn-extractor.ts`) before this handler runs, so the persisted
    // `primary_projects` is already the post-edit view. Confirm it here;
    // never silently shrink it.
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
      // on the live CC session (`post-turn-extractor.ts`); this body builder
      // just renders the persisted `primary_projects` via
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
    // freeform-field extraction now flows exclusively through the live CC
    // session (`post-turn-extractor.ts`).
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
// (consumed by the extracted slug free functions in engine-slug.ts +
// engine-agent-name.ts).
