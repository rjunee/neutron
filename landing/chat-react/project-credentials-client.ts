/**
 * landing/chat-react — web PROJECT CREDENTIALS API client (Settings tab).
 *
 * A thin fetch wrapper over the gateway's credential surface (bearer-gated,
 * `project-credentials/`), the store the agent's tool calls read their API keys
 * / tokens from. TWO route families, one per scope:
 *
 *   PROJECT (a project's Settings tab)
 *   GET    /api/app/projects/<id>/credentials                 list (own + inherited)
 *   POST   /api/app/projects/<id>/credentials                 set / replace THIS project's
 *   DELETE /api/app/projects/<id>/credentials/<service>       remove THIS project's
 *
 *   GLOBAL (the Admin tab)
 *   GET    /api/app/credentials                               list the global defaults
 *   POST   /api/app/credentials                               set / replace a global default
 *   DELETE /api/app/credentials/<service>                     remove a global default
 *
 * ── Metadata only, never the secret ─────────────────────────────────────────
 * The list route returns credential METADATA (`id`, `service`, `scope`, `label`,
 * timestamps) but NEVER the token value — a set is write-only. The Settings tab
 * therefore renders "a key exists for <service>" affordances, not the secret.
 *
 * ── project vs global scope (ISSUES #486) ───────────────────────────────────
 * A credential is either `project`-scoped (this project only) or `global` (an
 * instance-wide default a project inherits when it has no project-scoped key for
 * that service). The METHOD you call decides which — there is no `scope`
 * argument, because there is no call that can be pointed at the other scope by
 * mistake. `set`/`remove` only ever touch the named project; `setGlobal`/
 * `removeGlobal` only ever touch the instance-wide defaults, and they are the
 * only pair the Admin tab holds. The project `list` still returns the inherited
 * globals so the Settings tab can SHOW them, labelled and read-only.
 *
 * Wire shapes mirror the gateway types but are re-declared here (rather than
 * imported across the workspace boundary) so the browser bundle stays free of a
 * gateway dependency — the same convention `work-board-client.ts` /
 * `docs-client.ts` follow. Pure given an injected `fetchImpl`, so it unit-tests
 * without a DOM or a live server.
 */

import {
  GatewayClientError,
  GatewayHttpClient,
  type GatewayHttpClientOptions,
} from '@neutronai/client-core'

/* ─── wire types (mirror project-credentials/ store rows) ─── */

/** Where a credential lives: this project only, or an instance-wide default. */
export type CredentialScope = 'project' | 'global'

/**
 * One credential row, METADATA only — the token value is never returned by the
 * API (a set is write-only). `label` is an optional human note; `expires_at` is
 * an optional ISO-8601 expiry (null = no expiry).
 */
export interface Rec {
  id: string
  owner_slug: string
  project_id: string
  scope: CredentialScope
  service: string
  label: string | null
  created_at: string
  updated_at: string
  expires_at: string | null
}

/**
 * Input for a set (POST). `token` is the only write-only field. There is NO
 * `scope` here on purpose (ISSUES #486): the method you call is the scope.
 */
export interface SetCredentialInput {
  service: string
  token: string
  label?: string
  expires_at?: string
}

interface ListResponse {
  ok: boolean
  project_id: string
  /** Credentials scoped to this project. */
  project: Rec[]
  /** Instance-wide defaults this project inherits. */
  global: Rec[]
}

interface GlobalListResponse {
  ok: boolean
  global: Rec[]
}
interface SetResponse {
  ok: boolean
  credential: Rec
  project_id: string
}

/* ─── per-project connected-account selection (#500) ─── */

/**
 * One connected account as the project Settings toggles address it. `label` is
 * HUMANISED server-side (the address, or plain English when there is none) —
 * `account_id` is a hex digest and must never be rendered.
 */
export interface AccountSelectionEntry {
  account_id: string
  label: string
  account_email: string | null
  enabled: boolean
}

/** One selectable service and every account connected for it. */
export interface ServiceAccountSelection {
  service: string
  accounts: AccountSelectionEntry[]
}

interface AccountSelectionResponse {
  ok: boolean
  project_id: string
  services: ServiceAccountSelection[]
}

/** The list split by scope, as the Settings tab renders it. */
export interface CredentialList {
  project: Rec[]
  global: Rec[]
}

export class CredentialsClientError extends GatewayClientError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status)
    this.name = 'CredentialsClientError'
  }
}

export type CredentialsClientOptions = GatewayHttpClientOptions

export class WebProjectCredentialsClient extends GatewayHttpClient {
  protected override readonly guardNetworkErrors = true

  protected override makeError(code: string, message: string, status: number): GatewayClientError {
    return new CredentialsClientError(code, message, status)
  }

  /** This project's credentials + the global defaults it inherits (metadata). */
  async list(project_id: string): Promise<CredentialList> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/credentials`
    const res = await this.req<ListResponse>(path)
    return { project: res.project ?? [], global: res.global ?? [] }
  }

  /** Store (or replace) THIS PROJECT's credential for a service. */
  async set(project_id: string, input: SetCredentialInput): Promise<Rec> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/credentials`
    const res = await this.req<SetResponse>(path, { method: 'POST', body: input })
    return res.credential
  }

  /** Remove THIS PROJECT's credential for a service. */
  async remove(project_id: string, service: string): Promise<void> {
    const path =
      `/api/app/projects/${encodeURIComponent(project_id)}/credentials/${encodeURIComponent(service)}`
    await this.req<{ ok: boolean; deleted: string; scope: CredentialScope }>(path, { method: 'DELETE' })
  }

  /** The instance-wide default credentials (metadata) — the Admin tab's list. */
  async listGlobal(): Promise<Rec[]> {
    const res = await this.req<GlobalListResponse>('/api/app/credentials')
    return res.global ?? []
  }

  /** Store (or replace) an instance-wide default credential. Admin tab only. */
  async setGlobal(input: SetCredentialInput): Promise<Rec> {
    const res = await this.req<SetResponse>('/api/app/credentials', { method: 'POST', body: input })
    return res.credential
  }

  /** Remove an instance-wide default credential. Admin tab only. */
  async removeGlobal(service: string): Promise<void> {
    const path = `/api/app/credentials/${encodeURIComponent(service)}`
    await this.req<{ ok: boolean; deleted: string; scope: CredentialScope }>(path, { method: 'DELETE' })
  }

  /**
   * Which connected accounts THIS project reads (#500). Connecting stays
   * global — this only narrows what an already-connected account is used for.
   */
  async listAccounts(project_id: string): Promise<ServiceAccountSelection[]> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/accounts`
    const res = await this.req<AccountSelectionResponse>(path)
    return res.services ?? []
  }

  /**
   * Turn one account on or off for THIS project. Returns the WHOLE refreshed
   * view the server computed, so the caller renders from the server's truth
   * rather than patching a local copy that can drift from it.
   */
  async setAccountEnabled(
    project_id: string,
    input: { service: string; account_id: string; enabled: boolean },
  ): Promise<ServiceAccountSelection[]> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/accounts`
    const res = await this.req<AccountSelectionResponse>(path, { method: 'PUT', body: input })
    return res.services ?? []
  }
}
