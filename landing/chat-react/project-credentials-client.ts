/**
 * landing/chat-react — web PROJECT CREDENTIALS API client (Settings tab).
 *
 * A thin fetch wrapper over the gateway's per-project credential surface
 * (bearer-gated, `project-credentials/`), the store the agent's tool calls read
 * their per-project API keys / tokens from:
 *
 *   GET    /api/app/projects/<id>/credentials                 list (metadata)
 *   POST   /api/app/projects/<id>/credentials                 set / replace
 *   DELETE /api/app/projects/<id>/credentials/<service>       remove
 *
 * ── Metadata only, never the secret ─────────────────────────────────────────
 * The list route returns credential METADATA (`id`, `service`, `scope`, `label`,
 * timestamps) but NEVER the token value — a set is write-only. The Settings tab
 * therefore renders "a key exists for <service>" affordances, not the secret.
 *
 * ── project vs global scope ─────────────────────────────────────────────────
 * A credential is either `project`-scoped (this project only) or `global` (an
 * instance-wide default a project inherits when it has no project-scoped key for
 * that service). The list splits them into `project` + `global` so the tab can
 * label inherited rows; DELETE takes the scope as a query param so removing an
 * inherited default doesn't require knowing its owning project.
 *
 * Wire shapes mirror the gateway types but are re-declared here (rather than
 * imported across the workspace boundary) so the browser bundle stays free of a
 * gateway dependency — the same convention `work-board-client.ts` /
 * `docs-client.ts` follow. Pure given an injected `fetchImpl`, so it unit-tests
 * without a DOM or a live server.
 */

/* ─── wire types (mirror project-credentials/ store rows) ─── */

/** Where a credential lives: this project only, or an instance-wide default. */
export type CredentialScope = 'project' | 'global'

/**
 * One credential row, METADATA only — the token value is never returned by the
 * API (a set is write-only). `label` is an optional human note; `expires_at` is
 * an optional ISO-8601 expiry (null = no expiry).
 */
export interface Rec {
  id: string
  owner_slug: string
  project_id: string
  scope: CredentialScope
  service: string
  label: string | null
  created_at: string
  updated_at: string
  expires_at: string | null
}

/** Input for a set (POST). `token` is the only write-only field. */
export interface SetCredentialInput {
  service: string
  token: string
  scope: CredentialScope
  label?: string
  expires_at?: string
}

interface ListResponse {
  ok: boolean
  project_id: string
  /** Credentials scoped to this project. */
  project: Rec[]
  /** Instance-wide defaults this project inherits. */
  global: Rec[]
}
interface SetResponse {
  ok: boolean
  credential: Rec
  project_id: string
}
interface ErrorBody {
  ok?: boolean
  code?: string
  message?: string
}

/** The list split by scope, as the Settings tab renders it. */
export interface CredentialList {
  project: Rec[]
  global: Rec[]
}

export class CredentialsClientError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`)
    this.name = 'CredentialsClientError'
    this.code = code
    this.status = status
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export interface CredentialsClientOptions {
  /** Page origin (`https://host`); the surface lives at `/api/app/...`. */
  base_url: string
  /** App-ws bearer token (`config.token`). */
  token: string
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: FetchImpl
}

export class WebProjectCredentialsClient {
  private readonly base_url: string
  private readonly token: string
  private readonly fetchImpl: FetchImpl

  constructor(opts: CredentialsClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  /** This project's credentials + the global defaults it inherits (metadata). */
  async list(project_id: string): Promise<CredentialList> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/credentials`
    const res = await this.req<ListResponse>(path)
    return { project: res.project ?? [], global: res.global ?? [] }
  }

  /** Store (or replace) a credential for a service at the given scope. */
  async set(project_id: string, input: SetCredentialInput): Promise<Rec> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/credentials`
    const res = await this.req<SetResponse>(path, { method: 'POST', body: input })
    return res.credential
  }

  /** Remove a service's credential at the given scope (project | global). */
  async remove(project_id: string, service: string, scope: CredentialScope): Promise<void> {
    const path =
      `/api/app/projects/${encodeURIComponent(project_id)}/credentials/${encodeURIComponent(service)}` +
      `?scope=${encodeURIComponent(scope)}`
    await this.req<{ ok: boolean; deleted: boolean; scope: CredentialScope }>(path, { method: 'DELETE' })
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
      throw new CredentialsClientError(
        'network',
        err instanceof Error ? err.message : 'network error',
        0,
      )
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
      throw new CredentialsClientError(code, message, res.status)
    }
    return json as T
  }
}
