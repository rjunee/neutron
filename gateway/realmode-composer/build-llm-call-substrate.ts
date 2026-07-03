/**
 * @neutronai/gateway/realmode-composer — shared CC-subprocess LLM-call substrate.
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
} from '../../runtime/adapters/claude-code/index.ts'
import {
  reportFailure,
  reportSuccess,
  selectCredential,
  type CredentialPool,
} from '../../runtime/credential-pool.ts'
import type { Event } from '../../runtime/events.ts'
import type { SessionHandle } from '../../runtime/session-handle.ts'
import type { AgentSpec, Substrate } from '../../runtime/substrate.ts'
import type { OAuthCredentialSource } from './resolve-llm-credentials.ts'

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
  internal_handle?: string
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
    typeof input.internal_handle === 'string' &&
    input.internal_handle.length > 0
  ) {
    try {
      const fresh = await input.oauthRefresh.loadAccessToken(input.internal_handle)
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
   * Optional `internal_handle` keyed against `oauthRefresh.loadAccessToken`.
   * Required when `oauthRefresh` is wired; ignored otherwise.
   *
   * Optional (not mandatory) because some LLM call sites are platform-
   * internal rather than per-instance — for those, the resolver picks a
   * BYO or shared env credential and no Max OAuth refresh is needed.
   */
  internal_handle?: string
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
   */
  skip_permissions?: boolean
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
   * sets it. Used by the router to inject `MAX_THINKING_TOKENS=0` so its
   * classifier spawn doesn't burn 20-40s on extended thinking (root-caused
   * 2026-06-05 — see `runtime/adapters/claude-code/router-thinking-budget.ts`).
   *
   * Scope note: layered per-substrate, so a router-DEDICATED substrate carries
   * this overlay while the shared `llmCallSubstrate` does not. Keys here win
   * over the auth-scrub env on collision (applied last).
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
  return {
    start(spec: AgentSpec): SessionHandle {
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
          if (input.internal_handle !== undefined) {
            helperInput.internal_handle = input.internal_handle
          }
          resolved = await resolveScrubbedAuthEnv(helperInput)
        } catch (err) {
          if (err instanceof ScrubbedAuthEnvError) {
            // `all_cooldown` was retryable:true; `no_credentials` and
            // `oauth_refresh` were retryable:false — preserved verbatim.
            yield {
              kind: 'error',
              message: err.message,
              retryable: err.reason === 'all_cooldown',
            }
            return
          }
          throw err
        }
        const { env, pool } = resolved
        const cred = { id: resolved.cred_id }
        // Layer the optional `extra_env` overlay AFTER the auth-scrub env so
        // per-substrate spawn knobs (e.g. the router's `MAX_THINKING_TOKENS=0`)
        // win over inherited vars without disturbing the auth scrubbing. The
        // `undefined`-deletes contract is preserved downstream by the REPL spawn
        // env merge.
        const spawnEnv: Record<string, string | undefined> =
          input.extra_env !== undefined ? { ...env, ...input.extra_env } : env
        const opts: ClaudeCodeSubstrateOptions = {
          substrate_instance_id: input.substrate_instance_id,
          env: spawnEnv,
        }
        if (input.cwd !== undefined) opts.cwd = input.cwd
        if (input.claude_config_dir !== undefined) opts.claude_config_dir = input.claude_config_dir
        if (input.claude_bin !== undefined) opts.claude_bin = input.claude_bin
        if (input.skip_permissions !== undefined) opts.skip_permissions = input.skip_permissions
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
        if (input.project_slug !== undefined) opts.instance_slug = input.project_slug
        if (input.delivery_topic_id !== undefined) opts.delivery_topic_id = input.delivery_topic_id
        if (input.onRecoveredReply !== undefined) opts.onRecoveredReply = input.onRecoveredReply
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
              if (detectBinaryNotFound(ev.message)) {
                yield { kind: 'error', message: BINARY_NOT_FOUND_MESSAGE, retryable: false }
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
              if (detectChannelWedged(ev.message)) {
                yield { kind: 'error', message: CHANNEL_WEDGED_MESSAGE, retryable: false }
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
              if (detectTurnTimeout(ev.message)) {
                yield ev
                continue
              }
              const httpStatus = parseHttpStatusFromMessage(ev.message)
              let cooldownStatus: number | null
              if (httpStatus !== null) {
                cooldownStatus = mapStatusForPoolCooldown(httpStatus, ev.retryable)
              } else if (detectCliAuthFailure(ev.message)) {
                cooldownStatus = 401
              } else {
                cooldownStatus = mapStatusForPoolCooldown(null, ev.retryable)
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

/**
 * Accumulate `token` events from a SessionHandle into a single string,
 * throwing on the first `error` event. Returns when the `completion`
 * event is observed (or the iterator naturally ends).
 *
 * Used by every per-consumer adapter that converts the substrate's
 * event stream into a string-returning closure (LlmCallFn,
 * AnthropicMessagesClient, AgentWatcherLlmCall).
 *
 * If a `signal: AbortSignal` is supplied, the handle is cancelled when
 * it fires + the iterator throws an AbortError to the caller.
 */
export async function collectTokensToString(
  handle: SessionHandle,
  signal?: AbortSignal,
  /** FIX #347 — invoked once, the moment the FIRST reply token arrives. Lets a
   *  caller cancel the delayed cold-start "Waking up…" ack as soon as the reply
   *  is actually streaming (not only when the whole turn settles), so a fast-
   *  after-slow turn never fires a spurious pill. Optional + fired at most once. */
  onFirstToken?: () => void,
): Promise<string> {
  let abortListener: (() => void) | undefined
  let aborted = false
  let firstTokenSeen = false
  if (signal !== undefined) {
    if (signal.aborted) {
      await handle.cancel()
      throw new Error('cc-llm-call: aborted before dispatch')
    }
    abortListener = (): void => {
      aborted = true
      void handle.cancel().catch(() => undefined)
    }
    signal.addEventListener('abort', abortListener, { once: true })
  }
  try {
    let buf = ''
    for await (const ev of handle.events) {
      if (aborted) {
        throw new Error('cc-llm-call: aborted')
      }
      if (ev.kind === 'token') {
        // FIX #347 — signal the first real token exactly once so the caller can
        // cancel the pending cold-start ack before it fires.
        if (!firstTokenSeen && ev.text.length > 0) {
          firstTokenSeen = true
          try {
            onFirstToken?.()
          } catch {
            /* an ack-cancel callback must never break token collection */
          }
        }
        buf += ev.text
        continue
      }
      if (ev.kind === 'completion') {
        return buf
      }
      if (ev.kind === 'error') {
        throw new Error(`cc-llm-call: ${ev.message}`)
      }
      // thinking / tool_call / tool_result_ack / status — informational
    }
    // Argus r1 IMPORTANT #2 (2026-05-31) — if the abort fired AFTER the
    // loop's last `if (aborted)` check but BEFORE the iterator yielded
    // another event, the iterator can end naturally (because cancel()
    // closed it) without us throwing. The pre-fix `return buf` silently
    // returned whatever partial tokens accumulated, surfacing as a
    // SUCCESSFUL result instead of an aborted error. Caller can't tell
    // the difference between "LLM finished early" and "we aborted",
    // which breaks the router's timeout-then-escalate-to-Sonnet contract
    // (it might never escalate if we return a truncated Pass-1 response).
    if (aborted) {
      throw new Error('cc-llm-call: aborted')
    }
    // Iterator ended without an explicit completion event AND no abort.
    // Treat the accumulated buffer as the final response (defensive —
    // the CC adapter always emits a terminal completion or error event,
    // but we shouldn't throw here if a substrate stub-out in a test
    // omits the terminal event).
    return buf
  } finally {
    if (signal !== undefined && abortListener !== undefined) {
      signal.removeEventListener('abort', abortListener)
    }
  }
}
