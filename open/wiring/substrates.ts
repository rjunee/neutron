/**
 * @neutronai/open — substrate wiring (C3a, carve #1).
 *
 * Behavior-preserving extraction of the substrate-construction slice of
 * `createOpenComposition` (old `open/composer.ts` lines 485-661): the warm
 * onboarding phase-spec substrate (`cc-llm-*`) + its pre-warm, the warm
 * live-chat substrate (`cc-agent-*`, the ONLY one with `enableToolBridge`), the
 * per-worktree ephemeral factory (`makeEphemeralSubstrate`), and the warm
 * per-repo-cwd trident-fire factory (`cc-trident-fire-*` + `fireSubstrateByCwd`
 * cache). The composer destructures the returned bag and consumes each value
 * downstream verbatim.
 *
 * CARE (invariants pinned by `open/__tests__/open-wiring-substrates.test.ts`):
 *   - `prewarmReady` NEVER rejects and is NOT awaited at boot; `prewarmSettled`
 *     is exposed as a LIVE reference (`prewarmSettledRef.settled`) the `.then`
 *     flips, so the composer's cold-window elevation reads the live value.
 *   - Only `cc-agent-*` sets `enableToolBridge: true`. `cc-llm-*`,
 *     `cc-trident-*` (ephemeral), and `cc-trident-fire-*` deliberately omit it.
 *   - `cc-trident-fire-*` stays WARM per repo cwd (Map cache, non-ephemeral).
 *   - The `substrateFactory` test-seam is threaded verbatim via the
 *     `...(substrateFactory !== undefined ? { substrateFactory } : {})` spread.
 */

import {
  buildLlmCallSubstrate,
  type BuildLlmCallSubstrateInput,
} from '@neutronai/gateway/wiring/build-llm-call-substrate.ts'
import {
  PROFILE_PHASE_SPEC,
  PROFILE_WARM_CHAT,
  PROFILE_EPHEMERAL,
  PROFILE_WARM_FIRE,
} from '@neutronai/gateway/wiring/substrate-profiles.ts'
import { getOpenAiModelPreference } from '@neutronai/runtime/models-openai.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { OpenWiringContext } from './context.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

export interface WiredSubstrates {
  /** Warm onboarding phase-spec substrate (`cc-llm-*`); null when LLM-less. */
  llmCallSubstrate: Substrate | null
  /** Warm live-chat substrate (`cc-agent-*`, tool-bridge on); null LLM-less. */
  liveAgentSubstrate: Substrate | null
  /** Per-worktree ephemeral factory: `(prefix) => (cwd) => Substrate`. */
  makeEphemeralSubstrate: (instance_prefix: string) => (cwd: string) => Substrate
  /** Warm per-repo-cwd trident-fire factory (memoized, non-ephemeral). */
  makeWarmFireSubstrate: (cwd: string) => Substrate
  /** Build-time pre-warm promise (never rejects); null when LLM-less. */
  prewarmReady: Promise<void> | null
  /** LIVE reference the pre-warm `.then` flips; read for cold-window elevation. */
  prewarmSettledRef: { settled: boolean }
  /** Substrate teardown hooks (none today; registered by the composer verbatim). */
  cleanups: Array<() => void>
}

/**
 * Construct the Open composition's substrates from the narrow wiring context.
 * Pure of composition assembly — returns a typed bag of intermediate values the
 * rest of the closure consumes.
 */
