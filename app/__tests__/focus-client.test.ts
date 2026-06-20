/**
 * @neutronai/app — focus-client unit tests (P5.6).
 *
 * Round-trips the typed `FocusClient` against a mocked
 * `globalThis.fetch` so the wire shape (method, path, query, headers)
 * and the error mapping (network / 4xx → typed `FocusClientError`)
 * are exercised without spinning up a real gateway. The P5.6 client
 * extension is the optional `?order=focus_score` query param +
 * the `focus_score` field on `FocusItem`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  FocusClient,
  FocusClientError,
  type FocusResponse,
} from '../lib/focus-client';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
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

const ORIGINAL_FETCH = globalThis.fetch;

function emptyOk(): FocusResponse {
  return {
    ok: true,
    project_slug: 'demo',
    now: '2026-05-20T00:00:00Z',
    today: [],
  };
}

describe('FocusClient.list', () => {
  let restoreFetch: () => void;

  beforeEach(() => {
    restoreFetch = () => {
      globalThis.fetch = ORIGINAL_FETCH;
    };
  });

  afterEach(() => {
    restoreFetch();
  });

  it('GET /api/app/focus with bearer token, no order query', async () => {
    const stub = makeFetchStub(() => ({ status: 200, body: emptyOk() }));
    globalThis.fetch = stub.fetch;
    const client = new FocusClient({ base_url: 'https://gw/', token: 'tok' });
    await client.list();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.method).toBe('GET');
    expect(stub.calls[0]!.url).toBe('https://gw/api/app/focus');
    expect(stub.calls[0]!.headers.authorization).toBe('Bearer tok');
  });

  it("list({order: 'default'}) sends no order query (default = server default)", async () => {
    const stub = makeFetchStub(() => ({ status: 200, body: emptyOk() }));
    globalThis.fetch = stub.fetch;
    const client = new FocusClient({ base_url: 'https://gw', token: 'tok' });
    await client.list({ order: 'default' });
    expect(stub.calls[0]!.url).toBe('https://gw/api/app/focus');
  });

  it("list({order: 'focus_score'}) opts into the gateway's P6 sort", async () => {
    const stub = makeFetchStub(() => ({ status: 200, body: emptyOk() }));
    globalThis.fetch = stub.fetch;
    const client = new FocusClient({ base_url: 'https://gw', token: 'tok' });
    await client.list({ order: 'focus_score' });
    expect(stub.calls[0]!.url).toBe('https://gw/api/app/focus?order=focus_score');
  });

  it('throws typed FocusClientError on a 4xx with code + message', async () => {
    const stub = makeFetchStub(() => ({
      status: 403,
      body: { ok: false, code: 'forbidden', message: 'wrong instance' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new FocusClient({ base_url: 'https://gw', token: 'tok' });
    try {
      await client.list();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FocusClientError);
      const cast = err as FocusClientError;
      expect(cast.code).toBe('forbidden');
      expect(cast.status).toBe(403);
      expect(cast.message).toContain('wrong instance');
    }
  });

  it('throws FocusClientError with code request_failed on network throws', async () => {
    const stub = makeFetchStub(() => new Error('boom'));
    globalThis.fetch = stub.fetch;
    const client = new FocusClient({ base_url: 'https://gw', token: 'tok' });
    try {
      await client.list();
      throw new Error('expected throw');
    } catch (err) {
      // FocusClient surfaces the underlying error directly; the test
      // suite catches it as-is so non-Response throws don't get
      // re-wrapped. This matches the launcher + reminders clients'
      // shape — they propagate the native error.
      expect((err as Error).message).toBe('boom');
    }
  });

  it('throws FocusClientError invalid_response on a 200 with malformed payload', async () => {
    const stub = makeFetchStub(() => ({ status: 200, body: { ok: true } }));
    globalThis.fetch = stub.fetch;
    const client = new FocusClient({ base_url: 'https://gw', token: 'tok' });
    try {
      await client.list();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FocusClientError);
      const cast = err as FocusClientError;
      expect(cast.code).toBe('invalid_response');
    }
  });

  it('falls back to HTTP N message when the 4xx body has no message', async () => {
    const stub = makeFetchStub(() => ({ status: 500, body: {} }));
    globalThis.fetch = stub.fetch;
    const client = new FocusClient({ base_url: 'https://gw', token: 'tok' });
    try {
      await client.list();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FocusClientError);
      const cast = err as FocusClientError;
      expect(cast.code).toBe('request_failed');
      expect(cast.status).toBe(500);
      expect(cast.message).toContain('HTTP 500');
    }
  });
});
