/**
 * @neutronai/gateway/realmode-composer — landing-stack factory (Sprint 19 P3).
 *
 * Per docs/plans/2026-05-05-002-feat-sprint-19-realmode-composer-wiring-plan.md
 * § Phase 3. The boot path composes a per-instance gateway from a handful of
 * narrow primitives (button-store, onboarding state, transcript writer,
 * web sender registry, JWT verifier, etc.). Inlining this wiring at the
 * call site duplicates ~30 LOC across boot / e2e tests / realmode tests
 * and makes it easy to drift apart. This factory is the single shape of
 * truth.
 *
 * Returns a `LandingStack` (the same `{ fetch, websocket }` pair the
 * existing `createLandingServer` exposes — aliased here so callers depend
 * on a named export rather than `ReturnType<typeof createLandingServer>`,
 * per the TS-reviewer recommendation in the Phase 3 plan section).
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ProjectDb } from '../../persistence/index.ts'
import type { CronJobRegistry } from '../../cron/jobs.ts'
import { resolveDeploymentMode } from '../deployment-mode.ts'
import { JwksCache } from '../../jwt-validator/validator.ts'
import { buildJwksResolveKey } from '../../jwt-validator/resolve-key.ts'
import { ButtonStore } from '../../channels/button-store.ts'
import { buildOnboardingHandoffHook } from './build-onboarding-handoff.ts'
import {
  buildRoutedSendButtonPrompt,
  buildRoutedSendImportProgress,
  buildWebChatBridge,
  InMemoryWebChatSenderRegistry,
  type SlugHistoryShimStore,
  type OwnerRegistryLookup,
  type WebChatSenderRegistry,
} from '../http/chat-bridge.ts'
import {
  InterviewEngine,
  type ImportJobRunnerHook,
  type ImportPayloadResolver,
  type ImportResumeReadinessProbe,
  type MaxOAuthEngineHook,
  type MaxOauthSecretsStore,
  type PersonaComposerHook,
  type PersonaSyncHook,
  type ProfilePicEngineHook,
  type SlugHistoryLookup,
  type SlugPickerEngineHook,
  type WowDispatcherHook,
  type WowPushEmitter,
} from '../../onboarding/interview/engine.ts'
import type { SqliteOnboardingStateStore as OnboardingStateStoreType } from '../../onboarding/interview/sqlite-state-store.ts'
import { PersonaComposer } from '../../onboarding/persona-gen/compose.ts'
import { buildCringeChecker } from '../../onboarding/persona-gen/cringe-check.ts'
import { ArchetypeLibrary } from '../../onboarding/archetypes/library.ts'
import type {
  PhaseSpecResolver,
  LlmCallFn,
} from '../../onboarding/interview/phase-spec-resolver.ts'
import { SqliteOnboardingStateStore } from '../../onboarding/interview/sqlite-state-store.ts'
import { TranscriptWriter } from '../../onboarding/interview/transcript.ts'
// Sprint B (2026-05-20) — `ConsumedTokensStore` interface +
// `InMemoryConsumedTokens` lifted to `runtime/`. The production
// SQLite-backed variant stays Managed; this Open-classified factory
// only ever defaults to the in-memory store, so the runtime/ import is
// sufficient and the search-grep is clean.
import type { ConsumedTokensStore } from '../../runtime/start-token-types.ts'
import { InMemoryConsumedTokens } from '../../runtime/consumed-tokens-in-memory.ts'
import type { PendingRedirectStore } from '../../runtime/pending-redirect-types.ts'
import { createLandingServer, type LandingServer } from '../../landing/server.ts'
import { buildWowDispatcherHook } from './build-wow-dispatcher.ts'
import { buildProjectDocComposer } from './build-project-doc-composer.ts'
import { buildProjectPageIndexer } from './build-project-page-indexer.ts'
import { buildGatewayAnthropicMessagesClient } from './build-llm-router.ts'
import {
  buildImportJobRunnerHook,
  buildImportResumeReadinessProbe,
  ChainedImportPayloadResolver,
  FilesystemImportPayloadResolver,
  UrlPasteImportPayloadResolver,
} from './build-import-job-runner.ts'
import { buildSynthesisSession } from './build-synthesis-session.ts'
import { buildSynthesisImportJobRunner } from './build-synthesis-import-runner.ts'

export interface BuildLandingStackInput {
  db: ProjectDb
  project_slug: string
  owner_home: string
  jwks: JwksCache
  static_dir: string
  /**
   * P1.5 § 1.5.5 — frozen `internal_handle` for THIS instance. Threaded
   * into `buildWebChatBridge` so the JWT slug-history shim can verify
   * old-slug claims against THIS instance's history (cross-instance
   * safety).
   *
   * Argus r2 [BLOCKING #1] — required, not optional. Prior shape left
   * this off, which silently disabled the shim in production and 401'd
   * every old-slug JWT post-rename. The composer asserts a non-empty
   * value at boot so misconfiguration surfaces loudly rather than as
   * a slow-burn user-visible disconnect on first rename.
   */
  internal_handle: string
  /**
   * P1.5 § 1.5.5 — slug-history grace-window store. Production wires
   * an `InMemorySlugHistoryCache` wrapping a
   * `buildSlugHistoryShimFromRegistry(registry SlugHistoryStore)`
   * adapter; the cache is push-invalidated by the
   * `/internal/cache-invalidate` route after the rename orchestrator
   * commits. Required (Argus r2 BLOCKING #1) — see `internal_handle`
   * above for the same rationale.
   */
  slugHistoryStore: SlugHistoryShimStore
  /**
   * 2026-05-13 — engine-side slug-history lookup for the no-restart-rename
   * lazy-rekey path in `InterviewEngine.start`. Production wires this
   * against the registry's `SlugHistoryStore.listForInternalHandle(...)`
   * adapter (returns `old_slug[]` for THIS instance only). Optional for
   * back-compat — when omitted, the lazy-rekey fallback in `engine.start`
   * stays inert and a deploy / restart mid-onboarding-after-rename loses
   * the user's progress (the failure mode this dep fixes).
   */
  engineSlugHistory?: SlugHistoryLookup | null
  /**
   * 2026-05-13 — no-restart slug rename. When supplied, the
   * `validateStartToken` path accepts a JWT whose `project_slug` claim
   * mismatches `project_slug` (the gateway's boot-time slug) AS LONG AS
   * the registry's CURRENT `url_slug` for `internal_handle` matches
   * the claim. Production wires this against the live `OwnersRegistry`;
   * tests can pass a stub or omit to fall back to slug-history-only
   * acceptance.
   */
  ownerRegistry?: OwnerRegistryLookup
  /**
   * P1.5 / Sprint 21 — slug-picker engine hook. When provided, the
   * onboarding engine drives the `slug_chosen` phase through the
   * picker bridge so a user-typed slug fires a live rename and an
   * agent confirmation message arrives on the same WS. When omitted
   * (or null), the engine still emits the picker prompt but ONLY the
   * "Skip for now" option appears (per
   * `buildSlugChosenPromptSpec({slug_picker_configured:false})`).
   *
   * Production composer (`gateway/index.ts`) resolves the hook
   * synchronously at boot via `resolveSlugPickerEngineHook` and passes
   * either the resolved hook or null. Tests inject a stub hook
   * directly. The hook + the chat-bridge MUST share the same
   * `WebChatSenderRegistry` instance — pass `webRegistry` below to
   * pre-construct the registry outside this factory and thread it
   * through the hook construction.
   */
  slugPicker?: SlugPickerEngineHook | null
  /**
   * Optional pre-constructed web sender registry. When provided, the
   * landing stack uses it instead of creating its own — used by the
   * production composer so the resolved slug-picker hook can hold a
   * reference to the SAME registry the chat-bridge does.
   */
  webRegistry?: import('../http/chat-bridge.ts').WebChatSenderRegistry
  /**
   * Sprint 28 — profile-pic engine hook. When provided, the onboarding
   * engine drives `profile_pic_generating` through the Gemini Imagen
   * pipeline + the persistence fan-out (registry pointer + Telegram
   * bot avatar). When null/undefined, the engine emits a skip-only
   * placeholder. Production composer (`gateway/index.ts`) builds the
   * hook via `buildProfilePicEngineHook(...)` against the per-instance
   * `ProfilePicPipeline`; tests inject a stub.
   */
  profilePic?: ProfilePicEngineHook | null
  /**
   * Sprint 30 — persona-sync engine hook. When provided, the engine
   * lands the chosen agent_name on the canonical `agent_name` registry
   * column at the `signup` → `name_chosen` transition. When
   * null/undefined the engine no-ops and the column stays at its
   * provisioning-time default. Production wires this in
   * `gateway/index.ts` against `owners_registry.setAgentName(...)`;
   * tests inject a recorder.
   */
  personaSync?: PersonaSyncHook | null
  /**
   * T1 (2026-05-13) — persona composer hook. When provided, the engine
   * fires `compose()` on the transition INTO `persona_synthesizing` and
   * drives the [A] Looks good / [B] Edit one line / [C] Restart sub-
   * flow on `persona_reviewed`. When omitted, the factory builds a
   * default `PersonaComposer` from `buildCringeChecker()` + writes the
   * persona files to `<owner_home>/persona/SOUL.md` etc. Tests inject
   * a recorder; production gets the real composer for free.
   */
  personaComposer?: PersonaComposerHook | null
  /**
   * P2 v2 § 0 #9 + § 7.1 — curated archetype library. Consumed at
   * SYNTHESIS time inside `PersonaComposer.compose` via
   * `composeFromFreeText` to lift curated voice fragments out of the
   * free-text `agent_personality`. NOT wired into `InterviewEngine` —
   * the engine no longer routes the personality_offered phase through
   * the library (decision #9: "Personality is a free-text field, not
   * an enum").
   *
   * When omitted, the factory builds a default `ArchetypeLibrary`
   * against the in-repo curated md files at `onboarding/archetypes/data/`
   * and a per-instance LLM-extension cache at
   * `<owner_home>/cache/archetype-extensions/`. The default library
   * has no `generateExtension` substrate wired (tests + dev cycles
   * inject one); curated-match-only is the safe production default
   * until the substrate-extension prompt + per-instance LLM credentials
   * are threaded through. Pass `null` to skip curated matching entirely
   * — `composeFromFreeText` then returns a pure free-text blend driven
   * by the personality phrase itself.
   */
  archetypes?: ArchetypeLibrary | null
  /**
   * Sprint 30 — durable replay window for start-token JTIs. When
   * provided, the bridge uses the SQLite-backed store; when omitted,
   * falls back to `InMemoryConsumedTokens` (the legacy Sprint 19
   * behaviour). Production composer always passes the SQLite store
   * so a process bounce inside the 15-min start-token TTL no longer
   * lets the same JTI be re-claimed.
   */
  consumedTokens?: ConsumedTokensStore | null
  /**
   * LLM-driven prompts sprint (2026-05-09) — phase-spec resolver. When
   * provided AND a given phase is in the resolver's enabled set, the
   * onboarding engine asks BEST_MODEL (Opus 4.7) to rephrase the
   * body+options instead of using the static `PHASE_PROMPTS` table.
   * Production
   * builds the resolver via `buildPhaseSpecResolver(...)`; tests inject
   * a stub. Pass `null` (or omit) to disable — engine then walks the
   * static spec path identically to today.
   */
  phaseSpecResolver?: PhaseSpecResolver | null
  /**
   * T2 r2 (2026-05-13) — wow-moment dispatcher hook. Production wraps
   * the real `WowDispatcher` (built from the gateway's ReminderStore /
   * CronJobRegistry / CronStateStore / WowChannelAdapter / WowTelemetry)
   * in a closure that pins the FROZEN `internal_handle` as the dispatch
   * identity (NOT the mutable url_slug) so rename across the wow_fired
   * transition does not orphan the dispatched rows. Tests inject a
   * recorder via this field directly.
   *
   * When `null`/undefined, the engine treats `wow_fired` as a silent
   * transit (advance phase, no entry body emit) — the previous
   * behaviour before the T2 wiring. The body emission is gated on a
   * wired hook to avoid the "active-lie" copy Argus called out in r1
   * (PR shipped the body but no production dispatcher).
   */
  wowDispatcher?: WowDispatcherHook | null
  /**
   * 2026-05-22 (push-deeplink-wow sprint) — wow-moment push emitter.
   * When supplied (production composer closes over the per-instance
   * `PushDispatcher` + `DevicePushTokenStore` via
   * `gateway/wow-push-emitter.ts:emitWowPush`), the engine fires it
   * once per instance on entry into `dispatchWowAndAdvance`. When
   * undefined/null, the engine no-ops the push step but still drives
   * the wow dispatcher; the system stays correct under the legacy
   * pre-sprint behaviour.
   */
  wowPushEmitter?: WowPushEmitter | null
  /**
   * 2026-05-28 sidebar + per-project chat topology sprint — handoff
   * hook fired on the `wow_fired` → `completed` transition. The
   * production composer wires `buildOnboardingHandoffHook(...)` from
   * `gateway/realmode-composer/build-onboarding-handoff.ts` against
   * the same `ButtonStore` the engine emits through; tests pass a
   * recorder or omit (the engine no-ops the handoff gracefully).
   */
  onboardingHandoff?: import('../../onboarding/interview/engine.ts').OnboardingHandoffHook | null
  /**
   * Item 5 (2026-06-11, ISSUES #208) — optional LLM opening-message
   * composer threaded into `buildOnboardingHandoffHook` to compose the
   * per-project free-form opening (paragraph + ONE next move, NO
   * buttons) from the Item 4 materialized docs + the cached Pass-2
   * `import_result`. When omitted, the handoff falls back to the
   * deterministic prose path (README first paragraph / import
   * rationale, no LLM call). Production wires this via
   * `buildProjectOpeningMessageComposer({ anthropicClient })` against
   * the same CC-substrate-backed client as the llmRouter / character
   * suggester. Tests that don't exercise the LLM path leave it unset.
   *
   * Ignored when the caller pins `onboardingHandoff` explicitly (the
   * caller's hook is used verbatim — composer is only consulted for
   * the default-built hook).
   */
  projectOpeningComposer?: import('./build-onboarding-handoff.ts').ComposeProjectOpeningFn
  /**
   * T2 r3 (2026-05-13) — shared `CronJobRegistry`. When supplied AND
   * `wowDispatcher` is left unset (production path), threaded through
   * to `buildWowDispatcherHook` so action 07 (overnight-pass) registers
   * its job in the SAME registry the per-instance `CronScheduler` reads
   * from. Without it the registration goes into a dead local registry
   * and the scheduler never fires the job — silently dropping the
   * overnight brief tomorrow morning. Production composer constructs
   * the registry once and threads it into BOTH this field AND
   * `CompositionInput.cron_jobs` so scheduler + wow-dispatcher share.
   *
   * Optional for back-compat — when omitted (or when a caller-supplied
   * `wowDispatcher` is present), the wow-dispatcher falls back to a
   * fresh local registry (pre-r3 behaviour). Tests injecting a recorder
   * hook never hit this code path.
   */
  cronJobs?: CronJobRegistry
  /**
   * T2 r3 (2026-05-13) — test seam — wow-dispatcher inter-action pause
   * override. Production omits (uses the 5s default per § 2.5); tests
   * pass 0 to skip the chat-cadence pauses in unit/integration runs.
   * Ignored when a caller-supplied `wowDispatcher` is present.
   */
  wowInterActionPauseMs?: number
  /**
   * T2 r3 (2026-05-13) — test seam — sleep override threaded into both
   * the WowDispatcher (inter-action pause + freeform-ack) and the
   * ActionRunner (substrate-error retry delay). Production omits (uses
   * `Bun.sleep`); tests pass a no-op so the action-runner's 30s retry
   * delay does not blow up wall-clock time when action 01 throws.
   * Ignored when a caller-supplied `wowDispatcher` is present.
   */
  wowSleep?: (ms: number) => Promise<void>
  /**
   * 2026-06-10 (wow-hang-resilience) — per-action hard timeout threaded
   * into the ActionRunner via `buildWowDispatcherHook`. Production
   * omits (60s default per `DEFAULT_ACTION_TIMEOUT_MS`); tests pass a
   * small value so deliberately-hung actions settle within test
   * wall-clock. Ignored when a caller-supplied `wowDispatcher` is
   * present.
   */
  wowActionTimeoutMs?: number
  /**
   * P2 v2 S9 (Codex S9-r1 P1) — picker LLM for the wow-moment LLM
   * selection per spec § 5.3. Threaded into `buildWowDispatcherHook`'s
   * `pickerLlm` so the production composer actually exercises the LLM
   * picker instead of silently falling back to the deterministic
   * predicate set. When absent (or when a caller-supplied
   * `wowDispatcher` is present and reaches this builder), production
   * runs in fallback mode and the wow-dispatcher logs a structured
   * warning on construction.
   */
  wowPickerLlm?: LlmCallFn
  /**
   * 2026-05-28 wow-cleanup r3 (Codex cross-model BLOCKER, Argus r2) —
   * wow-dispatcher prompt-resolution probe poll cadence override (test
   * seam). Production omits and the default-built probe polls every
   * 500ms; tests pass 5-20ms so the probe loop spins tightly. Ignored
   * when a caller-supplied `wowDispatcher` is present.
   */
  wowPromptResolutionPollMs?: number
  /**
   * 2026-05-28 wow-cleanup r3 — sleep override for the default-built
   * `ButtonStoreResolutionProbe`'s poll loop. Distinct from `wowSleep`
   * (which drives the dispatcher's inter-action pause). Production
   * omits (`Bun.sleep`); tests inject a no-op so the probe loop
   * resolves on the first peek without burning wall-clock. Ignored
   * when a caller-supplied `wowDispatcher` is present.
   */
  wowPromptResolutionSleep?: (ms: number) => Promise<void>
  /**
   * 2026-05-28 wow-cleanup r3 — `now()` override for the default-built
   * probe's deadline math. Production omits (`Date.now`); tests inject
   * a deterministic clock. Ignored when a caller-supplied
   * `wowDispatcher` is present.
   */
  wowPromptResolutionNow?: () => number
  /**
   * T4 (2026-05-13) — history-import job-runner hook. When provided,
   * the engine routes the `import_offered` zip choices through it;
   * when null/undefined, the factory default-builds a real
   * `ImportJobRunner` via `buildImportJobRunnerHook(...)` so production
   * walks the spec'd path by construction. Tests inject a recorder
   * via this field directly.
   *
   * Argus-trapping shape: the explicit `null` carve-out lets test
   * harnesses opt out (legacy boot paths during the wiring rollout);
   * production never passes null because the engine's import_offered
   * branch silently collapses to skip when unwired. Per the brief:
   * "Production composer ALWAYS wires the hook".
   */
  importJobRunner?: ImportJobRunnerHook | null
  /**
   * T4 (2026-05-13) — history-import payload resolver. Production wires
   * the per-instance upload pipeline; tests inject buffers via
   * `InMemoryImportPayloadResolver`. Optional — when unwired, the
   * engine kicks off `ImportJobRunner.start` with an empty Buffer
   * placeholder (the runner records a `parse_failed` row; the engine's
   * failed branch surfaces retry/skip).
   */
  importPayloadResolver?: ImportPayloadResolver | null
  /**
   * T4 (2026-05-13) — Pass-1 LLM caller override (test seam). When
   * supplied AND `importJobRunner` is left undefined, threaded into
   * the default-built runner so tests can inject deterministic mocks
   * without rebuilding the entire runner.
   */
  importPass1Llm?:
    | import('../../onboarding/history-import/pass1-triage.ts').Pass1LlmCall
  /**
   * T4 (2026-05-13) — Pass-2 LLM caller override (test seam).
   */
  importPass2Llm?:
    | import('../../onboarding/history-import/pass2-synthesis.ts').Pass2LlmCall
  /**
   * T7 (2026-05-14) — Substrate used to default-build the Pass-1 + Pass-2
   * LLM callers when neither `importPass1Llm` nor `importPass2Llm` is
   * supplied. Production composer constructs a `createClaudeCodeSubstrateAuto(...)`
   * from the resolved Anthropic credentials (Max OAuth > BYO key > env)
   * and passes it here so a real import dispatches Haiku 4.5 + Opus 4.7
   * end-to-end. Per docs/plans/P2-onboarding.md § 2.3 + § 4.7.
   *
   * Tests that drive Pass-1 / Pass-2 paths inject a deterministic
   * `Substrate` stub here so the regression suite exercises the same
   * default-builder production walks (instead of side-stepping the
   * wiring via the `importPass1Llm` / `importPass2Llm` overrides).
   *
   * Resolution order inside `buildImportJobRunnerHook`:
   *   1. Caller-supplied `importPass1Llm` / `importPass2Llm` win
   *      (back-compat with T4 tests).
   *   2. Else: when `importSubstrate` is supplied, build Pass-1 (Haiku)
   *      + Pass-2 (Opus) callers via
   *      `buildPass1SubstrateCaller` / `buildPass2SubstrateCaller`.
   *   3. Else: fall back to the T4 `llm_unwired` throwing closure so the
   *      engine's `failed` sub_step UX still surfaces a user-visible
   *      failure (CLAUDE.md "Spec is the source of truth").
   */
  importSubstrate?: import('../../runtime/substrate.ts').Substrate
  /**
   * 2026-06-17 (Step 2b — synthesis cut-over). Opt the LIVE import flow onto
   * the ONE accumulating synthesis session (`onboarding/synthesis/*` via
   * `buildSynthesisSession` → `buildSynthesisImportJobRunner`) instead of the
   * retired per-chunk `buildImportJobRunnerHook`. The Open single-owner
   * composer sets this `true` (its `cc-synthesis-*` `importSubstrate` is built
   * ACCUMULATING — NO `reset_context_per_turn`). Left undefined/false by the
   * managed composer (whose import substrate is still `ephemeral`) and by every
   * per-chunk test. When an `importJobRunner` is injected directly, that wins
   * regardless of this flag.
   */
  importUseSynthesis?: boolean
  /**
   * P2-v2 S21 (2026-05-17) — telemetry hook fired when the Pass-2
   * substrate caller falls back from Opus 4.7 to Sonnet 4.6 on a 429.
   * Production composer wires this against the per-instance
   * `OnboardingTelemetry`; tests pass a recorder. Optional — when
   * unset, the substrate caller still falls back to Sonnet (the
   * user benefits unconditionally) but no telemetry row lands.
   * See `BuildImportJobRunnerHookInput.onSonnetFallback` for the
   * full contract.
   */
  importOnSonnetFallback?: import('../../onboarding/history-import/index.ts').Pass2SonnetFallbackHook
  /**
   * v0.1.85 (2026-05-23) — credential-kind resolver threaded to the
   * runner so Pass-1 chunk size adapts per-credential at job-start
   * time. Production composer wires this to a callback that re-resolves
   * the Anthropic CredentialPool via the same `resolveLlmCredentials`
   * path the lazy `importSubstrate.resolvePool` uses, then returns the
   * primary credential's `.kind`. Max OAuth (`'oauth'`) → 4096-token
   * chunks (stays under Anthropic's per-call rate-limit gate);
   * everything else → 50K-token chunks (the throughput default).
   *
   * Optional — tests inject a static resolver (constant `'oauth'` /
   * `'api_key'`) to exercise the chunk-size override deterministically.
   * When omitted, the runner preserves the legacy single-target
   * behaviour for back-compat with pre-v0.1.85 test fixtures.
   */
  importGetCurrentCredentialKind?: import('../../onboarding/history-import/index.ts').CredentialKindResolver
  /**
   * 2026-05-25 (import-pipeline-resilience sprint, Bug D + Argus r1
   * BLOCKER #1) — entity-populator write seam threaded into the
   * default-built `ImportJobRunner`. Tests pass a recorder to assert
   * the populator fired on completed / partial paths without writing
   * to disk. Production composer omits — the builder defaults to the
   * real `writeEntity` from `runtime/entity-writer.ts` when
   * `ownerDataDir` is set (the production composer ALSO omits, since
   * the default is `owner_home`).
   */
  importWriteEntity?: import('../../onboarding/history-import/index.ts').EntityPopulatorWriteEntityFn
  /**
   * 2026-05-25 (Bug D + Argus r1 BLOCKER #1) — override the
   * instance-data-dir threaded to the populator. Defaults to
   * `input.owner_home`. Tests may pass an isolated temp dir so each
   * test owns its own `entities/` tree.
   */
  importOwnerDataDir?: string
  /**
   * 2026-05-25 (Bug D + Argus r1 BLOCKER #1) — optional GBrain
   * sync hook fired by `writeEntity` after each committed page.
   * Production composer wires this when GBrain is provisioned for
   * the instance; tests pass a recorder or omit. When undefined the
   * entity writer still emits markdown to disk; only the KG fan-out
   * is skipped (recoverable via a later re-sync sweep).
   */
  importGbrainSyncHook?: import('../../onboarding/history-import/index.ts').ImportPopulatorSyncHook
  /**
   * Item 4 (2026-06-11) — LLM doc composer for the wow-moment project
   * materializer (README + transcript-summary synthesis).
   *
   * Resolution order:
   *   1. Caller-supplied (tests inject a deterministic stub).
   *   2. `null` explicitly → deterministic template docs only.
   *   3. Undefined → default-built over `importSubstrate` (the same
   *      CC-substrate the import pipeline dispatches through) via
   *      `buildProjectDocComposer`; when no substrate is wired either,
   *      falls back to `null` (template docs).
   */
  wowMaterializerComposer?:
    | import('../../onboarding/wow-moment/project-materializer.ts').ProjectDocComposer
    | null
  /**
   * Item 4 (2026-06-11) — memory-layer indexer for the wow-moment
   * project materializer (`writeEntity(kind='project')` + GBrain sync).
   *
   * Resolution order mirrors the composer: caller-supplied → explicit
   * `null` (no indexing) → default-built via `buildProjectPageIndexer`
   * over the SAME ownerDataDir + GBrain sync hook the import
   * entity-populator uses, so project pages land in the identical
   * entities/ tree + memory store.
   */
  wowMaterializerIndexer?:
    | import('../../onboarding/wow-moment/project-materializer.ts').ProjectPageIndexFn
    | null
  /**
   * 2026-05-25 (import-pipeline-resilience sprint, Part G.2 + Argus
   * r1 BLOCKER #3) — `ImportResumeReadinessProbe` threaded to the
   * engine so the `import_analysis_presented` body surfaces the
   * `resume_import` button only when the prior import is genuinely
   * resumable. Default-built via `buildImportResumeReadinessProbe`
   * from `input.db` + `input.owner_home` so production walks the
   * spec'd gate by construction. Pass an explicit `null` to opt
   * out (legacy boot paths during rollout); tests inject a stub.
   * Without the default-build, the engine's
   * `importResumeReadiness` dep stayed unwired in production and
   * `can_resume_import` was always false — the button never
   * rendered even when the ZIP + failed-job row were both present.
   */
  importResumeReadiness?: ImportResumeReadinessProbe | null
  /**
   * T4 (2026-05-13) — SourceParser override (test seam). Lets tests
   * inject a deterministic parser that yields canned conversations
   * without spinning up zip parsing.
   */
  importParse?: import('../../onboarding/history-import/job-runner.ts').SourceParser
  /**
   * T4 (2026-05-13) — clock override threaded into the default-built
   * runner. Tests pass a fixed-time `now()` so chunk timestamps land
   * deterministically.
   */
  importNow?: () => number
  /**
   * T4 (2026-05-13) — uuid override threaded into the default-built
   * runner. Tests pass a deterministic generator so the `job_id` is
   * predictable.
   */
  importUuid?: () => string
  /**
   * Codex r6 P1 (post-T4) — test seam for the default-runner wiring
   * tests that need a non-null hook but never execute a real import.
   * Production composer omits; setting it true silences the strict
   * "pass1Llm / pass2Llm required" guard.
   */
  __allowNoOpLlmForBoot?: boolean
  /**
   * 2026-05-11 — pending-redirect store. Production wires a
   * `SqlitePendingRedirectStore` against the per-instance DB so the
   * slug-picker hook can persist a redirect when its WS-closed-during-
   * rename branch fires, and the chat-bridge's `startSession` can
   * deliver it on the next WS connect.
   *
   * Optional for back-compat: when omitted, the factory constructs the
   * SQLite-backed store automatically from `input.db` so production
   * boots without explicit wiring. Tests can pass `null` to disable
   * the feature, or pass an in-memory stub.
   */
  pendingRedirects?: PendingRedirectStore | null
  /**
   * S17 (2026-05-17) — `GET /recover` handler. Mounted on the per-instance
   * landing surface so a same-origin /recover fetch from chat.ts after a
   * post-slug-rename WS disconnect lands on a handler that can mint a
   * fresh start-token bound to the CURRENT slug.
   *
   * Production composer (`gateway/index.ts`) constructs a closure that
   * calls `signup/recover-handler.ts:handleRecover` with the platform
   * registry lookup + identity DB signing key. Threaded through
   * to `createLandingServer({recoverHandler: …})`.
   *
   * Optional — instances that don't configure identity-service access
   * (dev / smoke) leave this unset and the route falls through to the
   * default 404 chain (parity with the platform proxy's
   * 503-when-unwired behaviour: the chat client falls back to a
   * manual-refresh hint in either case).
   */
  recoverHandler?: (req: Request) => Promise<Response>
  /**
   * 2026-05-27 persistent-session-cookie sprint (Part B) — resolve the
   * cookie-authenticated user's identity for a `/ws/chat` upgrade that
   * arrives with only a session cookie (no `?start=` token). Threaded
   * straight through to `createLandingServer({cookieToUserClaim: …})`
   * without modification.
   *
   * Production composer (`gateway/index.ts`) wires this against the
   * platform registry + `signSessionCookie` /
   * `readSessionCookie` from `landing/session-cookie.ts`, mirroring the
   * `mintStartToken` closure built alongside `recoverHandler`.
   *
   * Optional — dev / smoke deploys that don't co-locate identity (or
   * that haven't set `NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET`) leave
   * this unset and cookie-only `/ws/chat` upgrades 400 the same way a
   * tokenless pre-sprint upgrade did.
   */
  cookieToUserClaim?: (req: Request) => Promise<{
    project_slug: string
    user_id: string
    set_cookie?: string
  } | null>
  /**
   * ISSUES #318 (2026-06-21) — Open Claude-auth gate, threaded straight
   * through to `createLandingServer({chatAuthGate: …})`. When supplied and
   * `isUnauthenticated()` returns true, `GET /chat` renders the
   * "Authenticate Claude" page instead of the chat shell. The Open composer
   * wires it to `resolveOpenLlmPool(env) === null`; Managed leaves it unset.
   */
  chatAuthGate?: {
    isUnauthenticated: () => boolean
  }
  /**
   * Sprint B (2026-05-17) — PlatformAdapter seam. When supplied, the
   * landing stack threads `platform.slugAvailability` into the
   * InterviewEngine so `computeSlugSuggestionsForPhase` runs through
   * the adapter (i.e. consults the live registry / slug-history /
   * reserved-set in Managed; returns always-available in Open). When
   * omitted, the engine falls back to the legacy single-suggestion
   * path — same behaviour as pre-Sprint-B.
   *
   * Per docs/research/neutron-open-vs-managed-architecture-2026-05-17.md
   * § 9 / § A + Codex r1 P2 on PR #138.
   *
   * P2-v3 S2 (Argus r2 BLOCKING #1, 2026-05-18) — ALSO threaded into the
   * engine's `platform` dep so the LLM router's per-phase + bool-on
   * accessors (`getOnboardingConversational` +
   * `getOnboardingConversationalPhases`) actually fire. Without this
   * thread, the `NEUTRON_ONBOARDING_CONVERSATIONAL` env flag is a
   * no-op in production.
   */
  platform?: import('../../runtime/platform-adapter.ts').PlatformAdapter
  /**
   * P2-v3 S2 (Argus r2 BLOCKING #1, 2026-05-18) — LLM router instance.
   * When supplied AND `platform.getOnboardingConversational()` is true
   * AND the current phase has a non-null `PHASE_KNOWLEDGE` entry, the
   * engine's `normalAdvance` freeform fall-through routes the inbound
   * through the router instead of synthesising `__freeform__`. Tests
   * inject a deterministic stub; production composer
   * (`gateway/index.ts`) wires this via
   * `buildGatewayLlmRouter({ anthropicClient, onboardingTelemetry })`
   * with the SAME `OnboardingTelemetry` instance the rest of the
   * composer uses, so router-decision events land in
   * `gateway_events.payload_json` for the M2 metrics view.
   */
  llmRouter?: import('../../onboarding/interview/llm-router.ts').LlmRouter
  /**
   * Scribe phase 1 (2026-06-06) — chat-time knowledge-extraction hook,
   * threaded into the chat-bridge so a real user turn fans into scribe's
   * extract→GBrain path. Production wires `(i) => scribe.handleUserTurn(i)`
   * from the boot shell; tests + Open self-host without scribe omit it and the
   * chat path is unaffected. Closes ISSUES #101 Gap 2.
   */
  scribeOnUserTurn?: (input: {
    project_slug: string
    user_id: string
    topic_id: string
    text: string
    observed_at: number
  }) => void
  /**
   * Substrate-lift S3 (#106) — replay-redelivery store, threaded into the
   * chat-bridge so a (re)connect flushes any recovered replies a crash dropped
   * for this user's conversational channel (`web:<user_id>`). Production wires
   * the same `InMemoryRecoveredReplyStore` instance the per-instance LLM
   * substrate's `onRecoveredReply` sink persists into. Optional — omitted on the
   * `=0` rollback / Open self-host / tests, where the connect path is unaffected.
   */
  recoveredReplyStore?: import('../http/recovered-reply-store.ts').RecoveredReplyStore
  /**
   * ISSUES #204 (post-onboarding spec § ITEM 1) — live-agent turn-runner
   * factory. The runner needs the SAME `ButtonStore` + `TranscriptWriter`
   * instances this factory constructs (persistence + audit must share the
   * engine's stores), so the boot shell passes a FACTORY that receives
   * them and returns the runner; `buildLandingStack` threads the result
   * (plus the onboarding state store, for the phase gate) into
   * `buildWebChatBridge`. Optional — when omitted (Open box without LLM
   * creds, legacy tests), completed-phase messages keep the pre-#204
   * engine no-op path.
   */
  liveAgentTurnFactory?: (pieces: {
    buttonStore: ButtonStore
    transcript: TranscriptWriter
  }) => import('../http/chat-bridge.ts').LiveAgentTurnRunner
  /**
   * v0.1.80 (2026-05-22) — personality character suggester. When wired,
   * the engine fires `generate(...)` on `personality_offered` phase entry
   * and memoizes the 5 character picks into
   * `phase_state.personality_character_suggestions`. On failure the
   * suggester returns its own static fallback so the user still sees a
   * 5-character body. Production wiring (gateway/index.ts) builds this
   * via `buildPersonalityCharacterSuggester({ anthropicClient })` using
   * the same anthropicClient as the llmRouter.
   */
  personalityCharacterSuggester?: import('../../onboarding/interview/personality-character-suggester.ts').PersonalityCharacterSuggester
  /**
   * 2026-05-27 — agent-name suggester. When wired, the engine fires
   * `generate(...)` on `agent_name_chosen` phase entry and memoizes
   * 3-5 picks in `phase_state.agent_name_suggestions`. On failure the
   * suggester returns its own static fallback (Sage / Vera / Orin) so
   * the user still sees a name list. Production wiring (gateway/index.ts)
   * builds this via `buildAgentNameSuggester({ anthropicClient })`
   * using the SAME anthropicClient as the llmRouter + character suggester.
   */
  agentNameSuggester?: import('../../onboarding/interview/agent-name-suggester.ts').AgentNameSuggester
  /**
   * v0.1.80 (2026-05-22) — persona summarizer. When wired, the engine
   * fires `summarize(...)` on `persona_reviewed` phase entry and
   * memoizes the 3-4 sentence summary into
   * `phase_state.persona_reviewed_summary`. On failure the engine falls
   * back to `staticPersonaSummary(...)` so the body is never empty.
   * Production wiring (gateway/index.ts) builds this via
   * `buildPersonaSummarizer({ anthropicClient })`.
   */
  personaSummarizer?: import('../../onboarding/persona-gen/summarize.ts').PersonaSummarizer
  /**
   * 2026-05-28 — per-instance SecretsStore. Threads into the engine so
   * `max_oauth_offered` can (a) detect an existing `max_oauth_refresh`
   * row and auto-skip the connect prompt, and (b) verify the Done-tap
   * landed a row before advancing to `wow_fired`. Production wires the
   * shared `SecretsStore` instance from `gateway/index.ts` (same one
   * `MaxOAuthClient` writes into). Optional for back-compat — when
   * omitted the engine falls back to the env stop-gap detection +
   * surfaces the "Connect failed" rejection on Done.
   */
  secrets?: MaxOauthSecretsStore
  /**
   * 2026-05-28 — Max OAuth handoff hook. Threads into the engine so
   * the "Connect Claude Max" CTA actually fires the upstream handoff.
   * Production wires this against `MaxOAuthClient` (see
   * `gateway/index.ts`). Optional — when omitted, the engine renders
   * "Connect failed; tap to try again." on tap and the user is stuck
   * until the dep is wired.
   */
  maxOauth?: MaxOAuthEngineHook
  /**
   * 2026-05-28 PR #331 fast-follower — Telegram-bind token minter.
   * Threads into the engine so the final-handoff
   * `[B] Connect a Telegram bot` button can surface a verifiable
   * `t.me/<bot>?start=bind_<token>` deep link. Production composer
   * (`gateway/index.ts`) wires this via `buildMintTelegramBindToken`
   * against `NEUTRON_TELEGRAM_BIND_SECRET`; when the secret is unset
   * (dev / smoke deploys) the field stays `undefined` and the engine
   * falls back to its per-request opaque nonce — still grammar-safe
   * for Telegram's start payload, but non-verifiable.
   *
   * Pre-PR #331 fast-follower the dep existed only on the engine
   * (added in PR #331) without a production wiring path, so every
   * production deep-link URL fell through to the nonce branch. Argus
   * r1 (2026-05-28) IMPORTANT #2 — this thread closes that loop.
   */
  mintTelegramBindToken?: (input: {
    project_slug: string
    user_id: string
  }) => Promise<string | null>
}

