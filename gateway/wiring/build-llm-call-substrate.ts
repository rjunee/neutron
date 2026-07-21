/**
 * @neutronai/gateway/wiring — shared CC-subprocess LLM-call substrate.
 *
 * Sprint: cc-substrate-migration-3-sites (2026-05-31).
 *
 * Single primitive that every LLM call site in the gateway dispatches
 * through. Wraps the per-instance Anthropic `CredentialPool` (resolved by
 * `resolveLlmCredentials`) into a `Substrate` whose `start(spec)`:
 *
 *   1. Resolves the LIVE pool (eager `pool` OR lazy `resolvePool` per call).
 *   2. Selects a credential via `selectCredential(pool)`.
 *   3. Refreshes Max OAuth at dispatch time when `oauthRefresh` is wired.
 *   4. Layers `env` so the spawned `claude` subprocess sees ONLY the chosen
 *      credential's auth env var (host vars explicitly unset per ISSUES #49).
 *   5. Dispatches via `createClaudeCodeSubstrateAuto(...).start(spec)`.
 *   6. Proxies events back to the caller AND feeds completion / error into
 *      `reportSuccess` / `reportFailure` on the LIVE pool (cooldown).
 *
 * This is the SAME shape `buildImportSubstrate` (T7) ships for the
 * history-import pipeline — extracted so every other LLM call site
 * (router, agent-watcher, phase-spec resolver, wow picker, nudge engine)
 * inherits the identical credential rotation + OAuth refresh + cooldown
 * discipline instead of hand-rolling its own fetch wrapper.
 *
 * Direct HTTPS POSTs to `https://api.anthropic.com/v1/messages` are
 * FORBIDDEN in instance-facing code per memory
 * `feedback_cc_subprocess_substrate.md` (2026-05-31). Every consumer
 * imports this helper and constructs its own per-call-site adapter that
 * shapes the `Substrate.start` contract into the consumer's expected
 * closure (LlmCallFn, AnthropicMessagesClient, AgentWatcherLlmCall).
 *
 * Refactor: the cooldown-classification helpers (`parseHttpStatusFromMessage`,
 * `mapStatusForPoolCooldown`, `detectCliAuthFailure`) live HERE; the
 * older `build-import-substrate.ts` re-imports them so both substrates
 * apply the same classification logic. Behavior preserved verbatim from
 * the T7 implementation.
 */

import {
  createClaudeCodeSubstrateAuto,
  type ClaudeCodeSubstrateOptions,
  type RecoveredReply,
  type DeadTurnNotice,
  type RateLimitBannerNotice,
  type SizeSeverity,
} from '@neutronai/runtime/adapters/claude-code/index.ts'
import {
  normalizeProvider,
  selectSubstrateFactory,
  type Provider,
} from '@neutronai/runtime/adapters/select-substrate.ts'
import type { GptResponsesApiSubstrateOptions } from '@neutronai/runtime/adapters/openai-responses/index.ts'
import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import type { CodexCliSubstrateOptions } from '@neutronai/runtime/adapters/codex-cli/index.ts'
import type { McpToolResolver } from '@neutronai/contracts/mcp-tool-resolver.ts'
import type { ToolDef } from '@neutronai/cores-sdk/manifest'
import {
  reportFailure,
  reportSuccess,
  selectCredential,
  type CredentialPool,
} from '@neutronai/runtime/credential-pool.ts'
import type { Event, SubstrateErrorClass } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { OAuthCredentialSource } from './resolve-llm-credentials.ts'
import type { SubstrateProfile } from './substrate-profiles.ts'

/**
 * Discriminated failure reasons for `resolveScrubbedAuthEnv`. Mirrors the
 * three terminal-error branches the substrate's `start()` historically
 * yielded inline, so the substrate can re-map a thrown reason back to the
 * SAME `Event` (message + retryable) it emitted before the refactor:
 *
 *   - `no_credentials`  → no pool / empty pool at dispatch (retryable:false)
 *   - `all_cooldown`    → every credential in cooldown (retryable:true)
 *   - `oauth_refresh`   → Max OAuth `loadAccessToken` threw (retryable:false)
 *
 * Callers that let these throws bubble (rather than catching them as an
 * `Event`) get a clean credential-failure signal; the substrate itself maps
 * each reason back to the exact terminal `Event` it used to yield inline.
 */
export type ScrubbedAuthEnvFailureReason =
  | 'no_credentials'
  | 'all_cooldown'
  | 'oauth_refresh'

/**
 * Typed error thrown by `resolveScrubbedAuthEnv` on any credential-resolution
 * failure. `reason` lets the cold substrate translate the throw back into the
 * exact terminal `Event` it used to yield inline; `cause` carries the
 * underlying error text for the oauth-refresh branch.
 */
export class ScrubbedAuthEnvError extends Error {
  override readonly name = 'ScrubbedAuthEnvError'
  readonly reason: ScrubbedAuthEnvFailureReason
  constructor(reason: ScrubbedAuthEnvFailureReason, message: string) {
    super(message)
    this.reason = reason
  }
}

export interface ResolveScrubbedAuthEnvInput {
  /** Eager pool — used when supplied (tests / pre-resolved callers). */
  pool?: CredentialPool
  /** Lazy resolver — re-run on every call so a newly-available credential
   *  is picked up without a restart. Exactly one of pool/resolvePool. */
  resolvePool?: () => Promise<CredentialPool | null>
  /** Max OAuth refresh handle — refreshes oauth-like creds at dispatch. */
  oauthRefresh?: OAuthCredentialSource
  /** Handle keyed against `oauthRefresh.loadAccessToken`. */
  owner_handle?: string
}

export interface ResolveScrubbedAuthEnvResult {
  /**
   * The scrubbed env overlay: the three Anthropic auth vars are explicitly
   * UNSET (ISSUES #49) and exactly ONE is set to the selected credential's
   * secret — `CLAUDE_CODE_OAUTH_TOKEN` for oauth-like creds, else
   * `ANTHROPIC_API_KEY`. Suitable to pass verbatim as the subprocess
   * `env` overlay (cold substrate) OR as the warm process's spawn env.
   */
  env: Record<string, string | undefined>
  /** The selected pool (live, with cooldown state) — the cold substrate
   *  needs it to feed `reportSuccess`/`reportFailure`. */
  pool: CredentialPool
  /** The selected credential id — the cold substrate's cooldown reporter
   *  keys `reportSuccess`/`reportFailure` on it. */
  cred_id: string
}

/**
 * Resolve + scrub the per-instance Anthropic auth env for a CC subprocess.
 *
 * Extracted (DECISION doc Part 3c) from the inline block that used to live
 * in `buildLlmCallSubstrate`'s `start()` so the SAME credential-selection +
 * Max-OAuth-refresh + ISSUES-#49 env-scrubbing discipline is shared by BOTH
 * the cold substrate AND the warm reused router process — no duplicated
 * ~40-line cred logic, no drift between the two auth paths.
 *
 * Behaviour is byte-identical to the prior inline block; the only change is
 * that the three terminal-failure branches THROW a typed `ScrubbedAuthEnvError`
 * (reason-tagged) instead of yielding an `Event`. The cold substrate catches
 * and re-maps each reason to the exact `Event` it used to emit (so its tests
 * stay green); the warm path lets the throw bubble to cold-fallback.
 */
