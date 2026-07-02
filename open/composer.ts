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

import { JwksCache } from '../jwt-validator/validator.ts'
import { newCredentialPool, type CredentialPool } from '../runtime/credential-pool.ts'
import { detectAmbientClaudeAuthCached } from './ambient-claude-auth.ts'
import { buildOpenInstallTokenHandler } from './install-token-handoff.ts'
import { persistOauthTokenToEnv, requestSupervisorRestart } from './install-token-env.ts'
import { buildLocalPlatformAdapter } from '../runtime/platform-adapter-local.ts'
import type { PlatformAdapter } from '../runtime/platform-adapter.ts'
import { isSpaClientRoute } from '../landing/spa-routes.ts'
import { CronJobRegistry } from '../cron/jobs.ts'
import {
  buildLandingStack,
  resolveLandingStaticDir,
} from '../gateway/realmode-composer/build-landing-stack.ts'
import { buildLiveAgentTurn } from '../gateway/realmode-composer/build-live-agent-turn.ts'
import type { LiveAgentOnboardingSeam } from '../gateway/realmode-composer/build-live-agent-turn.ts'
import { buildProjectDocComposer } from '../gateway/realmode-composer/build-project-doc-composer.ts'
import { buildProjectKickoffComposer } from '../gateway/realmode-composer/build-project-kickoff-composer.ts'
import { buildProjectKickoff } from '../gateway/realmode-composer/build-project-kickoff.ts'
import { buildProjectPageIndexer } from '../gateway/realmode-composer/build-project-page-indexer.ts'
import { buildOnboardingFinalize } from '../gateway/realmode-composer/build-onboarding-finalize.ts'
import {
  buildProjectDocReader,
  buildDeterministicProjectOpening,
  finalizeOpeningBody,
  type ProjectOpeningDocs,
} from '../gateway/realmode-composer/build-onboarding-handoff.ts'
import { buildPostTurnExtractor } from '../onboarding/interview/post-turn-extractor.ts'
import { auditRequiredFields } from '../onboarding/interview/required-fields-audit.ts'
import { captureButtonBackedRequiredField } from '../onboarding/interview/button-backed-answer.ts'
import {
  buildImportAnalysisContextFragment,
  buildImportInFlightSteerFragment,
  buildOnboardingPreamble,
  buildOnboardingStepGuardFragment,
} from '../onboarding/interview/onboarding-preamble.ts'
import type { ImportResult } from '../onboarding/history-import/types.ts'
import {
  buildLlmCallSubstrate,
  collectTokensToString,
} from '../gateway/realmode-composer/build-llm-call-substrate.ts'
import { buildSubstrateWorkflowFire } from '../trident/inner-loop.ts'
import { getBestModel } from '../runtime/models.ts'
import {
  FIRST_CONVERSATIONAL_TIMEOUT_MS_DEFAULT,
  PREWARM_AWAIT_CAP_MS_DEFAULT,
} from '../onboarding/interview/llm-timeouts.ts'
import type { AgentSpec, Substrate } from '../runtime/substrate.ts'
import { SubagentRegistry } from '../runtime/subagent/registry.ts'
import { newControlState } from '../runtime/subagent/control.ts'
import {
  DispatchService,
  buildCancellableDispatchTurn,
  defaultPersonaLoader,
  type DispatchBoardBinder,
} from '../agent-dispatch/index.ts'
import {
  buildAnthropicLlmCall,
  buildPhaseSpecResolver,
} from '../gateway/realmode-composer/build-phase-spec-resolver.ts'
import {
  buildGatewayAnthropicMessagesClient,
  buildGatewayLlmRouter,
} from '../gateway/realmode-composer/build-llm-router.ts'
import { buildProjectOpeningMessageComposer } from '../gateway/realmode-composer/build-project-opening-message.ts'
import { mkdirSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildGBrainMemory } from '../gateway/realmode-composer/build-gbrain-memory.ts'
import { resolveOnboardingOpenAiKey } from '../gateway/realmode-composer/resolve-onboarding-openai-key.ts'
import { DocSearchIndex } from '../doc-search/store.ts'
import { DocSearchRuntime } from '../doc-search/runtime.ts'
import { buildLiveProjectEnumerator } from './doc-search-live-enumerator.ts'
import { buildButtonStoreMessageSearchRuntime } from '../gateway/composition/message-search-wiring.ts'
import { createScribe, type Scribe, type UserTurnInput } from '../scribe/index.ts'
import { createState, defaultStatePath } from '../scribe/scribe-budget.ts'
import { mountCoresScribeFanOut } from '../gateway/cores/mount-cores-scribe-fan-out.ts'
import { mountOpenCores } from '../gateway/cores/mount-open-cores.ts'
import { buildChainedChatCommandFilter } from '../gateway/boot-helpers.ts'
import {
  SkillForge,
  SkillForgeProposalsStore,
  buildSkillForgeBackend,
  buildSkillForgeChatCommandFilter,
  completedWorkflowFromTridentRun,
} from '../skill-forge/index.ts'
import {
  provisionAgentSkills,
  resolveAgentSkillsDir,
} from '../runtime/adapters/claude-code/persistent/agent-skills.ts'
import { TridentRunStore, type TridentRun } from '../trident/store.ts'
import { runProgressForItem } from '../trident/run-progress.ts'
import { SecretsStore } from '../auth/secrets-store.ts'
import { createReflection, type Reflection } from '../reflection/index.ts'
import { buildPersonalityCharacterSuggester } from '../onboarding/interview/personality-character-suggester.ts'
import { buildPersonaSummarizer } from '../onboarding/persona-gen/summarize.ts'
import { PersonaPromptLoader } from '../gateway/realmode-composer/persona-loader.ts'
import type { GraphComposer } from '../gateway/boot-helpers.ts'
import type { CompositionInput } from '../gateway/composition.ts'
import { buildLlmBriefComposer } from '../gateway/proactive/morning-brief.ts'
import { buildLlmNudgeRater } from '../gateway/proactive/idle-nudge-sweep.ts'
import { buildButtonStoreProactiveSink } from '../gateway/proactive/button-store-sink.ts'
import { resolveLocalTimezone } from '../gateway/proactive/local-timezone.ts'
import { readSessionCookie, signSessionCookie } from '../landing/session-cookie.ts'

import {
  buildReminderDispatcher,
  buildSubstrateReminderLlm,
  buildButtonStoreReminderOutbound,
  buildStatusMdContextSource,
} from '../reminders/index.ts'

import { buildLocalStartTokenAuth } from './local-start-token.ts'
import { buildProjectPersonaResolver } from './project-persona-resolver.ts'
import { createOpenChatTopicsSurface } from './chat-topics-surface.ts'
import { createChatHistorySurface } from '../gateway/http/chat-history-surface.ts'
import { OWNER_USER_ID, resolveNeutronHome, resolveOpenInstanceInfo } from './owner-identity.ts'
// P1b (2026-06-26) — wire the per-project Documents backend + the cores
// integrations/api-keys surface into the single-owner Open boot. Both authorize
// against ONE single-owner localhost-trust resolver (Path A): the owner is the
// only user and is already authed at the HTTP start-token/cookie layer, so the
// app-bearer (`dev:<owner>`) is accepted directly. No feature flag, single path.
import { createAppWsAuthResolver } from '../channels/adapters/app-ws/auth.ts'
import type { AppWsAuthResolver } from '../channels/adapters/app-ws/auth.ts'
import { DocStore } from '../gateway/http/doc-store.ts'
import { createAppDocsSurface } from '../gateway/http/app-docs-surface.ts'
import { createAppTabsSurface } from '../gateway/http/app-tabs-surface.ts'
import { createAppProjectsSurface } from '../gateway/http/app-projects-surface.ts'
import { SqliteProjectSettingsStore } from '../gateway/projects/sqlite-store.ts'
import { resolveProjectEmoji } from '../gateway/projects/default-emoji.ts'
import {
  createProjectRow,
  materializeProjectScaffold,
  type ProjectScaffoldDeps,
} from '../gateway/realmode-composer/project-create.ts'
import type { CreateProjectToolService } from '../gateway/realmode-composer/create-project-tool.ts'
import { createAppTasksSurface } from '../gateway/http/app-tasks-surface.ts'
import { createAppUploadSurface } from '../gateway/http/app-upload-surface.ts'
import { TaskStore } from '../tasks/store.ts'
import { AppWsAdapter, optionsToInlineChoices } from '../channels/adapters/app-ws/adapter.ts'
import { InMemoryAppWsSessionRegistry } from '../channels/adapters/app-ws/session-registry.ts'
import {
  appWsTopicId,
  appWsProjectTopicId,
  type AppWsOutboundAgentMessage,
  type AppWsOutboundAgentTyping,
  type AppWsOutboundImportProgress,
  type AppWsOutboundOnboardingCompleted,
  type AppWsOutboundProjectsChanged,
  type AppWsOutboundWorkBoardChanged,
} from '../channels/adapters/app-ws/envelope.ts'
import { createWorkBoardSurface } from '../gateway/http/work-board-surface.ts'
import { createProjectCredentialsSurface } from '../gateway/http/project-credentials-surface.ts'
import { createCodexCredentialSurface } from '../gateway/http/codex-credential-surface.ts'
import { ProjectCredentialStore } from '../project-credentials/store.ts'
import { CodexCredentialService } from '../trident/codex-credential.ts'
import { resolveCodexHome } from '../trident/codex-auth.ts'
import { formatAvailableServicesFragment } from '../project-credentials/fragment.ts'
import { WorkBoardStore, type WorkBoardItem } from '../work-board/store.ts'
import { WorkBoardSpecDocService } from '../work-board/spec-doc-service.ts'
import { dispatchBoardBoundBuild } from '../trident/board-dispatch.ts'
import type { WorkBoardStartResult } from '../gateway/http/work-board-surface.ts'
import { formatWorkBoardFragment } from '../work-board/fragment.ts'
// Chat transport — durable per-topic message log + receipt/reaction/edit logs
// for the app-ws (Expo / web) surface. Wiring these into the adapter is what
// turns the already-built seq/resume/idempotency/receipt machinery from inert
// (no-log fallback) into live: durable chat_log with a monotonic seq, an
// idempotent retry that never re-runs the agent turn, gap-free reconnect
// replay, and persisted delivered/read receipts + reactions + edits.
import {
  AppChatStore,
  AppChatReceiptStore,
  AppChatReactionStore,
  AppChatEditStore,
} from '../persistence/index.ts'
import { InMemoryConsumedTokens } from '../runtime/consumed-tokens-in-memory.ts'
import type { ButtonChoice, ButtonPrompt } from '../channels/button-primitive.ts'
import { buildButtonPrompt } from '../channels/button-primitive.ts'
import type {
  AppSocketButtonPromptRouter,
  AppSocketImportProgressRouter,
} from '../gateway/http/chat-bridge.ts'
import { createAppWsSurface } from '../gateway/http/app-ws-surface.ts'
import type { IncomingEvent, OutgoingMessage } from '../channels/types.ts'
import type { ChatOutbound } from '../landing/server.ts'

