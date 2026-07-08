/**
 * @neutronai/auth — Anthropic Claude Max paste-token client (Sprint 23).
 *
 * Replaces Sprint 22's PKCE OAuth-redirect flow. Sprint 22 redirected the
 * browser to `https://auth.anthropic.com/oauth/authorize` — that hostname
 * does not resolve. Anthropic has not shipped a public Max OAuth API for
 * third-party integration; the only documented path for a third party to
 * consume an owner's Max sub is the locally-acquired token from
 * `claude setup-token`.
 *
 * Per Atlas's research at
 * internal design notes,
 * the runtime adapter's auth chain (six tiers) only consumes
 * locally-acquired credentials. Tier (5) `CLAUDE_CODE_OAUTH_TOKEN` is the
 * exact shape Anthropic's CLI emits when a user runs `claude setup-token`
 * on their own machine.
 *
 * Sprint 23 model: owners paste their `claude setup-token` output into
 * the identity service's gate page. The token is probed against
 * `api.anthropic.com/v1/messages` to confirm it is well-formed (200 / 401
 * with rate-limit / 403 quota-exceeded all confirm Anthropic recognises
 * the token; 401 with invalid-key / 400 reject as malformed). On success
 * the token is persisted to the per-project SecretsStore as TWO rows:
 *
 *   - `kind=max_oauth_refresh, label=<sub_label>` — semantics shifted
 *     from "OAuth refresh token" to "long-lived Max paste token". The
 *     name is preserved so the existing SecretsStore schema + the
 *     `ownerHasMaxOAuthTokens` probe path keep working without a
 *     migration.
 *   - `kind=max_oauth_access,  label=<sub_label>:access` — SAME value as
 *     the refresh row. Paste tokens have no separate access-vs-refresh
 *     distinction; the access row exists so the resolver's existing
 *     read path (`max_oauth_access` first, fall through to refresh)
 *     short-circuits to the cached value. `expires_at` defaults to
 *     `now + 365d` because `claude setup-token` tokens are documented
 *     as long-lived; the user re-pastes when their Anthropic account
 *     rotates the token.
 *
 * The resolver consumes via `getAccessToken` which returns a
 * `{ access_token, expires_at }` or null. The chat-surface adapter's
 * tier (5) `CLAUDE_CODE_OAUTH_TOKEN` env var is set from this token via
 * the helper exported below (`oauthEnvForPool`).
 *
 * Removed (vs Sprint 22): the PKCE redirect code path. `startFlow`,
 * `consumeCallback`, `exchangeAndPersistDirect`, `exchangeCode`, and
 * `refreshAccessToken` are gone. The on-disk schema is unchanged so a
 * Sprint-22 SecretsStore row keeps reading; only the write-side shape
 * changes from "exchange code → tokens" to "probe token → persist".
 */

import { SecretsStore, SecretsStoreError } from './secrets-store.ts'
import { PROBE_MODEL } from '@neutronai/runtime/models.ts'

const DEFAULT_SUB_LABEL = 'default'

/**
 * Default access-row TTL. `claude setup-token` issues long-lived tokens
 * (Atlas research notes "no documented expiry"). 365 days is long
 * enough that an owner who pasted at signup keeps working through a
 * year of normal use; the next re-paste happens when the user notices
 * their token failing (Anthropic-side rotation) and re-runs
 * `claude setup-token`.
 */
const PASTE_TOKEN_DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1_000

/**
 * Default Anthropic API base — the probe POSTs against this URL. Tests
 * inject `config.api_base_url` to point at a mock fetch.
 */
const DEFAULT_API_BASE_URL = 'https://api.anthropic.com'

/**
 * Anthropic API version pinned for the probe request. Anthropic's
 * `messages` endpoint requires the `anthropic-version` header; without
 * it the probe gets a 400 that is unrelated to the token's validity.
 */
const PROBE_API_VERSION = '2023-06-01'

