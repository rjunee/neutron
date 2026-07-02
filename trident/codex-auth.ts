/**
 * @neutronai/trident — Codex SUBSCRIPTION auth: validation, path resolution,
 * materialization, and connection status (trident cross-model review, Part B).
 *
 * Part A shipped `trident/codex-review.sh`, which reads a per-tenant
 * `CODEX_HOME/auth.json` (a ChatGPT-SUBSCRIPTION OAuth bundle) and runs the
 * `codex` CLI as an independent cross-model reviewer. This module is the Part-B
 * bridge that lets the owner CONNECT that credential from the admin panel:
 *
 *   1. `validateCodexSubscriptionAuth(pasted)` — parse what the owner pasted
 *      (their `~/.codex/auth.json`) and CLASSIFY it. SUBSCRIPTION auth
 *      (`tokens.access_token` + `tokens.refresh_token`) is accepted + normalized;
 *      a metered `OPENAI_API_KEY` (auth_mode=apikey) is REJECTED — Ryan's hard
 *      rule is NEVER the metered path. A bare `sk-...` paste is likewise rejected.
 *   2. `resolveCodexHome({ owner_home })` — the canonical per-tenant CODEX_HOME
 *      directory. The materialize path AND the trident loop's env
 *      (`build-core-modules.ts`) resolve through THIS one function so they can
 *      never disagree about where `auth.json` lives.
 *   3. `materializeCodexAuth({ codexHome, authJson })` — write the normalized
 *      bundle to `CODEX_HOME/auth.json` at mode 0600 (mirrors
 *      `auth/chatgpt-oauth.ts:writeCodexAuthFile`), so `codex login status` (and
 *      thus `codex-review.sh`) sees it as connected (exit 0), not the exit-10
 *      NOT_CONNECTED branch.
 *   4. `deriveCodexStatus(...)` — connected / expired / not_connected for the
 *      admin panel + the `codex_status` agent tool.
 *
 * PURE (no store, no HTTP) so it unit-tests trivially; `codex-credential.ts`
 * layers the `ProjectCredentialStore` persistence on top.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The `~/.codex/auth.json` shape the Codex CLI reads (subscription mode). */
export interface CodexAuthFile {
  /** MUST be blank/absent for subscription auth — a real key = the metered path. */
  OPENAI_API_KEY?: string | null
  tokens: {
    id_token?: string
    access_token: string
    refresh_token: string
    account_id?: string
  }
  /** ISO-8601 — the Codex CLI uses this to decide when to refresh. */
  last_refresh: string
}

export type CodexAuthMode = 'subscription' | 'apikey' | 'unknown'

export interface CodexAuthValidation {
  ok: boolean
  mode: CodexAuthMode
  /** The normalized `auth.json` JSON to persist + materialize (only when ok). */
  normalized?: string
  /** Machine code for the surface: 'metered_key' | 'malformed' | 'missing_tokens'. */
  code?: 'metered_key' | 'malformed' | 'missing_tokens'
  error?: string
}

/** Max chars we'll accept for a pasted auth blob (matches the store's token cap). */
const MAX_AUTH_LEN = 8192

/**
 * Classify + normalize a pasted Codex auth blob.
 *
 * REJECTS (metered): a non-empty `OPENAI_API_KEY`, or a bare `sk-...` paste —
 * both drive the codex CLI into `apikey` mode, which bills per-token. Ryan's
 * standing rule is subscription-only.
 * ACCEPTS (subscription): `tokens.access_token` + `tokens.refresh_token`,
 * normalized to a clean bundle with `OPENAI_API_KEY` stripped so the CLI can
 * only ever use the OAuth tokens.
 */
