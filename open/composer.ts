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
import {
  buildAnthropicLlmCall,
  buildPhaseSpecResolver,
} from '../gateway/realmode-composer/build-phase-spec-resolver.ts'
import {
  buildGatewayAnthropicMessagesClient,
  buildGatewayLlmRouter,
} from '../gateway/realmode-composer/build-llm-router.ts'
import { buildProjectOpeningMessageComposer } from '../gateway/realmode-composer/build-project-opening-message.ts'
import { buildGBrainMemory } from '../gateway/realmode-composer/build-gbrain-memory.ts'
import { createScribe, type Scribe, type UserTurnInput } from '../scribe/index.ts'
import { createState, defaultStatePath } from '../scribe/scribe-budget.ts'
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
import { createOpenChatTopicsSurface } from './chat-topics-surface.ts'
import { createChatHistorySurface } from '../gateway/http/chat-history-surface.ts'
import { OWNER_USER_ID, resolveNeutronHome, resolveOpenInstanceInfo } from './owner-identity.ts'

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

    // Production-shape hook threaded into `buildLandingStack` → the chat-bridge.
    // `scribe` is `const`, so TS preserves the `!== null` narrowing inside the
    // closure (the extraction is fire-and-forget; `handleUserTurn` returns void
    // and swallows its own errors — it never throws into the chat path).
    const scribeOnUserTurn: ((input: UserTurnInput) => void) | undefined =
      scribe !== null ? (input: UserTurnInput): void => scribe.handleUserTurn(input) : undefined

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

    const liveAgentTurnFactory =
      liveAgentSubstrate !== null
        ? (pieces: {
            buttonStore: import('../channels/button-store.ts').ButtonStore
            transcript: import('../onboarding/interview/transcript.ts').TranscriptWriter
          }) =>
            buildLiveAgentTurn({
              substrate: liveAgentSubstrate,
              personaLoader,
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

    // ── The landing stack (onboarding engine + chat UI + WS) ───────────────
    const landing = buildLandingStack({
      db,
      project_slug,
      owner_home,
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
          resumable ? landing.fetch(req, server) : coldStartRedirect(url),
        )
      }

      // Otherwise serve via the landing server, ensuring the owner cookie is
      // set on the /chat page load so the WS reconnect path works.
      const res = landing.fetch(req, server)
      if (isGet && url.pathname === '/chat' && !hasValidCookie) {
        return Promise.resolve(res).then((r) => {
          const headers = new Headers(r.headers)
          headers.append('set-cookie', formatOwnerSetCookie(project_slug, cookieSecret, url))
          return new Response(r.body, { status: r.status, headers })
        })
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
      // Tear down the upload-session sweeper on shutdown.
      realmode_cleanups: realmodeCleanups,
      landing_server: {
        fetch: openFetch,
        websocket: landing.websocket,
      },
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