export async function resolveScrubbedAuthEnv(
  input: ResolveScrubbedAuthEnvInput,
): Promise<ResolveScrubbedAuthEnvResult> {
  let pool: CredentialPool
  if (input.pool !== undefined) {
    pool = input.pool
  } else if (input.resolvePool !== undefined) {
    const resolved = await input.resolvePool()
    if (resolved === null || resolved.credentials.length === 0) {
      throw new ScrubbedAuthEnvError(
        'no_credentials',
        'cc-llm-call substrate: no Anthropic credentials available at dispatch time. ' +
          'Configure CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in the per-project `.env`, ' +
          'or attach Max OAuth via signup, then retry.',
      )
    }
    pool = resolved
  } else {
    throw new ScrubbedAuthEnvError(
      'no_credentials',
      'resolveScrubbedAuthEnv: neither `pool` nor `resolvePool` supplied',
    )
  }
  const cred = selectCredential(pool)
  if (cred === null) {
    throw new ScrubbedAuthEnvError(
      'all_cooldown',
      'cc-llm-call substrate: all Anthropic credentials are in cooldown (429/402/401). ' +
        'Retry once the rate-limit window passes.',
    )
  }
  let activeSecret = cred.secret
  const isOauthLike = cred.kind === 'oauth' || cred.kind === 'codex_oauth'
  if (
    isOauthLike &&
    input.oauthRefresh !== undefined &&
    typeof input.owner_handle === 'string' &&
    input.owner_handle.length > 0
  ) {
    try {
      // `input.owner_handle` is the frozen instance handle (guarded string
      // above); brand it for the OAuth-refresh credential lookup.
      const fresh = await input.oauthRefresh.loadAccessToken(asOwnerHandle(input.owner_handle))
      if (fresh !== null && fresh.access_token.length > 0) {
        activeSecret = fresh.access_token
      }
    } catch (err) {
      throw new ScrubbedAuthEnvError(
        'oauth_refresh',
        `cc-llm-call oauth-refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  // Per ISSUES #49: explicitly UNSET the three Anthropic auth env vars that
  // the CC subprocess could otherwise inherit from the gateway's own
  // `process.env`, then set ONLY the selected credential's var. See the
  // substrate's prior inline comment for the credential-confusion failure
  // mode this prevents.
  const env: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  }
  if (cred.kind === 'ambient') {
    // Ambient/Keychain credential (single-owner Open): we hold NO secret of our
    // own. Thread NEITHER token — the three Anthropic env vars stay scrubbed to
    // `undefined` so the spawned `claude` child cannot inherit a stale gateway
    // token and instead authenticates via its OWN ambient/Keychain creds (the
    // macOS "Claude Code-credentials" item, the same path `claude -p` uses). The
    // oauth-refresh block above is guarded by `isOauthLike` (false here), so it
    // never runs for an ambient cred that has nothing to refresh.
  } else if (isOauthLike) {
    env['CLAUDE_CODE_OAUTH_TOKEN'] = activeSecret
  } else {
    env['ANTHROPIC_API_KEY'] = activeSecret
  }
  return { env, pool, cred_id: cred.id }
}

export interface BuildLlmCallSubstrateInput {
  /**
   * Resolved by `resolveLlmCredentials({provider:'anthropic',...})`. When
   * supplied (and `resolvePool` is absent), the substrate uses this pool
   * for every `start()` call. Used by tests and by callers that already
   * have an eagerly-resolved pool at construction.
   */
  pool?: CredentialPool
  /**
   * Lazy credential resolver — re-runs on EVERY `start()` so a credential
   * that becomes available between composer boot and the actual LLM call
   * is picked up without a gateway restart. Production wires this with
   * the same `resolveLlmCredentials` arg shape the build-import-substrate
   * call uses (per-instance `.env` overlay + Max OAuth + BYO key + env).
   * Mirrors `BuildImportSubstrateInput.resolvePool` semantics — see that
   * file's docs for the full rationale.
   */
  resolvePool?: () => Promise<CredentialPool | null>
  /** Stable per-instance identifier — surfaced on `completion.substrate_instance_id`.
   *  Also the instance+role discriminator the persistent substrate folds into its
   *  warm-pool key (S3 §2). */
  substrate_instance_id: string
  /** Optional cwd override threaded to `createClaudeCodeSubstrateAuto` (defaults to process.cwd()). */
  cwd?: string
  /**
   * Optional `--append-system-prompt-file` for the spawned REPL, threaded onto
   * `ClaudeCodeSubstrateOptions.appendSystemPromptFile`
   * (`persistent/types.ts:216` → emitted `build-repl-argv.ts:109`). ABSENT ⇒
   * the substrate's default (`repl-agent-base.md`, the CHAT persona) — unchanged
   * for every existing caller. Set by the ritual executor (plan task 4) to
   * `reminders/ritual-agent-base.md` so a scheduled ritual REPL runs as an
   * UNATTENDED executor, not the interactive chat agent.
   */
  append_system_prompt_file?: string
  /**
   * Optional per-instance `CLAUDE_CONFIG_DIR` threaded to the persistent child.
   * When set, the owner authenticates via the interactive-Max-login model (their
   * own `.credentials.json` with a refresh_token under this dir) and the child
   * SELF-REFRESHES its OAuth token, so the warm REPL never serves a turn on a
   * stale env token.
   *
   * Argus r3 IMPORTANT (2026-06-08) — ACCURACY: this self-refresh path is
   * FORWARD-LOOKING plumbing. NO live gateway caller threads `claude_config_dir`
   * today (the conversational substrate at `gateway/index.ts` builds WITHOUT it),
   * so in production the child ALWAYS runs on the per-dispatch-refreshed
   * `CLAUDE_CODE_OAUTH_TOKEN` env. The r2 commit framed self-refresh + the reuse
   * guard as "two complementary fixes"; that was misleading. The PRIMARY (and,
   * absent a live caller, SOLE) prod stale-token defense is the substrate's
   * credential-freshness reuse guard, which evicts + respawns on a token rotation
   * (see `persistent-repl-substrate.ts` `getOrSpawnSession`). This field is kept
   * wired end-to-end so the interactive-Max-login model can be turned on by a
   * future caller without re-plumbing — but it is dormant until then.
   */
  claude_config_dir?: string
  /**
   * S3 §2 — conversational user identity folded into the persistent substrate's
   * warm-pool key so two distinct users never collapse into one warm REPL. The
   * per-instance owner today (`owner_user_id`); stable for the instance lifetime, so the caller
   * threads it at composer-build time. Absent ⇒ the substrate keys the user
   * component as `_platform` (platform-internal LLM calls share one REPL per
   * instance — correct, not a collapse).
   */
  user_id?: string
  /**
   * S3 §2 — LIVE per-turn project identity resolver, folded into the persistent
   * substrate's warm-pool key so two DISTINCT projects for the same (instance,user)
   * resolve to DISTINCT warm REPLs (no shared `--resume` transcript ⇒ no
   * cross-project context bleed).
   *
   * Re-evaluated on EVERY `start(spec)` dispatch (the active project changes
   * across turns), so the caller threads a closure — NOT a captured value. In the
   * gateway this is the SAME `ownerChatProjectIdResolver` the phase-spec
   * resolver's `escalation_project_id` reads (the user's currently-active chat
   * project from `WebChatSessionProjectRegistry.getActive(owner_user_id)`),
   * so the warm REPL a turn lands on always matches the project whose escalation
   * envelope that turn reads — one source of truth for "which project is this
   * turn".
   *
   * Argus r3 BLOCKER (2026-06-08): the prior wiring keyed `project_id` off
   * `spec.metering_context?.project_id`, which `runtime/substrate.ts` documents
   * as Private-substrate-only and IGNORED by the CC adapter — ZERO live
   * conversational call sites populate it, so every owner's projects collapsed
   * into ONE warm REPL. This resolver replaces that dead dimension with the live
   * project pointer. Absent (platform-internal / router / test callers that don't
   * carry a conversational project) ⇒ falls back to `spec.metering_context?.
   * project_id`, then to the substrate's `'default'` namespace.
   */
  projectIdResolver?: () => string | undefined
  /** S3 §2 — owning instance slug (advisory: redelivery logging / scoping). */
  project_slug?: string
  /** S3 #106 — the user's reconnect channel (`web:<user_id>`); recorded on a
   *  dropped-turn entry so the replay path can re-deliver the recovered reply. */
  delivery_topic_id?: string
  /** S3 #106 — injected redelivery sink the persistent substrate calls when the
   *  replay path recovers a reply a crash dropped (deliver-or-persist by the
   *  gateway). */
  onRecoveredReply?: (reply: RecoveredReply) => void | Promise<void>
  /**
   * O6 — NOTICE-FAMILY DI seams the persistent substrate fires on the rising edge
   * of a detected condition (the substrate never imports `gateway/*`). Forwarded
   * onto `ClaudeCodeSubstrateOptions` so a gateway caller can wire user-facing
   * chat delivery instead of the substrate's stderr-only fallback. All three are
   * NOTIFY-ONLY (no keystroke, no auto-retry) and edge-latched UPSTREAM by the
   * substrate (per-turn / per `threadId::severity`), so wiring the callback
   * inherits the fire-once-per-rising-edge guarantee — the sink does not re-latch.
   *   - `onDeadTurnNotice`   (row #11) — a mid-turn API 5xx killed a turn.
   *   - `onSizeAlert`        (row #13) — a warm transcript crossed a warn/critical band.
   *   - `onRateLimitBanner`  (row #10) — a rate-limit / usage-cap banner appeared.
   * Wired ONLY on the owner's conversational substrate (`cc-agent-*`); the
   * stateless-utility / import / trident substrates leave them unset (stderr). */
  onDeadTurnNotice?: (notice: DeadTurnNotice) => void | Promise<void>
  onSizeAlert?: (info: { sessionKey: string; severity: SizeSeverity; sizeBytes: number }) => void
  onRateLimitBanner?: (notice: RateLimitBannerNotice) => void | Promise<void>
  /**
   * Optional `owner_handle` keyed against `oauthRefresh.loadAccessToken`.
   * Required when `oauthRefresh` is wired; ignored otherwise.
   *
   * Optional (not mandatory) because some LLM call sites are platform-
   * internal rather than per-instance — for those, the resolver picks a
   * BYO or shared env credential and no Max OAuth refresh is needed.
   */
  owner_handle?: string
  /** Max OAuth refresh handle — see build-import-substrate.ts for context. */
  oauthRefresh?: OAuthCredentialSource
  /**
   * Override the `claude` binary path threaded into the subprocess
   * substrate. Default behavior: `process.env.CLAUDE_BIN ?? 'claude'`.
   */
  claude_bin?: string
  /**
   * When true, thread `--dangerously-skip-permissions` into the spawned
   * `claude` REPL. Managed-tier deployments set this so the headless REPL
   * doesn't block on interactive prompts.
   *
   * PREFER `profile` (below) over this raw field for production call sites — it
   * is retained for backward compat (tests / callers that set the knob inline).
   * When `profile` is supplied, `profile.skip_permissions` WINS; this field is
   * the fallback only when no profile is threaded.
   */
  skip_permissions?: boolean
  /**
   * SECURITY PROFILE (tool-security redesign Step 0) — the single-source bag of
   * SECURITY-relevant spawn knobs (`skip_permissions` today; reserved shape for
   * `permission_mode` / `claude_config_dir` / `extra_env` / `sandbox`). Supplied
   * by the 8 production sites in place of the inline `skip_permissions: true`
   * literal so the later permission migration is N constant edits, not 8 risky
   * per-site edits. See `substrate-profiles.ts`.
   *
   * Precedence (all BEHAVIOUR-PRESERVING today, since no profile sets the
   * reserved fields and no live site sets the legacy per-call inputs): a
   * profile field WINS over the matching legacy per-call input
   * (`skip_permissions` / `claude_config_dir` / `extra_env`); an absent profile
   * field falls back to that input. `permission_mode` and `sandbox` are reserved
   * shape only and are NOT applied yet (no `ClaudeCodeSubstrateOptions` field).
   */
  profile?: SubstrateProfile
  /**
   * Substrate-construction seam. Defaults to `createClaudeCodeSubstrateAuto`
   * (the persistent interactive-REPL substrate — the SOLE production path).
   * Tests inject a fake `Substrate` so composer logic (credential selection +
   * rotation, ISSUES-#49 env scrubbing, cooldown classification) is exercised
   * WITHOUT spawning a real `claude` REPL. The factory receives the fully-
   * composed `ClaudeCodeSubstrateOptions` (incl. the scrubbed env +
   * `credential_identity`), so a fake can assert on the spawn contract directly.
   */
  substrateFactory?: (opts: ClaudeCodeSubstrateOptions) => Substrate
  /**
   * Extra env overlay layered onto EVERY spawn AFTER the auth-scrub step
   * (`resolveScrubbedAuthEnv`). Values follow the same `string | undefined`
   * contract as the auth env: `undefined` deletes the inherited var, a string
   * sets it. A general per-substrate spawn knob — e.g. a caller could inject
   * `MAX_THINKING_TOKENS=0` to keep a latency-sensitive classifier spawn from
   * burning 20-40s on extended thinking. (No production caller sets `extra_env`
   * today; the onboarding router that once motivated it never wired it and is
   * being removed — see the K9 entry (2026-07-04) in docs/AS_BUILT.md. Kept as the substrate's
   * generic env-overlay seam, exercised by the substrate unit test.)
   *
   * Scope note: layered per-substrate, so a dedicated substrate can carry this
   * overlay while the shared `llmCallSubstrate` does not. Keys here win over the
   * auth-scrub env on collision (applied last).
   */
  extra_env?: Record<string, string | undefined>
  /**
   * Argus r4 BLOCKER (2026-06-08) — STATELESS-ONE-SHOT mode. When `true`, every
   * `start(spec)` with no `spec.session` runs on a FRESH disposable REPL that is
   * terminated after its single turn, instead of reusing a warm pooled session.
   *
   * The persistent REPL re-keys the warm pool on (instance, user, project,
   * credential) but NOT on call-PURPOSE, so the SEVEN+ stateless utility callers
   * that share ONE `cc-llm-*` substrate (scribe, phase-spec resolver, agent-
   * watcher, nudge, research, wow, the onboarding suggesters/persona/seed
   * composers) would otherwise collapse into ONE ever-growing Claude conversation
   * per (user, project, cred): cross-purpose semantic bleed (onboarding phase
   * correctness is a CLAUDE.md HARD RULE) + unbounded transcript growth. Pre-S3
   * each was a fresh `claude -p` per call; the rip-replace (d3c7a0e) deleted that
   * path. This flag restores per-one-shot isolation on the persistent substrate.
   *
   * Set ONLY on the shared `cc-llm-*` substrate. The router (`cc-llm-router-*`)
   * and any conversational substrate leave it unset so they keep their warm
   * pooled REPL (latency). A dispatch carrying a real `spec.session` pools even
   * on an ephemeral substrate — the flag only changes the session-less path.
   */
  ephemeral?: boolean
  /**
   * PER-TURN CONTEXT RESET (2026-06-17, import warm-session). When `true`, a
   * session-less dispatch on a REUSED warm REPL built by this substrate is
   * preceded by a `/clear` so each turn runs on a freshly-cleared context.
   * The history-import composer sets this on the dedicated `cc-import-*`
   * substrate so all Pass-1/Pass-2 chunks flow through ONE warm `claude`
   * process WITHOUT accumulating each chunk into one ballooning transcript.
   * Leave unset on the conversational / router / shared one-shot substrates.
   */
  reset_context_per_turn?: boolean
  /**
   * P0-1 — opt the spawned REPL into the native-MCP tool bridge so the agent
   * can make structured, self-initiated Core/tool calls mid-reasoning. Set ONLY
   * on the owner's WARM conversational substrate (`cc-agent-*`); left unset on
   * the untrusted history-import (`cc-import-*`) and disposable Trident
   * (`cc-trident-*`) substrates so a prompt-injection in imported/untrusted
   * content can never reach a Core tool.
   */
  enableToolBridge?: boolean
  /**
   * SWAPPABLE MODEL PROVIDER — the conversational/utility backend for THIS
   * substrate. Absent ⇒ `'anthropic'` (Claude Code) — the default and primary
   * orchestration backend, BYTE-IDENTICAL to the pre-provider composer: the
   * resolved factory is `createClaudeCodeSubstrateAuto` and the whole
   * credential-scrub / warm-pool / cooldown path below is unchanged. A project
   * that opts into `'openai'` / `'openai-codex-cli'` routes each turn through the
   * matching adapter (see `openai` config + `providerResolver`).
   *
   * SCOPE — conversational / utility LLM turns ONLY. Trident's autonomous build
   * loop (the native `Workflow` inner loop) has NO OpenAI analogue and MUST stay
   * on Claude Code regardless of this setting; the trident-fire substrate is
   * built WITHOUT a provider so it always resolves to `'anthropic'`.
   */
  provider?: Provider
  /**
   * PER-TURN provider resolver — mirrors `projectIdResolver`. Re-evaluated on
   * EVERY `start(spec)` so the ACTIVE project's provider selection is honored
   * per turn (the "per-project resolved per-turn" granularity). Its result wins
   * over the static `provider`; an absent/undefined/empty result falls back to
   * `provider`, then to `'anthropic'`. An UNKNOWN non-empty string THROWS via
   * `normalizeProvider` (fail-loud, never a silent Claude fallback) — production
   * only ever resolves a valid `Provider` here, so this never trips in practice.
   */
  providerResolver?: () => Provider | string | undefined
  /**
   * OpenAI-family (`'openai'` / `'openai-codex-cli'`) configuration. Consumed
   * ONLY when the resolved provider is non-anthropic; ignored for the default
   * Claude Code path. When the provider resolves non-anthropic and this is
   * absent (or, for `'openai'`, its `mcpResolver` is missing) the substrate
   * degrades LOUDLY with a terminal `error` event rather than silently.
   */
  openai?: OpenAiFamilyProviderConfig
}

/**
 * Per-provider config for the OpenAI-family adapters. The credential pool is
 * SEPARATE from the anthropic pool (`OPENAI_API_KEY`, resolved via
 * `resolveLlmCredentials({provider:'openai'})`) — never the anthropic pool, so
 * an anthropic BYO key can't leak onto an OpenAI call.
 */
export interface OpenAiFamilyProviderConfig {
  /** Eager OpenAI credential pool (tests / pre-resolved callers). */
  pool?: CredentialPool
  /** Lazy OpenAI credential pool — re-run per `start()` (mirrors `resolvePool`). */
  resolvePool?: () => Promise<CredentialPool | null>
  /**
   * PROJECT-BOUND MCP resolver FACTORY (audit High — project scoping). The GPT
   * adapter's `McpToolResolver` receives only `{call_id,tool_name,args}`, but the
   * `ReplToolBridge.dispatch` needs the originating `project_id` to bind
   * project-scoped tools (work_board_*, dispatch, …) — exactly like the Claude
   * path threads `ReplSession.projectId → McpServer.dispatch({project_id})`. The
   * composer calls this factory PER TURN with the active project, so the returned
   * resolver closes over the right `project_id`. Mirrors `mcpServer.resolveBound(ctx)`.
   * REQUIRED for `'openai'`; the codex-cli adapter resolves MCP tools server-side.
   */
  bindMcpResolver?: (bind: { project_id?: string }) => McpToolResolver
  /**
   * HONEST TOOL MANIFEST (audit BLOCKER 1). The conversational `spec.tools`
   * carries Claude-Code NATIVE tool names (`Read`, `Write`, `Bash`, `Skill`,
   * `Workflow`, …) that only the Claude adapter can execute — they are NOT
   * MCP-registered, so the GPT adapter would advertise them to OpenAI as callable
   * functions it cannot honor (a call would hit `mcpResolver` for an unregistered
   * tool and fail). To obey "surface degradation, never silently break", the GPT
   * path REPLACES `spec.tools` with ONLY the tools this manifest reports — the
   * REAL MCP-registered tools the `mcpResolver` can actually execute (production
   * wires `() => mcpServer.listToolSchemas()`). Absent ⇒ the GPT turn advertises
   * NO tools (pure conversation) rather than falsely-advertised Claude built-ins.
   */
  toolManifest?: () => ReadonlyArray<{ name: string; description: string; input_schema: unknown }>
  /**
   * Model-preference override for the OpenAI-family turn. The gpt adapter reads
   * `spec.model_preference`; the caller's `spec` carries CLAUDE ids for the
   * anthropic path, so a non-anthropic turn MUST remap them to OpenAI ids (see
   * `runtime/models-openai.ts`). Absent ⇒ the spec's `model_preference` is used
   * as-is (only correct if the caller already built an OpenAI-shaped spec).
   */
  model_preference?: ReadonlyArray<string>
  /** Override the OpenAI Responses endpoint (tests). */
  endpoint?: string
  /** Cap tool-call rounds per turn (openai-responses adapter). */
  max_tool_rounds?: number
  /**
   * Extra env overlay for the adapter. For codex-cli this is where the selected
   * credential's `OPENAI_API_KEY` is threaded (the adapter defaults env to `{}`
   * and never reads host `process.env` — ISSUES #67).
   */
  env?: Readonly<Record<string, string | undefined>>
  /** codex-cli: override CODEX_HOME. */
  codex_home?: string
  /** codex-cli: override the `codex` binary path. */
  codex_bin?: string
  /**
   * Test seam — override `fetch` for the openai-responses adapter (mirrors the
   * adapter's own `fetchImpl`). Production leaves this unset. Lets the composer's
   * OpenAI path be unit-tested end-to-end against a mocked Responses stream
   * without a live `OPENAI_API_KEY`.
   */
  fetchImpl?: typeof fetch
  /** Test seam — override `spawn` for the codex-cli adapter (mirrors `spawnImpl`). */
  spawnImpl?: CodexCliSubstrateOptions['spawnImpl']
}

/**
 * Construct a CC-subprocess Substrate that delegates each `start(spec)`
 * call to a freshly-selected credential from the resolved pool. Returns
 * null only when the eager `pool` was supplied AND it's empty at boot;
 * the lazy `resolvePool` path always returns a non-null Substrate because
 * the per-call resolver is the decision point.
 *
 * Mirrors `buildImportSubstrate` exactly — same pattern, same cooldown
 * reporting, same env-scrubbing discipline. The only difference is the
 * default-error message text (callers downstream of THIS substrate
 * typically aren't running an `ImportJobRunner`, so we don't tag failures
 * with import-specific framing).
 */
export function buildLlmCallSubstrate(
  input: BuildLlmCallSubstrateInput,
): Substrate | null {
  if (input.pool === undefined && input.resolvePool === undefined) {
    throw new Error(
      'buildLlmCallSubstrate: exactly one of `pool` (eager) or `resolvePool` (lazy) must be supplied',
    )
  }
  if (input.pool !== undefined && input.resolvePool !== undefined) {
    throw new Error(
      'buildLlmCallSubstrate: cannot supply BOTH `pool` and `resolvePool` — pick one',
    )
  }
  if (input.pool !== undefined && input.pool.credentials.length === 0) {
    return null
  }
  // Cross-turn continuity ledger for the STATELESS OpenAI-family providers (audit
  // CRITICAL). Lives on THIS substrate's closure so it persists across `start()`
  // calls. The Claude path never touches it. Keyed per conversation so distinct
  // (user, project) turns keep separate upstream sessions — mirroring the CC
  // warm-pool key dimensions.
  const openaiSessions: OpenAiSessionLedger = new Map()
  return {
    start(spec: AgentSpec): SessionHandle {
      // SWAPPABLE PROVIDER — resolve the backend for THIS turn. A NON-EMPTY per-turn
      // resolver value wins (active-project provider); an EMPTY/whitespace resolver
      // result means "no dynamic override this turn" → defer to the statically
      // configured `provider` (which may be 'openai'); only when BOTH are
      // absent/empty do we get the 'anthropic' default. Passing an empty string
      // straight to normalizeProvider would resolve to Anthropic and SILENTLY route
      // an explicit-openai turn to Claude (audit High). When non-anthropic, delegate
      // to the OpenAI-family path; the anthropic block below stays BYTE-IDENTICAL.
      const resolvedProvider = input.providerResolver?.()
      const effectiveProvider =
        resolvedProvider !== undefined && resolvedProvider !== null && resolvedProvider.trim() !== ''
          ? resolvedProvider
          : input.provider
      const provider = normalizeProvider(effectiveProvider)
      if (provider !== 'anthropic') {
        // Conversation key mirrors the CC warm-pool key dimensions (user +
        // live active project) so continuity is scoped identically across
        // providers.
        // SCOPE-KEY SAFETY (audit High) — resolve the raw project id (undefined
        // when absent; NEVER a `'default'` literal that would collide with a real
        // project named 'default'), then build a COLLISION-SAFE continuity key via
        // structural encoding. Also thread the raw projectId for tool scoping so an
        // absent project binds to null (not the string 'default').
        const scopeUserId = input.user_id ?? '_platform'
        const rawProjectId = input.projectIdResolver?.() ?? spec.metering_context?.project_id
        const scopeProjectId =
          rawProjectId !== undefined && rawProjectId.length > 0 ? rawProjectId : undefined
        const sessionKey = openAiSessionScopeKey(scopeUserId, scopeProjectId)
        return startOpenAiFamilySession({
          provider,
          spec,
          substrate_instance_id: input.substrate_instance_id,
          config: input.openai,
          sessionLedger: openaiSessions,
          sessionKey,
          ...(scopeProjectId !== undefined ? { projectId: scopeProjectId } : {}),
        })
      }
      let innerHandle: SessionHandle | null = null
      let cancelled = false
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        // DECISION doc Part 3c — credential selection + Max-OAuth refresh +
        // ISSUES-#49 env-scrubbing is now the shared `resolveScrubbedAuthEnv`
        // helper (so the warm reused router process applies the IDENTICAL
        // discipline). The helper throws a reason-tagged
        // `ScrubbedAuthEnvError`; we catch and re-yield the EXACT terminal
        // `Event` (message + retryable) this generator emitted inline before
        // the refactor, so the substrate's behaviour + tests are unchanged.
        let resolved: ResolveScrubbedAuthEnvResult
        try {
          const helperInput: ResolveScrubbedAuthEnvInput = {}
          if (input.pool !== undefined) helperInput.pool = input.pool
          if (input.resolvePool !== undefined) helperInput.resolvePool = input.resolvePool
          if (input.oauthRefresh !== undefined) helperInput.oauthRefresh = input.oauthRefresh
          if (input.owner_handle !== undefined) {
            helperInput.owner_handle = input.owner_handle
          }
          resolved = await resolveScrubbedAuthEnv(helperInput)
        } catch (err) {
          if (err instanceof ScrubbedAuthEnvError) {
            // `all_cooldown` was retryable:true; `no_credentials` and
            // `oauth_refresh` were retryable:false — preserved verbatim. O3 —
            // stamp the typed class (the reason IS a `SubstrateErrorClass`) so
            // downstream consumers read `code` instead of the prose.
            yield {
              kind: 'error',
              message: err.message,
              retryable: err.reason === 'all_cooldown',
              code: err.reason,
            }
            return
          }
          throw err
        }
        const { env, pool } = resolved
        const cred = { id: resolved.cred_id }
        // SECURITY-PROFILE resolution (tool-security redesign Step 0). The
        // security knobs (`skip_permissions` / `claude_config_dir` / `extra_env`)
        // now live on a single-source `profile`; a profile field WINS over the
        // matching legacy per-call input, an absent profile field falls back to
        // it. BEHAVIOUR-PRESERVING today: no profile sets the reserved fields and
        // no live site sets these per-call inputs, so each `??` resolves to the
        // exact same value the pre-refactor inline literal produced. The reserved
        // `profile.permission_mode` / `profile.sandbox` are shape-only (no
        // `ClaudeCodeSubstrateOptions` field yet) and deliberately NOT applied
        // here — that is Phase B / Phase D of the redesign.
        const effectiveSkipPermissions = input.profile?.skip_permissions ?? input.skip_permissions
        const effectiveClaudeConfigDir = input.profile?.claude_config_dir ?? input.claude_config_dir
        const effectiveExtraEnv = input.profile?.extra_env ?? input.extra_env
        // Layer the optional `extra_env` overlay AFTER the auth-scrub env so
        // per-substrate spawn knobs (e.g. a `MAX_THINKING_TOKENS=0` classifier
        // knob) win over inherited vars without disturbing the auth scrubbing. The
        // `undefined`-deletes contract is preserved downstream by the REPL spawn
        // env merge.
        const spawnEnv: Record<string, string | undefined> =
          effectiveExtraEnv !== undefined ? { ...env, ...effectiveExtraEnv } : env
        const opts: ClaudeCodeSubstrateOptions = {
          substrate_instance_id: input.substrate_instance_id,
          env: spawnEnv,
        }
        if (input.cwd !== undefined) opts.cwd = input.cwd
        // Ritual executor (plan task 4) — a non-default system prompt file so the
        // scheduled REPL runs as an unattended executor rather than the chat
        // persona. Absent ⇒ the substrate's `repl-agent-base.md` default.
        if (input.append_system_prompt_file !== undefined) {
          opts.appendSystemPromptFile = input.append_system_prompt_file
        }
        if (effectiveClaudeConfigDir !== undefined) opts.claude_config_dir = effectiveClaudeConfigDir
        if (input.claude_bin !== undefined) opts.claude_bin = input.claude_bin
        if (effectiveSkipPermissions !== undefined) opts.skip_permissions = effectiveSkipPermissions
        // S3 §2 — fold the SELECTED credential id (#104) + the conversational
        // identity into the warm-pool key. `cred.id` is the `PooledCredential.id`
        // (never the secret); a rotation changes it → re-keys to a fresh REPL under
        // the new env so cooldown attribution matches the child. `user_id` is
        // per-instance (input).
        opts.credential_identity = cred.id
        if (input.user_id !== undefined) opts.user_id = input.user_id
        // S3 §2 / Argus r3 BLOCKER — the LIVE per-turn project id. `spec.
        // metering_context?.project_id` is a DEAD dimension on the CC adapter
        // (Private-substrate-only; never populated by conversational call sites),
        // so keying off it collapsed an owner's every project into one warm REPL =
        // cross-project context bleed. Resolve the live active-chat project via
        // the injected resolver (re-evaluated per dispatch) and fall back to the
        // metering field only for any caller that genuinely populates it.
        const projectId =
          input.projectIdResolver?.() ?? spec.metering_context?.project_id
        if (projectId !== undefined && projectId.length > 0) opts.project_id = projectId
        // CROSS-PROVIDER CONTINUITY (audit round 14) — this Claude turn is handling
        // the scope, so INVALIDATE any stored OpenAI continuation for it: a later
        // OpenAI turn on this scope must replay the FULL history (`spec.messages`)
        // instead of resuming a `previous_response_id` that predates (and can't see)
        // this intervening Claude turn — otherwise this turn silently vanishes from
        // the OpenAI-side conversation. Pure ledger bookkeeping — the CC option bag,
        // spec, and factory are UNTOUCHED (Claude path stays byte-identical). The
        // scope key matches the openai path's exactly (same user + project transform).
        openaiSessions.delete(
          openAiSessionScopeKey(
            input.user_id ?? '_platform',
            projectId !== undefined && projectId.length > 0 ? projectId : undefined,
          ),
        )
        if (input.project_slug !== undefined) opts.instance_slug = input.project_slug
        if (input.delivery_topic_id !== undefined) opts.delivery_topic_id = input.delivery_topic_id
        if (input.onRecoveredReply !== undefined) opts.onRecoveredReply = input.onRecoveredReply
        // O6 — forward the notice-family sinks so the substrate delivers a
        // rising-edge dead-turn / size-alert / rate-limit-banner notice to the
        // gateway's chat surface instead of only stderr. Unset on every non-
        // conversational substrate (they keep the stderr-only default).
        if (input.onDeadTurnNotice !== undefined) opts.onDeadTurnNotice = input.onDeadTurnNotice
        if (input.onSizeAlert !== undefined) opts.onSizeAlert = input.onSizeAlert
        if (input.onRateLimitBanner !== undefined) opts.onRateLimitBanner = input.onRateLimitBanner
        // Argus r4 BLOCKER — stateless one-shot disposable-REPL mode: a session-
        // less dispatch on this substrate gets a fresh REPL terminated after the
        // turn, so distinct one-shot purposes never share a `--resume` transcript.
        if (input.ephemeral !== undefined) opts.ephemeral = input.ephemeral
        // Import warm-session — per-turn `/clear` reset on a reused warm REPL so
        // each chunk runs on a fresh context (ONE warm process, isolated turns).
        if (input.reset_context_per_turn !== undefined) {
          opts.reset_context_per_turn = input.reset_context_per_turn
        }
        // P0-1 — native-MCP tool bridge opt-in (conversational substrate only).
        if (input.enableToolBridge !== undefined) {
          opts.enableToolBridge = input.enableToolBridge
        }
        // `createClaudeCodeSubstrateAuto` UNCONDITIONALLY builds the persistent
        // interactive-REPL substrate (the sole spawn shape post-S3-rip-replace).
        // The `substrateFactory` seam lets tests inject a fake substrate.
        const factory = input.substrateFactory ?? createClaudeCodeSubstrateAuto
        innerHandle = factory(opts).start(spec)
        if (cancelled) {
          await innerHandle.cancel()
          return
        }
        let reported = false
        for await (const ev of innerHandle.events) {
          if (!reported) {
            if (ev.kind === 'completion') {
              reported = true
              reportSuccess(pool, cred.id)
            } else if (ev.kind === 'error') {
              reported = true
              // Binary-not-found (ENOENT) is FATAL + non-retryable, NOT a
              // credential cooldown. The CC adapter surfaces a spawn ENOENT as a
              // retryable error, which would otherwise launder into a 429 pool
              // cooldown → "all credentials in cooldown" → an infinite wait on a
              // binary that will never appear (the 2026-06-17 import-blocker).
              // Classify it FIRST: skip the pool cooldown entirely and re-emit a
              // distinct, actionable error so the caller fails fast + loud.
              // O3 — a STAMPED code is AUTHORITATIVE: the message regexes run
              // ONLY when the producer left `code` unset (a legacy/unstamped
              // event), so a stamped class is never overridden by conflicting
              // prose (`{code:'turn_timeout', message:'…ENOENT'}` must NOT read
              // as fatal binary-not-found). One release of regex fallback.
              const stampedCode = ev.code
              if (
                stampedCode === 'binary_not_found' ||
                (stampedCode === undefined && detectBinaryNotFound(ev.message))
              ) {
                yield { kind: 'error', message: BINARY_NOT_FOUND_MESSAGE, retryable: false, code: 'binary_not_found' }
                continue
              }
              // P0 ROOT-CAUSE FIX (b): a persistent-REPL spawn/channel failure
              // (`channel-wedged`, `no-channel-ready`, `no-http-health`,
              // `dead-child`) is a SUBSTRATE failure, NOT a credential condition.
              // The CC adapter surfaces it as a retryable error with no HTTP
              // status, so the `else` branch below would `mapStatusForPoolCooldown
              // (null, retryable=true)` → 429 → `reportFailure` cools down a
              // perfectly healthy credential. Repeated across the pool this lands
              // as "all Anthropic credentials are in cooldown (429/402/401)" — the
              // exact MISLABEL the live dogfood hit while the real cause was the
              // dev-channel MCP never binding (see the substrate's
              // MCP_CONNECTION_NONBLOCKING fix). Classify it BEFORE the cooldown
              // map (mirrors the binary-not-found fast-path): skip the pool
              // cooldown entirely and re-emit a distinct error that names the real
              // class so the credential is never wrongly parked.
              if (
                stampedCode === 'channel_wedged' ||
                (stampedCode === undefined && detectChannelWedged(ev.message))
              ) {
                yield { kind: 'error', message: CHANNEL_WEDGED_MESSAGE, retryable: false, code: 'channel_wedged' }
                continue
              }
              // P0a ROOT-CAUSE FIX (2026-06-26 chat-blocker): a per-turn TIMEOUT
              // (`persistent-repl: turn timeout`) is a transient TURN failure —
              // the warm REPL was slow/wedged on THIS turn, not the credential.
              // The substrate surfaces it RETRYABLE with no HTTP status, so the
              // `else` branch below maps `mapStatusForPoolCooldown(null, true)` →
              // 429 → `reportFailure` parks a perfectly healthy credential.
              // Across a few timed-out turns the whole pool cools down and EVERY
              // subsequent turn dies with "all Anthropic credentials are in
              // cooldown (429/402/401)" — the exact cascade the live dogfood hit
              // (one slow "whats the veeva narrative?" turn timed out, then the
              // next turns showed "your AI connection may need attention"). The
              // substrate already self-heals a timeout by POISONING the warm
              // session so the NEXT dispatch respawns a clean REPL
              // (persistent-repl-substrate.ts:2707); that recovery only works if
              // the credential is NOT wrongly parked here. Classify it BEFORE the
              // cooldown map (mirrors binary-not-found / channel-wedged): skip the
              // pool cooldown entirely and re-emit the timeout UNCHANGED
              // (retryable:true) so the turn is retried on the SAME healthy
              // credential, never laundered into a quota lie.
              if (
                stampedCode === 'turn_timeout' ||
                (stampedCode === undefined && detectTurnTimeout(ev.message))
              ) {
                yield ev
                continue
              }
              // O3 — the cooldown classification is ALSO code-authoritative: the
              // prose classifiers (`parseHttpStatusFromMessage` / `detectCliAuth
              // Failure`) run ONLY for a legacy/unstamped event. A stamped class
              // is mapped by CODE so, e.g., a caller-cancelled `aborted` turn is
              // never mis-cooled as a 401 just because its prose says `HTTP 401`.
              let cooldownStatus: number | null
              if (stampedCode !== undefined) {
                if (stampedCode === 'aborted') {
                  // Caller cancellation — never a credential fault; no cooldown.
                  cooldownStatus = null
                } else if (stampedCode === 'rate_limited') {
                  cooldownStatus = 429
                } else if (stampedCode === 'http_status') {
                  // The numeric status lives in the `HTTP <n>:` message prefix.
                  cooldownStatus = mapStatusForPoolCooldown(parseHttpStatusFromMessage(ev.message), ev.retryable)
                } else {
                  // Every OTHER stamped class is NOT a fault of the SELECTED
                  // credential: `aborted` is a caller cancel; `all_cooldown` /
                  // `no_credentials` / `oauth_refresh` describe POOL/auth state
                  // (and are emitted by the composer's own pre-dispatch path, not
                  // the inner handle); the substrate classes short-circuit above.
                  // None must `reportFailure` on the healthy selected credential —
                  // in particular `all_cooldown` (retryable:true) must NOT map to
                  // 429 and cool the very credential the caller just picked.
                  cooldownStatus = null
                }
              } else {
                const httpStatus = parseHttpStatusFromMessage(ev.message)
                if (httpStatus !== null) {
                  cooldownStatus = mapStatusForPoolCooldown(httpStatus, ev.retryable)
                } else if (detectCliAuthFailure(ev.message)) {
                  cooldownStatus = 401
                } else {
                  cooldownStatus = mapStatusForPoolCooldown(null, ev.retryable)
                }
              }
              if (cooldownStatus !== null) {
                if (ev.retry_after_ms !== undefined) {
                  reportFailure(pool, cred.id, cooldownStatus, ev.retry_after_ms)
                } else {
                  reportFailure(pool, cred.id, cooldownStatus)
                }
              }
            }
          }
          yield ev
        }
      })()
      const handle: SessionHandle = {
        events,
        async respondToTool(call_id: string, result: unknown): Promise<void> {
          if (innerHandle !== null) return innerHandle.respondToTool(call_id, result)
          throw new Error(
            'cc-llm-call substrate: respondToTool called before substrate dispatched (caller bug; tool_resolution=internal)',
          )
        },
        async cancel(): Promise<void> {
          cancelled = true
          if (innerHandle !== null) await innerHandle.cancel()
        },
        tool_resolution: 'internal',
      }
      return handle
    },
  }
}

/**
 * A tiny in-memory cross-turn continuity ledger for the STATELESS OpenAI-family
 * adapters. Maps a per-conversation key → the last `session` hint carried on a
 * `completion` event (OpenAI `previous_response_id` / codex `--resume` thread id).
 *
 * WHY THIS EXISTS (audit CRITICAL): Claude Code keeps conversational continuity
 * IMPLICITLY in its warm REPL transcript (pool-key continuity) and IGNORES
 * `spec.session` — so no caller in the codebase threads `spec.session` today. A
 * stateless provider given no session is AMNESIAC every turn (silent — no error).
 * This ledger persists the completion's `session` and threads it back as
 * `spec.session` on the next dispatch for the SAME conversation key, so
 * multi-turn GPT/codex turns retain context. The Claude path never consults this
 * (it stays behavior-identical by construction — the CC adapter ignores session).
 *
 * SCOPE / KNOWN GAP: this ledger is per-gateway-process + in-memory, so it does
 * NOT survive a restart, and it does NOT yet rebuild history via `spec.messages`
 * when an upstream session EXPIRES (OpenAI response-id TTL / codex session prune).
 * A durable ledger + `spec.messages` replay (rebuilt from the chat log) is the
 * required follow-up before GPT is production-grade for long-lived conversations.
 */
export type OpenAiSessionLedger = Map<
  string,
  { id: string; last_active_at: number; provider: string }
>

/**
 * COLLISION-SAFE continuity scope key (audit High) for {@link OpenAiSessionLedger}.
 *
 * A naive `${userId}:${projectId}` key leaks conversation history across scope
 * boundaries: `(user='a:b', project='c')` and `(user='a', project='b:c')` both
 * flatten to `"a:b:c"`, and an ABSENT project (`undefined`) collides with a real
 * project literally named `"default"`. A collision means one conversation's
 * `previous_response_id` is replayed into another → cross-user / cross-project
 * context bleed. Structural JSON encoding makes every id boundary explicit — no
 * delimiter inside any id can forge another scope's key — and encodes an absent
 * project as `null`, which is a DISTINCT key from every real project name.
 */
export function openAiSessionScopeKey(
  userId: string,
  projectId: string | undefined | null,
): string {
  return JSON.stringify([userId, projectId ?? null])
}

/**
 * Dispatch ONE turn through an OpenAI-family adapter (`'openai'` /
 * `'openai-codex-cli'`), selected via the platform-band `selectSubstrateFactory`.
 *
 * Shared by BOTH `buildLlmCallSubstrate` and `buildImportSubstrate`. Mirrors the
 * anthropic path's discipline — per-turn credential selection from a LIVE pool +
 * completion/error feedback into the pool's cooldown clock — but against the
 * SEPARATE OpenAI credential pool and the OpenAI adapters' own option bags. The
 * gpt/codex adapters both expose `tool_resolution='internal'` and a throwing
 * `respondToTool`, so the caller-facing handle shape matches the CC path exactly.
 *
 * CONTINUITY: when a `sessionLedger` + `sessionKey` are supplied (conversational
 * callers), the last completion's `session` is threaded back as `spec.session` so
 * the stateless provider is NOT amnesiac across turns. Stateless one-shot callers
 * (history import — each chunk independent) omit the ledger.
 *
 * Degrades LOUDLY (terminal `error` event, `retryable:false`) when the OpenAI
 * config is missing — a project that selected `'openai'` but wasn't wired an
 * OpenAI pool / `mcpResolver` gets a clear failure, never a silent fallback.
 */
export function startOpenAiFamilySession(args: {
  provider: 'openai' | 'openai-codex-cli'
  spec: AgentSpec
  substrate_instance_id: string
  config: OpenAiFamilyProviderConfig | undefined
  /** Cross-turn continuity ledger — omit for stateless one-shot callers. */
  sessionLedger?: OpenAiSessionLedger
  /** COLLISION-SAFE conversation key into `sessionLedger` — built via
   *  {@link openAiSessionScopeKey} (structural JSON of `[userId, projectId|null]`),
   *  so no id delimiter can forge another scope's key and absent ≠ 'default'. */
  sessionKey?: string
  /** Active project id for THIS turn — bound into the MCP resolver so
   *  project-scoped tools dispatch with the correct scope (audit High). */
  projectId?: string
}): SessionHandle {
  const { provider, spec, substrate_instance_id, config, sessionLedger, sessionKey, projectId } = args
  let innerHandle: SessionHandle | null = null
  let cancelled = false
  const events = (async function* (): AsyncGenerator<Event, void, void> {
   // SINGLE-CHOKEPOINT LEDGER INVALIDATION (audit round 17) — compute the ledger
   // key BEFORE any setup / pool resolution / credential check so EVERY exit path
   // has it in scope, and invalidate it in the `finally` below on ANY non-success
   // exit (pool-null, all-credentials-cooling, setup/iterator throw, stream error,
   // expired-session, mid-switch, cancel). `committed` flips true ONLY after a
   // clean completion has stored the fresh response id. This replaces the scattered
   // per-error-path deletes, so no future exit path can silently regress continuity
   // (a resumed-but-failed turn otherwise leaks a stale previous_response_id that
   // drops the failed turn's history from the next turn).
   const ledgerKey =
     sessionLedger !== undefined && sessionKey !== undefined && sessionKey.length > 0
       ? sessionKey
       : undefined
   let committed = false
   // SETUP GUARD (audit) — the OpenAI path promises to "degrade LOUDLY (terminal
   // error event)". Pool resolution (`await config.resolvePool()`), manifest
   // resolution (`config.toolManifest()`), and adapter construction/`start()` can
   // all THROW; without this guard a throw would REJECT the caller's `for await`
   // instead of yielding a terminal `error`. Wrap the whole setup+dispatch so any
   // throw becomes an `error` event on the stream. (The shape-checks below yield
   // their own terminal errors and `return`.)
   try {
    if (config === undefined) {
      yield {
        kind: 'error',
        message:
          `model provider '${provider}' was selected but no OpenAI-family config ` +
          `was wired into the substrate (missing credential pool + mcpResolver). ` +
          `Configure OPENAI_API_KEY and thread an mcpResolver, or leave the ` +
          `provider unset to use Claude Code.`,
        retryable: false,
      }
      return
    }
    if (provider === 'openai' && config.bindMcpResolver === undefined) {
      yield {
        kind: 'error',
        message:
          "model provider 'openai' requires a bindMcpResolver so tools work in " +
          'internal mode (production passes a project-bound mcpServer.resolveBound(ctx)); none was wired.',
        retryable: false,
      }
      return
    }
    // Resolve the LIVE OpenAI pool (lazy re-run per call, or eager boot pool).
    let pool: CredentialPool
    if (config.pool !== undefined) {
      pool = config.pool
    } else if (config.resolvePool !== undefined) {
      const resolved = await config.resolvePool()
      if (resolved === null || resolved.credentials.length === 0) {
        yield {
          kind: 'error',
          message:
            `no OpenAI credentials available at dispatch time (provider='${provider}'). ` +
            'Configure OPENAI_API_KEY in the per-project `.env` or attach a BYO OpenAI key, then retry.',
          retryable: false,
        }
        return
      }
      pool = resolved
    } else {
      yield {
        kind: 'error',
        message: `provider='${provider}': neither an eager pool nor a resolvePool was wired`,
        retryable: false,
      }
      return
    }
    const cred = selectCredential(pool)
    if (cred === null) {
      yield {
        kind: 'error',
        message: `all OpenAI credentials are in cooldown (429/401). Retry once the rate-limit window passes.`,
        retryable: true,
      }
      return
    }
    // HONEST TOOL MANIFEST (audit BLOCKER 1) — the incoming `spec.tools` carries
    // Claude-NATIVE tool names (Read/Write/Bash/Skill/Workflow) that the OpenAI
    // adapter cannot execute. Replace them with ONLY the real MCP-registered tools
    // the resolver can honor (or NONE), so GPT never advertises a tool it can't run.
    const openaiTools: ToolDef[] =
      config.toolManifest !== undefined
        ? config.toolManifest().map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: (typeof t.input_schema === 'object' && t.input_schema !== null
              ? (t.input_schema as Record<string, unknown>)
              : { type: 'object' }),
            output_schema: { type: 'object' } as Record<string, unknown>,
            capability_required: 'fs:project_data',
          }))
        : []

    // Remap CLAUDE model ids → OpenAI ids when the caller supplied an override
    // (a non-anthropic turn's spec still carries the anthropic model_preference),
    // and swap in the honest OpenAI tool manifest.
    let dispatchSpec: AgentSpec = {
      ...spec,
      tools: openaiTools,
      ...(config.model_preference !== undefined && config.model_preference.length > 0
        ? { model_preference: [...config.model_preference] }
        : {}),
    }

    // CONTINUITY (audit CRITICAL) — thread the last completion's session hint
    // back as `spec.session` so the STATELESS provider is not amnesiac. Only when
    // the caller wired a ledger (conversational) AND didn't already set a session.
    // `ledgerKey` is computed once at the top (single-chokepoint invalidation).
    if (ledgerKey !== undefined && dispatchSpec.session === undefined) {
      const prior = sessionLedger!.get(ledgerKey)
      // CROSS-PROVIDER CONTINUITY (audit round 14) — only resume the stored
      // continuation if the SAME provider stored it. A different provider's session
      // id (e.g. a codex `--resume` thread id vs an OpenAI `previous_response_id`,
      // or a stale entry from before a non-OpenAI turn) is not a valid continuation
      // and would silently drop the intervening turns; a mismatch replays FULL
      // history via `spec.messages` instead. (A non-OpenAI turn also CLEARS the
      // entry — see the anthropic path — so this guards the openai↔codex case.)
      if (prior !== undefined && prior.provider === provider) {
        dispatchSpec = {
          ...dispatchSpec,
          session: { id: prior.id, last_active_at: prior.last_active_at },
        }
      }
    }

    const selected = selectSubstrateFactory(provider)
    let substrate: Substrate
    if (selected.provider === 'openai') {
      const opts: GptResponsesApiSubstrateOptions = {
        substrate_instance_id,
        api_key: cred.secret,
        // PROJECT SCOPING (audit High) — bind the resolver to THIS turn's active
        // project so project-scoped tools (work_board_*, dispatch, …) dispatch with
        // the correct `project_id`, mirroring the Claude path. Guarded above:
        // bindMcpResolver is defined for 'openai'.
        mcpResolver: (config.bindMcpResolver as (bind: { project_id?: string }) => McpToolResolver)(
          projectId !== undefined ? { project_id: projectId } : {},
        ),
      }
      if (config.env !== undefined) opts.env = config.env
      if (config.endpoint !== undefined) opts.endpoint = config.endpoint
      if (config.max_tool_rounds !== undefined) opts.max_tool_rounds = config.max_tool_rounds
      if (config.fetchImpl !== undefined) opts.fetchImpl = config.fetchImpl
      substrate = selected.create(opts)
    } else if (selected.provider === 'openai-codex-cli') {
      // codex-cli: thread the selected secret as OPENAI_API_KEY (the adapter
      // defaults env to `{}` and never reads host process.env — ISSUES #67).
      const codexEnv: Record<string, string | undefined> = {
        ...(config.env ?? {}),
        OPENAI_API_KEY: cred.secret,
      }
      const opts: CodexCliSubstrateOptions = { env: codexEnv }
      if (config.codex_home !== undefined) opts.codex_home = config.codex_home
      if (config.codex_bin !== undefined) opts.bin = config.codex_bin
      if (config.spawnImpl !== undefined) opts.spawnImpl = config.spawnImpl
      substrate = selected.create(opts)
    } else {
      // Unreachable: `provider` is narrowed to the two OpenAI-family variants by
      // the function signature. Defensive throw keeps the switch exhaustive.
      throw new Error(`startOpenAiFamilySession: unexpected provider '${provider}'`)
    }

    innerHandle = substrate.start(dispatchSpec)
    if (cancelled) {
      await innerHandle.cancel()
      return
    }
    let reported = false
    for await (const ev of innerHandle.events) {
      if (!reported) {
        if (ev.kind === 'completion') {
          reported = true
          reportSuccess(pool, cred.id)
          // Persist the session hint (tagged with THIS provider) for the next turn
          // on this conversation key — the provider tag lets the read above reject a
          // continuation stored by a different provider. `committed = true` marks
          // this the ONE clean-success outcome, so the finally-guard does NOT
          // invalidate (every other outcome does).
          if (ledgerKey !== undefined && ev.session !== undefined) {
            sessionLedger!.set(ledgerKey, {
              id: ev.session.id,
              last_active_at: ev.session.last_active_at,
              provider,
            })
            committed = true
          }
        } else if (ev.kind === 'error') {
          reported = true
          // CONTINUITY ON FAILURE (audit round 15/17) — a stream error is a
          // non-success exit; the `finally` guard invalidates the ledger (no
          // per-branch delete needed). We still classify the cooldown here.
          // CREDENTIAL-FAULT-ONLY cooldown (audit round 12). ONLY 401/402/429 cool
          // the OpenAI key. A 5xx / 408 / network exception / no-status error is a
          // transient SERVER/NETWORK fault, NOT a credential fault — cooling the key
          // for it would punish a valid credential for an upstream outage (and, with
          // the r9 at-most-once change, a post-tool 503 surfaces retryable, which the
          // old shared mapper turned into a 429 cooldown). The error still SURFACES
          // (below) — only the cooldown is suppressed. NB: deliberately NOT the
          // Claude-shared `mapStatusForPoolCooldown` (its retryable→429 default is
          // byte-identical CC behavior).
          // O3 — code-first, consistent with the Claude path: a STAMPED class is
          // authoritative (the gpt-5-5 adapter stamps `rate_limited`/`http_status`
          // /`aborted`), so the prose classifiers run ONLY for a legacy/unstamped
          // event. Extracted to `openAiCredentialCooldownForEvent` so the
          // conflicting-code/prose boundary is unit-tested without driving the
          // whole adapter.
          const cooldownStatus = openAiCredentialCooldownForEvent(ev)
          if (cooldownStatus !== null) {
            if (ev.retry_after_ms !== undefined) {
              reportFailure(pool, cred.id, cooldownStatus, ev.retry_after_ms)
            } else {
              reportFailure(pool, cred.id, cooldownStatus)
            }
          }
        }
      }
      yield ev
    }
   } catch (err) {
     // SETUP GUARD — convert any throw (pool/manifest resolution, adapter
     // construction/start, or a misbehaving adapter iterator) into a terminal
     // error event so the caller's `for await` never rejects.
     yield {
       kind: 'error',
       message: `openai provider (${provider}) failed during setup/dispatch: ${
         err instanceof Error ? err.message : String(err)
       }`,
       retryable: false,
     }
   } finally {
     // SINGLE-CHOKEPOINT INVALIDATION (audit round 17) — EVERY non-success exit
     // (pool-null / all-cooling early returns, setup or iterator throw, stream
     // error, abandonment/cancel) lands here with `committed === false`, so the
     // stale continuation is cleared and the next turn replays full `spec.messages`
     // instead of resuming a dead/uncertain session. A clean completion set
     // `committed = true`, so it is the ONLY outcome that keeps the stored id.
     if (!committed && ledgerKey !== undefined) sessionLedger!.delete(ledgerKey)
   }
  })()
  const handle: SessionHandle = {
    events,
    async respondToTool(call_id: string, result: unknown): Promise<void> {
      if (innerHandle !== null) return innerHandle.respondToTool(call_id, result)
      throw new Error(
        'openai-family substrate: respondToTool called before dispatch (caller bug; tool_resolution=internal)',
      )
    },
    async cancel(): Promise<void> {
      cancelled = true
      if (innerHandle !== null) await innerHandle.cancel()
    },
    tool_resolution: 'internal',
  }
  return handle
}

