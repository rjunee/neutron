/**
 * @neutronai/app — work-board-client unit tests (Work Board Phase 1b).
 *
 * Round-trips the typed `WorkBoardClient` against an injected `fetchImpl` so the
 * wire shape (method, path, headers, body) + error mapping are exercised without
 * a live gateway. Mirrors `tasks-client.test.ts`.
 */

import { describe, expect, it } from 'bun:test';

import {
  WorkBoardClient,
  WorkBoardClientError,
  parseWorkBoardItems,
  type WorkBoardItem,
} from '../lib/work-board-client';

const BASE = 'https://t.neutron.test';
const TOKEN = 'dev:sam';

function item(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'w1',
    project_slug: 't',
    title: 'Item',
    status: 'upcoming',
    sort_order: 1,
    design_doc_ref: null,
    inline_active: false,
    linked_run_id: null,
    created_at: '2026-06-20T00:00:00Z',
    updated_at: '2026-06-20T00:00:00Z',
    completed_at: null,
    ...over,
  };
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stub(res: { status: number; body: unknown }): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      const headers: Record<string, string> = {};
      const h = init?.headers as Record<string, string> | undefined;
      if (h !== undefined) for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k] as string;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers,
        body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify(res.body), {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

function make(res: { status: number; body: unknown }) {
  const s = stub(res);
  return { client: new WorkBoardClient({ base_url: BASE, token: TOKEN, fetchImpl: s.fetchImpl }), calls: s.calls };
}

describe('WorkBoardClient', () => {
  it('list GETs the board with the bearer', async () => {
    const { client, calls } = make({ status: 200, body: { ok: true, items: [item()], project_id: 'p' } });
    const items = await client.list('p');
    expect(items).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/p/work-board`);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('create POSTs the title', async () => {
    const { client, calls } = make({ status: 201, body: { ok: true, item: item({ title: 'New' }) } });
    const created = await client.create('p', { title: 'New' });
    expect(created.title).toBe('New');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ title: 'New' });
  });

  it('update PATCHes /work-board/<id>', async () => {
    const { client, calls } = make({ status: 200, body: { ok: true, item: item() } });
    await client.update('p', 'w1', { status: 'in_progress' });
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/p/work-board/w1`);
    expect(calls[0]!.body).toEqual({ status: 'in_progress' });
  });

  it('complete POSTs /complete', async () => {
    const { client, calls } = make({ status: 200, body: { ok: true, item: item({ status: 'done' }) } });
    await client.complete('p', 'w1');
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/p/work-board/w1/complete`);
  });

  it('reorder POSTs /reorder with target and returns the board', async () => {
    const { client, calls } = make({ status: 200, body: { ok: true, items: [item()], project_id: 'p' } });
    const rows = await client.reorder('p', 'w1', { after: 'w2' });
    expect(rows).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/p/work-board/w1/reorder`);
    expect(calls[0]!.body).toEqual({ after: 'w2' });
  });

  it('delete DELETEs /work-board/<id>', async () => {
    const { client, calls } = make({ status: 200, body: { ok: true, deleted: 'w1' } });
    await client.delete('p', 'w1');
    expect(calls[0]!.method).toBe('DELETE');
  });

  it('maps a 4xx to a typed WorkBoardClientError', async () => {
    const { client } = make({ status: 400, body: { ok: false, code: 'invalid_title', message: 'bad' } });
    await expect(client.create('p', { title: '' })).rejects.toBeInstanceOf(WorkBoardClientError);
  });
});

describe('parseWorkBoardItems', () => {
  it('drops malformed entries, keeps valid rows', () => {
    const out = parseWorkBoardItems([
      item({ id: 'a' }),
      { id: '', title: 'x' },
      { id: 'b', title: 'x', status: 'nope' },
      42,
    ]);
    expect(out.map((i) => i.id)).toEqual(['a']);
  });

  it('returns [] for a non-array', () => {
    expect(parseWorkBoardItems(null)).toEqual([]);
  });
});