/**
 * Aliased to `LandingServer` so the realmode-composer surface stays
 * stable even if the landing module grows additional return fields. A
 * named alias avoids `ReturnType<typeof createLandingServer>` (TS
 * reviewer feedback — keeps the export shape grep-able and stable
 * against refactors of the function signature).
 */
export type LandingStack = LandingServer

/**
 * Trident 6 (2026-05-13) — extended return shape that also exposes the
 * `InterviewEngine` instance built inside the factory so the boot
 * shell can wire the resume-on-reconnect cron (which needs an engine
 * reference) without having to re-construct it. Existing `.fetch` /
 * `.websocket` accesses on the return value continue to work because
 * the engine is a NEW field on top of the LandingStack surface.
 */
export interface LandingStackWithEngine extends LandingStack {
  engine: InterviewEngine
  /**
   * 2026-05-25 (Part G + Argus r1 BLOCKER #2) — surface the
   * `ImportJobRunnerHook` so the boot shell's
   * `POST /api/import/<job_id>/resume` handler dispatches against
   * the SAME runner instance the engine drives. Without sharing
   * the same instance, a resume would build a parallel runner that
   * didn't see the in-flight cron tick state. `null` when the
   * boot path passed `importJobRunner: null` explicitly.
   */
  importJobRunner: ImportJobRunnerHook | null
  /**
   * 2026-05-25 (Argus r1 BLOCKER #2) — payload resolver shared with
   * the resume handler so the HTTP route walks the same
   * filesystem / URL-paste chain the runner does.
   */
  importPayloadResolver: ImportPayloadResolver | null
  /**
   * 2026-05-25 (Argus r1 BLOCKER #2) — onboarding state store
   * shared with the resume handler so the post-dispatch upsert
   * lands on the SAME `(project_slug, user_id)` row the engine
   * polled.
   */
  stateStore: OnboardingStateStoreType
  /**
   * Chat-history hydration (2026-05-28) — surface the per-instance
   * `ButtonStore` so the boot shell can construct the
   * `GET /api/v1/chat/history` surface against the SAME instance
   * the engine writes to. Without sharing the store, a history
   * read would walk a parallel DB connection / cache and could
   * miss in-flight emits.
   */
  buttonStore: ButtonStore
  /**
   * Reminders fire-time delivery (2026-06-20, audit P0-2) — surface the
   * per-instance `WebChatSenderRegistry` so the boot shell can build the
   * reminder outbound against the SAME registry the chat-bridge registers
   * per-socket senders on. A fired reminder persists a durable history row
   * via `buttonStore` AND best-effort live-pushes through this registry, so
   * the registry must be the live one the open WS sockets bind to.
   */
  registry: WebChatSenderRegistry
}