/**
 * Parse the leading `HTTP <N>:` token from a CC adapter error message.
 * Lifted verbatim from build-import-substrate.ts for shared use.
 */
export function parseHttpStatusFromMessage(message: string): number | null {
  const m = message.match(/^HTTP\s+(\d{3})\b/)
  if (m === null) return null
  const n = Number.parseInt(m[1]!, 10)
  if (!Number.isFinite(n) || n < 100 || n > 599) return null
  return n
}

/**
 * Translate an upstream status into the pool-friendly cooldown code, OR
 * `null` when the failure is request-level rather than credential-level
 * (in which case the wrapper SKIPS `reportFailure` entirely).
 *
 * Lifted verbatim from build-import-substrate.ts for shared use. See the
 * original's docstring for the full mapping table + the Codex r4/r5 P1
 * incident history that drove it.
 */
/**
 * OpenAI-SPECIFIC credential-cooldown classifier (audit round 12).
 *
 * ONLY a genuine CREDENTIAL fault cools an OpenAI key:
 *   - 401 → auth cooldown
 *   - 402 → quota/billing cooldown
 *   - 429 → rate-limit cooldown
 * Everything else — 5xx, 408, a network/fetch exception, or a no-status error —
 * is a transient SERVER/NETWORK fault, NOT a credential fault; it returns `null`
 * (no cooldown) so a valid credential is never punished for an upstream outage.
 *
 * Why NOT reuse the Claude-shared {@link mapStatusForPoolCooldown}: that mapper's
 * `retryable → 429` default is load-bearing for the CC adapter's own error taxonomy
 * (Codex r4/r5 incident history) and MUST stay byte-identical for the Claude path.
 * The OpenAI path therefore keeps its own, stricter classifier — credential-fault
 * statuses only, no retryable-default-to-429.
 */
