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
} from '@neutronai/gateway/realmode-composer/build-llm-call-substrate.ts'
import { getOpenAiModelPreference } from '@neutronai/runtime/models-openai.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { OpenWiringContext } from './context.ts'

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
  const { llmPool, substrateFactory, internal_handle, owner_home, project_slug, prewarmSubstrate } =
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
  const openaiSelected =
    ctx.provider === 'openai' &&
    ctx.openaiLlmPool !== null &&
    ctx.openaiLlmPool !== undefined &&
    ctx.mcpResolver !== undefined
  const conversationalProvider: Partial<BuildLlmCallSubstrateInput> = openaiSelected
    ? {
        provider: 'openai',
        openai: {
          pool: ctx.openaiLlmPool!,
          mcpResolver: ctx.mcpResolver!,
          model_preference: getOpenAiModelPreference(),
        },
      }
    : {}

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
  const conversationalAvailable = openaiSelected || llmPool !== null
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
          substrate_instance_id: `cc-llm-${internal_handle}`,
          cwd: owner_home,
          internal_handle,
          user_id: OWNER_USER_ID,
          project_slug,
          skip_permissions: true,
          ...conversationalProvider,
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
  // pre-warming it would fire a real API call at boot; skip it under openaiSelected.
  const prewarmReady: Promise<void> | null =
    llmCallSubstrate !== null && !openaiSelected ? prewarmSubstrate(llmCallSubstrate) : null
  // Track whether the pre-warm has SETTLED so the resolver can elevate the
  // budget for EVERY conversational dispatch in the cold window — not just the
  // first (2026-06-18 cold-start fix, round 2: the live owner-signup raced the
  // first TWO turns against the cold spawn and both timed out at 12 s). The flag
  // flips true when the (never-rejecting) pre-warm promise resolves; until then,
  // early turns get the cold-spawn-sized `first_call_timeout_ms` budget.
  const prewarmSettledRef = { settled: prewarmReady === null }
  if (prewarmReady !== null) {
    void prewarmReady.then(() => {
      prewarmSettledRef.settled = true
    })
  }

  // Dedicated WARM conversational substrate for post-onboarding live chat
  // turns (no `ephemeral`; keyed per-dispatch on metering_context).
  const liveAgentSubstrate =
    conversationalAvailable
      ? buildLlmCallSubstrate({
          ...anthropicPoolArg,
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
          ...conversationalProvider,
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