export function validateCodexSubscriptionAuth(
  pasted: unknown,
  now: () => number = Date.now,
): CodexAuthValidation {
  if (typeof pasted !== 'string' || pasted.trim().length === 0) {
    return { ok: false, mode: 'unknown', code: 'malformed', error: 'no auth content pasted' }
  }
  const trimmed = pasted.trim()
  if (trimmed.length > MAX_AUTH_LEN) {
    return { ok: false, mode: 'unknown', code: 'malformed', error: `auth blob too large (>${MAX_AUTH_LEN} chars)` }
  }

  // A bare API key paste (not JSON) → metered, reject with a helpful message.
  if (/^sk-[A-Za-z0-9_-]+$/.test(trimmed)) {
    return {
      ok: false,
      mode: 'apikey',
      code: 'metered_key',
      error:
        'that looks like a metered OPENAI_API_KEY (auth_mode=apikey). Codex review is subscription-only — ' +
        'run `codex login` (ChatGPT account) on your machine and paste the resulting ~/.codex/auth.json instead.',
    }
  }

  let parsed: Record<string, unknown>
  try {
    const raw = JSON.parse(trimmed) as unknown
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, mode: 'unknown', code: 'malformed', error: 'auth must be a JSON object (your ~/.codex/auth.json)' }
    }
    parsed = raw as Record<string, unknown>
  } catch {
    return { ok: false, mode: 'unknown', code: 'malformed', error: 'auth is not valid JSON — paste the full contents of ~/.codex/auth.json' }
  }

  // A real OPENAI_API_KEY present → metered mode; REJECT even if tokens coexist
  // (the codex CLI PREFERS the key over OAuth, so its presence = metered).
  const apiKey = parsed['OPENAI_API_KEY']
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
    return {
      ok: false,
      mode: 'apikey',
      code: 'metered_key',
      error:
        'this auth.json carries an OPENAI_API_KEY (auth_mode=apikey) — that is the METERED path and is rejected. ' +
        'Sign in with `codex login` using your ChatGPT subscription (no API key) and paste that auth.json.',
    }
  }

  const tokens = parsed['tokens']
  if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) {
    return {
      ok: false,
      mode: 'unknown',
      code: 'missing_tokens',
      error: 'no subscription `tokens` in the auth.json — run `codex login` (ChatGPT) and paste the file it writes.',
    }
  }
  const t = tokens as Record<string, unknown>
  const access = t['access_token']
  const refresh = t['refresh_token']
  if (typeof access !== 'string' || access.trim().length === 0) {
    return { ok: false, mode: 'unknown', code: 'missing_tokens', error: 'auth.json tokens missing access_token' }
  }
  if (typeof refresh !== 'string' || refresh.trim().length === 0) {
    return {
      ok: false,
      mode: 'unknown',
      code: 'missing_tokens',
      error: 'auth.json tokens missing refresh_token — this is not a subscription (chatgpt) login',
    }
  }

  // Normalize: strip any API key, keep only the OAuth tokens the CLI needs, and
  // preserve a valid `last_refresh` (default to now if absent/invalid).
  const idToken = typeof t['id_token'] === 'string' ? (t['id_token'] as string) : undefined
  const accountId = typeof t['account_id'] === 'string' ? (t['account_id'] as string) : undefined
  const lastRefreshRaw = parsed['last_refresh']
  const lastRefresh =
    typeof lastRefreshRaw === 'string' && !Number.isNaN(Date.parse(lastRefreshRaw))
      ? lastRefreshRaw
      : new Date(now()).toISOString()

  const file: CodexAuthFile = {
    tokens: {
      access_token: access,
      refresh_token: refresh,
      ...(idToken !== undefined ? { id_token: idToken } : {}),
      ...(accountId !== undefined ? { account_id: accountId } : {}),
    },
    last_refresh: lastRefresh,
  }
  return { ok: true, mode: 'subscription', normalized: JSON.stringify(file, null, 2) }
}

/**
 * The canonical per-tenant CODEX_HOME directory. `owner_home` is already the
 * per-project_slug tenant root (`resolveNeutronHome`), so `<owner_home>/.codex`
 * is a per-tenant CODEX_HOME — the ONE place both the admin-panel materialize
 * and the trident loop's env agree on.
 */