export function classifyOpenAiCredentialCooldown(httpStatus: number | null): number | null {
  if (httpStatus === 401 || httpStatus === 402 || httpStatus === 429) return httpStatus
  return null
}

/**
 * O3 — code-first OpenAI credential-cooldown decision for a substrate error event.
 *
 * A STAMPED class is authoritative: only `rate_limited` (→429) and `http_status`
 * (→the numeric status in the `HTTP <n>:` prefix) can cool the OpenAI key; every
 * other stamped class — including a caller-cancelled `aborted` and the substrate
 * classes (`channel_wedged`/`turn_timeout`/…) — never cools it, EVEN IF its prose
 * reads `HTTP 401`. The prose classifiers (`parseHttpStatusFromMessage` /
 * `detectCliAuthFailure`) run ONLY for a legacy/unstamped event, for one release.
 *
 * Returns the HTTP status to cool the credential as, or `null` for no cooldown.
 */
export function openAiCredentialCooldownForEvent(ev: {
  code?: SubstrateErrorClass
  message: string
}): number | null {
  if (ev.code !== undefined) {
    if (ev.code === 'rate_limited') return classifyOpenAiCredentialCooldown(429)
    if (ev.code === 'http_status') {
      return classifyOpenAiCredentialCooldown(parseHttpStatusFromMessage(ev.message))
    }
    return null
  }
  const httpStatus = parseHttpStatusFromMessage(ev.message)
  return httpStatus !== null
    ? classifyOpenAiCredentialCooldown(httpStatus)
    : detectCliAuthFailure(ev.message)
      ? 401
      : null
}

