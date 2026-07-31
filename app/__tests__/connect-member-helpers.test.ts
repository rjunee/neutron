/**
 * @neutronai/app — Neutron Connect member-helper unit tests.
 *
 * Covers the pure gating + badge + sort logic (App member UI test #9):
 *   - badge tone/label for owner vs collaborator (two roles only — NO
 *     guest-vs-trusted distinction; hosting shape is an auth mechanism, never a
 *     visible tier),
 *   - canManageConnectMembers (owner/admin yes, member no, NO billing gate),
 *   - canRevokeConnectMember (owner yes; admin + member no — § 11 LOCK),
 *   - the roster sort (revoked last, owner-first grouping, alpha tiebreak),
 * plus the ConnectMembersClient wire shape (method/URL/body) for
 * issueInvite (by-link + by-email delivery) + revokeMember.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import {
  canManageConnectMembers,
  canRevokeConnectMember,
  connectBadge,
  connectMemberSort,
  formatAcceptLinkExpiry,
  outstandingConnectInvites,
} from '../lib/connect-member-helpers';
import {
  ConnectMembersClient,
  ConnectMembersClientError,
  type ConnectMemberView,
} from '../lib/connect-members-client';

describe('connectBadge', () => {
  it('labels a collaborator "Collaborator" with the collaborator tone', () => {
    expect(connectBadge('collaborator')).toEqual({ label: 'Collaborator', tone: 'collaborator' });
  });
  it('gives the owner a plain owner tone', () => {
    expect(connectBadge('owner')).toEqual({ label: 'Owner', tone: 'owner' });
  });
  it('uses two mutually distinct tones across the two roles', () => {
    const tones = new Set([connectBadge('owner').tone, connectBadge('collaborator').tone]);
    expect(tones.size).toBe(2);
  });
});

describe('canManageConnectMembers', () => {
  const owner = { user_id: 'sam', role: 'owner' as const };
  const admin = { user_id: 'admin1', role: 'admin' as const };
  const member = { user_id: 'mem1', role: 'member' as const };

  it('lets the owner manage', () => {
    expect(canManageConnectMembers({ members: [owner] }, 'sam')).toBe(true);
  });
  it('lets an admin manage (owner|admin parity)', () => {
    expect(canManageConnectMembers({ members: [owner, admin] }, 'admin1')).toBe(true);
  });
  it('does NOT gate on a personal project — Connect shares cross-org', () => {
    // canInviteToProject would return false for a personal project; the
    // Connect path explicitly does not, so a personal-project owner CAN
    // manage Connect members.
    expect(
      canManageConnectMembers(
        { members: [owner] } as { members: ReadonlyArray<{ user_id: string; role: 'owner' | 'admin' | 'member' }> },
        'sam',
      ),
    ).toBe(true);
  });
  it('denies a plain member', () => {
    expect(canManageConnectMembers({ members: [owner, member] }, 'mem1')).toBe(false);
  });
  it('denies a non-member and an anonymous (null) user', () => {
    expect(canManageConnectMembers({ members: [owner] }, 'stranger')).toBe(false);
    expect(canManageConnectMembers({ members: [owner] }, null)).toBe(false);
  });
});

describe('canRevokeConnectMember (OWNER-ONLY § 11 LOCK)', () => {
  const owner = { user_id: 'sam', role: 'owner' as const };
  const admin = { user_id: 'admin1', role: 'admin' as const };
  const member = { user_id: 'mem1', role: 'member' as const };

  it('lets the owner revoke', () => {
    expect(canRevokeConnectMember({ members: [owner, admin] }, 'sam')).toBe(true);
  });
  it('denies an admin (can invite, cannot revoke)', () => {
    expect(canRevokeConnectMember({ members: [owner, admin] }, 'admin1')).toBe(false);
  });
  it('denies a plain member', () => {
    expect(canRevokeConnectMember({ members: [owner, member] }, 'mem1')).toBe(false);
  });
  it('denies an anonymous (null) user', () => {
    expect(canRevokeConnectMember({ members: [owner] }, null)).toBe(false);
  });
});

describe('connectMemberSort', () => {
  const mk = (
    local_slug: string,
    role: ConnectMemberView['role'],
    status: ConnectMemberView['status'],
    display_name = local_slug,
  ): ConnectMemberView => ({ local_slug, display_name, role, status });

  it('sinks revoked members to the bottom regardless of role', () => {
    const revokedCollab = mk('z', 'collaborator', 'revoked');
    const activeCollab = mk('a', 'collaborator', 'active');
    const sorted = connectMemberSort([revokedCollab, activeCollab]);
    expect(sorted.map((m) => m.local_slug)).toEqual(['a', 'z']);
  });

  it('orders non-revoked owner before collaborators', () => {
    const collab = mk('c', 'collaborator', 'active');
    const owner = mk('o', 'owner', 'active');
    const sorted = connectMemberSort([collab, owner]);
    expect(sorted.map((m) => m.role)).toEqual(['owner', 'collaborator']);
  });

  it('does not rank collaborators against each other by anything but name', () => {
    // Two collaborators differ only by hosting in the real world, but the UI must
    // not encode that — so the ONLY tiebreak among same-status collaborators is
    // alphabetical by display name.
    const bob = mk('b', 'collaborator', 'active', 'Bob');
    const alice = mk('a', 'collaborator', 'active', 'Alice');
    const sorted = connectMemberSort([bob, alice]);
    expect(sorted.map((m) => m.display_name)).toEqual(['Alice', 'Bob']);
  });

  it('puts pending below active within the collaborator group, then alpha', () => {
    const pending = mk('p', 'collaborator', 'pending', 'Pending Pat');
    const activeB = mk('b', 'collaborator', 'active', 'Bob Active');
    const activeA = mk('a', 'collaborator', 'active', 'Alice Active');
    const sorted = connectMemberSort([pending, activeB, activeA]);
    expect(sorted.map((m) => m.display_name)).toEqual([
      'Alice Active',
      'Bob Active',
      'Pending Pat',
    ]);
  });

  it('does not mutate its input', () => {
    const input = [mk('z', 'collaborator', 'active'), mk('a', 'owner', 'active')];
    const before = input.map((m) => m.local_slug);
    connectMemberSort(input);
    expect(input.map((m) => m.local_slug)).toEqual(before);
  });
});

describe('formatAcceptLinkExpiry (re-export)', () => {
  const now = 1_900_000_000_000;
  it('renders minutes under an hour', () => {
    expect(formatAcceptLinkExpiry(now + 5 * 60_000, now)).toBe('Expires in 5 min');
  });
  it('reports expired in the past', () => {
    expect(formatAcceptLinkExpiry(now - 1, now)).toBe('Expired');
  });
});

// --- ConnectMembersClient wire-shape (mirrors projects-client-invite) ---

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeFetchStub(
  responder: (req: CapturedRequest) => { status: number; body: unknown } | Error,
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchFn: typeof globalThis.fetch = (async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const headers: Record<string, string> = {};
    const h = (init as RequestInit).headers;
    if (h !== undefined) {
      for (const [k, v] of Object.entries(h as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const captured: CapturedRequest = {
      url,
      method: (init as RequestInit).method ?? 'GET',
      headers,
      body: (init as RequestInit).body as string | undefined,
    };
    calls.push(captured);
    const result = responder(captured);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch: fetchFn, calls };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ConnectMembersClient', () => {
  it('GETs the member roster with a bearer + parses members', async () => {
    const members: ConnectMemberView[] = [
      { local_slug: 'casey', display_name: 'Casey', role: 'collaborator', status: 'active' },
    ];
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, members, project_id: 'neutron' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ConnectMembersClient({ base_url: 'http://example.test', token: 'dev:sam' });
    const got = await client.listMembers('neutron');

    expect(got).toEqual(members);
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe('http://example.test/api/app/projects/neutron/connect-members');
    expect(call.headers['authorization']).toBe('Bearer dev:sam');
  });

  it('POSTs a by-link invite with delivery+scope and parses the accept link', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: {
        ok: true,
        delivery: 'link',
        accept_url: 'https://sam.neutron.test/connect/accept?t=abc',
        expires_at_ms: 1_900_000_600_000,
        scope: 'read',
        project_id: 'neutron',
      },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ConnectMembersClient({ base_url: 'http://example.test', token: 't' });
    const got = await client.issueInvite('neutron', { delivery: 'link', scope: 'read' });

    expect(got.delivery).toBe('link');
    expect(got.accept_url).toContain('/connect/accept');
    expect(got.scope).toBe('read');
    // a by-link result has no jti
    expect((got as { jti?: string }).jti).toBeUndefined();

    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('http://example.test/api/app/projects/neutron/connect-invites');
    expect(JSON.parse(call.body ?? '{}')).toEqual({ delivery: 'link', scope: 'read' });
  });

  it('defaults delivery to "link" when omitted', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: {
        ok: true,
        delivery: 'link',
        accept_url: 'https://sam.neutron.test/connect/accept?t=abc',
        expires_at_ms: 1_900_000_600_000,
        scope: 'write',
        project_id: 'neutron',
      },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ConnectMembersClient({ base_url: 'http://example.test', token: 't' });
    await client.issueInvite('neutron', { scope: 'write' });
    expect(JSON.parse(stub.calls[0]!.body ?? '{}')).toEqual({ delivery: 'link', scope: 'write' });
  });

  it('POSTs a by-email invite and parses the jti', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: {
        ok: true,
        delivery: 'email',
        accept_url: 'https://sam.neutron.test/invite?invite=xyz',
        jti: 'jti-7',
        expires_at_ms: 1_900_000_600_000,
        scope: 'write',
        project_id: 'neutron',
      },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ConnectMembersClient({ base_url: 'http://example.test', token: 't' });
    const got = await client.issueInvite('neutron', {
      delivery: 'email',
      scope: 'write',
      invitee_email: 'a@b.co',
    });

    expect(got.delivery).toBe('email');
    if (got.delivery === 'email') expect(got.jti).toBe('jti-7');
    expect(JSON.parse(stub.calls[0]!.body ?? '{}')).toEqual({
      delivery: 'email',
      scope: 'write',
      invitee_email: 'a@b.co',
    });
  });

  it('surfaces 409 workspace_unavailable for a by-email invite as a typed error', async () => {
    const stub = makeFetchStub(() => ({
      status: 409,
      body: { ok: false, code: 'workspace_unavailable', message: 'no signing key' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ConnectMembersClient({ base_url: 'http://example.test', token: 't' });
    let caught: unknown;
    try {
      await client.issueInvite('neutron', { delivery: 'email', invitee_email: 'a@b.co' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConnectMembersClientError);
    expect((caught as ConnectMembersClientError).code).toBe('workspace_unavailable');
    expect((caught as ConnectMembersClientError).status).toBe(409);
  });

  it('maps a bodyless 501 to connect_not_configured', async () => {
    const stub = makeFetchStub(() => ({ status: 501, body: {} }));
    globalThis.fetch = stub.fetch;
    const client = new ConnectMembersClient({ base_url: 'http://example.test', token: 't' });
    await expect(client.listMembers('neutron')).rejects.toMatchObject({
      code: 'connect_not_configured',
      status: 501,
    });
  });

  it('POSTs revoke to the slug-scoped path and url-encodes the slug', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, revoked: true, project_id: 'neutron', local_slug: 'a/b' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ConnectMembersClient({ base_url: 'http://example.test', token: 't' });
    const got = await client.revokeMember('neutron', 'a/b');

    expect(got.revoked).toBe(true);
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(
      'http://example.test/api/app/projects/neutron/connect-members/a%2Fb/revoke',
    );
    expect(call.body).toBeUndefined();
  });

  it('maps a 403 forbidden revoke into a typed error', async () => {
    const stub = makeFetchStub(() => ({
      status: 403,
      body: { ok: false, code: 'forbidden', message: 'only the owner can revoke' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ConnectMembersClient({ base_url: 'http://example.test', token: 't' });
    await expect(client.revokeMember('neutron', 'casey')).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
  });
});

/**
 * ISSUES #421 residual — the OWNER-FACING half of invite revocation.
 *
 * A revoke API nobody can reach is the defect this repo keeps hitting, so these
 * pin the two links in the chain that live in the app: the wire shape the client
 * sends (method / URL / no body), and the filter that decides which invites the
 * drawer offers a Withdraw button for.
 */
