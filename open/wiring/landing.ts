/**
 * @neutronai/open — landing-stack wiring (C3b, carve #3).
 *
 * Behavior-preserving extraction of the `buildLandingStack({...})` call of
 * `createOpenComposition` (old `open/composer.ts` lines 959-1004): the
 * onboarding InterviewEngine + chat UI + WebSocket surface. The argument object
 * references ~20 upstream locals — the late-bound app-socket routers, the
 * install-token handler, the onboarding LLM hooks (phase-spec resolver /
 * character suggester / persona summarizer / project-opening composer), the
 * accumulating-synthesis import substrate, and the shared GBrain sync hook —
 * threaded here through an explicit typed `deps` bag. Fields already carried by
 * the narrow wiring context (`db` / `project_slug` / `owner_home` /
 * `internal_handle` / `env`) come from `ctx`.
 *
 * CARE (invariants pinned by `open/__tests__/open-wiring-landing.test.ts`):
 *   - `importUseSynthesis: true` is passed VERBATIM — it opts the single-owner
 *     composer onto the accumulating-synthesis import runner (`buildSynthesis
 *     Session` → `buildSynthesisImportJobRunner`), NOT the retired per-chunk one.
 *   - `chatAuthGate.isUnauthenticated` closes over `ctx.env` and calls
 *     `deps.resolveOpenLlmPool(ctx.env)` PER REQUEST (evaluated on each `/chat`
 *     hit, reads live env) — `resolveOpenLlmPool` is threaded as a function
 *     reference so the wiring never imports upward into the composer.
 *   - The `!== null` / `!== undefined` conditional spreads (phaseSpecResolver,
 *     personalityCharacterSuggester, personaSummarizer, projectOpeningComposer,
 *     importSubstrate) are preserved exactly so an omitted (undefined) field is
 *     never keyed.
 *
 * The returned `landing` is consumed heavily downstream (`landing.engine`,
 * `landing.importJobRunner`, `landing.importPayloadResolver`,
 * `landing.stateStore`, `landing.appWsAdapter`, `landing.buttonStore`, …). It is
 * returned as `{ landing }` and the composer keeps using `landing.*` verbatim.
 */