export function mapStatusForPoolCooldown(
  httpStatus: number | null,
  retryable: boolean,
): number | null {
  if (httpStatus !== null) {
    if (httpStatus === 429 || httpStatus === 402 || httpStatus === 401) {
      return httpStatus
    }
    if (retryable) {
      return 429
    }
    return null
  }
  if (retryable) return 429
  return null
}

/**
 * Detect auth-failure stderr signatures from the `claude` CLI subprocess.
 *
 * Lifted verbatim from build-import-substrate.ts for shared use. See ISSUES #50
 * (2026-05-28) for the full incident context.
 */
export function detectCliAuthFailure(message: string): boolean {
  if (/invalid api key/i.test(message)) return true
  if (/authentication.*failed/i.test(message)) return true
  if (/401/.test(message)) return true
  return false
}

/**
 * The single actionable, FATAL error surfaced when the `claude` binary is not
 * on the server's PATH. This is NOT a rate-limit / credential condition — an
 * unreachable binary will never recover by waiting, so the message tells the
 * operator how to make it reachable rather than implying a transient quota
 * problem. See `detectBinaryNotFound` + the 2026-06-17 import-blocker incident
 * (the launchd unit's PATH omitted `~/.local/bin`, so every CC-spawn LLM call
 * ENOENT'd and was mislabeled "all credentials in cooldown").
 */
