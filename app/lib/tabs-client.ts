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

// L6 — the `TabDescriptor` wire shape (+ `TabScope` / `TabSource` /
// `TabMountKind` / `TabMount`) is owned by the node-free
// `@neutronai/wire-types` leaf. This client used to re-declare it BY HAND (a
// comment-only mirror of `tabs/registry.ts`); it now imports + re-exports the
// ONE source, so the mirror-parity test is a plain import-and-use contract.
import type { TabDescriptor } from '@neutronai/wire-types';
import { httpProjectSegmentEncoded } from './general-scope';

export type {
  TabDescriptor,
  TabMount,
  TabMountKind,
  TabScope,
  TabSource,
} from '@neutronai/wire-types';

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

  /**
   * Resolve the ordered project-scope tab descriptors for one project.
   *
   * The id goes through `general-scope.ts` because the mobile rail spells the
   * General scope `'~general'`, which is deliberately outside the gateway's
   * project-id alphabet. Sending it raw 400'd, and the layout SWALLOWS a failed
   * tabs fetch by design ("whatever this scope already had stands") — so General
   * silently kept the PRE-FETCH loading default forever: the legacy
   * Chat/Apps/Tasks/Reminders/Docs/Settings set, no Work tab, Docs in fifth
   * place. It read as a tab-ORDER bug on device and was a failed fetch.
   *
   * The tabs surface resolves `'general'` like any other id — `resolveProjectTabs`
   * is a pure resolver over builtins ∪ Core contributions and never consults a
   * project row — so General now gets the same set every project does:
   * Chat / Work / Documents / Apps / Settings.
   */
  async listProjectTabs(project_id: string): Promise<TabDescriptor[]> {
    const path = `/api/app/projects/${httpProjectSegmentEncoded(project_id)}/tabs`;
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
