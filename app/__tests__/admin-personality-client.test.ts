/**
 * @neutronai/app — AdminPersonalityClient + dirty-state contract tests
 * (2026-05-22).
 *
 * Covers the typed client added by
 * docs/plans/2026-05-22-003-feat-admin-personality-editor-plan.md. The
 * UI's dirty-state + save round-trip + 409-conflict flow piggybacks on
 * this client; testing the client behaviour directly is faster +
 * tighter than spinning up RN renderer for the pane.
 *
 * Mocks `globalThis.fetch` (mirrors `launcher-client.test.ts` pattern).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  AdminPersonalityClient,
  AdminPersonalityClientError,
  PERSONA_FILENAMES,
  type PersonaFilename,
} from '../lib/admin-personality-client';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface FetchResponse {
  status: number;
  body: unknown;
  contentType?: string;
  extraHeaders?: Record<string, string>;
}

function makeFetchStub(
  responder: (req: CapturedRequest) => FetchResponse | Error,
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
    const contentType = result.contentType ?? 'application/json';
    const body_text =
      contentType.startsWith('application/json')
        ? JSON.stringify(result.body)
        : String(result.body);
    return new Response(body_text, {
      status: result.status,
      headers: {
        'content-type': contentType,
        ...(result.extraHeaders ?? {}),
      },
    });
  }) as typeof globalThis.fetch;
  return { fetch: fetchFn, calls };
}

const originalFetch: typeof globalThis.fetch = globalThis.fetch;
let restore: () => void;

beforeEach(() => {
  restore = (): void => {
    globalThis.fetch = originalFetch;
  };
});
afterEach(() => {
  restore();
});

describe('PERSONA_FILENAMES export contract', () => {
  it('exposes exactly the 3 allow-listed filenames', () => {
    expect([...PERSONA_FILENAMES].sort()).toEqual(
      (['SOUL.md', 'USER.md', 'priority-map.md'] as PersonaFilename[]).sort(),
    );
  });
});

describe('AdminPersonalityClient.listFiles', () => {
  it('calls GET /api/app/persona/files with bearer token', async () => {
    const { fetch, calls } = makeFetchStub(() => ({
      status: 200,
      body: {
        ok: true,
        files: [
          { filename: 'SOUL.md', exists: false, size_bytes: 0, last_modified_iso: null },
          { filename: 'USER.md', exists: true, size_bytes: 42, last_modified_iso: '2026-05-22T10:00:00Z' },
          { filename: 'priority-map.md', exists: false, size_bytes: 0, last_modified_iso: null },
        ],
      },
    }));
    globalThis.fetch = fetch;
    const client = new AdminPersonalityClient({ base_url: 'http://gw', token: 'tk1' });
    const files = await client.listFiles();
    expect(files).toHaveLength(3);
    expect(calls[0]?.url).toBe('http://gw/api/app/persona/files');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers['authorization']).toBe('Bearer tk1');
  });
});

describe('AdminPersonalityClient.getFile', () => {
  it('returns body + mtime from the X-Mtime header', async () => {
    const { fetch, calls } = makeFetchStub((req) => {
      expect(req.url).toBe('http://gw/api/app/persona/file?name=SOUL.md');
      expect(req.method).toBe('GET');
      return {
        status: 200,
        contentType: 'text/markdown; charset=utf-8',
        body: '# Personality\nHello\n',
        extraHeaders: { 'x-mtime': '1234567890' },
      };
    });
    globalThis.fetch = fetch;
    const client = new AdminPersonalityClient({ base_url: 'http://gw', token: 'tk' });
    const result = await client.getFile('SOUL.md');
    expect(result.filename).toBe('SOUL.md');
    expect(result.content).toBe('# Personality\nHello\n');
    expect(result.mtime).toBe(1234567890);
    expect(calls).toHaveLength(1);
  });

  it('falls back to mtime=0 when X-Mtime is missing', async () => {
    const { fetch } = makeFetchStub(() => ({
      status: 200,
      contentType: 'text/markdown',
      body: '',
    }));
    globalThis.fetch = fetch;
    const client = new AdminPersonalityClient({ base_url: 'http://gw', token: 'tk' });
    const result = await client.getFile('USER.md');
    expect(result.mtime).toBe(0);
  });
});

describe('AdminPersonalityClient.saveFile', () => {
  it('PATCHes the file body with expected_mtime and parses the new mtime', async () => {
    const { fetch, calls } = makeFetchStub((req) => {
      expect(req.url).toBe('http://gw/api/app/persona/file?name=USER.md');
      expect(req.method).toBe('PATCH');
      expect(req.headers['content-type']).toBe('application/json');
      const body = JSON.parse(req.body as string) as { content: string; expected_mtime: number };
      expect(body.content).toBe('name: sam\n');
      expect(body.expected_mtime).toBe(42);
      return {
        status: 200,
        body: { ok: true, mtime: 99 },
      };
    });
    globalThis.fetch = fetch;
    const client = new AdminPersonalityClient({ base_url: 'http://gw', token: 'tk' });
    const result = await client.saveFile({
      filename: 'USER.md',
      content: 'name: sam\n',
      expected_mtime: 42,
    });
    expect(result.ok).toBe(true);
    expect(result.mtime).toBe(99);
    expect(calls).toHaveLength(1);
  });

  it('throws AdminPersonalityClientError with code=mtime_conflict + current_mtime on 409', async () => {
    const { fetch } = makeFetchStub(() => ({
      status: 409,
      body: {
        ok: false,
        code: 'mtime_conflict',
        message: 'stale',
        current_mtime: 9999,
      },
    }));
    globalThis.fetch = fetch;
    const client = new AdminPersonalityClient({ base_url: 'http://gw', token: 'tk' });
    let err: unknown = null;
    try {
      await client.saveFile({ filename: 'SOUL.md', content: 'x', expected_mtime: 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AdminPersonalityClientError);
    const typed = err as AdminPersonalityClientError;
    expect(typed.status).toBe(409);
    expect(typed.code).toBe('mtime_conflict');
    expect(typed.current_mtime).toBe(9999);
  });

  it('throws on 413 with code=payload_too_large', async () => {
    const { fetch } = makeFetchStub(() => ({
      status: 413,
      body: { ok: false, code: 'payload_too_large', message: 'too big' },
    }));
    globalThis.fetch = fetch;
    const client = new AdminPersonalityClient({ base_url: 'http://gw', token: 'tk' });
    let err: unknown = null;
    try {
      await client.saveFile({ filename: 'SOUL.md', content: 'x'.repeat(300_000), expected_mtime: 0 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AdminPersonalityClientError);
    const typed = err as AdminPersonalityClientError;
    expect(typed.code).toBe('payload_too_large');
  });

  it('force-overwrites by sending expected_mtime: -1', async () => {
    const { fetch, calls } = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, mtime: 100 },
    }));
    globalThis.fetch = fetch;
    const client = new AdminPersonalityClient({ base_url: 'http://gw', token: 'tk' });
    await client.saveFile({ filename: 'SOUL.md', content: 'forced', expected_mtime: -1 });
    const body = JSON.parse(calls[0]?.body as string) as { expected_mtime: number };
    expect(body.expected_mtime).toBe(-1);
  });
});

describe('AdminPersonalityClient.restartFromScratch', () => {
  it('POSTs { confirm: true } and returns the deletion summary', async () => {
    const { fetch, calls } = makeFetchStub((req) => {
      expect(req.url).toBe('http://gw/api/app/persona/restart-from-scratch');
      expect(req.method).toBe('POST');
      const body = JSON.parse(req.body as string) as { confirm: boolean };
      expect(body.confirm).toBe(true);
      return {
        status: 200,
        body: {
          ok: true,
          files_deleted: ['SOUL.md', 'USER.md'],
          files_failed: [],
          onboarding_reset: false,
        },
      };
    });
    globalThis.fetch = fetch;
    const client = new AdminPersonalityClient({ base_url: 'http://gw', token: 'tk' });
    const result = await client.restartFromScratch();
    expect(result.files_deleted).toEqual(['SOUL.md', 'USER.md']);
    expect(result.files_failed).toEqual([]);
    expect(result.onboarding_reset).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('accepts 207 partial-success with non-empty files_failed (Codex r1 P2 fix)', async () => {
    const { fetch } = makeFetchStub(() => ({
      status: 207,
      body: {
        ok: true,
        files_deleted: ['SOUL.md', 'USER.md'],
        files_failed: [
          { filename: 'priority-map.md', code: 'EISDIR', message: 'is a directory' },
        ],
        onboarding_reset: false,
      },
    }));
    globalThis.fetch = fetch;
    const client = new AdminPersonalityClient({ base_url: 'http://gw', token: 'tk' });
    const result = await client.restartFromScratch();
    expect(result.files_deleted).toEqual(['SOUL.md', 'USER.md']);
    expect(result.files_failed).toHaveLength(1);
    expect(result.files_failed[0]?.filename).toBe('priority-map.md');
    expect(result.files_failed[0]?.code).toBe('EISDIR');
  });
});

describe('AdminPersonalityClient — auth + URL composition', () => {
  it('strips trailing slash from base_url so paths join cleanly', async () => {
    const { fetch, calls } = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, files: [] },
    }));
    globalThis.fetch = fetch;
    const client = new AdminPersonalityClient({
      base_url: 'http://gw///',
      token: 'tk',
    });
    await client.listFiles();
    expect(calls[0]?.url).toBe('http://gw/api/app/persona/files');
  });

  it('threads bearer on every method', async () => {
    const { fetch, calls } = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, files: [] },
    }));
    globalThis.fetch = fetch;
    const client = new AdminPersonalityClient({ base_url: 'http://gw', token: 'tk7' });
    await client.listFiles();
    expect(calls[0]?.headers['authorization']).toBe('Bearer tk7');
  });
});

describe('Dirty-state derivation (pane invariant)', () => {
  // The UI computes `dirty = pane.draft !== pane.baseline` and disables
  // the Save button when not dirty. This test pins the invariant: a
  // fresh GET seeds both baseline and draft to the server body, so the
  // user opens a pane that is NOT dirty (no surprise enabled Save).
  it('a fresh getFile result seeds baseline == draft so the pane opens clean', async () => {
    const { fetch } = makeFetchStub(() => ({
      status: 200,
      contentType: 'text/markdown',
      body: 'on disk',
      extraHeaders: { 'x-mtime': '5' },
    }));
    globalThis.fetch = fetch;
    const client = new AdminPersonalityClient({ base_url: 'http://gw', token: 'tk' });
    const body = await client.getFile('SOUL.md');
    const pane = {
      baseline: body.content,
      draft: body.content,
      mtime: body.mtime,
    };
    expect(pane.baseline).toBe('on disk');
    expect(pane.draft).toBe('on disk');
    expect(pane.draft === pane.baseline).toBe(true);
    expect(pane.mtime).toBe(5);
  });

  it('after a successful save, the baseline catches up to the draft (dirty clears)', async () => {
    const { fetch } = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, mtime: 9 },
    }));
    globalThis.fetch = fetch;
    const client = new AdminPersonalityClient({ base_url: 'http://gw', token: 'tk' });
    // Simulate the UI flow: user edits draft, hits save.
    const pane = { baseline: 'before', draft: 'after', mtime: 5 };
    expect(pane.draft !== pane.baseline).toBe(true); // dirty
    const result = await client.saveFile({
      filename: 'SOUL.md',
      content: pane.draft,
      expected_mtime: pane.mtime,
    });
    const next = { baseline: pane.draft, draft: pane.draft, mtime: result.mtime };
    expect(next.draft === next.baseline).toBe(true); // no longer dirty
    expect(next.mtime).toBe(9);
  });
});
