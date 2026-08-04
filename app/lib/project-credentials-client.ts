/**
 * @neutronai/app — project-scoped CREDENTIAL API client (Settings tab).
 *
 * The mobile twin of the gateway's credential surface. A thin fetch wrapper
 * mirroring `lib/work-board-client.ts`, with TWO route families — one per
 * scope, because the route IS the scope (ISSUES #486):
 *
 *   GET    /api/app/projects/<id>/credentials             list (project ∪ global)
 *   POST   /api/app/projects/<id>/credentials             set THIS project's
 *   DELETE /api/app/projects/<id>/credentials/<service>   remove THIS project's
 *
 *   GET    /api/app/credentials                           list the global defaults
 *   POST   /api/app/credentials                           set a global default
 *   DELETE /api/app/credentials/<service>                 remove a global default
 *
 * There is no `scope` argument on any of them. `set`/`remove` can only ever
 * touch the named project; `setGlobal`/`removeGlobal` can only ever touch the
 * instance-wide defaults, and only the Integrations (admin) screen holds them.
 * The project `list` still returns the inherited globals so the Settings screen
 * can SHOW them read-only.
 *
 * Pass the bearer at construction; every call returns the canonical server
 * view (server-authoritative). The list comes back split into the project's
 * OWN credentials and the `global` defaults the project inherits — the screen
 * renders the inherited set read-through and never re-sorts.
 *
 * SECURITY — the wire records are METADATA ONLY. The token value is never
 * returned by the server and this client never carries one back; `set()` sends
 * a token up but nothing hands one down. Do not add a token field to
 * {@link ProjectCredentialRecord}.
 *
 * `fetchImpl` is injectable for unit tests; it defaults to the global `fetch`.
 */

import {
  GatewayClientError,
  GatewayHttpClient,
  type GatewayHttpClientOptions,
} from '@neutronai/client-core';

export type CredentialScope = 'project' | 'global';

/**
 * One stored credential's metadata — the exact server row minus the secret.
 * `scope` says whether it belongs to this project or is a `global` default the
 * project inherits. `expires_at` is null when the credential never expires.
 */
export interface ProjectCredentialRecord {
  id: string;
  owner_slug: string;
  /** The project this row belongs to; a `global` row still carries an owner scope. */
  project_id: string;
  scope: CredentialScope;
  service: string;
  label: string | null;
  created_at: string;
  updated_at: string;
  /** ISO-8601 UTC; null when the credential does not expire. */
  expires_at: string | null;
}

/** The split list a project sees: its own rows + the inherited global defaults. */
export interface ProjectCredentialsList {
  project: ProjectCredentialRecord[];
  global: ProjectCredentialRecord[];
}

/** Input to a write. No `scope` — the method you call is the scope (#486). */
export interface SetCredentialInput {
  service: string;
  /** The secret to store. Sent up on write; never returned on any read. */
  token: string;
  label?: string;
}

export type ProjectCredentialsClientOptions = GatewayHttpClientOptions;

interface ListResponse {
  ok: boolean;
  project_id: string;
  project: ProjectCredentialRecord[];
  global: ProjectCredentialRecord[];
}

interface SetResponse {
  ok: boolean;
  credential: ProjectCredentialRecord;
}

interface GlobalListResponse {
  ok: boolean;
  global: ProjectCredentialRecord[];
}

export class ProjectCredentialsClientError extends GatewayClientError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status);
    this.name = 'ProjectCredentialsClientError';
  }
}

export class ProjectCredentialsClient extends GatewayHttpClient {
  protected override makeError(code: string, message: string, status: number): GatewayClientError {
    return new ProjectCredentialsClientError(code, message, status);
  }

  /** The project's own credentials plus the global defaults it inherits. */
  async list(project_id: string): Promise<ProjectCredentialsList> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/credentials`;
    const res = await this.req<ListResponse>(path);
    return { project: res.project ?? [], global: res.global ?? [] };
  }

  /** Create or rotate THIS PROJECT's credential. Returns the stored metadata. */
  async set(project_id: string, input: SetCredentialInput): Promise<ProjectCredentialRecord> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/credentials`;
    const res = await this.req<SetResponse>(path, { method: 'POST', body: input });
    return res.credential;
  }

  /** Delete THIS PROJECT's credential for `service`. 404 → throws. */
  async remove(project_id: string, service: string): Promise<void> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/credentials/${encodeURIComponent(service)}`;
    await this.req<{ ok: boolean }>(path, { method: 'DELETE' });
  }

  /** The instance-wide default credentials (metadata). Admin screen only. */
  async listGlobal(): Promise<ProjectCredentialRecord[]> {
    const res = await this.req<GlobalListResponse>('/api/app/credentials');
    return res.global ?? [];
  }

  /** Create or rotate an instance-wide default. Admin screen only. */
  async setGlobal(input: SetCredentialInput): Promise<ProjectCredentialRecord> {
    const res = await this.req<SetResponse>('/api/app/credentials', { method: 'POST', body: input });
    return res.credential;
  }

  /** Delete an instance-wide default. Admin screen only. */
  async removeGlobal(service: string): Promise<void> {
    await this.req<{ ok: boolean }>(`/api/app/credentials/${encodeURIComponent(service)}`, {
      method: 'DELETE',
    });
  }
}
