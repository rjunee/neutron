/**
 * @neutronai/app — the GENERAL scope's Work Board reaches the server (ISSUES: the
 * mobile Work tab rendered `invalid_project_id` for General).
 *
 * THE THREE SPELLINGS OF GENERAL meet here, exactly as they do in
 * `lib/activity-client.ts` — and this is the boundary that got them wrong:
 *
 *   - the mobile RAIL id / route segment is `'~general'` (`GENERAL_PROJECT_ID`),
 *   - the shared client-side CHAT SCOPE is `''` (`railIdToScope`),
 *   - the Work Board's HTTP path segment is `'general'`
 *     (`work-board/store.ts` `workBoardScopeKey(owner, 'general') → owner`).
 *
 * `~` is NOT in the gateway's `[A-Za-z0-9_.-]` project-id alphabet
 * (`channels/adapters/app-ws/envelope.ts` `sanitizeProjectId`), so sending the
 * raw rail sentinel down the wire is a guaranteed 400 — General's board is real
 * and reachable, the mobile client was simply asking for it under a name the
 * server cannot spell. The web client has always normalised at the URL boundary
 * (`landing/chat-react/work-board-client.ts` `workBoardPathSegment`); these
 * pin the mobile twin to the same behaviour.
 */

import { describe, expect, it } from 'bun:test';

import {
  GENERAL_WORK_BOARD_PROJECT_ID,
  WorkBoardClient,
  workBoardPathSegment,
  type WorkBoardItem,
} from '../lib/work-board-client';
import { boardErrorCopy } from '../lib/work-board-helpers';

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

function make(res: { status: number; body: unknown }) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { client: new WorkBoardClient({ base_url: BASE, token: TOKEN, fetchImpl }), calls };
}

describe('workBoardPathSegment — the URL boundary for General', () => {
  it('maps BOTH client-side General spellings onto the server id', () => {
    expect(workBoardPathSegment('~general')).toBe(GENERAL_WORK_BOARD_PROJECT_ID);
    expect(workBoardPathSegment('')).toBe(GENERAL_WORK_BOARD_PROJECT_ID);
  });

  it('leaves a real project id alone — including one that merely CONTAINS the sentinel', () => {
    expect(workBoardPathSegment('acme')).toBe('acme');
    // Not a substring match: a project genuinely called `general` is already the
    // server spelling, and `~general-notes` is somebody else's project.
    expect(workBoardPathSegment('~general-notes')).toBe('~general-notes');
    expect(workBoardPathSegment('general')).toBe('general');
  });
});

describe('WorkBoardClient — General never sends the raw rail sentinel', () => {
  it('list() on the rail sentinel hits the general board, not `/~general/`', async () => {
    const { client, calls } = make({
      status: 200,
      body: { ok: true, items: [item()], project_id: 'general' },
    });
    await client.list('~general');
    expect(calls[0]).toBe(`GET ${BASE}/api/app/projects/general/work-board`);
    // The literal shape that produced the on-device `invalid_project_id` pane.
    expect(calls[0]).not.toContain('~general');
    expect(calls[0]).not.toContain('%7Egeneral');
  });

  it('list() on the empty chat scope hits the general board, not a `//` double slash', async () => {
    const { client, calls } = make({ status: 200, body: { ok: true, items: [], project_id: 'general' } });
    await client.list('');
    expect(calls[0]).toBe(`GET ${BASE}/api/app/projects/general/work-board`);
  });

  it('normalises on EVERY mutating route, not just the read', async () => {
    const created = make({ status: 201, body: { ok: true, item: item() } });
    await created.client.create('~general', { title: 'New' });
    expect(created.calls[0]).toBe(`POST ${BASE}/api/app/projects/general/work-board`);

    const patched = make({ status: 200, body: { ok: true, item: item() } });
    await patched.client.update('~general', 'w1', { title: 'Edited' });
    expect(patched.calls[0]).toBe(`PATCH ${BASE}/api/app/projects/general/work-board/w1`);

    const done = make({ status: 200, body: { ok: true, item: item({ status: 'done' }) } });
    await done.client.complete('~general', 'w1');
    expect(done.calls[0]).toBe(`POST ${BASE}/api/app/projects/general/work-board/w1/complete`);

    const moved = make({ status: 200, body: { ok: true, items: [], project_id: 'general' } });
    await moved.client.reorder('~general', 'w1', { before: 'w2' });
    expect(moved.calls[0]).toBe(`POST ${BASE}/api/app/projects/general/work-board/w1/reorder`);

    const started = make({ status: 200, body: { ok: true, run_id: 'r1' } });
    await started.client.start('~general', 'w1');
    expect(started.calls[0]).toBe(`POST ${BASE}/api/app/projects/general/work-board/w1/start`);

    const gone = make({ status: 200, body: { ok: true, deleted: 'w1' } });
    await gone.client.delete('~general', 'w1');
    expect(gone.calls[0]).toBe(`DELETE ${BASE}/api/app/projects/general/work-board/w1`);
  });
});

describe('boardErrorCopy — a validator string is never the pane', () => {
  it('never leaks an internal code or message to the owner', () => {
    const raw = new Error('project_id must be 1-128 chars from [A-Za-z0-9_.-]') as Error & {
      code?: string;
    };
    raw.code = 'invalid_project_id';
    const copy = boardErrorCopy(raw, 'load');
    expect(copy).not.toContain('project_id');
    expect(copy).not.toContain('invalid_project_id');
    expect(copy).not.toContain('[A-Za-z0-9_.-]');
    // and it still says something useful
    expect(copy.length).toBeGreaterThan(10);
  });

  it('translates the codes the owner can act on', () => {
    const err = (code: string): Error => Object.assign(new Error('raw'), { code });
    expect(boardErrorCopy(err('missing_bearer'), 'load')).toContain('sign in');
    expect(boardErrorCopy(err('network'), 'load')).toContain('reach');
    expect(boardErrorCopy(err('item_not_found'), 'action')).toContain('already gone');
  });

  it('treats a code-less throw as the transport failure it is', () => {
    // `GatewayHttpClient.req` throws either a coded error or the raw fetch
    // rejection; the mobile client does not guard, so this is what an offline
    // device actually produces.
    const copy = boardErrorCopy(new TypeError('Network request failed'), 'load');
    expect(copy).toContain('reach');
    expect(copy).not.toContain('TypeError');
  });

  it('distinguishes a failed LOAD from a failed ACTION', () => {
    const err = Object.assign(new Error('raw'), { code: 'server_error' });
    expect(boardErrorCopy(err, 'load')).not.toBe(boardErrorCopy(err, 'action'));
  });

  it('handles a non-Error rejection without rendering `[object Object]`', () => {
    expect(boardErrorCopy({ nope: true }, 'load')).not.toContain('object Object');
    expect(boardErrorCopy(undefined, 'action')).not.toContain('undefined');
  });
});
