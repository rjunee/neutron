/**
 * landing/chat-react — web CODEX CONNECT API client (Settings tab, Part B).
 *
 * A thin fetch wrapper over the gateway's Connect Codex surface
 * (`gateway/http/codex-credential-surface.ts`), which stores the owner's ChatGPT
 * SUBSCRIPTION auth for the trident cross-model reviewer:
 *
 *   GET    /api/app/projects/<id>/codex-auth     connection status
 *   POST   /api/app/projects/<id>/codex-auth     connect ({ auth })
 *   DELETE /api/app/projects/<id>/codex-auth     disconnect
 *
 * The POST body carries the pasted `~/.codex/auth.json`. A metered OPENAI_API_KEY
 * comes back as a 400 `metered_key` (surfaced to the user as guidance); a good
 * subscription bundle returns `{ status: 'connected' }`. Write-only: the stored
 * tokens are never returned — only the status.
 *
 * Wire shapes are re-declared here (not imported across the workspace boundary)
 * so the browser bundle stays free of a gateway dependency, mirroring
 * `project-credentials-client.ts`.
 */

export type CodexConnectionStatus = 'connected' | 'expired' | 'not_connected'

export type CodexScope = 'project' | 'global'

export interface CodexStatus {
  status: CodexConnectionStatus
  materialized?: boolean
  expires_at?: string
  detail?: string
  /** Which scope supplied the resolved credential (project override vs global
   *  default), or null when unset. Present on the effective-status responses. */
  scope?: CodexScope | null
  /** Whether a project-scoped OVERRIDE row exists for the queried project —
   *  including an expired one the resolver skipped. Lets the Settings UI always
   *  offer to remove a stale override. Only on per-project status responses. */
  override_present?: boolean
}

interface ErrorBody {
  ok?: boolean
  code?: string
  message?: string
}

export class CodexClientError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`)
    this.name = 'CodexClientError'
    this.code = code
    this.status = status
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export interface CodexClientOptions {
  base_url: string
  token: string
  fetchImpl?: FetchImpl
}

export class WebCodexCredentialClient {
  private readonly base_url: string
  private readonly token: string
  private readonly fetchImpl: FetchImpl

  constructor(opts: CodexClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  /** The GLOBAL (account-wide) route — the primary Connect Codex surface. */
  private readonly globalPath = '/api/app/codex-auth'

  private path(project_id: string): string {
    return `/api/app/projects/${encodeURIComponent(project_id)}/codex-auth`
  }

  // ── GLOBAL (primary — General admin UI) ──

  /** Global connection status (the trident-wide default). */
  async statusGlobal(): Promise<CodexStatus> {
    return this.req<CodexStatus>(this.globalPath)
  }

  /** Connect the GLOBAL Codex subscription. Throws on a metered key. */
  async connectGlobal(auth: string): Promise<CodexStatus> {
    return this.req<CodexStatus>(this.globalPath, { method: 'POST', body: { auth } })
  }

  /** Disconnect the GLOBAL Codex subscription. */
  async disconnectGlobal(): Promise<void> {
    await this.req<{ ok: boolean }>(this.globalPath, { method: 'DELETE' })
  }

  // ── PROJECT OVERRIDE (optional — per-project Settings) ──

  /** Effective status for a project (project override → global default). */
  async status(project_id: string): Promise<CodexStatus> {
    return this.req<CodexStatus>(this.path(project_id))
  }

  /** Connect a per-project OVERRIDE subscription. Throws on a metered key. */
  async connect(project_id: string, auth: string): Promise<CodexStatus> {
    return this.req<CodexStatus>(this.path(project_id), { method: 'POST', body: { auth } })
  }

  /** Remove a project's OVERRIDE (the global default stays). */
  async disconnect(project_id: string): Promise<void> {
    await this.req<{ ok: boolean }>(this.path(project_id), { method: 'DELETE' })
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
      throw new CodexClientError('network', err instanceof Error ? err.message : 'network error', 0)
    }
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      /* fall through to the status-coded error */
    }
    if (!res.ok) {
      const errBody = (json ?? {}) as ErrorBody
      throw new CodexClientError(errBody.code ?? 'request_failed', errBody.message ?? `HTTP ${res.status}`, res.status)
    }
    return json as T
  }
}