import {
  buildLandingStack,
  type BuildLandingStackInput,
  type LandingStackWithEngine,
} from '@neutronai/gateway/realmode-composer/build-landing-stack.ts'
import type { CredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { PlatformAdapter } from '@neutronai/runtime/platform-adapter.ts'
import type {
  AppSocketButtonPromptRouter,
  AppSocketImportProgressRouter,
} from '@neutronai/gateway/http/chat-bridge.ts'
import type { OpenWiringContext } from './context.ts'

/**
 * The composed dependencies the landing stack reads that the narrow wiring
 * context does NOT carry. Each is threaded verbatim from the composer local of
 * the same name; the field types mirror `BuildLandingStackInput` so the composer
 * → deps assignment is exactly what `buildLandingStack` already accepted.
 */
export interface WireLandingStackDeps {
  /** Claude-Max OAuth install-token handoff routes (single-owner handler). */
  installTokenHandler: NonNullable<BuildLandingStackInput['installTokenHandler']>
  /** Late-bound `/ws/app/chat` button-prompt router (mutable holder). */
  appWsButtonPromptRouter: AppSocketButtonPromptRouter
  /** Late-bound `/ws/app/chat` import-progress router (mutable holder). */
  appWsImportProgressRouter: AppSocketImportProgressRouter
  /** Resolved landing static-asset dir. */
  static_dir: string
  /** Single-owner platform adapter (slug availability + conversational flags). */
  platform: PlatformAdapter
  /** Cookie-only `/ws/app/chat` upgrade identity resolver. */
  cookieToUserClaim: NonNullable<BuildLandingStackInput['cookieToUserClaim']>
  /**
   * The composer's `resolveOpenLlmPool` — threaded as a function reference so the
   * `chatAuthGate.isUnauthenticated` closure is byte-identical (evaluated per
   * request against live `ctx.env`) without an upward import into the composer.
   */
  resolveOpenLlmPool: (env: NodeJS.ProcessEnv) => CredentialPool | null
  /** Onboarding phase-spec resolver (LLM rephrasing); null when LLM-less. */
  phaseSpecResolver: NonNullable<BuildLandingStackInput['phaseSpecResolver']> | null
  /** Personality-character suggester; undefined when LLM-less. */
  personalityCharacterSuggester: BuildLandingStackInput['personalityCharacterSuggester']
  /** Persona summarizer; undefined when LLM-less. */
  personaSummarizer: BuildLandingStackInput['personaSummarizer']
  /** Per-project opening-message composer; undefined when LLM-less. */
  projectOpeningComposer: BuildLandingStackInput['projectOpeningComposer']
  /** Accumulating-synthesis import substrate; null when LLM-less. */
  importSubstrate: Substrate | null
  /** Shared GBrain sync hook fanned to the onboarding project-page indexer. */
  gbrainSyncHook: NonNullable<BuildLandingStackInput['importGbrainSyncHook']>
}

export interface WiredLandingStack {
  /** The onboarding engine + chat UI + WS surface; consumed via `landing.*`. */
  landing: LandingStackWithEngine
}

/**
 * Construct the Open composition's landing stack from the narrow wiring context
 * plus the composed `deps`. The call itself is synchronous; the composer keeps
 * consuming the returned `landing` exactly as today.
 */
export function wireLandingStack(
  ctx: OpenWiringContext,
  deps: WireLandingStackDeps,
): WiredLandingStack {
  const landing = buildLandingStack({
    installTokenHandler: deps.installTokenHandler,
    db: ctx.db,
    project_slug: ctx.project_slug,
    owner_home: ctx.owner_home,
    appWsButtonPromptRouter: deps.appWsButtonPromptRouter,
    appWsImportProgressRouter: deps.appWsImportProgressRouter,
    static_dir: deps.static_dir,
    internal_handle: ctx.internal_handle,
    platform: deps.platform,
    cookieToUserClaim: deps.cookieToUserClaim,
    // ISSUES #318 — app-level Claude-auth gate (defense in depth for the
    // installer gate). When the box boots with NO substrate credential,
    // `GET /chat` renders an "Authenticate Claude" page instead of a chat
    // that silently produces nothing. Evaluated per request (reads live env)
    // so a restart-with-token clears it. Same credential predicate the
    // composer's substrate wiring uses (`resolveOpenLlmPool`).
    chatAuthGate: { isUnauthenticated: () => deps.resolveOpenLlmPool(ctx.env) === null },
    ...(deps.phaseSpecResolver !== null ? { phaseSpecResolver: deps.phaseSpecResolver } : {}),
    // ONE warm LLM path (see construction above) — wiring these is the
    // fix for the `pickerLlm not configured` deterministic-fallback bug
    // class the owner hit live. All route through the same `cc-llm`
    // warm interview session; omitted (undefined) only when LLM-less.
    ...(deps.personalityCharacterSuggester !== undefined
      ? { personalityCharacterSuggester: deps.personalityCharacterSuggester }
      : {}),
    // agentNameSuggester intentionally NOT wired (DROP the agent-NAME step,
    // 2026-07-01) — Open onboarding never names the orchestrator.
    ...(deps.personaSummarizer !== undefined ? { personaSummarizer: deps.personaSummarizer } : {}),
    ...(deps.projectOpeningComposer !== undefined
      ? { projectOpeningComposer: deps.projectOpeningComposer }
      : {}),
    // Warm accumulating synthesis substrate — `buildLandingStack` threads it
    // into `buildSynthesisSession` → `buildSynthesisImportJobRunner` so the
    // live import reads the whole export through ONE warm `claude` REPL that
    // ACCUMULATES a user-model across passes (NO `reset_context_per_turn`, NO
    // `/clear`). The per-chunk `buildImportJobRunnerHook` path is retired from
    // the live onboarding flow (Step 2b, 2026-06-17). `importUseSynthesis`
    // opts THIS single-owner composer onto the synthesis runner.
    ...(deps.importSubstrate !== null ? { importSubstrate: deps.importSubstrate } : {}),
    importUseSynthesis: true,
    // Path 1 (2026-06-27) — thread the SHARED GBrain syncHook into the
    // onboarding/import project-page indexer so materialized projects fan out
    // to MEMORY/gbrain (`entities/projects/<slug>.md` + gbrain put_page), not
    // disk-only. Previously unwired in Open, so imported insights never
    // reached the agent's memory recall (build-landing-stack.ts:1016).
    importGbrainSyncHook: deps.gbrainSyncHook,
  })
  return { landing }
}