export interface BuildOpenGraphComposerOptions {
  /** Override the process env (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
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
    opts: import('../runtime/adapters/claude-code/index.ts').ClaudeCodeSubstrateOptions,
  ) => import('../runtime/substrate.ts').Substrate
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
 * BOTH subscription OAuth and API-billing auth — mirroring the Managed
 * resolver's precedence (`gateway/realmode-composer/resolve-llm-credentials.ts`:
 * the process-env `CLAUDE_CODE_OAUTH_TOKEN` source wins over the shared
 * `ANTHROPIC_API_KEY` env source). This is the credential the `claude`
 * subprocess substrate runs on (NEVER a direct api.anthropic.com call):
 *
 *   - `CLAUDE_CODE_OAUTH_TOKEN` (what `claude setup-token` prints — the
 *     self-host subscription path) → `kind: 'oauth'`, threaded to the
 *     subprocess as a `Authorization: Bearer …` token by
 *     `build-llm-call-substrate`.
 *   - else `ANTHROPIC_API_KEY` (API-billing) → `kind: 'api_key'`.
 *   - else, if `claude` is already AMBIENT/Keychain-authed (the owner ran
 *     `claude` login on this Mac; creds live in the macOS "Claude Code-credentials"
 *     Keychain item, NOT in env) → `kind: 'ambient'`. The substrate spawns
 *     `claude` threading NO token, so the child auths via its own Keychain. This
 *     closes the fresh-install 503: a Mac self-hoster with `claude` already
 *     logged in no longer hits a Day-1 "Authenticate Claude" wall even though
 *     `claude -p` works headlessly. The probe is fast + cached + never-hanging
 *     (`detectAmbientClaudeAuthCached`); a timeout/failure → not-authed → the
 *     gate stays up. SINGLE-OWNER ONLY: this resolver runs only on the Open
 *     composer, where an ambient Keychain login is the box owner's own. It is
 *     the sole credential resolver in this tree, so accepting ambient auth here
 *     cannot widen any shared/multi-user credential path (there is none here).
 *   - else `null` → the box boots LLM-less and onboarding walks its static
 *     phase prompts.
 *
 * BEFORE this resolver the Open composer gated the entire substrate on
 * `ANTHROPIC_API_KEY` alone, so a self-hoster who authed via `claude
 * setup-token` (subscription OAuth, the headline `curl | sh` flow) booted
 * LLM-less while the installer reported success — a false-success no-op.
 * Consuming the OAuth token here is what makes the install.sh "✓ Claude auth
 * detected" honest: install.sh's notion of "authed" now matches what the
 * Open server actually consumes.
 *
 * `opts.probeAmbientAuth` is a test seam — production defaults to the cached
 * Keychain/creds-file probe. It is consulted ONLY on the no-explicit-token
 * branch, so a configured token short-circuits with zero subprocess cost.
 */
export function resolveOpenLlmPool(
  env: NodeJS.ProcessEnv,
  opts?: { probeAmbientAuth?: () => boolean },
): CredentialPool | null {
  const oauthToken = env['CLAUDE_CODE_OAUTH_TOKEN']
  if (typeof oauthToken === 'string' && oauthToken.length > 0) {
    return newCredentialPool({
      strategy: 'fill_first',
      credentials: [{ id: 'anthropic:env_oauth', kind: 'oauth', secret: oauthToken }],
    })
  }
  const apiKey = env['ANTHROPIC_API_KEY']
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    return newCredentialPool({
      strategy: 'fill_first',
      credentials: [{ id: 'anthropic:env_api_key', kind: 'api_key', secret: apiKey }],
    })
  }
  // No explicit credential in env — accept an ambient/Keychain-authed `claude`
  // (single-owner only). The `ambient` cred carries no secret; the substrate
  // threads nothing and the spawned `claude` child uses its own Keychain auth.
  const probeAmbientAuth = opts?.probeAmbientAuth ?? (() => detectAmbientClaudeAuthCached(env))
  if (probeAmbientAuth()) {
    return newCredentialPool({
      strategy: 'fill_first',
      credentials: [{ id: 'anthropic:ambient_keychain', kind: 'ambient', secret: '' }],
    })
  }
  return null
}

/**
 * Open-mode app-ws routing decision for an engine-emitted onboarding
 * `ButtonPrompt`. In Path-1/Open the engine no longer drives the conversation
 * (the live CC session does) — it only emits IMPORT-side prompts on this socket.
 *
 * The successful `import_analysis_presented` prompt is special: its accept/resume
 * BUTTON is redundant (the import-completion watcher auto-advances the phase) and
 * a tap would dangle (button choices route to the engine store, not the live
 * session). A prior version suppressed the WHOLE prompt — body included — which
 * meant a real install's import would complete (e.g. 175 conversations, 8
 * projects) but the rich analysis "wow moment" NEVER reached the React chat
 * (2026-06-29 render-gap). The fix: still deliver the analysis BODY (the bulleted
 * project list IS the picker; the user confirms in freeform), but STRIP the
 * dangling button options. Every OTHER prompt — including a FAILED-import
 * analysis / rate-limit / resume prompt the user genuinely needs — emits as-is.
 *
 * Pure + exported for unit coverage; the router (in {@link buildOpenGraphComposer})
 * calls this then fans the result over the app-ws registry.
 */
export function resolveOpenImportPromptEmission(
  prompt: ButtonPrompt,
  phase: string | null,
  importFailed: boolean,
): ButtonPrompt {
  if (phase === 'import_analysis_presented' && !importFailed) {
    return { ...prompt, options: [], allow_freeform: true }
  }
  return prompt
}

export type ImportRunningStatusDelivery = 'durable' | 'suppress' | 'ephemeral'

/**
 * Open-mode delivery decision for the ephemeral import_running "Reading through
 * your export now…" STATUS bubble.
 *
 * Emitted via `emitOnboardingPrompt` it carries NO chat_log `seq`, so chat-core
 * `compareForDisplay` sorts it to the TAIL — it floats below every later
 * real-seq message and stays pinned at the bottom even after the import
 * completes and the analysis + later turns arrive (M1 verify, 2026-06-30; the
 * same ordering seam #130 fixed for the analysis body). The decision:
 *   - 'durable'   — persist the FIRST status bubble through the durable adapter
 *                   (chat_log → monotonic seq) so it orders chronologically,
 *                   mirroring the `import_analysis_presented` body.
 *   - 'suppress'  — drop the engine cron's RE-EMITS (attempt_count > 1): a fresh
 *                   prompt is built each poll, so persisting every one would stack
 *                   duplicate durable bubbles. The single durable bubble plus the
 *                   live `import_progress` banner already cover the running state.
 *   - 'ephemeral' — everything else (failure / rate-limit / resume prompts the
 *                   user must act on, and non-import_running prompts) keeps the
 *                   existing ephemeral path; the engine owns their durability +
 *                   reconnect re-emit.
 *
 * Only the plain no-button progress bubble (`sub_step === 'status'`, zero
 * options) is ever persisted/suppressed; a status variant carrying a button
 * falls through to 'ephemeral'. Pure + exported for unit coverage.
 */
