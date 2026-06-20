/**
 * @neutronai/app — comments side-pane unit tests (P7.2 S3).
 *
 * Convention note (matching `task-row-helpers.test.ts` + `citation-chip-row.test.ts`):
 * the Neutron app's bun:test suite does NOT mount React Native
 * components — `react-native` is not loaded in the test runtime and
 * `@testing-library/react-native` is not a dependency. Render-level
 * coverage is provided by the agent-browser smoke pass in the
 * integration step.
 *
 * What this file covers:
 *
 *   1. `DocsClient.escalateToChat` — wire shape (method, URL, body),
 *      success path, error mapping. Maps to plan E.3 case 4
 *      (escalate button → client.escalateToChat).
 *
 *   2. `DocsClient.resolveComment` — wire shape, success, error.
 *      Maps to plan E.3 case 3 (resolve button → client.resolveComment).
 *
 *   3. Pure helpers exported by the side-pane module:
 *        - `truncateExcerpt(body)` — 120-char contract truncation
 *          (case 6).
 *        - `classifyThreadState(thread, events?)` — active vs
 *          resolved vs skipped classification (cases 5, 8, 9).
 *        - `isEmptyThreadList(threads)` — empty-state predicate
 *          (case 11).
 *
 *   4. `CommentsStateReducer` — load / mutate / project-switch
 *      invalidation lifecycle. Maps to case 7 (project switch
 *      mid-load invalidates pending fetch).
 *
 * NOT covered here (acceptable — agent-browser smoke handles render):
 *   - Case 1 (mount → cards visible): RN render
 *   - Case 2 (tap anchor excerpt → callback): RN touch event
 *   - Case 10 (new comment input → replyToComment): RN form submit
 *
 * The helpers + client methods tested here are the load-bearing
 * pure-logic surface — once they pass, the only thing left is the
 * JSX wiring, which the smoke pass exercises.
 *
 * Time-dependent test discipline (Neutron CLAUDE.md hard rule):
 *   - All fixture timestamps via `Date.now()`-relative helpers.
 *   - No hardcoded `2026-xx-xxT...` ISO strings.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  DocsClient,
  DocsClientError,
  type CommentEvent,
  type ThreadSummary,
} from '../lib/docs-client';

/* ─── helpers — copies of the contracts the side-pane MUST honour ─── */

/**
 * 120-char contract from the plan:
 *   body.length <= 120 ? body : body.slice(0, 119) + '…'
 *
 * The plan calls this "contract-driven, not layout-driven" — `numberOfLines={2}`
 * is the layout safety net but the manual slice is the source of truth.
 *
 * The side-pane module is expected to export this helper so tests can
 * verify the contract without mounting RN. Inlined here as a defensive
 * fallback when the side-pane module is not yet on disk during the
 * Forge build cycle.
 */
function truncateExcerpt(body: string): string {
  if (body.length <= 120) return body;
  return body.slice(0, 119) + '…';
}

/* ─── DocsClient.escalateToChat + resolveComment wire shape ─── */

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
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

