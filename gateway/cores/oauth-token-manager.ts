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
 * ── MULTIPLE ACCOUNTS PER SERVICE ──────────────────────────────────────────────
 * A label is `<service>#<account_key>` — the SERVICE (what a Core's manifest
 * declares: `google_calendar`, `gmail_compose`, `google_workspace`) plus a
 * STABLE ACCOUNT KEY, so an owner who runs several accounts on the same service
 * has one independent grant per account instead of one that clobbers the last.
 * Before this the label named the service alone, so a second grant overwrote the
 * first and a read only ever spanned one account.
 *
 * The account key is derived from the ONE identity the grant already carries:
 * the account address the token exchange resolves from Google's userinfo
 * endpoint and persists into `:meta`. That address only exists because the
 * authorize URL asks for an identity scope — see `GOOGLE_IDENTITY_SCOPES` in
 * `gateway/http/cores-oauth-surface.ts`. Without it userinfo answers nothing,
 * every grant is anonymous, and this whole per-account scheme silently
 * collapses back to one-grant-per-service (ISSUES #494). It is a truncated
 * SHA-256 of the lowercased address rather than the address itself, for two
 * reasons — the
 * SecretsStore's `label` column is NOT encrypted (only ciphertext is), so a raw
 * address would put a plaintext identifier at rest that the encrypted `:meta`
 * already holds properly; and a hex key can never collide with the `:refresh` /
 * `:meta` suffix grammar the way an arbitrary address could.
 *
 * ── THE UPGRADE PATH (no manual step) ──────────────────────────────────────────
 * An install that already holds a bare `google_calendar` grant keeps working
 * untouched: `listGrants` ADOPTS an un-keyed row as an account whose
 * `account_key` is null, and every read path resolves through `listGrants`, so
 * the legacy grant is simply the first account. Nothing is rewritten at boot and
 * no row is rebuilt, so there is no window in which the owner is disconnected.
 * The row converts to the keyed shape the next time that service is granted:
 * `exchangeAndPersist` retires a bare row that names the SAME address it just
 * wrote, or one that names NO address at all (the #494 population, which can
 * never be identified and so would otherwise be adopted as a phantom second
 * account forever). A bare row naming a DIFFERENT address is a real second
 * account and is never touched. See `retireLegacyRowFor`.
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

import { createHash } from 'node:crypto'

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
  owner_handle: OwnerHandle
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

/**
 * One connected account for one service. This — not a bare label — is what
 * every read path enumerates, which is what makes N accounts per service work
 * and what makes the legacy un-keyed grant keep working with no migration.
 */
export interface OAuthGrant {
  /** The full SecretsStore label. Pass THIS to `getAccessToken`. */
  label: string
  /** Service part of the label (`google_calendar`, `gmail_compose`, …). */
  service: string
  /**
   * Stable per-account key, or `null` for a legacy un-keyed grant (an install
   * that connected before labels carried an account, or one whose address
   * Google's userinfo never returned — see `exchangeAndPersist`).
   */
  account_key: string | null
  /** Connected account address from `:meta`; null when it could not be read. */
  email: string | null
  scopes: string[]
  connected_at: number | null
  expires_at: number | null
  last_refresh_outcome: 'ok' | 'invalid_grant' | 'error' | null
}

export interface OAuthTokenStatus {
  label: string
  /** Service part of `label` — stable across accounts. */
  service: string
  /** Account key part of `label`; null for a legacy un-keyed grant. */
  account_key: string | null
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

/**
 * Separator between the SERVICE part of a grant label and its ACCOUNT key.
 * Chosen because it appears in no service name, no hex account key, and no
 * suffix (`:refresh` / `:meta`), so `parseGrantLabel` is unambiguous.
 */
export const ACCOUNT_KEY_SEPARATOR = '#'

/** Length of the truncated SHA-256 used as an account key. */
const ACCOUNT_KEY_LENGTH = 12

export class OAuthTokenManager {
  private readonly secretsStore: SecretsStore
  private readonly owner_handle: OwnerHandle
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
    this.owner_handle = opts.owner_handle
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
   * Exchange a Google authorization_code for an access/refresh pair AND write
   * the resulting rows into the per-instance SecretsStore for every supplied
   * SERVICE. Returns the canonical email (resolved via userinfo), the granted
   * scope list, the account key the grant was filed under, and the labels
   * actually written.
   *
   * `input.labels` are SERVICES (what a Core's manifest declares). The labels
   * written are per-account, so granting a second account leaves the first
   * account's rows untouched.
   */
  async exchangeAndPersist(input: {
    code: string
    code_verifier: string
    redirect_uri: string
    labels: ReadonlyArray<string>
  }): Promise<{
    email: string | null
    scopes: string[]
    labels: string[]
    account_key: string | null
  }> {
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

    // Each incoming label names a SERVICE. Write the grant under that service's
    // per-account label so connecting a second account adds a grant instead of
    // overwriting the first. When userinfo gave us no address there is no
    // identity to key on, so the grant lands on the bare service label — which
    // is exactly the pre-existing single-account shape, and is enumerated as an
    // un-keyed account rather than being hidden.
    const account_key = email !== null ? accountKeyFromEmail(email) : null
    const written: string[] = []
    for (const service of input.labels) {
      const label =
        account_key !== null ? serviceAccountLabel(service, account_key) : service
      const putInput: OAuthTokenPutInput = {
        label,
        access_token,
        refresh_token,
        expires_in,
        scopes,
      }
      if (email !== null) putInput.email = email
      await this.put(putInput)
      written.push(label)
      if (account_key !== null) await this.retireLegacyRowFor(service, email)
    }
    return { email, scopes, labels: written, account_key }
  }

  /**
   * Retire a pre-existing un-keyed `<service>` grant once a keyed grant has
   * been written for the same service — the in-place half of the upgrade path.
   * Only ever called with a non-null `account_key` in hand, so there is always
   * a keyed grant standing behind whatever this removes.
   *
   * Two shapes of bare row exist, and they retire under different rules:
   *
   *   - **Identified** (`:meta.email` present). Retired on an EXACT address
   *     match only. A bare row naming a DIFFERENT account is a real, readable
   *     second account: it is left completely alone and migrates itself the
   *     next time THAT address is granted.
   *
   *   - **Anonymous** (`:meta.email` null). Retired unconditionally. This is
   *     the ISSUES #494 population — grants written before the authorize URL
   *     asked for an identity scope, so userinfo returned no address and the
   *     grant landed bare. Such a row can never be identified after the fact:
   *     its access token was minted WITHOUT `openid`, so re-querying userinfo
   *     with it returns nothing, and no future exchange can ever match it. It
   *     therefore can never migrate, and `listGrants` would adopt it forever
   *     ALONGSIDE the keyed grant — the same mailbox read twice, every item
   *     duplicated, indefinitely. Retiring it is the only end state that
   *     converges.
   *
   *     Retiring is also safe by construction: because a bare label is one row
   *     per service, an anonymous bare row holds the LAST account to consent to
   *     that service and no other — any earlier account's tokens were already
   *     overwritten (that is the #494 bug). So it is either the account that
   *     just re-consented (retire = de-duplicate), or an account whose grant is
   *     unidentifiable and which the owner recovers, correctly keyed, with one
   *     re-consent.
   *
   * A bare access row with NO `:meta` at all is not a grant this manager wrote
   * — it is the Core install lifecycle echoing its token back under the
   * manifest label (`cores/runtime/lifecycle.ts` persistOrRotate). `listGrants`
   * already skips that echo, so it is left untouched.
   */
  private async retireLegacyRowFor(service: string, email: string | null): Promise<void> {
    if (email === null) return
    const legacyMeta = await this.readMeta(service)
    if (legacyMeta === null) return
    if (legacyMeta.email !== null && !sameAccount(legacyMeta.email, email)) return
    const rows = await this.secretsStore.list({
      owner_handle: this.owner_handle,
      kind: 'oauth_token',
    })
    for (const suffix of ['', REFRESH_LABEL_SUFFIX, META_LABEL_SUFFIX]) {
      const match = rows.find((r) => r.label === `${service}${suffix}`)
      if (match !== undefined) await this.secretsStore.delete(match.id)
    }
  }

  /**
   * Every connected account for `service`, oldest connection first.
   *
   * THE enumeration seam: fan-out reads, status, and the single-account
   * accessors all resolve through this, so there is one definition of "which
   * accounts are connected" and adding an account changes no caller.
   *
   * A legacy un-keyed `<service>` row is adopted as an account with
   * `account_key: null`. It is dropped ONLY when a keyed grant for the same
   * address already exists — otherwise a half-migrated install would read the
   * same mailbox twice and show every item duplicated.
   */
  async listGrants(service: string): Promise<OAuthGrant[]> {
    const rows = await this.secretsStore.list({
      owner_handle: this.owner_handle,
      kind: 'oauth_token',
    })
    const labels = new Set(rows.map((r) => r.label))
    const grants: OAuthGrant[] = []
    for (const row of rows) {
      if (
        row.label.endsWith(REFRESH_LABEL_SUFFIX) ||
        row.label.endsWith(META_LABEL_SUFFIX)
      ) {
        continue
      }
      const parsed = parseGrantLabel(row.label)
      if (parsed.service !== service) continue
      // An un-keyed row is a GRANT only if `put` wrote it — which always
      // produces a `:refresh` and a `:meta` companion. A bare access row with
      // neither is the Core install lifecycle echoing the token it was just
      // handed back under the manifest label (`cores/runtime/lifecycle.ts`
      // persistOrRotate). Counting that echo would list the same account twice
      // and make the fan-out read one mailbox two times.
      if (
        parsed.account_key === null &&
        !labels.has(refreshLabel(row.label)) &&
        !labels.has(metaLabel(row.label))
      ) {
        continue
      }
      const meta = await this.readMeta(row.label)
      grants.push({
        label: row.label,
        service,
        account_key: parsed.account_key,
        email: meta?.email ?? null,
        scopes: meta?.scopes ?? [],
        connected_at: meta?.connected_at ?? null,
        expires_at: row.expires_at ?? null,
        last_refresh_outcome: meta?.last_refresh_outcome ?? null,
      })
    }
    const keyed = new Set(
      grants
        .filter((g) => g.account_key !== null)
        .map((g) => g.account_key as string),
    )
    const deduped = grants.filter(
      (g) =>
        g.account_key !== null ||
        g.email === null ||
        !keyed.has(accountKeyFromEmail(g.email)),
    )
    // Oldest connection first, so the account the owner has had longest stays
    // the primary (the one writes go to). Label breaks ties deterministically.
    deduped.sort((a, b) => {
      const at = a.connected_at ?? 0
      const bt = b.connected_at ?? 0
      if (at !== bt) return at - bt
      return a.label < b.label ? -1 : a.label > b.label ? 1 : 0
    })
    return deduped
  }

  /**
   * Access token for the PRIMARY (first-connected) account of `service`.
   * The single-account entry point for callers that genuinely address one
   * account — writes, and services the owner only ever connects once.
   * Returns null when nothing is connected.
   */
  async getServiceAccessToken(service: string): Promise<string | null> {
    const grants = await this.listGrants(service)
    const primary = grants[0]
    if (primary === undefined) return null
    return await this.getAccessToken(primary.label)
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
      owner_handle: this.owner_handle,
      kind: 'oauth_token',
    })
    const accessRow = rows.find((r) => r.label === label) ?? null
    const expiresAt = accessRow?.expires_at ?? null
    const cached = await this.secretsStore.get({
      owner_handle: this.owner_handle,
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
      owner_handle: this.owner_handle,
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
      owner_handle: this.owner_handle,
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
      owner_handle: this.owner_handle,
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
      owner_handle: this.owner_handle,
      kind: 'oauth_token',
    })
    const accessRow = rows.find((r) => r.label === label) ?? null
    const metaRow = rows.find((r) => r.label === metaLabel(label)) ?? null
    const parsed = parseGrantLabel(label)
    if (accessRow === null && metaRow === null) {
      return {
        label,
        service: parsed.service,
        account_key: parsed.account_key,
        connected: false,
        scopes: [],
        email: null,
        connected_at: null,
        last_refresh_at: null,
        last_refresh_outcome: null,
        expires_at: null,
      }
    }
    const meta = metaRow !== null ? await this.readMeta(label) : null
    return {
      label,
      service: parsed.service,
      account_key: parsed.account_key,
      connected: accessRow !== null,
      scopes: meta?.scopes ?? [],
      email: meta?.email ?? null,
      connected_at: meta?.connected_at ?? null,
      last_refresh_at: meta?.last_refresh_at ?? null,
      last_refresh_outcome: meta?.last_refresh_outcome ?? null,
      expires_at: accessRow?.expires_at ?? null,
    }
  }

  /** Decode a label's `:meta` row, or null when absent / unparseable. */
  private async readMeta(label: string): Promise<OAuthTokenMeta | null> {
    const raw = await this.secretsStore.get({
      owner_handle: this.owner_handle,
      kind: 'oauth_token',
      label: metaLabel(label),
    })
    if (raw === null) return null
    return safeParseMeta(raw)
  }

  private async upsert(input: {
    kind: 'oauth_token'
    label: string
    plaintext: string
    expires_at?: number
  }): Promise<void> {
    const existing = await this.secretsStore.list({
      owner_handle: this.owner_handle,
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
      owner_handle: OwnerHandle
      kind: 'oauth_token'
      label: string
      plaintext: string
      expires_at?: number
    } = {
      owner_handle: this.owner_handle,
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
      owner_handle: this.owner_handle,
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

/**
 * Stable account key for a Google account address. Truncated SHA-256 of the
 * lowercased, trimmed address: stable across reconnects (same account ⇒ same
 * key ⇒ the grant rotates in place instead of accumulating rows), and hex-only
 * so it can never be confused with the `:refresh` / `:meta` suffix grammar.
 *
 * 12 hex chars = 48 bits. Collision needs two of the owner's OWN addresses to
 * agree on 48 bits — far outside the handful of accounts one person connects.
 */
export function accountKeyFromEmail(email: string): string {
  return createHash('sha256')
    .update(email.trim().toLowerCase(), 'utf8')
    .digest('hex')
    .slice(0, ACCOUNT_KEY_LENGTH)
}

/** Compose the per-account grant label for a service. */
export function serviceAccountLabel(service: string, account_key: string): string {
  return `${service}${ACCOUNT_KEY_SEPARATOR}${account_key}`
}

/**
 * Split a grant label into its service and account key. A label with no
 * separator is a legacy un-keyed grant — service only, `account_key: null`.
 */
export function parseGrantLabel(label: string): {
  service: string
  account_key: string | null
} {
  const at = label.indexOf(ACCOUNT_KEY_SEPARATOR)
  if (at < 0) return { service: label, account_key: null }
  return {
    service: label.slice(0, at),
    account_key: label.slice(at + ACCOUNT_KEY_SEPARATOR.length),
  }
}

/** Do two addresses name the same account? Case- and whitespace-insensitive. */
function sameAccount(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
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
