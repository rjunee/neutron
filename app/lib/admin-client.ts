/**
 * @neutronai/app — admin surface API client (P5.7).
 *
 * Thin fetch wrapper for the gateway's `/api/app/admin/*` routes.
 * Mirrors the P5.4 `TasksClient` shape: pass the bearer token at
 * construction time; each call returns the canonical server view.
 *
 * Backing surface: `gateway/http/app-admin-surface.ts`. Routes are
 * POST `/gateway/restart`, GET `/memory`, GET `/connectors`, plus
 * the P7.4 Phase 2 `/project-backup/*` family. Personality editing
 * lives on its own surface (`AdminPersonalityClient` at
 * `app/lib/admin-personality-client.ts` ↔ `/api/app/persona/*`); the
 * legacy `/personality` GET + PUT methods and tone/style enums were
 * removed by ISSUE #31 (2026-05-23).
 */

export interface MemoryEntry {
  id: string;
  content_preview: string;
  score: number;
}

export interface MemorySummary {
  configured: boolean;
  stats: { count: number; size_bytes: number } | null;
  entries: MemoryEntry[];
}

export interface Connector {
  slug: string;
  package_name: string;
  package_version: string;
  data_layout: 'tables' | 'sidecar';
  installed_at: number;
  started_at: number | null;
  uninstalled_at: number | null;
  capabilities: string[];
}

export interface ConnectorsSummary {
  configured: boolean;
  connectors: Connector[];
}

export interface GatewayRestartResult {
  triggered: boolean;
  triggered_at: number;
  tier: 'open' | 'managed';
  project_slug: string;
}

/** P7.4 Phase 2 — backup status surface. */
export type ProjectBackupState =
  | 'not_configured'
  | 'configured'
  | 'backing_up'
  | 'ok'
  | 'error';

export type PushFailureKind =
  | 'auth'
  | 'branch_protection'
  | 'remote_not_empty'
  | 'transient'
  | 'unknown';

export interface ProjectBackupStatus {
  state: ProjectBackupState;
  last_backup_at: string | null;
  last_check_at: string | null;
  last_commit_sha: string | null;
  last_push_at: string | null;
  last_push_error: { code: PushFailureKind; message: string } | null;
  remote_url: string | null;
  is_managed_remote: boolean;
  next_scheduled_at: string | null;
}

export interface ProjectBackupResult {
  commit_sha: string | null;
  pushed: boolean;
  push_error: { code: PushFailureKind; message: string } | null;
  completed_at: string;
}

export interface ConfigureProjectBackupInput {
  remote_url: string;
  ssh_key_pem?: string;
  generated_key_request_id?: string;
}

export interface GenerateKeypairResult {
  request_id: string;
  public_key: string;
  expires_at: string;
}

export interface BackupProjectListEntry {
  project_id: string;
}

export interface BackupProjectList {
  configured: boolean;
  projects: BackupProjectListEntry[];
}

/**
 * Switch-Max-account sprint (2026-06-01) — paste URL returned by
 * `POST /api/app/admin/max-oauth/mint-reauth-token`. The Expo client
 * opens this URL via `Linking.openURL`; the user lands on the
 * identity-side paste-token form (already in production), submits a
 * new `claude setup-token` output, and is 302d back to `return_url`
 * (the per-instance chat by default).
 */
export interface MintMaxReauthTokenResult {
  paste_url: string;
}

/**
 * O5 — read-only diagnostics report (`GET /api/app/admin/diagnostics`).
 * Client-side mirror of `gateway/diagnostics/diagnostics-report.ts`
 * `DiagnosticsReport` (the app package cannot import the gateway type — same
 * local-mirror pattern as `MemorySummary`). Every section carries `available`
 * + an optional `note`; in-process-only sections (credentials) are
 * `available: false` when read off-process.
 */
