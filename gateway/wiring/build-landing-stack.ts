/**
 * @neutronai/gateway/wiring — landing-stack factory (Sprint 19 P3).
 *
 * Per docs/plans/2026-05-05-002-feat-sprint-19-wiring-wiring-plan.md
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

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { resolveDeploymentMode } from '../deployment-mode.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import {
  buildRoutedSendButtonPrompt,
  buildRoutedSendImportProgress,
  type AppSocketButtonPromptRouter,
  type AppSocketImportProgressRouter,
} from '../http/chat-bridge.ts'
import {
  InMemoryWebChatSenderRegistry,
  type WebChatSenderRegistry,
} from '../http/chat-sender-registry.ts'
import {
  InterviewEngine,
  type ImportJobRunnerHook,
  type ImportPayloadResolver,
  type ImportResumeReadinessProbe,
  type MaxOauthSecretsStore,
  type PersonaComposerHook,
  type PersonaSyncHook,
  type ProfilePicEngineHook,
  type SlugHistoryLookup,
  type SlugPickerEngineHook,
} from '@neutronai/onboarding/interview/engine.ts'
import type { SqliteOnboardingStateStore as OnboardingStateStoreType } from '@neutronai/onboarding/interview/sqlite-state-store.ts'
import { PersonaComposer } from '@neutronai/onboarding/persona-gen/compose.ts'
import { buildCringeChecker } from '@neutronai/onboarding/persona-gen/cringe-check.ts'
import { ArchetypeLibrary } from '@neutronai/onboarding/archetypes/library.ts'
import type {
  PhaseSpecResolver,
} from '@neutronai/onboarding/interview/phase-spec-resolver.ts'
import { SqliteOnboardingStateStore } from '@neutronai/onboarding/interview/sqlite-state-store.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'
import { createLandingServer, type LandingServer } from '@neutronai/landing/server.ts'
import {
  buildImportResumeReadinessProbe,
  ChainedImportPayloadResolver,
  FilesystemImportPayloadResolver,
  UrlPasteImportPayloadResolver,
} from './import-payload-resolvers.ts'
import { buildSynthesisSession } from './build-synthesis-session.ts'
import { buildSynthesisImportJobRunner } from './build-synthesis-import-runner.ts'

export interface BuildLandingStackInput {
  db: ProjectDb
  project_slug: string
  owner_home: string
  static_dir: string
  /**
   * Onboarding consolidation (2026-06-26) — late-bound app-socket routers. The
   * Open composer passes these mutable holders so the SAME engine routes
   * onboarding button-prompts + import-progress over the unified `/ws/app/chat`
   * socket (it fills `.send` after the app-ws registry is built). Absent on the
   * Managed/web-only path — `app:` prompts then return was_new=false and the
   * engine retries. No second onboarding engine; one routed sender, three
   * channel prefixes (web/tg/app).
   */
  appWsButtonPromptRouter?: AppSocketButtonPromptRouter
  appWsImportProgressRouter?: AppSocketImportProgressRouter
  /**
   * P1.5 § 1.5.5 — frozen `internal_handle` for THIS instance (per-instance
   * identity). The `/ws/chat` JWT slug-history shim that once consumed this
   * was excised with the dead ChatBridge (K11b0); the field stays required
   * and boot-validated (a non-empty value) so a misconfigured composer fails
   * loudly rather than booting with an empty identity.
   */
  internal_handle: string
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
  webRegistry?: import('../http/chat-sender-registry.ts').WebChatSenderRegistry
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
   * T4 (2026-05-13) — history-import job-runner hook. When provided,
   * the engine routes the `import_offered` zip choices through it (an
   * injected runner always wins). When null/undefined, the factory builds
   * the SYNTHESIS runner iff `importUseSynthesis === true` (the Open
   * single-owner path — `open/composer.ts` opts in), otherwise no runner is
   * wired and the engine collapses the zip choices into its skip path. The
   * retired per-chunk `buildImportJobRunnerHook` default was deleted (K3).
   * Tests inject a recorder via this field directly.
   *
   * Argus-trapping shape: the explicit `null` carve-out lets test harnesses
   * opt out; production reaches the real path via `importUseSynthesis: true`,
   * not by passing a runner here.
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
   * Substrate the LIVE synthesis import path dispatches through. The Open
   * single-owner composer constructs a `createClaudeCodeSubstrateAuto(...)`
   * from the resolved Anthropic credentials (Max OAuth > BYO key > env) and
   * passes it here; `buildSynthesisSession` runs the ONE accumulating
   * synthesis session over it. Tests drive the path with a deterministic
   * `Substrate` stub. When omitted, the synthesis runner surfaces an honest
   * "no LLM substrate" failure the engine routes to gap-fill.
   *
   * (K3, 2026-07-03) — the per-chunk `importPass1Llm` / `importPass2Llm`
   * caller-override seams were removed with the dead per-chunk runner.
   */
  importSubstrate?: import('@neutronai/runtime/substrate.ts').Substrate
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
   * 2026-05-25 — override the instance-data-dir threaded to the wow-moment
   * project indexer. Defaults to `input.owner_home`. Tests may pass an
   * isolated temp dir so each test owns its own `entities/` tree.
   */
  importOwnerDataDir?: string
  /**
   * 2026-05-25 — optional GBrain sync hook fired by `writeEntity` after each
   * committed page. Production composer wires this when GBrain is provisioned
   * for the instance; tests pass a recorder or omit. When undefined the entity
   * writer still emits markdown to disk; only the KG fan-out is skipped
   * (recoverable via a later re-sync sweep). Consumed by the wow-moment
   * project-page indexer (`buildProjectPageIndexer`).
   *
   * (K3, 2026-07-03) — type repointed from the deleted per-chunk barrel's
   * `ImportPopulatorSyncHook` alias to the underlying `SyncHook`.
   */
  importGbrainSyncHook?: import('@neutronai/runtime/entity-writer.ts').SyncHook
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
    | import('@neutronai/onboarding/wow-moment/project-materializer.ts').ProjectDocComposer
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
    | import('@neutronai/onboarding/wow-moment/project-materializer.ts').ProjectPageIndexFn
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
  importParse?: import('@neutronai/onboarding/history-import/types.ts').SourceParser
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
   * cookie-authenticated user's identity for a `/ws/app/chat` upgrade that
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
   * this unset and cookie-only `/ws/app/chat` upgrades 400 the same way a
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
   * AUTH-CORRECTION (2026-06-28) — Claude-Max OAuth install-token handoff
   * routes, threaded straight through to
   * `createLandingServer({installTokenHandler: …})`. The Open composer wires the
   * single-owner handler (`buildOpenInstallTokenHandler`); Managed wires its own
   * HMAC-gated handler at the same paths. When unset the surface is unmounted.
   */
  installTokenHandler?: (req: Request) => Promise<Response | null>
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
  platform?: import('@neutronai/runtime/platform-adapter.ts').PlatformAdapter
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
  personalityCharacterSuggester?: import('@neutronai/onboarding/interview/personality-character-suggester.ts').PersonalityCharacterSuggester
  /**
   * 2026-05-27 — agent-name suggester. When wired, the engine fires
   * `generate(...)` on `agent_name_chosen` phase entry and memoizes
   * 3-5 picks in `phase_state.agent_name_suggestions`. On failure the
   * suggester returns its own static fallback (Sage / Vera / Orin) so
   * the user still sees a name list. Production wiring (gateway/index.ts)
   * builds this via `buildAgentNameSuggester({ anthropicClient })`
   * using the SAME anthropicClient as the llmRouter + character suggester.
   */
  agentNameSuggester?: import('@neutronai/onboarding/interview/agent-name-suggester.ts').AgentNameSuggester
  /**
   * v0.1.80 (2026-05-22) — persona summarizer. When wired, the engine
   * fires `summarize(...)` on `persona_reviewed` phase entry and
   * memoizes the 3-4 sentence summary into
   * `phase_state.persona_reviewed_summary`. On failure the engine falls
   * back to `staticPersonaSummary(...)` so the body is never empty.
   * Production wiring (gateway/index.ts) builds this via
   * `buildPersonaSummarizer({ anthropicClient })`.
   */
  personaSummarizer?: import('@neutronai/onboarding/persona-gen/summarize.ts').PersonaSummarizer
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
}

