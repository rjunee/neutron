/**
 * @neutronai/app — Neutron Connect member-management API client (M2.6 Ph5).
 *
 * Thin fetch wrapper for the gateway's cross-org "Connect" surface:
 *   - GET  `/api/app/projects/<id>/connect-members`
 *   - POST `/api/app/projects/<id>/connect-invites`
 *   - POST `/api/app/projects/<id>/connect-members/<local_slug>/revoke`
 *
 * Mirrors `lib/projects-client.ts`: pass the bearer at construction; each
 * call returns the canonical server view (server is authoritative) or
 * throws a typed `ConnectMembersClientError` carrying the server `code`
 * so the drawer can surface the precise failure (e.g.
 * `connect_not_configured`, `workspace_unavailable`, `not_group`).
 *
 * Connect membership is distinct from the local `ProjectMember`
 * roster: a connected member belongs to a *different* org and is
 * identified by their `local_slug` (the alias the owner's workspace
 * assigns them), not a `user_id`.
 */

/** The member's role in the meeting point. ONE owner per project; everyone else
 *  is a `collaborator`, regardless of hosting shape. Display-only — nothing gates
 *  on it (the capability axis is `access` ∈ read|write, server-side). */
export type ConnectMemberRole = 'owner' | 'collaborator';
export type ConnectMemberStatus = 'pending' | 'active' | 'revoked';

/** A single cross-org member as the gateway projects it for the drawer. */
export interface ConnectMemberView {
  local_slug: string;
  display_name: string;
  role: ConnectMemberRole;
  status: ConnectMemberStatus;
}

/** How the owner delivers a collaborator invite. A DELIVERY METHOD, not a tier —
 *  both land the same `role='collaborator'`. `link` works for anyone (connect-node
 *  token handshake); `email` enables OAuth auto-accept for a Managed invitee on
 *  another instance. Scope applies to both. */
export type ConnectInviteDelivery = 'link' | 'email';
export type ConnectInviteScope = 'write' | 'read';

export interface IssueInviteInput {
  /** Defaults to 'link' when omitted. */
  delivery?: ConnectInviteDelivery;
  scope?: ConnectInviteScope;
  ttl_ms?: number;
  /** Required for `delivery:'email'`. */
  invitee_email?: string;
}

/** Shared shape of a minted invite — both deliveries carry an accept link. */
interface ConnectInviteBase {
  accept_url: string;
  expires_at_ms: number;
  scope: ConnectInviteScope;
  project_id: string;
}

export interface LinkInviteResult extends ConnectInviteBase {
  delivery: 'link';
}

export interface EmailInviteResult extends ConnectInviteBase {
  delivery: 'email';
  /** Signed-token id — only the email delivery mints one. */
  jti: string;
}

export type ConnectInviteResult = LinkInviteResult | EmailInviteResult;

export interface RevokeMemberResult {
  revoked: boolean;
  project_id: string;
  local_slug: string;
}

export interface ConnectMembersClientOptions {
  base_url: string;
  token: string;
}

interface ListMembersResponse {
  ok: boolean;
  members: ConnectMemberView[];
  project_id: string;
}

type IssueInviteResponse =
  | ({ ok: boolean } & LinkInviteResult)
  | ({ ok: boolean } & EmailInviteResult);

interface RevokeMemberResponse {
  ok: boolean;
  revoked: boolean;
  project_id: string;
  local_slug: string;
}

export interface ConnectMembersClientErrorInit {
  code: string;
  message: string;
  status: number;
}

export class ConnectMembersClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(init: ConnectMembersClientErrorInit) {
    super(`${init.code}: ${init.message}`);
    this.name = 'ConnectMembersClientError';
    this.code = init.code;
    this.status = init.status;
  }
}

export class ConnectMembersClient {
  private readonly base_url: string;
  private readonly token: string;

  constructor(opts: ConnectMembersClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  /**
   * List every cross-org member connected to `project_id`. The owner's
   * own trust class (`owner`) is included so the roster reads top-to-bottom
   * as "you + everyone you've shared with". Throws on any non-2xx — most
   * notably `connect_not_configured` (501) when the deployment hasn't
   * enabled Connect — so the caller renders the honest reason.
   */
  async listMembers(project_id: string): Promise<ConnectMemberView[]> {
    const res = await this.req<ListMembersResponse>(
      `/api/app/projects/${encodeURIComponent(project_id)}/connect-members`,
    );
    return res.members;
  }

  /**
   * Mint a collaborator invite for `project_id`. A `link` delivery returns a
   * bare accept link; an `email` delivery additionally returns a `jti` (and may
   * fail 409 `workspace_unavailable` when no signing key is configured — surfaced
   * as a typed error). Delivery defaults to `link`. Both deliveries land the same
   * `role='collaborator'` — delivery is a method, not a tier. Scope defaults to
   * the server's choice when omitted.
   */
  async issueInvite(
    project_id: string,
    input: IssueInviteInput,
  ): Promise<ConnectInviteResult> {
    const body: Record<string, unknown> = { delivery: input.delivery ?? 'link' };
    if (input.scope !== undefined) body.scope = input.scope;
    if (input.ttl_ms !== undefined) body.ttl_ms = input.ttl_ms;
    if (input.invitee_email !== undefined) body.invitee_email = input.invitee_email;
    const res = await this.req<IssueInviteResponse>(
      `/api/app/projects/${encodeURIComponent(project_id)}/connect-invites`,
      { method: 'POST', body },
    );
    if (res.delivery === 'email') {
      return {
        delivery: 'email',
        accept_url: res.accept_url,
        jti: res.jti,
        expires_at_ms: res.expires_at_ms,
        scope: res.scope,
        project_id: res.project_id,
      };
    }
    return {
      delivery: 'link',
      accept_url: res.accept_url,
      expires_at_ms: res.expires_at_ms,
      scope: res.scope,
      project_id: res.project_id,
    };
  }

  /**
   * Revoke a connected member's access by their `local_slug`. OWNER-ONLY
   * (§ 11 LOCK) — the gateway returns 403 for anyone else. Resolves with
   * `revoked` (false when the member was already revoked / not found in a
   * revocable state, per the server's idempotent contract).
   */
  async revokeMember(
    project_id: string,
    local_slug: string,
  ): Promise<RevokeMemberResult> {
    const res = await this.req<RevokeMemberResponse>(
      `/api/app/projects/${encodeURIComponent(project_id)}/connect-members/${encodeURIComponent(
        local_slug,
      )}/revoke`,
      { method: 'POST' },
    );
    return {
      revoked: res.revoked,
      project_id: res.project_id,
      local_slug: res.local_slug,
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
      throw new ConnectMembersClientError({
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
      const errBody = json as { code?: string; message?: string } | null;
      const code = errBody?.code ?? defaultCodeForStatus(res.status);
      const message = errBody?.message ?? `HTTP ${res.status}`;
      throw new ConnectMembersClientError({ code, message, status: res.status });
    }
    return json as T;
  }
}

function defaultCodeForStatus(status: number): string {
  if (status === 401) return 'missing_bearer';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 400) return 'invalid_request';
  if (status === 409) return 'conflict';
  if (status === 501) return 'connect_not_configured';
  return 'request_failed';
}
