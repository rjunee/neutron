/**
 * @neutronai/app — restore-UI helper + client tests (P7.4 restore UI).
 *
 * Convention note (matching `comments-side-pane.test.tsx`):
 * the Neutron app's bun:test suite does NOT mount React Native
 * components — `react-native` is not loaded in the test runtime.
 * Render-level coverage is provided by the agent-browser smoke
 * pass in the integration step.
 *
 * What this file covers:
 *
 *   1. `BackupsClient` — wire shape (method, URL, body) for
 *      listSnapshots / previewSnapshot / getSnapshotFile /
 *      getSnapshotDiff / restore. Success + error mapping.
 *   2. `formatRelativeTime` — relative-time formatting.
 *   3. `groupSnapshotsByDay` — day-bucketed grouping + labels
 *      (Today / Yesterday / MMM D / MMM D YYYY).
 *
 * NOT covered here (acceptable — agent-browser smoke handles render):
 *   - Mounting the BackupsTab screen and exercising tap → preview.
 *   - The restore confirmation modal accept/cancel keyboard nav.
 *   - The undo banner enter/exit animation.
 *
 * Time-dependent test discipline (Neutron CLAUDE.md hard rule):
 *   - Every fixture timestamp is computed from `Date.now()`-relative
 *     deltas. No hardcoded `2026-xx-xxT...` ISO strings.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  BackupsClient,
  BackupsClientError,
  formatRelativeTime,
  groupSnapshotsByDay,
  type SnapshotSummary,
} from '../lib/backups-client';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeFetchStub(
  responder: (req: CapturedRequest) => {
    status: number;
    body: unknown;
  } | Error,
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

function fakeSnap(sha: string, message: string, ago_ms: number): SnapshotSummary {
  return {
    sha,
    parent_sha: null,
    message,
    author_date: new Date(Date.now() - ago_ms).toISOString(),
    shortstat: null,
  };
}

describe('BackupsClient', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = () => {
      globalThis.fetch = originalFetch;
    };
  });
  afterEach(() => restore());

  it('listSnapshots issues GET /api/app/projects/<id>/backups + parses the page', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: {
        ok: true,
        snapshots: [fakeSnap('a'.repeat(40), 'backup: t1', 1000)],
        next_cursor: 'b'.repeat(40),
      },
    }));
    globalThis.fetch = stub.fetch;
    const client = new BackupsClient({
      base_url: 'http://example.test',
      token: 'dev:sam',
    });
    const page = await client.listSnapshots('neutron', { limit: 25 });
    expect(page.snapshots).toHaveLength(1);
    expect(page.next_cursor).toBe('b'.repeat(40));
    const [call] = stub.calls;
    expect(call.url).toBe(
      'http://example.test/api/app/projects/neutron/backups?limit=25',
    );
    expect(call.method).toBe('GET');
    expect(call.headers['authorization']).toBe('Bearer dev:sam');
  });

  it('listSnapshots threads a cursor into the URL', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, snapshots: [], next_cursor: null },
    }));
    globalThis.fetch = stub.fetch;
    const client = new BackupsClient({
      base_url: 'http://example.test',
      token: 'tok',
    });
    await client.listSnapshots('p', {
      cursor: 'c'.repeat(40),
      limit: 5,
    });
    expect(stub.calls[0]!.url).toContain('cursor=' + 'c'.repeat(40));
    expect(stub.calls[0]!.url).toContain('limit=5');
  });

  it('previewSnapshot returns the preview shape unwrapped', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: {
        ok: true,
        preview: {
          sha: 'a'.repeat(40),
          parent_sha: null,
          message: 'backup: t1',
          author_date: new Date(Date.now()).toISOString(),
          files: [{ path: 'README.md', status: 'modified', size_bytes_at_sha: 64 }],
        },
      },
    }));
    globalThis.fetch = stub.fetch;
    const client = new BackupsClient({
      base_url: 'http://example.test',
      token: 't',
    });
    const preview = await client.previewSnapshot('p', 'a'.repeat(40));
    expect(preview.files[0]!.path).toBe('README.md');
    expect(stub.calls[0]!.url).toBe(
      `http://example.test/api/app/projects/p/backups/${'a'.repeat(40)}`,
    );
  });

  it('getSnapshotFile URI-encodes the path', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: {
        ok: true,
        file: {
          sha: 'a'.repeat(40),
          path: 'docs/has space.md',
          content: '# Demo',
          binary: false,
          size_bytes: 6,
          truncated: false,
        },
      },
    }));
    globalThis.fetch = stub.fetch;
    const client = new BackupsClient({
      base_url: 'http://example.test',
      token: 't',
    });
    await client.getSnapshotFile('p', 'a'.repeat(40), 'docs/has space.md');
    expect(stub.calls[0]!.url).toContain('path=docs%2Fhas%20space.md');
  });

  it('getSnapshotDiff requests the diff route', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: {
        ok: true,
        diff: {
          sha: 'a'.repeat(40),
          path: 'README.md',
          hunks: '@@ -1 +1 @@\n-a\n+b\n',
          truncated: false,
        },
      },
    }));
    globalThis.fetch = stub.fetch;
    const client = new BackupsClient({
      base_url: 'http://example.test',
      token: 't',
    });
    const diff = await client.getSnapshotDiff('p', 'a'.repeat(40), 'README.md');
    expect(diff.hunks).toContain('@@');
    expect(stub.calls[0]!.url).toContain(
      `/api/app/projects/p/backups/${'a'.repeat(40)}/diff?path=README.md`,
    );
  });

  it('restore POSTs the JSON body + returns the result shape', async () => {
    const sha = 'a'.repeat(40);
    const recovery = 'b'.repeat(40);
    const prior = 'c'.repeat(40);
    const stub = makeFetchStub((req) => {
      expect(req.method).toBe('POST');
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.body).toBe(JSON.stringify({ snapshot_sha: sha }));
      return {
        status: 200,
        body: {
          ok: true,
          restore: {
            snapshot_sha: sha,
            prior_head_sha: prior,
            recovery_commit_sha: recovery,
            file_path: null,
            completed_at_ms: Date.now(),
          },
        },
      };
    });
    globalThis.fetch = stub.fetch;
    const client = new BackupsClient({
      base_url: 'http://example.test',
      token: 't',
    });
    const r = await client.restore('p', sha);
    expect(r.recovery_commit_sha).toBe(recovery);
    expect(r.prior_head_sha).toBe(prior);
    expect(r.file_path).toBeNull();
  });

  it('restore threads file_path into the body when supplied', async () => {
    const sha = 'a'.repeat(40);
    const stub = makeFetchStub((req) => {
      expect(req.body).toBe(
        JSON.stringify({ snapshot_sha: sha, file_path: 'docs/notes.md' }),
      );
      return {
        status: 200,
        body: {
          ok: true,
          restore: {
            snapshot_sha: sha,
            prior_head_sha: 'p'.repeat(40),
            recovery_commit_sha: 'r'.repeat(40),
            file_path: 'docs/notes.md',
            completed_at_ms: Date.now(),
          },
        },
      };
    });
    globalThis.fetch = stub.fetch;
    const client = new BackupsClient({
      base_url: 'http://example.test',
      token: 't',
    });
    const r = await client.restore('p', sha, 'docs/notes.md');
    expect(r.file_path).toBe('docs/notes.md');
  });

  it('maps a 4xx response to BackupsClientError', async () => {
    const stub = makeFetchStub(() => ({
      status: 404,
      body: { ok: false, code: 'snapshot_not_found', message: 'no such sha' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new BackupsClient({
      base_url: 'http://example.test',
      token: 't',
    });
    try {
      await client.previewSnapshot('p', 'a'.repeat(40));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BackupsClientError);
      const e = err as BackupsClientError;
      expect(e.code).toBe('snapshot_not_found');
      expect(e.status).toBe(404);
    }
  });

  it('strips trailing slashes from base_url', async () => {
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, snapshots: [], next_cursor: null },
    }));
    globalThis.fetch = stub.fetch;
    const client = new BackupsClient({
      base_url: 'http://example.test/',
      token: 't',
    });
    await client.listSnapshots('p');
    expect(stub.calls[0]!.url).toBe(
      'http://example.test/api/app/projects/p/backups',
    );
  });
});

describe('formatRelativeTime', () => {
  it('returns "just now" for < 1m', () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now - 5_000).toISOString(), now)).toBe(
      'just now',
    );
  });

  it('returns Nm ago for under one hour', () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now - 12 * 60_000).toISOString(), now)).toBe(
      '12m ago',
    );
  });

  it('returns Nh ago under one day', () => {
    const now = Date.now();
    expect(
      formatRelativeTime(new Date(now - 5 * 3_600_000).toISOString(), now),
    ).toBe('5h ago');
  });

  it('returns Nd ago under one week', () => {
    const now = Date.now();
    expect(
      formatRelativeTime(new Date(now - 3 * 86_400_000).toISOString(), now),
    ).toBe('3d ago');
  });

  it('falls back to YYYY-MM-DD past one week', () => {
    const now = Date.now();
    const out = formatRelativeTime(
      new Date(now - 20 * 86_400_000).toISOString(),
      now,
    );
    expect(/^\d{4}-\d{2}-\d{2}$/.test(out)).toBe(true);
  });

  it('returns the input verbatim when the ISO is malformed', () => {
    expect(formatRelativeTime('not-an-iso', Date.now())).toBe('not-an-iso');
  });
});

describe('groupSnapshotsByDay', () => {
  it('returns [] on empty input', () => {
    expect(groupSnapshotsByDay([], Date.now())).toEqual([]);
  });

  it('labels today / yesterday correctly', () => {
    const now = Date.now();
    // Yesterday means "the calendar day before today's local date". A fixed N-hour
    // offset isn't safe — at 02:00 local, 27 h ago lands 2 calendar days back.
    // Anchor on noon-yesterday (start-of-today minus 12 h) so the label is wall-
    // clock-stable regardless of when the test runs.
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const yesterdayAgoMs = now - (startOfToday.getTime() - 12 * 3_600_000);
    // The two "today" snapshots must also be anchored to the local calendar
    // day, not a fixed N-ms offset: a snapshot "60 s ago" lands in YESTERDAY
    // when the test runs in the first minute after local midnight (the CI
    // runner's tz is UTC and a run at 00:00:30 made today-2 cross the
    // boundary). Anchor both within [startOfToday, now] — start-of-today and
    // the midpoint to now — so they are always today, in any tz, at any hour.
    const elapsedToday = now - startOfToday.getTime();
    const todayOldAgoMs = elapsedToday; // exactly local midnight today
    const todayNewAgoMs = Math.floor(elapsedToday / 2); // midday-ish, more recent
    const groups = groupSnapshotsByDay(
      [
        fakeSnap('a'.repeat(40), 'today-1', todayNewAgoMs),
        fakeSnap('b'.repeat(40), 'today-2', todayOldAgoMs),
        fakeSnap('c'.repeat(40), 'yest', yesterdayAgoMs),
      ],
      now,
    );
    expect(groups[0]!.label).toBe('Today');
    expect(groups[0]!.snapshots).toHaveLength(2);
    expect(groups[1]!.label).toBe('Yesterday');
    expect(groups[1]!.snapshots).toHaveLength(1);
  });

  it('formats older days as "MMM D" within current year', () => {
    const now = Date.now();
    const groups = groupSnapshotsByDay(
      [fakeSnap('a'.repeat(40), 'older', 30 * 86_400_000)],
      now,
    );
    expect(groups[0]!.snapshots).toHaveLength(1);
    expect(/^[A-Z][a-z]{2} \d{1,2}$|^[A-Z][a-z]{2} \d{1,2} \d{4}$/.test(groups[0]!.label)).toBe(true);
  });

  it('preserves snapshot order within a day', () => {
    const now = Date.now();
    // Anchor all three within today (same midnight-boundary safety as the
    // today/yesterday test) so they cannot split across days in the first
    // seconds after local midnight.
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const elapsedToday = now - startOfToday.getTime();
    const groups = groupSnapshotsByDay(
      [
        fakeSnap('a'.repeat(40), 'first', Math.floor(elapsedToday * 0.25)),
        fakeSnap('b'.repeat(40), 'second', Math.floor(elapsedToday * 0.5)),
        fakeSnap('c'.repeat(40), 'third', Math.floor(elapsedToday * 0.75)),
      ],
      now,
    );
    expect(groups[0]!.snapshots.map((s) => s.message)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});