/**
 * Compute the default landing static dir relative to this source file.
 * Resolves to `<repo>/landing` because this file lives at
 * `<repo>/gateway/realmode-composer/build-landing-stack.ts`.
 */
function defaultLandingDirFromRepo(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', '..', 'landing')
}

/**
 * Resolve the directory that holds `chat.html` + (optionally) the
 * compiled `chat.js`. Honors `NEUTRON_LANDING_STATIC_DIR` for production
 * deploys; falls back to the in-repo `landing/` directory for dev /
 * tests. Throws when neither exists so misconfiguration surfaces at
 * boot rather than via a 500 on the first `/chat` request.
 */
export function resolveLandingStaticDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env['NEUTRON_LANDING_STATIC_DIR']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    if (!existsSync(fromEnv)) {
      throw new Error(
        `NEUTRON_LANDING_STATIC_DIR=${fromEnv} does not exist on disk`,
      )
    }
    return fromEnv
  }
  const fallback = defaultLandingDirFromRepo()
  if (!existsSync(fallback)) {
    throw new Error(
      `landing static dir not found: NEUTRON_LANDING_STATIC_DIR unset and dev fallback ${fallback} does not exist`,
    )
  }
  return fallback
}

/**
 * Bag of fixtures shared between buildLandingStack + the testable
 * onboarding-engine factory below. Exported so the wiring regression
 * test in `wow-fired-composer.test.ts` can drive the SAME engine path
 * production walks without spinning the entire HTTP / WS stack.
 */
