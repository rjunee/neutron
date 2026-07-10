/**
 * @neutronai/gateway/realmode-composer — LLM credential resolver.
 *
 * Walks four sources in order to resolve a `CredentialPool` for an LLM
 * provider (Anthropic, Gemini, OpenAI) on behalf of an owner:
 *
 *   0. (Anthropic only, Sprint 22 → Sprint 23) Owner-held Max paste
 *      token via the injected `OAuthCredentialSource` (production
 *      wires `MaxOAuthClient.getAccessToken`). When present this wins
 *      over every other source — the owner pasted a long-lived
 *      `claude setup-token` value at signup. The resulting pool's
 *      `kind` is `'oauth'` so the consuming chat-surface adapter
 *      knows to emit `Authorization: Bearer ...` (NOT the `x-api-key`
 *      header used by BYO API keys). The future chat-surface adapter
 *      maps this pool to `CLAUDE_CODE_OAUTH_TOKEN` via
 *      `oauthEnvForPool(pool)` from `auth/max-oauth.ts` so the
 *      Claude Code adapter's tier (5) auth path picks it up
 *      unchanged.
 *   0.5 (Anthropic only, T15 — synthetic-auth + dev/CI fast path)
 *      Process-env `CLAUDE_CODE_OAUTH_TOKEN`. Production instances attach
 *      Max via signup → DB-stored (source 0); dev / synthetic-auth
 *      instances pre-write the token to per-instance `.env` and the systemd
 *      unit's `EnvironmentFile=-{{OWNER_HOME}}/.env` puts it in
 *      `process.env`. The resulting pool is `kind: 'oauth'` (same as
 *      source 0) so the consuming substrate emits `Authorization: Bearer
 *      ...` and the Claude Code adapter's Bearer-token tier picks it up
 *      unchanged. Sits between source 0 and source 1 so a DB-attached
 *      Max token (with refresh) wins over a static env-var fallback. A
 *      WARN log line surfaces the fact this fallback fired — this path
 *      is for synthetic-auth + CI, NOT how production should be wired.
 *   1. Per-instance SecretsStore via `ApiKeyStore` — BYO keys the operator
 *      registered through onboarding. Strongest isolation.
 *   2. Per-instance env var (e.g. `ANTHROPIC_API_KEY_CASEY_TEST`) — drop-in
 *      pattern when an instance has its own key but no DB-side seeding yet.
 *   3. Shared-env fallback (e.g. `ANTHROPIC_API_KEY`) — the
 *      single-instance-box pattern. Logs a WARN line. Item 3 bundle
 *      (2026-06-10): this tier is gated STRICTLY to the OSS
 *      single-instance self-host shape (`resolveDeploymentMode(env) ===
 *      'open'`, the default). On 'managed' / 'connect' it is
 *      UNREACHABLE — an instance with no/expired Max OAuth resolves to
 *      `null` (→ the /chat reconnect gate) instead of silently
 *      borrowing a box-global key shared across instances. On 'open' a
 *      global box key remains the legit, simplest auth model.
 *
 * Returns `null` when no source has a key — the caller decides whether to
 * skip the surface (landing / Telegram / web chat) or fail-soft. Sprint
 * 22 wires `gateway/index.ts` to render an "Authorize Max" gate page on
 * `/chat` when the resolver returns null AND `provider==='anthropic'`,
 * so a returning user with revoked tokens can re-connect.
 */

import type { ApiKeyStore, ApiKeyProvider } from '@neutronai/auth/api-key-store.ts'
import { buildBYOApiKeyPool } from '@neutronai/auth/byo-api-key-fallback.ts'
import { resolveDeploymentMode } from '../deployment-mode.ts'
import {
  newCredentialPool,
  type CredentialPool,
} from '@neutronai/runtime/credential-pool.ts'

/**
 * Sprint 22 — pluggable OAuth source. Production wires `MaxOAuthClient`
 * via `wrapMaxOAuthSource`; tests inject a stub. The interface stays
 * narrow so a future ChatGPT / Gemini OAuth adapter (post-M1) reuses
 * the same shape without dragging in the full Max client surface.
 */
