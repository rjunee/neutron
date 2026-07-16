/**
 * @neutronai/gateway/cores — Google OAuth token manager.
 *
 * Owns the `(kind=oauth_token, label=*)` rows in the per-instance
 * SecretsStore for Cores-side Google grants. Three rows per label:
 *
 *   - `<label>`           — ciphertext = access_token, expires_at set
 *   - `<label>:refresh`   — ciphertext = refresh_token, no expiry
 *   - `<label>:meta`      — ciphertext = JSON {scopes, email,
 *                                              connected_at, last_refresh_at,
 *                                              last_refresh_outcome}
 *
 * `getAccessToken(label)` is the transparent-refresh entry point. The
 * Cores SDK's bare `secretsAccessor.read({label})` still returns the
 * access_token verbatim for callers that don't refresh themselves —
 * but production Calendar / Email-Managed Cores route through this
 * manager so an expired access_token rotates via the refresh_token
 * before the next API call.
 *
 * Per docs/plans/cores-oauth-secret-resolution-sprint-brief.md § 2.3 + § 2.4.
 */

import type { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import type { OwnerHandle } from '@neutronai/persistence/index.ts'

/** Default lead time before expiry to trigger a refresh (ms). 60s. */
export const DEFAULT_REFRESH_LEAD_MS = 60_000

/** Google's refresh-token endpoint. Overridable via fetchImpl for tests. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** Google's revoke endpoint. */
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

/** Google's userinfo endpoint (used once after token exchange to capture email). */
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface OAuthTokenManagerOptions {
  secretsStore: SecretsStore
  /** Frozen owner handle (branded `OwnerHandle`) — keys every SecretsStore row. */
  internal_handle: OwnerHandle
  /** OAuth client id + secret — wired from env. */
  client_id: string
  client_secret: string
  /** Refresh-lead override (testing seam). */
  refresh_lead_ms?: number
  /** Fetch override (testing seam). */
  fetch?: FetchLike
  /** Wall clock override (testing seam). */
  now?: () => number
  /** Optional callback fired when a refresh exchange returns invalid_grant. */
  onInvalidGrant?: (label: string) => void | Promise<void>
}

export interface OAuthTokenPutInput {
  label: string
  access_token: string
  refresh_token: string
  /** Seconds; raw Google token-endpoint shape. */
  expires_in: number
  scopes: ReadonlyArray<string>
  /** Connected account email — captured from the userinfo endpoint. */
  email?: string
}

export interface OAuthTokenMeta {
  scopes: string[]
  email: string | null
  connected_at: number
  last_refresh_at: number | null
  last_refresh_outcome: 'ok' | 'invalid_grant' | 'error' | null
}

export interface OAuthTokenStatus {
  label: string
  connected: boolean
  scopes: string[]
  email: string | null
  connected_at: number | null
  last_refresh_at: number | null
  last_refresh_outcome: 'ok' | 'invalid_grant' | 'error' | null
  expires_at: number | null
}

export class OAuthRefreshError extends Error {
  override readonly name = 'OAuthRefreshError'
  constructor(
    readonly code: 'invalid_grant' | 'no_refresh_token' | 'token_endpoint_error',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

interface GoogleTokenRefreshResponse {
  access_token?: unknown
  expires_in?: unknown
  scope?: unknown
  refresh_token?: unknown
  token_type?: unknown
  error?: unknown
  error_description?: unknown
}

interface GoogleTokenExchangeResponse extends GoogleTokenRefreshResponse {
  id_token?: unknown
}

interface GoogleUserInfoResponse {
  email?: unknown
}

const REFRESH_LABEL_SUFFIX = ':refresh'
const META_LABEL_SUFFIX = ':meta'

export class OAuthTokenManager {
  private readonly secretsStore: SecretsStore
  private readonly internal_handle: OwnerHandle
  private readonly client_id: string
  private readonly client_secret: string
  private readonly refreshLeadMs: number
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly onInvalidGrant?: (label: string) => void | Promise<void>
  /** In-process refresh dedupe — collapses concurrent getAccessToken
   *  calls into a single Google fetch per label. Per brief § 2.4. */
  private readonly inflight = new Map<string, Promise<string>>()

  constructor(opts: OAuthTokenManagerOptions) {
    this.secretsStore = opts.secretsStore
    this.internal_handle = opts.internal_handle
    this.client_id = opts.client_id
    this.client_secret = opts.client_secret
    this.refreshLeadMs = opts.refresh_lead_ms ?? DEFAULT_REFRESH_LEAD_MS
    this.fetchImpl =
      opts.fetch ??
      ((input, init) =>
        init === undefined
          ? globalThis.fetch(input)
          : globalThis.fetch(input, init))
    this.now = opts.now ?? ((): number => Date.now())
    if (opts.onInvalidGrant !== undefined) this.onInvalidGrant = opts.onInvalidGrant
  }

  /**
   * Exchange a Google authorization_code for an access/refresh pair AND
   * write the resulting rows into the per-instance SecretsStore for every
   * supplied label. Returns the canonical email (resolved via userinfo)
   * + the granted scope list.
   */
  async exchangeAndPersist(input: {
    code: string
    code_verifier: string
    redirect_uri: string
    labels: ReadonlyArray<string>
  }): Promise<{ email: string | null; scopes: string[] }> {
    const tokenRes = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        client_id: this.client_id,
        client_secret: this.client_secret,
        redirect_uri: input.redirect_uri,
        code_verifier: input.code_verifier,
      }),
    })
    const body = (await safeJson(tokenRes)) as GoogleTokenExchangeResponse
    if (!tokenRes.ok) {
      const errCode = typeof body.error === 'string' ? body.error : 'token_exchange_failed'
      throw new OAuthRefreshError(
        'token_endpoint_error',
        `google token exchange failed: ${tokenRes.status} ${errCode}`,
      )
    }
    const access_token = typeof body.access_token === 'string' ? body.access_token : null
    const refresh_token = typeof body.refresh_token === 'string' ? body.refresh_token : null
    const expires_in = typeof body.expires_in === 'number' ? body.expires_in : null
    const scopeStr = typeof body.scope === 'string' ? body.scope : ''
    if (access_token === null || refresh_token === null || expires_in === null) {
      throw new OAuthRefreshError(
        'token_endpoint_error',
        `google token exchange response missing access_token / refresh_token / expires_in`,
      )
    }
    const scopes = scopeStr.length > 0 ? scopeStr.split(/\s+/).filter((s) => s.length > 0) : []

    // Best-effort email lookup. If userinfo fails, persist with email=null
    // and let the admin UI render a generic "Connected" line.
    let email: string | null = null
    try {
      const userinfoRes = await this.fetchImpl(GOOGLE_USERINFO_URL, {
        method: 'GET',
        headers: { authorization: `Bearer ${access_token}` },
      })
      if (userinfoRes.ok) {
        const userinfo = (await safeJson(userinfoRes)) as GoogleUserInfoResponse
        if (typeof userinfo.email === 'string' && userinfo.email.length > 0) {
          email = userinfo.email
        }
      }
    } catch {
      // Non-fatal — userinfo is metadata, not auth-critical.
    }

    for (const label of input.labels) {
      const putInput: OAuthTokenPutInput = {
        label,
        access_token,
        refresh_token,
        expires_in,
        scopes,
      }
      if (email !== null) putInput.email = email
      await this.put(putInput)
    }
    return { email, scopes }
  }

  /**
   * Persist a freshly-granted token bundle as three rows. Idempotent:
   * existing rows for the same label are rotated rather than insert-
   * conflicted.
   */
  async put(input: OAuthTokenPutInput): Promise<void> {
    const now = this.now()
    const access_expires_at = now + input.expires_in * 1000
    await this.upsert({
      kind: 'oauth_token',
      label: input.label,
      plaintext: input.access_token,
      expires_at: access_expires_at,
    })
    await this.upsert({
      kind: 'oauth_token',
      label: refreshLabel(input.label),
      plaintext: input.refresh_token,
      // No expires_at: refresh_tokens are valid until Google revokes.
    })
    const meta: OAuthTokenMeta = {
      scopes: [...input.scopes],
      email: input.email ?? null,
      connected_at: now,
      last_refresh_at: null,
      last_refresh_outcome: null,
    }
    await this.upsert({
      kind: 'oauth_token',
      label: metaLabel(input.label),
      plaintext: JSON.stringify(meta),
    })
  }

  /**
   * Read the cached access_token; refresh transparently via the
   * refresh_token row when the access row is within `refresh_lead_ms`
   * of expiry. Throws OAuthRefreshError on refresh failure.
   */
  async getAccessToken(label: string): Promise<string> {
    // First, check whether the cached row is still good. We re-list to
    // get the expires_at; SecretsStore.get returns the plaintext but
    // not the expiry, so this list call is necessary.
    const rows = await this.secretsStore.list({
      internal_handle: this.internal_handle,
      kind: 'oauth_token',
    })
    const accessRow = rows.find((r) => r.label === label) ?? null
    const expiresAt = accessRow?.expires_at ?? null
    const cached = await this.secretsStore.get({
      internal_handle: this.internal_handle,
      kind: 'oauth_token',
      label,
    })
    const now = this.now()
    if (cached !== null && expiresAt !== null && expiresAt - now > this.refreshLeadMs) {
      return cached
    }
    // Refresh path — collapse concurrent callers into one fetch.
    const existing = this.inflight.get(label)
    if (existing !== undefined) return existing
    const promise = this.runRefresh(label).finally(() => {
      this.inflight.delete(label)
    })
    this.inflight.set(label, promise)
    return promise
  }

  private async runRefresh(label: string): Promise<string> {
    const refresh = await this.secretsStore.get({
      internal_handle: this.internal_handle,
      kind: 'oauth_token',
      label: refreshLabel(label),
    })
    if (refresh === null) {
      throw new OAuthRefreshError(
        'no_refresh_token',
        `no refresh_token persisted for label='${label}' — user must reconnect`,
      )
    }
    const tokenRes = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: this.client_id,
        client_secret: this.client_secret,
      }),
    })
    const body = (await safeJson(tokenRes)) as GoogleTokenRefreshResponse
    if (!tokenRes.ok) {
      const errCode = typeof body.error === 'string' ? body.error : 'unknown'
      const isInvalidGrant = errCode === 'invalid_grant'
      await this.updateMeta(label, (meta) => ({
        ...meta,
        last_refresh_at: this.now(),
        last_refresh_outcome: isInvalidGrant ? 'invalid_grant' : 'error',
      }))
      if (isInvalidGrant) {
        if (this.onInvalidGrant !== undefined) {
          try {
            await this.onInvalidGrant(label)
          } catch {
            // best-effort
          }
        }
        throw new OAuthRefreshError(
          'invalid_grant',
          `refresh exchange returned invalid_grant — user must reconnect (label='${label}')`,
        )
      }
      throw new OAuthRefreshError(
        'token_endpoint_error',
        `refresh exchange failed: ${tokenRes.status} ${errCode}`,
      )
    }
    const newAccess = typeof body.access_token === 'string' ? body.access_token : null
    const expires_in = typeof body.expires_in === 'number' ? body.expires_in : null
    if (newAccess === null || expires_in === null) {
      throw new OAuthRefreshError(
        'token_endpoint_error',
        `refresh exchange response missing access_token / expires_in`,
      )
    }
    const now = this.now()
    await this.upsert({
      kind: 'oauth_token',
      label,
      plaintext: newAccess,
      expires_at: now + expires_in * 1000,
    })
    await this.updateMeta(label, (meta) => ({
      ...meta,
      last_refresh_at: now,
      last_refresh_outcome: 'ok',
    }))
    return newAccess
  }

  /**
   * Delete every row for a label (access + refresh + meta) and best-
   * effort revoke the refresh_token with Google. Returns the labels
   * that were actually present before deletion.
   */
  async disconnect(label: string): Promise<{ deleted: boolean }> {
    const refresh = await this.secretsStore.get({
      internal_handle: this.internal_handle,
      kind: 'oauth_token',
      label: refreshLabel(label),
    })
    if (refresh !== null) {
      try {
        await this.fetchImpl(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(refresh)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        })
      } catch {
        // best-effort; local cleanup still happens
      }
    }
    const rows = await this.secretsStore.list({
      internal_handle: this.internal_handle,
      kind: 'oauth_token',
    })
    let deleted = false
    for (const suffix of ['', REFRESH_LABEL_SUFFIX, META_LABEL_SUFFIX]) {
      const wanted = `${label}${suffix}`
      const match = rows.find((r) => r.label === wanted)
      if (match !== undefined) {
        await this.secretsStore.delete(match.id)
        deleted = true
      }
    }
    return { deleted }
  }

  async getStatus(label: string): Promise<OAuthTokenStatus> {
    const rows = await this.secretsStore.list({
      internal_handle: this.internal_handle,
      kind: 'oauth_token',
    })
    const accessRow = rows.find((r) => r.label === label) ?? null
    const metaRow = rows.find((r) => r.label === metaLabel(label)) ?? null
    if (accessRow === null && metaRow === null) {
      return {
        label,
        connected: false,
        scopes: [],
        email: null,
        connected_at: null,
        last_refresh_at: null,
        last_refresh_outcome: null,
        expires_at: null,
      }
    }
    let meta: OAuthTokenMeta | null = null
    if (metaRow !== null) {
      const raw = await this.secretsStore.get({
        internal_handle: this.internal_handle,
        kind: 'oauth_token',
        label: metaLabel(label),
      })
      if (raw !== null) {
        try {
          meta = JSON.parse(raw) as OAuthTokenMeta
        } catch {
          meta = null
        }
      }
    }
    return {
      label,
      connected: accessRow !== null,
      scopes: meta?.scopes ?? [],
      email: meta?.email ?? null,
      connected_at: meta?.connected_at ?? null,
      last_refresh_at: meta?.last_refresh_at ?? null,
      last_refresh_outcome: meta?.last_refresh_outcome ?? null,
      expires_at: accessRow?.expires_at ?? null,
    }
  }

  private async upsert(input: {
    kind: 'oauth_token'
    label: string
    plaintext: string
    expires_at?: number
  }): Promise<void> {
    const existing = await this.secretsStore.list({
      internal_handle: this.internal_handle,
      kind: input.kind,
    })
    const match = existing.find((r) => r.label === input.label)
    if (match !== undefined) {
      const rotateOpts: { expires_at?: number } = {}
      if (input.expires_at !== undefined) rotateOpts.expires_at = input.expires_at
      await this.secretsStore.rotate(match.id, input.plaintext, rotateOpts)
      return
    }
    const putInput: {
      internal_handle: OwnerHandle
      kind: 'oauth_token'
      label: string
      plaintext: string
      expires_at?: number
    } = {
      internal_handle: this.internal_handle,
      kind: input.kind,
      label: input.label,
      plaintext: input.plaintext,
    }
    if (input.expires_at !== undefined) putInput.expires_at = input.expires_at
    await this.secretsStore.put(putInput)
  }

  private async updateMeta(
    label: string,
    update: (prev: OAuthTokenMeta) => OAuthTokenMeta,
  ): Promise<void> {
    const raw = await this.secretsStore.get({
      internal_handle: this.internal_handle,
      kind: 'oauth_token',
      label: metaLabel(label),
    })
    const prev: OAuthTokenMeta =
      raw !== null
        ? (safeParseMeta(raw) ?? {
            scopes: [],
            email: null,
            connected_at: this.now(),
            last_refresh_at: null,
            last_refresh_outcome: null,
          })
        : {
            scopes: [],
            email: null,
            connected_at: this.now(),
            last_refresh_at: null,
            last_refresh_outcome: null,
          }
    const next = update(prev)
    await this.upsert({
      kind: 'oauth_token',
      label: metaLabel(label),
      plaintext: JSON.stringify(next),
    })
  }
}

export function refreshLabel(label: string): string {
  return `${label}${REFRESH_LABEL_SUFFIX}`
}

export function metaLabel(label: string): string {
  return `${label}${META_LABEL_SUFFIX}`
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return {}
  }
}

function safeParseMeta(raw: string): OAuthTokenMeta | null {
  try {
    const parsed = JSON.parse(raw) as Partial<OAuthTokenMeta>
    if (typeof parsed !== 'object' || parsed === null) return null
    return {
      scopes: Array.isArray(parsed.scopes)
        ? parsed.scopes.filter((s): s is string => typeof s === 'string')
        : [],
      email: typeof parsed.email === 'string' ? parsed.email : null,
      connected_at: typeof parsed.connected_at === 'number' ? parsed.connected_at : 0,
      last_refresh_at:
        typeof parsed.last_refresh_at === 'number' ? parsed.last_refresh_at : null,
      last_refresh_outcome:
        parsed.last_refresh_outcome === 'ok' ||
        parsed.last_refresh_outcome === 'invalid_grant' ||
        parsed.last_refresh_outcome === 'error'
          ? parsed.last_refresh_outcome
          : null,
    }
  } catch {
    return null
  }
}
