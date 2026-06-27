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

/* ─── client ─── */

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export interface IntegrationsClientOptions {
  /** Page origin (`https://host`); the surface lives at `/api/cores/...`. */
  base_url: string
  /** App-ws bearer token (`config.token`). */
  token: string
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: FetchImpl
}

export class IntegrationsClientError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`)
    this.name = 'IntegrationsClientError'
    this.code = code
    this.status = status
  }
}

interface ErrorBody {
  ok?: boolean
  code?: string
  message?: string
}

export class IntegrationsClient {
  private readonly base_url: string
  private readonly token: string
  private readonly fetchImpl: FetchImpl

  constructor(opts: IntegrationsClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
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

  private async req<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? 'GET'
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` }
    let body: string | undefined
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.body)
    }
    let res: Response
    try {
      res = await this.fetchImpl(`${this.base_url}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      })
    } catch (err) {
      throw new IntegrationsClientError('network', err instanceof Error ? err.message : 'network error', 0)
    }
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      // fall through to the status-coded error below
    }
    if (!res.ok) {
      const errBody = (json ?? {}) as ErrorBody
      const code = errBody.code ?? 'request_failed'
      const message = errBody.message ?? `HTTP ${res.status}`
      throw new IntegrationsClientError(code, message, res.status)
    }
    return json as T
  }
}
