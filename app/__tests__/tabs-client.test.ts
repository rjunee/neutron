/**
 * @neutronai/app — TabsClient wire-shape tests (WAVE 3 PR-3).
 *
 * Locks the `GET /api/app/projects/<id>/tabs` contract the mobile shell
 * consumes: method, URL, bearer header, the `{ tabs }` unwrap, and the
 * error-mapping path. Same fetch-stub convention as `launcher-client.test.ts`
 * (no live gateway; `react-native` is not loaded in this runtime).
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { TabsClient, TabsClientError, type TabDescriptor } from '../lib/tabs-client';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: (input: string, init?: RequestInit) => Response): {
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return Promise.resolve(impl(url, init));
  }) as typeof fetch;
  return { calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const DESCRIPTORS: TabDescriptor[] = [
  { key: 'chat', label: 'Chat', scope: 'project', source: 'builtin', order: 0, mount: { kind: 'builtin', target: 'chat' } },
  { key: 'core:research', label: 'Research', scope: 'project', source: 'core', core_slug: 'research', order: 100, mount: { kind: 'webview', target: 'https://core.example/r' } },
];

describe('TabsClient.listProjectTabs', () => {
  it('GETs the per-project tabs path with a bearer header and unwraps tabs', async () => {
    const { calls } = stubFetch(() =>
      jsonResponse(200, { ok: true, scope: 'project', project_id: 'p one', tabs: DESCRIPTORS }),
    );
    const client = new TabsClient({ base_url: 'https://gw.example/', token: 'tok123' });
    const tabs = await client.listProjectTabs('p one');

    expect(tabs).toEqual(DESCRIPTORS);
    expect(calls).toHaveLength(1);
    // base_url trailing slash trimmed + project id encoded.
    expect(calls[0]?.url).toBe('https://gw.example/api/app/projects/p%20one/tabs');
    expect(calls[0]?.init?.method).toBe('GET');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok123');
  });

  it('returns [] when the payload omits tabs', async () => {
    stubFetch(() => jsonResponse(200, { ok: true, scope: 'project', project_id: 'p1' }));
    const client = new TabsClient({ base_url: 'https://gw.example', token: 't' });
    expect(await client.listProjectTabs('p1')).toEqual([]);
  });

  it('maps a non-ok response to TabsClientError with the server code', async () => {
    stubFetch(() => jsonResponse(401, { ok: false, code: 'missing_bearer', message: 'nope' }));
    const client = new TabsClient({ base_url: 'https://gw.example', token: 't' });
    await expect(client.listProjectTabs('p1')).rejects.toMatchObject({
      name: 'TabsClientError',
      code: 'missing_bearer',
      status: 401,
    });
  });

  it('maps a network throw to a TabsClientError(network)', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const client = new TabsClient({ base_url: 'https://gw.example', token: 't' });
    await expect(client.listProjectTabs('p1')).rejects.toBeInstanceOf(TabsClientError);
  });
});
