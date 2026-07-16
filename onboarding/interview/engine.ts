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
} from '@neutronai/channels/button-primitive.ts'
import type { ButtonStore } from '@neutronai/channels/button-store.ts'
import {
  isLegalTransition,
  LEGAL_TRANSITIONS,
  TERMINAL_PHASES,
  type OnboardingPhase,
  type OnboardingDeploymentMode,
} from './phase.ts'
import {
  buildAgentNameChosenPromptSpec,
  buildPersonalityOfferedPromptSpec,
  buildProjectsProposedPromptSpec,
  buildResumePromptBody,
  IMPORT_RESUME_CHOICE_VALUE,
  parseCharacterChoiceIndex,
  parsePersonalitySuggestionIndex,
  PERSONALITY_CHARACTER_PREFIX,
  PERSONALITY_SUGGESTION_PREFIX,
  DEFAULT_PERSONALITY_SUGGESTIONS,
  RESUME_PROMPT_OPTIONS,
  STATIC_PHASE_SPECS,
  validateAgentName,
  type PersonaReviewSubStep,
  type PhasePromptSpec,
} from './phase-prompts.ts'
import {
  characterNamesInRenderOrder,
  type CharacterSuggesterResult,
  type PersonalityCharacterSuggester,
  type PersonalityCharacterSuggestions,
} from './personality-character-suggester.ts'
import {
  type AgentNameSuggester,
  type AgentNameSuggesterResult,
  type AgentNameSuggestions,
} from './agent-name-suggester.ts'
import type { PersonaSummarizer } from '../persona-gen/summarize.ts'
import type { OnboardingStateStore, OnboardingState } from './state-store.ts'
// Sprint B (2026-05-20) — engine-facing slug-picker types lifted to
// `runtime/slug-picker-types.ts` so this Open-classified module no
// longer takes an import edge on the Managed provisioning layer. The
// Managed bridge (slug-picker-bridge.ts in onboarding-api)
// returns the same `SlugPickerOutcome` shape via the
// `SlugPickerEngineHook` DI seam below.
import {
  suggestedSlugFromAgentName,
} from '@neutronai/runtime/slug-picker-types.ts'
import type {
  PlatformAdapter,
  SlugAvailabilityProbe,
} from '@neutronai/runtime/platform-adapter.ts'
import { extractAgentNameFromFreeform } from './extract-agent-name.ts'
import {
  getKnowledgeForPhase,
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
  readNonWorkInterests,
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
// D9c — `splitFreeformProjectList` was carved into
// `engine-projects-proposed.ts` with the `projects_proposed` flow. Re-export
// it from engine.ts so existing deep importers of the helper keep resolving
// from this module (matches the relocated-surface convention above).
export { splitFreeformProjectList } from './engine-projects-proposed.ts'
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
  consumePersonaSynthesizingChoice as personaConsumePersonaSynthesizingChoice,
  advancePersonaSynthToReviewed as personaAdvancePersonaSynthToReviewed,
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
// D9a — the `SpecResolutionFlow` (phase-prompt spec-resolution path) was
// extracted from this god-class into a cohesive leaf sibling. The public
// `resolvePhasePromptSpec` cache-wrapper below still lives on the class
// (co-located with the same-turn cache field + `clearResolvedSpecCache` /
// `invalidateResolvedSpec`, whose callers stay in engine.ts) and delegates
// the uncached resolution to the extracted free function verbatim.
import { resolvePhasePromptSpecUncached } from './engine-spec-resolution.ts'
import { createLogger } from '@neutronai/logger'

const log = createLogger('onboarding-engine')

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
   * fix) callers MUST pass the FROZEN `owner_handle` — NOT the
   * mutable `url_slug` (== `project_slug` post-canonicalisation) — so
   * that secret rows survive an instance rename. When this engine is
   * wired with `deps.owner_handle` (production via
   * `build-landing-stack.ts`), that frozen value is used. Tests and
   * legacy callers that don't supply it fall back to `project_slug`
   * for back-compat: pre-rename, the two values are identical, so the
   * fallback is harmless until a rename occurs (and those legacy
   * callers don't exercise the rename path).
   */
  secretsIdentity(project_slug: string): string {
    if (
      typeof this.deps.owner_handle === 'string' &&
      this.deps.owner_handle.length > 0
    ) {
      return this.deps.owner_handle
    }
    return project_slug
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
      channel_kind: signup_via === 'telegram' ? 'telegram' : 'app_socket',
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
        log.warn('send_agent_text_failed', {
          project: input.project_slug,
          phase,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
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
        log.warn('emit_phase_prompt_send_undelivered', {
          project: input.project_slug,
          topic: input.topic_id,
          prompt: emit.prompt_id,
          phase: input.phase,
          note: 'leaving delivered_at=null so reconnect re-emit catches it',
        })
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
    const spec = await resolvePhasePromptSpecUncached(this, project_slug, user_id, phase)
    if (spec !== null) this.writeResolvedSpec(project_slug, phase, spec)
    return spec
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
   * `selfOwnerHandle` is intentionally omitted — the picker computes
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
