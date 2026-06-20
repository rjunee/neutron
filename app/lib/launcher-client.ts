/**
 * @neutronai/app — project-launcher API client (P5.3).
 *
 * Thin fetch wrapper for the gateway's
 * `/api/app/projects/<project_id>/launcher[*]` surface PLUS the
 * `/api/app/chat/send` build-me entry point. Mirrors the P5.1
 * `AppWsClient` shape: pass the bearer token at construction time,
 * each call returns the post-mutation entry list (server is
 * authoritative).
 *
 * The build-me path lives here (not in a separate "buildMeClient")
 * because the production-composer-reachability guard test
 * (`gateway/__tests__/launcher-production-composer.test.ts`) needs
 * one typed surface to exercise. Argus has caught raw `fetch(...)`
 * calls in the route file three sprints in a row; promoting the
 * call into this client gates that anti-pattern.
 */

export type LauncherIcon =
  | { kind: 'emoji'; value: string }
  | { kind: 'url'; value: string };

/**
 * One row of a launcher tile's long-press action sheet. Mirrors the
 * server-side `LauncherEntryLongPressEntry` in
 * `gateway/http/project-launcher-store.ts` (and ultimately
 * `LauncherIconLongPressEntry` on the manifest). The wire shape is
 * byte-stable across both sides.
 */
export interface LauncherEntryLongPressEntry {
  id: string;
  label: string;
  action: 'open_app_tab' | 'chat_send' | 'chat_send_prefix';
  /** Required when action === 'chat_send_prefix'. */
  prefix?: string;
  /** Required when action === 'chat_send'. */
  text?: string;
}

export interface LauncherEntry {
  slug: string;
  display_name: string;
  launcher_icon: LauncherIcon;
  reorder_index: number;
  /** ISSUE #17 — primary tap-action verb the launcher tile resolves
   *  to. Optional; when omitted the app falls back to slug-derived
   *  default tab path inference. */
  primary_action?: 'open_app_tab' | 'chat_send' | 'chat_send_prefix';
  /** Expo Router path target for `open_app_tab` dispatch. The string
   *  `<project_id>` is substituted at navigation time. */
  app_tab_path?: string;
  /** Ordered list of long-press menu rows. Empty / undefined → the
   *  launcher renders only the legacy Rename / Move / Delete affordances. */
  long_press_menu?: ReadonlyArray<LauncherEntryLongPressEntry>;
}

export interface LauncherClientOptions {
  base_url: string;
  token: string;
}

interface ListResponse {
  ok: boolean;
  entries: LauncherEntry[];
  project_id: string;
  project_slug?: string;
}

export class LauncherClient {
  private readonly base_url: string;
  private readonly token: string;

  constructor(opts: LauncherClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  async list(project_id: string): Promise<LauncherEntry[]> {
    const res = await this.req(`/api/app/projects/${encodeURIComponent(project_id)}/launcher`);
    return res.entries;
  }

  async reorder(
    project_id: string,
    slug: string,
    new_index: number,
  ): Promise<LauncherEntry[]> {
    const res = await this.req(
      `/api/app/projects/${encodeURIComponent(project_id)}/launcher/reorder`,
      { method: 'POST', body: { slug, new_index } },
    );
    return res.entries;
  }

  async uninstall(project_id: string, slug: string): Promise<LauncherEntry[]> {
    const res = await this.req(
      `/api/app/projects/${encodeURIComponent(project_id)}/launcher/uninstall`,
      { method: 'POST', body: { slug } },
    );
    return res.entries;
  }

  async rename(
    project_id: string,
    slug: string,
    display_name: string,
  ): Promise<LauncherEntry[]> {
    const res = await this.req(
      `/api/app/projects/${encodeURIComponent(project_id)}/launcher/rename`,
      { method: 'POST', body: { slug, display_name } },
    );
    return res.entries;
  }

  /**
   * Send a "Build me a Core that …" prompt into the project's chat
   * via `POST /api/app/chat/send`. The prompt is wrapped with the
   * canonical prefix server-side semantics expect ("Build me a Core
   * that ${prompt}"). The build-me agent loop is the existing
   * onboarding/chat agent at P5.3; the real code-gen pipeline lands
   * in P9.
   *
   * Throws `LauncherClientError` on 4xx / 5xx / network errors so
   * the caller can surface the failure inline in the build-me modal.
   */
  async sendBuildMePrompt(input: {
    project_id: string;
    prompt: string;
  }): Promise<void> {
    const body = formatBuildMeBody(input.prompt);
    const path = '/api/app/chat/send';
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
    };
    let res: Response;
    try {
      res = await fetch(`${this.base_url}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body, project_id: input.project_id }),
      });
    } catch (err) {
      throw new LauncherClientError(
        'network',
        err instanceof Error ? err.message : 'network error',
        0,
      );
    }
    if (!res.ok) {
      let code = 'request_failed';
      let message = `HTTP ${res.status}`;
      try {
        const json = (await res.json()) as { code?: string; message?: string } | null;
        if (json !== null && typeof json.code === 'string') code = json.code;
        if (json !== null && typeof json.message === 'string') message = json.message;
      } catch {
        // fall through to status-coded error envelope
      }
      throw new LauncherClientError(code, message, res.status);
    }
  }

  private async req(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<ListResponse> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await fetch(`${this.base_url}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // fall through to status-coded error below
    }
    if (!res.ok) {
      const code = (json as { code?: string } | null)?.code ?? 'request_failed';
      const message =
        (json as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
      throw new LauncherClientError(code, message, res.status);
    }
    return json as ListResponse;
  }
}

export class LauncherClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`);
    this.name = 'LauncherClientError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Wrap the user's "Build me…" prompt in the canonical body shape the
 * chat-send agent expects. Exported for the unit test + as a stable
 * contract so future refactors don't drift the wrapper from the
 * sentinel the agent-side prompt parser keys off.
 */
export function formatBuildMeBody(prompt: string): string {
  return `Build me a Core that ${prompt}`;
}