export function resolveImportRunningStatusDelivery(args: {
  phase: string | null
  sub_step: unknown
  attempt_count: unknown
  option_count: number
}): ImportRunningStatusDelivery {
  const { phase, sub_step, attempt_count, option_count } = args
  if (phase !== 'import_running') return 'ephemeral'
  if (sub_step !== 'status') return 'ephemeral'
  if (option_count !== 0) return 'ephemeral'
  const attempts =
    typeof attempt_count === 'number' && Number.isFinite(attempt_count) ? attempt_count : 1
  return attempts <= 1 ? 'durable' : 'suppress'
}

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

  return async ({ db, project_slug }): Promise<CompositionInput> => {
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

    // WARM conversational substrate for the onboarding phase-spec LLM
    // rephrasing — the snappy-conversational core of the onboarding rework
    // (2026-06-17 single-session architecture, Step 1).
    //
    // NOT `ephemeral`: a session-less phase-spec dispatch REUSES the ONE warm,
    // pre-warmed `claude` REPL keyed on (instance, owner, project, credential)
    // rather than cold-spawning a fresh heavy session (MCP + dev-channel +
    // plugins + system-prompt load, ~10-30s) EVERY onboarding turn just to
    // rephrase a prompt that has a static fallback. Context is ALLOWED to
    // accumulate across the conversation (no `reset_context_per_turn` → no
    // `/clear`) — an accumulating model of the onboarding so far is desired,
    // and the conversational SHORT timeout tier (3s, llm-timeouts.ts) means a
    // turn is always snappy: fast real answer on the warm session, or instant
    // static fallback.
    //
    // The `ephemeral` one-shot-isolation flag exists for the MANAGED gateway's
    // SHARED `cc-llm-*` substrate (7+ stateless utility callers that must not
    // bleed cross-purpose into one transcript). On Open this substrate is
    // SINGLE-PURPOSE — wired only into `buildPhaseSpecResolver` below — so
    // reusing one warm session is correct, not a collapse. `skip_permissions`
    // mirrors `liveAgentSubstrate` so the headless REPL doesn't block on
    // interactive prompts.
    const llmCallSubstrate =
      llmPool !== null
        ? buildLlmCallSubstrate({
            pool: llmPool,
            substrate_instance_id: `cc-llm-${internal_handle}`,
            cwd: owner_home,
            internal_handle,
            user_id: OWNER_USER_ID,
            project_slug,
            skip_permissions: true,
            ...(substrateFactory !== undefined ? { substrateFactory } : {}),
          })
        : null

    // Pre-warm the conversational session at onboarding start (fire-and-forget,
    // behind the loading indicator). The cold warm-up (~10-30s) is paid ONCE
    // here at composer build — NOT on the user's first turn — so the first real
    // phase-spec dispatch hits a HOT session. Best-effort: any failure (no
    // credentials at warm-up, transient spawn error) is swallowed; the engine's
    // static phase prompts cover a cold/failed warm session, and the next real
    // turn re-spawns the warm REPL lazily. Skipped entirely when LLM-less.
    //
    // 2026-06-18 (synthesis-completes fix): capture the pre-warm promise so the
    // phase-spec resolver can AWAIT it (bounded) before its FIRST dispatch. If
    // the owner answers the first question before the cold spawn settles, the
    // first real turn would otherwise race the ~11-30s spawn and time out at the
    // 12s conversational tier into the static fallback (the live-signup symptom).
    // Awaiting readiness OUTSIDE the conversational timeout means only the cold
    // first turn waits; warm turns stay snappy.
    const prewarmReady: Promise<void> | null =
      llmCallSubstrate !== null ? prewarmSubstrate(llmCallSubstrate) : null
    // Track whether the pre-warm has SETTLED so the resolver can elevate the
    // budget for EVERY conversational dispatch in the cold window — not just the
    // first (2026-06-18 cold-start fix, round 2: the live owner-signup raced the
    // first TWO turns against the cold spawn and both timed out at 12 s). The flag
    // flips true when the (never-rejecting) pre-warm promise resolves; until then,
    // early turns get the cold-spawn-sized `first_call_timeout_ms` budget.
    let prewarmSettled = prewarmReady === null
    if (prewarmReady !== null) {
      void prewarmReady.then(() => {
        prewarmSettled = true
      })
    }

    // Dedicated WARM conversational substrate for post-onboarding live chat
    // turns (no `ephemeral`; keyed per-dispatch on metering_context).
    const liveAgentSubstrate =
      llmPool !== null
        ? buildLlmCallSubstrate({
            pool: llmPool,
            substrate_instance_id: `cc-agent-${internal_handle}`,
            cwd: owner_home,
            internal_handle,
            user_id: OWNER_USER_ID,
            project_slug,
            skip_permissions: true,
            // P0-1 — the owner's WARM conversational REPL is the ONE substrate
            // that opts into the native-MCP tool bridge, so the live chat agent
            // can call Cores/doc-search/memory/reminders mid-reasoning over a
            // structured stdio-MCP transport (the in-process registry, fronted by
            // `tools-bridge.ts`). The untrusted import (`cc-import-*`) and
            // disposable Trident (`cc-trident-*`) substrates deliberately omit it.
            enableToolBridge: true,
            ...(substrateFactory !== undefined ? { substrateFactory } : {}),
          })
        : null

    // Foundational Trident build-agent runner (Forge / Argus) — the `/code
    // <task>` autonomous build loop, on the CC-subprocess substrate.
    //
    // Per-WORKTREE + per-build isolation: rather than ONE substrate fixed at
    // `owner_home`, this is a FACTORY that builds a FRESH ephemeral substrate
    // per dispatch, rooted at the run's worktree (`input.repo_path`). So each
    // Forge/Argus turn runs IN its own worktree on a disposable `cc-trident-*`
    // REPL — never `owner_home`, never the owner's warm conversational
    // (`cc-agent-*`) pool — so one build's context can never bleed into another
    // build or into the owner's live chat. (`AgentSpec` carries no per-call cwd,
    // so per-worktree dispatch HAS to re-root the substrate per turn; this
    // closes the two hardening items the first prod-boot wiring PR deferred.)
    //
    // When no credential resolves (`llmPool === null`) the dispatch stays null
    // and `composition.trident` is left unset — the tick loop runs its
    // restart-safe `stubAdvanceDeps` no-op, the unchanged LLM-less behaviour.
    // A FRESH ephemeral CC-subprocess substrate per turn, rooted at the call's
    // cwd. Shared by the Trident build loop and the agent-dispatch family below
    // (each passes its own `instance_id` prefix) so both spawn through the SAME
    // path (NEVER a direct api.anthropic.com call). Throws on an empty pool so a
    // dispatch surfaces as a crashed turn rather than a silent no-op.
    const makeEphemeralSubstrate =
      (instance_prefix: string) =>
      (cwd: string): Substrate => {
        const s =
          llmPool === null
            ? null
            : buildLlmCallSubstrate({
                pool: llmPool,
                substrate_instance_id: `${instance_prefix}-${internal_handle}`,
                cwd,
                internal_handle,
                user_id: OWNER_USER_ID,
                project_slug,
                skip_permissions: true,
                ephemeral: true,
                ...(substrateFactory !== undefined ? { substrateFactory } : {}),
              })
        if (s === null) {
          throw new Error(`${instance_prefix}: empty Anthropic credential pool`)
        }
        return s
      }

    // Trident v2 (Work Board Phase 2a exec-model) — the inner Forge→Argus→fix
    // loop is one native CC Dynamic Workflow. The composer threads a FIRE seam
    // (`buildSubstrateWorkflowFire`); the build-core trident module wraps it with
    // `buildWorkflowFirer`. The fire seam invokes the `Workflow` tool on a WARM
    // (non-ephemeral) substrate and SETTLES the launching turn immediately —
    // billing-exempt (the owner's Max-OAuth pool, NOT a per-build `claude -p`).
    // The workflow then runs DETACHED in the background and persists its TYPED
    // result to `code_trident_runs.inner_result`, which the durable tick loop
    // harvests by runId.
    //
    // WARM-PER-REPO: the persistent pool keys on (instance, user, project,
    // credential) — NOT cwd — so a single shared instance id would pin every
    // run's worktree creation to the FIRST repo's cwd. The workflow's Forge agent
    // uses `isolation:'worktree'`, which forks the worktree from the FIRE turn's
    // git cwd, so each distinct repo needs its OWN warm pool entry. This memoized
    // factory builds ONE non-ephemeral `cc-trident-fire-*` substrate PER repo cwd
    // (distinct instance id), reused across fires so that repo's background
    // workflows accumulate in ONE responsive REPL (the verified N-parallel model)
    // and survive the turn settle. NO `enableToolBridge` (Workflow is a native CC
    // tool, not an MCP bridge tool); NO `ephemeral` (warm — an ephemeral REPL
    // would be disposed on settle and abort the detached workflow). Null pool
    // leaves `composition.trident` unset → the loop's restart-safe stub no-op.
    const fireSubstrateByCwd = new Map<string, Substrate>()
    const makeWarmFireSubstrate = (cwd: string): Substrate => {
      const cached = fireSubstrateByCwd.get(cwd)
      if (cached !== undefined) return cached
      if (llmPool === null) throw new Error('cc-trident-fire: empty Anthropic credential pool')
      // djb2 over the cwd → a short, stable, per-repo instance discriminator.
      let h = 5381
      for (let i = 0; i < cwd.length; i++) h = (((h << 5) + h) ^ cwd.charCodeAt(i)) >>> 0
      const built = buildLlmCallSubstrate({
        pool: llmPool,
        substrate_instance_id: `cc-trident-fire-${internal_handle}-${h.toString(36)}`,
        cwd,
        internal_handle,
        user_id: OWNER_USER_ID,
        project_slug,
        skip_permissions: true,
        ...(substrateFactory !== undefined ? { substrateFactory } : {}),
      })
      if (built === null) throw new Error('cc-trident-fire: empty Anthropic credential pool')
      fireSubstrateByCwd.set(cwd, built)
      return built
    }
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
    const dispatchBoardHolder: { store: WorkBoardStore | null } = { store: null }
    const dispatchBoardBinder: DispatchBoardBinder = {
      get: (slug, id) => dispatchBoardHolder.store?.get(slug, id) ?? null,
      attachRun: async (slug, id, run_id) => {
        await dispatchBoardHolder.store?.attachRun(slug, id, run_id)
      },
      clearRun: async (slug, id, run_id) => {
        await dispatchBoardHolder.store?.clearRun(slug, id, run_id)
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
    const realmodeCleanups: Array<() => void> = []

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

    // ── Scribe: chat-time entity extraction → GBrain (P0 daily-driver) ─────
    // gap-audit P0-3 / cat 7: the scribe package (`scribe/`) ships the whole
    // extract→GBrain path AND the chat-bridge fires `scribeOnUserTurn` after
    // every real user turn — but the param is OPTIONAL and the Open self-host
    // composer never threaded it, so chat-time extraction was DEAD in Open:
    // every person/company mention stayed a manual wiki entry. This wires it ON.
    //
    // A DEDICATED `cc-scribe-*` substrate (not the conversational `cc-agent-*`
    // one) keeps background extraction isolated from the live chat REPL — scribe
    // is a stateless one-shot caller (build-llm-call-substrate.ts names it
    // explicitly), so `ephemeral: true` gives per-extraction isolation on the
    // persistent substrate rather than accumulating extraction prompts into a
    // chat transcript. Gated on `llmPool` exactly like every other substrate:
    // LLM-less boxes have no extractor, so scribe stays off and the chat path is
    // unaffected (`scribeOnUserTurn` omitted → bridge no-ops).
    const scribeSubstrate =
      llmPool !== null
        ? buildLlmCallSubstrate({
            pool: llmPool,
            substrate_instance_id: `cc-scribe-${internal_handle}`,
            cwd: owner_home,
            internal_handle,
            user_id: OWNER_USER_ID,
            project_slug,
            skip_permissions: true,
            ephemeral: true,
            ...(substrateFactory !== undefined ? { substrateFactory } : {}),
          })
        : null

    // GBrain memory wiring is the scribe write target. `buildGBrainMemory` is
    // LAZY + FAIL-SOFT by contract: it emits ONE loud boot warning when the
    // `gbrain` binary is absent from PATH, then every memory op degrades to a
    // single latched failure (the entity page still lands on disk; only the
    // GBrain fan-out no-ops). So a missing/unresolvable GBrain NEVER crashes a
    // chat turn — it degrades with a clear log, exactly as the spec requires.
    // Built only when scribe can run (there is no point standing up a write
    // target with no extractor to feed it).
    // GBrain wiring is hoisted out of the scribe closure so the SAME syncHook
    // feeds three consumers: the chat-time scribe (below), the onboarding
    // materializer's project-page indexer (threaded into `buildLandingStack` as
    // `importGbrainSyncHook` so imported/onboarding projects land in MEMORY/
    // gbrain — previously unwired in Open), and the Path 1 onboarding finalize.
    // Lazy + fail-soft: building it never spawns `gbrain serve` until first use.
    //
    // ND1: activate GBrain semantic embeddings from the owner's onboarding-
    // captured OpenAI key (ApiKeyStore, provider=openai label=onboarding;
    // internal_handle == project_slug). When present, GBrain serves with
    // OpenAI `text-embedding-3-large`; absent → keyword + graph default.
    //
    // LAZY resolution (not an eager read here): this composition runs ONCE at
    // process boot, but the key is captured LATER — during onboarding / via the
    // admin Integrations surface, over the already-running server. An eager read
    // at boot would miss every freshly-pasted key until a restart (the bug:
    // "Openai embeddings key is supposed to be wired to Gbrain"). Threading a
    // resolver thunk instead defers the read to the FIRST `gbrain serve` spawn
    // (first memory op, after onboarding), so the key flips on embeddings at the
    // next turn — exactly what the onboarding offer promises. Best-effort: the
    // resolver swallows store errors and returns undefined (keyword + graph).
    const gbrainMemory = buildGBrainMemory({
      owner_home,
      project_slug,
      env,
      resolveOpenAiKey: () =>
        resolveOnboardingOpenAiKey({ db, owner_home, internal_handle, project_slug }),
    })
    realmodeCleanups.push(() => {
      void gbrainMemory.close().catch(() => undefined)
    })
    const gbrainSyncHook = gbrainMemory.syncHook
    const scribe: Scribe | null =
      scribeSubstrate !== null
        ? createScribe({
            substrate: scribeSubstrate,
            syncHook: gbrainSyncHook,
            ownerDataDir: owner_home,
            project_slug,
            budget: createState(defaultStatePath(owner_home)),
          })
        : null

    // ── Reflection: diary + corrections-log (P1 daily-driver, gap-audit §(c) #10) ──
    // The lightweight self-improvement loop COMPLEMENTING scribe/GBrain (which
    // capture entity knowledge). Two stores under the owner home:
    //   - diary/        — the agent's own append-only short reflections
    //   - corrections/  — owner corrections of the agent (what was wrong / right
    //                     / why), read back into context so future sessions adapt
    //                     SILENTLY (Vajra's corrections-log mechanism).
    // The correction JUDGE is an LLM call, so it gets its OWN dedicated ephemeral
    // `cc-reflection-*` substrate (per-judgement isolation, never pollutes the
    // chat REPL) — same shape as scribe's `cc-scribe-*`. When LLM-less the
    // substrate is omitted: detection is OFF but the diary + context read-back
    // still function, so the layer degrades gracefully.
    const reflectionSubstrate =
      llmPool !== null
        ? buildLlmCallSubstrate({
            pool: llmPool,
            substrate_instance_id: `cc-reflection-${internal_handle}`,
            cwd: owner_home,
            internal_handle,
            user_id: OWNER_USER_ID,
            project_slug,
            skip_permissions: true,
            ephemeral: true,
            ...(substrateFactory !== undefined ? { substrateFactory } : {}),
          })
        : null
    const reflection: Reflection = createReflection({
      ownerDataDir: owner_home,
      ...(reflectionSubstrate !== null ? { substrate: reflectionSubstrate } : {}),
    })

    // Production-shape hook threaded into `buildLandingStack` → the chat-bridge.
    // `scribe` is `const`, so TS preserves the `!== null` narrowing inside the
    // closure (the extraction is fire-and-forget; `handleUserTurn` returns void
    // and swallows its own errors — it never throws into the chat path).
    const scribeOnUserTurn: ((input: UserTurnInput) => void) | undefined =
      scribe !== null ? (input: UserTurnInput): void => scribe.handleUserTurn(input) : undefined

    // ── Cores→scribe phase-2 fan-out (Vajra parity gap #1) ─────────────────
    // The chat-turn extractor (`scribeOnUserTurn` above) is only HALF of scribe:
    // the phase-2 Cores→scribe fan-out lets the scheduled Calendar + Email Cores
    // contribute their OWN ambient extraction (today's events / inbox mail →
    // GBrain). That seam (`scribeFanOut` in `gateway/cores/{calendar,email-managed}
    // -wiring.ts`) was built but never threaded — its only callers were tests, so
    // per-Core memory extraction was DEAD. Mount it here so it runs on the live
    // single-owner Open boot path, gated on scribe being live (no extraction
    // target otherwise — LLM-less boxes are unaffected). Until a Google-backed
    // calendar/gmail client is composed in (separate parity gap), the in-memory
    // fallback clients yield an empty calendar/inbox, so the schedulers run
    // harmlessly and fan out nothing; the wire goes live with zero further
    // changes the moment a real client is supplied. Cleanup drains in-flight
    // extractions + tears the schedulers down at SIGTERM.
    if (scribe !== null) {
      const coresFanOut = mountCoresScribeFanOut({
        scribe,
        project_slug,
        owner_home,
      })
      realmodeCleanups.push(() => {
        void coresFanOut.stop().catch(() => undefined)
      })
    }

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
      // Settings Core (M1) — when `update_agent_name` / `update_personality`
      // rewrites SOUL.md, drop the persona-loader cache entry so the change is
      // spliced into the system prompt on the very next turn (the atomic write
      // also bumps mtime as a backstop). Same loader instance the live agent
      // turns read through.
      onPersonaReload: (filename) => personaLoader.invalidate(filename),
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
            isWarmReady: (): boolean => prewarmSettled,
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
    // Conversational freeform router — only fires when
    // `NEUTRON_ONBOARDING_CONVERSATIONAL` is enabled (platform adapter gate),
    // but wiring it costs nothing and shares the same warm client.
    const llmRouter =
      onboardingAnthropicClient !== null
        ? buildGatewayLlmRouter({
            anthropicClient: onboardingAnthropicClient,
            personaLoader,
          })
        : undefined
    // Per-project opening message (Item 11) — consumed by the default-built
    // onboarding handoff inside `buildLandingStack` to compose a custom,
    // synthesis-grounded opener per project instead of the generic template.
    const projectOpeningComposer =
      onboardingAnthropicClient !== null
        ? buildProjectOpeningMessageComposer({ anthropicClient: onboardingAnthropicClient })
        : undefined
    // Wow-moment picker (Item 1 root cause + Item 8) — the `LlmCallFn` the
    // wow dispatcher uses to choose + word the per-project overnight/background
    // items from the synthesis. Same warm substrate, BEST_MODEL.
    const wowPickerLlm =
      llmCallSubstrate !== null
        ? buildAnthropicLlmCall({ substrate: llmCallSubstrate })
        : undefined

    // WAVE 2 Track A — per-project persona resolver. Reads the canonical
    // `projects.persona` label (the same column the settings drawer + onboarding
    // write) for a project topic so each project topic's dedicated warm CC
    // session adopts ITS persona on top of the owner-wide SOUL/USER doctrine.
    // A closure over `db` (NOT a captured value), re-run per first-turn so a
    // persona edited mid-session lands on the next cold topic. Best-effort: a
    // transient SQLite error degrades to the owner-wide persona alone.
    const projectPersonaResolver = buildProjectPersonaResolver(db)

    const liveAgentTurnFactory =
      liveAgentSubstrate !== null
        ? (pieces: {
            buttonStore: import('../channels/button-store.ts').ButtonStore
            transcript: import('../onboarding/interview/transcript.ts').TranscriptWriter
          }) =>
            buildLiveAgentTurn({
              substrate: liveAgentSubstrate,
              personaLoader,
              projectPersonaResolver,
              reflection,
              buttonStore: pieces.buttonStore,
              transcript: pieces.transcript,
              project_slug,
              owner_home,
            })
        : undefined

    // ── Single-owner session + first-prompt-on-connect ─────────────────────
    // The cookie secret is the single shared HMAC secret for both the session
    // cookie AND the local start-token. open/server.ts guarantees it is set
    // (it generates an ephemeral one when unset), but default defensively so
    // the composer never throws on a missing secret.
    const cookieSecret =
      env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] ?? `open-ephemeral-${internal_handle}`
    const startTokenAuth = buildLocalStartTokenAuth(cookieSecret)

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
    const landing = buildLandingStack({
      installTokenHandler,
      db,
      project_slug,
      owner_home,
      appWsButtonPromptRouter,
      appWsImportProgressRouter,
      // JWKS is a required field but inert on Open — our start-token verifier
      // is HMAC and never resolves a JWKS key. Pass a never-fetched URL.
      jwks: new JwksCache('https://invalid.local/.well-known/jwks.json'),
      static_dir,
      internal_handle,
      // No slug-rename machinery on Open — the shim store always misses.
      slugHistoryStore: { lookup: async () => null },
      platform,
      cookieToUserClaim,
      cronJobs,
      // FIX 2 — share the single-use JTI store so the HTTP cookie-mint gate and
      // any bridge-side claim consume the SAME token namespace (a token claimed
      // at one gate can never be replayed at the other).
      consumedTokens,
      // ISSUES #318 — app-level Claude-auth gate (defense in depth for the
      // installer gate). When the box boots with NO substrate credential,
      // `GET /chat` renders an "Authenticate Claude" page instead of a chat
      // that silently produces nothing. Evaluated per request (reads live env)
      // so a restart-with-token clears it. Same credential predicate the
      // composer's substrate wiring uses (`resolveOpenLlmPool`).
      chatAuthGate: { isUnauthenticated: () => resolveOpenLlmPool(env) === null },
      ...(phaseSpecResolver !== null ? { phaseSpecResolver } : {}),
      ...(liveAgentTurnFactory !== undefined ? { liveAgentTurnFactory } : {}),
      // ONE warm LLM path (see construction above) — wiring these is the
      // fix for the `pickerLlm not configured` deterministic-fallback bug
      // class the owner hit live. All route through the same `cc-llm`
      // warm interview session; omitted (undefined) only when LLM-less.
      ...(personalityCharacterSuggester !== undefined
        ? { personalityCharacterSuggester }
        : {}),
      // agentNameSuggester intentionally NOT wired (DROP the agent-NAME step,
      // 2026-07-01) — Open onboarding never names the orchestrator.
      ...(personaSummarizer !== undefined ? { personaSummarizer } : {}),
      ...(llmRouter !== undefined ? { llmRouter } : {}),
      ...(projectOpeningComposer !== undefined ? { projectOpeningComposer } : {}),
      ...(wowPickerLlm !== undefined ? { wowPickerLlm } : {}),
      // Warm accumulating synthesis substrate — `buildLandingStack` threads it
      // into `buildSynthesisSession` → `buildSynthesisImportJobRunner` so the
      // live import reads the whole export through ONE warm `claude` REPL that
      // ACCUMULATES a user-model across passes (NO `reset_context_per_turn`, NO
      // `/clear`). The per-chunk `buildImportJobRunnerHook` path is retired from
      // the live onboarding flow (Step 2b, 2026-06-17). `importUseSynthesis`
      // opts THIS single-owner composer onto the synthesis runner.
      ...(importSubstrate !== null ? { importSubstrate } : {}),
      importUseSynthesis: true,
      // Path 1 (2026-06-27) — thread the SHARED GBrain syncHook into the
      // onboarding/import project-page indexer so materialized projects fan out
      // to MEMORY/gbrain (`entities/projects/<slug>.md` + gbrain put_page), not
      // disk-only. Previously unwired in Open, so imported insights never
      // reached the agent's memory recall (build-landing-stack.ts:1016).
      importGbrainSyncHook: gbrainSyncHook,
      // Scribe chat-time extraction (P0 daily-driver, gap-audit cat 7). When the
      // box has LLM creds, a real user turn fans into scribe's extract→GBrain
      // path; LLM-less, this is omitted and the chat-bridge no-ops the hook.
      ...(scribeOnUserTurn !== undefined ? { scribeOnUserTurn } : {}),
      // Chat-command filters routed BEFORE the LLM turn, chained in order:
      //   - Free Cores (parity gap #2) — `/cal` / `/email` / `/note` /
      //     `/remind` / `/research` (sharing each Core's MCP-tool backend).
      //   - Skill-forge (parity gap #5) — `/skills` (list / approve / decline),
      //     sharing the SAME `SkillForgeBackend` as the `skill_forge_*` MCP
      //     tools (agent-native parity).
      // Each filter returns null for a non-match, so the chain falls through to
      // the LLM exactly as a single filter would.
      chatCommandFilter,
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
    const importWatchHolder: { watch?: (user_id: string) => void } = {}
    const engineForUpload: Pick<typeof landing.engine, 'notifyImportUpload'> = {
      notifyImportUpload: async (input) => {
        const result = await landing.engine.notifyImportUpload(input)
        importWatchHolder.watch?.(input.user_id)
        return result
      },
    }
    // Single-owner POSIX identity — the process uid/gid the owner runs as.
    const uploadUid = process.getuid?.() ?? 0
    const uploadGid = process.getgid?.() ?? 0

    const { buildImportUploadHandler, TOPIC_ID_FALLBACK, TOPIC_ID_HEADER } =
      await import('../gateway/upload/import-upload-handler.ts')
    // Bare single-shot `POST /api/upload/<source>` handler. Writes the export
    // ZIP to `<owner_home>/imports/<source>.zip` then notifies the engine.
    const import_upload_handler = buildImportUploadHandler({
      owner_home,
      uid: uploadUid,
      gid: uploadGid,
      project_slug,
      engine: engineForUpload,
      onTopicIdMissing: () => {
        console.warn(
          `[upload] open ${TOPIC_ID_HEADER} missing — falling back to topic_id=${TOPIC_ID_FALLBACK}. The engine's post-upload button emit is dropped unless a sender is registered for ${TOPIC_ID_FALLBACK}.`,
        )
      },
    })

    // Chunked resumable upload handler — owns
    // `POST /api/upload/<source>/start`,
    // `PATCH /api/upload/<source>/<upload_id>`, and
    // `HEAD /api/upload/<source>/<upload_id>`. Shares the engine + owner_home +
    // uid/gid + `notifyImportUpload` bridge with the bare handler so the
    // post-upload advance fires identically. Per-upload session state persists
    // in `upload_sessions` (migration 0048) on the single-owner project.db; a
    // long-lived sweeper marks expired sessions + unlinks partial files and is
    // torn down via `realmode_cleanups` on shutdown.
    const { buildChunkedUploadHandler } = await import(
      '../gateway/upload/chunked-upload-handler.ts'
    )
    const { SqliteUploadSessionStore } = await import(
      '../gateway/upload/upload-session-store.ts'
    )
    const { ChunkedUploadSweeper } = await import(
      '../gateway/upload/chunked-upload-sweeper.ts'
    )
    const uploadSessionStore = new SqliteUploadSessionStore(db)
    const chunked_upload_handler = buildChunkedUploadHandler({
      owner_home,
      uid: uploadUid,
      gid: uploadGid,
      project_slug,
      engine: engineForUpload,
      store: uploadSessionStore,
      onTopicIdMissing: () => {
        console.warn(
          `[chunked-upload] open ${TOPIC_ID_HEADER} missing — falling back to topic_id=${TOPIC_ID_FALLBACK}.`,
        )
      },
    })
    const uploadSweeper = new ChunkedUploadSweeper({
      store: uploadSessionStore,
      owner_home,
      project_slug,
    })
    uploadSweeper.start()
    realmodeCleanups.push(() => {
      try {
        uploadSweeper.stop()
      } catch {
        // best-effort shutdown cleanup
      }
    })

    // Import-resume route (`POST /api/import/<job_id>/resume`) — mounted
    // against the SAME runner / payload-resolver / state-store the engine
    // drives so tapping the chat `resume_import` button after a parse failure
    // doesn't 404. `buildLandingStack` surfaces all three on the engine return
    // shape; they are non-null whenever the engine built a default runner.
    let import_resume_handler: CompositionInput['import_resume_handler']
    const resumeRunner = landing.importJobRunner
    const resumePayloadResolver = landing.importPayloadResolver
    const resumeStateStore = landing.stateStore
    if (resumeRunner !== null && resumePayloadResolver !== null) {
      const { buildImportResumeHandler } = await import(
        '../gateway/upload/import-resume-handler.ts'
      )
      import_resume_handler = buildImportResumeHandler({
        db,
        project_slug,
        owner_home,
        runner: resumeRunner,
        payloadResolver: resumePayloadResolver,
        stateStore: resumeStateStore,
      })
    } else {
      console.warn(
        `[composer] open import-resume handler NOT mounted — runner=${resumeRunner !== null} resolver=${resumePayloadResolver !== null}. resume_import button in chat will 404 if tapped.`,
      )
    }

    // Wrap the landing fetch with a thin single-owner auth gate: a fresh
    // visit (no session cookie) mints the owner session cookie AND a one-shot
    // local start-token, then bounces to /chat?start=<token> so the chat
    // client opens the WS with the token → engine.start → first onboarding
    // prompt. A returning visit (valid cookie) serves chat.html directly and
    // the WS resumes via the cookie-only path — BUT only when there is real
    // resumable state (see `coldStartRedirect` / `hasResumableState` below).
    //
    // Mint a fresh owner cookie + one-shot local start-token and 302 to the
    // PROVEN cold-start path (/chat?start=<token> → engine.start → first
    // onboarding prompt). Used both for a no-cookie visit AND for the
    // stale-cookie fallback so a valid-but-unresumable cookie funnels into the
    // exact same working path instead of a loader that spins forever.
    const coldStartRedirect = (url: URL): Response => {
      const token = startTokenAuth.mint({ project_slug, user_id: OWNER_USER_ID })
      const headers = new Headers({
        location: `/chat?start=${encodeURIComponent(token)}`,
      })
      headers.append('set-cookie', formatOwnerSetCookie(project_slug, cookieSecret, url))
      return new Response(null, { status: 302, headers })
    }

    // Does this owner have an onboarding session worth resuming? A returning
    // visit with a valid cookie is only safe to serve chat.html (→ cookie-only
    // WS resume) when there is real resumable state. A fresh/wiped DB (no
    // `onboarding_state` row — the owner re-ran install.sh, the data dir was
    // cleared, or onboarding never started) has nothing to resume: the
    // cookie-only WS open registers a sender but the General topic re-emits
    // NOTHING, so the client wedges on the "Setting things up…" loader forever
    // (the loader only clears when the first real content lands). In that case
    // we MUST fall back to the cold-start path so a valid-but-stale cookie can
    // never strand the client.
    const hasResumableState = async (): Promise<boolean> => {
      try {
        const row = await landing.stateStore.get(project_slug, OWNER_USER_ID)
        return row !== null
      } catch (err) {
        // Fail toward cold-start: if the state row can't be read we can't
        // prove a resume will land, and a hung loader is strictly worse than
        // a fresh onboarding bounce. `engine.start` is idempotent — it
        // re-emits the CURRENT phase prompt — so cold-starting a user who
        // actually had state simply re-surfaces where they left off.
        console.warn(
          '[open] hasResumableState read threw — treating as no resumable state (cold-start):',
          err,
        )
        return false
      }
    }

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
    // The rail row shape shared by the page bootstrap injection AND the live
    // `projects_changed` app-ws emit — id + label + the rail-redesign fields
    // (emoji / unread / activity). Ordered most-recent-activity-first so an
    // active project floats to the top; a legacy row with a NULL activity key
    // falls back to updated_at (COALESCE) rather than sinking.
    const readProjectRows = (): {
      id: string
      label: string
      emoji: string
      unread: number
      last_activity_at: string
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
          }))
      } catch {
        return []
      }
    }
    const projectsBootstrapScript = (): string => {
      const projects = readProjectRows()
      // Escape `<` so a project name can never break out of the <script> context.
      const enc = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c')
      const active = projects.length > 0 ? enc(projects[0]!.id) : 'null'
      // Codex r1 [P1] — Open's `?start=` token is a local HMAC payload, NOT a JWT
      // with a `sub` claim, so `chat-react/config.ts:decodeJwtSub` returns null
      // and the client throws `ChatBootstrapError` before it can open
      // `/ws/app/chat`. Inject the owner identity explicitly so the client
      // derives `userId` (→ its default `dev:<owner>` app-ws bearer, the one our
      // owner-restricted resolver accepts) and connects.
      return (
        `<script>window.__neutron_user_id=${enc(OWNER_USER_ID)};` +
        `window.__neutron_projects=${enc(projects)};` +
        `window.__neutron_active_project_id=${active};</script>`
      )
    }
    // BUG 1 (auto-start) — tell the React client whether THIS owner is still
    // onboarding so a fresh session shows the auto-start loader ("Setting things
    // up…") instead of the steady-state "Send a message to begin." empty state.
    // Mirrors `isOnboardingActive` below: no `onboarding_state` row OR a
    // non-terminal phase ⇒ active. Kept as a SEPARATE injected <script> from
    // `projectsBootstrapScript` (and away from the `?start=` gate) to minimise
    // the merge surface with the in-flight forge-p2-followups edits.
    const onboardingBootstrapScript = (): string => {
      let active = false
      try {
        const row = db
          .prepare<{ phase: string }, [string, string]>(
            `SELECT phase FROM onboarding_state WHERE project_slug = ? AND user_id = ?`,
          )
          .get(project_slug, OWNER_USER_ID)
        active = row == null ? true : row.phase !== 'completed' && row.phase !== 'failed'
      } catch {
        // Unknown (no table yet / read error) → false so a steady-state chat
        // never wedges on the loader; a genuinely-fresh onboarding briefly shows
        // the plain empty state before the server's opener lands.
        active = false
      }
      return `<script>window.__neutron_onboarding_active=${active ? 'true' : 'false'};</script>`
    }
    // Managed post-onboarding claim redirect — a CONFIG passthrough, not a flag.
    // When env `NEUTRON_POST_ONBOARDING_CLAIM_URL` is set (the Managed overlay
    // points it at the control-plane `/claim`), inject it into the page bootstrap so the
    // React client can navigate there when it receives the `onboarding_completed`
    // frame. When UNSET (the Open self-host default) NOTHING is injected — the
    // client's config reads `undefined` and the redirect no-ops. There is ONE
    // code path (redirect-if-present); absence of the env is the "off" state.
    const claimBootstrapScript = (): string => {
      const claimUrl = env['NEUTRON_POST_ONBOARDING_CLAIM_URL']
      if (typeof claimUrl !== 'string' || claimUrl.length === 0) return ''
      // Escape `<` so the URL can never break out of the <script> context.
      const enc = JSON.stringify(claimUrl).replace(/</g, '\\u003c')
      return `<script>window.__neutron_post_onboarding_claim_url=${enc};</script>`
    }
    const withReactBootstrap = async (res: Response | Promise<Response>): Promise<Response> => {
      const r = await res
      const ct = r.headers.get('content-type') ?? ''
      if (!ct.includes('text/html')) return r
      const html = await r.text()
      // No-op if the React shell marker isn't present (e.g. the auth-gate page).
      if (!html.includes('/chat-react.js')) {
        const headers = new Headers(r.headers)
        return new Response(html, { status: r.status, headers })
      }
      const claimScript = claimBootstrapScript()
      const injected = html.replace(
        '<script type="module" src="/chat-react.js"></script>',
        `${projectsBootstrapScript()}\n${onboardingBootstrapScript()}` +
          `${claimScript.length > 0 ? `\n${claimScript}` : ''}` +
          `\n<script type="module" src="/chat-react.js"></script>`,
      )
      const headers = new Headers(r.headers)
      headers.delete('content-length')
      return new Response(injected, { status: r.status, headers })
    }

    // FIX 2 — verify + atomically claim a one-shot `?start=` token at the HTTP
    // cookie-mint gate. Returns true ONLY for the FIRST presentation of a
    // valid, unexpired, unclaimed token; every replay (bad signature, expired,
    // or already-claimed JTI) returns false so the gate refuses to mint a fresh
    // owner cookie. The `resolveKey` arg satisfies the DI verifier shape — the
    // local HMAC verifier never calls it (single owner, one shared secret).
    const claimStartToken = async (token: string): Promise<boolean> => {
      try {
        const payload = await startTokenAuth.verifyStartToken({
          token,
          resolveKey: async () => null,
        })
        await startTokenAuth.claimStartTokenJti({
          jti: payload.jti,
          expires_at_ms: payload.expires_at_ms,
          consumedTokens,
        })
        return true
      } catch {
        return false
      }
    }

    const openFetch = (
      req: Request,
      server: import('bun').Server<unknown>,
    ): Response | Promise<Response> => {
      const url = new URL(req.url)
      const isGet = req.method === 'GET'
      const hasValidCookie =
        isGet && readSessionCookie(req, cookieSecret, Date.now()) === project_slug
      const hasStart = url.searchParams.has('start')

      // Bare root → the onboarding/chat product entry point. A valid cookie
      // bounces to /chat (where the resumable-state check below runs); a fresh
      // visitor cold-starts directly.
      if (isGet && url.pathname === '/') {
        if (hasValidCookie) {
          return new Response(null, { status: 302, headers: { location: '/chat' } })
        }
        return coldStartRedirect(url)
      }

      // Fresh /chat visit (no cookie, no token) → cold-start.
      if (isGet && url.pathname === '/chat' && !hasStart && !hasValidCookie) {
        return coldStartRedirect(url)
      }

      // Returning /chat visit WITH a valid cookie but no `?start=` token:
      // serve chat.html ONLY when there's resumable state; otherwise cold-start
      // so a valid-but-stale cookie over a fresh/wiped DB can never wedge the
      // client on the "Setting things up…" loader. The happy path (a real
      // in-progress / completed session has an `onboarding_state` row) still
      // serves chat.html and resumes via the cookie-only WS path unchanged.
      if (isGet && url.pathname === '/chat' && !hasStart && hasValidCookie) {
        return hasResumableState().then((resumable) =>
          resumable ? withReactBootstrap(landing.fetch(req, server)) : coldStartRedirect(url),
        )
      }

      // SPA client-route deep link (doc-link 404 fix) — a HARD load / share of
      // a project-scoped URL (e.g. `/projects/<id>/docs?path=…`, the P-A
      // doc-reference link). It serves the SAME chat-react shell as /chat, so it
      // needs the SAME owner cookie-mint + React-bootstrap injection: without the
      // injected `__neutron_user_id` / `__neutron_projects` the client throws
      // ChatBootstrapError and never opens the doc. A no-cookie/no-token visit
      // mints the owner cookie and bounces back to the SAME deep link
      // (preserving the doc path — unlike /chat's cold-start, which resets to
      // onboarding); the reload then carries a valid cookie and serves the
      // injected shell, which client-routes to the doc (`ProjectShell` boot-open).
      if (isGet && isSpaClientRoute(url.pathname, req.method)) {
        if (!hasValidCookie && !hasStart) {
          const headers = new Headers({ location: `${url.pathname}${url.search}` })
          headers.append('set-cookie', formatOwnerSetCookie(project_slug, cookieSecret, url))
          return new Response(null, { status: 302, headers })
        }
        const spaRes = landing.fetch(req, server)
        if (!hasValidCookie) {
          // Arrived with a `?start=` token (a shared link opened in a fresh
          // browser that already went through the mint bounce): claim it
          // single-use + mint the cookie, then inject + serve — identical to the
          // /chat `?start=` gate below.
          const startToken = url.searchParams.get('start')
          return (async (): Promise<Response> => {
            const minted = startToken !== null ? await claimStartToken(startToken) : false
            const r = await withReactBootstrap(spaRes)
            const headers = new Headers(r.headers)
            if (minted) {
              headers.append('set-cookie', formatOwnerSetCookie(project_slug, cookieSecret, url))
            }
            return new Response(r.body, { status: r.status, headers })
          })()
        }
        return withReactBootstrap(spaRes)
      }

      // Otherwise serve via the landing server, ensuring the owner cookie is
      // set on the /chat page load so the WS reconnect path works.
      const res = landing.fetch(req, server)
      // Cookie-mint gate: a `/chat` load WITHOUT a valid cookie reaches here only
      // with a `?start=` token (the no-cookie/no-token case cold-starts above).
      // FIX 2 — make that token single-use: verify + claim its JTI and mint the
      // owner cookie ONLY on the first claim. A replayed/invalid token still
      // serves the page but mints NO cookie, so a leaked `?start=` URL can grant
      // the owner session at most once within its TTL.
      if (isGet && url.pathname === '/chat' && !hasValidCookie) {
        const startToken = url.searchParams.get('start')
        return (async (): Promise<Response> => {
          const minted = startToken !== null ? await claimStartToken(startToken) : false
          const r = await withReactBootstrap(res)
          const headers = new Headers(r.headers)
          if (minted) {
            headers.append('set-cookie', formatOwnerSetCookie(project_slug, cookieSecret, url))
          }
          return new Response(r.body, { status: r.status, headers })
        })()
      }
      // A /chat load WITH a valid cookie (e.g. arriving with a fresh `?start=`)
      // still needs the project bootstrap injected.
      if (isGet && url.pathname === '/chat') {
        return withReactBootstrap(res)
      }
      return res
    }

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
        // `listIdleTopics` lands. See AS-BUILT for the follow-up.
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
    const workBoardStore = new WorkBoardStore(db, {
      onChange: (): void => {
        try {
          const nowMs = Date.now()
          const frame: AppWsOutboundWorkBoardChanged = {
            v: 1,
            type: 'work_board_changed',
            items: workBoardStore.list(project_slug).map((it) => {
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
            ts: nowMs,
          }
          appWsRegistry.send(appWsTopicId(OWNER_USER_ID), frame)
        } catch (err) {
          console.warn(
            `[work-board] event=push_failed project=${project_slug} err=${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      },
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
            const result = await dispatchBoardBoundBuild(
              { board_item_id: item.id, task },
              {
                store: boardRunStore,
                board: workBoardStore,
                project_slug: slug,
                repo_path: owner_home,
                channel_kind: 'app_socket',
              },
            )
            if (result.ok) return { ok: true, run_id: result.run.id }
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
    dispatchBoardHolder.store = workBoardStore

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
    const appProjectsSurface = createAppProjectsSurface({
      store: new SqliteProjectSettingsStore(db),
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
    const onboardingMsgHolder: {
      emit?: (input: {
        user_id: string
        project_id: string | null
        body: string
        dedupe_key: string
      }) => Promise<void>
    } = {}
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
              onboardingMsgHolder.emit?.(input) ?? Promise.resolve(),
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
        const raw = db.raw()
        const job = raw
          .query<{ one: number }, [string]>(
            `SELECT 1 AS one FROM import_jobs
               WHERE project_slug = ?
                 AND status NOT IN ('completed', 'failed', 'cancelled')
               LIMIT 1`,
          )
          .get(project_slug)
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
        const upload = raw
          .query<{ one: number }, [string, number]>(
            `SELECT 1 AS one FROM upload_sessions
               WHERE project_slug = ?
                 AND status = 'uploading'
                 AND expires_at > ?
               LIMIT 1`,
          )
          .get(project_slug, Date.now())
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
            // escaped `<work_board>` DATA block for the active+next items.
            workBoardSnapshot: (slug: string): string =>
              formatWorkBoardFragment(workBoardStore.listActive(slug)),
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
    // adapter ↔ receiver are mutually referential (the receiver replies via
    // `adapter.send`); a holder breaks the cycle without a `used-before-assigned`
    // hazard. The socket cannot dispatch an inbound until boot completes, long
    // after `holder.adapter` is assigned below.
    const appWsHolder: { adapter?: AppWsAdapter } = {}
    // Path 1 auto-start de-dupe: topics whose onboarding opener we've already
    // seeded THIS process, so a quick reconnect doesn't double-open the
    // interview. Mirrors the live runner's own per-process `contextSent` guard.
    const seededOnboardingTopics = new Set<string>()
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
        if (Object.keys(adapter_options).length > 0) msg.adapter_options = adapter_options
        void appWsHolder.adapter?.send(msg)
        // Rail-redesign: an agent reply on a PROJECT topic is fresh activity —
        // stamp the project's `last_activity_at` and re-fan `projects_changed`
        // so every connected rail reorders (this project pops to the top) and
        // its unread badge updates live. Best-effort + General-exempt (a General
        // reply carries no project_id). The stamp is a tiny UPDATE; the fan is
        // an idempotent full-snapshot push, so doing it per agent turn is fine.
        if (project_id !== undefined && project_id.length > 0) {
          // Stamp THEN emit — the re-fanned frame is ordered by
          // `last_activity_at`, so the UPDATE must commit before we rebuild it or
          // this project wouldn't yet have popped to the top. Async IIFE keeps
          // the fan itself sync + non-throwing; a stamp failure still emits (the
          // frame just keeps the prior order).
          void (async (): Promise<void> => {
            try {
              await db.run(
                `UPDATE projects SET last_activity_at = ? WHERE id = ? AND deleted_at IS NULL`,
                [new Date().toISOString(), project_id],
              )
            } catch {
              /* activity stamping must never break a message turn */
            }
            emitProjectsChangedNow(OWNER_USER_ID)
          })()
        }
      }
    // Path-1 closing + per-project opening delivery (items 6/7). Deliver a
    // finalize-composed agent message the SAME way a live-agent reply is
    // delivered: persist a durable `button_prompts` history row on the topic
    // (`app:<user>` for the General closing, `app:<user>:<project>` for a
    // project opening) — the topic `chat_history_surface` hydrates from — AND
    // fan it live via `buildAppWsSendReply` (→ adapter durable chat_log + socket
    // push). So the message renders live when the owner is connected and
    // hydrates on reload, exactly like every other agent turn. Best-effort: a
    // persistence failure still ships the live message; nothing throws back into
    // finalize. NOTE (sibling client PR coordination): the React client reads a
    // project's chat off this `app:<user>:<project>` topic — the same key the
    // live-agent reply path uses — so the opening lands where the client subscribes.
    onboardingMsgHolder.emit = async ({ user_id, project_id, body, dedupe_key }): Promise<void> => {
      const channelTopic = appWsTopicId(user_id)
      const turnTopic =
        project_id !== null && project_id.length > 0
          ? `${channelTopic}:${project_id}`
          : channelTopic
      let prompt_id: string | undefined
      // Idempotency: finalize is reachable from several overlapping recovery
      // paths, so key the durable row on (instance, topic, dedupe_key). A
      // re-finalize collapses onto the SAME row (was_new=false) and we SKIP the
      // live re-send below — no duplicate closing / opening bubble. Default to
      // sending (fail-open) only when persistence itself failed (no key written).
      let wasNew = true
      try {
        const prompt = buildButtonPrompt({
          body,
          options: [],
          allow_freeform: true,
          // Long TTL so the history row never hits the unresolved-prompt ghost
          // filter (mirrors the live-agent reply row's REPLY_ROW_TTL_MS).
          expires_in_ms: 10 * 365 * 24 * 60 * 60 * 1_000,
          idempotency: { project_slug, topic_id: turnTopic, seed: dedupe_key },
          uuid: randomUUID,
        })
        const emitted = await landing.buttonStore.emit(prompt, { topic_id: turnTopic })
        prompt_id = emitted.prompt_id
        wasNew = emitted.was_new
      } catch (err) {
        console.warn(
          `[open] event=onboarding_msg_persist_failed project=${project_slug} topic=${turnTopic} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
      // A duplicate finalize already delivered this message — don't re-post it live.
      if (!wasNew) return
      const out: ChatOutbound = {
        type: 'agent_message',
        body,
        topic_id: turnTopic,
        options: [],
        allow_freeform: true,
        ...(prompt_id !== undefined ? { prompt_id } : {}),
      }
      // Live-fan on the SAME topic the durable row landed on: a per-project opening
      // must reach the PROJECT socket (`app:<user>:<project>`), not General — the
      // app-ws adapter routes + appends chat_log by `topic.channel_topic_id`, and a
      // project tab is registered under the project topic (Codex r1 P2, 2026-06-30).
      // Sending on General delivered the durable row but NEVER live-rendered to the
      // just-connected project socket, so the project-opening RECOVERY (which fires
      // from a project-topic `on_session_open`, AFTER its `session_ready` history
      // replay) left the tab empty until yet another reload. The General closing
      // (`project_id === null`) still fans on the General channel, unchanged.
      const liveChannel =
        project_id !== null && project_id.length > 0 ? turnTopic : channelTopic
      buildAppWsSendReply(liveChannel, project_id ?? undefined)(out)
    }
    // Item 1 / 4b (2026-06-30 fresh-install fix) — make a materialized project's
    // deterministic OPENING a reliable property of ENTERING the project, not a
    // fire-once side effect of finalize. finalize emits each opening eagerly at
    // onboarding completion, but that emit can race the project-tab socket, be
    // swallowed, or (under cold-turn load) the whole finalize can be delayed —
    // leaving the project topic with ZERO history rows (DB-confirmed on the live
    // box: 6 projects, 0 `app:<user>:<project>` rows) so the client wedges on its
    // empty state and a reload never recovers it (reload only regenerated the
    // GENERAL welcome). On every steady-state connect to a PROJECT topic that has
    // no message yet, regenerate + persist the SAME deterministic opening
    // (STATUS.md / README summary + one next move) finalize would have produced.
    // Idempotent: keyed on `onboarding_opening:<project_id>`, so if finalize (or a
    // prior entry) already delivered it, `buttonStore.emit` collapses onto the
    // existing row and nothing double-posts. Best-effort + non-throwing — a
    // project chat must NEVER be blocked by opening recovery.
    const onboardingOpeningDocReader = buildProjectDocReader({ owner_home })
    const ensureProjectOpeningOnEntry = async (
      user_id: string,
      channel_topic_id: string,
    ): Promise<void> => {
      try {
        const prefix = `${appWsTopicId(user_id)}:`
        // Only a per-project topic (`app:<user>:<project_id>`) — the General topic
        // has no per-project opening.
        if (!channel_topic_id.startsWith(prefix)) return
        const project_id = channel_topic_id.slice(prefix.length)
        if (project_id.length === 0) return
        // Only for a MATERIALIZED, non-deleted project — never seed an arbitrary
        // or soft-deleted topic. `readProjectRows` is the same `projects`-table
        // snapshot the rail + bootstrap use, so the id + name align exactly.
        const row = readProjectRows().find((p) => p.id === project_id)
        if (row === undefined) return
        // Only when the topic has NO message yet — never retro-inject an opening
        // above an existing conversation.
        const now = Date.now()
        const latest = await landing.buttonStore.latestTurnByTopic({
          topic_id: channel_topic_id,
          before: now,
          now,
        })
        if (latest !== null) return
        // Compose the SAME deterministic opening finalize uses, from the
        // materialized docs (STATUS.md is the highest-signal source; README is the
        // fallback; the composer degrades to a usable "added to your projects"
        // line when neither exists — so the body is NEVER empty).
        const docs: ProjectOpeningDocs = {
          readme: onboardingOpeningDocReader(project_id, 'README.md'),
          transcript_summary: onboardingOpeningDocReader(
            project_id,
            joinPath('docs', 'transcript-summary.md'),
          ),
          status_md: onboardingOpeningDocReader(project_id, 'STATUS.md'),
        }
        const composition = buildDeterministicProjectOpening(row.label, null, docs)
        const body = finalizeOpeningBody(composition.body)
        if (body.trim().length === 0) return
        await onboardingMsgHolder.emit?.({
          user_id,
          project_id,
          body,
          dedupe_key: `onboarding_opening:${project_id}`,
        })
      } catch (err) {
        console.warn(
          `[open] event=project_opening_recovery_failed project=${project_slug} topic=${channel_topic_id} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    // Chat transport — server-authoritative typing indicator. Fan an ephemeral
    // `agent_typing` frame (start/end) directly to the socket topic's live
    // devices around every live-agent turn. NOT routed through the adapter's
    // `send` (which persists + assigns a seq) — typing is ephemeral and must
    // never land in the durable log or a `resume` replay. Best-effort: a closed
    // socket / registry miss is a silent no-op (the client clears typing on the
    // next agent_message regardless, so a lost `end` can't wedge the dots).
    const emitAppWsTyping = (
      channel_topic_id: string,
      state: 'start' | 'end',
      project_id?: string,
    ): void => {
      const env: AppWsOutboundAgentTyping = {
        v: 1,
        type: 'agent_typing',
        state,
        ts: Date.now(),
      }
      if (project_id !== undefined && project_id.length > 0) env.project_id = project_id
      try {
        appWsRegistry.send(channel_topic_id, env)
      } catch {
        /* socket closed mid-turn; the start/end pair is best-effort */
      }
    }
    // Translate an engine `ButtonPrompt` → the app-ws `agent_message` envelope
    // (a superset already carrying options/prompt_id/allow_freeform/kind/
    // upload_affordance) and fan it out over the socket. Ephemeral by design:
    // the engine owns durability via `button_prompts` + an idempotent re-emit on
    // the next connect (`on_session_open` below), so we do NOT persist onboarding
    // prompts into the steady-state app chat log (which would double-render on a
    // `resume` replay).
    const emitOnboardingPrompt = (topic_id: string, prompt: ButtonPrompt): boolean => {
      const env: AppWsOutboundAgentMessage = {
        v: 1,
        type: 'agent_message',
        body: prompt.body,
        message_id: prompt.prompt_id,
        ts: Date.now(),
        prompt_id: prompt.prompt_id,
        options: prompt.options.map((o) => ({
          label: o.label,
          body: o.body,
          value: o.value,
          ...(o.image_url !== undefined ? { image_url: o.image_url } : {}),
        })),
        allow_freeform: prompt.allow_freeform,
      }
      if (prompt.kind !== undefined) env.kind = prompt.kind
      const rawAff = (prompt.metadata as Record<string, unknown> | undefined)?.['upload_affordance']
      if (rawAff !== null && typeof rawAff === 'object') {
        const src = (rawAff as { source?: unknown }).source
        if (src === 'chatgpt' || src === 'claude') env.upload_affordance = { source: src }
        // Legacy two-upload 'both' normalizes to 'chatgpt' (mirrors chat-bridge).
        else if (src === 'both') env.upload_affordance = { source: 'chatgpt' }
      }
      return appWsRegistry.send(topic_id, env)
    }
    // Path 1: onboarding conversational turns no longer go through
    // `engine.advance` — they run on the live session (see `appWsReceiver` /
    // `on_button_choice` below). The engine is retained ONLY for the import
    // subsystem (`notifyImportUpload`), so its button-prompt router is still
    // wired below for any import-side prompt it may emit.
    // Fill the late-bound onboarding button-prompt router NOW that the registry
    // exists. The engine's `sendButtonPrompt` reads this holder at call time
    // (see buildRoutedSendButtonPrompt) — `app:<user>` topics route here.
    //
    // Path 1: the engine no longer drives the conversation. Its prompts on this
    // socket are import-side only. We SUPPRESS exactly one: the SUCCESSFUL
    // `import_analysis_presented` accept button — that flow is auto-consumed by
    // the import-completion watcher (materialize without a tap), so a stray
    // "accept these projects" button would dangle (its tap routes to the live
    // session, not the engine). Every OTHER engine prompt — an import
    // parse-failure / rate-limit / resume prompt the user genuinely needs to see
    // — is emitted normally (Codex r1 [P1]). Single-owner Open has exactly one
    // onboarding user, so we key the phase lookup on the owner.
    appWsButtonPromptRouter.send = async ({ topic_id, prompt }) => {
      try {
        const st = await onboardingStateStore.get(project_slug, OWNER_USER_ID)
        const importFailed = st?.phase_state?.['import_failed'] === true
        // 2026-06-29 render-gap fix — for the successful import_analysis_presented
        // prompt, emit the rich analysis BODY (the "wow moment") with the dangling
        // accept/resume button STRIPPED, instead of suppressing the whole prompt
        // (which left the owner never seeing their import result). See
        // resolveOpenImportPromptEmission for the rationale.
        const toEmit = resolveOpenImportPromptEmission(prompt, st?.phase ?? null, importFailed)
        // Ordering fix (import-curation handoff, 2026-06-29): the SUCCESSFUL
        // import_analysis_presented body is a plain "wow moment" agent message
        // (its dangling button is stripped above, and the watcher auto-consumes
        // the phase). Delivered ephemerally via emitOnboardingPrompt it carries NO
        // chat_log `seq`, so the client sorts it to the tail and a later real-seq
        // user message renders ABOVE it (newest-at-bottom broken) — and it
        // vanishes on resume. Persist THIS one through the durable adapter
        // (chat_log → monotonic seq, replayable) so it orders with live chat.
        // Safe from double-render: on_session_open never re-sends the body, and
        // the watcher resolves the phase (active_prompt_id→null) so the engine's
        // reconnect re-emit won't re-fire it. Every OTHER onboarding prompt
        // (import failure / rate-limit / resume — real buttons) stays ephemeral,
        // since the engine owns their durability + reconnect re-emit.
        if (
          st?.phase === 'import_analysis_presented' &&
          !importFailed &&
          toEmit.options.length === 0 &&
          appWsHolder.adapter !== undefined
        ) {
          const msg: OutgoingMessage = {
            topic: {
              topic_id: '',
              channel_kind: 'app_socket',
              channel_topic_id: topic_id,
              project_id: null,
              privacy_mode: 'regular',
            },
            text: toEmit.body,
          }
          const id = await appWsHolder.adapter.send(msg)
          return { message_id: prompt.prompt_id, was_new: !id.startsWith('app-ws:dropped:') }
        }
        // Ordering + de-dupe fix (import_running status bubble, M1 2026-06-30):
        // the "Reading through your export now…" progress bubble is buttonless
        // and ephemeral, so it sorts to the chat tail and floats below later
        // messages (same seam as the analysis body above). Persist the FIRST one
        // durably (chronological seq); suppress the engine cron's re-emits so we
        // don't stack duplicates — the live import_progress banner covers ongoing
        // progress and the durable analysis body lands after on completion.
        const statusDelivery = resolveImportRunningStatusDelivery({
          phase: st?.phase ?? null,
          sub_step: st?.phase_state?.['import_running_sub_step'],
          attempt_count: st?.phase_state?.['import_running_attempt_count'],
          option_count: toEmit.options.length,
        })
        if (statusDelivery === 'suppress') {
          return { message_id: prompt.prompt_id, was_new: false }
        }
        if (statusDelivery === 'durable' && appWsHolder.adapter !== undefined) {
          const msg: OutgoingMessage = {
            topic: {
              topic_id: '',
              channel_kind: 'app_socket',
              channel_topic_id: topic_id,
              project_id: null,
              privacy_mode: 'regular',
            },
            text: toEmit.body,
          }
          const id = await appWsHolder.adapter.send(msg)
          return { message_id: prompt.prompt_id, was_new: !id.startsWith('app-ws:dropped:') }
        }
        const ok = emitOnboardingPrompt(topic_id, toEmit)
        return { message_id: prompt.prompt_id, was_new: ok }
      } catch {
        // Any lookup failure → fall through and emit (fail open, user sees it).
      }
      const ok = emitOnboardingPrompt(topic_id, prompt)
      return { message_id: prompt.prompt_id, was_new: ok }
    }
    // Import-progress over app-ws (2026-06-29): the engine's import-running cron
    // emits an `import_progress` event every ~5s while a history import runs, and
    // `buildRoutedSendImportProgress` routes `app:<user>` topics to this holder.
    // Fan it to the owner's live socket as an ephemeral `import_progress` frame
    // (mirrors `emitAppWsTyping` / `work_board_changed`): the React client renders
    // a live spinner + per-pass progress line off it, so a long import visibly
    // works instead of stalling on the one-shot "received" banner. UI-only — NOT
    // persisted, no `seq`, never replayed on `resume`. Terminal statuses still
    // deliver their analysis body via the button-prompt path above; a terminal
    // frame here just clears the client's spinner defensively. Best-effort: a
    // closed socket / registry miss is a silent non-delivery (re-emitted next tick).
    appWsImportProgressRouter.send = async ({ topic_id, event }) => {
      const env: AppWsOutboundImportProgress = {
        v: 1,
        type: 'import_progress',
        job_id: event.job_id,
        status: event.status,
        pass: event.pass,
        pct: event.pct,
        chunks_total_known: event.chunks_total_known,
        ts: Date.now(),
      }
      if (event.body !== undefined) env.body = event.body
      try {
        return { delivered: appWsRegistry.send(topic_id, env) }
      } catch {
        return { delivered: false }
      }
    }

    const appWsReceiver = {
      receive: async (event: IncomingEvent): Promise<void> => {
        if (event.channel_kind !== 'app_socket') return
        const text = event.body.text.trim()
        // Codex r1 [P2]: an attachment-only send arrives with empty text but
        // non-empty `adapter_metadata.attachments`; dropping on empty text alone
        // would swallow the turn after the echo/read-receipt (user sees no
        // reply). Only drop a TRULY empty inbound (no text AND no attachments);
        // for attachment-only, run the turn with a minimal placeholder so the
        // agent responds. (Full attachment content isn't yet threaded into
        // `LiveAgentTurnRequest` — its interface carries only `user_text`; that
        // deeper wiring is a separate follow-up, but we no longer silently drop.)
        const attachments = Array.isArray(event.adapter_metadata?.['attachments'])
          ? (event.adapter_metadata!['attachments'] as unknown[])
          : []
        if (text.length === 0 && attachments.length === 0) return
        const userText = text.length > 0 ? text : 'Sent an attachment.'
        // Path 1: ONE path. Every typed turn — onboarding OR steady-state — runs
        // through the SAME live CC session (`appWsChatTurn`). While the owner
        // isn't onboarded the live agent's onboarding seam carries the interview
        // preamble + zip affordance and the fire-and-forget post-turn extractor
        // scribes the profile. No `engine.advance`, no freeform router gate.
        const project_id =
          typeof event.adapter_metadata?.['project_id'] === 'string'
            ? (event.adapter_metadata['project_id'] as string)
            : undefined
        // The live-agent turn is keyed on a PROJECT-SCOPED warm-session topic
        // (`app:<owner>:<project_id>`) so each project gets its own warm REPL +
        // persona + button-store history (sharing the bare channel topic across
        // projects would cross-ground them).
        //   - The WEB client now binds the SOCKET per-project, so
        //     `event.channel_topic_id` is ALREADY `app:<owner>:<project_id>` —
        //     re-appending would double the suffix, so skip it when the topic
        //     already ends with `:<project_id>`.
        //   - MOBILE keeps ONE `app:<owner>` socket + a `project_id` FIELD, so
        //     the suffix IS appended there (the topic is the bare `app:<owner>`).
        // The REPLY is still delivered to the socket's real `channel_topic_id`
        // (below), since that's where the client listens.
        const turnTopicId =
          project_id !== undefined &&
          project_id.length > 0 &&
          !event.channel_topic_id.endsWith(`:${project_id}`)
            ? `${event.channel_topic_id}:${project_id}`
            : event.channel_topic_id
        const sendReply = buildAppWsSendReply(event.channel_topic_id, project_id)
        if (appWsChatTurn === null) {
          sendReply({
            type: 'agent_message',
            body:
              "I can't answer yet — this box has no AI credential configured. Add one in settings, then try again.",
          })
          // FIX 1 (#85) — still surface any project-set change (e.g. an import
          // that landed) so the rail refreshes even on the LLM-less path.
          emitProjectsChangedIfChanged(event.user.channel_user_id)
          return
        }
        // Chat transport — server-authoritative typing. Show the indicator the
        // moment the gateway picks up the turn; clear it when the turn settles
        // (finally → fires on success AND failure so the dots never wedge).
        emitAppWsTyping(event.channel_topic_id, 'start', project_id)
        try {
          await appWsChatTurn({
            project_slug,
            user_id: event.user.channel_user_id,
            // Project-scoped for warm-session/persona/history keying (Codex [P2]).
            topic_id: turnTopicId,
            ...(project_id !== undefined ? { project_id } : {}),
            user_text: userText,
            send: sendReply,
            observed_at: event.received_at,
          })
        } finally {
          emitAppWsTyping(event.channel_topic_id, 'end', project_id)
        }
        // Entity scribe → GBrain (Vajra parity) — fan the user's turn into the
        // extract→memory path, fire-and-forget + guarded, EXACTLY like the legacy
        // web chat-bridge does (chat-bridge.ts §scribe-phase-1). This was the ONLY
        // surface missing it: `/ws/app/chat` (the sole chat surface the React owner
        // UI uses) dispatches here, so without this call NO post-onboarding chat
        // turn ever extracted facts to gbrain — the store stayed empty and "recall"
        // silently fell back to in-session CC context only (fullpipe-e2e 2026-06-28
        // Stage 2 root-cause). NOTE: the onboarding seam's `onTurnComplete` (inside
        // `appWsChatTurn`) extracts the 5 PROFILE fields; this is the GENERAL entity
        // scribe (people/companies/concepts → gbrain), a distinct layer. Short turns
        // and slash commands are dropped by the scribe's own `shouldExtract` filter,
        // so seed/utility turns cost nothing. `scribeOnUserTurn` is omitted on
        // LLM-less boxes (no extractor) → this no-ops, chat path unaffected.
        if (scribeOnUserTurn !== undefined) {
          try {
            scribeOnUserTurn({
              project_slug,
              user_id: event.user.channel_user_id,
              topic_id: turnTopicId,
              text: userText,
              observed_at: event.received_at,
              // Owner-native web-chat turn → author #0 (connect-spec §4.1).
              author: { id: 'owner', display: 'owner' },
            })
          } catch (err) {
            console.warn(
              `[open] event=scribe_hook_threw project=${project_slug} topic=${turnTopicId} err=${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          }
        }
        // FIX 1 (#85) — re-wired into Path 1: after every turn, fan a
        // projects_changed frame if the set changed. Onboarding completion +
        // import materialize projects out-of-band (the fire-and-forget finalize
        // also emits directly when it creates them), so this per-turn snapshot
        // diff catches anything not already pushed — the rail refreshes live.
        emitProjectsChangedIfChanged(event.user.channel_user_id)
      },
    }
    // Chat transport (Ryan-directed best-in-class) — wire the durable per-topic
    // logs onto the app-ws adapter. ALL four back the single-owner project.db
    // (migrations 0079/0082/0083/0087). Passing them flips `hasChatLog` /
    // `hasReceipts` / `hasReactions` / `hasEdits` true, which lights up the
    // already-built surface machinery that was inert in M1:
    //   • durable chat_log + monotonic per-topic seq on every echo/agent_message
    //   • idempotent ingest on client_msg_id → the retry button + WS↔HTTP race
    //     NEVER re-run the agent turn (the `if (!was_new) return` guards trip)
    //   • `resume`/`session_ready.last_seen_seq` gap-free reconnect replay
    //   • delivered/read receipts, reactions, and edit/delete — persisted + fanned
    appWsHolder.adapter = new AppWsAdapter({
      registry: appWsRegistry,
      receiver: appWsReceiver,
      chat_log: new AppChatStore({ db }),
      receipt_log: new AppChatReceiptStore({ db }),
      reaction_log: new AppChatReactionStore({ db }),
      edit_log: new AppChatEditStore({ db }),
    })
    const appWsSurface = createAppWsSurface({
      adapter: appWsHolder.adapter,
      registry: appWsRegistry,
      auth: appOwnerAuth,
      project_slug,
      // Codex r1 [P2]: route slash commands (/note, /remind, /skills, …) through
      // the SAME chained filter the web chat uses — parity, not a second path.
      chat_command_filter: chatCommandFilter,
      // Path 1 auto-start — when the owner hasn't finished onboarding, SEED the
      // first onboarding turn through the live session on connect so Claude opens
      // with the first question under the client's auto-start loader (no user
      // message needed). The seed is a synthetic system-origin turn
      // (`seed_turn: true`) — it is NOT persisted as a user bubble and is NOT
      // scribed. The warm session is keyed per-process, so a reconnect within the
      // same process won't re-seed a duplicate opener (`contextSent` guard in the
      // live-agent runner); a fresh process re-seeds, which only repaints the
      // opening question — acceptable and idempotent enough for the loader.
      on_session_open: async ({ user_id, channel_topic_id }) => {
        // FIX 1 (#85) — seed the projects rail baseline on connect (only records
        // the pre-existing set; the post-emit below catches a seed-driven change).
        emitProjectsChangedIfChanged(user_id)
        if (await isOnboardingActive(user_id)) {
          // RECOVERY (M1 E2E Round 4, 2026-06-29) — finalize a post-import
          // onboarding that was consumed back into the conversational marker but
          // never finalized: the owner answered every field while the import was
          // synthesizing, the import landed, and they went idle (or a restart
          // landed between the watcher's consume and a finalize). On-reconnect is
          // the natural recovery point. No-op unless every required field is
          // present and no import is in flight; finalize is idempotent.
          const recoverSt = await onboardingStateStore.get(project_slug, user_id)
          if (await finalizeImportOnboardingIfReady(user_id, recoverSt)) {
            emitProjectsChangedIfChanged(user_id)
            return
          }
          // RESTART RESILIENCE (M1 E2E Round 2, 2026-06-29) — re-arm the import-
          // completion watcher on reconnect. The watcher is a purely in-memory
          // `setTimeout` chain armed ONLY inside `notifyImportUpload` (the upload
          // request). It is the single consumer of `import_analysis_presented`:
          // it transitions that phase back to `work_interview_gap_fill` so the
          // interview can finish + materialize the imported projects, and the
          // accept button for that phase is deliberately SUPPRESSED on the
          // assumption the watcher auto-consumes it. So if the server restarts
          // mid-import (redeploy / crash / `launchctl kickstart`), the watcher is
          // gone, the import-running cron (which DOES re-arm on boot) drives the
          // persisted row into `import_analysis_presented`, and nothing ever
          // consumes it — the button is hidden and the post-turn extractor refuses
          // to finalize on top of an import phase. Onboarding wedges PERMANENTLY.
          // Re-arm here (idempotent — `importWatchActive` guards a double-arm)
          // whenever the persisted phase is import-active, so a reconnect after a
          // restart resumes the consume. No-op when no import is in flight.
          if (importWatchHolder.watch !== undefined) {
            const st = await onboardingStateStore.get(project_slug, user_id)
            if (
              st !== null &&
              (st.phase === 'import_running' || st.phase === 'import_analysis_presented')
            ) {
              importWatchHolder.watch(user_id)
            }
          }
          // Onboarding is a GENERAL-TOPIC-ONLY mode: the welcome seed belongs to
          // the owner's General topic (`app:<user>`). The web client opens a
          // fresh socket per PROJECT tab (`app:<user>:<project>`), which also
          // lands here — and a project tab opened while `isOnboardingActive` is
          // still true (fire-and-forget finalize slow, or its terminal
          // `completed` upsert raced/failed) would otherwise seed the generic
          // "…what should I call you?" welcome INTO the project topic, masking
          // the deterministic per-project opening finalize already delivered. A
          // materialized project is always steady-state, so never seed it.
          const isGeneralTopic = channel_topic_id === appWsTopicId(user_id)
          if (
            isGeneralTopic &&
            appWsChatTurn !== null &&
            !seededOnboardingTopics.has(channel_topic_id)
          ) {
            seededOnboardingTopics.add(channel_topic_id)
            // Typing while the agent composes its onboarding opener.
            emitAppWsTyping(channel_topic_id, 'start')
            try {
              const seedResult = await appWsChatTurn({
                project_slug,
                user_id,
                topic_id: channel_topic_id,
                user_text:
                  '(The owner just opened the chat to begin onboarding. Greet them warmly by opening the conversation and asking your very first question now — start by asking what they would like you to call them. Do not wait for them to speak first.)',
                send: buildAppWsSendReply(channel_topic_id),
                observed_at: Date.now(),
                seed_turn: true,
              })
              // Self-heal a FAILED welcome seed (e.g. a cold spawn that still
              // timed out): the live runner stays silent on a seed failure (no
              // persisted error bubble), so CLEAR the per-process seeded mark
              // here too — otherwise this topic stays "seeded" for the process
              // and a reload/re-subscribe would skip re-firing, stranding the
              // owner on the empty "Setting things up…" loader. Dropping the mark
              // makes the next on_session_open regenerate the welcome.
              if (
                seedResult !== null &&
                typeof seedResult === 'object' &&
                (seedResult as { outcome?: unknown }).outcome === 'failed'
              ) {
                seededOnboardingTopics.delete(channel_topic_id)
              }
            } catch {
              // A throw (defensive — the runner owns its failures) must also not
              // leave the topic falsely marked seeded; let reload re-fire.
              seededOnboardingTopics.delete(channel_topic_id)
            } finally {
              emitAppWsTyping(channel_topic_id, 'end')
            }
          }
        } else {
          // STEADY STATE (onboarding done). If this connect is to a materialized
          // PROJECT topic that has no message yet, regenerate + persist its
          // deterministic opening (item 1 / 4b). No-op for the General topic, an
          // unmaterialized topic, or a project that already has chat history.
          await ensureProjectOpeningOnEntry(user_id, channel_topic_id)
          // RECOVERY (Managed post-onboarding claim redirect) — replay the one-
          // shot `onboarding_completed` signal on connect for an already-completed
          // owner when a claim URL is configured. The live frame fanned at
          // finalize is DROPPED if no socket was registered then (e.g. a
          // background import-completion watcher finalizes while the tab is
          // closed/reloading), and a reconnect sees an already-`completed` row so
          // nothing re-signals — the redirect would be lost forever. Deriving it
          // from the persisted completed state here makes it recoverable. Gated on
          // the env so it is a strict NO-OP on Open self-host; sent only to the
          // connecting topic. The client's `claimRedirected` latch keeps it at-
          // most-once per load, and once the owner claims they move to a host
          // without the env, so this never loops post-claim.
          const claimUrl = env['NEUTRON_POST_ONBOARDING_CLAIM_URL']
          if (typeof claimUrl === 'string' && claimUrl.length > 0) {
            // This branch is reached for BOTH terminal phases (`isOnboardingActive`
            // is false for `completed` AND `failed`), so gate strictly on the
            // persisted phase being exactly `completed` — a `failed` onboarding
            // never had the completion transition and must NOT redirect to claim.
            const st = await onboardingStateStore.get(project_slug, user_id)
            if (st !== null && st.phase === 'completed') {
              const completedFrame: AppWsOutboundOnboardingCompleted = {
                v: 1,
                type: 'onboarding_completed',
                ts: Date.now(),
              }
              appWsRegistry.send(channel_topic_id, completedFrame)
            }
          }
        }
        // Emit if the seed turn (or anything since the pre-seed) changed the set.
        emitProjectsChangedIfChanged(user_id)
      },
      // Path 1: ONE path — a tapped quick-reply button feeds the live session as
      // the owner's selection (its freeform text, else the choice value),
      // onboarding OR steady-state. No `engine.advance` branch (the engine no
      // longer drives conversational turns). `prompt_id` is unused now that taps
      // don't resolve engine button rows; the live runner persists the turn.
      on_button_choice: async ({
        user_id,
        channel_topic_id,
        project_id,
        choice_value,
        freeform_text,
      }) => {
        const now = Date.now()
        if (appWsChatTurn === null) return
        const turnTopicId =
          project_id !== undefined && project_id.length > 0
            ? `${appWsTopicId(user_id)}:${project_id}`
            : appWsTopicId(user_id)
        const replyText =
          freeform_text !== undefined && freeform_text.length > 0 ? freeform_text : choice_value
        // Typing while the agent works the tapped quick-reply as a turn.
        emitAppWsTyping(channel_topic_id, 'start', project_id)
        try {
          await appWsChatTurn({
            project_slug,
            user_id,
            topic_id: turnTopicId,
            ...(project_id !== undefined ? { project_id } : {}),
            user_text: replyText,
            send: buildAppWsSendReply(channel_topic_id, project_id),
            observed_at: now,
          })
        } finally {
          emitAppWsTyping(channel_topic_id, 'end', project_id)
        }
        // Entity scribe → GBrain (parity with the typed-message receiver above):
        // a freeform quick-reply answer is owner text worth extracting too, so a
        // long freeform reply doesn't silently skip memory just because it arrived
        // via a button prompt instead of the composer. Short choice values are
        // dropped by the scribe's own `shouldExtract` floor, so a bare tap costs
        // nothing. Fire-and-forget + guarded; omitted on LLM-less boxes.
        if (scribeOnUserTurn !== undefined) {
          try {
            scribeOnUserTurn({
              project_slug,
              user_id,
              topic_id: turnTopicId,
              text: replyText,
              observed_at: now,
              author: { id: 'owner', display: 'owner' },
            })
          } catch (err) {
            console.warn(
              `[open] event=scribe_hook_threw project=${project_slug} topic=${turnTopicId} err=${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          }
        }
        // FIX 1 (#85) — refresh the rail if this turn changed the project set.
        emitProjectsChangedIfChanged(user_id)
      },
    })

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
      landing_server: {
        fetch: openFetch,
        websocket: landing.websocket,
      },
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

/**
 * Build the `Set-Cookie` header value for the single owner's session. Mirrors
 * `landing/session-cookie.ts:formatSetCookie` but drops `Secure` on plain
 * http loopback (a self-hoster running `bun start` over http://127.0.0.1
 * without TLS) so the browser actually stores + returns the cookie. Behind
 * TLS (https) the `Secure` flag is set as normal.
 */
function formatOwnerSetCookie(
  project_slug: string,
  secret: string,
  url: URL,
): string {
  const c = signSessionCookie(project_slug, secret, Date.now())
  const secure = url.protocol === 'https:' ? '; Secure' : ''
  return `${c.name}=${c.value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${c.max_age_s}${secure}`
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
