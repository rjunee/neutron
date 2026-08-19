/**
 * @neutronai/app — GITHUB CONNECT API client (mobile, device flow).
 *
 * The gateway's GitHub connect surface (`gateway/http/github-connect-surface.ts`)
 * stores the OWNER's GitHub token so a build can push a branch and open a pull
 * request. It is app-scoped — `/api/app/github-auth` — and until now NO client
 * called it, on any surface, so the flow could not be started by a human at all.
 *
 *   GET  /api/app/github-auth   what the state is right now
 *   POST /api/app/github-auth   start (or re-show) a device flow
 *
 * WHY TWO CALLS AND NOT ONE. Device flow cannot complete inside a request: the
 * server asks GitHub for a code, the OWNER types it into a browser, and only then
 * does polling succeed. So POST answers immediately with the short `user_code` to
 * type plus the `verification_uri` to type it at, and GET is what the screen polls
 * until the answer turns into `connected`. On a phone this is the good shape: the
 * code is read here and entered wherever the owner has a keyboard.
 *
 * WHAT NEVER COMES BACK. The `device_code` (the bearer half of the exchange) and
 * the token itself never leave the gateway module — the wire type below is the
 * whole contract, and there is deliberately no field here to hold either.
 *
 * Wire shapes are re-declared rather than imported across the workspace boundary,
 * the same convention `codex-credential-client.ts` follows: the app bundle stays
 * free of any gateway dependency.
 */

/** The three states the surface reports. Mirrors the gateway response contract. */
export type GitHubConnectState =
  | { status: 'connected' }
  | {
      status: 'awaiting_owner';
      /** The short code the owner types at `verification_uri`. Safe to display. */
      user_code: string;
      verification_uri: string;
      expires_in_seconds: number;
    }
  | { status: 'not_connected' };

export class GitHubConnectError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'GitHubConnectError';
    this.code = code;
    this.status = status;
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubConnectClientOptions {
  base_url: string;
  token: string;
  /** Injected for tests. */
  fetchImpl?: FetchImpl;
}

const PATH = '/api/app/github-auth';

export class GitHubConnectClient {
  private readonly base_url: string;
  private readonly token: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: GitHubConnectClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Where the flow stands right now. Polled while a code is on screen. */
  async status(): Promise<GitHubConnectState> {
    return await this.req('GET');
  }

  /**
   * Start a device flow. Idempotent by design: a second start while one is live
   * returns the SAME code rather than minting a rival, so a double-press cannot
   * leave the owner approving a code the server stopped polling.
   */
  async start(): Promise<GitHubConnectState> {
    return await this.req('POST');
  }

  private async req(method: string): Promise<GitHubConnectState> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base_url}${PATH}`, {
        method,
        headers: { authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      // A network failure is reported as a NAMED error rather than a thrown
      // TypeError, so the screen can say "couldn't reach your server" instead of
      // rendering a fetch internal.
      throw new GitHubConnectError(
        'network',
        err instanceof Error ? err.message : 'request failed',
        0,
      );
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const code = typeof json?.['code'] === 'string' ? (json['code'] as string) : `http_${res.status}`;
      const message =
        typeof json?.['message'] === 'string'
          ? (json['message'] as string)
          : `request failed (${res.status})`;
      throw new GitHubConnectError(code, message, res.status);
    }
    return (json ?? { status: 'not_connected' }) as GitHubConnectState;
  }
}
