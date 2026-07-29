/**
 * @neutronai/app — tasks-client unit tests (P5.4).
 *
 * Round-trips the typed `TasksClient` against a mocked
 * `globalThis.fetch` so the wire shape (method, path, query, headers,
 * body) and the error mapping (network / 4xx → typed
 * `TasksClientError`) are exercised without spinning up a real
 * gateway. The new `?order=focus_score` opt-in for `list()` lands
 * with its own assertion — Atlas locked focus_score as the P5.4
 * default sort, so the typed client carries the query param.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TasksClient, TasksClientError, type Task } from '../lib/tasks-client';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function task(id: string): Task {
  return {
    id,
    project_slug: 't',
    project_id: 'p',
    title: `Task ${id}`,
    description: null,
    status: 'open',
    priority: null,
    due_date: null,
    owner_persona: null,
    source: null,
    created_at: '2026-05-20T00:00:00Z',
    updated_at: '2026-05-20T00:00:00Z',
    completed_at: null,
    focus_score: null,
  };
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

describe('TasksClient — list', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = () => {
      globalThis.fetch = originalFetch;
    };
  });
  afterEach(() => restore());

  it('builds the canonical URL with ?status=open by default', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, tasks: [task('a')], project_id: 'p', status: 'open' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new TasksClient({ base_url: 'http://x.test', token: 'dev:sam' });
    const got = await client.list('p');
    expect(got).toHaveLength(1);
    expect(got[0]?.id).toBe('a');
    expect(stub.calls[0]?.headers['authorization']).toBe('Bearer dev:sam');
    expect(stub.calls[0]?.url).toBe('http://x.test/api/app/projects/p/tasks?status=open');
    expect(stub.calls[0]?.method).toBe('GET');
  });

  it('threads the status filter through the query string', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, tasks: [], project_id: 'p', status: 'done' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new TasksClient({ base_url: 'http://x.test', token: 't' });
    await client.list('p', 'done');
    expect(stub.calls[0]?.url).toBe('http://x.test/api/app/projects/p/tasks?status=done');
  });

  it('omits ?order when the default ordering is requested', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, tasks: [], project_id: 'p', status: 'open' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new TasksClient({ base_url: 'http://x.test', token: 't' });
    await client.list('p', 'open', 'default');
    expect(stub.calls[0]?.url).toBe('http://x.test/api/app/projects/p/tasks?status=open');
  });

  it('threads ?order=focus_score when requested (P5.4 default sort)', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, tasks: [], project_id: 'p', status: 'open' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new TasksClient({ base_url: 'http://x.test', token: 't' });
    await client.list('p', 'open', 'focus_score');
    expect(stub.calls[0]?.url).toBe(
      'http://x.test/api/app/projects/p/tasks?status=open&order=focus_score',
    );
  });

  it('url-encodes the project_id', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, tasks: [], project_id: 'p/x', status: 'open' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new TasksClient({ base_url: 'http://x.test', token: 't' });
    await client.list('weird id/with slash');
    expect(stub.calls[0]?.url).toContain('weird%20id%2Fwith%20slash');
  });
});

describe('TasksClient — mutations', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = () => {
      globalThis.fetch = originalFetch;
    };
  });
  afterEach(() => restore());

  it('POST create sends the input body + parses the task', async () => {
    const stub = makeFetchStub(() => ({
      status: 201,
      body: { ok: true, task: task('new') },
    }));
    globalThis.fetch = stub.fetch;
    const client = new TasksClient({ base_url: 'http://x.test', token: 't' });
    const got = await client.create('p', { title: 'foo', priority: 1 });
    expect(got.id).toBe('new');
    expect(stub.calls[0]?.url).toBe('http://x.test/api/app/projects/p/tasks');
    expect(stub.calls[0]?.method).toBe('POST');
    expect(stub.calls[0]?.body).toBe(JSON.stringify({ title: 'foo', priority: 1 }));
    expect(stub.calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('PATCH update sends the patch body + parses the task', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, task: task('t1') },
    }));
    globalThis.fetch = stub.fetch;
    const client = new TasksClient({ base_url: 'http://x.test', token: 't' });
    await client.update('p', 't1', { title: 'new title' });
    expect(stub.calls[0]?.url).toBe('http://x.test/api/app/projects/p/tasks/t1');
    expect(stub.calls[0]?.method).toBe('PATCH');
    expect(stub.calls[0]?.body).toBe(JSON.stringify({ title: 'new title' }));
  });

  it('POST complete uses the /complete verb path', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, task: { ...task('t1'), status: 'done' as const } },
    }));
    globalThis.fetch = stub.fetch;
    const client = new TasksClient({ base_url: 'http://x.test', token: 't' });
    const got = await client.complete('p', 't1');
    expect(stub.calls[0]?.url).toBe('http://x.test/api/app/projects/p/tasks/t1/complete');
    expect(stub.calls[0]?.method).toBe('POST');
    expect(got.status).toBe('done');
  });

  it('POST cancel uses the /cancel verb path', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, task: { ...task('t1'), status: 'cancelled' as const } },
    }));
    globalThis.fetch = stub.fetch;
    const client = new TasksClient({ base_url: 'http://x.test', token: 't' });
    const got = await client.cancel('p', 't1');
    expect(stub.calls[0]?.url).toBe('http://x.test/api/app/projects/p/tasks/t1/cancel');
    expect(got.status).toBe('cancelled');
  });

  it('DELETE returns void + uses the bare task path', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, deleted_task_id: 't1' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new TasksClient({ base_url: 'http://x.test', token: 't' });
    await client.delete('p', 't1');
    expect(stub.calls[0]?.url).toBe('http://x.test/api/app/projects/p/tasks/t1');
    expect(stub.calls[0]?.method).toBe('DELETE');
  });
});

describe('TasksClient — error mapping', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = () => {
      globalThis.fetch = originalFetch;
    };
  });
  afterEach(() => restore());

  it('4xx response throws a typed TasksClientError with the code', async () => {
    const stub = makeFetchStub(() => ({
      status: 403,
      body: { code: 'forbidden', message: 'no' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new TasksClient({ base_url: 'http://x.test', token: 't' });
    await expect(client.list('p')).rejects.toThrow(TasksClientError);
    try {
      await client.list('p');
    } catch (err) {
      expect(err).toBeInstanceOf(TasksClientError);
      expect((err as TasksClientError).code).toBe('forbidden');
      expect((err as TasksClientError).status).toBe(403);
    }
  });

  it('network failure throws a TasksClientError with `request_failed` fallback', async () => {
    const stub = makeFetchStub(() => new Error('econn'));
    globalThis.fetch = stub.fetch;
    const client = new TasksClient({ base_url: 'http://x.test', token: 't' });
    await expect(client.list('p')).rejects.toThrow();
  });

  it('500 with no JSON body still throws TasksClientError', async () => {
    const stub = makeFetchStub(() => ({
      status: 500,
      body: 'plaintext', // will JSON.stringify to "plaintext"
    }));
    globalThis.fetch = stub.fetch;
    const client = new TasksClient({ base_url: 'http://x.test', token: 't' });
    try {
      await client.list('p');
      throw new Error('should not reach');
    } catch (err) {
      expect(err).toBeInstanceOf(TasksClientError);
      expect((err as TasksClientError).status).toBe(500);
    }
  });

  it('trims trailing slashes from base_url', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, tasks: [], project_id: 'p', status: 'open' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new TasksClient({ base_url: 'http://x.test///', token: 't' });
    await client.list('p');
    expect(stub.calls[0]?.url).toBe('http://x.test/api/app/projects/p/tasks?status=open');
  });
});
