/**
 * @neutronai/gateway/realmode-composer — build an import-only Substrate (T7).
 *
 * Per docs/plans/P2-onboarding.md § 2.3 + § 4.7. The history-import
 * `ImportJobRunner` consumes a `Substrate` to dispatch Pass-1 (Haiku 4.5)
 * + Pass-2 (Opus 4.7). T7 wires production's resolved Anthropic
 * `CredentialPool` (from `resolveLlmCredentials`) into a single-purpose
 * Substrate scoped to the import job.
 *
 * Why a dedicated builder rather than reusing the chat-surface substrate:
 * the chat surface is its own follow-up sprint; the import surface needs
 * to ship now and only needs the narrow "fetch headers + endpoint" slice
 * of the adapter. A standalone builder keeps the import wiring grep-able
 * and independent of the chat-surface refactor that lands later.
 *
 * Credential threading. The returned Substrate `start()` re-selects from
 * the supplied `CredentialPool` on EVERY call so that cooldowns
 * (`reportFailure(billing_402|rate_limit_429|auth_401)`) are honoured
 * mid-import and the next chunk picks a fresh credential. Selecting once
 * at composer-build time (the v1 shape Codex P1-flagged) would freeze a
 * specific secret across every Pass-1 chunk + Pass-2 call and bypass the
 * pool's rotation contract entirely — multi-key instances would never see
 * their secondary keys exercised. Per-call selection also avoids the
 * "boot-time pool empty → permanent llm_unwired until restart" failure
 * mode: a cooldown that lifts mid-run is observable on the next chunk.
 *
 * Transcript storage. Pre-2026-05-26 the CC adapter wrote session-resume
 * transcripts at `<claude_home>/projects/<encoded-cwd>/<uuid>.jsonl`.
 * Under the CLI-subprocess substrate the `claude` binary owns the
 * transcript itself — passing `cwd` to the subprocess scopes it. Per-
 * instance transcript isolation is a follow-up sprint (see SYSTEM-OVERVIEW
 * § Known gaps); this builder no longer takes `claude_home`.
 *
 * Returns `null` when the pool is empty at boot (no credentials at all).
 * The composer treats that the same as "no credentials" and falls
 * through to the T4 `llm_unwired` placeholder so the engine still
 * surfaces a user-visible failure on the next import attempt. Cooldown-
 * only emptiness (pool has credentials but ALL are temporarily in
 * cooldown) lets construction succeed — the per-call selector will
 * surface the same `llm_unwired` symptom only when the start() actually
 * fires.
 */

import {
  createClaudeCodeSubstrateAuto,
  type ClaudeCodeSubstrateOptions,
} from '../../runtime/adapters/claude-code/index.ts'
import {
  reportFailure,
  reportSuccess,
  selectCredential,
  soonestCooldownUntil,
  type CredentialPool,
} from '../../runtime/credential-pool.ts'
import { ImportError } from '../../onboarding/history-import/types.ts'
import type { Event } from '../../runtime/events.ts'
import type { SessionHandle } from '../../runtime/session-handle.ts'
import type { AgentSpec, Substrate } from '../../runtime/substrate.ts'
import type { OAuthCredentialSource } from './resolve-llm-credentials.ts'
import {
  BINARY_NOT_FOUND_MESSAGE,
  detectBinaryNotFound,
  detectCliAuthFailure,
  mapStatusForPoolCooldown,
  parseHttpStatusFromMessage,
} from './build-llm-call-substrate.ts'