export const BINARY_NOT_FOUND_MESSAGE =
  'Claude CLI not found on the server PATH — the LLM substrate is unreachable. ' +
  'Ensure `claude` is installed and on PATH (the official installer at ' +
  'https://claude.ai/install.sh symlinks it into ~/.local/bin), then restart Neutron.'

/**
 * Detect a spawn "binary not found" (ENOENT) failure for the `claude`
 * subprocess. Bun's `spawn` throws `Executable not found in $PATH: "claude"`;
 * a posix/node spawn throws `spawn claude ENOENT`; a shell layer can surface
 * `claude: command not found`. This is a FATAL, NON-retryable condition,
 * distinct from a 429/credential cooldown: retrying forever on a missing binary
 * is the exact "dumb code path" the 2026-06-17 import-blocker fix exists to
 * eliminate. Callers MUST check this BEFORE the cooldown classification and
 * MUST NOT call `reportFailure` (no pool cooldown) when it returns true.
 *
 * The substrate only ever spawns the LLM binary, so a bare "executable not
 * found in $PATH" is unambiguously it; the ENOENT / no-such-file shapes
 * additionally require a `claude` mention so an unrelated file ENOENT can't be
 * misclassified.
 */
export function detectBinaryNotFound(message: string): boolean {
  if (/executable not found in \$?path/i.test(message)) return true
  if (/\bENOENT\b/.test(message) && /claude/i.test(message)) return true
  if (/claude:\s*command not found/i.test(message)) return true
  if (/no such file or directory/i.test(message) && /claude/i.test(message)) return true
  return false
}

