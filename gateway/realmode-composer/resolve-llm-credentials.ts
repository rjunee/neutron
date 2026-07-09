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

/**
 * Resolve a `CredentialPool` for an LLM provider. Walks max_oauth (1st
 * priority, anthropic only) > process-env CLAUDE_CODE_OAUTH_TOKEN (T15,
 * anthropic only) > BYO store > each `env_vars` entry in order. Logs
 * INFO for max_oauth / store / per-instance env hits; logs WARN for the
 * process-env CLAUDE_CODE_OAUTH_TOKEN fallback AND when the LAST entry
 * in `env_vars` (treated as the shared-env fallback) is the source AND
 * there is more than one entry.
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
  // Sprint 22 — 1st-priority Anthropic Max OAuth. Only fires when the
  // caller wired `maxOAuth` (production composer wires it for
  // provider==='anthropic'; gemini / openai pass undefined).
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

  // T15 — process-env CLAUDE_CODE_OAUTH_TOKEN (synthetic-auth + dev/CI
  // fast path). Anthropic-only: the var name is Anthropic-specific and
  // the cc-adapter's Bearer tier reads it. Other providers fall through.
  // Sits between source 0 (DB Max — refreshable) and source 1
  // (ApiKeyStore — BYO) so a production instance with attached Max always
  // wins over a static env-var fallback set on the same box. Emits a
  // WARN line (mirrors source 3's pattern) so operators see the fallback
  // fired in journald — this path is for synthetic-auth + CI, NOT the
  // production attach flow.
  //
  // Codex r1 P2 — when source 0 THREW (Max refresh outage / network
  // blip), skip this env-var source and fall through to the stable
  // BYO/store path. Reason: an instance with both a Max sub AND a stored
  // BYO key relies on the BYO key as the recovery path during a Max
  // refresh outage. Without this guard, a stale `CLAUDE_CODE_OAUTH_TOKEN`
  // exported into the operator's process env would short-circuit the
  // resolver into returning a likely-expired Bearer instead of the
  // valid stored API key. Tested below.
  if (input.provider === 'anthropic' && !maxOAuthThrew) {
    const envOauthToken = input.env['CLAUDE_CODE_OAUTH_TOKEN']
    if (typeof envOauthToken === 'string' && envOauthToken.length > 0) {
      console.warn(
        `[composer] project=${log_slug} ${input.provider} credentials loaded from process-env CLAUDE_CODE_OAUTH_TOKEN — synthetic-auth / dev / CI fallback. Production should attach Max via signup.`,
      )
      return newCredentialPool({
        strategy: 'fill_first',
        credentials: [
          {
            id: `${input.provider}:env_oauth`,
            kind: 'oauth',
            secret: envOauthToken,
          },
        ],
      })
    }
  }

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
  for (let i = 0; i < input.env_vars.length; i++) {
    const name = input.env_vars[i]!
    const value = input.env[name]
    if (typeof value === 'string' && value.length > 0) {
      const isShared = i === input.env_vars.length - 1 && i > 0
      if (isShared) {
        // Item 3 bundle (2026-06-10) — the shared trailing env key is the
        // single-instance-box global credential (a bare ANTHROPIC_API_KEY
        // exported box-wide). On the MANAGED hosted deployment (and
        // on a Connect relay) that tier must be UNREACHABLE: an instance
        // with no/expired Max OAuth gets `null` (→ the /chat "Authorize
        // Max" reconnect gate), NEVER a silently borrowed box-global
        // credential shared across instances. Only the OSS single-instance
        // self-host shape ('open' — the `resolveDeploymentMode` default)
        // may use it, where a global box login/key is the legit,
        // simplest auth model. The per-instance tiers above (Max OAuth,
        // SecretsStore BYO, per-instance env — including the T15
        // CLAUDE_CODE_OAUTH_TOKEN, which on Managed comes from the
        // instance's OWN systemd EnvironmentFile) are intentionally
        // untouched.
        const mode = resolveDeploymentMode(input.env)
        if (mode !== 'open') {
          console.warn(
            `[composer] project=${log_slug} ${input.provider} SHARED env key ${name} is set but deployment mode is '${mode}' — refusing the box-global fallback; this project must attach its own credential (Max OAuth / BYO key). Returning null → reconnect gate.`,
          )
          continue
        }
        console.warn(
          `[composer] project=${log_slug} ${input.provider} credentials loaded from SHARED env key ${name} — review M2 credential-sharing plan`,
        )
      } else {
        console.info(
          `[composer] project=${log_slug} ${input.provider} credentials loaded from per-project env ${name}`,
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
