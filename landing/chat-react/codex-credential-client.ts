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

/**
 * One connected seat. Mirrors the mobile client's `CodexAccount` because it is the
 * SAME server response — the web type simply never declared the fields, so the web
 * pane could not render a seat list, a cooling state, or a per-seat remove even
 * though the gateway had been sending all three.
 */
export interface CodexAccount {
  slot: string
  label: string | null
  status: CodexConnectionStatus
  /** Cooling seats are skipped by rotation until `cooling_until` passes. */
  cooling: boolean
  cooling_until: number | null
  cooling_reason: string | null
  used_percent: number | null
  window_minutes: number | null
  plan_type: string | null
  /** Whether this is the seat the next run will use. */
  active: boolean
}

export interface CodexStatus {
  status: CodexConnectionStatus
  materialized?: boolean
  expires_at?: string
  detail?: string
  /** Every connected seat. Optional because a pre-rotation server omits it. */
  accounts?: CodexAccount[]
  /** The seat the next run will use. */
  next?: string | null
  /** Every seat is cooling — runs continue on a capped seat rather than none. */
  exhausted?: boolean
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

  /**
   * Connect a Codex subscription. Throws on a metered key.
   *
   * `account` NAMES A SEAT, and omitting it is not neutral: the server resolves an
   * absent account to `DEFAULT_SLOT`, so a paste with no name REPLACES the first
   * seat rather than adding one. This client used to have no way to pass it at all,
   * which meant the web pane could only ever write seat 1 — silently destroying an
   * existing subscription while reporting "connected".
   */
  async connectGlobal(auth: string, account?: string): Promise<CodexStatus> {
    return this.req<CodexStatus>(this.globalPath, {
      method: 'POST',
      body: account === undefined || account.length === 0 ? { auth } : { auth, account },
    })
  }

  /**
   * Forget EVERY connected seat. Unqualified, and named so at the call site.
   *
   * The gateway maps a bare DELETE to `disconnectAllAccounts`. Before rotation that
   * removed one credential and the distinction did not exist; now it is the
   * difference between clearing one seat and destroying every subscription the
   * owner has, none of which he can re-mint without a fresh `codex login` on each
   * original machine. Callers MUST confirm first — see {@link disconnectSeat} for
   * the one-seat form.
   */
  async disconnectAllSeats(): Promise<void> {
    await this.req<{ ok: boolean }>(this.globalPath, { method: 'DELETE' })
  }

  /** Forget ONE seat, leaving the rest of the pool connected. */
  async disconnectSeat(account: string): Promise<void> {
    await this.req<{ ok: boolean }>(
      `${this.globalPath}?account=${encodeURIComponent(account)}`,
      { method: 'DELETE' },
    )
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
