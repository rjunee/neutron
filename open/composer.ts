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
import { buildLocalPlatformAdapter } from '../runtime/platform-adapter-local.ts'
import type { PlatformAdapter } from '../runtime/platform-adapter.ts'
import { CronJobRegistry } from '../cron/jobs.ts'
import {
  buildLandingStack,
  resolveLandingStaticDir,
} from '../gateway/realmode-composer/build-landing-stack.ts'
import { buildLiveAgentTurn } from '../gateway/realmode-composer/build-live-agent-turn.ts'
import {
  buildLlmCallSubstrate,
  collectTokensToString,
} from '../gateway/realmode-composer/build-llm-call-substrate.ts'
import { BEST_MODEL } from '../runtime/models.ts'
import {
  FIRST_CONVERSATIONAL_TIMEOUT_MS_DEFAULT,
  PREWARM_AWAIT_CAP_MS_DEFAULT,
} from '../onboarding/interview/llm-timeouts.ts'
import type { AgentSpec, Substrate } from '../runtime/substrate.ts'
import { buildSubstrateTridentDispatch } from '../trident/substrate-dispatch.ts'
import { SubagentRegistry } from '../runtime/subagent/registry.ts'
import { newControlState } from '../runtime/subagent/control.ts'
import {
  DispatchService,
  buildCancellableDispatchTurn,
  defaultPersonaLoader,
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
import { buildGBrainMemory } from '../gateway/realmode-composer/build-gbrain-memory.ts'
import { DocSearchIndex } from '../doc-search/store.ts'
import { DocSearchRuntime } from '../doc-search/runtime.ts'
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
  resolveSkillsDir,
  completedWorkflowFromTridentRun,
} from '../skill-forge/index.ts'
import type { TridentRun } from '../trident/store.ts'
import { SecretsStore } from '../auth/secrets-store.ts'
import { createReflection, type Reflection } from '../reflection/index.ts'
import { buildPersonalityCharacterSuggester } from '../onboarding/interview/personality-character-suggester.ts'
import { buildAgentNameSuggester } from '../onboarding/interview/agent-name-suggester.ts'
import { buildPersonaSummarizer } from '../onboarding/persona-gen/summarize.ts'
import { PersonaPromptLoader } from '../gateway/realmode-composer/persona-loader.ts'
import type { GraphComposer } from '../gateway/boot-helpers.ts'
import type { CompositionInput } from '../gateway/composition.ts'
import { readSessionCookie, signSessionCookie } from '../landing/session-cookie.ts'

import {
  buildReminderDispatcher,
  buildSubstrateReminderLlm,
  buildButtonStoreReminderOutbound,
  buildStatusMdContextSource,
} from '../reminders/index.ts'
import { webTopicId } from '../gateway/http/web-topic-id.ts'

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
import { createAppTasksSurface } from '../gateway/http/app-tasks-surface.ts'
import { createAppUploadSurface } from '../gateway/http/app-upload-surface.ts'
import { TaskStore } from '../tasks/store.ts'
import { AppWsAdapter } from '../channels/adapters/app-ws/adapter.ts'
import { InMemoryAppWsSessionRegistry } from '../channels/adapters/app-ws/session-registry.ts'
import {
  appWsTopicId,
  type AppWsOutboundAgentMessage,
} from '../channels/adapters/app-ws/envelope.ts'
import type { ButtonChoice, ButtonPrompt } from '../channels/button-primitive.ts'
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
 */
