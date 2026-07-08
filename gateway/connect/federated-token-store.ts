/**
 * Federated connect token store (M2.5) — Open client side.
 *
 * Persists (encrypted, via SecretsStore) the Open instance's federated
 * credential obtained from the configured auth service, and serves a currently-valid
 * connect JWT for outbound connect API calls, refreshing on demand.
 *
 * One secret row holds a JSON blob:
 *   { refresh_token, refresh_expires_at, access_token, access_expires_at, user_instance_slug }
 *
 * Times are unix-SECONDS (matching the identity service). The secret row's own
 * `expires_at` is set to refresh_expires_at (ms) so the blob auto-disappears
 * when the refresh token dies — `status()` then correctly reports disconnected
 * without any sweeper.
 *
 * `getValidFederatedToken` returns the cached access JWT if it has >120s of
 * life left; otherwise it exchanges the refresh token at
 * `POST <auth_base>/auth/connect/token`, persists the new JWT, and
 * returns it. A 401 (dead refresh token) clears the blob. Any other failure —
 * or a user who belongs to no workspace yet — returns null so the aggregator
 * degrades the workspace to "unavailable" rather than failing the whole list.
 */

import { decodeJwt } from 'jose'

import type { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import type { Membership } from '@neutronai/jwt-validator/index.ts'

/** Refresh the access JWT once it's within this many seconds of expiry. */
export const FEDERATED_TOKEN_REFRESH_MARGIN_SECONDS = 120

const SECRET_KIND = 'oauth_token' as const
const SECRET_LABEL = 'connect_federation'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface FederationBlob {
  refresh_token: string
  refresh_expires_at: number // unix-seconds
  access_token: string | null
  access_expires_at: number | null // unix-seconds
  user_instance_slug: string | null
}

/** Shape returned by `POST /auth/connect/redeem`. */
export interface RedeemResponse {
  user_id: string
  refresh_token: string
  refresh_expires_at: number
  connect_token: string | null
  connect_expires_at: number | null
  user_instance_slug: string | null
}

export interface FederatedStatus {
  connected: boolean
  user_instance_slug?: string
  access_expires_at_ms?: number
  refresh_expires_at_ms?: number
}

export interface FederatedTokenStoreDeps {
  secrets: SecretsStore
  /** Frozen registry PK for this instance (NOT the mutable url_slug). */
  internal_handle: string
  /** Base URL of the identity service, e.g. https://auth.example.test */
  auth_base_url: string
  fetch?: FetchLike
  /** ms clock (injectable for tests). */
  now?: () => number
}

export class FederatedConnectError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'FederatedConnectError'
  }
}

export class FederatedTokenStore {
  private readonly secrets: SecretsStore
  private readonly internalHandle: string
  private readonly authBase: string
  private readonly fetchImpl: FetchLike
  private readonly now: () => number

  constructor(deps: FederatedTokenStoreDeps) {
    this.secrets = deps.secrets
    this.internalHandle = deps.internal_handle
    this.authBase = deps.auth_base_url.replace(/\/+$/, '')
    this.fetchImpl = deps.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.now = deps.now ?? ((): number => Date.now())
  }

  private async loadBlob(): Promise<FederationBlob | null> {
    const raw = await this.secrets.get({
      internal_handle: this.internalHandle,
      kind: SECRET_KIND,
      label: SECRET_LABEL,
    })
    if (raw === null) return null
    try {
      return JSON.parse(raw) as FederationBlob
    } catch {
      return null
    }
  }

  private async saveBlob(blob: FederationBlob): Promise<void> {
    await this.secrets.replaceAtomic([
      {
        internal_handle: this.internalHandle,
        kind: SECRET_KIND,
        label: SECRET_LABEL,
        plaintext: JSON.stringify(blob),
        // Row auto-expires when the refresh token dies.
        expires_at: blob.refresh_expires_at * 1_000,
      },
    ])
  }

  /** Persist the credential returned by a successful redeem. */
  private async persistRedeem(r: RedeemResponse): Promise<void> {
    await this.saveBlob({
      refresh_token: r.refresh_token,
      refresh_expires_at: r.refresh_expires_at,
      access_token: r.connect_token,
      access_expires_at: r.connect_expires_at,
      user_instance_slug: r.user_instance_slug,
    })
  }