export interface BuildImportSubstrateInput {
  /**
   * Resolved by `resolveLlmCredentials({provider:'anthropic',...})`. When
   * supplied (and `resolvePool` is absent), the substrate uses this pool
   * for every `start()` call. Used by tests and by callers that already
   * have an eagerly-resolved pool at construction.
   *
   * S13 (2026-05-16) — exactly ONE of `pool` / `resolvePool` must be
   * supplied. Production composer (`gateway/index.ts`) now passes
   * `resolvePool` so a `.env` write that lands BETWEEN composer boot and
   * the first import dispatch is picked up transparently (closes the
   * "pass1Llm is not wired" stale-runner gap — incident of record:
   * v0.1.34 prod walkthrough, 2026-05-16).
   */
  pool?: CredentialPool
  /**
   * S13 (2026-05-16) — lazy credential resolver. When supplied (and
   * `pool` is absent), the substrate re-runs the resolver on EVERY
   * `start()` call so a credential that becomes available between
   * composer boot and the actual import dispatch is picked up without a
   * gateway restart.
   *
   * Returns the current `CredentialPool` (or `null` when no source has a
   * key). A null / empty result throws `ImportError('llm_unwired', ...)`
   * from the call site so the runner's per-chunk catch records a stable
   * `error_code='llm_unwired'` and the engine surfaces the `failed`
   * sub_step UX with a clear "credentials not available" message.
   *
   * Why lazy (not eager) is the right default for production:
   *
   *   - Synthetic-auth / dev provisioning writes `<OWNER_HOME>/.env`
   *     AFTER the per-instance systemd unit's first boot in some races
   *     (the unit's `systemctl restart` lands the env vars, but a fresh
   *     instance whose first chat connect happens BEFORE that restart
   *     completes hits a runner with no substrate, then stays unwired
   *     for the lifetime of that process).
   *   - Max OAuth refresh changes the access token over time. Eager
   *     resolution captures the boot-time token; lazy resolution lets
   *     the per-call refresh path in this substrate pick up the latest
   *     value.
   *   - A returning user whose creds were revoked + re-attached
   *     mid-session was previously stranded with the boot-time pool
   *     until the next restart; lazy resolution surfaces the fresh
   *     credential on the next chunk.
   */
  resolvePool?: () => Promise<CredentialPool | null>
  /** Stable per-instance identifier — surfaced on `completion.substrate_instance_id`.
   *  Also the instance+role discriminator (`cc-import-*`) the persistent substrate
   *  folds into its warm-pool key (S3 §2). */
  substrate_instance_id: string
  /** Optional cwd override threaded to `createClaudeCodeSubstrateAuto` (defaults to process.cwd()). */
  cwd?: string
  /** S3 §2 — conversational user identity folded into the persistent substrate's
   *  warm-pool key (per-instance owner). Absent ⇒ `_platform`. */
  user_id?: string
  /** S3 §2 — owning instance slug (advisory). */
  project_slug?: string
  /**
   * Override the `claude` binary path threaded into the subprocess
   * substrate. Default behavior: `process.env.CLAUDE_BIN ?? 'claude'`.
   */
  claude_bin?: string
  /**
   * When true, thread `--dangerously-skip-permissions` into the spawned
   * `claude` REPL. Managed-tier deployments set this so the headless REPL
   * doesn't block on interactive prompts. NOTE: the import substrate processes
   * UNTRUSTED export content, so the REPL is always spawned with `--tools ""`
   * (default-deny) regardless of this flag — see the persistent substrate's
   * tool-restriction wiring (Codex-r1-P1).
   */
  skip_permissions?: boolean
  /**
   * Substrate-construction seam. Defaults to `createClaudeCodeSubstrateAuto`
   * (the persistent interactive-REPL substrate — the SOLE production path).
   * Tests inject a fake `Substrate` so the import composer's credential +
   * env-scrub + cooldown-classification logic is exercised WITHOUT spawning a
   * real `claude` REPL. The factory receives the composed options (incl. the
   * scrubbed env + `credential_identity`).
   */
  substrateFactory?: (opts: ClaudeCodeSubstrateOptions) => Substrate
  /**
   * Codex r5 P1 (T7 forge-fix r5): Max OAuth refresh handle. When the
   * resolved CredentialPool came from `resolveLlmCredentials`'s
   * max_oauth branch, the pool's secret is just the access token that
   * happened to be valid at composer-build time. Max access tokens
   * have a finite TTL (`expires_at`) and MUST be refreshed via the
   * `MaxOAuthClient.getAccessToken(internal_handle)` path before
   * each dispatch — otherwise a long-lived gateway process starts
   * returning 401/`substrate_error` for every import once the token
   * expires, user-visible only on the new T7 import surface.
   *
   * Production wires the same `wrapMaxOAuthSource(maxOAuthClient)`
   * adapter `resolveLlmCredentials` already consumes. The wrapper's
   * `loadAccessToken` refreshes transparently; if it returns null
   * (revoked / refresh failed) we fall back to the pool's cached
   * secret. If it throws we surface the error to the runner so the
   * engine's failed sub_step UX fires.
   *
   * Optional — tests and BYO-only instances pass undefined; the pool's
   * cached secret is used as-is. Required for production Max-OAuth
   * instances to avoid the post-expiry hang.
   */
  oauthRefresh?: OAuthCredentialSource
  /**
   * Frozen `internal_handle` passed to `oauthRefresh.loadAccessToken(...)`.
   * Required when `oauthRefresh` is wired; ignored otherwise.
   */
  internal_handle?: string
}