/**
 * The single actionable error surfaced when the persistent-REPL substrate fails
 * to START a session (the dev-channel MCP never bound, the REPL child died during
 * bootstrap, or `/health` never came up). This is a SUBSTRATE/spawn failure, NOT
 * a credential/quota condition — the Anthropic credentials are fine. Surfacing the
 * real class stops the failure laundering into a pool cooldown ("all Anthropic
 * credentials are in cooldown") that masks a dead LLM path behind a quota lie.
 */
export const CHANNEL_WEDGED_MESSAGE =
  "Neutron's LLM session channel failed to bind — the persistent-REPL substrate " +
  'could not start its dev-channel MCP before the turn. This is a substrate/spawn ' +
  'failure, NOT an Anthropic credential cooldown (the credentials are fine). Check ' +
  'the server log for `channel-wedged` / `no-channel-ready` and restart Neutron if it persists.'

/**
 * Detect a persistent-REPL spawn/channel-bind failure surfaced by the substrate.
 * The substrate throws `persistent-repl: spawn failed (<reason>; …)` for the four
 * post-spawn-assertion reasons (`channel-wedged`, `no-channel-ready`,
 * `no-http-health`, `dead-child`) and `ChannelWedgedSpawnError` carries the same
 * `spawn failed (channel-wedged; …)` text. None of these are credential conditions
 * — the substrate has ALREADY exhausted its own bounded respawn by the time the
 * error surfaces here, so rotating to a different credential cannot help and MUST
 * NOT cool one down. Callers MUST check this BEFORE the cooldown classification and
 * MUST NOT call `reportFailure` when it returns true (mirrors `detectBinaryNotFound`).
 */
