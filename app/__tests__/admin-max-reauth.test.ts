/**
 * @neutronai/app — AdminClient.mintMaxReauthToken wire-shape tests
 * (switch-Max-account sprint, 2026-06-01).
 *
 * Convention (same as `comments-side-pane.test.tsx`,
 * `task-row-helpers.test.ts`, etc.): the bun:test suite does NOT
 * mount React Native components — `react-native` is not in the
 * runtime, no `@testing-library/react-native` dep. Render-level
 * coverage for the new "Max account" sub-tab is the agent-browser
 * smoke pass.
 *
 * What this file covers:
 *
 *   1. `AdminClient.mintMaxReauthToken` wire shape — POST,
 *      `/api/app/admin/max-oauth/mint-reauth-token`, bearer auth,
 *      JSON body shape with + without `return_url`.
 *
 *   2. Success-path unwrap — `{ paste_url }` round-trips.
 *
 *   3. Error mapping — 503 `reauth_not_configured` → typed
 *      `AdminClientError` with the same code, so the
 *      `MaxAccountPane` can branch on `err.code === 'reauth_not_
 *      configured'` and render the "not supported here" notice
 *      instead of the generic error banner.
 *
 *   4. 400 `invalid_return_url` → typed AdminClientError (the
 *      sub-tab in M1 doesn't expose return_url; this guards future
 *      callers from silent fallback when the override is rejected).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { AdminClient, AdminClientError } from '../lib/admin-client';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
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
    const bodyInit = (init as RequestInit).body;
    const body = typeof bodyInit === 'string' ? bodyInit : null;
    const captured: CapturedRequest = {
      url,
      method: (init as RequestInit).method ?? 'GET',
      headers,
      body,
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

describe('AdminClient.mintMaxReauthToken', () => {
  beforeEach(() => {
    // No-op — each test rebinds globalThis.fetch inside its body.
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('POSTs /api/app/admin/max-oauth/mint-reauth-token with bearer + empty JSON body when no return_url', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, paste_url: 'https://auth.example/oauth/max/start?...' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new AdminClient({ base_url: 'https://gw', token: 'tok' });
    const result = await client.mintMaxReauthToken();
    expect(result.paste_url).toBe('https://auth.example/oauth/max/start?...');
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://gw/api/app/admin/max-oauth/mint-reauth-token');
    expect(call.headers.authorization).toBe('Bearer tok');
    expect(call.headers['content-type']).toBe('application/json');
    // Body is `{}` when no return_url provided — the gateway
    // surface treats empty body and absent return_url identically.
    expect(call.body).toBe('{}');
  });

  it('threads return_url through the JSON body when provided', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, paste_url: 'https://auth.example/oauth/max/start' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new AdminClient({ base_url: 'https://gw/', token: 'tok' });
    await client.mintMaxReauthToken('https://demo.neutron.example/chat?reload=1');
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    // Trailing slash on base_url is stripped before the path is joined.
    expect(call.url).toBe('https://gw/api/app/admin/max-oauth/mint-reauth-token');
    const parsedBody = JSON.parse(call.body ?? '{}') as { return_url?: string };
    expect(parsedBody.return_url).toBe('https://demo.neutron.example/chat?reload=1');
  });

  it('maps 503 reauth_not_configured → AdminClientError with the same code (so the UI can branch on it)', async () => {
    const stub = makeFetchStub(() => ({
      status: 503,
      body: {
        ok: false,
        code: 'reauth_not_configured',
        message: 'in-app Max OAuth re-auth is not wired on this gateway',
      },
    }));
    globalThis.fetch = stub.fetch;
    const client = new AdminClient({ base_url: 'https://gw', token: 'tok' });
    try {
      await client.mintMaxReauthToken();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AdminClientError);
      const cast = err as AdminClientError;
      expect(cast.code).toBe('reauth_not_configured');
      expect(cast.status).toBe(503);
      expect(cast.message).toContain('not wired');
    }
  });

  it('maps 400 invalid_return_url → AdminClientError with the same code', async () => {
    const stub = makeFetchStub(() => ({
      status: 400,
      body: {
        ok: false,
        code: 'invalid_return_url',
        message: "return_url 'https://evil.example/x' is not on the allowlist",
      },
    }));
    globalThis.fetch = stub.fetch;
    const client = new AdminClient({ base_url: 'https://gw', token: 'tok' });
    try {
      await client.mintMaxReauthToken('https://evil.example/x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AdminClientError);
      const cast = err as AdminClientError;
      expect(cast.code).toBe('invalid_return_url');
      expect(cast.status).toBe(400);
    }
  });

  it('maps 500 mint_failed → AdminClientError (signing key unavailable)', async () => {
    const stub = makeFetchStub(() => ({
      status: 500,
      body: { ok: false, code: 'mint_failed', message: 'signing key unavailable' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new AdminClient({ base_url: 'https://gw', token: 'tok' });
    try {
      await client.mintMaxReauthToken();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AdminClientError);
      const cast = err as AdminClientError;
      expect(cast.code).toBe('mint_failed');
      expect(cast.status).toBe(500);
    }
  });
});