/**
 * Construct a Substrate that delegates each `start(spec)` call to a
 * freshly-selected credential from the pool. Returns null only when the
 * pool is empty at boot (no credentials at all); cooldown-only emptiness
 * defers the failure to the first `start()` so credentials whose
 * cooldown lifts mid-run can be picked up without a restart.
 *
 * Codex r2 P1 (T7 forge-fix r2): the returned substrate wraps each
 * inner `SessionHandle.events` iterator so completion → reportSuccess
 * and error → reportFailure feed back into the pool. Without this hook
 * an instance with multiple BYO keys would never trip the per-credential
 * cooldown clock on real adapter failures, so a 429/402/401 from the
 * first key would keep being re-served by `selectCredential` on every
 * Pass-1 chunk and the whole import would degrade into
 * `pass1_all_failed` even when a healthy second key was available.
 */
export function buildImportSubstrate(
  input: BuildImportSubstrateInput,
): Substrate | null {
  if (input.pool === undefined && input.resolvePool === undefined) {
    throw new Error(
      'buildImportSubstrate: exactly one of `pool` (eager) or `resolvePool` (lazy) must be supplied',
    )
  }
  if (input.pool !== undefined && input.resolvePool !== undefined) {
    throw new Error(
      'buildImportSubstrate: cannot supply BOTH `pool` and `resolvePool` — pick one',
    )
  }
  // Eager-pool back-compat: when an empty pool is passed at boot, we
  // surface the "no creds" state at construction time so the legacy
  // call-site (tests, BYO-only callers that have already resolved)
  // doesn't get a substrate that silently fails-at-dispatch. The lazy
  // `resolvePool` path skips this check (an empty resolution at boot is
  // expected — the dispatch-time re-resolve is the point).
  if (input.pool !== undefined && input.pool.credentials.length === 0) {
    return null
  }
  return {
    start(spec: AgentSpec): SessionHandle {
      // S13 (2026-05-16) — single async-generator that:
      //   1. Resolves the live pool (lazy `resolvePool` re-runs per call;
      //      eager `pool` is the static boot-time value).
      //   2. Selects a credential from the resolved pool.
      //   3. Refreshes Max OAuth at dispatch time when applicable.
      //   4. Dispatches to the inner CC adapter.
      //   5. Wraps inner events so completion / error feed back into the
      //      resolved pool (not a stale boot-time reference).
      let innerHandle: SessionHandle | null = null
      let cancelled = false
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        // Step 1 — resolve pool. Lazy path re-runs the resolver so a
        // .env write between boot and dispatch is picked up; eager path
        // returns the boot-time pool unchanged. Empty / null →
        // dispatch-time `llm_unwired` failure rather than a stale-runner
        // "pass1Llm is not wired" symptom.
        let pool: CredentialPool
        if (input.pool !== undefined) {
          pool = input.pool
        } else {
          const resolved = await input.resolvePool!()
          if (resolved === null || resolved.credentials.length === 0) {
            yield {
              kind: 'error',
              message:
                'cc-import substrate: no Anthropic credentials available at import dispatch time. ' +
                'Configure CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in the per-project `.env`, ' +
                'or attach Max OAuth via signup, then retry the import.',
              retryable: false,
            }
            return
          }
          pool = resolved
        }
        // Step 2 — credential selection from the LIVE pool.
        const cred = selectCredential(pool)
        if (cred === null) {
          // 2026-06-17 (import-analysis-completeness) — surface the ACTUAL
          // soonest cooldown window so the runner can wait for the quota
          // reset precisely (respecting the provider's retry-after that
          // `reportFailure` already baked into `cooldown_until`) and show
          // an accurate "waiting for your Anthropic quota to reset" UX,
          // instead of guessing with a fixed backoff schedule. Single-Max
          // owners hit this constantly (one credential → a 429 parks the
          // whole pool for COOLDOWN_429_MS); the import must wait + retry,
          // never drop the chunk.
          const resumeAt = soonestCooldownUntil(pool)
          const errorEvent: Event = {
            kind: 'error',
            message:
              'cc-import substrate: all Anthropic credentials are in cooldown (429/402/401). ' +
              'Retry once the rate-limit window passes.',
            retryable: true,
          }
          if (resumeAt !== null) {
            const waitMs = Math.max(0, resumeAt - Date.now())
            errorEvent.retry_after_ms = waitMs
          }
          yield errorEvent
          return
        }
        // Step 3 — Max OAuth refresh at dispatch time. For oauth-kind
        // credentials we ask the supplied refresher for the CURRENT
        // access token; the wrapper refreshes via the upstream's
        // refresh_token transparently. If the refresher returns null
        // (revoked / refresh endpoint down) we fall back to the pool's
        // cached secret — better to fail with the substrate's own 401
        // path (which lands on the pool's auth_401 cooldown) than to
        // short-circuit before even trying.
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
            // null → keep the cached secret. The substrate's HTTP path
            // will surface the 401 if the cached token is expired.
          } catch (err) {
            yield {
              kind: 'error',
              message: `cc-import oauth-refresh failed: ${err instanceof Error ? err.message : String(err)}`,
              retryable: false,
            }
            return
          }
        }
        // Step 4 — dispatch. The CLI-subprocess substrate honours the
        // env vars we layer here: `CLAUDE_CODE_OAUTH_TOKEN` for OAuth-like
        // instances and `ANTHROPIC_API_KEY` for BYO API keys. The `claude`
        // binary's own auth resolution picks the first non-empty source
        // (env vars take precedence over `~/.claude/.credentials.json`),
        // so Max OAuth instances whose pool happens to carry an explicit
        // access token still get that token honoured; instances whose pool
        // is satisfied by the CLI's own credentials file pass through
        // unaffected.
        //
        // ISSUES #49 (2026-05-28) — explicitly UNSET the three Anthropic
        // auth env vars that the CC subprocess could otherwise read from
        // the inherited `process.env` (the gateway's own env, which on a
        // production box typically carries `ANTHROPIC_API_KEY` as a
        // managed-tier fallback). Without this delete, a max_oauth
        // instance whose pool selected an OAuth token would have BOTH
        // `CLAUDE_CODE_OAUTH_TOKEN` (set here) AND the host's
        // `ANTHROPIC_API_KEY` (inherited via the REPL spawn's parentEnv
        // merge) visible to the `claude` binary — and the binary's auth
        // precedence could pick the host API key instead of the pool's
        // OAuth token, billing the host's quota / fallback key rather
        // than the owner's. The undefined values are treated as
        // "delete from parentEnv" by the REPL spawn env merge. The
        // per-spawn env object is local to this generator; `process.env`
        // is NOT mutated.
        const env: Record<string, string | undefined> = {
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          CLAUDE_CODE_OAUTH_TOKEN: undefined,
        }
        if (isOauthLike) {
          env['CLAUDE_CODE_OAUTH_TOKEN'] = activeSecret
        } else {
          env['ANTHROPIC_API_KEY'] = activeSecret
        }
        const opts: ClaudeCodeSubstrateOptions = {
          substrate_instance_id: input.substrate_instance_id,
          env,
        }
        if (input.cwd !== undefined) opts.cwd = input.cwd
        if (input.claude_bin !== undefined) opts.claude_bin = input.claude_bin
        if (input.skip_permissions !== undefined) opts.skip_permissions = input.skip_permissions
        // S3 §2 — fold the selected credential id (#104) + the conversational
        // identity into the warm-pool key (the import substrate is `cc-import-*`,
        // so it never collapses with the conversational REPL regardless).
        opts.credential_identity = cred.id
        if (input.user_id !== undefined) opts.user_id = input.user_id
        const importProjectId = spec.metering_context?.project_id
        if (importProjectId !== undefined && importProjectId.length > 0) opts.project_id = importProjectId
        if (input.project_slug !== undefined) opts.instance_slug = input.project_slug
        // Argus r6 follow-up (Codex GPT-5 cross-model, same review run as the
        // recovered-reply BLOCKER) — the import substrate MUST be ephemeral.
        // Post-rip-replace `createClaudeCodeSubstrateAuto` builds the persistent
        // warm-pool REPL unconditionally; the `cc-import-*` pool key is stable
        // (instance id + credential + project), and NO import caller ever sets
        // `spec.session` (every Pass-1 chunk + the Pass-2 synthesis is a stateless
        // one-shot — see onboarding/history-import/substrate-callers.ts). Without
        // this flag those session-less calls collapse into ONE shared Claude
        // transcript, so later chunks see prior chunks' UNTRUSTED export content
        // and Pass-2 state — cross-chunk contamination + unbounded context growth,
        // the exact transcript-bleed class this PR exists to eliminate (r4 closed
        // it for the shared `cc-llm-*` utility substrate but missed `cc-import-*`).
        // Pre-S3 each of these was a fresh `claude -p`; `ephemeral` restores that
        // stateless one-shot semantics: a session-less dispatch routes through a
        // FRESH disposable REPL (createPersistentReplSubstrate.start()) torn down
        // after the turn. A dispatch that DID carry `spec.session` would still pool.
        opts.ephemeral = true
        // `createClaudeCodeSubstrateAuto` UNCONDITIONALLY builds the persistent
        // interactive-REPL substrate (the sole spawn shape post-S3-rip-replace).
        // The `substrateFactory` seam lets tests inject a fake substrate.
        const factory = input.substrateFactory ?? createClaudeCodeSubstrateAuto
        innerHandle = factory(opts).start(spec)
        if (cancelled) {
          await innerHandle.cancel()
          return
        }
        // Step 5 — proxy events, feeding completion / error back into
        // the LIVE pool (not a boot-time reference).
        let reported = false
        for await (const ev of innerHandle.events) {
          if (!reported) {
            if (ev.kind === 'completion') {
              reported = true
              reportSuccess(pool, cred.id)
            } else if (ev.kind === 'error') {
              reported = true
              // ENOENT (the `claude` binary is missing from the server's PATH)
              // is a FATAL, non-retryable substrate condition — NOT a 429/402/401
              // credential cooldown. Pre-fix, the adapter's retryable spawn error
              // laundered into a 429 pool cooldown → the next chunk's
              // `selectCredential` returned null → "all credentials in cooldown"
              // with a retry-after hint → the runner waited + retried forever on a
              // binary that will never appear (the 2026-06-17 import-blocker; PR
              // #73's cooldown-wait/retry made it WORSE). Classify it FIRST: skip
              // the cooldown (no `reportFailure`, so the pool never cools) and
              // re-emit a distinct, truthful error so `drainSubstrateEvents` wraps
              // the real message into the import job's failure reason and the
              // runner fails fast (non-retryable) instead of looping.
              if (detectBinaryNotFound(ev.message)) {
                yield { kind: 'error', message: BINARY_NOT_FOUND_MESSAGE, retryable: false }
                continue
              }
              const httpStatus = parseHttpStatusFromMessage(ev.message)
              // ISSUES #50 (2026-05-28) — CLI-subprocess auth failures
              // arrive as `claude exited 1: <stderr-tail>` shaped
              // messages, so `parseHttpStatusFromMessage` returns null and
              // the fallback `mapStatusForPoolCooldown(null, false)` skips
              // reportFailure entirely — pool never rotates off a bad
              // credential under `fill_first`. Detect auth-shaped stderr
              // tails up-front and route them through the same auth_401
              // cooldown class the HTTP-direct 401 path used pre-substrate-
              // swap. Order of precedence is HTTP-prefix → CLI-auth detect
              // → fallback so the existing 429 / 402 / 500-class paths and
              // the request-level (non-cooldown) path stay verbatim.
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
          // The inner handle hasn't materialised yet (OAuth refresh in
          // flight). The CC adapter's tool_resolution is internal so
          // respondToTool is a caller bug regardless; mirror its
          // contract.
          throw new Error(
            'cc-import substrate: respondToTool called before substrate dispatched (caller bug; tool_resolution=internal)',
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

// Cooldown classification helpers (`parseHttpStatusFromMessage`,
// `mapStatusForPoolCooldown`, `detectCliAuthFailure`) live in
// `build-llm-call-substrate.ts` and are imported at the top of this file.
// Behavior is preserved verbatim — the helpers were extracted so the
// LLM-call substrate sprint (cc-substrate-migration-3-sites, 2026-05-31)
// can share the same classification logic across import + chat + router
// + watcher + resolver call sites. The original docstrings live in the
// shared file; see the lift commit for the full rationale and incident
// history (Codex r4/r5 P1, ISSUES #50).
