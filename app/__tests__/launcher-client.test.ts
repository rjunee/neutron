/**
 * @neutronai/app — launcher-client unit tests (P5.3).
 *
 * Round-trips the typed `LauncherClient` against a mocked
 * `globalThis.fetch` so the wire shape (request method, path,
 * headers, body) and the error mapping (network / 4xx → typed
 * `LauncherClientError`) is exercised without spinning up a real
 * gateway. The build-me path is the new addition this sprint —
 * Argus has caught raw-fetch anti-patterns three sprints in a row
 * so the typed client + this test gate the regression.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  LauncherClient,
  LauncherClientError,
  formatBuildMeBody,
  type LauncherEntry,
} from '../lib/launcher-client';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function entry(slug: string, idx: number): LauncherEntry {
  return {
    slug,
    display_name: slug,
    launcher_icon: { kind: 'emoji', value: '🧩' },
    reorder_index: idx,
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

describe('LauncherClient — list / mutations', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = () => {
      globalThis.fetch = originalFetch;
    };
  });
  afterEach(() => restore());

  it('GET list sends the bearer + parses entries', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, entries: [entry('notes', 0)], project_id: 'p' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new LauncherClient({ base_url: 'http://x.test', token: 'dev:sam' });
    const got = await client.list('p');
    expect(got).toHaveLength(1);
    expect(got[0]?.slug).toBe('notes');
    expect(stub.calls[0]?.headers['authorization']).toBe('Bearer dev:sam');
    expect(stub.calls[0]?.url).toBe('http://x.test/api/app/projects/p/launcher');
    expect(stub.calls[0]?.method).toBe('GET');
  });

  it('POST reorder threads slug + new_index in the body', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, entries: [], project_id: 'p' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new LauncherClient({ base_url: 'http://x.test', token: 'dev:r' });
    await client.reorder('p', 'notes', 2);
    expect(stub.calls[0]?.url).toBe('http://x.test/api/app/projects/p/launcher/reorder');
    expect(stub.calls[0]?.method).toBe('POST');
    expect(stub.calls[0]?.body).toBe(JSON.stringify({ slug: 'notes', new_index: 2 }));
  });

  it('4xx response throws a typed LauncherClientError with the code', async () => {
    const stub = makeFetchStub(() => ({
      status: 403,
      body: { code: 'forbidden', message: 'no' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new LauncherClient({ base_url: 'http://x.test', token: 'dev:r' });
    try {
      await client.list('p');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LauncherClientError);
      expect((err as LauncherClientError).code).toBe('forbidden');
      expect((err as LauncherClientError).status).toBe(403);
    }
  });
});

describe('LauncherClient.sendBuildMePrompt', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = () => {
      globalThis.fetch = originalFetch;
    };
  });
  afterEach(() => restore());

  it('POSTs the canonical body shape to /api/app/chat/send', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, message_id: 'm-1' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new LauncherClient({ base_url: 'http://x.test', token: 'dev:sam' });
    await client.sendBuildMePrompt({ project_id: 'p_test', prompt: 'tracks running' });
    expect(stub.calls).toHaveLength(1);
    const c = stub.calls[0];
    expect(c?.url).toBe('http://x.test/api/app/chat/send');
    expect(c?.method).toBe('POST');
    expect(c?.headers['authorization']).toBe('Bearer dev:sam');
    expect(c?.headers['content-type']).toBe('application/json');
    expect(c?.body).toBe(
      JSON.stringify({
        body: 'Build me a Core that tracks running',
        project_id: 'p_test',
      }),
    );
  });

  it('4xx response throws LauncherClientError with the gateway code', async () => {
    const stub = makeFetchStub(() => ({
      status: 422,
      body: { ok: false, code: 'malformed_envelope', message: 'bad body' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new LauncherClient({ base_url: 'http://x.test', token: 'dev:r' });
    try {
      await client.sendBuildMePrompt({ project_id: 'p', prompt: 'x' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LauncherClientError);
      expect((err as LauncherClientError).code).toBe('malformed_envelope');
      expect((err as LauncherClientError).status).toBe(422);
    }
  });

  it('network failure throws LauncherClientError with kind=network', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const client = new LauncherClient({ base_url: 'http://x.test', token: 'dev:r' });
    try {
      await client.sendBuildMePrompt({ project_id: 'p', prompt: 'x' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LauncherClientError);
      expect((err as LauncherClientError).code).toBe('network');
      expect((err as LauncherClientError).status).toBe(0);
    }
  });
});

describe('formatBuildMeBody', () => {
  it('wraps the user prompt with the canonical prefix', () => {
    expect(formatBuildMeBody('tracks running')).toBe('Build me a Core that tracks running');
  });
});