/**
 * Probe model — sourced from `runtime/models.ts:PROBE_MODEL` so the alias
 * is the single source of truth across the codebase. We send `max_tokens=1`
 * so the call is essentially free (most replies refuse before generating
 * any tokens). We only care about the auth-tier response (200 vs 401 vs
 * 403 vs 400); the body is ignored.
 */

export type MaxOAuthErrorCode =
  | 'token_probe_failed'
  | 'token_invalid'
  | 'not_found'

export class MaxOAuthError extends Error {
  override readonly name = 'MaxOAuthError'
  constructor(
    readonly code: MaxOAuthErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface MaxOAuthClientConfig {
  /** Override the api.anthropic.com base URL — tests inject a mock. */
  api_base_url?: string
  /** Override the access-row TTL when persisting a paste token. */
  paste_token_ttl_ms?: number
}

/** Loosely-typed fetch shim — production passes `globalThis.fetch`; tests
 *  pass any function that returns a `Response`. */
export type HttpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface MaxOAuthClientDeps {
  secrets: SecretsStore
  httpFetch?: HttpFetch
  now?: () => number
  config?: MaxOAuthClientConfig
}

export interface PersistPasteTokenInput {
  /** Frozen `internal_handle` — see auth/secrets-store.ts file header. */
  internal_handle: string
  /** The literal output of `claude setup-token` on the user's machine. */
  token: string
  /** Override the sub label (default `'default'`). */
  sub_label?: string
}

export interface PersistPasteTokenResult {
  id: string
  /** Frozen `internal_handle` — see auth/secrets-store.ts file header. */
  internal_handle: string
  expires_at: number
  sub_label: string
}

export interface ProbeTokenResult {
  /** True when Anthropic recognised the token (200 / 401-rate / 403). */
  valid: boolean
  /** Upstream HTTP status when probing. -1 on network failure. */
  status: number
  /**
   * One-line reason for human display. Always present; safe to surface
   * in the form-error UI verbatim (no upstream secrets leaked).
   */
  reason: string
}

export class MaxOAuthClient {
  private readonly secrets: SecretsStore
  private readonly httpFetch: HttpFetch
  private readonly now: () => number
  private readonly apiBaseUrl: string
  private readonly pasteTokenTtlMs: number

  constructor(deps: MaxOAuthClientDeps) {
    this.secrets = deps.secrets
    this.httpFetch = deps.httpFetch ?? globalThis.fetch.bind(globalThis)
    this.now = deps.now ?? ((): number => Date.now())
    this.apiBaseUrl = deps.config?.api_base_url ?? DEFAULT_API_BASE_URL
    this.pasteTokenTtlMs =
      deps.config?.paste_token_ttl_ms ?? PASTE_TOKEN_DEFAULT_TTL_MS
  }

  /**
   * Probe a candidate paste token against api.anthropic.com to confirm
   * Anthropic recognises it. The probe POSTs a 1-token `messages`
   * request — cheap to issue, definitive on the auth tier:
   *
   *   - 200                 → token is valid AND has Anthropic-side
   *                            credit. Accept.
   *   - 429                  → token is valid (Anthropic recognised the
   *                            account) but throttled. Accept.
   *   - 403                  → token is valid but quota-exhausted /
   *                            permission-denied. Accept (the user can
   *                            still authenticate; the chat surface
   *                            will surface the upstream 403 when the
   *                            user actually sends a message).
   *   - 402                  → billing failure. Accept-and-surface
   *                            later (the owner's Max sub may have
   *                            lapsed but the token still identifies
   *                            them).
   *   - 401 + rate_limit     → throttled, valid. Accept.
   *   - 401 invalid_api_key /
   *     400 invalid_request_
   *     error                → token is malformed / wrong shape.
   *                            Reject.
   *   - other / network      → unknown — reject (surface as
   *                            "could not validate" so the user can
   *                            re-paste).
   *
   * The decision rule mirrors how Anthropic's own CLI treats setup
   * tokens — an `Authorization: Bearer <token>` header is the only
   * shape `claude setup-token` produces.
   */
  async probeToken(input: { token: string }): Promise<ProbeTokenResult> {
    const probeUrl = new URL('/v1/messages', this.apiBaseUrl).toString()
    let response: Response
    try {
      response = await this.httpFetch(probeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': PROBE_API_VERSION,
          authorization: `Bearer ${input.token}`,
        },
        body: JSON.stringify({
          model: PROBE_MODEL,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return {
        valid: false,
        status: -1,
        reason: `network error reaching api.anthropic.com (${reason})`,
      }
    }

    const status = response.status

    // 200: token is healthy.
    if (status === 200) {
      return { valid: true, status, reason: 'ok' }
    }

    // Read the body once to inspect the error code / type. Anthropic
    // returns `{"type":"error","error":{"type":"invalid_request_error" | "authentication_error" | "permission_error" | "rate_limit_error" | "overloaded_error" | "billing_error", "message":"..."}}`.
    let bodyText = ''
    try {
      bodyText = await response.text()
    } catch {
      // ignore — fall through to status-only classification.
    }
    const errorType = extractAnthropicErrorType(bodyText)

    // 429: rate-limited. Token is valid; Anthropic just throttled. Accept.
    if (status === 429) {
      return {
        valid: true,
        status,
        reason: `rate-limited (${errorType ?? 'rate_limit_error'}) — token is valid`,
      }
    }

    // 403: forbidden / quota / permission. Token authenticates but the
    // tier can't complete THIS request — the chat surface will surface
    // the actual upstream 403 when the user sends a real message. Accept.
    if (status === 403) {
      return {
        valid: true,
        status,
        reason: `quota / permission limit (${errorType ?? 'permission_error'}) — token is valid`,
      }
    }

    // 402: billing failure. Same accept-and-surface-later semantics as
    // 403 — the owner's Max sub may have lapsed but the token still
    // identifies them. Accept so the user can re-connect their billing
    // upstream without re-onboarding.
    if (status === 402) {
      return {
        valid: true,
        status,
        reason: `billing (${errorType ?? 'billing_error'}) — token is valid`,
      }
    }

    // 401: distinguish "rate limit dressed up as 401" (rare but
    // observed in legacy paths) vs "actually invalid token".
    if (status === 401) {
      if (errorType === 'rate_limit_error') {
        return {
          valid: true,
          status,
          reason: 'rate-limited (401 rate_limit_error) — token is valid',
        }
      }
      return {
        valid: false,
        status,
        reason: `Anthropic rejected the token (${errorType ?? 'authentication_error'}). Re-run \`claude setup-token\` and paste the new value.`,
      }
    }

    // 400: malformed request. Sprint 23 spec requires 400 → reject
    // so we don't persist a token Anthropic explicitly rejected.
    //
    // Codex Sprint 23 r7 P1 — reverts r4 P1's "accept 400" change,
    // which silently persisted unverified tokens. Spec-compliant
    // 400 = reject. Side-effect: if Anthropic retires the probe
    // model (`claude-haiku-4-5-20251001`), every probe returns 400
    // and onboarding is dead until the operator updates the model
    // constant. Mitigation: pick a model with a long support
    // horizon AND track Anthropic's deprecation announcements
    // alongside our model-version updates.
    if (status === 400) {
      return {
        valid: false,
        status,
        reason: `Anthropic returned 400 (${errorType ?? 'invalid_request_error'}) — the token shape looks wrong, OR the probe model has been retired. Re-run \`claude setup-token\` and paste the new value; if the failure persists contact the operator.`,
      }
    }

    // 5xx: upstream is down. Reject so the user retries; we don't
    // want to commit a token we couldn't validate.
    if (status >= 500) {
      return {
        valid: false,
        status,
        reason: `Anthropic returned ${status} (${errorType ?? 'upstream error'}) — please retry in a moment.`,
      }
    }

    // Anything else → unknown.
    return {
      valid: false,
      status,
      reason: `unexpected response from api.anthropic.com (status ${status}, ${errorType ?? 'unknown'})`,
    }
  }

  /**
   * Persist a probed paste token. Writes the SAME value to BOTH
   * `max_oauth_refresh` (label=<sub_label>) AND `max_oauth_access`
   * (label=<sub_label>:access). Paste tokens have no separate
   * access-vs-refresh distinction; the access row exists so the
   * resolver's existing read path short-circuits without ever falling
   * through to the (now-impossible) upstream refresh.
   *
   * The caller is responsible for calling `probeToken` first. We do
   * NOT re-probe here so test fixtures can stage a probe response and
   * an unrelated persistence outcome independently.
   */
  async persistPasteToken(
    input: PersistPasteTokenInput,
  ): Promise<PersistPasteTokenResult> {
    const sub_label = input.sub_label ?? DEFAULT_SUB_LABEL
    const refreshLabel = sub_label
    const accessLabel = `${sub_label}:access`
    const expires_at = this.now() + this.pasteTokenTtlMs

    // Codex Sprint 23 r6 P2 — write BOTH rows in ONE transaction so a
    // partial failure between the delete + the second insert can't
    // leave the owner with a half-written set of paste-token rows
    // (which would strand the chat surface). Either both new rows
    // land or none — the previous tokens stay intact on rollback.
    const [refreshRecord] = await this.secrets.replaceAtomic([
      {
        internal_handle: input.internal_handle,
        kind: 'max_oauth_refresh',
        label: refreshLabel,
        plaintext: input.token,
      },
      {
        internal_handle: input.internal_handle,
        kind: 'max_oauth_access',
        label: accessLabel,
        plaintext: input.token,
        expires_at,
      },
    ])
    return {
      id: refreshRecord!.id,
      internal_handle: input.internal_handle,
      expires_at,
      sub_label,
    }
  }

  /**
   * Read the cached paste token. Returns `null` when no
   * `max_oauth_refresh` row exists for the owner — the resolver
   * then falls through to BYO/env so an owner who hasn't completed
   * the paste-token gate yet doesn't break the chat surface.
   *
   * Resolution order:
   *   1. `max_oauth_access` row (with TTL) — the fast path.
   *   2. `max_oauth_refresh` row — fallback when the access row has
   *      expired or is missing. Sprint 23 paste tokens hold the SAME
   *      value in both rows, so re-promoting refresh into a fresh
   *      access row is safe.
   *   3. null — no row at all.
   *
   * Codex Sprint 23 r8 P1 — restores the fallback that r2 P2
   * removed. r2 P2's concern was Sprint-22 schema drift (different
   * values in refresh vs access); in practice Sprint 22 never reached
   * production (its redirect to auth.anthropic.com was unreachable),
   * so no Sprint-22 rows exist in the wild. The fallback is required
   * for short-TTL deployments via `NEUTRON_ANTHROPIC_PASTE_TOKEN_TTL_MS`
   * (staging dry-runs, tests) where the access row genuinely expires
   * before the user re-pastes. Without it, the resolver falls
   * through to BYO/env and the chat surface darkens even though a
   * still-valid paste token sits on disk.
   */
  async getAccessToken(
    internal_handle: string,
    sub_label?: string,
  ): Promise<{ access_token: string; expires_at: number } | null> {
    const label = sub_label ?? DEFAULT_SUB_LABEL
    const accessLabel = `${label}:access`

    const cached = await this.secrets.get({
      internal_handle,
      kind: 'max_oauth_access',
      label: accessLabel,
    })
    if (cached !== null && cached.length > 0) {
      const records = await this.secrets.list({ internal_handle, kind: 'max_oauth_access' })
      const row = records.find((r) => r.label === accessLabel)
      if (row !== undefined && row.expires_at !== null) {
        return { access_token: cached, expires_at: row.expires_at }
      }
      // No expiry on the row (defensive — `persistPasteToken` always
      // sets one). Report a 1-min budget so the resolver treats this
      // as a near-expiring row.
      return { access_token: cached, expires_at: this.now() + 60_000 }
    }

    // Access row is missing or expired — fall back to the refresh
    // row (which holds the SAME value for Sprint 23 paste tokens)
    // and re-promote it into a fresh access row.
    const refresh = await this.secrets.get({
      internal_handle,
      kind: 'max_oauth_refresh',
      label,
    })
    if (refresh === null || refresh.length === 0) return null

    const expires_at = this.now() + this.pasteTokenTtlMs
    await this.removeIfExists(internal_handle, 'max_oauth_access', accessLabel)
    await this.secrets.put({
      internal_handle,
      kind: 'max_oauth_access',
      label: accessLabel,
      plaintext: refresh,
      expires_at,
    })
    return { access_token: refresh, expires_at }
  }

  /**
   * Drop the local paste-token rows for an owner. There is no upstream
   * revoke endpoint for `claude setup-token` — Anthropic owns rotation
   * — so this is purely a local cleanup.
   */
  async revoke(internal_handle: string, sub_label?: string): Promise<void> {
    const label = sub_label ?? DEFAULT_SUB_LABEL
    await this.removeIfExists(internal_handle, 'max_oauth_refresh', label)
    await this.removeIfExists(internal_handle, 'max_oauth_access', `${label}:access`)
  }

  private async removeIfExists(
    internal_handle: string,
    kind: 'max_oauth_refresh' | 'max_oauth_access',
    label: string,
  ): Promise<void> {
    const existing = await this.secrets.list({ internal_handle, kind })
    for (const row of existing) {
      if (row.label === label) {
        try {
          await this.secrets.delete(row.id)
        } catch (err) {
          if (err instanceof SecretsStoreError && err.code === 'not_found') continue
          throw err
        }
      }
    }
  }
}

/**
 * Sprint 23 — convert an OAuth-shaped `CredentialPool` (the
 * `kind: 'oauth'` shape produced by `resolveLlmCredentials` when the
 * owner pasted a Max token) into the env fragment the Claude Code
 * adapter consumes via tier (5).
 *
 * The adapter's `resolveAuth` reads `env['CLAUDE_CODE_OAUTH_TOKEN']`
 * and emits `Authorization: Bearer <token>`. Setting this env var is
 * the simplest plumb-through that keeps the adapter completely
 * unchanged and re-uses the existing six-tier precedence.
 *
 * Returns `{}` when no oauth-kind credential is present so callers
 * can `Object.assign` the result into a base env without branching.
 */
export function oauthEnvForPool(
  pool: { credentials: ReadonlyArray<{ kind: string; secret: string }> } | null,
): Record<string, string> {
  if (pool === null) return {}
  const oauth = pool.credentials.find((c) => c.kind === 'oauth')
  if (oauth === undefined || oauth.secret.length === 0) return {}
  return { CLAUDE_CODE_OAUTH_TOKEN: oauth.secret }
}

/**
 * Pull the Anthropic error type out of a JSON error body, matching
 * Anthropic's documented error shape:
 *   {"type":"error","error":{"type":"invalid_request_error","message":"..."}}
 *
 * Returns `undefined` when the body isn't JSON or doesn't match.
 * Callers fall back to status-code-only classification.
 */
function extractAnthropicErrorType(body: string): string | undefined {
  if (body.length === 0) return undefined
  try {
    const parsed = JSON.parse(body) as {
      error?: { type?: unknown }
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      parsed.error !== undefined &&
      typeof parsed.error === 'object' &&
      parsed.error !== null &&
      typeof (parsed.error as { type?: unknown }).type === 'string'
    ) {
      return (parsed.error as { type: string }).type
    }
  } catch {
    // not JSON
  }
  return undefined
}