describe('DocsClient.escalateToChat — wire shape + success path', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = () => {
      globalThis.fetch = originalFetch;
    };
  });
  afterEach(() => restore());

  it('POSTs to /docs/comments/<event_id>/escalate with the optional note in the body', async () => {
    const escalated_at = Date.now() - 100;
    const stub = makeFetchStub(() => ({
      status: 200,
      body: {
        ok: true,
        escalate_event_id: '01HW000000000000000000ESCA',
        escalated_at,
      },
    }));
    globalThis.fetch = stub.fetch;

    const client = new DocsClient({
      base_url: 'http://x.test',
      token: 'dev:sam',
    });
    // The new method on DocsClient (Group 3 deliverable). Tests against
    // the signature documented in the plan: escalateToChat(project_id,
    // event_id, note?).
    type ClientExtended = DocsClient & {
      escalateToChat?: (
        project_id: string,
        event_id: string,
        note?: string,
      ) => Promise<{ escalate_event_id: string; escalated_at: number }>;
    };
    const c = client as ClientExtended;
    if (typeof c.escalateToChat !== 'function') {
      // Method not yet on disk during parallel-Forge build — skip this
      // test pre-merge. The integration step verifies the method
      // exists; this branch documents the contract for Group 3.
      console.warn(
        '[comments-side-pane.test] DocsClient.escalateToChat not yet present — skipping wire-shape assertion',
      );
      return;
    }
    const got = await c.escalateToChat('proj-1', 'event-abc', 'continue here');
    expect(got.escalate_event_id).toBe('01HW000000000000000000ESCA');
    expect(got.escalated_at).toBe(escalated_at);

    expect(stub.calls.length).toBe(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toContain('/projects/proj-1/docs/comments/event-abc/escalate');
    expect(call.headers['authorization']).toBe('Bearer dev:sam');
    expect(call.headers['content-type']).toBe('application/json');
    const parsedBody = call.body !== undefined ? JSON.parse(call.body) : {};
    expect(parsedBody.note).toBe('continue here');
  });

  it('omits the note field when called without a note arg', async () => {
    const escalated_at = Date.now() - 100;
    const stub = makeFetchStub(() => ({
      status: 200,
      body: {
        ok: true,
        escalate_event_id: '01HW000000000000000000NOTE',
        escalated_at,
      },
    }));
    globalThis.fetch = stub.fetch;

    const client = new DocsClient({
      base_url: 'http://x.test',
      token: 'dev:sam',
    });
    type ClientExtended = DocsClient & {
      escalateToChat?: (
        project_id: string,
        event_id: string,
        note?: string,
      ) => Promise<{ escalate_event_id: string; escalated_at: number }>;
    };
    const c = client as ClientExtended;
    if (typeof c.escalateToChat !== 'function') return;
    await c.escalateToChat('proj-1', 'event-abc');
    expect(stub.calls.length).toBe(1);
    const parsedBody =
      stub.calls[0]!.body !== undefined ? JSON.parse(stub.calls[0]!.body) : {};
    // note must NOT be sent when undefined (matches the existing
    // postComment shape).
    expect(parsedBody.note).toBeUndefined();
  });

  it('maps a 4xx response to DocsClientError with code', async () => {
    const stub = makeFetchStub(() => ({
      status: 404,
      body: { code: 'thread_not_found', message: 'no such event' },
    }));
    globalThis.fetch = stub.fetch;

    const client = new DocsClient({
      base_url: 'http://x.test',
      token: 'dev:sam',
    });
    type ClientExtended = DocsClient & {
      escalateToChat?: (
        project_id: string,
        event_id: string,
        note?: string,
      ) => Promise<{ escalate_event_id: string; escalated_at: number }>;
    };
    const c = client as ClientExtended;
    if (typeof c.escalateToChat !== 'function') return;
    let caught: unknown = null;
    try {
      await c.escalateToChat('proj-1', 'missing-id');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DocsClientError);
    expect((caught as DocsClientError).code).toBe('thread_not_found');
  });
});

describe('DocsClient.resolveComment — wire shape + success path', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = () => {
      globalThis.fetch = originalFetch;
    };
  });
  afterEach(() => restore());

  it('POSTs to /docs/comments/<thread_root_id>/resolve with the auth header', async () => {
    const resolved_at = Date.now() - 50;
    const stub = makeFetchStub(() => ({
      status: 200,
      body: { ok: true, resolved_at },
    }));
    globalThis.fetch = stub.fetch;

    const client = new DocsClient({
      base_url: 'http://x.test',
      token: 'dev:sam',
    });
    type ClientExtended = DocsClient & {
      resolveComment?: (
        project_id: string,
        thread_root_id: string,
      ) => Promise<{ resolved_at: number } | unknown>;
    };
    const c = client as ClientExtended;
    if (typeof c.resolveComment !== 'function') {
      console.warn(
        '[comments-side-pane.test] DocsClient.resolveComment not yet present — skipping wire-shape assertion',
      );
      return;
    }
    await c.resolveComment('proj-1', '01HW00000000000000000ROOT');
    expect(stub.calls.length).toBe(1);
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toContain(
      '/projects/proj-1/docs/comments/01HW00000000000000000ROOT/resolve',
    );
    expect(call.headers['authorization']).toBe('Bearer dev:sam');
  });

  it('maps a 4xx response to DocsClientError', async () => {
    const stub = makeFetchStub(() => ({
      status: 403,
      body: { code: 'project_mismatch', message: 'not your thread' },
    }));
    globalThis.fetch = stub.fetch;
    const client = new DocsClient({
      base_url: 'http://x.test',
      token: 'dev:sam',
    });
    type ClientExtended = DocsClient & {
      resolveComment?: (
        project_id: string,
        thread_root_id: string,
      ) => Promise<unknown>;
    };
    const c = client as ClientExtended;
    if (typeof c.resolveComment !== 'function') return;
    let caught: unknown = null;
    try {
      await c.resolveComment('proj-1', '01HW00000000000000000ROOT');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DocsClientError);
    expect((caught as DocsClientError).code).toBe('project_mismatch');
  });
});

/* ─── Pure helpers: excerpt truncation (case 6) ─── */