describe('outstandingConnectInvites', () => {
  const base = {
    access: 'write' as const,
    created_at_ms: 0,
    expires_at_ms: 9_000,
    redeemed_at_ms: null,
    revoked_at_ms: null,
  };

  it('keeps only LIVE invites — the ones still redeemable and still holding the surface open', () => {
    const got = outstandingConnectInvites([
      { ...base, invite_id: 'a', state: 'live' },
      { ...base, invite_id: 'b', state: 'redeemed' },
      { ...base, invite_id: 'c', state: 'revoked' },
      { ...base, invite_id: 'd', state: 'expired' },
    ]);
    expect(got.map((i) => i.invite_id)).toEqual(['a']);
  });

  it('orders newest first, so the invite just minted is the one the owner sees', () => {
    const got = outstandingConnectInvites([
      { ...base, invite_id: 'old', state: 'live', created_at_ms: 1 },
      { ...base, invite_id: 'new', state: 'live', created_at_ms: 3 },
      { ...base, invite_id: 'mid', state: 'live', created_at_ms: 2 },
    ]);
    expect(got.map((i) => i.invite_id)).toEqual(['new', 'mid', 'old']);
  });

  it('is non-mutating', () => {
    const input = [
      { ...base, invite_id: 'x', state: 'live' as const, created_at_ms: 1 },
      { ...base, invite_id: 'y', state: 'live' as const, created_at_ms: 2 },
    ];
    const snapshot = JSON.stringify(input);
    outstandingConnectInvites(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('ConnectMembersClient — invite ledger + withdrawal', () => {
  it('lists the ledger with a GET at the connect-invites path', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: {
        ok: true,
        project_id: 'neutron',
        invites: [
          {
            invite_id: 'f'.repeat(64),
            access: 'write',
            state: 'live',
            created_at_ms: 1,
            expires_at_ms: 2,
            redeemed_at_ms: null,
            revoked_at_ms: null,
          },
        ],
      },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ConnectMembersClient({ base_url: 'http://example.test', token: 't' });
    const got = await client.listInvites('neutron');

    expect(got.map((i) => i.state)).toEqual(['live']);
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe('http://example.test/api/app/projects/neutron/connect-invites');
  });

  it('withdraws an invite with a POST to its /revoke path and no body', async () => {
    const id = 'a'.repeat(64);
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, revoked: true, state: 'live', project_id: 'neutron', invite_id: id },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ConnectMembersClient({ base_url: 'http://example.test', token: 't' });
    const got = await client.revokeInvite('neutron', id);

    expect(got).toEqual({ revoked: true, state: 'live', project_id: 'neutron', invite_id: id });
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(
      `http://example.test/api/app/projects/neutron/connect-invites/${id}/revoke`,
    );
    expect(call.body).toBeUndefined();
  });

  it('maps an unknown invite into a typed 404 error', async () => {
    const stub = makeFetchStub(() => ({
      status: 404,
      body: { ok: false, code: 'invite_not_found', message: 'no such invite on this project' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ConnectMembersClient({ base_url: 'http://example.test', token: 't' });
    await expect(client.revokeInvite('neutron', 'b'.repeat(64))).rejects.toMatchObject({
      code: 'invite_not_found',
      status: 404,
    });
  });
});

/**
 * ISSUES #421 residual — THE WIRING PIN.
 *
 * The client method and the filter above are both fully unit-tested and both
 * would stay green if `ProjectSettingsDrawer` never called them — which is
 * exactly the "module exists, its tests pass, nothing composes it" defect the
 * whole of #421 is about. There is no render harness for that component in this
 * repo (nothing under `app/__tests__` mounts it), so this asserts the wiring at
 * the SOURCE level, the same technique `gateway/http/__tests__/
 * tenant-slug-timing-safe.test.ts` uses to pin a cross-surface invariant.
 *
 * It is a weaker pin than a render test and is not pretending otherwise: it
 * proves the call sites exist, not that a human can see the button. The
 * end-to-end proof that revocation reaches the surface lives in
 * `open/__tests__/open-connect-served.test.ts`, over real HTTP.
 */
describe('the drawer actually calls the withdrawal path', () => {
  it('renders outstanding invites and wires a Withdraw action to revokeInvite', async () => {
    const src = await Bun.file(
      new URL('../components/ProjectSettingsDrawer.tsx', import.meta.url).pathname,
    ).text();

    // The ledger is read and filtered for display…
    expect(src).toContain('outstandingConnectInvites(connect.invites)');
    // …the hook exposes the withdrawal…
    expect(src).toContain('client.revokeInvite(projectId, inviteId)');
    // …and a control invokes it.
    expect(src).toContain('connect.revokeInvite(inv.invite_id)');
    expect(src).toContain('connect-invite-revoke-');
    // The ledger is fetched at all — a Withdraw button over an always-empty
    // list is the same defect wearing a different hat.
    expect(src).toContain('client.listInvites(projectId)');
  });
});
