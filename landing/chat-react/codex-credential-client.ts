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

export interface CodexStatus {
  status: CodexConnectionStatus
  materialized?: boolean
  expires_at?: string
  detail?: string
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

  private path(project_id: string): string {
    return `/api/app/projects/${encodeURIComponent(project_id)}/codex-auth`
  }

  /** Current connection status. */
  async status(project_id: string): Promise<CodexStatus> {
    return this.req<CodexStatus>(this.path(project_id))
  }

  /** Connect by pasting a ChatGPT-subscription auth.json. Throws on a metered key. */
  async connect(project_id: string, auth: string): Promise<CodexStatus> {
    return this.req<CodexStatus>(this.path(project_id), { method: 'POST', body: { auth } })
  }

  /** Disconnect (delete the stored credential + materialized auth.json). */
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