/**
 * Aliased to `LandingServer` so the wiring surface stays
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
 * `<repo>/gateway/wiring/build-landing-stack.ts`.
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
  registry: import('../http/chat-sender-registry.ts').WebChatSenderRegistry
  /**
   * T4 (2026-05-13) — history-import job-runner hook surfaced on the
   * shared fixture bag so the wiring regression test
   * (`import-running-composer.test.ts`) can assert the engine receives
   * a non-null hook by default.
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
 * same way production does. Exported so the wiring regression tests can
 * drive the SAME engine path production walks without spinning the
 * entire HTTP / WS stack.
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
  // 2026-06-17 (Step 2b — synthesis cut-over) / K3 (2026-07-03 — per-chunk
  // pipeline evacuated): the live import runs through the ONE accumulating
  // synthesis session (`onboarding/synthesis/*` via `buildSynthesisSession` →
  // `buildSynthesisImportJobRunner`). The Open single-owner composer opts in
  // via `importUseSynthesis: true` (its `cc-synthesis-*` substrate is built
  // ACCUMULATING, NO `reset_context_per_turn`). An injected `importJobRunner`
  // always wins. The retired per-chunk `buildImportJobRunnerHook` path was
  // deleted (K3): when neither an injected runner nor synthesis opt-in is
  // present, no import runner is wired — the engine collapses the zip choices
  // into the skip path (its documented unwired-hook behaviour).
  const importJobRunner: ImportJobRunnerHook | null =
    input.importJobRunner !== undefined
      ? input.importJobRunner
      : input.importUseSynthesis === true
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
        : null
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
    sendButtonPrompt: buildRoutedSendButtonPrompt({
      webRegistry: registry,
      ...(input.appWsButtonPromptRouter !== undefined
        ? { appSocketRouter: input.appWsButtonPromptRouter }
        : {}),
    }),
    // Bug 1, v0.1.75 — import-progress envelope sender. The cron-tick
    // path on engine.pollImportRunningTick calls this every 5s during
    // the import_running phase so the client renders a live progress
    // indicator below the agent prompt.
    sendImportProgress: buildRoutedSendImportProgress({
      webRegistry: registry,
      ...(input.appWsImportProgressRouter !== undefined
        ? { appSocketRouter: input.appWsImportProgressRouter }
        : {}),
    }),
    ...(slugPicker !== null ? { slugPicker } : {}),
    ...(profilePic !== null ? { profilePic } : {}),
    ...(personaSync !== null ? { personaSync } : {}),
    ...(personaComposer !== null ? { personaComposer } : {}),
    ...(phaseSpecResolver !== null ? { phaseSpecResolver } : {}),
    ...(importJobRunner !== null ? { importJobRunner } : {}),
    ...(importPayloadResolver !== null ? { importPayloadResolver } : {}),
    // ND2 (2026-06-28) — the Path-1 conversational upload affordance is offered
    // iff an import SUBSTRATE exists (the same `importSubstrate !== null` gate
    // that drives `LiveAgentOnboardingSeam.uploadAffordance()` in open/composer.ts).
    // `notifyImportUpload` keys on THIS to honor a solicited upload at a
    // conversational phase — NOT on `importJobRunner` presence, which is always
    // wired in Open even with a null substrate (Codex review, PR #94).
    importAffordanceOffered: input.importSubstrate !== undefined,
    // 2026-05-25 (Part G.2 + Argus r1 BLOCKER #3) — `importResumeReadiness`
    // probe so the engine renders the `resume_import` button on
    // analysis-presented when prior import is genuinely resumable.
    ...(importResumeReadiness !== null ? { importResumeReadiness } : {}),
    // P2 v2 § 0 #9 + § 7.1 — `archetypes` is INTENTIONALLY NOT wired
    // here. The library is consumed at synthesis time inside
    // `PersonaComposer` (see archetypes wiring above), so the engine's
    // personality_offered phase stays string-only per spec § 3.9.
    // PlatformAdapter thread — retained for the engine's non-router
    // platform accessors.
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
    // 2026-06-13 (onboarding Open-mode) — gate the phase sequence on the
    // deployment mode. Open self-host cuts identity_oauth /
    // instance_provisioned / slug_chosen and swaps the hosted Max OAuth
    // handoff for a local setup-token paste; managed (and the deferred
    // `connect` tier, which onboards as managed until B2) keep the full
    // hosted sequence. Resolved from `NEUTRON_ROLE` per gateway/deployment-mode.ts.
    deploymentMode: resolveDeploymentMode() === 'open' ? 'open' : 'managed',
  })
  return {
    engine,
    buttonStore,
    stateStore,
    transcript,
    registry,
    importJobRunner,
    importPayloadResolver,
    importResumeReadiness,
    archetypes,
  }
}

/**
 * Resolve the in-repo curated archetype data dir relative to this source
 * file. Resolves to `<repo>/onboarding/archetypes/data` because this
 * file lives at `<repo>/gateway/wiring/build-landing-stack.ts`.
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
  // K11b0 (2026-07) — the dead `/ws/chat` `buildWebChatBridge` construction
  // was excised. The engine's onboarding emit fans out through the routed
  // senders (`buildRoutedSendButtonPrompt` / `buildRoutedSendImportProgress`,
  // wired via `buildOnboardingEnginePieces`) on `/ws/app/chat`; the legacy
  // bridge socket had zero production reachability. `createLandingServer` no
  // longer accepts a `bridge`, so the start-token / slug-history / engagement
  // wiring that only fed the bridge is gone with it.
  const landingOpts: Parameters<typeof createLandingServer>[0] = {
    static_dir: input.static_dir,
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
  if (input.installTokenHandler !== undefined) {
    landingOpts.installTokenHandler = input.installTokenHandler
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
