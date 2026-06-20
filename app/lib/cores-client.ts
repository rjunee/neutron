/**
 * @neutronai/app — Cores admin + OAuth API client.
 *
 * Wraps the per-instance gateway's `/api/cores[/<slug>]` read surface +
 * `/api/cores/install` + `/api/cores/uninstall` + the Cores OAuth
 * routes at `/api/cores/oauth/google/*`. Mirrors the
 * `AdminClient` shape from `admin-client.ts`.
 *
 * Cross-ref: `gateway/http/cores-surface.ts` +
 * `gateway/http/cores-oauth-surface.ts`.
 */

export type CoreInstallState =
  | 'installed'
  | 'failed'
  | 'not_installed'
  | 'install_failed_runtime'
  | 'install_failed_dependency_missing';

export interface CoreTool {
  name: string;
  description: string;
  capability_required: string;
}

export interface CoreUIComponent {
  name: string;
  entry_point: string;
  surface: string;
  mount_path?: string;
}

export interface CoreSummary {
  slug: string;
  package_name: string;
  package_version: string;
  source: 'bundled';
  root_dir: string;
  display_name: string;
  description: string;
  capabilities: string[];
  tools: CoreTool[];
  ui_components: CoreUIComponent[];
  required_oauth_labels: string[];
  install_state: CoreInstallState;
  install_error?: { code: string; message: string };
}

export interface CoresListResponse {
  ok: boolean;
  cores: CoreSummary[];
}

export interface OAuthStatusLabel {
  label: string;
  connected: boolean;
  scopes: string[];
  email: string | null;
  connected_at: number | null;
  last_refresh_at: number | null;
  last_refresh_outcome: 'ok' | 'invalid_grant' | 'error' | null;
  expires_at: number | null;
}

export interface OAuthStatusResponse {
  ok: boolean;
  google: {
    connected: boolean;
    labels: OAuthStatusLabel[];
  };
}

export interface OAuthStartResponse {
  ok: boolean;
  authorize_url: string;
  state: string;
  expires_at: number;
}

export interface OAuthDisconnectResponse {
  ok: boolean;
  disconnected: string[];
  affected_cores: string[];
}

export class CoresClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`);
    this.name = 'CoresClientError';
    this.code = code;
    this.status = status;
  }
}

export interface CoresClientOptions {
  base_url: string;
  token: string;
}

export class CoresClient {
  private readonly base_url: string;
  private readonly token: string;

  constructor(opts: CoresClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  async list(): Promise<CoreSummary[]> {
    const res = await this.req<CoresListResponse>('/api/cores');
    return res.cores;
  }

  async install(slug: string): Promise<void> {
    await this.req('/api/cores/install', { method: 'POST', body: { slug } });
  }

  async uninstall(slug: string): Promise<void> {
    await this.req('/api/cores/uninstall', { method: 'POST', body: { slug } });
  }

  async oauthStatus(): Promise<OAuthStatusResponse['google']> {
    const res = await this.req<OAuthStatusResponse>('/api/cores/oauth/google/status');
    return res.google;
  }

  async oauthStart(labels: string[]): Promise<OAuthStartResponse> {
    const q = encodeURIComponent(labels.join(','));
    const res = await this.req<OAuthStartResponse>(
      `/api/cores/oauth/google/start?labels=${q}`,
    );
    return res;
  }

  async oauthDisconnect(label: string): Promise<OAuthDisconnectResponse> {
    return await this.req<OAuthDisconnectResponse>(
      `/api/cores/oauth/google/disconnect/${encodeURIComponent(label)}`,
      { method: 'POST' },
    );
  }

  private async req<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
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
      const body = json as { code?: string; message?: string } | null;
      const code = body?.code ?? 'request_failed';
      const message = body?.message ?? `HTTP ${res.status}`;
      throw new CoresClientError(code, message, res.status);
    }
    return json as T;
  }
}
