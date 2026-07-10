/**
 * @neutronai/open — single-owner graph composer (Sprint D boot shell).
 *
 * This is the IGNITION the Open public mirror was missing. The Open tree
 * already ships every engine part — the onboarding interview machine
 * (`onboarding/`), the landing chat UI + WebSocket (`landing/`), the
 * realmode wiring helpers (`gateway/realmode-composer/*`), and the
 * `boot()` shell (`gateway/index.ts`). But the only thing that wired them
 * into a live HTTP server was the Managed provisioning composer, which is
 * Managed-only and never carves to Open. So a fresh clone of Open booted
 * `/healthz` and nothing else.
 *
 * `buildOpenGraphComposer()` returns a `GraphComposer` — the SINGLE-OWNER
 * subset of the Managed composer:
 *   - reads single-owner config (NEUTRON_HOME, owner identity) — NO
 *     per-project routing, NO subdomain routing, NO provisioning, NO Caddy,
 *     NO registry;
 *   - mounts the onboarding interview phase machine + the landing chat UI
 *     shell + the chat WebSocket via `buildLandingStack`, mirroring the
 *     Managed composer's landing-stack contract;
 *   - LLM turns spawn Claude Code subprocesses (`buildLlmCallSubstrate` →
 *     `createClaudeCodeSubstrateAuto`) — NEVER `api.anthropic.com`. When no
 *     credentials are configured the box still boots and serves onboarding
 *     with the engine's static phase prompts (the LLM-less fallback);
 *   - single-owner session: a host-bound HMAC session cookie (the same
 *     primitive `landing/session-cookie.ts` uses), plus a self-contained
 *     local start-token (`open/local-start-token.ts`) so a fresh owner gets
 *     the first onboarding prompt the moment the chat socket connects.
 *
 * `/healthz` is seeded by `boot()` itself (it owns `bootedAt` + slug) — the
 * composer leaves `default_handler` unset and `boot()` fills it.
 */