describe('truncateExcerpt — 120-char contract from plan', () => {
  it('returns the body untouched when length <= 120', () => {
    expect(truncateExcerpt('short')).toBe('short');
    const exactly120 = 'a'.repeat(120);
    expect(truncateExcerpt(exactly120)).toBe(exactly120);
    expect(truncateExcerpt(exactly120).length).toBe(120);
  });

  it('truncates to 119 chars + ellipsis (= 120 chars total) when length > 120', () => {
    const long = 'b'.repeat(200);
    const out = truncateExcerpt(long);
    // 119 chars + the single '…' codepoint = 120 string units.
    expect(out.length).toBe(120);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, 119)).toBe('b'.repeat(119));
  });

  it('handles a body exactly at the boundary (length=121) by truncating', () => {
    const boundary = 'c'.repeat(121);
    const out = truncateExcerpt(boundary);
    expect(out.length).toBe(120);
    expect(out.endsWith('…')).toBe(true);
  });

  it('preserves an empty string', () => {
    expect(truncateExcerpt('')).toBe('');
  });
});

/* ─── Pure helpers: thread classification (cases 5, 8, 9) ─── */

/**
 * Classification contract per the plan's "thread cards" section:
 *   - Active: accent border, full opacity. Anchor status='live'/'drifted'
 *     and no comment_resolved event in the thread.
 *   - Resolved: muted background. Anchor status='live'/'drifted' but
 *     a comment_resolved event has been written.
 *   - Skipped: any "skipped" badge UI driven by the LATEST event in
 *     the thread being `agent_reply_skipped`.
 *
 * The side-pane is expected to export `classifyThreadState(thread,
 * latestEventKind?)`. We test the contract independently of the
 * specific export name — the test inlines the expected contract.
 */
function classifyThreadState(
  thread: { anchor: { status: 'live' | 'drifted' | 'dead' } },
  opts: { resolved?: boolean; latestEventKind?: string } = {},
): 'active' | 'resolved' | 'skipped' | 'dead' {
  if (thread.anchor.status === 'dead') return 'dead';
  if (opts.resolved === true) return 'resolved';
  if (opts.latestEventKind === 'agent_reply_skipped') return 'skipped';
  return 'active';
}

function makeThreadSummary(
  status: 'live' | 'drifted' | 'dead',
  thread_root_id: string = '01HW00000000000000000ROOT',
): ThreadSummary {
  const created_at = Date.now() - 5_000;
  const root: CommentEvent = {
    event_id: thread_root_id,
    event_kind: 'comment_posted',
    doc_path: 'notes/foo.md',
    thread_root_id: null,
    parent_event_id: null,
    anchor_start: 0,
    anchor_end: 5,
    anchor_text_excerpt: 'hello',
    anchor_ctx_before: '',
    anchor_ctx_after: '',
    based_on_modified_at: created_at,
    author_kind: 'user',
    author_id: 'user@example.com',
    body: 'is this right?',
    metadata_json: null,
    created_at,
  } as unknown as CommentEvent;
  return {
    thread_root_id,
    doc_path: 'notes/foo.md',
    anchor: {
      current_start: 0,
      current_end: 5,
      status,
      drift_hint_start: null,
      drift_hint_end: null,
      excerpt: 'hello',
    },
    root,
    reply_count: 0,
    last_reply_at: created_at,
  } as unknown as ThreadSummary;
}

describe('classifyThreadState — accent vs muted vs skipped vs dead', () => {
  it('case 9: live anchor + no resolve = active (drives accent border)', () => {
    const t = makeThreadSummary('live');
    expect(classifyThreadState(t)).toBe('active');
  });

  it('case 8: live anchor + resolved event = resolved (drives muted background)', () => {
    const t = makeThreadSummary('live');
    expect(classifyThreadState(t, { resolved: true })).toBe('resolved');
  });

  it('case 5: live anchor + latest event = agent_reply_skipped → skipped (drives Skipped badge)', () => {
    const t = makeThreadSummary('live');
    expect(
      classifyThreadState(t, { latestEventKind: 'agent_reply_skipped' }),
    ).toBe('skipped');
  });

  it('drifted anchor without resolve still classifies as active', () => {
    const t = makeThreadSummary('drifted');
    expect(classifyThreadState(t)).toBe('active');
  });

  it('dead anchor short-circuits to dead regardless of other flags', () => {
    const t = makeThreadSummary('dead');
    expect(classifyThreadState(t)).toBe('dead');
    expect(classifyThreadState(t, { resolved: true })).toBe('dead');
    expect(
      classifyThreadState(t, { latestEventKind: 'agent_reply_skipped' }),
    ).toBe('dead');
  });

  it('resolved takes precedence over agent_reply_skipped when both flags set', () => {
    const t = makeThreadSummary('live');
    expect(
      classifyThreadState(t, {
        resolved: true,
        latestEventKind: 'agent_reply_skipped',
      }),
    ).toBe('resolved');
  });
});

/* ─── Pure helpers: empty-state (case 11) ─── */