export function wireSubstrates(ctx: OpenWiringContext): WiredSubstrates {
  const { llmPool, substrateFactory, owner_handle, owner_home, project_slug, prewarmSubstrate } =
    ctx

  // SWAPPABLE PROVIDER — the CONVERSATIONAL provider option bag. Applied ONLY to
  // the `cc-llm-*` (phase-spec) + `cc-agent-*` (live chat) substrates below.
  //
  // TRIDENT STAYS CLAUDE-CODE (hard constraint): the trident-fire
  // (`makeWarmFireSubstrate`) + ephemeral (`makeEphemeralSubstrate`) substrates
  // NEVER receive this — trident's fire-and-settle inner loop is a native CC
  // Dynamic Workflow with no OpenAI analogue, so an autonomous build always runs
  // on Claude Code regardless of the conversational provider. Degrade LOUDLY: if
  // openai is selected but its pool / mcpResolver is missing, we leave the
  // conversational config unset (→ Claude Code) rather than boot a broken path;
  // the composer logs the fallback.
  // EXPLICIT operator selection vs FULLY-WIRED. `ctx.provider === 'openai'` is the
  // operator's explicit choice (NEUTRON_MODEL_PROVIDER=openai); it is honored even
  // when incomplete so the substrate FAILS LOUDLY rather than silently routing the
  // operator's prompts to Anthropic — the provider they did NOT select (audit High).
  const openaiRequested = ctx.provider === 'openai'
  const openaiFullyWired =
    openaiRequested &&
    ctx.openaiLlmPool !== null &&
    ctx.openaiLlmPool !== undefined &&
    ctx.bindMcpResolver !== undefined
  // CAPABILITY-PARITY (audit round 16) — the OpenAI config must grant EXACTLY the
  // capabilities the substrate's CLAUDE-path equivalent grants, never more. The
  // decisive one is the TOOL BRIDGE: on the Claude path ONLY `cc-agent-*` (live
  // chat) sets `enableToolBridge: true`; `cc-llm-*` (onboarding phase-spec) does
  // NOT. So the OpenAI `toolManifest` (which becomes the GPT tool surface) is
  // included ONLY for the live-agent substrate — never the phase-spec one, whose
  // input is user-controlled ONBOARDING text. Emitting the full MCP manifest there
  // would let onboarding prompts reach work_board / dispatch / etc. = privilege
  // escalation the Claude path never permits.
  const conversationalProviderFor = (
    withToolBridge: boolean,
  ): Partial<BuildLlmCallSubstrateInput> =>
    openaiRequested
      ? {
          // ALWAYS set provider='openai' for an explicit selection. When fully wired
          // the `openai` config is included; when NOT, it is omitted so the substrate
          // emits its LOUD terminal error (never a silent Anthropic fallback).
          provider: 'openai',
          ...(openaiFullyWired
            ? {
                openai: {
                  pool: ctx.openaiLlmPool!,
                  bindMcpResolver: ctx.bindMcpResolver!,
                  // OPERATOR OVERRIDE (audit round 11) — resolve the model ids from the
                  // COMPOSER'S selected env (`ctx.env`), NOT the ambient global
                  // `process.env`, so `NEUTRON_OPENAI_MODEL` on the instance env is honored.
                  model_preference: getOpenAiModelPreference(ctx.env),
                  // HONEST TOOL MANIFEST (audit BLOCKER 1) — only real MCP tools reach
                  // GPT, and ONLY on a tool-bridge substrate (audit round 16). Without
                  // a manifest the GPT turn advertises NO tools (spec.tools → []).
                  ...(withToolBridge && ctx.toolManifest !== undefined
                    ? { toolManifest: ctx.toolManifest }
                    : {}),
                  // Test-only fetch seam (E2E mocked GPT), mirrors substrateFactory.
                  ...(ctx.openaiFetchImpl !== undefined ? { fetchImpl: ctx.openaiFetchImpl } : {}),
                },
              }
            : {}),
        }
      : {}
  // Phase-spec (`cc-llm-*`): NO tool bridge (mirrors the Claude path — it never sets
  // enableToolBridge). Live-agent (`cc-agent-*`): tool bridge ON (mirrors enableToolBridge).
  const phaseSpecProvider = conversationalProviderFor(false)
  const liveAgentProvider = conversationalProviderFor(true)

  // Codex-fix — the CONVERSATIONAL substrates build when the SELECTED provider's
  // pool is available, NOT solely on the Anthropic `llmPool`. An OpenAI-only box
  // (valid OPENAI_API_KEY, no Claude credential) must still get its conversational
  // pair; otherwise `llmPool === null` silently nulls them while the OpenAI pool is
  // never consulted (repro: NEUTRON_MODEL_PROVIDER=openai + OPENAI_API_KEY, no Claude).
  //
  // The Anthropic `pool`/`resolvePool` arg is required by the composer contract but
  // is NEVER consulted on an openai turn (`start()` delegates to the openai branch
  // before touching it). When there's no Anthropic pool we thread a lazy resolver
  // that returns null so construction still yields a non-null Substrate. When NOT
  // openai-selected this is `{ pool: llmPool }` with a non-null pool — BYTE-IDENTICAL
  // to before.
  const conversationalAvailable = openaiRequested || llmPool !== null
  const anthropicPoolArg: Pick<BuildLlmCallSubstrateInput, 'pool' | 'resolvePool'> =
    llmPool !== null ? { pool: llmPool } : { resolvePool: async (): Promise<null> => null }

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
    conversationalAvailable
      ? buildLlmCallSubstrate({
          ...anthropicPoolArg,
          substrate_instance_id: `cc-llm-${owner_handle}`,
          cwd: owner_home,
          owner_handle,
          user_id: OWNER_USER_ID,
          project_slug,
          // Phase-spec resolver (cc-llm). Security knobs live on the profile —
          // see substrate-profiles.ts.
          profile: PROFILE_PHASE_SPEC,
          // Phase-spec: openai provider WITHOUT the tool manifest (no tool bridge),
          // mirroring the Claude path (cc-llm-* never sets enableToolBridge).
          ...phaseSpecProvider,
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
  // Pre-warm ONLY the Claude Code warm-REPL path — pre-warming is a CC concept
  // (cold spawn of the interactive REPL). The OpenAI adapter is stateless HTTP, so
  // pre-warming it would fire a real API call at boot; skip it whenever openai is
  // the requested provider (wired or not — an unwired openai turn just errors).
  const prewarmReady: Promise<void> | null =
    llmCallSubstrate !== null && !openaiRequested ? prewarmSubstrate(llmCallSubstrate) : null
  // Track whether the pre-warm has SETTLED so the resolver can elevate the
  // budget for EVERY conversational dispatch in the cold window — not just the
  // first (2026-06-18 cold-start fix, round 2: the live owner-signup raced the
  // first TWO turns against the cold spawn and both timed out at 12 s). The flag
  // flips true when the (never-rejecting) pre-warm promise resolves; until then,
  // early turns get the cold-spawn-sized `first_call_timeout_ms` budget.
  const prewarmSettledRef = { settled: prewarmReady === null }
  if (prewarmReady !== null) {
    fireAndForget('substrates.then', prewarmReady.then(() => {
      prewarmSettledRef.settled = true
    }))
  }

  // Dedicated WARM conversational substrate for post-onboarding live chat
  // turns (no `ephemeral`; keyed per-dispatch on metering_context).
  const liveAgentSubstrate =
    conversationalAvailable
      ? buildLlmCallSubstrate({
          ...anthropicPoolArg,
          substrate_instance_id: `cc-agent-${owner_handle}`,
          cwd: owner_home,
          owner_handle,
          user_id: OWNER_USER_ID,
          project_slug,
          // Owner's WARM conversational REPL (cc-agent) — TRUSTED live chat.
          // Security knobs live on the profile — see substrate-profiles.ts. Kept
          // DISTINCT from the untrusted-import profile even though identical today.
          profile: PROFILE_WARM_CHAT,
          // P0-1 — the owner's WARM conversational REPL is the ONE substrate
          // that opts into the native-MCP tool bridge, so the live chat agent
          // can call Cores/doc-search/memory/reminders mid-reasoning over a
          // structured stdio-MCP transport (the in-process registry, fronted by
          // `tools-bridge.ts`). The untrusted import (`cc-import-*`) and
          // disposable Trident (`cc-trident-*`) substrates deliberately omit it.
          enableToolBridge: true,
          // ISOLATION INVARIANT (ISSUES #378, Argus r2): DO NOT wire a
          // `projectIdResolver` here. The per-project opening / kickoff / doc
          // composers ride THIS substrate and isolate each project's transcript
          // by stamping `spec.metering_context.project_id` PER DISPATCH, which
          // `build-llm-call-substrate.ts` folds into the warm-pool key ONLY when
          // no resolver is present (`input.projectIdResolver?.() ??
          // spec.metering_context?.project_id`, :696). A resolver would take
          // PRECEDENCE over the per-dispatch project_id and re-collapse every
          // project's compose onto one shared REPL — the exact #378 cross-project
          // bleed. The LIVE chat turn does not need one either: it dispatches raw
          // specs whose `metering_context.project_id` is the active project, and
          // the pool key already keys on that. Wiring a resolver here is a
          // regression; guarded by per-project-session-openings.test.ts.
          // O6 — the notice-family sinks + recovered-reply sink are wired ONLY
          // here (the owner's conversational REPL). So a rising-edge dead-turn /
          // size-alert / rate-limit-banner state surfaces as an owner chat bubble
          // + a `system_events` row, and a crash-dropped reply is recovered —
          // instead of all four vanishing to the substrate's stderr fallback. The
          // phase-spec / ephemeral / trident-fire substrates deliberately omit
          // them (no owner chat surface to deliver to).
          ...(ctx.liveAgentNoticeSinks !== undefined
            ? {
                onDeadTurnNotice: ctx.liveAgentNoticeSinks.onDeadTurnNotice,
                onSizeAlert: ctx.liveAgentNoticeSinks.onSizeAlert,
                onRateLimitBanner: ctx.liveAgentNoticeSinks.onRateLimitBanner,
              }
            : {}),
          ...(ctx.liveAgentRecoveredReplySink !== undefined
            ? { onRecoveredReply: ctx.liveAgentRecoveredReplySink }
            : {}),
          ...(ctx.liveAgentDeliveryTopicId !== undefined
            ? { delivery_topic_id: ctx.liveAgentDeliveryTopicId }
            : {}),
          // Live-agent: openai provider WITH the tool manifest (tool bridge ON),
          // mirroring the Claude path's enableToolBridge — this is the ONE
          // conversational substrate that gets tools on either provider.
          ...liveAgentProvider,
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
              substrate_instance_id: `${instance_prefix}-${owner_handle}`,
              cwd,
              owner_handle,
              user_id: OWNER_USER_ID,
              project_slug,
              // Disposable per-worktree Trident/agent-dispatch REPL. Security
              // knobs live on the profile — see substrate-profiles.ts.
              profile: PROFILE_EPHEMERAL,
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
      substrate_instance_id: `cc-trident-fire-${owner_handle}-${h.toString(36)}`,
      cwd,
      owner_handle,
      user_id: OWNER_USER_ID,
      project_slug,
      // Trident v2 FIRE seam — WARM per-repo REPL. Security knobs live on the
      // profile — see substrate-profiles.ts.
      profile: PROFILE_WARM_FIRE,
      ...(substrateFactory !== undefined ? { substrateFactory } : {}),
    })
    if (built === null) throw new Error('cc-trident-fire: empty Anthropic credential pool')
    fireSubstrateByCwd.set(cwd, built)
    return built
  }

  return {
    llmCallSubstrate,
    liveAgentSubstrate,
    makeEphemeralSubstrate,
    makeWarmFireSubstrate,
    prewarmReady,
    prewarmSettledRef,
    cleanups: [],
  }
}
