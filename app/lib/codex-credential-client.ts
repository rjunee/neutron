/**
 * @neutronai/app — CODEX connect API client (mobile).
 *
 * WHY THIS EXISTS. The gateway's Codex surface is explicitly app-scoped —
 * `/api/app/codex-auth` — and the web client has talked to it since it was built.
 * The MOBILE app never did: there was no client and no screen, so an owner holding
 * only a phone could not connect the cross-model reviewer at all. The reference
 * deployment works solely because provisioning wrote the credential onto the
 * filesystem directly, which is not a thing any self-hoster can do.
 *
 *   GET    /api/app/codex-auth                  status + every connected seat
 *   POST   /api/app/codex-auth                  connect ({ auth, account? })
 *   DELETE /api/app/codex-auth                  disconnect EVERY seat
 *   DELETE /api/app/codex-auth?account=<slot>   disconnect ONE seat
 *
 * SEATS, NOT ONE ACCOUNT. The owner may connect several ChatGPT subscriptions and
 * trident rotates between them per run, so the phone has to be able to see which
 * seats exist, add another, and remove one — a seat the owner cannot see or manage
 * is not a shipped feature. `account` is optional everywhere: omitting it means the
 * first seat, which is exactly what a pre-rotation client sends.
 *
 * GLOBAL ROUTES ONLY, deliberately. The per-project override is an advanced escape
 * hatch the web Settings tab already offers; putting it on a phone would mean
 * explaining project→global resolution precedence on a 6-inch screen to solve a
 * problem nobody has yet.
 *
 * WRITE-ONLY. The stored tokens are never returned by the surface — only a status.
 * Nothing here logs the pasted bundle, and it is never put into component state
 * beyond the input the owner is typing into.
 *
 * Wire shapes are re-declared rather than imported across the workspace boundary,
 * the same convention `project-credentials-client.ts` follows: the app bundle stays
 * free of any gateway dependency.
 */

/**
 * `revoked` — the server refused a token that has NOT expired (the same ChatGPT
 * account signed in elsewhere and rotated the refresh token). It is deliberately
 * distinct from `expired`: only a reconnect clears it, so a pane that folded the
 * two together would tell the owner to wait for a refresh that can never come.
 */
export type CodexConnectionStatus = 'connected' | 'expired' | 'revoked' | 'not_connected';

/** One connected seat, as the owner sees it. Never carries token material. */
export interface CodexAccount {
  slot: string;
  label: string | null;
  status: CodexConnectionStatus;
  /** Cooling seats are skipped by rotation until `cooling_until` passes. */
  cooling: boolean;
  cooling_until: number | null;
  cooling_reason: string | null;
  used_percent: number | null;
  window_minutes: number | null;
  plan_type: string | null;
  /** Whether this is the seat the next run will use. */
  active: boolean;
}

export interface CodexStatus {
  status: CodexConnectionStatus;
  /** Whether the credential has been written to disk for the reviewer to use. */
  materialized?: boolean;
  expires_at?: string;
  detail?: string;
  /** Every connected seat. Absent from a pre-rotation server, hence optional. */
  accounts?: CodexAccount[];
  /** The seat the next run will use. */
  next?: string | null;
  /** Every seat is cooling — runs continue on a capped seat rather than none. */
  exhausted?: boolean;
}

export class CodexClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'CodexClientError';
    this.code = code;
    this.status = status;
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface CodexCredentialClientOptions {
  base_url: string;
  token: string;
  /** Injected for tests. */
  fetchImpl?: FetchImpl;
}

const PATH = '/api/app/codex-auth';

export class CodexCredentialClient {
  private readonly base_url: string;
  private readonly token: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: CodexCredentialClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Account-wide connection status. */
  async status(): Promise<CodexStatus> {
    return await this.req<CodexStatus>('GET');
  }

  /**
   * Connect by handing over a pasted `~/.codex/auth.json`.
   *
   * A metered `OPENAI_API_KEY` bundle comes back as a 400 the caller is expected to
   * SHOW rather than swallow: it means "this is the wrong kind of credential", and
   * an owner who pasted the wrong file needs to be told which one to paste instead.
   */
  async connect(auth: string, account?: string): Promise<CodexStatus> {
    return await this.req<CodexStatus>(
      'POST',
      account === undefined || account.length === 0 ? { auth } : { auth, account },
    );
  }

  /**
   * Forget EVERY connected seat.
   *
   * Unqualified, because that is what the button says. Removing only the first
   * seat would leave the others stored and still selectable while telling the
   * owner Codex was disconnected.
   */
  async disconnect(): Promise<void> {
    await this.req<{ ok: boolean }>('DELETE');
  }

  /** Forget ONE seat, leaving the rest of the pool connected. */
  async disconnectAccount(account: string): Promise<void> {
    await this.req<{ ok: boolean }>('DELETE', undefined, `?account=${encodeURIComponent(account)}`);
  }

  private async req<T>(method: string, body?: unknown, query = ''): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base_url}${PATH}${query}`, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
      });
    } catch (err) {
      // A network failure is reported as a NAMED error rather than a thrown
      // TypeError, so the screen can say "couldn't reach your server" instead of
      // rendering a fetch internal.
      throw new CodexClientError(
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
      throw new CodexClientError(code, message, res.status);
    }
    return (json ?? {}) as T;
  }
}