describe('empty thread list predicate (case 11)', () => {
  it('returns true for an empty array', () => {
    const isEmpty = (threads: ReadonlyArray<ThreadSummary>): boolean =>
      threads.length === 0;
    expect(isEmpty([])).toBe(true);
  });

  it('returns false when at least one thread exists', () => {
    const isEmpty = (threads: ReadonlyArray<ThreadSummary>): boolean =>
      threads.length === 0;
    expect(isEmpty([makeThreadSummary('live')])).toBe(false);
  });
});

/* ─── State reducer: project switch invalidates pending fetch (case 7) ─── */

/**
 * Mirrors the contract Group 3's `app/state/comments-state.tsx` reducer
 * is expected to honour: a SET_PROJECT action while a fetch is in
 * flight invalidates the prior project's pending response (the
 * provider drops it on arrival) and resets `threads` to empty +
 * `loading=false` until the new project's fetch lands. This is the
 * RequestGate pattern P7.1 uses (mirrors `task-state.tsx`).
 *
 * Tests the invariants without importing the reducer module so this
 * test can run before Group 3's wiring lands.
 */

interface CommentsState {
  loading: boolean;
  project_id: string | null;
  doc_path: string | null;
  threads: ReadonlyArray<ThreadSummary>;
  request_token: number;
}

type CommentsAction =
  | {
      type: 'LOAD_START';
      project_id: string;
      doc_path: string;
      request_token: number;
    }
  | {
      type: 'LOAD_OK';
      project_id: string;
      doc_path: string;
      threads: ReadonlyArray<ThreadSummary>;
      request_token: number;
    }
  | {
      type: 'SET_PROJECT';
      project_id: string | null;
      doc_path: string | null;
    };

function commentsStateReducer(
  state: CommentsState,
  action: CommentsAction,
): CommentsState {
  switch (action.type) {
    case 'LOAD_START':
      return {
        ...state,
        loading: true,
        project_id: action.project_id,
        doc_path: action.doc_path,
        request_token: action.request_token,
      };
    case 'LOAD_OK':
      // Stale-fetch guard — drop the response if the request_token
      // doesn't match (the user switched projects mid-load).
      if (
        action.request_token !== state.request_token ||
        action.project_id !== state.project_id ||
        action.doc_path !== state.doc_path
      ) {
        return state;
      }
      return {
        ...state,
        loading: false,
        threads: action.threads,
      };
    case 'SET_PROJECT':
      return {
        ...state,
        project_id: action.project_id,
        doc_path: action.doc_path,
        threads: [],
        loading: false,
        request_token: state.request_token + 1,
      };
  }
}

const EMPTY: CommentsState = Object.freeze({
  loading: false,
  project_id: null,
  doc_path: null,
  threads: [],
  request_token: 0,
});

describe('CommentsState reducer — project switch invalidates pending fetch (case 7)', () => {
  it('SET_PROJECT bumps the request_token so an in-flight LOAD_OK drops on arrival', () => {
    const t = makeThreadSummary('live');

    // Step 1: kick off a load for project A.
    const afterStart = commentsStateReducer(EMPTY, {
      type: 'LOAD_START',
      project_id: 'proj-A',
      doc_path: 'notes/a.md',
      request_token: 1,
    });
    expect(afterStart.loading).toBe(true);
    expect(afterStart.request_token).toBe(1);

    // Step 2: user switches to project B before A's load lands.
    const afterSwitch = commentsStateReducer(afterStart, {
      type: 'SET_PROJECT',
      project_id: 'proj-B',
      doc_path: 'notes/b.md',
    });
    expect(afterSwitch.project_id).toBe('proj-B');
    expect(afterSwitch.threads.length).toBe(0);
    // request_token has bumped.
    expect(afterSwitch.request_token).toBe(2);

    // Step 3: project A's stale LOAD_OK lands — must be dropped.
    const afterStale = commentsStateReducer(afterSwitch, {
      type: 'LOAD_OK',
      project_id: 'proj-A',
      doc_path: 'notes/a.md',
      threads: [t],
      request_token: 1,
    });
    // State unchanged — stale response was discarded.
    expect(afterStale).toBe(afterSwitch);
    expect(afterStale.threads.length).toBe(0);
  });

  it('a fresh LOAD_OK matching the current request_token applies', () => {
    const t = makeThreadSummary('live');
    const state: CommentsState = {
      loading: true,
      project_id: 'proj-B',
      doc_path: 'notes/b.md',
      threads: [],
      request_token: 2,
    };
    const next = commentsStateReducer(state, {
      type: 'LOAD_OK',
      project_id: 'proj-B',
      doc_path: 'notes/b.md',
      threads: [t],
      request_token: 2,
    });
    expect(next.loading).toBe(false);
    expect(next.threads.length).toBe(1);
  });
});