export interface DiagnosticsSection {
  available: boolean;
  note?: string;
}
export interface DiagnosticsReport {
  generated_at: number;
  project_slug: string;
  gbrain: DiagnosticsSection & {
    status?: string;
    latch_reason?: string | null;
    latched_at?: string | null;
    last_success_at?: string | null;
    deferred_count?: number;
    updated_at?: string;
  };
  credentials: DiagnosticsSection & {
    has_usable?: boolean;
    soonest_cooldown_until?: number | null;
  };
  repl_sessions: DiagnosticsSection & {
    registry_path?: string;
    sessions?: Array<{
      key: string;
      session_id?: string;
      channel_name?: string;
      has_session?: boolean;
      pid?: number;
      model?: string;
      age_ms?: number | null;
      respawn_count?: number;
      capped_at?: number | null;
    }>;
  };
  cron_jobs: DiagnosticsSection & {
    jobs?: Array<{
      job_name: string;
      last_run_at?: number | null;
      last_run_status?: string | null;
      last_run_error?: string | null;
    }>;
  };
  import_jobs: DiagnosticsSection & {
    jobs?: Array<{
      job_id: string;
      source?: string;
      status?: string;
      error_code?: string | null;
      error_message?: string | null;
    }>;
  };
  recent_events: DiagnosticsSection & {
    events?: Array<{
      ts?: number;
      level?: string;
      module?: string;
      event?: string;
    }>;
  };
}

export interface AdminClientOptions {
  base_url: string;
  token: string;
}

interface MemoryResponse {
  ok: boolean;
  configured: boolean;
  stats: { count: number; size_bytes: number } | null;
  entries: MemoryEntry[];
}

interface ConnectorsResponse {
  ok: boolean;
  configured: boolean;
  connectors: Connector[];
}

interface RestartResponse {
  ok: boolean;
  triggered: boolean;
  triggered_at: number;
  tier: 'open' | 'managed';
  project_slug: string;
}

export class AdminClient {
  private readonly base_url: string;
  private readonly token: string;

