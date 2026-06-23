/**
 * @neutronai/app — project TAB RESOLVER client (WAVE 3 PR-3).
 *
 * Thin fetch wrapper for the engine's tab-resolver surface:
 *
 *   GET /api/app/projects/<project_id>/tabs  → ordered project-scope tabs
 *
 * The engine (`tabs/registry.ts` + `gateway/http/app-tabs-surface.ts`) is the
 * SINGLE SOURCE OF TRUTH for which tabs a project renders — builtin
 * Chat/Documents/Tasks UNIONed with the `project_tab` surfaces of Cores
 * installed in the project. The mobile shell consumes this list instead of the
 * old hardcoded `PROJECT_TABS` const. Always on — no feature flag (SPEC
 * Decisions Log, 2026-06-23).
 *
 * Wire shapes mirror the engine types in `tabs/registry.ts` byte-for-byte. We
 * re-declare them here (rather than import across the workspace boundary) so
 * the Expo app stays free of a gateway dependency — the same convention every
 * other `app/lib/*-client.ts` follows.
 *
 * Mirrors the `CoresClient` / `LauncherClient` shape: pass the bearer token at
 * construction time; each call throws `TabsClientError` on 4xx/5xx/network so
 * the caller can fall back to the loading default.
 */

/** Where a tab lives. Mirrors `TabScope` in `tabs/registry.ts`. */
export type TabScope = 'project' | 'global';

/** Who contributes the tab. Mirrors `TabSource` in `tabs/registry.ts`. */
export type TabSource = 'builtin' | 'core' | 'custom';

/** How a client renders the tab body. Mirrors `TabMountKind`. */
export type TabMountKind = 'builtin' | 'webview';

export interface TabMount {
  kind: TabMountKind;
  /** builtin → route/view key (`chat` | `docs` | `tasks`); webview → URL. */
  target: string;
}

/** Engine tab descriptor. Mirrors `TabDescriptor` in `tabs/registry.ts`. */
export interface TabDescriptor {
  key: string;
  label: string;
  scope: TabScope;
  source: TabSource;
  /** Present only when `source === 'core'`. */
  core_slug?: string;
  order: number;
  mount: TabMount;
}

interface ProjectTabsResponse {
  ok: boolean;
  scope: 'project';
  project_id: string;
  tabs: TabDescriptor[];
}

export class TabsClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`);
    this.name = 'TabsClientError';
    this.code = code;
    this.status = status;
  }
}

export interface TabsClientOptions {
  base_url: string;
  token: string;
}

export class TabsClient {
  private readonly base_url: string;
  private readonly token: string;

  constructor(opts: TabsClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  /** Resolve the ordered project-scope tab descriptors for one project. */
  async listProjectTabs(project_id: string): Promise<TabDescriptor[]> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/tabs`;
    let res: Response;
    try {
      res = await fetch(`${this.base_url}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      throw new TabsClientError(
        'network',
        err instanceof Error ? err.message : 'network error',
        0,
      );
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // fall through to the status-coded error below
    }
    if (!res.ok) {
      const body = json as { code?: string; message?: string } | null;
      const code = body?.code ?? 'request_failed';
      const message = body?.message ?? `HTTP ${res.status}`;
      throw new TabsClientError(code, message, res.status);
    }
    const body = json as ProjectTabsResponse | null;
    return body?.tabs ?? [];
  }
}
