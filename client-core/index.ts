/**
 * @neutronai/client-core — the shared base for the app's gateway HTTP surface
 * clients (W1a, the behaviour-preserving base slice of W1).
 *
 * Every `/api/app/...` surface client (docs / work-board / project-credentials /
 * integrations / backups, in both the web `landing/chat-react` and the RN
 * `app/lib` twins) hand-rolled the SAME request machinery: Bearer-token auth,
 * JSON body + `content-type`, best-effort `res.json()`, a coded throw on a
 * non-2xx, and a `base_url` trailing-slash normalization — plus a per-surface
 * `*ClientError extends Error` that only ever varied by its `name` (and, for
 * docs, one extra `current_modified_at` field). This collapses that duplicated
 * body into one base class + one base error.
 *
 * ── Strictly behaviour-preserving; NO web↔RN convergence ─────────────────────
 * The web and RN twins genuinely DIVERGE in exactly one spot: a web client
 * catches a fetch rejection and rethrows it as a coded `network` error (status
 * 0), while an RN client lets the raw rejection propagate. That single
 * difference is captured by the {@link GatewayHttpClient.guardNetworkErrors}
 * flag — set by the subclass, never the caller — so each twin keeps its exact
 * current behaviour. The named `*ClientError` subclasses stay in their own
 * modules (so `instanceof DocsClientError` and `error.name` are unchanged); they
 * become three-line subclasses of {@link GatewayClientError} instead of
 * re-implementing the code/status/message body.
 *
 * Pure given an injected `fetchImpl`, so it unit-tests without a DOM or a live
 * server — the same convention the surface clients already followed.
 */

/** The injected fetch; defaults to the global `fetch` when omitted. */
export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export interface GatewayHttpClientOptions {
  /** Page origin (`https://host`); every surface lives under `/api/app/...`. */
  base_url: string
  /** App-ws bearer token (`config.token`). */
  token: string
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: FetchImpl
}

/**
 * The one coded client error. Each surface keeps a thin named subclass
 * (`DocsClientError`, `WorkBoardClientError`, …) that only sets its `name` and
 * any extra field, so `instanceof <Surface>ClientError` and `error.name` keep
 * working while the code/status/message construction lives here once.
 */
export class GatewayClientError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`)
    this.name = 'GatewayClientError'
    this.code = code
    this.status = status
  }
}

export class GatewayHttpClient {
  protected readonly base_url: string
  protected readonly token: string
  protected readonly fetchImpl: FetchImpl

  /**
   * Web surfaces catch a fetch rejection and rethrow it as a coded `network`
   * error (status 0); RN surfaces let the raw rejection propagate. This is the
   * ONLY behavioural difference between the two twins' request paths, and it is
   * a subclass concern (NOT a caller-supplied option), so both keep their exact
   * behaviour. Defaults to the RN shape (no guard).
   */
  protected readonly guardNetworkErrors: boolean = false

  constructor(opts: GatewayHttpClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  /**
   * Build a surface error from a non-2xx response (or, when guarded, a fetch
   * rejection). The default is a plain {@link GatewayClientError}; every surface
   * overrides this to return its OWN named subclass (and, for docs, to lift
   * `current_modified_at` off the parsed body). `body` is the parsed JSON error
   * body, or `{}` for a network failure / unparseable body.
   */
  protected makeError(
    code: string,
    message: string,
    status: number,
    _body: Record<string, unknown>,
  ): GatewayClientError {
    return new GatewayClientError(code, message, status)
  }

  /**
   * The shared request path. Adds Bearer auth; on a present body sets
   * `content-type: application/json` and JSON-serializes it; best-effort parses
   * `res.json()` (a non-JSON body leaves the payload `null`); throws a
   * `makeError`-coded error on a non-2xx; otherwise returns the parsed JSON as
   * `T`. Matches every adopting surface byte-for-byte — the sole per-surface
   * variation is {@link guardNetworkErrors}.
   */
  protected async req<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
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
      if (!this.guardNetworkErrors) throw err
      throw this.makeError('network', err instanceof Error ? err.message : 'network error', 0, {})
    }
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      // fall through to the status-coded error below
    }
    if (!res.ok) {
      const errBody = (json ?? {}) as { code?: string; message?: string }
      throw this.makeError(
        errBody.code ?? 'request_failed',
        errBody.message ?? `HTTP ${res.status}`,
        res.status,
        (json ?? {}) as Record<string, unknown>,
      )
    }
    return json as T
  }
}
