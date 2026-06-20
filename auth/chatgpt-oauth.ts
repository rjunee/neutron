/**
 * @neutronai/auth — ChatGPT (OpenAI) device-code OAuth client.
 *
 * Drives the device-code flow used by the Codex CLI when a user wants to
 * "sign in with ChatGPT" (i.e. attach an OpenAI subscription that the
 * Codex CLI later consumes via `~/.codex/auth.json`). P1.5 ships only the
 * primitives — the actual signin button + Codex-CLI hand-off lives in P2.
 *
 * IMPORTANT: P2's ChatGPT-zip importer (history archive) does NOT use
 * this module. The zip importer reads a static export Apple/Google ships
 * to the user's email; OAuth is unrelated.
 *
 * Tokens flow through `SecretsStore` as kind=`chatgpt_oauth`,
 * label=`<sub_label>` (default `'default'`). When the caller asks for the
 * `~/.codex/auth.json` shape, this module decrypts the stored envelope
 * and returns the literal JSON the Codex CLI expects.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SecretsStore, SecretsStoreError } from './secrets-store.ts'

const DEFAULT_SUB_LABEL = 'default'
const DEFAULT_DEVICE_AUTH_URL = 'https://auth.openai.com/oauth/device/code'
const DEFAULT_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_POLL_DEADLINE_MS = 10 * 60 * 1_000

export type ChatGPTOAuthErrorCode =
  | 'device_code_failed'
  | 'authorization_pending'
  | 'access_denied'
  | 'expired_token'
  | 'token_exchange_failed'
  | 'not_found'

export class ChatGPTOAuthError extends Error {
  override readonly name = 'ChatGPTOAuthError'
  constructor(
    readonly code: ChatGPTOAuthErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface ChatGPTOAuthConfig {
  device_authorization_url?: string
  token_url?: string
  client_id?: string
  scopes?: ReadonlyArray<string>
  poll_interval_ms?: number
  poll_deadline_ms?: number
}

/** Loose fetch shim — see `auth/max-oauth.ts:HttpFetch`. */
export type HttpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface ChatGPTOAuthClientDeps {
  secrets: SecretsStore
  httpFetch?: HttpFetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  config?: ChatGPTOAuthConfig
}

export interface DeviceCodeStartInput {
  /** Frozen `internal_handle` — see auth/secrets-store.ts file header. */
  internal_handle: string
  sub_label?: string
}

export interface DeviceCodeStartResult {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_at: number
  poll_interval_ms: number
}

export interface DeviceCodePollInput {
  /** Frozen `internal_handle` — see auth/secrets-store.ts file header. */
  internal_handle: string
  device_code: string
  sub_label?: string
}

export interface DeviceCodePollResult {
  authorized: boolean
  /** Present iff `authorized: true`. */
  expires_at?: number
}

export interface CodexAuthFile {
  OPENAI_API_KEY?: string
  tokens: {
    id_token?: string
    access_token: string
    refresh_token: string
    account_id?: string
  }
  last_refresh: string
}

export class ChatGPTOAuthClient {
  private readonly secrets: SecretsStore
  private readonly httpFetch: HttpFetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly config: Required<
    Pick<ChatGPTOAuthConfig, 'device_authorization_url' | 'token_url' | 'poll_interval_ms' | 'poll_deadline_ms'>
  > &
    Pick<ChatGPTOAuthConfig, 'client_id' | 'scopes'>

