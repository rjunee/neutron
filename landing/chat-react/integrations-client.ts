/**
 * landing/chat-react — web INTEGRATIONS API client (admin / OAuth + API keys).
 *
 * The web twin of the mobile `app/lib/cores-client.ts` integrations slice. A
 * thin fetch wrapper for the gateway's per-instance integrations surface
 * (`gateway/http/cores-integrations-surface.ts`):
 *
 *   GET    /api/cores/integrations          → { ok, oauth[], api_keys[] }
 *   POST   /api/cores/api-keys/<label>       → store/rotate a BYO API key
 *   DELETE /api/cores/api-keys/<label>       → clear a stored API key
 *
 * …plus the two Google-OAuth connection routes the Admin tab drives
 * (`gateway/http/cores-oauth-surface.ts`):
 *
 *   GET  /api/cores/oauth/google/start?labels=…      → { ok, authorize_url, … }
 *   POST /api/cores/oauth/google/disconnect/<label>  → revoke + delete tokens
 *
 * `/start` is BEARER-GATED, so it can never be rendered as an `<a href>` — a
 * browser navigation carries no Authorization header and the route 401s
 * (cores-oauth-surface.ts resolveBearer). The caller does this authenticated
 * round-trip and then navigates to the returned `authorize_url`, which is the
 * PUBLIC `accounts.google.com` consent URL and needs no credential. Same
 * server-side start the mobile client and the agent-native `integrations_connect`
 * tool run — one code path, three callers.
 *
 * NO plaintext secrets ever come back from GET — each slot carries a `connected`
 * boolean only, never the key value. The web Admin tab reflects that boolean and
 * lets the owner set / clear keys + see which OAuth accounts are connected.
 *
 * Auth + base URL mirror the sibling `docs-client.ts` / `tabs-client.ts`: the
 * app-ws bearer token (`config.token`) and the page origin (`config.origin`).
 * Wire shapes mirror the mobile `app/lib/cores-client.ts` types byte-for-byte
 * but are re-declared here (rather than imported across the workspace boundary)
 * so the browser bundle stays free of an Expo-app dependency — the same
 * convention `docs-client.ts` follows. Pure given an injected `fetchImpl`, so it
 * unit-tests without a DOM or a live server.
 */

import {
  GatewayClientError,
  GatewayHttpClient,
  type GatewayHttpClientOptions,
} from '@neutronai/client-core'

/* ─── wire types (mirror app/lib/cores-client.ts byte-for-byte) ─── */

/** OAuth label status — mirrors `OAuthStatusLabel` in the mobile client. */
export interface OAuthStatusLabel {
  label: string
  connected: boolean
  scopes: string[]
  email: string | null
  connected_at: number | null
  last_refresh_at: number | null
  last_refresh_outcome: 'ok' | 'invalid_grant' | 'error' | null
  expires_at: number | null
}

/** A per-Core Google OAuth account slot + its live connection status. */
export interface OAuthAccountIntegration extends OAuthStatusLabel {
  kind: 'oauth'
  scope: string
  core_slugs: string[]
}

/** A standalone API-key slot + whether a key is currently stored. */
export interface ApiKeyIntegration {
  kind: 'api_key'
  label: string
  name: string
  core_slugs: string[]
  required: boolean
  install_prompt: string
  connected: boolean
}

export interface IntegrationsResponse {
  ok: boolean
  oauth: OAuthAccountIntegration[]
  api_keys: ApiKeyIntegration[]
}

export interface ApiKeySetResponse {
  ok: boolean
  label: string
  connected: boolean
}

export interface ApiKeyDeleteResponse {
  ok: boolean
  label: string
  deleted: boolean
}

/** `/api/cores/oauth/google/start` — `authorize_url` is the PUBLIC Google
 *  consent URL (never a gateway link), safe to navigate to without a bearer. */
export interface OAuthStartResponse {
  ok: boolean
  authorize_url: string
  state: string
  expires_at: number
}

export interface OAuthDisconnectResponse {
  ok: boolean
  disconnected: string[]
  affected_cores: string[]
}

/* ─── client ─── */

export type IntegrationsClientOptions = GatewayHttpClientOptions

export class IntegrationsClientError extends GatewayClientError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status)
    this.name = 'IntegrationsClientError'
  }
}

export class IntegrationsClient extends GatewayHttpClient {
  protected override readonly guardNetworkErrors = true

  protected override makeError(code: string, message: string, status: number): GatewayClientError {
    return new IntegrationsClientError(code, message, status)
  }

  /** Unified Integrations status: OAuth accounts + standalone API-key slots. */
  async getStatus(): Promise<IntegrationsResponse> {
    return await this.req<IntegrationsResponse>('/api/cores/integrations')
  }

  /** Store (or rotate) a standalone API key for a `byo_api_key` slot. */
  async setApiKey(label: string, value: string): Promise<ApiKeySetResponse> {
    return await this.req<ApiKeySetResponse>(
      `/api/cores/api-keys/${encodeURIComponent(label)}`,
      { method: 'POST', body: { value } },
    )
  }

  /** Clear a stored API key for a `byo_api_key` slot. */
  async deleteApiKey(label: string): Promise<ApiKeyDeleteResponse> {
    return await this.req<ApiKeyDeleteResponse>(
      `/api/cores/api-keys/${encodeURIComponent(label)}`,
      { method: 'DELETE' },
    )
  }

  /**
   * Start a Google OAuth grant and get back the public consent URL to navigate
   * to. `labels` are SERVICE labels (`google_calendar`), never composite
   * per-account ones — `/start` validates them against the manifest-declared
   * slots and a `<service>#<account_key>` would 400 `unknown_label`.
   *
   * This authenticated round-trip is mandatory: `/start` is bearer-gated, so a
   * plain link to it 401s in the browser.
   */
  async oauthStart(labels: string[]): Promise<OAuthStartResponse> {
    const q = encodeURIComponent(labels.join(','))
    return await this.req<OAuthStartResponse>(
      `/api/cores/oauth/google/start?labels=${q}`,
    )
  }

  /**
   * Revoke + delete one account's Google tokens. `label` is the FULL grant
   * label off the row (composite when the service holds several accounts), so
   * disconnecting one account leaves the others connected. POST, per
   * `cores-oauth-surface.ts` — the route only matches `req.method === 'POST'`.
   */
  async oauthDisconnect(label: string): Promise<OAuthDisconnectResponse> {
    return await this.req<OAuthDisconnectResponse>(
      `/api/cores/oauth/google/disconnect/${encodeURIComponent(label)}`,
      { method: 'POST' },
    )
  }
}
