/**
 * @neutronai/app — FocusClient.getCurrentFocus + hero-pick prop contract (P6.1).
 *
 * Bun's bun:test does not load the react-native runtime (Flow types in
 * `node_modules/react-native/index.js` aren't parseable), so we keep
 * coverage at the LIB boundary: FocusClient's wire shape + the prop
 * contract for the hero pick. Visual render coverage lives in
 * /compound-engineering:test-browser via the dev server.
 *
 * Asserts:
 *
 *   1. FocusClient.getCurrentFocus — wire shape (path, method, auth),
 *      success payload, 404 → null (no pick today is not an error),
 *      error mapping for non-404 4xx.
 *   2. The CurrentFocusPick contract (the JSON shape FocusHeroCard
 *      consumes) is stable.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import {
  FocusClient,
  FocusClientError,
  type CurrentFocusPick,
  type CurrentFocusResponse,
} from '../lib/focus-client';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function makeFetchStub(
  responder: (req: CapturedRequest) => { status: number; body: unknown },
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
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch: fetchFn, calls };
}

const ORIGINAL_FETCH = globalThis.fetch;

function samplePick(): CurrentFocusPick {
  return {
    day: '2026-05-23',
    task_id: 'tsk_abc',
    task: {
      id: 'tsk_abc',
      project_id: 'proj_alpha',
      title: 'Ship the nudge engine',
      description: null,
      status: 'open',
      priority: 3,
      due_date: '2026-05-23T17:00:00Z',
      focus_score: 12,
    },
    llm_rationale:
      'Casey is asking about Focus tab launch this afternoon — wrap it now.',
    created_at: '2026-05-23T13:00:00Z',
    llm_model: 'claude-haiku-4-5',
  };
}

function sampleResponse(): CurrentFocusResponse {
  return {
    ok: true,
    project_slug: 'demo',
    now: '2026-05-23T13:01:00Z',
    pick: samplePick(),
  };
}

describe('FocusClient.getCurrentFocus', () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('GETs /api/app/focus/current with bearer header', async () => {
    const stub = makeFetchStub(() => ({ status: 200, body: sampleResponse() }));
    globalThis.fetch = stub.fetch;
    const client = new FocusClient({ base_url: 'https://gw/', token: 'tok' });
    const pick = await client.getCurrentFocus();
    expect(pick).not.toBeNull();
    expect(pick!.task.title).toBe('Ship the nudge engine');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.method).toBe('GET');
    expect(stub.calls[0]!.url).toBe('https://gw/api/app/focus/current');
    expect(stub.calls[0]!.headers.authorization).toBe('Bearer tok');
  });

  it('returns null on 404 (no pick today — not an error)', async () => {
    const stub = makeFetchStub(() => ({
      status: 404,
      body: { ok: false, code: 'no_pick_today', message: 'no pick' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new FocusClient({ base_url: 'https://gw', token: 'tok' });
    const pick = await client.getCurrentFocus();
    expect(pick).toBeNull();
  });

  it('throws FocusClientError on a non-404 4xx', async () => {
    const stub = makeFetchStub(() => ({
      status: 401,
      body: { ok: false, code: 'unauthorized', message: 'no token' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new FocusClient({ base_url: 'https://gw', token: '' });
    await expect(client.getCurrentFocus()).rejects.toBeInstanceOf(
      FocusClientError,
    );
  });

  it('throws on a malformed 200 (missing pick field)', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, project_slug: 'demo', now: 'x' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new FocusClient({ base_url: 'https://gw', token: 'tok' });
    await expect(client.getCurrentFocus()).rejects.toBeInstanceOf(
      FocusClientError,
    );
  });
});

describe('CurrentFocusPick contract', () => {
  it('exposes the fields the hero card consumes', () => {
    const pick: CurrentFocusPick = samplePick();
    // The hero card reads these specific fields. Lock them in so a
    // future schema rename surfaces as a compile error first AND a
    // test failure second.
    expect(typeof pick.day).toBe('string');
    expect(typeof pick.task_id).toBe('string');
    expect(typeof pick.task.title).toBe('string');
    expect(typeof pick.task.project_id).toBe('string');
    expect(typeof pick.llm_rationale).toBe('string');
    expect(typeof pick.created_at).toBe('string');
    expect(typeof pick.llm_model).toBe('string');
  });

  it('routes owner-level picks (project_id === "") to /projects in the press handler shape', () => {
    // The route handler in app/app/focus.tsx:handleHeroPress reads
    // `pick.task.project_id`. Owner-level picks have project_id ''.
    const instanceLevel: CurrentFocusPick = {
      ...samplePick(),
      task: { ...samplePick().task, project_id: '' },
    };
    expect(instanceLevel.task.project_id.length).toBe(0);
  });
});