export interface OnboardingEnginePieces {
  engine: InterviewEngine
  buttonStore: ButtonStore
  stateStore: SqliteOnboardingStateStore
  transcript: TranscriptWriter
  registry: import('../http/chat-bridge.ts').WebChatSenderRegistry
  wowDispatcher: WowDispatcherHook | null
  /**
   * T4 (2026-05-13) — history-import job-runner hook surfaced on the
   * shared fixture bag so the wiring regression test
   * (`import-running-composer.test.ts`) can assert the engine receives
   * a non-null hook by default. Mirrors `wowDispatcher` from T2 r2.
   */
  importJobRunner: ImportJobRunnerHook | null
  /**
   * T4 (2026-05-13) — payload resolver surfaced so tests can inject /
   * inspect their stub without rebuilding the entire fixture.
   */
  importPayloadResolver: ImportPayloadResolver | null
  /**
   * 2026-05-25 (Argus r1 BLOCKER #3) — resume-readiness probe surfaced
   * so the wiring regression test can assert the engine receives a
   * non-null probe by default. Without this assertion the engine
   * silently routes the analysis-presented body with
   * `can_resume_import: false` even on resumable jobs.
   */
  importResumeReadiness: ImportResumeReadinessProbe | null
  /**
   * T5 (2026-05-13) — exposed so the regression test can assert the
   * production composer wires a non-null library by default and so
   * tests can spy on `matchByName` / `generateExtension` to verify the
   * engine routes typed names through the library.
   */
  archetypes: ArchetypeLibrary | null
}

