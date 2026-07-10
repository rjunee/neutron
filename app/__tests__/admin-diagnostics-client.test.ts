/**
 * @neutronai/app — AdminClient.getDiagnostics wire-shape tests (O5).
 *
 * Convention (same as `admin-max-reauth.test.ts`, `comments-side-pane.test.tsx`):
 * the app bun:test suite does NOT mount React Native components — render-level
 * coverage of the Diagnostics pane is the agent-browser smoke pass. This file
 * covers the load-bearing pure surface: the client's wire shape, success unwrap,
 * and error mapping (non-2xx → typed AdminClientError, malformed body).
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { AdminClient, AdminClientError, type DiagnosticsReport } from '../lib/admin-client';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function makeFetchStub(
  responder: (req: CapturedRequest) => { status: number; body: unknown; noJson?: boolean } | Error,
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchFn: typeof globalThis.fetch = (async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const headers: Record<string, string> = {};
    const h = (init as RequestInit).headers;
    if (h !== undefined && !(h instanceof Headers) && !Array.isArray(h)) {
      for (const [k, v] of Object.entries(h as Record<string, string>)) headers[k.toLowerCase()] = v;
    }
    const captured: CapturedRequest = { url, method: (init as RequestInit).method ?? 'GET', headers };
    calls.push(captured);
    const result = responder(captured);
    if (result instanceof Error) throw result;
    // `noJson: true` simulates a malformed/empty body → res.json() rejects.
    const bodyText = result.noJson === true ? 'not json' : JSON.stringify(result.body);
    return new Response(bodyText, { status: result.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch: fetchFn, calls };
}

const ORIGINAL_FETCH = globalThis.fetch;

function sampleReport(): DiagnosticsReport {
  return {
    generated_at: 123,
    project_slug: 'demo',
    gbrain: { available: true, status: 'ok' },
    credentials: { available: false, note: 'not wired on this gateway' },
    repl_sessions: { available: true, sessions: [] },
    cron_jobs: { available: true, jobs: [] },
    import_jobs: { available: true, jobs: [] },
    recent_events: { available: true, events: [] },
  };
}

describe('AdminClient.getDiagnostics', () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('GETs /api/app/admin/diagnostics with bearer auth and unwraps { diagnostics }', async () => {
    const report = sampleReport();
    const stub = makeFetchStub(() => ({ status: 200, body: { ok: true, diagnostics: report } }));
    globalThis.fetch = stub.fetch;

    const client = new AdminClient({ base_url: 'https://gw/', token: 'tok' });
    const out = await client.getDiagnostics();

    expect(out.project_slug).toBe('demo');
    expect(out.gbrain.status).toBe('ok');
    expect(out.credentials.available).toBe(false);
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe('https://gw/api/app/admin/diagnostics');
    expect(call.headers.authorization).toBe('Bearer tok');
  });

  it('maps a 401 into a typed AdminClientError carrying the server code', async () => {
    const stub = makeFetchStub(() => ({ status: 401, body: { ok: false, code: 'missing_bearer', message: 'x' } }));
    globalThis.fetch = stub.fetch;
    const client = new AdminClient({ base_url: 'https://gw', token: '' });
    await expect(client.getDiagnostics()).rejects.toMatchObject({
      name: 'AdminClientError',
      code: 'missing_bearer',
      status: 401,
    });
  });

  it('maps a 403 project_mismatch into a typed AdminClientError', async () => {
    const stub = makeFetchStub(() => ({ status: 403, body: { ok: false, code: 'project_mismatch', message: 'x' } }));
    globalThis.fetch = stub.fetch;
    const client = new AdminClient({ base_url: 'https://gw', token: 'tok' });
    let err: unknown;
    try {
      await client.getDiagnostics();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AdminClientError);
    expect((err as AdminClientError).code).toBe('project_mismatch');
  });

  it('a 200 { ok:true } with NO diagnostics payload maps to a typed error (does not resolve undefined)', async () => {
    const stub = makeFetchStub(() => ({ status: 200, body: { ok: true } }));
    globalThis.fetch = stub.fetch;
    const client = new AdminClient({ base_url: 'https://gw', token: 'tok' });
    await expect(client.getDiagnostics()).rejects.toMatchObject({
      name: 'AdminClientError',
      code: 'malformed_response',
    });
  });

  it('a 200 with a wrong-shaped diagnostics (no project_slug) maps to a typed error', async () => {
    const stub = makeFetchStub(() => ({ status: 200, body: { ok: true, diagnostics: { nonsense: 1 } } }));
    globalThis.fetch = stub.fetch;
    const client = new AdminClient({ base_url: 'https://gw', token: 'tok' });
    await expect(client.getDiagnostics()).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('a malformed/empty error body still yields a typed error (no throw-through)', async () => {
    const stub = makeFetchStub(() => ({ status: 500, body: null, noJson: true }));
    globalThis.fetch = stub.fetch;
    const client = new AdminClient({ base_url: 'https://gw', token: 'tok' });
    await expect(client.getDiagnostics()).rejects.toMatchObject({
      name: 'AdminClientError',
      code: 'request_failed',
      status: 500,
    });
  });
});