export function resolveOpenLlmPool(env: NodeJS.ProcessEnv): CredentialPool | null {
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
  return null
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

    const tridentDispatch =
      llmPool !== null
        ? buildSubstrateTridentDispatch({ build_substrate: makeEphemeralSubstrate('cc-trident') })
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
        repo_path: owner_home,
        default_model: BEST_MODEL,
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
      skillsDir: resolveSkillsDir(owner_home),
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
      docSearchRuntime = new DocSearchRuntime({ ownerHome: owner_home, index: docIndex })
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
    const scribe: Scribe | null =
      scribeSubstrate !== null
        ? ((): Scribe => {
            const gbrain = buildGBrainMemory({ owner_home, project_slug, env })
            realmodeCleanups.push(() => {
              void gbrain.close().catch(() => undefined)
            })
            return createScribe({
              substrate: scribeSubstrate,
              syncHook: gbrain.syncHook,
              ownerDataDir: owner_home,
              project_slug,
              budget: createState(defaultStatePath(owner_home)),
            })
          })()
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
    const coresSubstrate =
      llmPool !== null ? makeEphemeralSubstrate('cc-cores')(owner_home) : null
    const coresWiring = await mountOpenCores({
      projectDb: db,
      owner_home,
      project_slug,
      secretsStore,
      env,
      substrate: coresSubstrate,
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
    const agentNameSuggester =
      onboardingAnthropicClient !== null
        ? buildAgentNameSuggester({ anthropicClient: onboardingAnthropicClient })
        : undefined
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
        ? buildAnthropicLlmCall({ substrate: llmCallSubstrate, model: BEST_MODEL })
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
    const landing = buildLandingStack({
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
      ...(agentNameSuggester !== undefined ? { agentNameSuggester } : {}),
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
    const engineForUpload = landing.engine
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
    const projectsBootstrapScript = (): string => {
      let rows: { id: string; name: string }[] = []
      try {
        rows = db
          .prepare<{ id: string; name: string }, []>(
            `SELECT id, name FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC, id ASC`,
          )
          .all()
      } catch {
        rows = []
      }
      const projects = rows.map((r) => ({ id: r.id, label: r.name }))
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
      const injected = html.replace(
        '<script type="module" src="/chat-react.js"></script>',
        `${projectsBootstrapScript()}\n<script type="module" src="/chat-react.js"></script>`,
      )
      const headers = new Headers(r.headers)
      headers.delete('content-length')
      return new Response(injected, { status: r.status, headers })
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

      // Otherwise serve via the landing server, ensuring the owner cookie is
      // set on the /chat page load so the WS reconnect path works.
      const res = landing.fetch(req, server)
      if (isGet && url.pathname === '/chat' && !hasValidCookie) {
        return withReactBootstrap(res).then((r) => {
          const headers = new Headers(r.headers)
          headers.append('set-cookie', formatOwnerSetCookie(project_slug, cookieSecret, url))
          return new Response(r.body, { status: r.status, headers })
        })
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
    const reminderGeneralTopic = webTopicId(OWNER_USER_ID)
    const reminder_dispatcher = buildReminderDispatcher({
      outbound: buildButtonStoreReminderOutbound({
        buttonStore: landing.buttonStore,
        registry: landing.registry,
      }),
      ...(liveAgentSubstrate !== null
        ? { llm: buildSubstrateReminderLlm(liveAgentSubstrate) }
        : {}),
      context: buildStatusMdContextSource({ owner_home }),
      resolveTopicId: ({ explicit_topic }): string => {
        if (explicit_topic === null || explicit_topic.length === 0) {
          return reminderGeneralTopic
        }
        if (explicit_topic.startsWith('web:')) return explicit_topic
        const projectId = explicit_topic.startsWith('app-project:')
          ? explicit_topic.slice('app-project:'.length)
          : explicit_topic
        return `${reminderGeneralTopic}:${projectId}`
      },
    })

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
    const appWsChatTurn =
      liveAgentSubstrate !== null
        ? buildLiveAgentTurn({
            substrate: liveAgentSubstrate,
            personaLoader,
            projectPersonaResolver,
            reflection,
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

    // ── Onboarding consolidation (2026-06-26): ONE chat path ───────────────
    // Onboarding is NOT a separate engine/socket — it is the INITIAL MODE of
    // this same `/ws/app/chat` surface. The shared `landing.engine` keys its
    // state on (project_slug, user_id), independent of transport, so the same
    // InterviewEngine that drove the (now-removed) legacy onboarding socket runs
    // here. `isOnboardingActive` decides per-turn whether the engine (onboarding) or
    // the live agent (steady-state) handles the message.
    const engine = landing.engine
    const onboardingStateStore = landing.stateStore
    // No state row = fresh install → start onboarding. A row in a non-terminal
    // phase = mid-onboarding. 'completed'/'failed' = steady-state chat.
    const isOnboardingActive = async (user_id: string): Promise<boolean> => {
      const st = await onboardingStateStore.get(project_slug, user_id)
      if (st === null) return true
      return st.phase !== 'completed' && st.phase !== 'failed'
    }
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
          msg.inline_choices = out.options.map((o) => ({ label: o.label, callback_data: o.value }))
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
    // Drive one onboarding turn from a typed (freeform) answer.
    const advanceOnboardingText = async (
      user_id: string,
      freeform_text: string,
      observed_at: number,
    ): Promise<void> => {
      await engine.advance({
        project_slug,
        topic_id: appWsTopicId(user_id),
        user_id,
        channel_kind: 'app-socket',
        freeform_text,
        observed_at,
      })
    }
    // Drive one onboarding turn from a tapped button (structured choice).
    const advanceOnboardingChoice = async (
      user_id: string,
      prompt_id: string,
      choice_value: string,
      freeform_text: string | undefined,
      observed_at: number,
    ): Promise<void> => {
      const choice: ButtonChoice = {
        prompt_id,
        choice_value,
        chosen_at: observed_at,
        speaker_user_id: user_id,
        channel_kind: 'app-socket',
        ...(freeform_text !== undefined ? { freeform_text } : {}),
      }
      await engine.advance({
        project_slug,
        topic_id: appWsTopicId(user_id),
        user_id,
        channel_kind: 'app-socket',
        choice,
        observed_at,
      })
    }
    // Fill the late-bound onboarding button-prompt router NOW that the registry
    // exists. The engine's `sendButtonPrompt` reads this holder at call time
    // (see buildRoutedSendButtonPrompt) — `app:<user>` topics route here.
    appWsButtonPromptRouter.send = async ({ topic_id, prompt }) => {
      const ok = emitOnboardingPrompt(topic_id, prompt)
      return { message_id: prompt.prompt_id, was_new: ok }
    }
    // Import-progress over app-ws: dropped for now (the terminal-state prompt
    // still lands via the button-prompt path). Left as an explicit no-op holder
    // so the router prefix is recognised (no "unknown-channel" warn). A future
    // pass can translate progress → an `agent_message_partial`-style update.
    void appWsImportProgressRouter

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
        const onboardingUserId = event.user.channel_user_id
        // ONE path: while onboarding is active this typed answer advances the
        // shared InterviewEngine (which emits the next prompt over THIS socket
        // via the router above) instead of the steady-state live agent. The
        // user's text was already echoed/persisted by the surface's
        // ingestUserMessage, so it renders as a normal user bubble.
        if (await isOnboardingActive(onboardingUserId)) {
          await advanceOnboardingText(onboardingUserId, userText, event.received_at)
          return
        }
        const project_id =
          typeof event.adapter_metadata?.['project_id'] === 'string'
            ? (event.adapter_metadata['project_id'] as string)
            : undefined
        // Codex r1 [P2]: the React client keeps ONE app-ws channel topic
        // (`app:<owner>`) and switches projects via the `project_id` field only.
        // Keying the live-agent turn on the bare channel topic would share the
        // warm session + first-turn context + button-store history across ALL
        // projects (wrong-project grounding). Derive a PROJECT-SCOPED turn topic
        // (`app:<owner>:<project_id>`) — mirrors the web path's
        // `web:<owner>:<project>` — so each project gets its own warm REPL +
        // persona + history. The REPLY is still delivered to the socket's real
        // `channel_topic_id` (below), since that's where the client listens.
        const turnTopicId =
          project_id !== undefined && project_id.length > 0
            ? `${event.channel_topic_id}:${project_id}`
            : event.channel_topic_id
        const sendReply = buildAppWsSendReply(event.channel_topic_id, project_id)
        if (appWsChatTurn === null) {
          sendReply({
            type: 'agent_message',
            body:
              "I can't answer yet — this box has no AI credential configured. Add one in settings, then try again.",
          })
          return
        }
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
      },
    }
    appWsHolder.adapter = new AppWsAdapter({ registry: appWsRegistry, receiver: appWsReceiver })
    const appWsSurface = createAppWsSurface({
      adapter: appWsHolder.adapter,
      registry: appWsRegistry,
      auth: appOwnerAuth,
      project_slug,
      // Codex r1 [P2]: route slash commands (/note, /remind, /skills, …) through
      // the SAME chained filter the web chat uses — parity, not a second path.
      chat_command_filter: chatCommandFilter,
      // Onboarding consolidation — fire the FIRST onboarding prompt over this
      // socket on connect when the owner hasn't finished onboarding. Idempotent:
      // engine.start re-emits the active prompt on a reconnect.
      on_session_open: async ({ user_id, channel_topic_id }) => {
        if (await isOnboardingActive(user_id)) {
          await engine.start({
            project_slug,
            topic_id: channel_topic_id,
            user_id,
            signup_via: 'web',
          })
        }
      },
      // Onboarding consolidation — a tapped quick-reply button. Onboarding →
      // structured engine.advance; steady-state → feed the choice to the live
      // agent as the user's selection (same single surface).
      on_button_choice: async ({
        user_id,
        channel_topic_id,
        project_id,
        prompt_id,
        choice_value,
        freeform_text,
      }) => {
        const now = Date.now()
        if (await isOnboardingActive(user_id)) {
          await advanceOnboardingChoice(user_id, prompt_id, choice_value, freeform_text, now)
          return
        }
        if (appWsChatTurn === null) return
        const turnTopicId =
          project_id !== undefined && project_id.length > 0
            ? `${appWsTopicId(user_id)}:${project_id}`
            : appWsTopicId(user_id)
        const replyText =
          freeform_text !== undefined && freeform_text.length > 0 ? freeform_text : choice_value
        await appWsChatTurn({
          project_slug,
          user_id,
          topic_id: turnTopicId,
          ...(project_id !== undefined ? { project_id } : {}),
          user_text: replyText,
          send: buildAppWsSendReply(channel_topic_id, project_id),
          observed_at: now,
        })
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
      // Foundational Trident — the `/code <task>` autonomous Forge→Argus→merge
      // loop. Threading `dispatch` here is what flips the trident tick loop
      // (built in `build-core-modules.ts`) from its `stubAdvanceDeps` no-op to
      // the REAL `buildTridentOrchestrator` step, so a `code_trident_runs` row
      // is driven end-to-end on the CC-subprocess substrate (a fresh ephemeral
      // REPL rooted at each run's worktree — see `tridentDispatch` above).
      // Omitted when no credential resolves (`tridentDispatch === null`) →
      // unchanged LLM-less behaviour (loop stays live + restart-safe but
      // advances nothing).
      // The `on_run_terminal` observer fires Skill Forge's auto-skillify audit
      // (parity gap #5) on every terminal run — the audit drops non-`done`
      // runs. Wired only on the live (dispatch) path; an LLM-less box never
      // advances a run to terminal, so there is nothing to skillify.
      ...(tridentDispatch !== null
        ? { trident: { dispatch: tridentDispatch, on_run_terminal: skillForgeOnRunTerminal } }
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
    model_preference: [BEST_MODEL],
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