export interface OAuthCredentialSource {
  /**
   * Resolve a fresh access token for the given instance, refreshing
   * transparently when the cached token is expired. Return `null` when
   * the owner has not connected their OAuth-backed subscription yet
   * — the resolver then falls through to BYO / env-var sources.
   *
   * 2026-05-12 — the value passed is the FROZEN `internal_handle`,
   * NOT the mutable `url_slug`. See `auth/secrets-store.ts` file
   * header for the full rationale.
   *
   * Throws are NOT suppressed by the resolver — a refresh-token-revoked
   * / network blip surfaces to the caller so operators see the failure
   * in journald rather than the chat surface silently going dark. The
   * resolver itself catches + logs + falls through (see implementation).
   */
  loadAccessToken: (
    internal_handle: string,
  ) => Promise<{ access_token: string; expires_at: number } | null>
}

export interface ResolveLlmCredentialsInput {
  /**
   * 2026-05-12 — frozen `internal_handle` for the instance (see
   * `auth/secrets-store.ts` file header). Was previously `project_slug`;
   * renamed because the SecretsStore / ApiKeyStore lookups inside the
   * resolver MUST key on the frozen handle, not the mutable url_slug,
   * or renamed instances silently lose their stored credentials.
   *
   * The per-instance + shared env-var lookups still derive their var
   * names from `url_slug` (the user-visible identifier in operator
   * env files); the resolver accepts that as a separate field.
   */
  internal_handle: string
  /**
   * Mutable `url_slug` used ONLY for log line readability + telemetry.
   * Per-instance env-var lookups derive their suffix from this so
   * operators set `ANTHROPIC_API_KEY_<URL_SLUG_UPPER>` in their unit
   * files. Empty string falls back to `internal_handle` for
   * back-compat.
   */
  url_slug?: string
  apiKeys: ApiKeyStore
  provider: ApiKeyProvider
  /**
   * Ordered list of env var names to try. Production composer passes:
   *   ['ANTHROPIC_API_KEY_<SLUG_UPPER>', 'ANTHROPIC_API_KEY']
   * The shared-env fallback fires only when no per-instance env var is set;
   * a `console.warn` log line surfaces the fact that a SHARED key is in
   * use so operators can review the M2 instance-isolation boundary.
   */
  env_vars: ReadonlyArray<string>
  env: NodeJS.ProcessEnv
  /**
   * Sprint 22 — Anthropic-only Max OAuth source. When provided AND it
   * returns a non-null token, wins over all api-key / env-var sources
   * and the resulting pool's `kind` is `'oauth'` so chat-surface
   * adapters emit `Authorization: Bearer <token>`. Pass `undefined`
   * for gemini / openai — those have no Max-style OAuth path in M1.
   */
  maxOAuth?: OAuthCredentialSource
}

/**
 * Convert instance slug to the per-instance env var suffix. Slugs are
 * lowercase kebab-case; env vars are upper-snake. e.g.
 *   'casey-test' → 'CASEY_TEST'
 *   'bob' → 'BOB'
 *   'multi-word-slug' → 'MULTI_WORD_SLUG'
 */
export function envSuffixForSlug(slug: string): string {
  return slug.toUpperCase().replace(/-/g, '_')
}

