/**
 * @neutronai/app — project-settings API client (P5.2).
 *
 * Thin fetch wrapper for the gateway's
 * `GET` + `PATCH` `/api/app/projects/<id>/settings` surface (P5.2).
 * Mirrors the shape of `lib/tasks-client.ts` / `lib/launcher-client.ts`:
 * pass the bearer token at construction time; each call returns the
 * canonical server view (server is authoritative).
 *
 * PATCH whitelist at P5.2 is `privacy_mode` only — server returns 400
 * `field_not_writable` for any other field. The client surface omits
 * convenience methods for the read-only fields so the API itself
 * encodes the boundary.
 */

// R6 (audit P2-12): collapsed away the legacy `'workspace'` (group-visibility)
// privacy tier + per-seat/group billing values. Single source of truth on
// the app side (app/lib/projects.ts imports `PrivacyMode` from here).
export type PrivacyMode = 'private' | 'public';
export type BillingMode = 'personal';

/**
 * Connect group-chat agent engagement mode. L6: no longer a hand mirror — the
 * vocabulary is owned by `@neutronai/contracts` (L2 leaf, `agent-engagement.ts`)
 * and re-exported by the node-free `@neutronai/wire-types` leaf, which the Expo
 * bundle may import (contracts-band, `app-bundle-purity`-safe). Imported for
 * local use here + re-exported so `app/lib/projects.ts` + the settings UI keep
 * resolving it from this module.
 */
import type { AgentEngagementMode } from '@neutronai/wire-types';
export type { AgentEngagementMode } from '@neutronai/wire-types';

export const ALL_PRIVACY_MODES: readonly PrivacyMode[] = ['private', 'public'];

export const ALL_BILLING_MODES: readonly BillingMode[] = ['personal'];

export interface ProjectMember {
  user_id: string;
  name: string;
  role: 'owner' | 'member';
}

export interface ProjectSettings {
  id: string;
  name: string;
  description: string;
  persona: string;
  /** Short glyph shown on the project rail/card. Always a non-empty glyph
   *  server-side; the client defaults it when an older gateway omits it. */
  emoji: string;
  privacy_mode: PrivacyMode;
  billing_mode: BillingMode;
  agent_engagement_mode: AgentEngagementMode;
  members: ProjectMember[];
}

export interface ProjectsClientOptions {
  base_url: string;
  token: string;
}

interface SettingsResponse {
  ok: boolean;
  project: ProjectSettings;
}

/** M2.3 unified-list discriminator — see gateway
 *  `app-projects-surface.ts` `ProjectOrigin`. */
export type ProjectOrigin = 'solo' | 'shared';

/** A row in the unified project list: the owner's solo projects
 *  plus every group project from the workspaces the user belongs to. */
export interface ProjectListItem extends ProjectSettings {
  kind: ProjectOrigin;
  origin_instance: string;
  owning_instance_slug: string;
  /** ISO-8601 wall-clock of the last activity on this project. '' when the
   *  server can't determine one (older gateway / never touched). */
  last_activity_at: string;
  /** Count of unread items for the bearer-resolved user. 0 when caught up. */
  unread_count: number;
}

/** Per-workspace fan-out failure — surfaced as a non-blocking notice. */
export interface ProjectSourceError {
  workspace_instance_slug: string;
  error: string;
}

interface ListResponse {
  ok: boolean;
  projects: ProjectListItem[];
  project_slug: string;
  /** Optional for back-compat: a pre-M2.3 / local-only gateway omits it. */
  source_errors?: ProjectSourceError[];
}

/** Result of `POST /api/app/projects` (Create Project). */
interface CreateResponse {
  ok: boolean;
  project: { id: string; label: string };
  /** true on a fresh create, false when an existing project was resolved. */
  created?: boolean;
}

/** Result of `ProjectsClient.list()` — the unified list plus any
 *  per-workspace failures the caller renders as "unavailable". */
export interface ProjectListResult {
  projects: ProjectListItem[];
  source_errors: ProjectSourceError[];
}

/** Result of `POST /api/app/projects/<id>/invite` (M2.4). */
export interface InviteGenerateResult {
  invite_url: string;
  jti: string;
  expires_at_ms: number;
}

interface InviteGenerateResponse {
  ok: boolean;
  invite_url: string;
  jti: string;
  expires_at_ms: number;
}

export interface ProjectsClientErrorInit {
  code: string;
  message: string;
  status: number;
  /** Server-supplied field name for `field_not_writable`-style errors. */
  field?: string | null;
}

export class ProjectsClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly field: string | null;
  constructor(init: ProjectsClientErrorInit) {
    super(`${init.code}: ${init.message}`);
    this.name = 'ProjectsClientError';
    this.code = init.code;
    this.status = init.status;
    this.field = init.field ?? null;
  }
}