/**
 * Build the InterviewEngine + its supporting per-instance fixtures the
 * same way production does. Exported so the T2 r2 wiring regression
 * test asserts the engine receives the `wowDispatcher` hook by
 * default (Argus BLOCKING #1: the original PR shipped a hook
 * interface with NO production call site).
 */
export function buildOnboardingEnginePieces(
  input: BuildLandingStackInput,
): OnboardingEnginePieces {
  if (typeof input.internal_handle !== 'string' || input.internal_handle.length === 0) {
    throw new Error('buildOnboardingEnginePieces: internal_handle is required (P1.5 § 1.5.5)')
  }
  const buttonStore = new ButtonStore({ db: input.db })
  const stateStore = new SqliteOnboardingStateStore({ db: input.db })
  const registry = input.webRegistry ?? new InMemoryWebChatSenderRegistry()
  const transcript = new TranscriptWriter({
    path: join(input.owner_home, 'persona', 'onboarding-transcript.jsonl'),
  })
  const slugPicker: SlugPickerEngineHook | null = input.slugPicker ?? null
  const profilePic: ProfilePicEngineHook | null = input.profilePic ?? null
  const personaSync: PersonaSyncHook | null = input.personaSync ?? null
  // P2 v2 § 0 #9 + § 7.1 — curated archetype library. Default-built
  // against the in-repo curated md files at `onboarding/archetypes/data/`
  // and a per-instance LLM-extension cache under
  // `<owner_home>/cache/archetype-extensions/`. Wired into
  // `PersonaComposer` (NOT the engine) so curated archetype mentions
  // inside the user's free-text `agent_personality` lift curated voice
  // fragments at synthesis time. Tests inject a stub via
  // `input.archetypes` (or pass `null` to skip curated matching).
  const archetypes: ArchetypeLibrary | null =
    input.archetypes === undefined
      ? new ArchetypeLibrary({
          dataDir: defaultArchetypeDataDirFromRepo(),
          cacheDir: join(input.owner_home, 'cache', 'archetype-extensions'),
        })
      : input.archetypes
  // T1 (2026-05-13) — persona composer. Default-on so every production
  // boot has the persona-gen pipeline wired by construction. Callers
  // that need to disable it (legacy tests, dev cycles where compose
  // shouldn't fire) pass `null` explicitly. P2 v2 (2026-05-21) — wires
  // the archetype library so `compose()` can run `composeFromFreeText`
  // against curated archetypes per § 7.1.
  const personaComposer: PersonaComposerHook | null =
    input.personaComposer === undefined
      ? new PersonaComposer({
          cringeChecker: buildCringeChecker(),
          ownerHomeFor: (_slug: string): string => join(input.owner_home, 'persona'),
          ...(archetypes !== null ? { archetypes } : {}),
        })
      : input.personaComposer
  const phaseSpecResolver: PhaseSpecResolver | null = input.phaseSpecResolver ?? null
  const engineSlugHistory: SlugHistoryLookup | null = input.engineSlugHistory ?? null
  // T2 r2 (2026-05-13) — wow-moment dispatcher hook.
  //
  // Resolution order:
  //   1. Caller-supplied `input.wowDispatcher` (tests inject a recorder).
  //   2. `null` explicitly → silent-transit fallback (the engine treats
  //      `wow_fired` as a no-op transit phase; phase advances with no
  //      entry body emit, the prior pre-T2 behaviour).
  //   3. Undefined → BUILD the real dispatcher via
  //      `buildWowDispatcherHook(...)` using the deps already in scope
  //      (db, owner_home, webRegistry, buttonStore). Production walks
  //      this path so a wow_fired transition actually fires the
  //      catalogue actions instead of stranding the user at "Setting
  //      up your first week..." with nothing behind it.
  //
  // The explicit `null` carve-out exists for callers that want to opt
  // out (legacy boot paths during the wiring rollout; never invoked in
  // production now, but it avoids breaking the contract for in-process
  // test composers that pre-date this builder).
  // Item 4 (2026-06-11) — materializer enrichments for action 03.
  // Composer: LLM doc synthesis over the SAME CC substrate the import
  // pipeline uses (no substrate wired → deterministic template docs).
  // Indexer: project page through writeEntity(kind='project') into the
  // SAME entities/ tree + GBrain hook the import entity-populator
  // targets, so the Item-1 agent's memory recall surfaces projects.
  const wowMaterializerComposer =
    input.wowMaterializerComposer === undefined
      ? input.importSubstrate !== undefined
        ? buildProjectDocComposer({
            client: buildGatewayAnthropicMessagesClient({ substrate: input.importSubstrate }),
          })
        : null
      : input.wowMaterializerComposer
  const wowMaterializerIndexer =
    input.wowMaterializerIndexer === undefined
      ? buildProjectPageIndexer({
          ownerDataDir: input.importOwnerDataDir ?? input.owner_home,
          project_slug: input.project_slug,
          ...(input.importGbrainSyncHook !== undefined
            ? { syncHook: input.importGbrainSyncHook }
            : {}),
        })
      : input.wowMaterializerIndexer
  const wowDispatcher: WowDispatcherHook | null =
    input.wowDispatcher === undefined
      ? buildWowDispatcherHook({
          db: input.db,
          owner_home: input.owner_home,
          webRegistry: registry,
          buttonStore,
          ...(wowMaterializerComposer !== null
            ? { materializerComposer: wowMaterializerComposer }
            : {}),
          ...(wowMaterializerIndexer !== null
            ? { materializerIndexer: wowMaterializerIndexer }
            : {}),
          // T2 r3 (2026-05-13) — Argus BLOCKING #1: thread the SHARED
          // CronJobRegistry so action 07 registers its overnight-pass
          // job in the registry the production CronScheduler reads
          // from. Falls back to a fresh local registry when the
          // composer hasn't been updated to pass one (back-compat for
          // older boot paths + tests).
          ...(input.cronJobs !== undefined ? { cronJobs: input.cronJobs } : {}),
          ...(input.wowInterActionPauseMs !== undefined
            ? { interActionPauseMs: input.wowInterActionPauseMs }
            : {}),
          ...(input.wowSleep !== undefined ? { sleep: input.wowSleep } : {}),
          ...(input.wowActionTimeoutMs !== undefined
            ? { actionTimeoutMs: input.wowActionTimeoutMs }
            : {}),
          // P2 v2 S9 (Codex S9-r1 P1) — picker LLM for the wow-moment
          // LLM selection per § 5.3. Without this, production walks
          // the deterministic-fallback path on every dispatch.
          ...(input.wowPickerLlm !== undefined
            ? { pickerLlm: input.wowPickerLlm }
            : {}),
          // 2026-05-28 wow-cleanup r3 — probe test seams (poll cadence
          // + sleep + now). Production omits all three so the
          // default-built ButtonStoreResolutionProbe walks `Bun.sleep`
          // and `Date.now` at 500ms cadence; tests pass test seams.
          ...(input.wowPromptResolutionPollMs !== undefined
            ? { promptResolutionPollMs: input.wowPromptResolutionPollMs }
            : {}),
          ...(input.wowPromptResolutionSleep !== undefined
            ? { promptResolutionSleep: input.wowPromptResolutionSleep }
            : {}),
          ...(input.wowPromptResolutionNow !== undefined
            ? { promptResolutionNow: input.wowPromptResolutionNow }
            : {}),
        })
      : input.wowDispatcher
  // Codex r2 P1 + r3 P1 (post-T4) — default-build a ChainedImportPayloadResolver
  // combining:
  //   1. UrlPasteImportPayloadResolver — picks up the user's pasted URL
  //      from `phase_state.import_paste_url_<source>` and fetches it.
  //      Spec § 2.3 v1 contract ("freeform paste of a presigned URL is
  //      acceptable").
  //   2. FilesystemImportPayloadResolver — picks up zips dropped at
  //      `<owner_home>/imports/<source>.zip` by a future upload
  //      mechanism (side-channel HTTP route).
  //
  // Tests that need a deterministic in-memory resolver pass it
  // explicitly via `input.importPayloadResolver`. The chain returns the
  // first non-null Buffer.
  const importPayloadResolver: ImportPayloadResolver | null =
    input.importPayloadResolver === undefined
      ? new ChainedImportPayloadResolver([
          new UrlPasteImportPayloadResolver(async (resolveInput) => {
            const row = await stateStore.get(resolveInput.project_slug, resolveInput.user_id)
            if (row === null) return null
            const v = row.phase_state[`import_paste_url_${resolveInput.source}`]
            return typeof v === 'string' && v.length > 0 ? v : null
          }),
          new FilesystemImportPayloadResolver(input.owner_home),
        ])
      : input.importPayloadResolver
  // The engine is constructed below. No runner→engine callback is
  // wired today; if a future feature needs one (e.g. a status
  // emitter), the mutual-reference ceremony belongs here.
  //
  // 2026-06-17 (Step 2b — synthesis cut-over): when the caller OPTS IN via
  // `importUseSynthesis` (the Open single-owner composer — its `cc-synthesis-*`
  // substrate is built ACCUMULATING, NO `reset_context_per_turn`), the live
  // import runs through the ONE accumulating synthesis session
  // (`onboarding/synthesis/*` via `buildSynthesisSession` →
  // `buildSynthesisImportJobRunner`) instead of the retired per-chunk
  // `buildImportJobRunnerHook` path. The opt-in is explicit (not auto-detected)
  // because the MANAGED hosted import substrate (`build-import-substrate.ts`)
  // is still `ephemeral` by the 2026-06 recovered-reply decision — feeding an
  // ephemeral substrate to the accumulating synthesis session would defeat the
  // accumulation, so managed stays on per-chunk until its substrate is reworked
  // (documented follow-up). An injected `importJobRunner` always wins.
  const useSynthesisImport =
    input.importJobRunner === undefined && input.importUseSynthesis === true
  const importJobRunner: ImportJobRunnerHook | null = useSynthesisImport
    ? buildSynthesisImportJobRunner({
        db: input.db,
        synthesis: buildSynthesisSession({
          substrate: input.importSubstrate ?? null,
          owner_home: input.importOwnerDataDir ?? input.owner_home,
          ...(input.importNow !== undefined ? { now: input.importNow } : {}),
        }),
        ...(input.importParse !== undefined ? { parse: input.importParse } : {}),
        ...(input.importNow !== undefined ? { now: input.importNow } : {}),
        ...(input.importUuid !== undefined ? { uuid: input.importUuid } : {}),
      })
    : input.importJobRunner === undefined
      ? buildImportJobRunnerHook({
          db: input.db,
          ...(input.importPass1Llm !== undefined ? { pass1Llm: input.importPass1Llm } : {}),
          ...(input.importPass2Llm !== undefined ? { pass2Llm: input.importPass2Llm } : {}),
          ...(input.importSubstrate !== undefined ? { substrate: input.importSubstrate } : {}),
          ...(input.importOnSonnetFallback !== undefined
            ? { onSonnetFallback: input.importOnSonnetFallback }
            : {}),
          ...(input.importParse !== undefined ? { parse: input.importParse } : {}),
          ...(input.importNow !== undefined ? { now: input.importNow } : {}),
          ...(input.importUuid !== undefined ? { uuid: input.importUuid } : {}),
          ...(input.importGetCurrentCredentialKind !== undefined
            ? { getCurrentCredentialKind: input.importGetCurrentCredentialKind }
            : {}),
          // 2026-05-25 (Bug D + Argus r1 BLOCKER #1) — populator wiring.
          // ownerDataDir defaults to `owner_home` so the production
          // boot path always lands `<owner_home>/entities/...`
          // populated after each completed/partial import. Tests can
          // override with `importOwnerDataDir` (isolated tmp dir) +
          // `importWriteEntity` (recorder). `importGbrainSyncHook`
          // is forwarded as-is — undefined here keeps the KG fan-out
          // skipped on instances without GBrain wired.
          ownerDataDir: input.importOwnerDataDir ?? input.owner_home,
          ...(input.importWriteEntity !== undefined
            ? { writeEntity: input.importWriteEntity }
            : {}),
          ...(input.importGbrainSyncHook !== undefined
            ? { gbrainSyncHook: input.importGbrainSyncHook }
            : {}),
          ...(input.__allowNoOpLlmForBoot === true ? { __allowNoOpLlmForBoot: true } : {}),
        })
      : input.importJobRunner
  // 2026-05-25 (import-pipeline-resilience sprint, Part G.2 + Argus
  // r1 BLOCKER #3) — `ImportResumeReadinessProbe`.
  //
  // Resolution order:
  //   1. Caller-supplied (tests inject a deterministic recorder).
  //   2. `null` explicitly → engine never surfaces the `resume_import`
  //      button. Legacy opt-out kept for back-compat.
  //   3. Undefined → BUILD the real probe from `db` + `owner_home`
  //      via `buildImportResumeReadinessProbe`. Production walks this
  //      path so the button surfaces by construction whenever the
  //      `import_jobs` row is resumable and the source ZIP is still
  //      on disk.
  const importResumeReadiness: ImportResumeReadinessProbe | null =
    input.importResumeReadiness === undefined
      ? buildImportResumeReadinessProbe({
          db: input.db,
          owner_home: input.owner_home,
          project_slug: input.project_slug,
        })
      : input.importResumeReadiness
  // Sprint B (2026-05-17) — Argus r2 BLOCKING: do NOT thread
  // `platform.slugAvailability` into the production engine. The Sprint B
  // spec gate is "M2 emits byte-identical sequence", and threading the
  // probe silently activates the multi-suggestion `slug_chosen` branch
  // (engine.ts:7707-7719 → phase-prompts.ts:741-776). Production stays
  // on the legacy single-suggestion path until a follow-up sprint
  // EXPLICITLY ships multi-suggestion alongside a refreshed M2 walkthrough
  // fixture. The `PlatformAdapter` interface + Local/Managed adapters
  // remain wired through `composition.ts` for the rest of Sprint B's
  // deliverable; only the engine-constructor field is omitted here.
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: buildRoutedSendButtonPrompt({ webRegistry: registry }),
    // Bug 1, v0.1.75 — import-progress envelope sender. The cron-tick
    // path on engine.pollImportRunningTick calls this every 5s during
    // the import_running phase so the client renders a live progress
    // indicator below the agent prompt.
    sendImportProgress: buildRoutedSendImportProgress({ webRegistry: registry }),
    ...(slugPicker !== null ? { slugPicker } : {}),
    ...(profilePic !== null ? { profilePic } : {}),
    ...(personaSync !== null ? { personaSync } : {}),
    ...(personaComposer !== null ? { personaComposer } : {}),
    ...(phaseSpecResolver !== null ? { phaseSpecResolver } : {}),
    ...(wowDispatcher !== null ? { wowDispatcher } : {}),
    // 2026-05-22 (push-deeplink-wow sprint) — wow-moment push emitter.
    // The engine fires this once per (instance, user) on entry into
    // `dispatchWowAndAdvance`, gated on `state.wow_pushed_at === null`.
    // Production composer in `gateway/index.ts` closes the per-instance
    // PushDispatcher + DevicePushTokenStore over `emitWowPush` and
    // forwards the closure here; tests that don't exercise push
    // simply omit the field (null is fine too).
    ...(input.wowPushEmitter !== undefined && input.wowPushEmitter !== null
      ? { wowPushEmitter: input.wowPushEmitter }
      : {}),
    // 2026-05-28 sidebar sprint — onboarding-to-General + per-project
    // topics handoff. Fires on the wow_fired → completed success path
    // so per-project sidebar topics are seeded BEFORE the engine
    // declares the user done. The hook is built here against the
    // local `buttonStore` so the seed rows land in the SAME
    // per-project DB the chat-history + chat-topics surfaces read
    // from. Tests injecting `input.onboardingHandoff: null`
    // explicitly opt out so the seed step is silent for fixtures
    // that don't exercise it.
    ...(input.onboardingHandoff === null
      ? {}
      : {
          onboardingHandoff:
            input.onboardingHandoff ??
            buildOnboardingHandoffHook({
              buttonStore,
              // Item 5 (2026-06-11) — the SAME owner_home the wow
              // dispatcher hands the Item 4 materializer, so the
              // opening-message doc reader resolves the exact
              // `Projects/<slug>/` tree `materialize()` wrote during
              // the wow dispatch earlier in this transition.
              owner_home: input.owner_home,
              // Item 5 — thread the optional LLM opening composer when
              // supplied so per-project openings carry a real
              // synthesized paragraph + next move. Production composer
              // (`gateway/index.ts`) builds this from the same
              // CC-substrate anthropicClient as llmRouter; tests that
              // don't exercise the LLM path leave it unset and the
              // deterministic prose path takes over.
              ...(input.projectOpeningComposer !== undefined
                ? { composeProjectOpening: input.projectOpeningComposer }
                : {}),
            }),
        }),
    ...(importJobRunner !== null ? { importJobRunner } : {}),
    ...(importPayloadResolver !== null ? { importPayloadResolver } : {}),
    // 2026-05-25 (Part G.2 + Argus r1 BLOCKER #3) — `importResumeReadiness`
    // probe so the engine renders the `resume_import` button on
    // analysis-presented when prior import is genuinely resumable.
    ...(importResumeReadiness !== null ? { importResumeReadiness } : {}),
    // P2 v2 § 0 #9 + § 7.1 — `archetypes` is INTENTIONALLY NOT wired
    // here. The library is consumed at synthesis time inside
    // `PersonaComposer` (see archetypes wiring above), so the engine's
    // personality_offered phase stays string-only per spec § 3.9.
    // P2-v3 S2 (Argus r2 BLOCKING #1) — thread the LlmRouter +
    // PlatformAdapter so the engine's freeform fall-through actually
    // routes through the LLM when the env flag is on. Without these
    // two threads, `NEUTRON_ONBOARDING_CONVERSATIONAL=1` is a no-op in
    // production because `shouldConsultRouter` returns false on a
    // missing platform dep and `llmRouter` is undefined on the engine.
    ...(input.llmRouter !== undefined ? { llmRouter: input.llmRouter } : {}),
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    // v0.1.80 (2026-05-22) — character suggester + persona summarizer.
    // Both are optional; missing deps fall back to deterministic static
    // bodies so the engine never strands the user.
    ...(input.personalityCharacterSuggester !== undefined
      ? { personalityCharacterSuggester: input.personalityCharacterSuggester }
      : {}),
    ...(input.agentNameSuggester !== undefined
      ? { agentNameSuggester: input.agentNameSuggester }
      : {}),
    ...(input.personaSummarizer !== undefined
      ? { personaSummarizer: input.personaSummarizer }
      : {}),
    // T2 r2 — internal_handle threads through to the engine even when
    // engineSlugHistory is absent, so dispatchWowAndAdvance can pass the
    // FROZEN identity (NOT the mutable url_slug) into the hook. Without
    // this, a rename across the wow_fired transition would have the
    // dispatcher key its persistence rows under the post-rename slug,
    // orphaning the pre-rename state.
    ...(engineSlugHistory !== null
      ? { slugHistory: engineSlugHistory, internal_handle: input.internal_handle }
      : { internal_handle: input.internal_handle }),
    // 2026-05-28 — Max OAuth + per-instance SecretsStore. Pre-2026-05-28
    // these deps were NEVER wired into the production engine despite
    // existing as optional fields on InterviewEngineDeps, which broke
    // every "Connect Claude Max" tap (Sam walkthrough hit a 3x stuck
    // loop ending in "Max attach is temporarily unavailable"). Wiring
    // them here ALSO enables the auto-skip-when-attached path so an
    // instance whose Max was wired during the import phase never sees
    // the prompt at all.
    ...(input.secrets !== undefined ? { secrets: input.secrets } : {}),
    ...(input.maxOauth !== undefined ? { maxOauth: input.maxOauth } : {}),
    // 2026-05-28 PR #331 fast-follower — Telegram-bind token minter.
    // Closes the IMPORTANT #2 residual from Argus r1: the dep existed
    // on the engine but had no production call site, so every
    // [B] Connect a Telegram bot tap minted the per-request opaque
    // nonce fallback instead of a HMAC-signed token a future bot-side
    // bind handler (ISSUES #65) can verify. Tests omit this field +
    // the engine falls back to the nonce path.
    ...(input.mintTelegramBindToken !== undefined
      ? { mintTelegramBindToken: input.mintTelegramBindToken }
      : {}),
    // 2026-06-13 (onboarding Open-mode) — gate the phase sequence on the
    // deployment mode. Open self-host cuts identity_oauth /
    // instance_provisioned / slug_chosen and swaps the hosted Max OAuth
    // handoff for a local setup-token paste; managed (and the deferred
    // `connect` tier, which onboards as managed until B2) keep the full
    // hosted sequence. Resolved from `NEUTRON_ROLE` / `NEUTRON_DEPLOYMENT_MODE`
    // per gateway/deployment-mode.ts.
    deploymentMode: resolveDeploymentMode() === 'open' ? 'open' : 'managed',
  })
  return {
    engine,
    buttonStore,
    stateStore,
    transcript,
    registry,
    wowDispatcher,
    importJobRunner,
    importPayloadResolver,
    importResumeReadiness,
    archetypes,
  }
}