// ── C6 — Unified credential precedence table ────────────────────────────────
//
// ONE source of truth for each precedence rung, shared by BOTH the Managed
// async resolver (`resolveLlmCredentials`, below) AND the Open single-owner
// sync resolver (`resolveOpenLlmPool` in `open/composer.ts`). Before C6 the two
// resolvers duplicated the env-OAuth → api-key pool-construction by hand-kept
// comment ("mirroring the Managed resolver's precedence"); the comment-sync is
// now retired — the pool-construction for each tier lives here exactly once.
//
// Canonical order, highest-priority first:
//
//   1. Max OAuth source           (async, Managed-only — see resolveLlmCredentials)
//   2. env CLAUDE_CODE_OAUTH_TOKEN  → resolveEnvOAuthTier    (anthropic-only)
//   3. BYO ApiKeyStore            (async, Managed-only — see resolveLlmCredentials)
//   4. env_vars API keys          → resolveApiKeyEnvTier     (shared-tier gated)
//   5. ambient/Keychain `claude`  → resolveAmbientTier       (Open-only, allowAmbient)
//   6. null
//
// Tiers 1 & 3 are async (network / DB) and stay LAZILY sequenced inside the
// async resolver so a higher tier short-circuits before the lower async source
// is ever touched (an attached Max token must not incur a BYO-store read).
// Tiers 2 / 4 / 5 are pure + synchronous, so the Open chat auth-gate
// (`() => resolveOpenLlmPool(env) === null`, evaluated synchronously on every
// `/chat` request) consumes them directly with no `await`.
//
// SECURITY — the precedence is env-OAuth > API-key > ambient and MUST be
// preserved exactly. The `'ambient'` tier threads NO token: its secret is the
// empty string, and `resolveScrubbedAuthEnv` passes NOTHING to the child, which
// authenticates via its own macOS Keychain. Never mint an ambient pool with a
// non-empty secret.
//
// Logging: every tier emits its INFO / WARN line ONLY when a `log_slug` is
// supplied. The Managed resolver always threads one (journald observability);
// the Open resolver threads none, so it stays silent exactly as before C6.

/**
 * Tier 2 — process-env `CLAUDE_CODE_OAUTH_TOKEN` (synthetic-auth + dev/CI fast
 * path, and the Open self-host `claude setup-token` path). Anthropic-only: the
 * var name is Anthropic-specific and only the cc-adapter's Bearer tier reads
 * it; other providers return `null`. An empty string is treated as unset.
 * Resulting pool is `kind: 'oauth'` so the substrate emits `Authorization:
 * Bearer …`. Emits a WARN (Managed only) so operators see the fallback fired —
 * this env source is for synthetic-auth + CI, not the production attach flow.
 */
export function resolveEnvOAuthTier(input: {
  provider: ApiKeyProvider
  env: NodeJS.ProcessEnv
  log_slug?: string
}): CredentialPool | null {
  if (input.provider !== 'anthropic') return null
  const token = input.env['CLAUDE_CODE_OAUTH_TOKEN']
  if (typeof token !== 'string' || token.length === 0) return null
  if (input.log_slug !== undefined) {
    console.warn(
      `[composer] project=${input.log_slug} ${input.provider} credentials loaded from process-env CLAUDE_CODE_OAUTH_TOKEN — synthetic-auth / dev / CI fallback. Production should attach Max via signup.`,
    )
  }
  return newCredentialPool({
    strategy: 'fill_first',
    credentials: [
      { id: `${input.provider}:env_oauth`, kind: 'oauth', secret: token },
    ],
  })
}

/**
 * Tier 4 — walk `env_vars` in order, first non-empty wins → `kind: 'api_key'`.
 * The LAST entry (when there is more than one) is the shared box-global key
 * (a bare `ANTHROPIC_API_KEY` exported box-wide).
 *
 * `allowSharedEnvTier` gates that shared trailing entry:
 *   - Managed passes `resolveDeploymentMode(env) === 'open'`. On managed /
 *     connect it is FALSE, so the shared key is REFUSED (→ `null`, the /chat
 *     reconnect gate) rather than silently borrowed across instances. The
 *     `deploymentModeLabel` names the refusing mode in the WARN.
 *   - The Open resolver passes a single-entry `env_vars` (`['ANTHROPIC_API_KEY']`),
 *     so the `i > 0` guard never classifies it as shared — it is treated as the
 *     per-owner box key regardless of this flag (Open passes `true`).
 */
