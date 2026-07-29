/**
 * @neutronai/app — ProjectsClient.generateInvite unit tests (M2.4).
 *
 * Round-trips the typed client against a mocked `globalThis.fetch`:
 * verifies the POST path, bearer header, JSON body, parsed result, and
 * the error mapping (server `code` → `ProjectsClientError.code`).
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { ProjectsClient, ProjectsClientError } from '../lib/projects-client';

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

describe('ProjectsClient.generateInvite', () => {
  it('POSTs the email with a bearer + parses the link result', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: {
        ok: true,
        invite_url: 'https://sam.neutron.test/invite?invite=jwt.parts.here',
        jti: 'jti-1',
        expires_at_ms: 1_900_000_600_000,
      },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ProjectsClient({
      base_url: 'http://example.test',
      token: 'dev:sam',
    });
    const got = await client.generateInvite('neutron', 'invited@test.invalid');

    expect(got.invite_url).toContain('/invite?invite=');
    expect(got.jti).toBe('jti-1');
    expect(got.expires_at_ms).toBe(1_900_000_600_000);

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('http://example.test/api/app/projects/neutron/invite');
    expect(call.headers['authorization']).toBe('Bearer dev:sam');
    expect(JSON.parse(call.body ?? '{}')).toEqual({ invitee_email: 'invited@test.invalid' });
  });

  it('url-encodes the project id', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, invite_url: 'x', jti: 'j', expires_at_ms: 1 },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ProjectsClient({ base_url: 'http://example.test', token: 't' });
    await client.generateInvite('a/b', 'a@b.co');
    expect(stub.calls[0]!.url).toBe('http://example.test/api/app/projects/a%2Fb/invite');
  });

  it('maps a 403 forbidden into a typed ProjectsClientError', async () => {
    const stub = makeFetchStub(() => ({
      status: 403,
      body: { ok: false, code: 'forbidden', message: 'only the owner can invite' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ProjectsClient({ base_url: 'http://example.test', token: 't' });
    await expect(client.generateInvite('neutron', 'a@b.co')).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
  });

  it('maps a 409 not_group reason through', async () => {
    const stub = makeFetchStub(() => ({
      status: 409,
      body: { ok: false, code: 'not_group', message: 'solo project' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ProjectsClient({ base_url: 'http://example.test', token: 't' });
    let caught: unknown;
    try {
      await client.generateInvite('neutron', 'a@b.co');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProjectsClientError);
    expect((caught as ProjectsClientError).code).toBe('not_group');
  });
});