  /**
   * Exchange a one-time code for a federated credential and persist it. Called
   * by the local OAuth callback route. Throws FederatedConnectError on any
   * non-2xx from the identity service.
   */
  async connectViaRedeem(code: string): Promise<FederatedStatus> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.authBase}/auth/connect/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      })
    } catch (err) {
      throw new FederatedConnectError(
        `redeem request failed: ${err instanceof Error ? err.message : 'unknown'}`,
      )
    }
    if (!res.ok) {
      throw new FederatedConnectError(`redeem rejected: ${res.status}`, res.status)
    }
    const body = (await res.json()) as RedeemResponse
    await this.persistRedeem(body)
    return this.status()
  }

  /** Drop the stored credential (the user disconnected). Idempotent. */
  async disconnect(): Promise<void> {
    const records = await this.secrets.list({
      internal_handle: this.internalHandle,
      kind: SECRET_KIND,
    })
    for (const rec of records) {
      if (rec.label === SECRET_LABEL) {
        await this.secrets.delete(rec.id)
      }
    }
  }

  /** Report connection state without minting/refreshing anything. */
  async status(): Promise<FederatedStatus> {
    const blob = await this.loadBlob()
    if (blob === null) return { connected: false }
    return {
      connected: true,
      ...(blob.user_instance_slug !== null ? { user_instance_slug: blob.user_instance_slug } : {}),
      ...(blob.access_expires_at !== null
        ? { access_expires_at_ms: blob.access_expires_at * 1_000 }
        : {}),
      refresh_expires_at_ms: blob.refresh_expires_at * 1_000,
    }
  }

  /**
   * Return a currently-valid federated connect JWT, refreshing if needed.
   * Returns null when not connected, when the refresh token is dead, or when
   * the user belongs to no workspace yet — the caller degrades gracefully.
   */
  async getValidFederatedToken(): Promise<string | null> {
    const blob = await this.loadBlob()
    if (blob === null) return null
    const nowSec = Math.floor(this.now() / 1_000)
    if (
      blob.access_token !== null &&
      blob.access_expires_at !== null &&
      blob.access_expires_at - nowSec > FEDERATED_TOKEN_REFRESH_MARGIN_SECONDS
    ) {
      return blob.access_token
    }
    // Exchange the refresh token for a fresh connect JWT.
    let res: Response
    try {
      res = await this.fetchImpl(`${this.authBase}/auth/connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: blob.refresh_token }),
      })
    } catch {
      return null
    }
    if (res.status === 401) {
      // Refresh token is dead — clear the blob so status() reports disconnected.
      await this.disconnect()
      return null
    }
    if (!res.ok) return null
    let body: { connect_token: string | null; expires_at: number | null; user_instance_slug?: string | null }
    try {
      body = (await res.json()) as typeof body
    } catch {
      return null
    }
    if (body.connect_token === null || body.connect_token === undefined) {
      // Authenticated but not a member of any workspace yet.
      return null
    }
    await this.saveBlob({
      ...blob,
      access_token: body.connect_token,
      access_expires_at: body.expires_at ?? null,
      user_instance_slug: body.user_instance_slug ?? blob.user_instance_slug,
    })
    return body.connect_token
  }

  /**
   * Return the membership list carried by the current federated token,
   * refreshing the token if needed. The Open-mode shared-projects resolver
   * uses this to enumerate which workspaces to fan out to — it replaces the
   * local identity-DB `MembershipStore.list` the Managed path uses (an Open
   * box has no local identity DB).
   *
   * Returns `[]` when not connected, when the user belongs to no workspace
   * yet (no token minted), or when the token can't be decoded — the resolver
   * then renders the user's solo projects only, exactly as on a fresh box.
   *
   * The memberships are read from the token's `memberships` claim, which the
   * identity service signs in (the identity federated-token issuer). We do
   * NOT verify the signature here: this is OUR cached token obtained from a
   * trusted server-to-server exchange, and each receiving workspace instance
   * independently re-verifies the signature when the token is presented to
   * its connect API. Decoding only reads which workspaces to query.
   */
  async getMemberships(): Promise<Membership[]> {
    const token = await this.getValidFederatedToken()
    if (token === null) return []
    try {
      const claims = decodeJwt(token) as { memberships?: unknown }
      if (!Array.isArray(claims.memberships)) return []
      return claims.memberships as Membership[]
    } catch {
      return []
    }
  }
}