export function resolveApiKeyEnvTier(input: {
  provider: ApiKeyProvider
  env: NodeJS.ProcessEnv
  env_vars: ReadonlyArray<string>
  allowSharedEnvTier: boolean
  deploymentModeLabel?: string
  log_slug?: string
}): CredentialPool | null {
  for (let i = 0; i < input.env_vars.length; i++) {
    const name = input.env_vars[i]!
    const value = input.env[name]
    if (typeof value === 'string' && value.length > 0) {
      const isShared = i === input.env_vars.length - 1 && i > 0
      if (isShared) {
        if (!input.allowSharedEnvTier) {
          if (input.log_slug !== undefined) {
            console.warn(
              `[composer] project=${input.log_slug} ${input.provider} SHARED env key ${name} is set but deployment mode is '${input.deploymentModeLabel ?? 'non-open'}' — refusing the box-global fallback; this project must attach its own credential (Max OAuth / BYO key). Returning null → reconnect gate.`,
            )
          }
          continue
        }
        if (input.log_slug !== undefined) {
          console.warn(
            `[composer] project=${input.log_slug} ${input.provider} credentials loaded from SHARED env key ${name} — review M2 credential-sharing plan`,
          )
        }
      } else if (input.log_slug !== undefined) {
        console.info(
          `[composer] project=${input.log_slug} ${input.provider} credentials loaded from per-project env ${name}`,
        )
      }
      return newCredentialPool({
        strategy: 'fill_first',
        credentials: [
          { id: `${input.provider}:${name}`, kind: 'api_key', secret: value },
        ],
      })
    }
  }
  return null
}

/**
 * Tier 5 — ambient / Keychain `claude` login (Open single-owner ONLY; Managed
 * never allows it). Anthropic-only: ambient auth is a Claude-Code concept (the
 * macOS "Claude Code-credentials" Keychain item) and the substrate's ambient
 * path scrubs only the Anthropic/Claude env vars, so a non-anthropic provider
 * has no ambient credential to mint — return `null` (matches
 * `resolveEnvOAuthTier`'s anthropic-only guard). When `allowAmbient` and the
 * injected `probeAmbientAuth()` reports a Keychain-authed `claude`, mint an
 * `ambient`-kind pool. The pool threads NO secret (empty string): the substrate
 * passes nothing and the spawned `claude` child authenticates via its OWN macOS
 * Keychain item. The probe is injected so this module never imports the
 * Open-only probe (no gateway→open edge).
 */
export function resolveAmbientTier(input: {
  provider: ApiKeyProvider
  allowAmbient: boolean
  probeAmbientAuth: () => boolean
}): CredentialPool | null {
  if (input.provider !== 'anthropic') return null
  if (!input.allowAmbient) return null
  if (!input.probeAmbientAuth()) return null
  return newCredentialPool({
    strategy: 'fill_first',
    credentials: [
      { id: `${input.provider}:ambient_keychain`, kind: 'ambient', secret: '' },
    ],
  })
}

/**
 * Resolve a `CredentialPool` for an LLM provider (Managed / realmode path).
 * Walks the C6 precedence table: max_oauth (tier 1, anthropic only) >
 * process-env CLAUDE_CODE_OAUTH_TOKEN (tier 2, anthropic only) > BYO store
 * (tier 3) > each `env_vars` entry (tier 4, shared-tier gated by deployment
 * mode). Tier 5 (ambient) is Open-only and never reached here. Logs INFO for
 * max_oauth / store / per-instance env hits; WARN for the process-env
 * CLAUDE_CODE_OAUTH_TOKEN fallback and for the shared-env fallback / refusal.
 *
 * Returns `null` when no source has a key — caller decides what to skip.
 */