export function detectChannelWedged(message: string): boolean {
  if (/spawn failed \((?:channel-wedged|no-channel-ready|no-http-health|dead-child)/i.test(message)) {
    return true
  }
  if (/\bchannel-wedged\b/i.test(message)) return true
  return false
}

/**
 * Detect a per-turn TIMEOUT surfaced by the persistent-REPL substrate. The
 * substrate emits `persistent-repl: turn timeout` (retryable:true) when a warm
 * REPL fails to settle a turn inside `DEFAULT_TURN_TIMEOUT_MS` (180s) — the turn
 * was slow or wedged, the credential is fine. This is NEITHER an HTTP-status
 * failure NOR a CLI auth failure, so without this fast-path it falls through to
 * `mapStatusForPoolCooldown(null, retryable=true)` → 429 → `reportFailure`,
 * parking a healthy credential and cascading into "all credentials in cooldown".
 * Callers MUST check this BEFORE the cooldown classification and MUST NOT call
 * `reportFailure` when it returns true (mirrors `detectBinaryNotFound` /
 * `detectChannelWedged`). Unlike those two the timeout stays RETRYABLE — the
 * substrate poisons + respawns the warm session, so the next dispatch lands on a
 * clean REPL and the retry succeeds on the same credential.
 */
export function detectTurnTimeout(message: string): boolean {
  return /persistent-repl:\s*turn timeout/i.test(message)
}

/**
 * Render an Anthropic-shape messages array into a flat user-turn body.
 *
 * AgentSpec carries a single `prompt: string` field (no separate system/
 * messages split — the locked § B.P1 interface). For consumers that have
 * a multi-turn Anthropic-shape array, we render it as:
 *
 *   User: <body1>
 *
 *   Assistant: <body2>
 *
 *   User: <body3>
 *
 *   ...
 *
 * Single-turn callers (the LLM router today) pass `messages.length === 1`
 * and get the bare body back without the `User:` prefix — matches how the
 * import pipeline composes its single-turn Pass-1 chunks.
 *
 * Empty array → empty string (the caller is responsible for ensuring the
 * spec.prompt is non-empty; the REPL rejects an empty turn body).
 */
export function renderMessagesArray(
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): string {
  if (messages.length === 0) return ''
  if (messages.length === 1) return messages[0]!.content
  const parts: string[] = []
  for (const m of messages) {
    const label = m.role === 'user' ? 'User' : 'Assistant'
    parts.push(`${label}: ${m.content}`)
  }
  return parts.join('\n\n')
}

// `collectTokensToString` moved to `../../runtime/collect-tokens.ts` (L3,
// 2026-07, pairs with O8) so services-band consumers can drain a substrate
// stream without importing UP into this gateway composition band. Re-exported
// here so every existing gateway import specifier stays valid (test-policy
// §2.2 barrel rule).
export { collectTokensToString } from '@neutronai/runtime/collect-tokens.ts'