export function resolveCodexHome(opts: { owner_home: string }): string {
  return join(opts.owner_home, '.codex')
}

/** The absolute `auth.json` path inside a CODEX_HOME. */
export function codexAuthPath(codexHome: string): string {
  return join(codexHome, 'auth.json')
}

/**
 * Write the normalized subscription bundle to `CODEX_HOME/auth.json` at mode
 * 0600. Mirrors `auth/chatgpt-oauth.ts:writeCodexAuthFile`: `writeFileSync`'s
 * `mode` only applies on CREATE, so we `chmod` explicitly afterwards to tighten
 * an existing (possibly 0644) file.
 */
export function materializeCodexAuth(input: { codexHome: string; authJson: string }): { path: string } {
  const target = codexAuthPath(input.codexHome)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, input.authJson.endsWith('\n') ? input.authJson : `${input.authJson}\n`, { mode: 0o600 })
  chmodSync(target, 0o600)
  return { path: target }
}

/** Remove a materialized `auth.json` (idempotent — no-op if absent). */
export function removeCodexAuth(codexHome: string): void {
  const target = codexAuthPath(codexHome)
  if (existsSync(target)) rmSync(target)
}

export type CodexConnectionStatus = 'connected' | 'expired' | 'not_connected'

export interface CodexStatusDetail {
  status: CodexConnectionStatus
  /** Whether an `auth.json` is materialized at the resolved CODEX_HOME. */
  materialized: boolean
  /** ISO expiry decoded from the access_token JWT `exp`, when present. */
  expires_at?: string
  detail: string
}

/**
 * Decode the `exp` (seconds since epoch) from a JWT access token, best-effort.
 * Returns null if the token isn't a decodeable JWT (the CLI still refreshes via
 * refresh_token, so a non-JWT opaque token is treated as non-expiring here).
 */
function decodeJwtExpMs(accessToken: string): number | null {
  const parts = accessToken.split('.')
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown }
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) return payload.exp * 1000
    return null
  } catch {
    return null
  }
}

/**
 * Derive connection status from a stored/normalized auth.json string.
 * `connected` = valid subscription tokens whose access token has NOT expired;
 * `expired` = tokens present but the access-token JWT `exp` is in the past
 * (still recoverable via `codex login`/refresh, so we surface it distinctly);
 * `not_connected` = no/invalid auth.
 */
export function deriveCodexStatus(
  authJson: string | null,
  opts: { materialized: boolean; now?: () => number },
): CodexStatusDetail {
  const now = opts.now ?? Date.now
  if (authJson === null || authJson.trim().length === 0) {
    return { status: 'not_connected', materialized: opts.materialized, detail: 'No Codex subscription connected.' }
  }
  let file: CodexAuthFile
  try {
    file = JSON.parse(authJson) as CodexAuthFile
  } catch {
    return { status: 'not_connected', materialized: opts.materialized, detail: 'Stored Codex auth is unreadable.' }
  }
  const access = file.tokens?.access_token
  if (typeof access !== 'string' || access.length === 0) {
    return { status: 'not_connected', materialized: opts.materialized, detail: 'Stored Codex auth has no access token.' }
  }
  const expMs = decodeJwtExpMs(access)
  if (expMs !== null && expMs <= now()) {
    return {
      status: 'expired',
      materialized: opts.materialized,
      expires_at: new Date(expMs).toISOString(),
      detail: 'Codex subscription token expired — re-run `codex login` and paste the fresh auth.json.',
    }
  }
  return {
    status: 'connected',
    materialized: opts.materialized,
    ...(expMs !== null ? { expires_at: new Date(expMs).toISOString() } : {}),
    detail: 'Codex subscription connected.',
  }
}

/** Read the materialized `auth.json` at a CODEX_HOME (or null if absent). */
export function readMaterializedAuth(codexHome: string): string | null {
  const target = codexAuthPath(codexHome)
  if (!existsSync(target)) return null
  try {
    return readFileSync(target, 'utf8')
  } catch {
    return null
  }
}