export async function resolveLlmCredentials(
  input: ResolveLlmCredentialsInput,
): Promise<CredentialPool | null> {
  // Log under the user-facing url_slug when available so journald greps
  // line up with the instance the operator knows; fall back to
  // internal_handle when url_slug isn't threaded through.
  const log_slug =
    input.url_slug !== undefined && input.url_slug.length > 0
      ? input.url_slug
      : input.internal_handle
  // Tier 1 — Sprint 22 Anthropic Max OAuth (async). Only fires when the caller
  // wired `maxOAuth` (production composer wires it for provider==='anthropic';
  // gemini / openai pass undefined).
  let maxOAuthThrew = false
  if (input.maxOAuth !== undefined) {
    let tokens: { access_token: string; expires_at: number } | null = null
    try {
      tokens = await input.maxOAuth.loadAccessToken(input.internal_handle)
    } catch (err) {
      // Defense-in-depth: a refresh failure / network blip should NOT
      // brick the resolver — fall through to BYO/env so an instance with
      // both a Max sub AND a BYO key keeps working when the upstream
      // refresh endpoint is down. Operators see the failure in
      // journald via the WARN below.
      maxOAuthThrew = true
      console.warn(
        `[composer] project=${log_slug} ${input.provider} max-oauth loadAccessToken threw: ${
          err instanceof Error ? err.message : String(err)
        } — falling through to BYO/env`,
      )
    }
    if (tokens !== null && tokens.access_token.length > 0) {
      console.info(
        `[composer] project=${log_slug} ${input.provider} credential resolved from max_oauth ` +
          `(will be threaded to claude subprocess as CLAUDE_CODE_OAUTH_TOKEN)`,
      )
      return newCredentialPool({
        strategy: 'fill_first',
        credentials: [
          {
            id: `${input.provider}:max_oauth`,
            kind: 'oauth',
            secret: tokens.access_token,
          },
        ],
      })
    }
  }

  // Tier 2 — process-env CLAUDE_CODE_OAUTH_TOKEN. Sits between tier 1 (DB Max —
  // refreshable) and tier 3 (ApiKeyStore — BYO) so a production instance with
  // attached Max always wins over a static env-var fallback set on the same box.
  //
  // Codex r1 P2 — when tier 1 THREW (Max refresh outage / network blip), skip
  // this env-var source and fall through to the stable BYO/store path: an
  // instance with both a Max sub AND a stored BYO key relies on the BYO key as
  // the recovery path during a Max refresh outage. Without this guard, a stale
  // `CLAUDE_CODE_OAUTH_TOKEN` exported into the operator's process env would
  // short-circuit the resolver into returning a likely-expired Bearer instead of
  // the valid stored API key. Tested below.
  if (!maxOAuthThrew) {
    const envOAuth = resolveEnvOAuthTier({
      provider: input.provider,
      env: input.env,
      log_slug,
    })
    if (envOAuth !== null) return envOAuth
  }

  // Tier 3 — BYO ApiKeyStore (async). Lazily reached only when tiers 1-2 miss.
  const stored = await buildBYOApiKeyPool({
    internal_handle: input.internal_handle,
    provider: input.provider,
    api_keys: input.apiKeys,
  })
  if (stored !== null) {
    console.info(
      `[composer] project=${log_slug} ${input.provider} credentials loaded from store`,
    )
    return stored
  }

  // Tier 4 — env_vars API keys. Item 3 bundle (2026-06-10): the shared trailing
  // env key (a bare ANTHROPIC_API_KEY exported box-wide) is UNREACHABLE on
  // managed / connect — an instance with no/expired Max OAuth gets `null` (→ the
  // /chat "Authorize Max" reconnect gate), never a silently borrowed box-global
  // credential. Only the OSS single-instance self-host shape ('open' — the
  // `resolveDeploymentMode` default) may use it. The per-instance tiers above
  // (Max OAuth, SecretsStore BYO, per-instance env — including the tier-2
  // CLAUDE_CODE_OAUTH_TOKEN, which on Managed comes from the instance's OWN
  // systemd EnvironmentFile) are intentionally untouched.
  const mode = resolveDeploymentMode(input.env)
  return resolveApiKeyEnvTier({
    provider: input.provider,
    env: input.env,
    env_vars: input.env_vars,
    allowSharedEnvTier: mode === 'open',
    deploymentModeLabel: mode,
    log_slug,
  })
}

/**
 * Wrap a `MaxOAuthClient` (or any object with the same `getAccessToken`
 * signature) as an `OAuthCredentialSource`. Used by the production
 * composer; tests can pass any plain object that matches the interface.
 */
export function wrapMaxOAuthSource(client: {
  getAccessToken: (
    internal_handle: string,
    sub_label?: string,
  ) => Promise<{ access_token: string; expires_at: number } | null>
}): OAuthCredentialSource {
  return {
    loadAccessToken: async (internal_handle: string) =>
      client.getAccessToken(internal_handle),
  }
}