  constructor(deps: ChatGPTOAuthClientDeps) {
    this.secrets = deps.secrets
    this.httpFetch = deps.httpFetch ?? globalThis.fetch.bind(globalThis)
    this.now = deps.now ?? ((): number => Date.now())
    this.sleep =
      deps.sleep ??
      ((ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms)))
    this.config = {
      device_authorization_url:
        deps.config?.device_authorization_url ?? DEFAULT_DEVICE_AUTH_URL,
      token_url: deps.config?.token_url ?? DEFAULT_TOKEN_URL,
      poll_interval_ms: deps.config?.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS,
      poll_deadline_ms: deps.config?.poll_deadline_ms ?? DEFAULT_POLL_DEADLINE_MS,
      ...(deps.config?.client_id !== undefined ? { client_id: deps.config.client_id } : {}),
      ...(deps.config?.scopes !== undefined ? { scopes: deps.config.scopes } : {}),
    }
  }

  async startDeviceFlow(input: DeviceCodeStartInput): Promise<DeviceCodeStartResult> {
    let response: Response
    try {
      response = await this.httpFetch(this.config.device_authorization_url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...(this.config.client_id !== undefined ? { client_id: this.config.client_id } : {}),
          ...(this.config.scopes !== undefined ? { scope: this.config.scopes.join(' ') } : {}),
        }).toString(),
      })
    } catch (err) {
      throw new ChatGPTOAuthError('device_code_failed', `network error: ${errMsg(err)}`, err)
    }
    if (!response.ok) {
      throw new ChatGPTOAuthError(
        'device_code_failed',
        `device code endpoint returned ${response.status}`,
      )
    }
    interface DeviceResponse {
      device_code: string
      user_code: string
      verification_uri: string
      verification_uri_complete?: string
      expires_in: number
      interval?: number
    }
    let body: DeviceResponse
    try {
      body = (await response.json()) as DeviceResponse
    } catch (err) {
      throw new ChatGPTOAuthError('device_code_failed', `invalid JSON`, err)
    }
    if (
      typeof body.device_code !== 'string' ||
      typeof body.user_code !== 'string' ||
      typeof body.verification_uri !== 'string' ||
      typeof body.expires_in !== 'number'
    ) {
      throw new ChatGPTOAuthError('device_code_failed', `malformed device-code payload`)
    }
    const interval =
      typeof body.interval === 'number' ? body.interval * 1_000 : this.config.poll_interval_ms
    void input // input.internal_handle is reserved for telemetry by callers
    const result: DeviceCodeStartResult = {
      device_code: body.device_code,
      user_code: body.user_code,
      verification_uri: body.verification_uri,
      expires_at: this.now() + body.expires_in * 1_000,
      poll_interval_ms: interval,
    }
    if (typeof body.verification_uri_complete === 'string') {
      result.verification_uri_complete = body.verification_uri_complete
    }
    return result
  }

  /**
   * Poll the token endpoint with the supplied device_code. Returns once
   * the upstream returns either `authorized: true` (token stored) OR
   * throws on a terminal error (`access_denied`, `expired_token`).
   */
  async pollUntilAuthorized(
    input: DeviceCodePollInput & { poll_interval_ms: number },
  ): Promise<DeviceCodePollResult> {
    const sub_label = input.sub_label ?? DEFAULT_SUB_LABEL
    const deadline = this.now() + this.config.poll_deadline_ms
    while (this.now() < deadline) {
      let response: Response
      try {
        response = await this.httpFetch(this.config.token_url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: input.device_code,
            ...(this.config.client_id !== undefined ? { client_id: this.config.client_id } : {}),
          }).toString(),
        })
      } catch (err) {
        throw new ChatGPTOAuthError('token_exchange_failed', `network error: ${errMsg(err)}`, err)
      }
      const body = (await response.json().catch(() => null)) as
        | {
            access_token?: string
            refresh_token?: string
            id_token?: string
            expires_in?: number
            error?: string
          }
        | null
      if (response.ok && body !== null && typeof body.access_token === 'string') {
        const obtained_at = this.now()
        const expires_at = obtained_at + (body.expires_in ?? 3_600) * 1_000
        const refreshLabel = sub_label
        await this.removeIfExists(input.internal_handle, 'chatgpt_oauth', refreshLabel)
        // Store the full ChatGPT bundle (refresh + access + id) WITHOUT a
        // row-level `expires_at`. Codex review fix: setting expires_at to
        // the access-token expiry would make `SecretsStore.get()` return
        // null after access expiry, hiding the still-valid refresh token
        // from `writeCodexAuthFile()`. The Codex CLI manages its own
        // refresh based on the `last_refresh` timestamp inside the file,
        // so the row stays readable until explicitly revoked / rotated.
        // `obtained_at` is the wall-clock ms at token issue — used by
        // writeCodexAuthFile to stamp `last_refresh` with the real refresh
        // time, so a delayed file write doesn't lie to the Codex CLI
        // about freshness (Codex r6 follow-up).
        const payload = {
          access_token: body.access_token,
          refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : '',
          id_token: typeof body.id_token === 'string' ? body.id_token : undefined,
          access_expires_at: expires_at,
          obtained_at,
        }
        await this.secrets.put({
          internal_handle: input.internal_handle,
          kind: 'chatgpt_oauth',
          label: refreshLabel,
          plaintext: JSON.stringify(payload),
        })
        return { authorized: true, expires_at }
      }
      const errCode = body !== null && typeof body.error === 'string' ? body.error : 'authorization_pending'
      if (errCode === 'access_denied') {
        throw new ChatGPTOAuthError('access_denied', 'user denied device-code authorization')
      }
      if (errCode === 'expired_token') {
        throw new ChatGPTOAuthError('expired_token', 'device code expired before authorization')
      }
      // 'authorization_pending' or 'slow_down' — keep polling.
      await this.sleep(input.poll_interval_ms)
    }
    throw new ChatGPTOAuthError('expired_token', 'device-code poll deadline exceeded')
  }

  /**
   * Materialize the stored token into a `~/.codex/auth.json`-shaped
   * payload. Caller passes the absolute path; this module writes the
   * JSON with mode 0600. `OPENAI_API_KEY` is left blank — the Codex CLI
   * uses tokens.access_token for `chatgpt_token_only` mode.
   */
  async writeCodexAuthFile(input: {
    /** Frozen `internal_handle` — see auth/secrets-store.ts file header. */
    internal_handle: string
    target_path: string
    sub_label?: string
  }): Promise<{ path: string }> {
    const sub_label = input.sub_label ?? DEFAULT_SUB_LABEL
    const stored = await this.secrets.get({
      internal_handle: input.internal_handle,
      kind: 'chatgpt_oauth',
      label: sub_label,
    })
    if (stored === null) {
      throw new ChatGPTOAuthError(
        'not_found',
        `no ChatGPT OAuth token for instance=${input.internal_handle} sub=${sub_label}`,
      )
    }
    let parsed: {
      access_token?: string
      refresh_token?: string
      id_token?: string
      obtained_at?: number
    }
    try {
      parsed = JSON.parse(stored) as typeof parsed
    } catch (err) {
      throw new ChatGPTOAuthError('not_found', `stored payload not JSON`, err)
    }
    if (typeof parsed.access_token !== 'string') {
      throw new ChatGPTOAuthError('not_found', `stored payload missing access_token`)
    }
    // `last_refresh` MUST be the time the access token was actually
    // obtained — not the file-write time (Codex r6 follow-up). The Codex
    // CLI uses `last_refresh` to decide when to refresh; stamping it with
    // `now()` after a delayed write would make a stale token look fresh
    // and the CLI would skip the refresh path. Bundles written before
    // this fix landed (no `obtained_at` field) fall back to `now()` for
    // legacy compatibility — those rows refresh on next poll anyway.
    const lastRefreshMs =
      typeof parsed.obtained_at === 'number' ? parsed.obtained_at : this.now()
    const file: CodexAuthFile = {
      tokens: {
        access_token: parsed.access_token,
        refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '',
        ...(typeof parsed.id_token === 'string' ? { id_token: parsed.id_token } : {}),
      },
      last_refresh: new Date(lastRefreshMs).toISOString(),
    }
    mkdirSync(dirname(input.target_path), { recursive: true })
    writeFileSync(input.target_path, JSON.stringify(file, null, 2), { mode: 0o600 })
    // POSIX: writeFileSync's `mode` only applies on CREATE — re-writing an
    // existing file (e.g. user-created ~/.codex/auth.json at 0644) leaves
    // its permissions untouched. Force-tighten via an explicit chmod so
    // refresh writes can never widen the on-disk mode (Argus r1, finding 3).
    chmodSync(input.target_path, 0o600)
    return { path: input.target_path }
  }

  private async removeIfExists(
    internal_handle: string,
    kind: 'chatgpt_oauth',
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
