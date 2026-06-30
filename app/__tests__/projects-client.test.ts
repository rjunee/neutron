/**
 * @neutronai/app — projects-client unit tests (P5.2).
 *
 * Round-trips the typed `ProjectsClient` against a mocked
 * `globalThis.fetch` so the wire shape (request method, path, headers,
 * body) and the error mapping (network / 401 / 404 / 400 → typed
 * `ProjectsClientError`) are exercised without spinning up a real
 * gateway.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  ProjectsClient,
  ProjectsClientError,
  type ProjectSettings,
} from '../lib/projects-client';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeProject(): ProjectSettings {
  return {
    id: 'neutron',
    name: 'Neutron',
    description: '',
    persona: 'Forge',
    privacy_mode: 'private',
    billing_mode: 'personal',
    agent_engagement_mode: 'all_messages',
    members: [{ user_id: 'sam', name: 'Sam', role: 'owner' }],
  };
}

function makeFetchStub(
  responder: (req: CapturedRequest) => {
    status: number;
    body: unknown;
  } | Error,
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchFn: typeof globalThis.fetch = (async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const headers: Record<string, string> = {};
    const h = (init as RequestInit).headers;
    if (h !== undefined) {
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headers[String(k).toLowerCase()] = String(v);
      } else {
        for (const [k, v] of Object.entries(h as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
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

const originalFetch: typeof globalThis.fetch = globalThis.fetch;

describe('ProjectsClient', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = () => {
      globalThis.fetch = originalFetch;
    };
  });
  afterEach(() => restore());

  it('GET sends the bearer + parses the canonical settings doc', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, project: fakeProject() },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ProjectsClient({
      base_url: 'http://example.test',
      token: 'dev:sam',
    });
    const got = await client.getSettings('neutron');
    expect(got).toEqual(fakeProject());
    expect(stub.calls).toHaveLength(1);
    const [call] = stub.calls;
    expect(call.url).toBe('http://example.test/api/app/projects/neutron/settings');
    expect(call.method).toBe('GET');
    expect(call.headers['authorization']).toBe('Bearer dev:sam');
  });

  it('PATCH includes the privacy_mode body + parses the canonical doc back', async () => {
    const stub = makeFetchStub((req) => {
      expect(req.method).toBe('PATCH');
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.body).toBe(JSON.stringify({ privacy_mode: 'public' }));
      return {
        status: 200,
        body: { ok: true, project: { ...fakeProject(), privacy_mode: 'public' } },
      };
    });
    globalThis.fetch = stub.fetch;
    const client = new ProjectsClient({
      base_url: 'http://example.test/',
      token: 'dev:casey',
    });
    const got = await client.patchPrivacy('neutron', 'public');
    expect(got.privacy_mode).toBe('public');
  });

  it('create POSTs { name } and parses the new project id + label', async () => {
    const stub = makeFetchStub((req) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('http://example.test/api/app/projects');
      expect(req.headers['authorization']).toBe('Bearer dev:sam');
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.body).toBe(JSON.stringify({ name: 'Taxes' }));
      return {
        status: 201,
        body: { ok: true, project: { id: 'taxes', label: 'Taxes' }, created: true },
      };
    });
    globalThis.fetch = stub.fetch;
    const client = new ProjectsClient({ base_url: 'http://example.test', token: 'dev:sam' });
    const got = await client.create('Taxes');
    expect(got).toEqual({ id: 'taxes', label: 'Taxes', created: true });
  });

  it('create surfaces a typed error on 400 invalid_name', async () => {
    const stub = makeFetchStub(() => ({
      status: 400,
      body: { ok: false, code: 'invalid_name', message: 'name is required' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ProjectsClient({ base_url: 'http://x', token: 't' });
    let err: unknown = null;
    try {
      await client.create('');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProjectsClientError);
    if (err instanceof ProjectsClientError) {
      expect(err.code).toBe('invalid_name');
    }
  });

  it('401 raises ProjectsClientError with code=unauthorized', async () => {
    const stub = makeFetchStub(() => ({
      status: 401,
      body: { ok: false, code: 'missing_bearer', message: 'no token' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ProjectsClient({ base_url: 'http://x', token: 't' });
    let err: unknown = null;
    try {
      await client.getSettings('neutron');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProjectsClientError);
    if (err instanceof ProjectsClientError) {
      expect(err.code).toBe('missing_bearer');
      expect(err.status).toBe(401);
    }
  });

  it('404 raises ProjectsClientError with code=project_not_found', async () => {
    const stub = makeFetchStub(() => ({
      status: 404,
      body: { ok: false, code: 'project_not_found', message: 'no such project' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ProjectsClient({ base_url: 'http://x', token: 't' });
    let err: unknown = null;
    try {
      await client.getSettings('ghost');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProjectsClientError);
    if (err instanceof ProjectsClientError) {
      expect(err.code).toBe('project_not_found');
      expect(err.status).toBe(404);
    }
  });

  it('400 PATCH field_not_writable preserves the field name', async () => {
    const stub = makeFetchStub(() => ({
      status: 400,
      body: {
        ok: false,
        code: 'field_not_writable',
        message: "field 'persona' is not writable at P5.2",
        field: 'persona',
      },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ProjectsClient({ base_url: 'http://x', token: 't' });
    let err: unknown = null;
    try {
      await client.patchPrivacy('neutron', 'public');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProjectsClientError);
    if (err instanceof ProjectsClientError) {
      expect(err.code).toBe('field_not_writable');
      expect(err.field).toBe('persona');
      expect(err.status).toBe(400);
    }
  });

  it('network failure raises code=network', async () => {
    globalThis.fetch = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof globalThis.fetch;
    const client = new ProjectsClient({ base_url: 'http://x', token: 't' });
    let err: unknown = null;
    try {
      await client.getSettings('neutron');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProjectsClientError);
    if (err instanceof ProjectsClientError) {
      expect(err.code).toBe('network');
      expect(err.status).toBe(0);
    }
  });

  it('list GETs /api/app/projects and parses the envelope (ISSUES #9 + M2.3)', async () => {
    const projects = [
      { ...fakeProject(), kind: 'solo' as const, origin_instance: 'demo', owning_instance_slug: 'demo' },
      {
        ...fakeProject(),
        id: 'acme',
        name: 'Acme',
        privacy_mode: 'public' as const,
        kind: 'solo' as const,
        origin_instance: 'demo',
        owning_instance_slug: 'demo',
      },
    ];
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, projects, project_slug: 'demo', source_errors: [] },
    }));
    globalThis.fetch = stub.fetch;
    const client = new ProjectsClient({
      base_url: 'http://example.test',
      token: 'dev:sam',
    });
    const got = await client.list();
    // M2.3 — list() now returns { projects, source_errors } not a bare array.
    expect(got).toEqual({ projects, source_errors: [] });
    expect(stub.calls).toHaveLength(1);
    const [call] = stub.calls;
    expect(call!.url).toBe('http://example.test/api/app/projects');
    expect(call!.method).toBe('GET');
    expect(call!.headers['authorization']).toBe('Bearer dev:sam');
  });

  it('list propagates source_errors and defaults them to [] when absent (M2.3)', async () => {
    // With source_errors present.
    const withErrs = makeFetchStub(() => ({
      status: 200,
      body: {
        ok: true,
        projects: [],
        project_slug: 'demo',
        source_errors: [{ workspace_instance_slug: 'acme', error: 'http_503' }],
      },
    }));
    globalThis.fetch = withErrs.fetch;
    let client = new ProjectsClient({ base_url: 'http://x', token: 't' });
    let got = await client.list();
    expect(got.source_errors).toEqual([{ workspace_instance_slug: 'acme', error: 'http_503' }]);

    // Back-compat: a local-only / pre-M2.3 gateway omits source_errors.
    const noField = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, projects: [], project_slug: 'demo' },
    }));
    globalThis.fetch = noField.fetch;
    client = new ProjectsClient({ base_url: 'http://x', token: 't' });
    got = await client.list();
    expect(got.source_errors).toEqual([]);
  });
});
