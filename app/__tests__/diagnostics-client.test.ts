/**
 * @neutronai/app — DiagnosticsClient wire shape + the manual-send copy.
 *
 * Convention (same as `admin-diagnostics-client.test.ts`): the app suite does
 * not mount React Native components, so the coverage here is the load-bearing
 * pure surface — the request the client actually issues, how it reports a
 * non-2xx, and the Settings copy that must not claim success after a failure.
 */

import { describe, expect, it } from 'bun:test';

import type { ClientReport } from '../lib/diagnostic-report';
import { DiagnosticsClient, REPORTS_PATH } from '../lib/diagnostics-client';
import { describeSendError, describeSendResult } from '../lib/diagnostics-send-state';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function stubFetch(
  responder: (req: Captured) => { status: number; body: unknown },
): { fetchFn: typeof globalThis.fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchFn: typeof globalThis.fetch = (async (input, init = {}) => {
    const headers: Record<string, string> = {};
    const raw = (init as RequestInit).headers;
    if (raw !== undefined && !(raw instanceof Headers) && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const captured: Captured = {
      url: typeof input === 'string' ? input : String(input),
      method: (init as RequestInit).method ?? 'GET',
      headers,
      body: String((init as RequestInit).body ?? ''),
    };
    calls.push(captured);
    const result = responder(captured);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetchFn, calls };
}

function report(): ClientReport {
  return {
    schema: 1,
    report_id: 'r1',
    created_at: 1,
    origin: 'https://neutron.example.com',
    reason: 'manual',
    app: { version: '1.0.0', build: null, platform: 'ios', os_version: '18' },
    session: { signed_in: true },
    events: [],
  };
}

describe('DiagnosticsClient', () => {
  it('POSTs the batch to the owner gateway with the bearer', async () => {
    const { fetchFn, calls } = stubFetch(() => ({ status: 200, body: { ok: true, accepted: 1 } }));
    const client = new DiagnosticsClient({
      base_url: 'https://neutron.example.com/',
      token: 'tok-abcdefgh',
      fetchFn,
    });

    const result = await client.sendReports([report()]);

    expect(result).toEqual({ ok: true, status: 200, accepted: 1 });
    expect(calls).toHaveLength(1);
    // Trailing slash on the base is normalised away.
    expect(calls[0]!.url).toBe(`https://neutron.example.com${REPORTS_PATH}`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['authorization']).toBe('Bearer tok-abcdefgh');
    expect(JSON.parse(calls[0]!.body)).toEqual({ reports: [report()] });
  });

  it('reports a non-2xx as not-ok instead of throwing', async () => {
    const { fetchFn } = stubFetch(() => ({ status: 401, body: { ok: false, code: 'missing_bearer' } }));
    const client = new DiagnosticsClient({ base_url: 'https://x', token: 'tok-abcdefgh', fetchFn });
    const result = await client.sendReports([report()]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('reports a transport failure as not-ok', async () => {
    const fetchFn = (async () => {
      throw new Error('network down');
    }) as unknown as typeof globalThis.fetch;
    const client = new DiagnosticsClient({ base_url: 'https://x', token: 'tok-abcdefgh', fetchFn });
    const result = await client.sendReports([report()]);
    expect(result).toEqual({ ok: false, status: 0, accepted: 0, message: 'network down' });
  });

  it('sends nothing for an empty batch', async () => {
    const { fetchFn, calls } = stubFetch(() => ({ status: 200, body: { ok: true } }));
    const client = new DiagnosticsClient({ base_url: 'https://x', token: 'tok-abcdefgh', fetchFn });
    expect(await client.sendReports([])).toEqual({ ok: true, status: 200, accepted: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('manual-send copy', () => {
  it('never claims success after a failed flush', () => {
    const described = describeSendResult({ delivered: 0, remaining: 2, ok: false });
    expect(described.state).toBe('failed');
    expect(described.message).toContain('2 reports are saved');
  });

  it('says plainly when there was nothing to send', () => {
    expect(describeSendResult({ delivered: 0, remaining: 0, ok: true })).toEqual({
      state: 'done',
      message: 'Nothing to send — no errors recorded.',
    });
  });

  it('reports the delivered count', () => {
    expect(describeSendResult({ delivered: 1, remaining: 0, ok: true }).message).toBe(
      'Sent 1 report to your server.',
    );
    expect(describeSendResult({ delivered: 3, remaining: 0, ok: true }).message).toBe(
      'Sent 3 reports to your server.',
    );
  });

  it('surfaces a thrown send as a failure', () => {
    expect(describeSendError(new Error('boom'))).toEqual({
      state: 'failed',
      message: 'Could not send: boom',
    });
  });
});
