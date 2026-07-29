/**
 * @neutronai/app — admin-personality surface client (2026-05-22).
 *
 * Thin fetch wrapper for the gateway's `/api/app/persona/*` routes
 * (added by docs/plans/2026-05-22-003-feat-admin-personality-editor-plan.md).
 * Mirrors the AdminClient / DocsClient shape: pass the bearer token at
 * construction time; each call returns the canonical server view.
 *
 * Backing surface: `gateway/http/admin-personality-surface.ts`. The four
 * routes are:
 *   - `GET   /api/app/persona/files`
 *   - `GET   /api/app/persona/file?name=<name>`
 *   - `PATCH /api/app/persona/file?name=<name>`
 *   - `POST  /api/app/persona/restart-from-scratch`
 */

export type PersonaFilename = 'SOUL.md' | 'USER.md' | 'priority-map.md';

export const PERSONA_FILENAMES: ReadonlyArray<PersonaFilename> = [
  'SOUL.md',
  'USER.md',
  'priority-map.md',
];

export interface PersonaFileSummary {
  filename: PersonaFilename;
  exists: boolean;
  size_bytes: number;
  /** ISO-8601 mtime; null when the file does not yet exist. */
  last_modified_iso: string | null;
}

export interface PersonaFileBody {
  filename: PersonaFilename;
  /** Raw markdown body. Empty when the file does not yet exist. */
  content: string;
  /** Floor-rounded mtime in milliseconds. 0 when the file does not yet
   *  exist. The client passes this back as `expected_mtime` on the next
   *  PATCH to detect external edits via the surface's 409 conflict path. */
  mtime: number;
}

export interface PersonaSaveResult {
  ok: true;
  mtime: number;
}

export interface PersonaRestartFailure {
  filename: PersonaFilename;
  /** Node.js errno code (e.g. EISDIR, EPERM) or "unknown". */
  code: string;
  message: string;
}

export interface PersonaRestartResult {
  ok: true;
  files_deleted: PersonaFilename[];
  /** Codex r1 P2 fix (2026-05-22): non-ENOENT unlink failures are
   *  reported here so the UI can show a partial-success banner instead
   *  of a green "restart succeeded" lie. Empty when every targeted
   *  file was deleted (or was missing already). */
  files_failed: PersonaRestartFailure[];
  /** True only when the gateway has an `onRestartFromScratch` hook
   *  wired (future onboarding-engine integration). False in M1. */
  onboarding_reset: boolean;
}

export class AdminPersonalityClientError extends Error {
  override readonly name = 'AdminPersonalityClientError';
  /**
   * On 409 `mtime_conflict`, the server's view of the current on-disk
   * mtime. Use this to reload then re-PATCH cleanly.
   */
  readonly current_mtime?: number;
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    extra: { current_mtime?: number } = {},
  ) {
    super(`${code}: ${message}`);
    if (extra.current_mtime !== undefined) this.current_mtime = extra.current_mtime;
  }
}

export interface AdminPersonalityClientOptions {
  base_url: string;
  token: string;
}

export class AdminPersonalityClient {
  private readonly base_url: string;
  private readonly token: string;

  constructor(opts: AdminPersonalityClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  async listFiles(): Promise<PersonaFileSummary[]> {
    const res = await fetch(`${this.base_url}/api/app/persona/files`, {
      headers: this.headers(),
    });
    if (!res.ok) throw await this.toError(res);
    const body = (await res.json()) as { files: PersonaFileSummary[] };
    return body.files;
  }

  async getFile(filename: PersonaFilename): Promise<PersonaFileBody> {
    const res = await fetch(
      `${this.base_url}/api/app/persona/file?name=${encodeURIComponent(filename)}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw await this.toError(res);
    const content = await res.text();
    const mtime = Number(res.headers.get('x-mtime') ?? '0');
    return { filename, content, mtime: Number.isFinite(mtime) ? mtime : 0 };
  }

  async saveFile(input: {
    filename: PersonaFilename;
    content: string;
    /** Pass 0 for a fresh file, the prior body's `mtime` for an
     *  existing file, or -1 to force-overwrite without the mtime guard. */
    expected_mtime: number;
  }): Promise<PersonaSaveResult> {
    const res = await fetch(
      `${this.base_url}/api/app/persona/file?name=${encodeURIComponent(input.filename)}`,
      {
        method: 'PATCH',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          content: input.content,
          expected_mtime: input.expected_mtime,
        }),
      },
    );
    if (!res.ok) throw await this.toError(res);
    const body = (await res.json()) as { ok: true; mtime: number };
    return body;
  }

  async restartFromScratch(): Promise<PersonaRestartResult> {
    const res = await fetch(`${this.base_url}/api/app/persona/restart-from-scratch`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ confirm: true }),
    });
    if (!res.ok) throw await this.toError(res);
    return (await res.json()) as PersonaRestartResult;
  }

  private headers(extra: Record<string, string> = {}): Headers {
    const h = new Headers(extra);
    h.set('authorization', `Bearer ${this.token}`);
    return h;
  }

  private async toError(res: Response): Promise<AdminPersonalityClientError> {
    let code = `http_${res.status}`;
    let message = res.statusText;
    let current_mtime: number | undefined;
    try {
      const body = (await res.json()) as {
        code?: unknown;
        message?: unknown;
        current_mtime?: unknown;
      };
      if (typeof body.code === 'string') code = body.code;
      if (typeof body.message === 'string') message = body.message;
      if (typeof body.current_mtime === 'number') current_mtime = body.current_mtime;
    } catch {
      // non-JSON body — keep statusText
    }
    return new AdminPersonalityClientError(
      res.status,
      code,
      message,
      current_mtime !== undefined ? { current_mtime } : {},
    );
  }
}