export class ProjectsClient {
  private readonly base_url: string;
  private readonly token: string;

  constructor(opts: ProjectsClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  async getSettings(project_id: string): Promise<ProjectSettings> {
    const res = await this.req<SettingsResponse>(
      `/api/app/projects/${encodeURIComponent(project_id)}/settings`,
    );
    return res.project;
  }

  async patchPrivacy(
    project_id: string,
    privacy_mode: PrivacyMode,
  ): Promise<ProjectSettings> {
    const res = await this.req<SettingsResponse>(
      `/api/app/projects/${encodeURIComponent(project_id)}/settings`,
      { method: 'PATCH', body: { privacy_mode } },
    );
    return res.project;
  }

  /**
   * Rename a project via the settings PATCH surface (`{ name }`) — the Settings
   * tab's editable project name. Returns the canonical settings after the
   * write. Throws `ProjectsClientError` (e.g. `invalid_name`,
   * `field_not_writable`) so the caller can surface the precise reason.
   */
  async rename(project_id: string, name: string): Promise<ProjectSettings> {
    const res = await this.req<SettingsResponse>(
      `/api/app/projects/${encodeURIComponent(project_id)}/settings`,
      { method: 'PATCH', body: { name } },
    );
    return res.project;
  }

  /**
   * Set the project's rail emoji via the settings PATCH surface (`{ emoji }`).
   * Returns the canonical settings after the write. Throws
   * `ProjectsClientError` (e.g. `invalid_emoji`, `field_not_writable`) so the
   * caller can surface the precise reason.
   */
  async setEmoji(project_id: string, emoji: string): Promise<ProjectSettings> {
    const res = await this.req<SettingsResponse>(
      `/api/app/projects/${encodeURIComponent(project_id)}/settings`,
      { method: 'PATCH', body: { emoji } },
    );
    return res.project;
  }

  /**
   * List every project visible to the bearer-resolved user — the M2.3
   * unified list: the owner's solo projects merged with every
   * group project from the workspaces the user belongs to. Each item
   * carries its `kind` (`solo`/`shared`) + `origin_instance`. Per-workspace
   * fan-out failures come back in `source_errors` (non-fatal — the rest
   * of the list still renders).
   */
  async list(): Promise<ProjectListResult> {
    const res = await this.req<ListResponse>('/api/app/projects');
    return {
      projects: res.projects,
      source_errors: res.source_errors ?? [],
    };
  }

  /**
   * Generate a single-use invite link for `project_id`, bound to
   * `invitee_email` (M2.4). The caller must be the project owner/admin
   * — the gateway returns 403 otherwise. Throws `ProjectsClientError`
   * on any non-2xx (e.g. `not_group`, `workspace_unavailable`,
   * `invalid_email`) so the modal can surface the precise reason.
   */
  async generateInvite(
    project_id: string,
    invitee_email: string,
  ): Promise<InviteGenerateResult> {
    const res = await this.req<InviteGenerateResponse>(
      `/api/app/projects/${encodeURIComponent(project_id)}/invite`,
      { method: 'POST', body: { invitee_email } },
    );
    return {
      invite_url: res.invite_url,
      jti: res.jti,
      expires_at_ms: res.expires_at_ms,
    };
  }

  /**
   * Create a new project from `name` (the project-rail / list "Create Project"
   * affordance). POSTs `{ name }` to `/api/app/projects`; the gateway creates
   * the row + topic + materialized scaffold and returns the new project's id +
   * label. Idempotent on the name (an existing project resolves with
   * `created:false`). Throws `ProjectsClientError` on any non-2xx (e.g.
   * `invalid_name`, `create_not_configured`).
   */
  async create(name: string): Promise<{ id: string; label: string; created: boolean }> {
    const res = await this.req<CreateResponse>('/api/app/projects', {
      method: 'POST',
      body: { name },
    });
    return {
      id: res.project.id,
      label: res.project.label,
      created: res.created ?? false,
    };
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
    let res: Response;
    try {
      res = await fetch(`${this.base_url}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
    } catch (err) {
      throw new ProjectsClientError({
        code: 'network',
        message: err instanceof Error ? err.message : 'network error',
        status: 0,
      });
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // status-coded error below
    }
    if (!res.ok) {
      const errBody = json as
        | { code?: string; message?: string; field?: string }
        | null;
      const code = errBody?.code ?? defaultCodeForStatus(res.status);
      const message = errBody?.message ?? `HTTP ${res.status}`;
      throw new ProjectsClientError({
        code,
        message,
        status: res.status,
        field: errBody?.field ?? null,
      });
    }
    return json as T;
  }
}

function defaultCodeForStatus(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 400) return 'bad_request';
  return 'request_failed';
}