/**
 * Resolve the in-repo curated archetype data dir relative to this source
 * file. Resolves to `<repo>/onboarding/archetypes/data` because this
 * file lives at `<repo>/gateway/realmode-composer/build-landing-stack.ts`.
 */
function defaultArchetypeDataDirFromRepo(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', '..', 'onboarding', 'archetypes', 'data')
}

/**
 * Construct the production landing stack: ButtonStore + onboarding state
 * + transcript writer + web sender registry + start-token verifier +
 * `createLandingServer`. Returns the `{ fetch, websocket }` pair the
 * gateway HTTP composition layer plugs into Bun.serve.
 *
 * Wiring notes:
 *   - `TranscriptWriter` auto-creates the `<owner_home>/persona/`
 *     parent dir on first construction.
 *   - `InMemoryConsumedTokens` is per-process; one per instance gateway.
 *     Migration to a SQLite-backed variant lives behind the
 *     `ConsumedTokensStore` interface (`signup/start-token.ts`).
 *   - The engine's `sendButtonPrompt` is the routed-by-prefix factory
 *     wired with a web-only registry; the Telegram surface is composed
 *     separately and threaded into a different routed sender (Phase 4
 *     of the plan).
 */
export function buildLandingStack(input: BuildLandingStackInput): LandingStackWithEngine {
  // Argus r2 [BLOCKING #1] — assert at boot so a misconfigured composer
  // bricks loudly here rather than silently disabling the shim and
  // 401'ing every old-slug JWT post-rename in prod.
  if (typeof input.internal_handle !== 'string' || input.internal_handle.length === 0) {
    throw new Error('buildLandingStack: internal_handle is required (P1.5 § 1.5.5)')
  }
  const pieces = buildOnboardingEnginePieces(input)
  const { engine, registry, stateStore, importJobRunner, importPayloadResolver, buttonStore } =
    pieces
  const consumedTokens: ConsumedTokensStore = input.consumedTokens ?? new InMemoryConsumedTokens()
  // 2026-05-11 — pending-redirect store. The Managed boot shell
  // (`buildDefaultRealModeComposer`) constructs the SQLite-backed store
  // and threads it in via `input.pendingRedirects`.
  //
  // Sprint B (2026-05-20) — the previous default-construction-here
  // shape took a direct import edge on the Managed pending-redirect-store
  // module, which is Managed-classified. The store is now wholly owned by the
  // boot shell; callers that need it (production) wire it through, and
  // callers that don't (tests / Open self-hosted boxes that never run
  // the slug-rename flow) pass `undefined` and the chat-bridge's
  // delivery path stays inert.
  const pendingRedirects: PendingRedirectStore | null =
    input.pendingRedirects === undefined ? null : input.pendingRedirects
  // Sprint B (2026-05-20), updated C2 (2026-06-10) — start-token verify
  // + JTI claim are dependency-injected from `input.platform` when
  // supplied by the boot shell, otherwise omitted entirely. Since C2
  // there is NO fallback: chat-bridge's lazy dynamic import of the
  // Managed start-token module was DELETED (a dynamic import is still
  // an open→managed edge), so unwired callers (tests / Open self-host)
  // get injection-only behavior — validateStartToken rejects every
  // token with `reason=start-token-auth-unwired`.
  const bridge = buildWebChatBridge({
    expected_project_slug: input.project_slug,
    internal_handle: input.internal_handle,
    slugHistoryStore: input.slugHistoryStore,
    ...(input.ownerRegistry !== undefined ? { ownerRegistry: input.ownerRegistry } : {}),
    resolveKey: buildJwksResolveKey(input.jwks),
    consumedTokens,
    ...(input.platform?.verifyStartToken !== undefined
      ? { verifyStartToken: input.platform.verifyStartToken }
      : {}),
    ...(input.platform?.claimStartTokenJti !== undefined
      ? { claimStartTokenJti: input.platform.claimStartTokenJti }
      : {}),
    engine,
    registry,
    ...(pendingRedirects !== null ? { pendingRedirects } : {}),
    // 2026-05-28 sidebar sprint — share the same ButtonStore the
    // engine emits into so the project-topic inbound stub can resolve
    // tapped seed prompts via `buttonStore.resolve(...)`.
    buttonStore,
    // Scribe phase 1 — forward the chat-time extraction hook so a user turn
    // fans into the extract→GBrain path (closes #101 Gap 2).
    ...(input.scribeOnUserTurn !== undefined
      ? { scribeOnUserTurn: input.scribeOnUserTurn }
      : {}),
    // S3 #106 — forward the replay-redelivery store so a (re)connect flushes
    // any recovered replies a crash dropped for this user's channel.
    ...(input.recoveredReplyStore !== undefined
      ? { recoveredReplyStore: input.recoveredReplyStore }
      : {}),
    // ISSUES #204 — live-agent turn runner bound to THIS stack's
    // ButtonStore + TranscriptWriter, plus the state store for the
    // bridge's completed-phase gate. The state store is threaded
    // unconditionally (read-only `get`); the gate only fires when the
    // runner is also present.
    ...(input.liveAgentTurnFactory !== undefined
      ? {
          liveAgentTurn: input.liveAgentTurnFactory({
            buttonStore,
            transcript: pieces.transcript,
          }),
        }
      : {}),
    onboardingStateStore: stateStore,
  })
  const landingOpts: Parameters<typeof createLandingServer>[0] = {
    static_dir: input.static_dir,
    bridge,
  }
  if (input.recoverHandler !== undefined) {
    landingOpts.recoverHandler = input.recoverHandler
  }
  if (input.cookieToUserClaim !== undefined) {
    landingOpts.cookieToUserClaim = input.cookieToUserClaim
  }
  if (input.chatAuthGate !== undefined) {
    landingOpts.chatAuthGate = input.chatAuthGate
  }
  const landing = createLandingServer(landingOpts)
  // Trident 6 (2026-05-13) — expose the engine instance so the boot
  // shell can wire the per-instance resume-on-reconnect cron (the cron
  // handler holds an engine reference + drives `engine.advance` on
  // stale rows). Existing callers reading `.fetch` / `.websocket` are
  // unaffected; the engine field is additive.
  //
  // 2026-05-25 (Argus r1 BLOCKER #2) — also expose
  // `importJobRunner` + `importPayloadResolver` + `stateStore` so
  // the boot shell can mount `POST /api/import/<job_id>/resume`
  // against the SAME instances the engine drives.
  return {
    ...landing,
    engine,
    importJobRunner,
    importPayloadResolver,
    stateStore,
    buttonStore,
    // Audit P0-2 — expose the live web sender registry so the boot shell can
    // build the reminder outbound against the SAME registry the per-socket
    // chat senders bind to (durable history row + best-effort live push).
    registry,
  }
}