import type { CredentialPool } from '@neutronai/runtime/credential-pool.ts'
import {
  resolveEnvOAuthTier,
  resolveApiKeyEnvTier,
  resolveAmbientTier,
} from '@neutronai/gateway/realmode-composer/resolve-llm-credentials.ts'
import { detectAmbientClaudeAuthCached } from './ambient-claude-auth.ts'
import { buildOpenInstallTokenHandler } from './install-token-handoff.ts'
import { persistOauthTokenToEnv, requestSupervisorRestart } from './install-token-env.ts'
import { buildLocalPlatformAdapter } from '@neutronai/runtime/platform-adapter-local.ts'
import type { PlatformAdapter } from '@neutronai/runtime/platform-adapter.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { resolveLandingStaticDir } from '@neutronai/gateway/realmode-composer/build-landing-stack.ts'
import { buildLiveAgentTurn } from '@neutronai/gateway/realmode-composer/build-live-agent-turn.ts'
import type { LiveAgentOnboardingSeam } from '@neutronai/gateway/realmode-composer/build-live-agent-turn.ts'
import { buildProjectDocComposer } from '@neutronai/gateway/realmode-composer/build-project-doc-composer.ts'
import { buildProjectKickoffComposer } from '@neutronai/gateway/realmode-composer/build-project-kickoff-composer.ts'
import { buildProjectKickoff } from '@neutronai/gateway/realmode-composer/build-project-kickoff.ts'
import { buildProjectPageIndexer } from '@neutronai/gateway/realmode-composer/build-project-page-indexer.ts'
import { buildOnboardingFinalize } from '@neutronai/gateway/realmode-composer/build-onboarding-finalize.ts'
import { buildPostTurnExtractor } from '@neutronai/onboarding/interview/post-turn-extractor.ts'
import { auditRequiredFields } from '@neutronai/onboarding/interview/required-fields-audit.ts'
import { captureButtonBackedRequiredField } from '@neutronai/onboarding/interview/button-backed-answer.ts'
import {
  buildImportAnalysisContextFragment,
  buildImportInFlightSteerFragment,
  buildOnboardingPreamble,
  buildOnboardingStepGuardFragment,
} from '@neutronai/onboarding/interview/onboarding-preamble.ts'
import type { ImportResult } from '@neutronai/onboarding/history-import/types.ts'
import {
  buildLlmCallSubstrate,
  collectTokensToString,
} from '@neutronai/gateway/realmode-composer/build-llm-call-substrate.ts'
import { buildSubstrateWorkflowFire } from '@neutronai/trident/inner-loop.ts'
import { getBestModel } from '@neutronai/runtime/models.ts'
import {
  FIRST_CONVERSATIONAL_TIMEOUT_MS_DEFAULT,
  PREWARM_AWAIT_CAP_MS_DEFAULT,
} from '@neutronai/onboarding/interview/llm-timeouts.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import { SubagentRegistry } from '@neutronai/runtime/subagent/registry.ts'
import { newControlState } from '@neutronai/runtime/subagent/control.ts'
import {
  DispatchService,
  buildCancellableDispatchTurn,
  defaultPersonaLoader,
  type DispatchBoardBinder,
} from '@neutronai/agent-dispatch/index.ts'
import {
  buildAnthropicLlmCall,
  buildPhaseSpecResolver,
} from '@neutronai/gateway/realmode-composer/build-phase-spec-resolver.ts'
import { buildGatewayAnthropicMessagesClient } from '@neutronai/gateway/realmode-composer/build-anthropic-messages-client.ts'
import { buildProjectOpeningMessageComposer } from '@neutronai/gateway/realmode-composer/build-project-opening-message.ts'
import { mkdirSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { constantTimeEqual } from '@neutronai/runtime/constant-time-equal.ts'
import { DocSearchIndex } from '@neutronai/doc-search/store.ts'
import { DocSearchRuntime } from '@neutronai/doc-search/runtime.ts'
import { buildLiveProjectEnumerator } from './doc-search-live-enumerator.ts'
import { buildButtonStoreMessageSearchRuntime } from '@neutronai/gateway/composition/message-search-wiring.ts'
import { mountOpenCores } from '@neutronai/gateway/cores/mount-open-cores.ts'
import { wireSubstrates } from './wiring/substrates.ts'
import { wireMemory } from './wiring/memory.ts'
import { wireLandingStack } from './wiring/landing.ts'
import { wireUploads } from './wiring/uploads.ts'
import { buildOpenOwnerGate } from './wiring/owner-gate.ts'
import { wireAppWs, type OnboardingMsgEmit } from './wiring/app-ws.ts'
import { late } from './wiring/late.ts'
import type { OpenWiringContext } from './wiring/context.ts'
import { buildChainedChatCommandFilter } from '@neutronai/gateway/boot-helpers.ts'
import {
  SkillForge,
  SkillForgeProposalsStore,
  buildSkillForgeBackend,
  buildSkillForgeChatCommandFilter,
  completedWorkflowFromTridentRun,
} from '@neutronai/skill-forge/index.ts'
import {
  provisionAgentSkills,
  resolveAgentSkillsDir,
} from '@neutronai/runtime/adapters/claude-code/persistent/agent-skills.ts'
import { TridentRunStore, type TridentRun } from '@neutronai/trident/store.ts'
import { runProgressForItem } from '@neutronai/trident/run-progress.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { buildPersonalityCharacterSuggester } from '@neutronai/onboarding/interview/personality-character-suggester.ts'
import { buildPersonaSummarizer } from '@neutronai/onboarding/persona-gen/summarize.ts'
import { PersonaPromptLoader } from '@neutronai/gateway/realmode-composer/persona-loader.ts'
import type { GraphComposer } from '@neutronai/gateway/boot-helpers.ts'
import type { CompositionInput } from '@neutronai/gateway/composition.ts'
import { buildLlmBriefComposer } from '@neutronai/gateway/proactive/morning-brief.ts'

/**
 * C3d — the Open composition's return type. `CompositionInput` with the surfaces
 * Open UNCONDITIONALLY sets marked REQUIRED, so a DROPPED slice fails at COMPILE
 * (a missing property on the return literal) instead of 404-ing at runtime.
 *
 * The required-pick set is derived from the field-key characterization snapshot
 * (`open/__tests__/open-composition-fields-characterization.test.ts`) MINUS the
 * CONDITIONALLY-omitted surfaces — `doc_search`, `import_resume_handler`,
 * `trident`, `trident_build_dispatch`, `agent_dispatch` — which the composer
 * spreads only when their doc-index / import-runner / live-credential gate holds
 * (marking THEM required would break an LLM-less boot). Everything else is set on
 * every code path, so it is safe (and useful) to require.
 */
export type OpenComposition = CompositionInput &
  Required<
    Pick<
      CompositionInput,
      | 'db'
      | 'project_slug'
      | 'chat_topics_surface'
      | 'chat_history_surface'
      | 'topic_handler'
      | 'approval_notifier'
      | 'watchdog_notifier'
      | 'reminder_dispatcher'
      | 'tasks'
      | 'heartbeat_tracker'
      | 'platform'
      | 'cron_jobs'
      | 'cores'
      | 'gbrain_search'
      | 'work_board'
      | 'create_project'
      | 'message_search'
      | 'import_upload_handler'
      | 'chunked_upload_handler'
      | 'onboarding_import_running_cron'
      | 'skill_forge'
      | 'realmode_cleanups'
      | 'landing_server'
      | 'app_ws_surface'
      | 'app_docs_surface'
      | 'app_tabs_surface'
      | 'app_projects_surface'
      | 'app_work_board_surface'
      | 'app_project_credentials_surface'
      | 'app_codex_credential_surface'
      | 'codex_credential'
      | 'app_tasks_surface'
      | 'app_upload_surface'
    >
  >
import { buildLlmNudgeRater } from '@neutronai/gateway/proactive/idle-nudge-sweep.ts'
import { buildButtonStoreProactiveSink } from '@neutronai/gateway/proactive/button-store-sink.ts'
import { resolveLocalTimezone } from '@neutronai/gateway/proactive/local-timezone.ts'
import { readSessionCookie } from '@neutronai/landing/session-cookie.ts'

import {
  buildReminderDispatcher,
  buildSubstrateReminderLlm,
  buildStatusMdContextSource,
} from '@neutronai/reminders/index.ts'
// L3 (2026-07) — the reminder delivery impl moved UP into the gateway
// composition band (it reaches the WebChatSenderRegistry + landing protocol).
import { buildButtonStoreReminderOutbound } from '@neutronai/gateway/proactive/reminder-outbound.ts'

import { buildLocalStartTokenAuth } from './local-start-token.ts'
import { buildProjectPersonaResolver } from './project-persona-resolver.ts'
import { createOpenChatTopicsSurface } from './chat-topics-surface.ts'
import { createChatHistorySurface } from '@neutronai/gateway/http/chat-history-surface.ts'
import { OWNER_USER_ID, resolveNeutronHome, resolveOpenInstanceInfo } from './owner-identity.ts'
// L3 (2026-07) — build the Open agent-profile backend HERE (composition root)
// and inject it into `mountOpenCores`, so the gateway core no longer imports the
// `open` band.
import { buildOpenAgentProfileBackend } from './agent-profile-backend.ts'
// P1b (2026-06-26) — wire the per-project Documents backend + the cores
// integrations/api-keys surface into the single-owner Open boot. Both authorize
// against ONE single-owner localhost-trust resolver (Path A): the owner is the
// only user and is already authed at the HTTP start-token/cookie layer, so the
// app-bearer (`dev:<owner>`) is accepted directly. No feature flag, single path.
import { createAppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { DocStore } from '@neutronai/gateway/http/doc-store.ts'
import { createAppDocsSurface } from '@neutronai/gateway/http/app-docs-surface.ts'
import { createAppTabsSurface } from '@neutronai/gateway/http/app-tabs-surface.ts'
import { createAppProjectsSurface } from '@neutronai/gateway/http/app-projects-surface.ts'
import { SqliteProjectSettingsStore } from '@neutronai/gateway/projects/sqlite-store.ts'
import { resolveProjectEmoji } from '@neutronai/contracts/default-emoji.ts'
import {
  createProjectRow,
  materializeProjectScaffold,
  type ProjectScaffoldDeps,
} from '@neutronai/gateway/realmode-composer/project-create.ts'
import type { CreateProjectToolService } from '@neutronai/gateway/realmode-composer/create-project-tool.ts'
import { createAppTasksSurface } from '@neutronai/gateway/http/app-tasks-surface.ts'
import { createAppUploadSurface } from '@neutronai/gateway/http/app-upload-surface.ts'
import { TaskStore } from '@neutronai/tasks/store.ts'
import { AppWsAdapter, optionsToInlineChoices } from '@neutronai/channels/adapters/app-ws/adapter.ts'
import { InMemoryAppWsSessionRegistry } from '@neutronai/channels/adapters/app-ws/session-registry.ts'
import {
  appWsTopicId,
  appWsProjectTopicId,
  type AppWsOutboundAgentMessage,
  type AppWsOutboundAgentTyping,
  type AppWsOutboundImportProgress,
  type AppWsOutboundOnboardingCompleted,
  type AppWsOutboundProjectsChanged,
  type AppWsOutboundWorkBoardChanged,
} from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { createWorkBoardSurface } from '@neutronai/gateway/http/work-board-surface.ts'
import { createProjectCredentialsSurface } from '@neutronai/gateway/http/project-credentials-surface.ts'
import { createCodexCredentialSurface } from '@neutronai/gateway/http/codex-credential-surface.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { CodexCredentialService } from '@neutronai/trident/codex-credential.ts'
import { resolveCodexHome } from '@neutronai/trident/codex-auth.ts'
import { formatAvailableServicesFragment } from '@neutronai/project-credentials/fragment.ts'
import {
  WorkBoardStore,
  workBoardProjectIdForKey,
  workBoardScopeKey,
  type WorkBoardItem,
} from '@neutronai/work-board/store.ts'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import { deriveRunProgress } from '@neutronai/trident/run-progress.ts'
import {
  deriveProjectActivity,
  truncatePreview,
  type ProjectActivity,
  type PreviewFrom,
} from './project-rail.ts'
import { WorkBoardSpecDocService } from '@neutronai/work-board/spec-doc-service.ts'
import { dispatchBoardBoundBuild } from '@neutronai/trident/board-dispatch.ts'
import { buildForgeConflictResolver } from '@neutronai/trident/conflict-resolver.ts'
import type { WorkBoardStartResult } from '@neutronai/gateway/http/work-board-surface.ts'
import { formatWorkBoardFragment } from '@neutronai/work-board/fragment.ts'
import { InMemoryConsumedTokens } from '@neutronai/runtime/consumed-tokens-in-memory.ts'
import type {
  AppSocketButtonPromptRouter,
  AppSocketImportProgressRouter,
} from '@neutronai/gateway/http/chat-bridge.ts'
import type { OutgoingMessage } from '@neutronai/channels/types.ts'
import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'

export interface BuildOpenGraphComposerOptions {
  /** Override the process env (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /**
   * C1 — the frozen, validated {@link BootConfig} the entrypoint resolved. The
   * Open entrypoint threads it here so the composer shares boot()'s single env
   * resolution. Sub-builders still read `env` (kept in lockstep by the
   * `open/server.ts` process.env write-back shim) until a later unit migrates
   * them to read `config` directly; passing it now closes the entrypoint→
   * composer half of the "boot re-reads env independently" hazard.
   */
  config?: import('@neutronai/config/index.ts').BootConfig
  /**
   * Substrate-construction seam, threaded verbatim into BOTH the onboarding
   * phase-spec substrate AND the live-chat substrate via
   * `buildLlmCallSubstrate({ substrateFactory })`. Defaults to undefined →
   * `createClaudeCodeSubstrateAuto` (the real persistent interactive-REPL
   * substrate — the SOLE production path; a fresh `bun start` NEVER sets this).
   *
   * The single-owner E2E (`tests/e2e/`) injects a deterministic fake
   * `Substrate` here so the served signup→onboarding→chat flow can be walked
   * end-to-end with a MOCKED LLM — no real `claude` REPL, no
   * `api.anthropic.com`, no Max token (synthetic-auth, per
   * `feedback_e2e_synthetic_auth`). The fake receives the fully-composed
   * `ClaudeCodeSubstrateOptions` (scrubbed auth env + credential identity), so
   * the test still exercises the real composer's credential-pool wiring.
   */
  substrateFactory?: (
    opts: import('@neutronai/runtime/adapters/claude-code/index.ts').ClaudeCodeSubstrateOptions,
  ) => import('@neutronai/runtime/substrate.ts').Substrate
  /**
   * Install-token handoff seam (E2E). Production leaves this undefined →
   * `buildOpenInstallTokenHandler` with the real `.env`-persist + supervisor-
   * restart side effects. The single-owner E2E injects a handler whose
   * `persistToken`/`requestRestart` are spies so the no-token → handoff →
   * activate flow can be walked without writing `.env` or exiting the runner.
   */
  installTokenHandler?: (req: Request) => Promise<Response | null>
}

/**
 * Resolve the single-owner LLM credential pool from the environment, honoring
 * BOTH subscription OAuth and API-billing auth. C6 (2026-07-09): this now walks
 * the SHARED credential precedence table
 * (`gateway/realmode-composer/resolve-llm-credentials.ts` —
 * `resolveEnvOAuthTier` → `resolveApiKeyEnvTier` → `resolveAmbientTier`) rather
 * than re-implementing the env-OAuth / API-key pool construction by hand. The
 * Managed resolver (`resolveLlmCredentials`) consumes the SAME tier helpers, so
 * the two paths can no longer drift; the pre-C6 "mirroring the Managed resolver
 * by comment" note is retired. Open resolves the anthropic-only sync tiers
 * (2 / 4 / 5) — it wires NO Max OAuth source (tier 1) and NO BYO ApiKeyStore
 * (tier 3), and it uniquely enables the ambient tier (`allowAmbient: true`).
 *
 * This is the credential the `claude` subprocess substrate runs on (NEVER a
 * direct api.anthropic.com call):
 *
 *   - `CLAUDE_CODE_OAUTH_TOKEN` (what `claude setup-token` prints — the
 *     self-host subscription path) → `kind: 'oauth'`, threaded to the
 *     subprocess as a `Authorization: Bearer …` token by
 *     `build-llm-call-substrate`. (tier 2 — `resolveEnvOAuthTier`)
 *   - else `ANTHROPIC_API_KEY` (API-billing) → `kind: 'api_key'`. Passed as a
 *     single-entry `env_vars` list so the shared-tier gate never classifies it
 *     as a cross-instance shared key — it is the per-owner box key.
 *     (tier 4 — `resolveApiKeyEnvTier`)
 *   - else, if `claude` is already AMBIENT/Keychain-authed (the owner ran
 *     `claude` login on this Mac; creds live in the macOS "Claude Code-credentials"
 *     Keychain item, NOT in env) → `kind: 'ambient'`. The substrate spawns
 *     `claude` threading NO token (the ambient pool's secret is the empty
 *     string), so the child auths via its own Keychain. This closes the
 *     fresh-install 503: a Mac self-hoster with `claude` already logged in no
 *     longer hits a Day-1 "Authenticate Claude" wall even though `claude -p`
 *     works headlessly. The probe is fast + cached + never-hanging
 *     (`detectAmbientClaudeAuthCached`); a timeout/failure → not-authed → the
 *     gate stays up. SINGLE-OWNER ONLY: this resolver runs only on the Open
 *     composer, where an ambient Keychain login is the box owner's own — which
 *     is why the shared table gates the ambient tier behind `allowAmbient`, set
 *     TRUE only here. (tier 5 — `resolveAmbientTier`)
 *   - else `null` → the box boots LLM-less and onboarding walks its static
 *     phase prompts.
 *
 * BEFORE the OAuth tier existed the Open composer gated the entire substrate on
 * `ANTHROPIC_API_KEY` alone, so a self-hoster who authed via `claude
 * setup-token` (subscription OAuth, the headline `curl | sh` flow) booted
 * LLM-less while the installer reported success — a false-success no-op.
 * Consuming the OAuth token is what makes the install.sh "✓ Claude auth
 * detected" honest: install.sh's notion of "authed" now matches what the
 * Open server actually consumes.
 *
 * Open threads NO `log_slug` into the tier helpers, so it stays silent (no
 * INFO/WARN lines) exactly as before C6.
 *
 * `opts.probeAmbientAuth` is a test seam — production defaults to the cached
 * Keychain/creds-file probe. It is consulted ONLY on the no-explicit-token
 * branch, so a configured token short-circuits with zero subprocess cost.
 */
export function resolveOpenLlmPool(
  env: NodeJS.ProcessEnv,
  opts?: { probeAmbientAuth?: () => boolean },
): CredentialPool | null {
  // Tier 2 — subscription OAuth token.
  const envOAuth = resolveEnvOAuthTier({ provider: 'anthropic', env })
  if (envOAuth !== null) return envOAuth
  // Tier 4 — API-billing key. Single-entry env_vars ⇒ never the "shared" tier;
  // Open is always deployment-mode 'open' ⇒ allowSharedEnvTier is moot but true.
  const envKey = resolveApiKeyEnvTier({
    provider: 'anthropic',
    env,
    env_vars: ['ANTHROPIC_API_KEY'],
    allowSharedEnvTier: true,
  })
  if (envKey !== null) return envKey
  // Tier 5 — ambient/Keychain `claude` (Open-only). No secret threaded; the
  // spawned `claude` child auths via its own Keychain.
  const probeAmbientAuth = opts?.probeAmbientAuth ?? (() => detectAmbientClaudeAuthCached(env))
  return resolveAmbientTier({ provider: 'anthropic', allowAmbient: true, probeAmbientAuth })
}

// C3d — the two pure Open-mode app-ws routing helpers MOVED to
// `open/wiring/app-ws.ts` (they are app-ws-only). Re-exported here so the
// existing `open/__tests__/open-import-analysis-delivery.test.ts` import path
// (`../composer.ts`) keeps working.
export {
  resolveOpenImportPromptEmission,
  resolveImportRunningStatusDelivery,
  type ImportRunningStatusDelivery,
} from './wiring/app-ws.ts'

/**
 * Build the single-owner Open graph composer. The returned closure is what
 * `boot({ composer })` invokes after migrations — it receives the live
 * `ProjectDb` + the boot-frozen `project_slug` and returns the
 * `CompositionInput` describing the onboarding + chat surface.
 */
export function buildOpenGraphComposer(
  options: BuildOpenGraphComposerOptions = {},
): GraphComposer {
  const env = options.env ?? process.env

  return async ({ db, project_slug }): Promise<OpenComposition> => {
    const owner_home = resolveNeutronHome(env)
    const static_dir = resolveLandingStaticDir(env)
    // Single-owner: the frozen instance handle IS the boot slug.
    const internal_handle = project_slug
    const instanceInfo = resolveOpenInstanceInfo({ project_slug, owner_home, env })

    // P1-5 (lift audit § P1-5) — native Claude Code SKILL.md discovery. Materialize
    // the bundled skill packs (`impeccable` + design sub-skills, `agent-browser`,
    // `remind`) into the live agent's PROJECT skills dir (`<owner_home>/.claude/skills`)
    // so the spawned interactive REPL (cwd = owner_home) discovers + invokes them
    // NATIVELY via the built-in `Skill` mechanism — the same loader Vajra's
    // `~/.claude/skills` rides on. Idempotent + best-effort: refreshes bundled packs
    // on every boot, never deletes a forged pack. Skill-forge re-points its approved
    // output at this SAME dir (below), so a forged skill lands here as a loadable
    // `SKILL.md` pack too.
    const agentSkillsDir = resolveAgentSkillsDir(owner_home)
    try {
      const provisioned = provisionAgentSkills({ skillsDir: agentSkillsDir })
      console.log(
        `[skills] provisioned ${provisioned.bundled.length} bundled skill pack(s) into ${agentSkillsDir} ` +
          `(${provisioned.present.length} total discoverable)`,
      )
    } catch (err) {
      // Never block boot on skill provisioning — the agent just lacks the packs.
      console.warn(
        `[skills] provisioning failed for ${agentSkillsDir}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // Shared per-owner persona loader — splices <owner_home>/persona/*.md
    // into every onboarding + chat system prompt.
    const personaLoader = new PersonaPromptLoader({ owner_home })

    // Shared cron registry — threaded into BOTH the wow-dispatcher (via the
    // landing stack) AND CompositionInput.cron_jobs so the scheduler and the
    // dispatcher share one registry (Managed composer does the same).
    const cronJobs = new CronJobRegistry()

    // ── CC-spawn LLM substrate (gated on credentials) ──────────────────────
    // Resolve the single-owner credential pool from the environment, honoring
    // BOTH the subscription OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`, what
    // `claude setup-token` yields — the self-host default) AND an API-billing
    // key (`ANTHROPIC_API_KEY`). The substrate spawns the `claude` subprocess
    // (NEVER a direct api.anthropic.com call — buildLlmCallSubstrate dispatches
    // through createClaudeCodeSubstrateAuto and threads an oauth-kind pool to
    // the child as CLAUDE_CODE_OAUTH_TOKEN). When NEITHER credential is present
    // the box boots LLM-less and the onboarding engine walks its static phase
    // prompts.
    const llmPool = resolveOpenLlmPool(env)

    // Optional test-only substrate factory seam (E2E mocked-LLM). Undefined in
    // production → buildLlmCallSubstrate falls through to its
    // createClaudeCodeSubstrateAuto default.
    const substrateFactory = options.substrateFactory

    // ── CC-spawn substrates (C3a: carved to open/wiring/substrates.ts) ──────
    // The warm onboarding phase-spec (`cc-llm-*`) substrate + its pre-warm, the
    // warm live-chat (`cc-agent-*`, the ONLY tool-bridge substrate), the
    // per-worktree ephemeral factory, and the warm per-repo-cwd trident-fire
    // factory. Built once from the narrow wiring context and consumed downstream
    // verbatim. `prewarmSettledRef` is a LIVE reference the pre-warm `.then`
    // flips (cold-window budget elevation reads `.settled`, not a snapshot).
    const wiringCtx: OpenWiringContext = {
      llmPool,
      internal_handle,
      owner_home,
      project_slug,
      env,
      db,
      prewarmSubstrate,
      ...(substrateFactory !== undefined ? { substrateFactory } : {}),
    }
    const {
      llmCallSubstrate,
      liveAgentSubstrate,
      makeEphemeralSubstrate,
      makeWarmFireSubstrate,
      prewarmReady,
      prewarmSettledRef,
      cleanups: substrateCleanups,
    } = wireSubstrates(wiringCtx)
    const tridentFireInnerWorkflow =
      llmPool !== null
        ? buildSubstrateWorkflowFire({ build_substrate: makeWarmFireSubstrate })
        : null

    // Agent-dispatch family (parity gap #3) — the general named-specialist +
    // ad-hoc background-agent surface (research → Atlas, review → Sentinel,
    // adhoc → a one-shot agent) that mirrors Vajra's `spawn-agent.sh`. It is
    // built ON the same `runtime/subagent/` registry + watchdog the Trident
    // loop uses (one registry, one concurrency cap, one supervisor), and it
    // spawns a fresh `cc-dispatch-*` REPL per turn via the SAME factory. The
    // turn is CANCELLABLE (`buildCancellableDispatchTurn`): a `/dispatch stop` or
    // a watchdog reap actually terminates the subprocess. Gated on the same
    // credential availability as Trident (no credential → unregistered; no flag).
    // Work Board Phase 2b — the dispatch board binder. The canonical
    // `workBoardStore` is constructed later (it needs `appWsRegistry`), so the
    // dispatch service reaches it through this late-bound holder (same pattern
    // as the onboarding routers above). Set once below, after the store exists;
    // every runtime dispatch happens long after composition, so the store is
    // always populated by the time `dispatch()` runs.
    // C3d — a `late<T>` two-phase seam. The canonical `workBoardStore` is
    // constructed later (it needs `appWsRegistry`), so the dispatch binder reads
    // it through this holder; `bind` fires once below, after the store exists.
    const dispatchBoardHolder = late<WorkBoardStore>('dispatch_board_store')
    const dispatchBoardBinder: DispatchBoardBinder = {
      get: (slug, id) => dispatchBoardHolder.deref((s) => s.get(slug, id)) ?? null,
      attachRun: async (slug, id, run_id) => {
        await dispatchBoardHolder.deref((s) => s.attachRun(slug, id, run_id))
      },
      clearRun: async (slug, id, run_id) => {
        await dispatchBoardHolder.deref((s) => s.clearRun(slug, id, run_id))
      },
    }
    const dispatchService = ((): DispatchService | null => {
      if (llmPool === null) return null
      const registry = new SubagentRegistry()
      const control = newControlState(registry)
      return new DispatchService({
        registry,
        control,
        dispatch: buildCancellableDispatchTurn({
          build_substrate: makeEphemeralSubstrate('cc-dispatch'),
        }),
        report: async (r) => {
          // First-cut report-back: log the announcement. The live WS
          // `agent_message` splice is the documented follow-up (Open is
          // WS-native + single-owner, no Telegram channel).
          console.log(
            `[agent-dispatch] ${r.kind} (${r.agent_kind}) ${r.run_id.slice(0, 8)} → ${r.status}\n${r.markdown}`,
          )
        },
        instance_key: internal_handle,
        // Phase 2b — the board-binding chokepoint: every dispatch must carry a
        // valid, sufficiently-specified board_item_id (else rejected) and is
        // bound to its Plan item for the duration of the run.
        board: dispatchBoardBinder,
        project_slug,
        repo_path: owner_home,
        // Pass the dynamic accessor (thunk) so each dispatch resolves the live
        // best model — the watchdog's adopted id reaches new agent-dispatch runs.
        default_model: getBestModel,
        persona_loader: defaultPersonaLoader,
      })
    })()

    // ── Skill-forge → Open boot (Vajra parity gap #5) ──────────────────────
    // Auto-skillify: audit a COMPLETED Trident workflow and, gated by the
    // propose-then-approve step, distill it into a saved, re-invokable skill
    // under `<owner_home>/skills/conventions/` — the dir the realmode composer
    // splices into every LLM turn (`registrar.ts`), so an approved skill is
    // immediately agent-discoverable and survives a fresh session.
    //
    // Built UNCONDITIONALLY (no `llmPool` gate, no feature flag): the
    // approve/decline/list surface — the `skill_forge_*` MCP tools (agent-native)
    // AND the `/skills` chat command, sharing ONE `SkillForgeBackend` — must work
    // even on an LLM-less box (a persisted proposal can still be approved). The
    // auto-propose TRIGGER is wired separately, into the Trident terminal hook
    // (`trident.on_run_terminal` below) — it only fires on a `done` run, which
    // itself only advances when `tridentDispatch !== null` (i.e. llmPool exists),
    // so an LLM-less box simply never produces a proposal.
    //
    // Notifier mirrors agent-dispatch's report sink (Open is WS-native +
    // single-owner, no Telegram channel): it logs the proposal. The proposal is
    // PERSISTED regardless of delivery (the store row is the source of truth),
    // so `/skills list` surfaces it even if the notify is a no-op log.
    const skillForgeStore = new SkillForgeProposalsStore({ db })
    const skillForge = new SkillForge({
      store: skillForgeStore,
      notifier: {
        async notify(proposal, message): Promise<void> {
          console.log(
            `[skill-forge] proposal ${proposal.id} (${proposal.proposed_name}):\n${message}`,
          )
        },
      },
      // P1-5 — write approved skills as native `SKILL.md` packs into the SAME
      // project skills dir the live REPL discovers natively (`<owner_home>/.claude/
      // skills/<name>/SKILL.md`), instead of the legacy convention-injection path
      // (`<owner_home>/skills/conventions/*.md`). Closes the loop: a forged skill
      // becomes an actually-loadable native skill, not just injected prose.
      skillsDir: agentSkillsDir,
    })
    const skillForgeBackend = buildSkillForgeBackend(skillForge, skillForgeStore)
    // The Trident-terminal trigger: on every terminal run, audit a `done`
    // workflow for skill-worthiness (the audit itself drops non-`done` runs).
    // Fire-and-forget by the trident module (it wraps this in try/catch).
    const skillForgeOnRunTerminal = async (run: TridentRun): Promise<void> => {
      if (run.phase !== 'done') return
      await skillForge.onWorkflowCompleted(completedWorkflowFromTridentRun(run))
    }

    // Dedicated WARM history-import / synthesis substrate (2026-06-17 Step 2b —
    // single-session synthesis cut-over). The live onboarding import now runs
    // through the ONE accumulating synthesis session (`onboarding/synthesis/*`
    // via `buildSynthesisSession` → `buildSynthesisImportJobRunner`, wired in
    // `buildLandingStack`): a deterministic pre-pass organizes the export, then
    // this ONE warm `claude` REPL reads it in a handful of passes, holding a
    // running user-model in its working context across passes and routing
    // conversations into per-project buckets.
    //
    // CRITICAL: this substrate ACCUMULATES — NO `reset_context_per_turn`, NO
    // `/clear`. Clearing context between passes is the exact anti-pattern the
    // 2026-06-17 rework removes (it destroys the accumulating model). This
    // RETIRES the per-chunk `reset_context_per_turn` import mode (#79), where
    // each chunk was a self-contained LLM call that `/clear`'d the prior
    // chunk's context — ~170 round-trips that built no model of the user.
    //
    // A distinct `cc-synthesis-*` instance id keeps this REPL isolated from the
    // conversational (`cc-agent-*`) and phase-spec (`cc-llm-*`) warm pools.
    const importSubstrate =
      llmPool !== null
        ? buildLlmCallSubstrate({
            pool: llmPool,
            substrate_instance_id: `cc-synthesis-${internal_handle}`,
            cwd: owner_home,
            internal_handle,
            user_id: OWNER_USER_ID,
            project_slug,
            skip_permissions: true,
            ...(substrateFactory !== undefined ? { substrateFactory } : {}),
          })
        : null

    // Realmode teardown sinks (upload sweeper + the scribe GBrain child below).
    // Declared here so the scribe wiring — which is constructed BEFORE
    // `buildLandingStack` (it needs `scribeOnUserTurn`) — can register the
    // `gbrain serve` close hook. Returned on `realmode_cleanups`.
    // §F1 — a cleanup may be async (e.g. the upload sweeper's quiescing
    // `stop()`); the gateway shutdown runner awaits each before `db.close()`.
    const realmodeCleanups: Array<() => void | Promise<void>> = []
    // Substrate teardown hooks (C3a): registered here — the point at which the
    // substrate wiring's inline cleanups previously ran. None exist today (the
    // array is empty), but the contract stays wired for the C3b-d carves.
    for (const cleanup of substrateCleanups) realmodeCleanups.push(cleanup)

    // ── Doc search (QMD-equivalent) — index + agent tools ──────────────────
    // gap-audit P1 #9 / cat 13: Neutron agents could read a KNOWN doc path
    // but had no corpus search over the owner's project folders, so the
    // "research before asking" discipline couldn't function. This builds a
    // local BM25 (SQLite FTS5) index over every project's markdown
    // (`<owner_home>/Projects/<id>/`) and registers the `doc_search` +
    // `doc_read` agent tools so the live chat agent can search docs
    // mid-conversation. OSS-friendly: no external embedding provider; the
    // index opens synchronously and refreshes lazily (incremental, mtime-
    // diffed) on the first tool call. Failure-isolated: a doc-search open
    // failure must never sink the whole boot.
    let docSearchRuntime: DocSearchRuntime | null = null
    try {
      const docIndexPath = joinPath(owner_home, 'cache', 'doc-search', 'index.db')
      mkdirSync(joinPath(owner_home, 'cache', 'doc-search'), { recursive: true })
      const docIndex = DocSearchIndex.open(docIndexPath)
      docSearchRuntime = new DocSearchRuntime({
        ownerHome: owner_home,
        index: docIndex,
        // Exclude SOFT-DELETED projects from the corpus: `delete_project` only
        // sets `projects.deleted_at` and never removes the on-disk folder, so
        // without this the indexer keeps the folder and `doc_search` keeps
        // surfacing a deleted project's docs (M1 E2E Round 4, bug E).
        enumerateProjects: buildLiveProjectEnumerator(db),
      })
      realmodeCleanups.push(() => {
        try {
          docIndex.close()
        } catch {
          // best-effort on shutdown
        }
      })
    } catch (err) {
      console.warn('[open] doc-search index unavailable; doc_search tools disabled:', err)
      docSearchRuntime = null
    }

    // ── Scribe / GBrain / reflection (C3a: carved to open/wiring/memory.ts) ──
    // The dedicated `cc-scribe-*` extraction substrate, the lazy fail-soft
    // GBrain memory + its `syncHook`, the `cc-reflection-*` correction judge +
    // `reflection`, the `scribeOnUserTurn` chat-bridge hook, and the Cores→scribe
    // phase-2 fan-out. Self-contained given the wiring context. Its teardown
    // hooks (GBrain close, fan-out stop) append onto `realmodeCleanups` HERE, at
    // the carve site, so SIGTERM ordering stays byte-identical.
    const {
      gbrainMemory,
      gbrainSyncHook,
      scribe,
      reflection,
      scribeOnUserTurn,
      cleanups: memoryCleanups,
    } = wireMemory(wiringCtx)
    for (const cleanup of memoryCleanups) realmodeCleanups.push(cleanup)

    // ── Free Cores → Open boot (Vajra parity gap #2) ───────────────────────
    // Compose the bundled free Cores (Calendar / Email / Google-Workspace /
    // Notes / Reminders / Research) into the single-owner daily-driver, REUSING
    // the Managed mechanism (`buildCoresBackendFactories` + the chained
    // chat-command filter — `gateway/cores/mount-open-cores.ts`):
    //   - `cores.backends` (below) drives `installBundledCores` so each Core's
    //     `buildTools(deps)` MCP surface registers (agent-native parity).
    //   - `coresWiring.chatCommandFilter` is threaded into `buildLandingStack`
    //     so a typed `/cal` / `/email` / `/note` / `/remind` / `/research` is
    //     routed to its Core BEFORE the LLM turn (the repo-wide chat-filter gap).
    // Optional-until-credentialed: a per-instance OAuthTokenManager over the
    // shared SecretsStore. With no `NEUTRON_CORES_GOOGLE_CLIENT_ID` (the
    // zero-creds Open default) the Calendar/Gmail/Workspace backends fall back to
    // in-memory clients — `/cal`/`/email` show an empty calendar/inbox, never a
    // hard error, never a boot block. The LLM-driven Core calls run on a DEDICATED
    // ephemeral `cc-cores-*` substrate (isolated from the chat REPL), or degrade
    // gracefully when LLM-less. Built unconditionally — Cores compose with zero
    // creds; only the LLM-backed sub-paths gate on `llmPool`.
    const secretsStore = new SecretsStore({ data_dir: owner_home, db })
    // Per-project credential store (Settings tab + D2 Cores resolver) — ONE
    // canonical instance shared by the CRUD surface (createProjectCredentialsSurface
    // below), the per-project→global→unset resolver the Cores resolve their
    // credential through (mountOpenCores), and the per-turn "available services"
    // awareness injection. Reuses the SecretsStore AES-256-GCM crypto (shared
    // `.neutron-aes-key` keyfile). Constructed HERE (before mountOpenCores) so the
    // Cores' credential accessors can bind to it.
    const projectCredentialStore = new ProjectCredentialStore(db, { crypto: secretsStore })
    // Codex subscription credential (trident cross-model review). Codex is a
    // GLOBAL, trident-wide credential (trident runs across ANY project), so the
    // PRIMARY connect surface is the account-wide General admin UI; the store
    // scope defaults to `global`. A per-project OVERRIDE (that project's Settings
    // tab) wins over the global default for that project (store resolver:
    // project → global → unset). The admin-panel Connect Codex surface + the
    // `codex_connect`/`codex_status` agent tools dispatch this ONE service:
    // validate a pasted ChatGPT-subscription auth.json (metered OPENAI_API_KEY
    // rejected), store it encrypted in the #149 credential store (service `codex`),
    // and materialize it to the CODEX_HOME `trident/codex-review.sh` reads — the
    // GLOBAL dir (`resolveCodexHome`) for the default, or a nested per-project dir
    // (`codexProjectHome`) for an override. The trident loop threads the GLOBAL
    // CODEX_HOME (the trident-wide default); `ensureMaterialized` self-heals the
    // global file if a stored credential exists but the on-disk auth.json is
    // missing (fresh process / wiped tmp).
    const codexHome = resolveCodexHome({ owner_home })
    const codexCredentialService = new CodexCredentialService({
      store: projectCredentialStore,
      codexHome,
    })
    try {
      codexCredentialService.ensureMaterialized(project_slug)
    } catch (err) {
      console.warn(`[codex] ensureMaterialized failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    const coresSubstrate =
      llmPool !== null ? makeEphemeralSubstrate('cc-cores')(owner_home) : null
    const coresWiring = await mountOpenCores({
      projectDb: db,
      owner_home,
      project_slug,
      secretsStore,
      projectCredentialStore,
      env,
      substrate: coresSubstrate,
      // Settings Core (M1) — build the Open agent-profile backend at the
      // composition root and inject it (L3 DAG cut: the gateway core no longer
      // imports `open/`). When `update_agent_name` / `update_personality`
      // rewrites SOUL.md, `onProfileChange` drops the persona-loader cache entry
      // so the change is spliced into the system prompt on the very next turn
      // (the atomic write also bumps mtime as a backstop). Same loader instance
      // the live agent turns read through.
      agentSettingsProfile: buildOpenAgentProfileBackend({
        owner_home,
        env,
        onProfileChange: () => personaLoader.invalidate('SOUL.md'),
      }),
    })
    realmodeCleanups.push(() => {
      coresWiring.cleanup()
    })
    console.info(
      `[open] cores composed: oauth_configured=${coresWiring.oauthConfigured} (Calendar/Email/Google ${
        coresWiring.oauthConfigured ? 'live-cred-capable' : 'in-memory until Google OAuth connected'
      })`,
    )

    const phaseSpecResolver = await buildPhaseSpecResolver({
      substrate: llmCallSubstrate,
      env,
      internal_handle,
      log_slug: project_slug,
      owner_data_dir: owner_home,
      personaLoader,
      // Make the first conversational turn AWAIT the pre-warm (bounded) so a cold
      // CC spawn never times out into the static fallback (2026-06-18). Resolves
      // on real readiness or the cap, whichever first; never rejects.
      ...(prewarmReady !== null
        ? {
            awaitReady: (): Promise<void> => awaitPrewarmReady(prewarmReady, env),
            // Elevate the budget for EVERY dispatch in the cold window, not just the
            // first (round 2): the live owner-signup raced the first two turns and
            // both timed out at 12 s. Once the pre-warm settles, turns go snappy.
            isWarmReady: (): boolean => prewarmSettledRef.settled,
          }
        : {}),
      // Belt to awaitReady's suspenders (2026-06-18 cold-start fix): give cold-window
      // conversational dispatches a cold-spawn-sized budget so they can't degrade to
      // static merely because the warm session is still spawning when the owner
      // answers the first question(s). Once warm, turns stay snappy at the 12s tier.
      first_call_timeout_ms: readFirstConversationalTimeoutMs(env),
    })

    // ── ONE warm LLM path for the onboarding suggesters / picker / router ──
    // The owner's live dogfood surfaced the root-cause bug class: the
    // personality/name character suggesters + the wow-moment picker + the
    // per-project opening composer were built (in the engine + realmode
    // helpers) but NEVER wired into the Open composer, so every dispatch fell
    // through to the deterministic fallback (the generic "sharp engineering
    // sidekick / chill thinking partner" flavors, the "Per-project background
    // analysis for <X>" overnight items, the same "want me to dig into…"
    // opener on every project). The server log said it plainly:
    //   [build-wow-dispatcher] WARNING: pickerLlm not configured …
    //
    // Architectural fix (owner-stated): there is ONE LLM path. Every
    // LLM-driven onboarding hook routes through the SAME warm `cc-llm`
    // interview session (`llmCallSubstrate`) that drives the phase-spec
    // rephrasing of the main onboarding chat — NOT a separate client slot
    // that can silently go unconfigured. `buildGatewayAnthropicMessagesClient`
    // wraps that one warm substrate into the `AnthropicMessagesClient` shape
    // the suggesters / router / opening composer consume; `buildAnthropicLlmCall`
    // wraps the SAME substrate into the `LlmCallFn` the wow picker consumes.
    // Because the session ACCUMULATES the onboarding so far, the suggesters
    // get the user's synthesized context for free → genuinely personalized
    // character picks instead of generic flavors. When LLM-less (no
    // credentials), every hook stays undefined and the engine walks its
    // deterministic fallbacks exactly as before.
    const onboardingAnthropicClient =
      llmCallSubstrate !== null
        ? buildGatewayAnthropicMessagesClient({ substrate: llmCallSubstrate })
        : null

    const personalityCharacterSuggester =
      onboardingAnthropicClient !== null
        ? buildPersonalityCharacterSuggester({ anthropicClient: onboardingAnthropicClient })
        : undefined
    // 2026-07-01 (DROP the agent-NAME step): Neutron Open onboarding never asks
    // the owner to name the orchestrator, so the agent-name suggester is no
    // longer wired here. The `agent-name-suggester.ts` MODULE stays in the tree
    // (Managed repurposes it as a personal-URL suggester); only Open's onboarding
    // wiring is removed.
    const personaSummarizer =
      onboardingAnthropicClient !== null
        ? buildPersonaSummarizer({ anthropicClient: onboardingAnthropicClient })
        : undefined
    // Per-project opening message (Item 11) — consumed by the default-built
    // onboarding handoff inside `buildLandingStack` to compose a custom,
    // synthesis-grounded opener per project instead of the generic template.
    const projectOpeningComposer =
      onboardingAnthropicClient !== null
        ? buildProjectOpeningMessageComposer({ anthropicClient: onboardingAnthropicClient })
        : undefined

    // WAVE 2 Track A — per-project persona resolver. Reads the canonical
    // `projects.persona` label (the same column the settings drawer + onboarding
    // write) for a project topic so each project topic's dedicated warm CC
    // session adopts ITS persona on top of the owner-wide SOUL/USER doctrine.
    // A closure over `db` (NOT a captured value), re-run per first-turn so a
    // persona edited mid-session lands on the next cold topic. Best-effort: a
    // transient SQLite error degrades to the owner-wide persona alone.
    const projectPersonaResolver = buildProjectPersonaResolver(db)

    // ── Single-owner session + first-prompt-on-connect ─────────────────────
    // The cookie secret is the single shared HMAC secret for both the session
    // cookie AND the local start-token. open/server.ts guarantees it is set
    // (it generates an ephemeral one when unset), but default defensively so
    // the composer never throws on a missing secret.
    const cookieSecret =
      env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] ?? `open-ephemeral-${internal_handle}`
    const startTokenAuth = buildLocalStartTokenAuth(cookieSecret)

    // S0 security quick-patch (b) — per-boot app-ws token. The React client's
    // historical default bearer was the guessable public constant `dev:<owner>`
    // (chat-react/config.ts), so any web page the owner visited could open
    // `ws://127.0.0.1:7800/ws/app/chat?token=dev:owner`. Mint a fresh random
    // token EACH BOOT, inject it into the served page bootstrap
    // (`window.__neutron_app_ws_token`, owner-gate), and require it on the WS
    // upgrade for any browser-origin connection (app-ws-surface). A token from a
    // previous boot no longer matches, so it can never re-authenticate. Native
    // clients (Expo/CLI — no Origin header) are exempt and keep the localhost-
    // trust bearer path. This is the S0 quick-patch; S1 replaces it with a
    // per-INSTALL credential required on every /api/app/* surface.
    const appWsToken = `nbt_${randomBytes(24).toString('base64url')}`

    // FIX 2 (P2 follow-up to #84) — ONE shared single-use store for start-token
    // JTIs. With the legacy `/ws/chat` onboarding socket deleted, the start
    // token is now consumed ONLY at the HTTP `/chat?start=` cookie-mint gate
    // (`openFetch` below); nothing claimed its JTI, so a leaked `?start=` URL
    // could re-mint the owner cookie repeatedly within its 15-min TTL. This
    // store is threaded into BOTH `buildLandingStack` (so any bridge-side claim
    // shares the same namespace) AND the HTTP gate, where the JTI is claimed
    // before the cookie is minted — making a given token single-use again.
    const consumedTokens = new InMemoryConsumedTokens()

    // The LocalPlatformAdapter is the single-owner platform seam. We attach
    // the local start-token verify/claim so the chat-bridge's startSession
    // path (engine.start → first onboarding prompt) accepts our minted token
    // and rejects everything else.
    const baseAdapter = buildLocalPlatformAdapter({
      selfOwner: instanceInfo,
      publicRoot: env['NEUTRON_REPO_ROOT'] ?? process.cwd(),
    })
    const platform: PlatformAdapter = {
      ...baseAdapter,
      verifyStartToken: startTokenAuth.verifyStartToken,
      claimStartTokenJti: startTokenAuth.claimStartTokenJti,
      capabilities: { ...baseAdapter.capabilities, start_token_verify: true },
    }

    // Cookie → owner identity. Returns null for any cookie not signed for
    // THIS instance's slug, so a stale / cross-instance cookie is ignored.
    const cookieToUserClaim = async (
      req: Request,
    ): Promise<{ project_slug: string; user_id: string } | null> => {
      const slug = readSessionCookie(req, cookieSecret, Date.now())
      if (slug === null || slug !== project_slug) return null
      return { project_slug, user_id: OWNER_USER_ID }
    }

    // Chat-command filter (Free Cores `/cal`/`/email`/`/note`/`/remind`/
    // `/research` + skill-forge `/skills`), chained. Defined ONCE here so BOTH
    // the web onboarding chat AND the app-ws chat (`/ws/app/chat`) route slash
    // commands through the IDENTICAL handlers (Codex r1 [P2] — without this the
    // React app-ws path lost slash commands, sending `/note` etc. to the LLM).
    const chatCommandFilter = buildChainedChatCommandFilter([
      coresWiring.chatCommandFilter,
      buildSkillForgeChatCommandFilter(skillForgeBackend),
    ])

    // ── The landing stack (onboarding engine + chat UI + WS) ───────────────
    // Onboarding consolidation (2026-06-26) — late-bound app-socket routers.
    // The engine's button-prompt + import-progress senders are fixed at
    // construction (inside buildLandingStack), but the app-ws registry/adapter
    // are built AFTER. These mutable holders let the SAME engine route
    // onboarding emits over the unified `/ws/app/chat` socket: the routed sender
    // reads `.send` at call time; we fill it once the registry exists (below).
    // This is what makes onboarding a MODE of the single chat — one socket, no
    // second engine, no flag.
    const appWsButtonPromptRouter: AppSocketButtonPromptRouter = {}
    const appWsImportProgressRouter: AppSocketImportProgressRouter = {}
    // AUTH-CORRECTION (2026-06-28) — Claude-Max OAuth install-token handoff.
    // The DEFAULT first-screen auth path: when the box has no token AND no
    // Keychain login (so `resolveOpenLlmPool` returns null and `chatAuthGate`
    // gates `/chat`), the gate page drives this handler — a copy-paste one-liner
    // that captures the owner's `sk-ant-oat…` token and POSTs it back here.
    // `/complete` persists it to `.env` then exits so the supervisor respawns
    // with a LIVE substrate (the composer resolves creds once at boot). The
    // Keychain fast-path (#101) stays ABOVE this — when present, the gate never
    // renders and this handler is never reached.
    const installTokenHandler = options.installTokenHandler ?? buildOpenInstallTokenHandler({
      persistToken: (token) => persistOauthTokenToEnv(token),
      requestRestart: () => requestSupervisorRestart(),
    }).handle
    // ── The landing stack (C3b: carved to open/wiring/landing.ts) ──────────
    // The `buildLandingStack({...})` call — the onboarding InterviewEngine + chat
    // UI + WS surface — moves into `wireLandingStack(ctx, deps)`. Fields already
    // on the narrow wiring context (`db` / `project_slug` / `owner_home` /
    // `internal_handle` / `env`) come from `wiringCtx`; the ~20 composed locals
    // (the late-bound routers, install-token handler, onboarding LLM hooks, the
    // synthesis import substrate, the shared GBrain sync hook) thread through the
    // typed `deps` bag. `importUseSynthesis: true` and the per-request
    // `chatAuthGate` (via `resolveOpenLlmPool` + live `env`) are preserved
    // verbatim inside the wiring module. The returned `landing` is consumed
    // downstream via `landing.*` exactly as today.
    const { landing } = wireLandingStack(wiringCtx, {
      installTokenHandler,
      appWsButtonPromptRouter,
      appWsImportProgressRouter,
      static_dir,
      platform,
      cookieToUserClaim,
      resolveOpenLlmPool,
      phaseSpecResolver,
      personalityCharacterSuggester,
      personaSummarizer,
      projectOpeningComposer,
      importSubstrate,
      gbrainSyncHook,
    })

    // ── Import-upload surface (P2 v2 § 6.1 S4 + Upload Resume Phase 2) ──────
    // Mirror the production composer's upload wiring against the Open
    // single-owner InterviewEngine. `buildLandingStack` returns the engine it
    // drives (`landing.engine`); the import handlers bridge
    // `engine.notifyImportUpload(...)` so a Claude/ChatGPT export upload
    // advances the owner OUT of `import_upload_pending` without a follow-up
    // tap — identical to the per-instance managed path. BEFORE this wiring the
    // Open composer never set these handlers, so the import-upload surface was
    // unmounted and `POST /api/upload/<source>/start` 404'd → import was
    // impossible during a self-hosted onboarding.
    // (`realmodeCleanups` is declared earlier — the scribe GBrain child
    // registers its close hook there before `buildLandingStack` runs.)
    // Path 1 — the upload handler still drives the engine's import pipeline
    // (synthesis + cron write the project DOCUMENTS), but Path 1 has no accept
    // BUTTON: when the import lands at `import_analysis_presented` an
    // import-completion watcher transitions the row back to the conversational
    // marker so the live session continues + the post-turn extractor can finish
    // onboarding (which materializes the imported projects). The watcher is
    // late-bound (it needs onboarding state wired further below) via this holder.
    // The Path-1 late-bound `importWatchHolder` stays COMPOSER-OWNED: its
    // `.watch` setter lives deep below (post-onboarding wiring), far from this
    // carve, so the composer creates the holder here and threads it into
    // `wireUploads` as the READER — both close over the SAME reference. (NOT a
    // `late<T>` seam — that is C3d's job.)
    const importWatchHolder: { watch?: (user_id: string) => void } = {}
    // Single-owner POSIX identity — the process uid/gid the owner runs as.
    const uploadUid = process.getuid?.() ?? 0
    const uploadGid = process.getgid?.() ?? 0
    const {
      import_upload_handler,
      chunked_upload_handler,
      import_resume_handler,
      cleanups: uploadCleanups,
    } = await wireUploads(wiringCtx, {
      landing,
      uploadUid,
      uploadGid,
      importWatchHolder,
    })
    // The sweeper `stop()` hook collected into `wireUploads`'s `cleanups` is
    // re-registered HERE, at the carve site, so it lands at the SAME point in the
    // cleanup sequence (the sweeper `start()`→`push(stop)` previously ran inline).
    for (const cleanup of uploadCleanups) realmodeCleanups.push(cleanup)

    // ── Single-owner owner gate (C3c: carved to open/wiring/owner-gate.ts) ──
    // The cookie-mint / one-shot start-token / auth funnel that wraps the
    // landing `fetch` — `coldStartRedirect`, `hasResumableState`, the React-shell
    // bootstrap HTML injection, and the `openFetch` gate itself — moves into
    // `buildOpenOwnerGate(ctx, deps)`. It reads the composer-owned rail-row
    // reader `readProjectRows` (defined below, ALSO consumed by the live
    // `projects_changed` emit + topic rail) as a threaded dep, so the
    // `buildOpenOwnerGate` call is issued AFTER `readProjectRows` is in scope.
    // The returned `openFetch` is consumed downstream (`landing_server.fetch`)
    // verbatim.

    // P1b — React shell project bootstrap. `chat-react/config.ts` reads the
    // owner's project list + active project from `window.__neutron_projects` /
    // `window.__neutron_active_project_id`; nothing set them, so the React
    // ProjectShell had `projectId === null` forever and never fetched
    // `/api/app/projects/<id>/tabs` — the Documents/Tasks tabs stayed hidden even
    // with their backends mounted (Codex r1). Inject the canonical project list
    // (from the `projects` table — the source of truth onboarding writes) into
    // the served `/chat` HTML so the shell opens on a real project with its tabs.
    // The canonical project list (id + label) from the `projects` table — the
    // source of truth onboarding writes. Shared by the page-load bootstrap
    // injection AND the live `projects_changed` app-ws emit (FIX 1) so both
    // surface the IDENTICAL shape/order. Best-effort: a transient read failure
    // degrades to an empty list rather than sinking the request.
    // Per-project unread = agent messages on the project's chat topic
    // (`app:<user>:<project>`) beyond the owner's highest READ receipt seq.
    // Honest (derived from the real chat log + receipt cursor), best-effort
    // (a read failure — e.g. chat tables absent in a minimal DB — degrades to
    // 0 rather than sinking the rail refresh).
    const readProjectUnread = (project_id: string): number => {
      const topic = appWsProjectTopicId(OWNER_USER_ID, project_id)
      try {
        const row = db
          .prepare<{ n: number }, [string, string]>(
            `SELECT COUNT(*) AS n
               FROM app_chat_messages m
              WHERE m.topic_id = ?
                AND m.role = 'agent'
                AND m.seq > (
                  SELECT COALESCE(MAX(r.seq), 0)
                    FROM app_chat_receipts r
                   WHERE r.topic_id = ? AND r.read_at IS NOT NULL
                )`,
          )
          .get(topic, topic)
        return row?.n ?? 0
      } catch {
        return 0
      }
    }
    // M1 UX REDESIGN — the set of projects with a LIVE chat turn in progress.
    // Maintained at the `agent_typing` start/end seam (the same boundary that
    // drives the typing dots), so the rail's `working` state reflects an
    // in-flight chat turn without a second bookkeeping path. General turns (no
    // project_id) are keyed under the General sentinel so its row can also read
    // `working`. Best-effort in-memory — a lost `end` self-heals on the next turn.
    const activeChatProjects = new Set<string>()
    const GENERAL_RAIL_KEY = '__general__'
    const railChatKey = (project_id?: string): string =>
      project_id !== undefined && project_id.length > 0 ? project_id : GENERAL_RAIL_KEY
    // M1 UX REDESIGN — the rail-redesign per-project derived fields
    // (`activity` / `preview` / `preview_from` / `live_runs`). Pure derivation in
    // `open/project-rail.ts`; here we only COLLECT the signals from the project's
    // Work-Board items + their bound runs + its live chat turn + its last chat
    // message. Best-effort: any read failure degrades that project to idle / no
    // preview rather than sinking the whole rail refresh.
    const readProjectRailExtras = (
      project_id: string,
    ): {
      activity: ProjectActivity
      preview: string | null
      preview_from: PreviewFrom
      live_runs: number
    } => {
      let liveRunCount = 0
      let hasInlineActive = false
      let hasFailedNotDone = false
      let hasStalledLiveRun = false
      try {
        const scopeKey = workBoardScopeKey(project_slug, project_id)
        const nowMs = Date.now()
        for (const item of workBoardStore.list(scopeKey)) {
          if (item.inline_active) hasInlineActive = true
          const runId = item.linked_run_id
          if (runId === null || runId.length === 0) continue
          const run = boardRunStore.get(runId)
          if (run === null) continue
          if (isTerminalPhase(run.phase)) {
            // A still-bound terminal run: `failed` on a not-done item = attention
            // (the brief pre-reconcile window; a `done` run just completes it).
            if (run.phase === 'failed' && item.status !== 'done') hasFailedNotDone = true
            continue
          }
          // Live (non-terminal) bound run.
          liveRunCount++
          if (deriveRunProgress(run, nowMs).stalled) hasStalledLiveRun = true
        }
        // Durable failure signal — a failed build is detached from its item on
        // terminal reconcile, so the bound-item check above only catches the brief
        // pre-reconcile window. The run ROW persists: if this scope's MOST RECENT
        // run is `failed` (not yet superseded by a fresh live/done run) AND the
        // project still has an actionable (not-done) item, keep surfacing
        // `attention` (Codex review [P2]).
        if (!hasFailedNotDone) {
          const latest = boardRunStore.latestByProjectScope(scopeKey)
          if (latest !== null && latest.phase === 'failed') {
            const hasOpenItem = workBoardStore
              .list(scopeKey)
              .some((it) => it.status !== 'done')
            if (hasOpenItem) hasFailedNotDone = true
          }
        }
      } catch {
        // Board/run read failure → treat as no board signal (idle unless chat).
      }
      const activity = deriveProjectActivity({
        chatTurnInProgress: activeChatProjects.has(railChatKey(project_id)),
        liveRunCount,
        hasInlineActive,
        hasFailedNotDone,
        hasStalledLiveRun,
      })
      // Preview = the project's last chat message, markdown-stripped + truncated.
      let preview: string | null = null
      let preview_from: PreviewFrom = null
      try {
        const topic = appWsProjectTopicId(OWNER_USER_ID, project_id)
        const last = db
          .prepare<{ role: 'user' | 'agent'; body: string }, [string]>(
            `SELECT role, body FROM app_chat_messages
              WHERE topic_id = ? ORDER BY seq DESC LIMIT 1`,
          )
          .get(topic)
        if (last !== null) {
          preview = truncatePreview(last.body)
          if (preview !== null) preview_from = last.role
        }
      } catch {
        // No chat tables / read error → no preview line.
      }
      return { activity, preview, preview_from, live_runs: liveRunCount }
    }
    // The rail row shape shared by the page bootstrap injection AND the live
    // `projects_changed` app-ws emit — id + label + the rail-redesign fields
    // (emoji / unread / activity / preview / live_runs). Ordered
    // most-recent-activity-first so an active project floats to the top; a legacy
    // row with a NULL activity key falls back to updated_at (COALESCE).
    const readProjectRows = (): {
      id: string
      label: string
      emoji: string
      unread: number
      last_activity_at: string
      activity: ProjectActivity
      preview: string | null
      preview_from: PreviewFrom
      live_runs: number
    }[] => {
      try {
        return db
          .prepare<
            { id: string; name: string; emoji: string | null; last_activity_at: string | null; updated_at: string },
            []
          >(
            `SELECT id, name, emoji, last_activity_at, updated_at
               FROM projects
              WHERE deleted_at IS NULL
              ORDER BY COALESCE(last_activity_at, updated_at) DESC, id ASC`,
          )
          .all()
          .map((r) => ({
            id: r.id,
            label: r.name,
            emoji: resolveProjectEmoji(r.emoji, r.name),
            unread: readProjectUnread(r.id),
            last_activity_at: r.last_activity_at ?? r.updated_at,
            ...readProjectRailExtras(r.id),
          }))
      } catch {
        return []
      }
    }
    // ── The owner gate (C3c: carved to open/wiring/owner-gate.ts) ──────────
    // `coldStartRedirect` / `hasResumableState` / the React-shell bootstrap HTML
    // injection (`projectsBootstrapScript` / `onboardingBootstrapScript` /
    // `claimBootstrapScript` / `withReactBootstrap`) / `claimStartToken` / the
    // `openFetch` gate all move into `buildOpenOwnerGate(ctx, deps)`. The
    // security semantics (single-use `?start=` JTI claimed BEFORE the cookie is
    // minted, cookie-mint-only-on-first-claim, fail-toward-cold-start on a
    // stale-cookie/wiped-DB read, the exact `/chat-react.js` tag replace) are
    // preserved verbatim inside the wiring module, and the TWO byte-identical
    // claim-then-mint blocks are converged onto one shared helper there. The
    // composer-owned `readProjectRows` (also driving the live `projects_changed`
    // emit + topic rail) is threaded in as the bootstrap-injection reader.
    // C5b — take the unified `HttpGate` view of the owner gate (`gate`) instead
    // of wiring `openFetch` as `landing_server.fetch`. Open now flows through
    // the SAME `composition.auth_gate` seam as Managed: the gate is supplied as
    // `auth_gate` below and `landing_server.fetch` points at the RAW landing
    // surface. Behavior is unchanged — the gate routes `/chat` + SPA deep links
    // to the (verbatim) `openFetch` and everything else to the ladder.
    const { gate: openOwnerGate } = buildOpenOwnerGate(wiringCtx, {
      cookieSecret,
      startTokenAuth,
      consumedTokens,
      landing,
      readProjectRows,
      appWsToken,
    })

    // ── Sidebar topic-rail surface (`GET /api/v1/chat/topics`) ─────────────
    // THE BUG (Ryan, dogfooding): the Open composer never mounted a topics
    // surface, so the chat client's sidebar fetch 404'd → empty sidebar even
    // though onboarding had created N projects in the `projects` table. The
    // Managed surface lists topics from `button_prompts` (chat history) only,
    // which brand-new project topics don't have yet. The Open-native surface
    // lists projects DIRECTLY from the canonical `projects` table (the source
    // of truth onboarding writes) and merges in chat metadata where present.
    const chat_topics_surface = createOpenChatTopicsSurface({
      db,
      buttonStore: landing.buttonStore,
      resolveUserClaim: cookieToUserClaim,
      project_slug,
    })

    // ── Chat-history hydration surface (`GET /api/v1/chat/history`) ─────────
    // THE BUG (Ryan, dogfooding 2026-06-20): the Open composer mounted the
    // topic-rail surface but NEVER mounted the history surface, so the chat
    // client's `hydrateInitialHistory` fetch 404'd → `history-hydrate-failed
    // status=404 — falling back to live-WS-only`. Result: General reloaded
    // EMPTY and a project switch showed only the single live WS re-emit, even
    // though `button_prompts` held the full conversation. The handler + tests
    // existed; only the Open-composer wiring was missing (the carve dropped
    // it). Mirror the topics surface: same per-instance buttonStore + the
    // same `cookieToUserClaim` the WS upgrade uses + this instance's
    // project_slug (defense-in-depth instance binding).
    const chat_history_surface = createChatHistorySurface({
      store: landing.buttonStore,
      resolveUserClaim: cookieToUserClaim,
      project_slug,
    })

    // ── Reminders fire-time dispatcher ─────────────────────────────────────
    // THE BUG (audit P0-2, daily-driver gap): `reminders/tick.ts` fired due
    // rows on schedule but the Open composer passed a NO-OP dispatcher
    // (`{ dispatch: async () => undefined }`), so a scheduled reminder
    // advanced its row and posted NOTHING — reminders could not actually
    // fire in Open. Wire the real dispatcher (ported from Vajra's
    // `reminder-agent-base.md` + `reminder-patterns.md`):
    //   • compose — at fire time the warm conversational substrate
    //     (`liveAgentSubstrate`, the SAME CC-spawn REPL the live chat uses —
    //     NEVER a direct api.anthropic.com call) composes a context-aware
    //     nudge from the stored `message` shape (literal / smart-wrap /
    //     pattern). When LLM-less, every reminder degrades to its literal
    //     body so a fired reminder ALWAYS delivers something real.
    //   • context — the project's STATUS.md under `<owner_home>/Projects/`.
    //   • post — the composed body lands in the originating chat topic via
    //     the SAME `ButtonStore` + `WebChatSenderRegistry` the live-agent
    //     reply path uses (durable history row + best-effort live push).
    // The engine stores a reminder's destination as the raw `project_id` (or
    // null for instance-level reminders). Open's web chat routes on synthetic
    // `web:<user_id>` (General) / `web:<user_id>:<project_id>` (project) keys —
    // the SAME keys `chat-topics-surface` lists and the WS registry binds
    // per-socket senders on. Bridge the two so a fired reminder lands on a
    // topic a client actually subscribes to (else it writes history + live-
    // pushes to a key nobody reads). Also forward an already-web-shaped topic
    // and unwrap the Expo app's `app-project:<id>` form.
    // ── Live-delivery: fired reminders + briefs go to the app-ws client ────────
    // THE BUG (M1 E2E 2026-06-28, verified on an isolated instance): fired
    // reminders (and the proactive morning brief) are timer-driven AGENT
    // MESSAGES, but they were delivered over the LEGACY `web:` chat registry
    // (`landing.registry`) on the `web:<user>` topic. The ONLY client — the
    // React/Expo app — connects to `/ws/app/chat` and binds its live sender in
    // `appWsRegistry` under `app:<user>` (`app-ws-surface.ts` `appWsTopicId`).
    // So a fired reminder hit the durable history but was NEVER pushed to the
    // connected client (`registry.send('web:<user>', …)` matches no sender),
    // while a steady-state live-agent reply — delivered via `buildAppWsSendReply`
    // → `appWsRegistry` on `app:<user>` — paints instantly. Net: you set a
    // reminder, it fires, and nothing appears in your chat until you reload.
    // (Proven: a steady-state reply reached the socket live; a fired reminder
    // did not; the reminder durable row landed under `web:<owner>` while the
    // reply's landed under `app:<owner>`.) This is the "app: vs web: live-push
    // parity" follow-up the earlier wiring flagged as deferred.
    //
    // THE FIX: deliver reminders + briefs the SAME way the agent delivers its
    // own replies. `appWsAgentPushRegistry` is a thin `WebChatSenderRegistry`-
    // shaped bridge that forwards each agent_message to `buildAppWsSendReply`
    // (the exact steady-state reply path → `appWsHolder.adapter.send` →
    // `appWsRegistry`). It forward-references `buildAppWsSendReply` / `appWsRegistry`
    // (defined below); both are touched only at FIRE time (tick loop / brief
    // cron), long after boot wires the adapter — never during composition. The
    // durable `button_prompts` row now lands under the SAME `app:<user>` topic
    // agent replies use, carrying its `prompt_id` into the live frame so a later
    // hydration de-dupes cleanly. NO feature flag.
    const appWsAgentPushRegistry = {
      register: (): void => {},
      unregister: (): void => {},
      has: (topic_id: string): boolean => appWsRegistry.has(topic_id),
      send: (topic_id: string, event: ChatOutbound): boolean => {
        buildAppWsSendReply(topic_id)(event)
        return true
      },
    }
    // Resolve every fired reminder/brief to the app-ws topic the client binds:
    // the owner's BARE `app:<user>`.
    //
    // THE BUG (M1 E2E Round 2, 2026-06-29 — the residual #105 missed): the app-ws
    // client opens ONE `/ws/app/chat` socket and registers its live sender +
    // replays history on the BARE `app:<user>` topic only (`app-ws-surface.ts`
    // registers `appWsTopicId(user_id)`; `config.topicId = appWsTopicId(userId)`);
    // project context is a per-FRAME field, NOT a topic suffix. This differs from
    // the LEGACY web path, which bound a per-socket sender on
    // `web:<user>:<project>` — and #105 ported that suffixing pattern here,
    // mapping a project reminder (`app-project:<id>`) to `app:<user>:<id>`. But
    // NO sender is ever registered on that suffixed topic, so the live push
    // matches nothing (`registry.send` → false, dropped), AND the durable
    // `button_prompts` row lands under a topic the client NEVER replays (it only
    // ever hydrates the bare `app:<user>`) — so a project-scoped reminder VANISHES
    // entirely, live and on reload. (General reminders — `explicit_topic` null →
    // bare topic — are the only case #105's test exercised, which is why this
    // slipped through.)
    //
    // THE FIX: deliver ALL fired reminders/briefs to the owner's bare
    // `app:<user>` topic — exactly the general-reminder path #105 made work and
    // the one topic the client actually binds + hydrates. Project GROUPING is
    // unaffected: it lives on the reminder row's stored `topic_id`
    // (`app-project:<id>`) which the reminders tab filters on (`store.listBy*`)
    // and `deriveReminderProjectId` keys context/metering off — neither reads
    // this delivery topic. The fired message simply surfaces in the owner's chat,
    // the single surface the app reads, instead of silently disappearing.
    const reminderGeneralTopic = appWsTopicId(OWNER_USER_ID)
    const resolveAppWsReminderTopic = (_explicit_topic: string | null): string =>
      reminderGeneralTopic
    const reminder_dispatcher = buildReminderDispatcher({
      outbound: buildButtonStoreReminderOutbound({
        buttonStore: landing.buttonStore,
        registry: appWsAgentPushRegistry,
      }),
      ...(liveAgentSubstrate !== null
        ? { llm: buildSubstrateReminderLlm(liveAgentSubstrate) }
        : {}),
      context: buildStatusMdContextSource({ owner_home }),
      resolveTopicId: ({ explicit_topic }): string => resolveAppWsReminderTopic(explicit_topic),
    })

    // ── P1-4 — proactive messaging ACTIVATION (morning brief + idle nudge) ──
    // The proactive modules (`gateway/proactive/*`) were built + tested but
    // DEAD: they register only when `tasks.proactive` is set, and the Open
    // composer never set it. Wire it now so the daily brief + idle-nudge sweep
    // ship ON (no feature flag). Both post through the production ChannelRouter
    // (resolved post-boot inside `build-core-modules`), reuse the shared cron
    // registry, and route LLM work through the SAME warm `cc-llm` substrate the
    // nudge engine / wow picker use (`buildAnthropicLlmCall`).
    const proactiveLlm =
      llmCallSubstrate !== null
        ? buildAnthropicLlmCall({ substrate: llmCallSubstrate })
        : null
    // The brief posts to the General topic on the SAME app-ws delivery path
    // fired reminders now use (`reminderGeneralTopic = appWsTopicId(OWNER_USER_ID)`
    // + `appWsAgentPushRegistry`, just above): persist a durable history row
    // under `app:<user>` + live-push through the app-ws session registry so a
    // connected client paints the brief immediately (the previous `web:` +
    // `landing.registry` path reached no app-ws client — same live-delivery bug
    // as reminders, now fixed for both). The durable row is the guarantee (read
    // on the next hydration); the live push reaches the owner's open socket.
    const proactiveGeneralTopic = appWsTopicId(OWNER_USER_ID)
    const proactiveSink = buildButtonStoreProactiveSink({
      buttonStore: landing.buttonStore,
      registry: appWsAgentPushRegistry,
    })
    // Detect the host's LOCAL timezone (Ryan: "Detect local computer time not
    // hardcode pt"). Without this the morning brief fell back to the proactive
    // module's hardcoded `America/Los_Angeles`, so a non-Pacific owner got the
    // daily brief (and its tz-derived day/wording) at the wrong local hour.
    // `resolveLocalTimezone` is the single source: `process.env.TZ` override →
    // the runtime's resolved zone → a defensive floor. Threaded into the brief
    // scheduler below; never hardcode a zone per-call.
    const localTimezone = resolveLocalTimezone({ env })
    const tasksConfig: NonNullable<CompositionInput['tasks']> = {
      proactive: {
        // Morning brief — ACTIVE. Posts the daily brief to the owner's General
        // topic through the durable web sink, computed for the host's local
        // timezone (`localTimezone`) rather than a hardcoded Pacific default.
        sink: proactiveSink,
        resolveGeneralTopic: (): string => proactiveGeneralTopic,
        timezone: localTimezone,
        // Idle-nudge SWEEP — DELIBERATELY NOT auto-enabled here (no
        // `listIdleTopics`), so the sweep cron does not register. The sweep
        // CODE + the ≥7 dual-rating quality gate (`rateNudge`) are complete and
        // unit-tested; what is NOT yet a clean seam is a CORRECT production
        // enumeration, which needs (1) BOTH the `web:<owner>` (React web) AND
        // `app:<owner>` (Expo app-ws) topic namespaces — `ButtonStore.list-
        // TopicsByUser` is single-prefix — and (2) a USER-TURN-ONLY activity
        // watermark for dedupe: `last_created_at` counts agent rows (incl. the
        // nudge's own durable row), so the sweep would see its own post as
        // "the user returned" and re-nudge every idle cycle (Codex P1/P2,
        // 2026-06-27). Enabling it on the agent-polluted, web-only watermark
        // would mis-target + spam — worse than deferring. The `rateNudge` gate
        // is still supplied so the sweep enforces ≥7 the moment a correct
        // `listIdleTopics` lands. See docs/research/AS-BUILT-archive-2026-07.md
        // for the follow-up.
        ...(proactiveLlm !== null
          ? {
              // LLM brief over real sources (Vajra parity) + the dual-rating
              // ≥7 nudge quality gate (ready for the sweep). Degrade safely.
              composeBrief: buildLlmBriefComposer(proactiveLlm),
              rateNudge: buildLlmNudgeRater(proactiveLlm),
            }
          : {}),
      },
    }

    // P1b — single-owner localhost-trust auth resolver (Path A, Ryan-locked
    // 2026-06-26). The owner is the sole user, the server binds 127.0.0.1, and
    // the HTTP layer already authenticates them via the start-token/cookie, so
    // the app-bearer (`dev:<owner_user_id>`, the chat-react client's default
    // token) is accepted directly — no cryptographic mint needed for a
    // single-owner box. Managed layers its own auth as the thin wrapper.
    // ONE resolver feeds BOTH the per-project docs surface AND the cores
    // integrations/api-keys surface (no flag, single code path).
    //
    // Codex r1 [P1] HARDENING: the bare dev-bypass resolver accepts ANY
    // `dev:<user_id>` (or raw user id), which would let `Bearer dev:anyone`
    // read project docs or rotate API keys. Single-owner Open has exactly ONE
    // legitimate identity — the owner — so wrap the resolver to REJECT any
    // resolved user_id that isn't `OWNER_USER_ID`. This keeps Path A's
    // localhost-trust ergonomics (the React client's default `dev:<owner>`
    // bearer still works) while closing the arbitrary-bearer hole. (A box bound
    // to a non-loopback `NEUTRON_HOST` is still trusting the owner-id constant
    // by design — that is the operator's Path A choice — but no OTHER identity
    // is ever accepted.)
    const appOwnerAuth: AppWsAuthResolver = ((): AppWsAuthResolver => {
      const base = createAppWsAuthResolver({ project_slug, bypass: true })
      return {
        mode: base.mode,
        resolve: async (token) => {
          // S0 (b) — the per-boot app-ws token resolves directly to the owner.
          // This is the credential the web client now presents (injected into
          // the page bootstrap); the WS upgrade already constant-time-checked it
          // for browser origins, but the resolver must ALSO map it to the owner
          // identity so both the WS and the /api/app/* bearer path accept it.
          if (constantTimeEqual(token, appWsToken)) {
            return { user_id: OWNER_USER_ID, project_slug, mode: base.mode as 'dev-bypass' }
          }
          const resolved = await base.resolve(token)
          if ('code' in resolved) return resolved
          if (resolved.user_id !== OWNER_USER_ID) {
            return {
              code: 'project_mismatch',
              message: 'single-owner Open: only the owner bearer is accepted',
            }
          }
          return resolved
        },
      }
    })()

    // P1b — per-project Documents backend. The chat-react Documents tab
    // (`landing/chat-react/docs-client.ts`) calls
    // `/api/app/projects/<id>/docs/*`; `createAppDocsSurface` serves it off the
    // real on-disk docs tree (`DocStore` → `<owner_home>/Projects/<id>/docs`),
    // which the project setup already populates. Mounted via
    // `composition.app_docs_surface` (gateway/composition.ts) → compose.ts route
    // chain. Previously unmounted in Open, so the tab 404'd.
    const docStore = new DocStore({ owner_home })
    const appDocsSurface = createAppDocsSurface({
      store: docStore,
      auth: appOwnerAuth,
      project_slug,
    })

    // P1b — app TABS resolver (`/api/app/projects/<id>/tabs` + `/api/app/tabs`).
    // The React `ProjectShell` fetches this BEFORE rendering non-chat tabs; when
    // it 404s the shell falls back to a Chat-only view and the Documents/Tasks
    // tabs stay HIDDEN even though `/docs/*` is mounted (Codex r1 [P2]). A
    // builtin-only surface (auth only) returns the per-project Chat/Documents/
    // Tasks + global Admin descriptors from `tabs/registry.ts`, so the Documents
    // tab actually renders. (Core-contributed project tabs would need
    // cores+installations; the builtins cover the parity gate.)
    const appTabsSurface = createAppTabsSurface({ auth: appOwnerAuth })

    // P1b — Tasks tab backend (`/api/app/projects/<id>/tasks*`) + chat upload
    // surface (`/api/app/upload`), the remaining app-API endpoints the React UI
    // calls. Codex r1 [P2]×2: the tabs resolver now SHOWS the Tasks tab and the
    // composer SHOWS the attachment button, so their backends must exist or those
    // controls 404. `new TaskStore(db)` reads the SAME canonical project task
    // data the agent's `cores/free/tasks` backend writes. Same owner auth.
    const appTasksSurface = createAppTasksSurface({ store: new TaskStore(db), auth: appOwnerAuth })
    const appUploadSurface = createAppUploadSurface({
      auth: appOwnerAuth,
      project_slug,
      owner_home,
    })

    // P1b — app-ws CHAT surface (`/ws/app/chat` + `/api/app/chat/send`), the
    // SINGLE chat transport the served React client uses
    // (`chat-react/config.ts` → `WebChatSession({url: /ws/app/chat})`). Both
    // onboarding (engine) and steady-state (live agent) turns flow through this
    // one surface — there is no second chat socket. An inbound app-ws user
    // message runs the onboarding engine while onboarding is active, else a real
    // `buildLiveAgentTurn`, and the reply fans back out over the app-ws registry.
    // Same Path A localhost-trust auth resolver as docs/admin. Single code path;
    // Managed layers its own auth as the wrapper.
    const appWsRegistry = new InMemoryAppWsSessionRegistry()

    // FIX 1 (P2 follow-up to #84) — live project-rail refresh. The served
    // `/chat` HTML injects the project list ONCE at page-load; a brand-new owner
    // bootstraps with NONE, and when onboarding CREATES projects in the SAME
    // session there was no signal to refresh — the Documents/Tasks/Admin tabs
    // only appeared after a manual reload. We snapshot the project set and, after
    // each onboarding turn, fan a `projects_changed` frame over the owner's
    // app-ws topic whenever the set changed. `lastProjectsSnapshot` starts null;
    // the FIRST observation (taken at session open, after the page already
    // bootstrapped with the then-current set) only seeds the baseline so we emit
    // on real CHANGES, never on the initial load.
    let lastProjectsSnapshot: string | null = null
    const buildProjectsChangedFrame = (): AppWsOutboundProjectsChanged => {
      const projects = readProjectRows()
      return {
        v: 1,
        type: 'projects_changed',
        projects,
        active_project_id: projects.length > 0 ? projects[0]!.id : null,
        ts: Date.now(),
      }
    }
    // The project rail is a CROSS-PROJECT concern, but the served web client
    // opens ONE socket scoped to whichever project it is viewing
    // (`app:<user>:<project>` — `appWsProjectTopicId`); General stays on the
    // user-scoped `app:<user>` topic. A rail refresh fanned ONLY to the
    // user-scoped topic therefore never reaches a client that is currently
    // inside a project — the new project would only appear after a reload. This
    // is exactly the "Create Project from inside a project → rail doesn't update
    // until reload" bug (#132 wired the fan, but only to `app:<user>`; onboarding
    // masked it because onboarding runs on General). Fan the frame to the base
    // topic AND every live per-project topic for this user so the rail updates
    // live regardless of which project socket is active. The registry is keyed by
    // exact topic string and each web socket lives on exactly one topic, so no
    // socket receives the frame twice.
    const fanProjectsChanged = (user_id: string, frame: AppWsOutboundProjectsChanged): void => {
      const base = appWsTopicId(user_id)
      const scopedPrefix = `${base}:`
      appWsRegistry.send(base, frame)
      for (const topic of appWsRegistry.topics()) {
        if (topic.startsWith(scopedPrefix)) appWsRegistry.send(topic, frame)
      }
    }
    const emitProjectsChangedIfChanged = (user_id: string): void => {
      const frame = buildProjectsChangedFrame()
      const snapshot = JSON.stringify(frame.projects)
      if (lastProjectsSnapshot === null) {
        lastProjectsSnapshot = snapshot
        return
      }
      if (snapshot === lastProjectsSnapshot) return
      lastProjectsSnapshot = snapshot
      fanProjectsChanged(user_id, frame)
    }
    // Unconditional fan — a KNOWN mutation (the create-project capability) just
    // changed the project set, so always push the fresh snapshot (and reseed the
    // diff baseline) rather than relying on the post-turn diff probe, which
    // would no-op on a skip-import owner whose first action is "Create Project"
    // (baseline still null → diff path swallows the first emit).
    const emitProjectsChangedNow = (user_id: string): void => {
      const frame = buildProjectsChangedFrame()
      lastProjectsSnapshot = JSON.stringify(frame.projects)
      fanProjectsChanged(user_id, frame)
    }
    // One-shot onboarding-complete signal for the web client (Managed post-
    // onboarding claim redirect). Fanned to the base topic AND every live per-
    // project topic — same topology as `fanProjectsChanged` — so it reaches the
    // client regardless of which project socket is active. The frame carries no
    // redirect target; the client reads the claim URL (if any) from its page
    // bootstrap, so on Open self-host it simply no-ops.
    const fanOnboardingCompleted = (user_id: string): void => {
      const frame: AppWsOutboundOnboardingCompleted = {
        v: 1,
        type: 'onboarding_completed',
        ts: Date.now(),
      }
      const base = appWsTopicId(user_id)
      const scopedPrefix = `${base}:`
      appWsRegistry.send(base, frame)
      for (const topic of appWsRegistry.topics()) {
        if (topic.startsWith(scopedPrefix)) appWsRegistry.send(topic, frame)
      }
    }

    // Work Board (Phase 1a) — the per-project live work-tracking board that
    // doubles as the orchestrator's EXTERNAL memory. ONE canonical store shared
    // by the agent `work_board_*` tools (build-core-modules), the HTTP surface
    // (createWorkBoardSurface below), and the per-turn injection seam — so every
    // mutation, agent OR human, runs ONE code path and fires ONE
    // `work_board_changed` full-snapshot push to the owner's app-ws topic. The
    // push is best-effort (the registry `send` is non-throwing; the wrapper
    // guards the snapshot read) so it can never roll back a committed write.
    // Item 1 — a thin trident run store over the SAME `db` the loop reads, so the
    // board push (below) + the HTTP GET surface can derive each bound item's live
    // phase/round/elapsed/stalled from its `linked_run_id`'s `code_trident_runs`
    // row. Stateless wrapper — a second instance elsewhere is harmless.
    const boardRunStore = new TridentRunStore(db)
    // `changedKey` is the storage key of the board that mutated. List + push THAT
    // project's snapshot (not one shared board) and tag the frame with the
    // per-project `project_id` so the clients' per-project filter applies it to the
    // right view; General (key === the owner slug) → no tag (the clients' "no
    // project_id = this/General board" broadcast). Extracted as a named fn so the
    // store's `onChange` AND the M1 run-transition fan (`on_run_transition`, which
    // pushes on each inner-workflow checkpoint) share ONE snapshot-build path.
    const fanWorkBoardChanged = (changedKey: string): void => {
      try {
        const nowMs = Date.now()
        const framePid = workBoardProjectIdForKey(project_slug, changedKey)
        const frame: AppWsOutboundWorkBoardChanged = {
          v: 1,
          type: 'work_board_changed',
          items: workBoardStore.list(changedKey).map((it) => {
            // Item 1 — attach the bound run's live progress (null when unbound).
            const run_progress = runProgressForItem(it, (id) => boardRunStore.get(id), nowMs)
            return {
              id: it.id,
              title: it.title,
              status: it.status,
              sort_order: it.sort_order,
              design_doc_ref: it.design_doc_ref,
              inline_active: it.inline_active,
              linked_run_id: it.linked_run_id,
              created_at: it.created_at,
              updated_at: it.updated_at,
              completed_at: it.completed_at,
              ...(run_progress !== null ? { run_progress } : {}),
            }
          }),
          ...(framePid !== undefined ? { project_id: framePid } : {}),
          ts: nowMs,
        }
        appWsRegistry.send(appWsTopicId(OWNER_USER_ID), frame)
      } catch (err) {
        console.warn(
          `[work-board] event=push_failed project=${changedKey} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    const workBoardStore = new WorkBoardStore(db, {
      onChange: (changedKey: string): void => fanWorkBoardChanged(changedKey),
    })
    // M1 on-disk spec + ▶ play button — the ONE service that persists a card's
    // full ask to a user-visible `Projects/<id>/docs/plans/<slug>.md` doc (setting
    // the card's `design_doc_ref`) and resolves that doc back as the build's spec
    // input. Shared by the create path (agent tool + HTTP POST) and the start
    // path (▶ button HTTP route + `work_board_start` agent tool) so there is one
    // doc-write path and one spec-read path.
    const workBoardSpecDoc = new WorkBoardSpecDocService({
      docs: docStore,
      board: workBoardStore,
      // Ensure the project's docs/ root exists before a spec doc is written — the
      // owner's default board scope (+ any not-yet-materialized project) may lack
      // one, and the DocStore rejects a write under a missing root. Idempotent.
      ensureDocsDir: async (slug) => {
        mkdirSync(joinPath(owner_home, 'Projects', slug, 'docs'), { recursive: true })
      },
    })
    // #339 — the originating app-ws chat topic for a build, reconstructed from a
    // board scope. The React/Expo client subscribes to the General base topic (no
    // project) or `<base>:<project_id>` for a project — the SAME topic the
    // live-agent reply + the work_board_changed fan target. Stamped onto the run's
    // `chat_id` so terminal-result delivery routes the completion message back to
    // the surface the build came from (board-dispatched runs previously carried a
    // null chat_id → the delivery no-op'd → silent completions).
    const tridentDeliveryChatId = (projectId: string | null): string =>
      projectId !== null && projectId.length > 0
        ? `${appWsTopicId(OWNER_USER_ID)}:${projectId}`
        : appWsTopicId(OWNER_USER_ID)
    // #337 — late-bound clarifying-question poster (assigned once the app-ws
    // adapter exists, below). When the ▶ route trips the ask-before-acting gate
    // on an underspecified card, we post a SHORT clarifying question to the CHAT
    // (not the raw internal guard text into the work pane) and leave the item
    // quietly pending. Mirrors the `appWsHolder` late-binding pattern.
    const buildClarifyPoster: { post?: (chatId: string, text: string) => void } = {}
    // ▶ start/retry closure — resolves the card's saved spec (its plans/ doc, else
    // its title) and dispatches a board-bound build through the SAME chokepoint
    // (`dispatchBoardBoundBuild`: required-item + ask-before-acting gate +
    // attachRun binding) the `/code` command + the agent tools use. Gated on the
    // same live-credential predicate as the trident loop (a build can only run
    // when the loop can fire it), so the ▶ route degrades to 501 on an LLM-less
    // box just like `work_board_dispatch_build` is unregistered there.
    const boardStartBuild =
      tridentFireInnerWorkflow !== null
        ? async (slug: string, item: WorkBoardItem): Promise<WorkBoardStartResult> => {
            const task = await workBoardSpecDoc.resolveTaskForItem(slug, {
              title: item.title,
              design_doc_ref: item.design_doc_ref,
            })
            // #339 — stamp the originating chat topic so the terminal result
            // announces back here (slug is the board scope key; map it to project_id).
            const chatId = tridentDeliveryChatId(
              workBoardProjectIdForKey(project_slug, slug) ?? null,
            )
            const result = await dispatchBoardBoundBuild(
              { board_item_id: item.id, task },
              {
                store: boardRunStore,
                board: workBoardStore,
                project_slug: slug,
                repo_path: owner_home,
                channel_kind: 'app_socket',
                chat_id: chatId,
                thread_id: null,
              },
            )
            if (result.ok) return { ok: true, run_id: result.run.id }
            // #337 — an underspecified card must NOT dump the internal guard text
            // into the work pane. Post a short clarifying question to the CHAT and
            // leave the item quietly pending; the surface maps this to a 200 (no
            // error banner). Other rejection codes stay as errors.
            if (result.code === 'underspecified') {
              buildClarifyPoster.post?.(
                tridentDeliveryChatId(workBoardProjectIdForKey(project_slug, slug) ?? null),
                `🛠 "${item.title}" needs a bit more detail before I can build it — what platform, ` +
                  `the key features, and any design reference should it target? Add that (or link a ` +
                  `design doc) and hit ▶ again.`,
              )
            }
            return { ok: false, code: result.code, message: result.message }
          }
        : undefined
    const workBoardSurface = createWorkBoardSurface({
      store: workBoardStore,
      auth: appOwnerAuth,
      // Item 1 (live progress on GET) + item 3 (delete cancels the linked run).
      trident_runs: boardRunStore,
      // M1 — persist a non-trivial create `spec` to a plans/ doc + link the card.
      create_card: (slug, input) => workBoardSpecDoc.createCardWithOptionalSpec(slug, input),
      // M1 — ▶ start/retry a build from the card's saved spec (undefined = 501).
      ...(boardStartBuild !== undefined ? { start_build: boardStartBuild } : {}),
    })
    // Phase 2b — late-bind the dispatch board binder (declared above, before the
    // store could exist) to the canonical store now that it's constructed.
    dispatchBoardHolder.bind(workBoardStore)

    // Per-project credential store: the ONE canonical instance is constructed
    // above (before mountOpenCores) so the Cores' credential resolver + this
    // CRUD surface + the awareness injection all share it. Mount the CRUD surface.
    const projectCredentialsSurface = createProjectCredentialsSurface({
      store: projectCredentialStore,
      auth: appOwnerAuth,
    })
    // Part B — the admin-panel "Connect Codex" surface
    // (`/api/app/projects/<id>/codex-auth`), same bearer auth as the credentials
    // surface. GET status, POST connect (validates + rejects metered key +
    // materializes to CODEX_HOME), DELETE disconnect.
    const codexCredentialSurface = createCodexCredentialSurface({
      service: codexCredentialService,
      auth: appOwnerAuth,
    })

    // ── Onboarding-as-CC-session → Path 1 (2026-06-27): ONE live-session path ─
    // Onboarding is NOT a separate engine/socket and NO LONGER a per-turn phase
    // machine. It is the INITIAL MODE of this same `/ws/app/chat` live agent:
    // while the owner is not yet onboarded the live CC session conducts the
    // interview (a system preamble) and a fire-and-forget post-turn extractor
    // scribes the profile into the SAME `OnboardingStateStore` the engine used —
    // no `engine.advance`, no 6 s Haiku freeform router (the "I didn't quite
    // catch that" culprit), no flag, no dual path. The engine is retained ONLY
    // as the import subsystem owner (notifyImportUpload + synthesis + cron).
    // `isOnboardingActive` decides per-turn whether THIS turn carries the
    // onboarding preamble/affordance or is plain steady-state chat.
    const engine = landing.engine
    const onboardingStateStore = landing.stateStore
    // No state row = fresh install → onboarding. A row in a non-terminal phase =
    // mid-onboarding. 'completed'/'failed' = steady-state chat.
    const isOnboardingActive = async (user_id: string): Promise<boolean> => {
      const st = await onboardingStateStore.get(project_slug, user_id)
      if (st === null) return true
      return st.phase !== 'completed' && st.phase !== 'failed'
    }
    // Project-doc LLM synth for materialized onboarding/import projects (same
    // warm cc-llm path; null → deterministic template docs).
    const projectDocComposer =
      onboardingAnthropicClient !== null
        ? buildProjectDocComposer({ client: onboardingAnthropicClient })
        : null
    // AGENTIC KICKOFF (2026-07-01) — the one-time per-project kickoff finalize
    // runs at onboarding completion. It drafts a real starting doc (via the
    // same CC-substrate composer path as projectDocComposer), offers deadline
    // reminders, or asks a hobby engaging questions when a project carries enough
    // signal; otherwise it returns null and finalize emits the deterministic
    // opening. The written doc is indexed to GBrain recall via the SAME
    // project-page indexer the materializer uses. Null LLM path → no kickoff
    // (onboarding can't run LLM-less anyway).
    const projectKickoff =
      onboardingAnthropicClient !== null
        ? buildProjectKickoff({
            owner_home,
            project_slug,
            composer: buildProjectKickoffComposer({ client: onboardingAnthropicClient }),
            indexer: buildProjectPageIndexer({
              ownerDataDir: owner_home,
              project_slug,
              ...(gbrainSyncHook !== undefined ? { syncHook: gbrainSyncHook } : {}),
            }),
          })
        : null

    // ── Create-project capability (project-rail "Create Project" button) ──────
    // ONE owner-scoped create path, shared by the HTTP surface
    // (`POST /api/app/projects`) and the `create_project` agent tool, reusing the
    // SAME `createProjectRow` + materializer the onboarding finalizer runs. The
    // row write (fast, deterministic) is awaited; the live rail refresh fans
    // immediately; the on-disk materialization (git + docs + gbrain page) is
    // fire-and-forget + failure-isolated (the materializer never throws) — so the
    // button is snappy and the project's row/topic/Work-Board are usable at once
    // while its docs fill in shortly after. Mirrors how finalize is itself
    // dispatched fire-and-forget.
    const scaffoldDeps: ProjectScaffoldDeps = {
      owner_home,
      project_slug,
      db,
      ...(projectDocComposer !== null ? { projectDocComposer } : {}),
      gbrainSyncHook,
    }
    const createProjectAndRefresh = async (input: {
      name: string
      user_id: string | null
    }): Promise<{
      project_id: string
      name: string
      outcome: 'created' | 'existing' | 'skipped'
    }> => {
      const row = await createProjectRow(scaffoldDeps, { name: input.name })
      if (row.outcome !== 'skipped') {
        // Fire-and-forget on-disk scaffold; never blocks the response / rollback.
        void materializeProjectScaffold(scaffoldDeps, {
          name: row.name,
          project_id: row.project_id,
        }).catch((err: unknown) => {
          console.warn(
            `[create-project] event=materialize_failed project=${project_slug} id=${
              row.project_id
            } err=${err instanceof Error ? err.message : String(err)}`,
          )
        })
        // Known mutation → always push the fresh rail snapshot.
        emitProjectsChangedNow(input.user_id ?? OWNER_USER_ID)
      }
      // A 'skipped' outcome (soft-deleted-name collision) is surfaced as a
      // failure by the HTTP/tool callers — never resurrected, never a success.
      return { project_id: row.project_id, name: row.name, outcome: row.outcome }
    }
    // HTTP surface (`/api/app/projects` GET list + POST create). Wiring the
    // surface in Open also gives the mobile app's `fetchProjects` list a real
    // backend (previously unmounted here). Bearer-gated by the same owner auth.
    // P4 (table-ownership, 2026-07): bound to a name so the agent-reply
    // activity stamp below routes through the owning store instead of
    // inlining `UPDATE projects` SQL here (migrations/table-ownership.json).
    const projectSettingsStore = new SqliteProjectSettingsStore(db)
    const appProjectsSurface = createAppProjectsSurface({
      store: projectSettingsStore,
      auth: appOwnerAuth,
      createProject: ({ name, user_id }) => createProjectAndRefresh({ name, user_id }),
      // Rail-redesign: a Settings PATCH that changes the project name or emoji is
      // rail-visible — fan a fresh `projects_changed` so every connected rail
      // re-renders the label/glyph live (no reload).
      onRailFieldChanged: ({ user_id }) => emitProjectsChangedNow(user_id),
    })
    // Agent-tool service (`create_project`) — same path, owner as the refresh
    // target when the turn has no explicit speaker (solo/system).
    const createProjectToolService: CreateProjectToolService = {
      create: ({ name, speaker_user_id }) =>
        createProjectAndRefresh({ name, user_id: speaker_user_id }),
    }

    // Path-1 closing + per-project opening delivery (items 6/7, 2026-06-30).
    // `buildOnboardingFinalize` runs fire-and-forget from the post-turn extractor
    // (constructed below) and from the import-completion watcher; the live agent
    // message delivery path (`buildAppWsSendReply`) is defined much later in this
    // closure. A late-bound holder forward-references it without a use-before-init
    // hazard: `.emit` is assigned right after `buildAppWsSendReply` exists, and is
    // only ever CALLED at finalize time (long after boot). Mirrors the
    // `importWatchHolder` / `appWsButtonPromptRouter` late-binding pattern.
    // C3d — a `late<T>` two-phase seam. `buildOnboardingFinalize` (built just
    // below) derefs `.emit` at finalize time; `wireAppWs` BINDS it once the
    // app-ws adapter exists. The value is only ever CALLED long after boot, so a
    // deref-before-bind cannot happen in prod (all binds fire during composition).
    const onboardingMsg = late<OnboardingMsgEmit>('onboarding_msg')
    // Path 1 finalize seam: persona compose+commit + project materialization
    // (DB rows + topics + docs + gbrain) + mark completed + rail refresh +
    // per-project opening + closing handoff message. Wired only when the box has
    // an LLM path (onboarding can't run LLM-less anyway).
    const onboardingFinalizer =
      onboardingAnthropicClient !== null
        ? buildOnboardingFinalize({
            owner_home,
            project_slug,
            db,
            stateStore: onboardingStateStore,
            personaLoader,
            ...(projectDocComposer !== null ? { projectDocComposer } : {}),
            ...(projectKickoff !== null ? { projectKickoff } : {}),
            gbrainSyncHook,
            emitProjectsChanged: (user_id: string): void => emitProjectsChangedIfChanged(user_id),
            emitOnboardingCompleted: (user_id: string): void => fanOnboardingCompleted(user_id),
            emitChatMessage: (input): Promise<void> =>
              onboardingMsg.deref((emit) => emit(input)) ?? Promise.resolve(),
          })
        : null
    // Authoritative in-flight-import probe — gates onboarding completion against
    // the premature-finalize race (a Path-1 export upload starts an import job
    // OUTSIDE the extractor's per-user chain, so the stale onboarding phase
    // alone can't be trusted). A non-terminal `import_jobs` row for this owner
    // means "an import is live; do not finalize on top of it." Shared by the
    // post-turn extractor, the import-completion watcher, and the reconnect
    // recovery below.
    const probeInFlightImport = async (): Promise<boolean> => {
      try {
        const job = db.get<{ one: number }, [string]>(
          `SELECT 1 AS one FROM import_jobs
               WHERE project_slug = ?
                 AND status NOT IN ('completed', 'failed', 'cancelled')
               LIMIT 1`,
          [project_slug],
        )
        if (job !== null && job !== undefined) return true
        // SEV1 (2026-07-01, "STOP M2" a) — close the UPLOAD-WINDOW hole. The
        // chunked resumable upload writes an `upload_sessions` row (status=
        // 'uploading') during the client→server transfer and only creates the
        // `import_jobs` row once the full ZIP lands (`notifyImportUpload`). An
        // onboarding turn that settles the last required field mid-upload would
        // otherwise finalize BEFORE the import exists (no job row yet, phase not
        // yet `import_running`) and materialize thin chat-answer projects while
        // the export is still at e.g. 31%. Treating an in-progress (non-expired)
        // upload session as "import in flight" makes BOTH finalize gates (the
        // extractor's onComplete AND `finalizeImportOnboardingIfReady`) AND the
        // extractor's project-discovery field suppression hold across the WHOLE
        // upload, not just after the ZIP lands.
        const upload = db.get<{ one: number }, [string, number]>(
          `SELECT 1 AS one FROM upload_sessions
               WHERE project_slug = ?
                 AND status = 'uploading'
                 AND expires_at > ?
               LIMIT 1`,
          [project_slug, Date.now()],
        )
        return upload !== null && upload !== undefined
      } catch {
        // Probe failure must never block a legitimate completion.
        return false
      }
    }
    // M1 E2E Round 4 (2026-06-29) — finalize an onboarding whose history import
    // landed AFTER the owner had already answered every required field. The
    // extractor only finalizes on a USER turn and is (correctly) gated from
    // finalizing while an import is in flight, so the field-completing turn
    // could not finalize. The import-completion watcher then consumes
    // `import_analysis_presented` but historically did NOT finalize — it relied
    // on "a subsequent no-op turn". A user who answered everything and went idle
    // (very likely on a large multi-minute import) was therefore left WEDGED:
    // generic persona, no project DB rows, no error — and reconnect didn't
    // recover (on_session_open only re-armed the watcher). Make import
    // completion an authoritative finalize trigger. Idempotent (finalize no-ops
    // a `completed` row). Returns true iff it finalized.
    const finalizeImportOnboardingIfReady = async (
      user_id: string,
      st: Awaited<ReturnType<typeof onboardingStateStore.get>>,
    ): Promise<boolean> => {
      if (onboardingFinalizer === null || st === null) return false
      if (st.phase === 'completed' || st.phase === 'failed') return false
      // Only AFTER the import has been consumed back into a conversational
      // marker (the engine has by then stamped `import_result` + the merged
      // primary_projects onto phase_state). Never finalize on top of a live or
      // not-yet-consumed import phase. `import_upload_pending` is included (SEV1
      // 2026-07-01) so a turn that settles the last field while the source picker
      // / upload affordance is live cannot finalize ahead of the export either.
      if (
        st.phase === 'import_upload_pending' ||
        st.phase === 'import_running' ||
        st.phase === 'import_analysis_presented'
      )
        return false
      if (auditRequiredFields(st.phase_state).next_to_collect !== null) return false
      if (await probeInFlightImport()) return false
      const importResult =
        st.phase_state['import_result'] !== null &&
        typeof st.phase_state['import_result'] === 'object'
          ? (st.phase_state['import_result'] as ImportResult)
          : null
      await onboardingFinalizer.finalize({
        user_id,
        topic_id: appWsTopicId(user_id),
        state: st,
        import_result: importResult,
      })
      return true
    }
    // The fire-and-forget post-turn scribe — replaces the per-turn llm-router.
    const onboardingExtractor =
      onboardingAnthropicClient !== null
        ? buildPostTurnExtractor({
            anthropicClient: onboardingAnthropicClient,
            stateStore: onboardingStateStore,
            project_slug,
            hasInFlightImport: probeInFlightImport,
            onComplete: async ({ user_id, state }): Promise<void> => {
              if (onboardingFinalizer === null) return
              // Pass the import analysis through to materialization when an
              // import ran this onboarding — the engine stamps the full
              // `ImportResult` onto phase_state at import_analysis_presented, so
              // the materialized project docs carry the imported transcript
              // slices, not just deterministic templates.
              const importResult =
                state.phase_state['import_result'] !== null &&
                typeof state.phase_state['import_result'] === 'object'
                  ? (state.phase_state['import_result'] as ImportResult)
                  : null
              await onboardingFinalizer.finalize({
                user_id,
                topic_id: appWsTopicId(user_id),
                state,
                import_result: importResult,
              })
            },
          })
        : null
    // Path 1 import-completion watcher (late-bound into `importWatchHolder`
    // above). Polls the onboarding row after an upload; the moment the engine's
    // import pipeline lands at `import_analysis_presented` (ImportResult +
    // merged primary_projects/non_work_interests already stamped onto
    // phase_state by the engine), it transitions the row back to the
    // conversational marker so the live interview continues and the extractor's
    // completion path can materialize the imported projects. There is no accept
    // button — the import is auto-consumed. Best-effort; self-cancels on
    // terminal/timeout and unregisters its timer via realmode cleanup.
    const IMPORT_WATCH_INTERVAL_MS = 3_000
    const IMPORT_WATCH_MAX_MS = 30 * 60 * 1_000
    const importWatchActive = new Set<string>()
    const watchImportCompletion = (user_id: string): void => {
      if (importWatchActive.has(user_id)) return
      importWatchActive.add(user_id)
      const startedAt = Date.now()
      const tick = async (): Promise<void> => {
        let reschedule = false
        try {
          const st = await onboardingStateStore.get(project_slug, user_id)
          if (st === null || st.phase === 'completed' || st.phase === 'failed') {
            // Onboarding finished (or the row vanished) — nothing to consume.
          } else if (st.phase === 'import_analysis_presented') {
            // Consume the import: the store does not validate transitions, so we
            // move straight back to the conversational marker. The empty patch
            // (plus a consumed stamp) shallow-merges, preserving the engine's
            // merged primary_projects / non_work_interests / import_result.
            const consumed = await onboardingStateStore.upsert({
              project_slug,
              user_id,
              phase: 'work_interview_gap_fill',
              phase_state_patch: { active_prompt_id: null, import_consumed_at: Date.now() },
            })
            emitProjectsChangedIfChanged(user_id)
            // If the owner had already answered every required field while the
            // import was still synthesizing, there is NO further user turn to
            // finalize on — do it now so onboarding can't strand at the
            // conversational marker. Otherwise the interview simply continues
            // and the field-completing turn finalizes as usual.
            await finalizeImportOnboardingIfReady(user_id, consumed)
          } else if (Date.now() - startedAt <= IMPORT_WATCH_MAX_MS) {
            reschedule = true
          }
        } catch {
          // Transient read/write failure — retry next tick (still bounded).
          reschedule = Date.now() - startedAt <= IMPORT_WATCH_MAX_MS
        }
        if (!reschedule) {
          importWatchActive.delete(user_id)
          return
        }
        const t = setTimeout(() => {
          void tick()
        }, IMPORT_WATCH_INTERVAL_MS)
        realmodeCleanups.push(() => clearTimeout(t))
      }
      void tick()
    }
    importWatchHolder.watch = watchImportCompletion
    // The onboarding interview preamble (offer history import only when a
    // synthesis substrate exists to actually run it).
    const onboardingPreambleText = buildOnboardingPreamble({
      import_offered: importSubstrate !== null,
    })
    // The live-agent onboarding seam — active while the owner isn't onboarded.
    const onboardingSeam: LiveAgentOnboardingSeam | undefined =
      onboardingExtractor !== null
        ? {
            isActive: (user_id: string): Promise<boolean> => isOnboardingActive(user_id),
            systemPreamble: (): string => onboardingPreambleText,
            // Per-turn grounding: re-inject the import-analysis the agent already
            // presented (proposed projects + curation status) so the warm session
            // KNOWS what it proposed and can honor "drop X" / "keep the rest".
            // Reads the durable phase_state (where the engine stamped the full
            // import_result + the merged primary_projects). Best-effort: any read
            // failure degrades to no block (the turn still runs).
            onboardingContext: async (user_id: string): Promise<string | null> => {
              try {
                const st = await onboardingStateStore.get(project_slug, user_id)
                if (st === null) return null
                // Two per-turn grounding fragments, joined:
                //  1. REQUIRED-STEP GUARD (item 3, 2026-06-30) — re-injected EVERY
                //     onboarding turn so the personality archetype + name steps are
                //     reliably presented as `[[OPTIONS]]` buttons (not LLM-whim).
                //     Driven by the durable phase_state audit; null once both
                //     fields are settled.
                //  2. IMPORT-ANALYSIS grounding — only when an import ran (re-injects
                //     the proposed/curated project set so the warm session honors
                //     "drop X" / "keep the rest").
                const stepGuard = buildOnboardingStepGuardFragment(st.phase_state)
                // IMPORT-IN-FLIGHT steer (SEV1 2026-07-01) — while a history
                // import is uploading/analyzing, tell the agent NOT to do project
                // discovery (real projects come from the import). Authoritative:
                // the durable import phase OR the in-flight probe (which now also
                // catches an in-progress chunked upload before the import_jobs row
                // exists), so it holds across the whole upload window.
                const importInFlight =
                  st.phase === 'import_upload_pending' ||
                  st.phase === 'import_running' ||
                  st.phase === 'import_analysis_presented' ||
                  (await probeInFlightImport())
                const importSteer = buildImportInFlightSteerFragment(importInFlight)
                const ir = st.phase_state['import_result']
                const importResult =
                  ir !== null && typeof ir === 'object' ? (ir as ImportResult) : null
                let importFragment: string | null = null
                if (importResult !== null) {
                  const activeRaw = st.phase_state['primary_projects']
                  const active_project_names = Array.isArray(activeRaw)
                    ? activeRaw.filter((s): s is string => typeof s === 'string')
                    : []
                  const fn = st.phase_state['user_first_name']
                  importFragment = buildImportAnalysisContextFragment({
                    proposed_projects: importResult.proposed_projects.map((p) => ({
                      name: p.name,
                      rationale: p.rationale,
                    })),
                    active_project_names,
                    user_first_name: typeof fn === 'string' ? fn : null,
                  })
                }
                const parts = [importSteer, stepGuard, importFragment].filter(
                  (p): p is string => p !== null && p.length > 0,
                )
                return parts.length > 0 ? parts.join('\n\n') : null
              } catch {
                return null
              }
            },
            uploadAffordance: (): { source: 'chatgpt' | 'claude' } | null =>
              importSubstrate !== null ? { source: 'chatgpt' } : null,
            // BUG 1/2 fix (2026-06-30, Ryan live test) — deterministic
            // button-backed answer capture, run + awaited at turn-START (before
            // the step-guard grounding reads phase_state). Persists agent_name /
            // agent_personality DIRECTLY on a tap/typed answer so the required-step
            // audit recomputes settled and never re-asks (BUG 1); when the answer
            // settles the LAST required field, fires finalize and returns
            // `finalized: true` so the runner suppresses its own wrap-up and the
            // deterministic finalize closing is the ONE closing (BUG 2). Fully
            // best-effort: any read/write hiccup degrades to extractor-only
            // persistence and a normal (un-suppressed) turn.
            captureRequiredAnswer: async ({
              user_id,
              user_text,
              prior_agent_options,
            }): Promise<{ finalized: boolean }> => {
              try {
                const st = await onboardingStateStore.get(project_slug, user_id)
                if (st === null) return { finalized: false }
                const captured = captureButtonBackedRequiredField({
                  phase_state: st.phase_state,
                  user_text,
                  prior_agent_options,
                })
                if (captured === null) return { finalized: false }
                // Persist the settled field (shallow-merge; phase unchanged).
                const next = await onboardingStateStore.upsert({
                  project_slug,
                  user_id,
                  phase: st.phase,
                  phase_state_patch: { [captured.field]: captured.value },
                })
                // BUG 2 — did this settle the final required field? If every
                // required field is now present and no import is in flight, finalize
                // now (idempotent) and tell the runner to suppress its wrap-up so the
                // single deterministic closing owns the ending. `finalizeImport-
                // OnboardingIfReady` re-checks readiness + fires finalize.
                if (auditRequiredFields(next.phase_state).next_to_collect === null) {
                  const finalized = await finalizeImportOnboardingIfReady(user_id, next)
                  if (finalized) {
                    emitProjectsChangedIfChanged(user_id)
                    return { finalized: true }
                  }
                }
                return { finalized: false }
              } catch (err) {
                console.warn(
                  `[open] event=capture_required_answer_failed project=${project_slug} user=${user_id} err=${
                    err instanceof Error ? err.message : String(err)
                  }`,
                )
                return { finalized: false }
              }
            },
            onTurnComplete: (turn): void => onboardingExtractor.onTurnComplete(turn),
          }
        : undefined

    const appWsChatTurn =
      liveAgentSubstrate !== null
        ? buildLiveAgentTurn({
            substrate: liveAgentSubstrate,
            personaLoader,
            projectPersonaResolver,
            reflection,
            ...(onboardingSeam !== undefined ? { onboarding: onboardingSeam } : {}),
            // Work Board (Phase 1a) — re-ground EVERY turn on the board (the
            // orchestrator's external memory). Returns the already-formatted,
            // escaped `<work_board>` DATA block for the active+next items, scoped
            // to the ACTIVE project (`workBoardScopeKey`) so the injected board
            // matches the board the agent's `work_board_*` writes land on. General
            // (no project_id) → the owner slug, as before.
            workBoardSnapshot: (slug: string, project_id: string | undefined): string =>
              formatWorkBoardFragment(
                workBoardStore.listActive(workBoardScopeKey(slug, project_id)),
              ),
            // Available-services awareness — the project-scoped credential
            // picture (per-project ∪ global default), so the agent knows which
            // external services it can use in THIS project and gracefully
            // refuses the rest. `slug` = owner boundary, `project_id` =
            // the real per-project dimension (undefined on General).
            availableServicesSnapshot: (slug: string, project_id: string | undefined): string =>
              formatAvailableServicesFragment(
                projectCredentialStore.listAvailableServices(slug, project_id),
              ),
            buttonStore: landing.buttonStore,
            project_slug,
            owner_home,
          })
        : null
    // C3d — the app-ws adapter `late<T>` two-phase seam. adapter ↔ receiver are
    // mutually referential (the receiver replies via `adapter.send`); the seam
    // breaks the cycle without a `used-before-assigned` hazard. The socket cannot
    // dispatch an inbound until boot completes, long after `appWs` is bound (in
    // `wireAppWs`, after `new AppWsAdapter`). It stays COMPOSER-owned because the
    // composer's `buildAppWsSendReply` (below) + the reminder/brief push registry
    // deref it too.
    const appWs = late<AppWsAdapter>('app_ws_adapter')
    // Reply factory: a live-agent turn emits `ChatOutbound`; translate the
    // user-facing `agent_message` into an app-ws `OutgoingMessage` and fan it
    // out via the adapter (which stamps message_id/ts + persists when a chat log
    // is wired). Typing/ack/status frames are web-shaped and dropped. Carries
    // any button options/prompt_id/kind/allow_freeform/upload_affordance so
    // steady-state live-agent prompts render with the SAME button UI onboarding
    // uses (one renderer, one path).
    const buildAppWsSendReply =
      (channel_topic_id: string, project_id?: string) =>
      (out: ChatOutbound): void => {
        if (out.type !== 'agent_message') return
        const msg: OutgoingMessage = {
          topic: {
            topic_id: '',
            channel_kind: 'app_socket',
            channel_topic_id,
            project_id: project_id ?? null,
            privacy_mode: 'regular',
          },
          text: out.body,
        }
        if (out.options !== undefined && out.options.length > 0) {
          // Carry the HUMAN-READABLE option text into `InlineChoice.label` (the
          // adapter renders the button's `body` from it) — NOT the "A"/"B"
          // legend, which would paint live onboarding buttons as bare letters
          // (Codex P2, 2026-06-30). Shared, unit-tested helper.
          msg.inline_choices = optionsToInlineChoices(out.options)
        }
        const adapter_options: Record<string, unknown> = {}
        if (project_id !== undefined) adapter_options['project_id'] = project_id
        if (out.prompt_id !== undefined) adapter_options['prompt_id'] = out.prompt_id
        if (out.kind !== undefined) adapter_options['kind'] = out.kind
        if (out.allow_freeform !== undefined) adapter_options['allow_freeform'] = out.allow_freeform
        if (out.upload_affordance !== undefined) {
          adapter_options['upload_affordance'] = out.upload_affordance
        }
        // FIX #333 — a transient system notice (the cold-start "Waking up…" ack)
        // is live-only: carry the flag so `AppWsAdapter.send` fans it out WITHOUT
        // persisting a chat_log row (no stray bubble on reload).
        if (out.system_notice === true) adapter_options['system_notice'] = true
        if (Object.keys(adapter_options).length > 0) msg.adapter_options = adapter_options
        void appWs.deref((adapter) => adapter.send(msg))
        // Rail-redesign: an agent reply on a PROJECT topic is fresh activity —
        // stamp the project's `last_activity_at` and re-fan `projects_changed`
        // so every connected rail reorders (this project pops to the top) and
        // its unread badge updates live. Best-effort + General-exempt (a General
        // reply carries no project_id). The stamp is a tiny UPDATE; the fan is
        // an idempotent full-snapshot push, so doing it per agent turn is fine.
        // FIX #333 — a transient system notice (cold-start ack) is NOT real
        // activity: it's never persisted, so it must not pop the project or
        // touch `last_activity_at`.
        if (out.system_notice !== true && project_id !== undefined && project_id.length > 0) {
          // Stamp THEN emit — the re-fanned frame is ordered by
          // `last_activity_at`, so the UPDATE must commit before we rebuild it or
          // this project wouldn't yet have popped to the top. Async IIFE keeps
          // the fan itself sync + non-throwing; a stamp failure still emits (the
          // frame just keeps the prior order).
          void (async (): Promise<void> => {
            // P4 (table-ownership): the exact UPDATE moved into the owning
            // store — `touchActivityIncludingArchived` (best-effort, never
            // throws), NOT `touchActivity` (whose predicate also skips
            // archived rows; converging the two was not provably
            // behaviour-preserving).
            await projectSettingsStore.touchActivityIncludingArchived(project_id)
            emitProjectsChangedNow(OWNER_USER_ID)
          })()
        }
      }
    // ── app-ws receiver + delivery cluster (C3d: carved to open/wiring/app-ws.ts) ─
    // The Path-1 closing/opening delivery (`onboardingMsg` bind), the ephemeral
    // typing + onboarding-prompt + import-progress translators, the engine
    // button-prompt router bind, the inbound receiver, `createAppWsSurface(...)`
    // with its on_session_open / on_button_choice hooks, the clarifying poster
    // bind (#337), and the trident terminal-result durable sink (#339). `appWs` is
    // BOUND inside (after `new AppWsAdapter`); `onboardingMsg` is bound at the SAME
    // sequence point as before. `buildAppWsSendReply` (composer-owned, above) is
    // threaded in so the receiver / seed / opening paths share one reply path.
    const {
      appWsSurface,
      tridentDeliverySink,
      cleanups: appWsCleanups,
    } = wireAppWs(wiringCtx, {
      appWs,
      buildAppWsSendReply,
      onboardingMsg,
      importWatchHolder,
      appWsButtonPromptRouter,
      appWsImportProgressRouter,
      buildClarifyPoster,
      appWsRegistry,
      appWsChatTurn,
      scribeOnUserTurn,
      chatCommandFilter,
      appOwnerAuth,
      appWsToken,
      landing,
      emitProjectsChangedIfChanged,
      buildProjectsChangedFrame,
      isOnboardingActive,
      finalizeImportOnboardingIfReady,
      readProjectRows,
      activeChatProjects,
      railChatKey,
    })
    for (const cleanup of appWsCleanups) realmodeCleanups.push(cleanup)

    // #342 — bounded Forge merge-conflict resolver: a fresh ephemeral REPL rooted
    // in the conflicted worktree, reusing the SAME per-cwd factory the dispatch
    // family uses. Gated on the live-credential predicate (a resolver can only run
    // where builds run). Absent → a rebase conflict escalates a specific question
    // to chat rather than auto-resolving.
    const tridentConflictResolver =
      tridentFireInnerWorkflow !== null
        ? buildForgeConflictResolver({
            build_substrate: makeEphemeralSubstrate('cc-trident-resolve'),
          })
        : undefined

    return {
      db,
      project_slug,
      chat_topics_surface,
      chat_history_surface,
      // Single-owner has no Telegram channel — the topic handler + notifiers
      // are no-ops (the Managed composer uses the same shape for its base
      // composition).
      topic_handler: async () => undefined,
      approval_notifier: { notify: async () => undefined },
      watchdog_notifier: { notify: async () => undefined },
      reminder_dispatcher,
      // P1-4 — proactive brief + idle-nudge sweep go live (see `tasksConfig`).
      tasks: tasksConfig,
      heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform,
      cron_jobs: cronJobs,
      // Free Cores (parity gap #2) — `composition.cores` flips on the cores
      // module in `composeProductionGraph` (`build-core-modules.ts:535`) so
      // `installBundledCores` discovers the bundled Cores (rootDirs from the
      // platform adapter) and registers each Core's `buildTools(deps)` MCP
      // surface against the shared ToolRegistry. The `backends` map (built by
      // `mountOpenCores` via `buildCoresBackendFactories`) supplies the
      // optional-until-credentialed Calendar/Email/Google clients; per-Core
      // install is fail-soft (`install-bundled.ts:167-247`) so a Core lacking
      // creds is marked failed without blocking boot.
      cores: {
        dataDir: owner_home,
        secretsStore,
        backends: coresWiring.backends,
        // Read connected OAuth tokens from the SecretsStore at install time so a
        // Google-backed Core installs LIVE the moment its grant exists, and
        // fail-soft/hidden until then (optional-until-credentialed at install).
        prompter: coresWiring.prompter,
        // P1b — supplying `auth` triggers `wireCoresSurfaces` to auto-build the
        // `/api/cores/integrations` + `/api/cores/api-keys/*` admin endpoints
        // (API-key collection). Without it the surface was never mounted in Open
        // → the admin/integrations routes 404'd. Single-owner localhost trust.
        auth: appOwnerAuth,
      },
      // Doc-search agent tools (doc_search / doc_read) — registered by the
      // `tools` module when a runtime is present. Omitted if the index
      // failed to open (boot stays healthy without doc search).
      ...(docSearchRuntime !== null ? { doc_search: { runtime: docSearchRuntime } } : {}),
      // Memory recall (P0-2 — `gbrain_search`) — wire the SAME GBrainMemoryStore
      // the scribe writes to every turn (and the admin Memory tab reads) as an
      // agent-facing recall tool, so the live agent can read its long-term
      // memory back (people/companies/projects + scribe facts). The store is
      // always built (`buildGBrainMemory`), so this is unconditional; the tool
      // degrades to empty results on a host without the `gbrain` binary.
      gbrain_search: { store: gbrainMemory.memoryStore },
      // Work Board (Phase 1a) — register the `work_board_*` agent tools backed
      // by the SAME canonical store the HTTP surface + per-turn injection use,
      // so an agent mutation and a human HTTP write share one code path + one
      // live `work_board_changed` push.
      work_board: { store: workBoardStore, spec_doc: workBoardSpecDoc },
      // Create-project agent tool (create_project) — agent-native parity with
      // the project-rail Create Project button; same owner-scoped create path
      // the HTTP surface uses (one code path).
      create_project: { service: createProjectToolService },
      // Message-search agent tool (message_search) — chat-history twin of
      // doc_search. Backed by this owner's ButtonStore turn history so the
      // live agent can recall what was said earlier in the conversation.
      message_search: {
        runtime: buildButtonStoreMessageSearchRuntime(landing.buttonStore),
      },
      // Import-upload surface (P2 v2 § 6.1 S4 + Upload Resume Phase 2) — these
      // make `app-surfaces-input` mount the bare + chunked + resume routes so
      // a Claude/ChatGPT export upload succeeds during Open onboarding.
      import_upload_handler,
      chunked_upload_handler,
      ...(import_resume_handler !== undefined ? { import_resume_handler } : {}),
      // Import-running cron (S12 2026-05-16 + Bug-1 progress envelope, v0.1.75)
      // — register the per-instance tick so the import-analysis phase surfaces
      // live progress AND auto-advances. `buildLandingStack` already wires the
      // `sendImportProgress` sender + web registry (line ~1114), but NOTHING
      // ticked `engine.pollImportRunningTick(...)` on Open: the managed gateway
      // registers this cron from `build-core-modules.ts` via the same config,
      // while the Open composer omitted it. Result (Ryan, dogfooding): the
      // upload completes + the job runner processes chunks server-side, but the
      // chat shows NO progress and the phase strands at `import_running` because
      // the terminal-status poll never fires. Supplying the config registers
      // the 5s tick → `import_progress` envelopes render in the chat client
      // (`landing/chat.ts:renderImportProgress`) AND the runner's terminal
      // status (completed / failed / cancelled / hard-timeout) advances to
      // `import_analysis_presented` without a user inbound. Mirrors the managed
      // wiring exactly (gateway/composition/build-core-modules.ts § S12).
      onboarding_import_running_cron: { engine: landing.engine },
      // Foundational Trident v2 (Work Board Phase 2a exec-model) — the
      // `/code <task>` autonomous Forge→Argus→merge loop, inner loop a native CC
      // Dynamic Workflow. Threading `fire_inner_workflow` here flips the trident
      // tick loop (built in `build-core-modules.ts`) from its `stubAdvanceDeps`
      // no-op to the REAL `buildWorkflowFirer` + `buildTridentOrchestrator` step,
      // so a `code_trident_runs` row is driven end-to-end: FIRE the `Workflow`
      // tool on a warm substrate + settle the launching turn (billing-exempt, no
      // `claude -p`), the workflow persists its typed result to the DB, and the
      // durable loop harvests it by runId + merges on a server-gated APPROVE (see
      // `tridentFireInnerWorkflow` above). Omitted when no credential resolves
      // (`tridentFireInnerWorkflow === null`) → unchanged LLM-less behaviour (loop
      // stays live + restart-safe but advances nothing). The `on_run_terminal`
      // observer fires Skill Forge's auto-skillify audit (parity gap #5) on every
      // terminal run — the audit drops non-`done` runs. Wired only on the live
      // (dispatch) path; an LLM-less box never advances a run to terminal, so
      // there is nothing to skillify.
      ...(tridentFireInnerWorkflow !== null
        ? {
            trident: {
              fire_inner_workflow: tridentFireInnerWorkflow,
              on_run_terminal: skillForgeOnRunTerminal,
              // M1 UX REDESIGN — the LIVE-PROGRESS fan. Fired by the tick loop for
              // every run whose observable progress advanced (a checkpoint crossing
              // building→reviewing→fixing→merging, a launch, or a terminal
              // transition). A board-bound run's `project_slug` IS the board scope
              // key (`dispatchBoardBoundBuild` creates the run + binds the item
              // under the same slug), so fan THAT board's `work_board_changed` (its
              // items carry the fresh `run_progress.step_label`) + the rail's
              // `projects_changed` (activity/live_runs). Both are best-effort +
              // diff-gated; this is what retires the client's 15 s poll to a
              // fallback. Sync fans wrapped in an async fn to satisfy the hook.
              on_run_transition: async (run): Promise<void> => {
                fanWorkBoardChanged(run.project_slug)
                emitProjectsChangedIfChanged(OWNER_USER_ID)
              },
              // The CODEX_HOME the trident loop threads into the inner workflow's
              // optional codex reviewer. Resolved PER RUN through the credential
              // service (`resolveActiveCodexHome`: project override → global →
              // unset, self-healing) so a connect made AFTER boot + any project
              // override are honored via the #149 store resolver. Trident runs are
              // instance-scoped by `project_slug` (no per-project id), so a run
              // resolves the GLOBAL default; the resolver still prefers an override
              // for any project id it is given. `codex_home` (static global dir)
              // stays as the dev/legacy fallback (see build-core-modules).
              resolve_codex_home: (run) =>
                codexCredentialService.resolveActiveCodexHome(run.project_slug),
              codex_home: codexHome,
              // #339 — post terminal completion messages through the durable
              // app-ws adapter (the bare router has no app_socket adapter on Open).
              delivery_sink: tridentDeliverySink,
              // #342 — auto-resolve a parallel-build rebase conflict via a bounded
              // Forge instead of hard-failing the run.
              ...(tridentConflictResolver !== undefined
                ? { resolve_conflict: tridentConflictResolver }
                : {}),
            },
            // Work Board Phase 2b — the agent-native board-bound build dispatch
            // (`work_board_dispatch_build`). Gated on the SAME live-credential
            // predicate as the trident loop (a build can only run when the loop
            // can fire it). `store` is a thin TridentRunStore over the SAME `db`
            // the loop reads, so a row created by the tool is fired + harvested
            // by the loop. `work_board` is the shared board store (the run
            // binding + the ask-gate lookups). `repo_path` here is the owner HOME
            // BASE — the chokepoint resolves each project's own git-initialized
            // workspace `<home>/Projects/<slug>/code` under it (so brand-new
            // projects with no code repo are buildable), and writes THAT onto the
            // run row.
            trident_build_dispatch: {
              store: new TridentRunStore(db),
              work_board: workBoardStore,
              repo_path: owner_home,
              channel_kind: 'app_socket' as const,
              // M1 ▶ (agent-native) — `work_board_start` resolves a card's saved
              // spec (its plans/ doc, else its title) via the same service the
              // HTTP ▶ route uses, so both build from the one on-disk spec.
              resolve_task: (slug, item) => workBoardSpecDoc.resolveTaskForItem(slug, item),
              // #339 — resolve the originating chat topic from the composing turn's
              // project scope so a board-dispatched (agent-native) build's terminal
              // result announces back to that project's chat (the tool's warm-REPL
              // ToolCallContext is topic-agnostic, but its project_id is correct).
              resolve_delivery: (projectId: string | null) => ({
                chat_id: tridentDeliveryChatId(projectId),
                thread_id: null,
              }),
            },
          }
        : {}),
      // Agent-dispatch family (parity gap #3) — register the `dispatch_agent`
      // tool when the dispatch service was built (same credential gate as
      // trident). The live chat agent can then dispatch a research/review/
      // ad-hoc background agent that shares the SubagentRegistry + watchdog.
      ...(dispatchService !== null ? { agent_dispatch: { service: dispatchService } } : {}),
      // Skill-forge (parity gap #5) — register the `skill_forge_list` +
      // `skill_forge_decide` agent tools, backed by the SAME `SkillForgeBackend`
      // the `/skills` chat command uses (agent-native parity). Built
      // unconditionally so the approve/decline/list surface works LLM-less.
      skill_forge: { backend: skillForgeBackend },
      // Tear down the upload-session sweeper on shutdown.
      realmode_cleanups: realmodeCleanups,
      // C5b — the RAW landing surface. The owner gate is no longer wired here;
      // it flows through the unified `auth_gate` seam below (both modes). For
      // every non-`/chat`, non-SPA path the pre-C5b `openFetch` was a pure
      // `landing.fetch` passthrough, so the ladder serving the raw landing
      // surface directly is behavior-identical.
      landing_server: {
        fetch: landing.fetch.bind(landing),
        websocket: landing.websocket,
      },
      // C5b — the ONE auth-gate seam, Open variant: the single-owner serving
      // gate, supplied through the SAME `composition.auth_gate` field Managed
      // uses. `gateway/composition.ts` routes the `{ kind: 'gate' }` variant
      // straight onto the compose `gate` seam.
      auth_gate: { kind: 'gate', gate: openOwnerGate },
      // P1b — mount the app-ws chat surface (the React client's real transport)
      // + the per-project Documents backend so the chat-react UI works
      // end-to-end. `gateway/composition.ts` forwards both into the compose.ts
      // route chain (app_ws also contributes the `/ws/app/chat` websocket).
      app_ws_surface: {
        handler: appWsSurface.handler,
        websocket: appWsSurface.websocket,
      },
      app_docs_surface: { handler: appDocsSurface.handler },
      // P1b — the tab resolver so the React ProjectShell shows the Documents/Tasks
      // tabs (without it, it falls back to Chat-only and the docs tab is hidden).
      app_tabs_surface: { handler: appTabsSurface.handler },
      // Project list (GET) + create (POST /api/app/projects) surface — feeds the
      // mobile app's project list AND the project-rail Create Project button.
      app_projects_surface: { handler: appProjectsSurface.handler },
      // Work Board (Phase 1a) — the human read+WRITE board API
      // (`/api/app/projects/<id>/work-board`), bearer-gated like the tabs
      // surface, dispatching the same canonical WorkBoardStore the agent uses.
      app_work_board_surface: { handler: workBoardSurface.handler },
      // Per-project credential CRUD (`/api/app/projects/<id>/credentials`),
      // bearer-gated, dispatching the canonical ProjectCredentialStore.
      app_project_credentials_surface: { handler: projectCredentialsSurface.handler },
      // Part B — admin-panel Connect Codex (subscription auth → per-project CODEX_HOME).
      app_codex_credential_surface: { handler: codexCredentialSurface.handler },
      // Part B — agent-native parity for the connect/status flow.
      codex_credential: { service: codexCredentialService },
      // P1b — Tasks tab backend + chat attachment upload, so every visible React
      // control has a live backend (no 404s behind a shown tab/button).
      app_tasks_surface: { handler: appTasksSurface.handler },
      app_upload_surface: { handler: appUploadSurface.handler },
    }
  }
}

/** The minimal warm-up prompt dispatched to spawn + heat the conversational
 *  REPL at onboarding start. Cheap (1-token response) — its only job is to pay
 *  the cold-spawn cost ONCE behind the loading indicator so the first real
 *  phase-spec turn lands on a hot session. The reply text is discarded. */
const PREWARM_PROMPT = 'Reply with the single word: ready'

/**
 * Pre-warm a conversational substrate at onboarding start (Step 1 of the
 * single-session onboarding rework). Fire-and-forget: dispatches ONE minimal
 * warm-up turn through the substrate so the persistent `claude` REPL spawns +
 * heats now (behind the loading indicator), NOT on the user's first real turn.
 *
 * Best-effort by contract: every failure path — no credential at warm-up time,
 * a transient spawn error, the warm-up turn timing out — is swallowed. A
 * cold/failed warm session is covered by the engine's static phase prompts, and
 * the next real turn re-spawns the warm REPL lazily. So a failed pre-warm
 * degrades to exactly the pre-rework behaviour (one cold spawn on the first
 * turn) rather than breaking onboarding.
 *
 * Returns the warm-up promise (2026-06-18): the composer awaits it — bounded,
 * via `awaitPrewarmReady` — before the first conversational dispatch so the cold
 * spawn is paid OUTSIDE the conversational timeout, not raced against it. The
 * promise NEVER rejects (the warm-up runs detached + swallows all errors), so an
 * awaiter can rely on it settling. Still effectively fire-and-forget: nothing
 * blocks on it at build, and a caller that ignores the return value gets the
 * prior behaviour. Exported for the composer unit test.
 */
export function prewarmSubstrate(substrate: Substrate): Promise<void> {
  const spec: AgentSpec = {
    prompt: PREWARM_PROMPT,
    tools: [],
    // Resolve the warm-pool model PER-PREWARM via the dynamic accessor. This is
    // the spawn that HEATS the onboarding REPL (it stamps the warm record's
    // `model`, which the first real turn then reuses): a frozen id here is what
    // pinned the dead `opus-4-7` and hung onboarding for the full 180s turn
    // timeout (the 2026-06-30 incident). `getBestModel()` tracks the watchdog.
    model_preference: [getBestModel()],
    max_tokens: 16,
  }
  return (async (): Promise<void> => {
    try {
      const handle = substrate.start(spec)
      // Drain to completion so the persistent substrate keeps the freshly
      // spawned child in its warm pool. The reply is discarded.
      await collectTokensToString(handle)
    } catch {
      // best-effort warm-up — never blocks boot, never throws.
    }
  })()
}

/**
 * Await the pre-warm's readiness, BOUNDED by `PREWARM_AWAIT_CAP_MS_DEFAULT`
 * (env `NEUTRON_PREWARM_AWAIT_CAP_MS`, default 35s) so the first conversational
 * turn waits for the cold CC spawn to settle but can NEVER hang on a pathological
 * pre-warm. Resolves on whichever fires first: the (never-rejecting) pre-warm
 * promise, or the cap. Best-effort by contract — used by the phase-spec
 * resolver's `awaitReady` gate, which itself swallows any throw.
 */
export async function awaitPrewarmReady(
  prewarmReady: Promise<void>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const capMs = readPrewarmAwaitCapMs(env)
  let timer: ReturnType<typeof setTimeout> | null = null
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, capMs)
  })
  try {
    await Promise.race([prewarmReady, cap])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Resolve the pre-warm await cap (ms) from env, defaulting per llm-timeouts. */
function readPrewarmAwaitCapMs(env: NodeJS.ProcessEnv): number {
  const raw = env['NEUTRON_PREWARM_AWAIT_CAP_MS']
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return PREWARM_AWAIT_CAP_MS_DEFAULT
}

/**
 * Resolve the FIRST-conversational-turn elevated budget (ms) from env, defaulting
 * per llm-timeouts (`PREWARM_AWAIT_CAP_MS_DEFAULT + CONVERSATIONAL_TIMEOUT_MS_DEFAULT`).
 * Sized to cover a cold CC spawn so the first onboarding turn doesn't degrade to
 * the static prompt purely from spawn latency (2026-06-18 cold-start fix).
 */
function readFirstConversationalTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env['NEUTRON_FIRST_CONVERSATIONAL_TIMEOUT_MS']
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return FIRST_CONVERSATIONAL_TIMEOUT_MS_DEFAULT
}