  constructor(opts: AdminClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  async restartGateway(): Promise<GatewayRestartResult> {
    const res = await this.req<RestartResponse>('/api/app/admin/gateway/restart', {
      method: 'POST',
    });
    return {
      triggered: res.triggered,
      triggered_at: res.triggered_at,
      tier: res.tier,
      project_slug: res.project_slug,
    };
  }

  async getMemory(): Promise<MemorySummary> {
    const res = await this.req<MemoryResponse>('/api/app/admin/memory');
    return { configured: res.configured, stats: res.stats, entries: res.entries };
  }

  async getConnectors(): Promise<ConnectorsSummary> {
    const res = await this.req<ConnectorsResponse>('/api/app/admin/connectors');
    return { configured: res.configured, connectors: res.connectors };
  }

  /**
   * O5 — read-only diagnostics. Composes existing per-instance state (gbrain
   * latch, credential-pool health, REPL registry, cron last-fire, import jobs,
   * recent events) so the owner can answer "why is memory / chat / import
   * broken?" from the admin tab. Owner-gated; no writes.
   */
  async getDiagnostics(): Promise<DiagnosticsReport> {
    const res = await this.req<{ ok: boolean; diagnostics?: DiagnosticsReport }>(
      '/api/app/admin/diagnostics',
    );
    // Validate the success envelope — a 200 `{ ok: true }` with a missing /
    // wrong-shaped `diagnostics` must map to a typed error, not resolve to
    // `undefined` and crash the pane on `report.project_slug`.
    const d = res.diagnostics;
    if (d === null || typeof d !== 'object' || typeof d.project_slug !== 'string') {
      throw new AdminClientError(
        'malformed_response',
        'diagnostics response was missing a valid `diagnostics` payload',
        200,
      );
    }
    return d;
  }

  /** P7.4 Phase 2 — list per-project backups for the Backup sub-tab. */
  async listBackupProjects(): Promise<BackupProjectList> {
    const res = await this.req<{
      ok: boolean;
      configured: boolean;
      projects: BackupProjectListEntry[];
    }>('/api/app/admin/project-backup/projects');
    return { configured: res.configured, projects: res.projects };
  }

  /** P7.4 Phase 2 — per-project backup status. */
  async getProjectBackupStatus(project_id: string): Promise<ProjectBackupStatus> {
    const res = await this.req<{ ok: boolean; status: ProjectBackupStatus }>(
      `/api/app/admin/project-backup/${encodeURIComponent(project_id)}/status`,
    );
    return res.status;
  }

  /** P7.4 Phase 2 — configure a remote (Open only). */
  async configureProjectBackup(
    project_id: string,
    input: ConfigureProjectBackupInput,
  ): Promise<{ remote: { remote_url: string; configured_at: string }; backup: ProjectBackupResult }> {
    const res = await this.req<{
      ok: boolean;
      remote: { remote_url: string; configured_at: string };
      backup: ProjectBackupResult;
    }>(
      `/api/app/admin/project-backup/${encodeURIComponent(project_id)}/configure`,
      { method: 'POST', body: input },
    );
    return { remote: res.remote, backup: res.backup };
  }

  /** P7.4 Phase 2 — disconnect a remote (Open only). */
  async disconnectProjectBackupRemote(project_id: string): Promise<void> {
    await this.req<{ ok: boolean; disconnected: boolean }>(
      `/api/app/admin/project-backup/${encodeURIComponent(project_id)}/disconnect-remote`,
      { method: 'POST' },
    );
  }

  /** P7.4 Phase 2 — force a backup right now. */
  async runProjectBackupNow(project_id: string): Promise<ProjectBackupResult> {
    const res = await this.req<{ ok: boolean; backup: ProjectBackupResult }>(
      `/api/app/admin/project-backup/${encodeURIComponent(project_id)}/run-now`,
      { method: 'POST' },
    );
    return res.backup;
  }

  /**
   * Switch-Max-account sprint (2026-06-01) — mint a fresh start_token
   * JWT bound to this instance + the authenticated user, and return
   * the fully-formed identity-side paste-URL the Expo client opens
   * via `Linking.openURL`. The user pastes a new `claude setup-token`
   * value into the existing identity-side form; on success the
   * server's `persistPasteToken` replaces the cached Max credential
   * atomically (no operator SQL).
   *
   * Throws `AdminClientError('reauth_not_configured', ...)` (HTTP 503)
   * when the deployment lacks the identity-DB wiring (Open self-host
   * with NEUTRON_AUTH_DB_PATH unset). The Max-account sub-tab catches
   * that case and renders a "this deployment doesn't support in-app
   * Max swap" notice instead of the Switch button.
   */
  async mintMaxReauthToken(returnUrl?: string): Promise<MintMaxReauthTokenResult> {
    const body: Record<string, unknown> = {};
    if (returnUrl !== undefined) body['return_url'] = returnUrl;
    const res = await this.req<{ ok: boolean; paste_url: string }>(
      '/api/app/admin/max-oauth/mint-reauth-token',
      { method: 'POST', body },
    );
    return { paste_url: res.paste_url };
  }

  /** P7.4 Phase 2 — generate a fresh ED25519 keypair (Open only). */
  async generateProjectBackupKeypair(project_id: string): Promise<GenerateKeypairResult> {
    const res = await this.req<{
      ok: boolean;
      request_id: string;
      public_key: string;
      expires_at: string;
    }>(
      `/api/app/admin/project-backup/${encodeURIComponent(project_id)}/generate-keypair`,
      { method: 'POST' },
    );
    return {
      request_id: res.request_id,
      public_key: res.public_key,
      expires_at: res.expires_at,
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
      const body = (json as { code?: string; message?: string; redirect_hint?: string } | null);
      const code = body?.code ?? 'request_failed';
      const message = body?.message ?? `HTTP ${res.status}`;
      const redirect_hint =
        typeof body?.redirect_hint === 'string' ? body.redirect_hint : null;
      throw new AdminClientError(code, message, res.status, redirect_hint);
    }
    return json as T;
  }
}

export class AdminClientError extends Error {
  readonly code: string;
  readonly status: number;
  /** Server-supplied URL/path the client may surface as a follow-up
   *  action when an endpoint returns a 503 envelope carrying a
   *  `redirect_hint` (relative against `base_url`, or absolute as-is). */
  readonly redirect_hint: string | null;
  constructor(code: string, message: string, status: number, redirect_hint: string | null = null) {
    super(`${code}: ${message}`);
    this.name = 'AdminClientError';
    this.code = code;
    this.status = status;
    this.redirect_hint = redirect_hint;
  }
}

