/**
 * @neutronai/app — work-board-live unit tests (Work Board Phase 1b).
 *
 * Exercises the read-only live subscriber over a FAKE socket (injected
 * `socketFactory`) — no real network. Covers frame decoding, project filtering,
 * snapshot delivery, malformed-frame tolerance, reconnect, and stop().
 */

import { describe, expect, it } from 'bun:test';

import {
  decodeWorkBoardFrame,
  startWorkBoardLive,
  type MinimalSocket,
} from '../lib/work-board-live';
import type { WorkBoardItem } from '../lib/work-board-client';

function frame(items: Array<Record<string, unknown>>, project_id?: string): string {
  return JSON.stringify({
    v: 1,
    type: 'work_board_changed',
    items,
    ...(project_id !== undefined ? { project_id } : {}),
    ts: 1,
  });
}

const boardRow = (over: Record<string, unknown> = {}) => ({
  id: 'a',
  title: 'One',
  status: 'upcoming',
  sort_order: 1,
  design_doc_ref: null,
  inline_active: false,
  linked_run_id: null,
  created_at: '2026-06-20T00:00:00Z',
  updated_at: '2026-06-20T00:00:00Z',
  completed_at: null,
  ...over,
});

class FakeSocket implements MinimalSocket {
  onopen: ((this: unknown, ev: unknown) => void) | null = null;
  onmessage: ((this: unknown, ev: { data: unknown }) => void) | null = null;
  onerror: ((this: unknown, ev: unknown) => void) | null = null;
  onclose: ((this: unknown, ev: unknown) => void) | null = null;
  closed = false;
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.onclose?.({});
  }
  close(): void {
    this.closed = true;
  }
}

describe('decodeWorkBoardFrame', () => {
  it('parses a work_board_changed frame for this project', () => {
    const out = decodeWorkBoardFrame(frame([boardRow({ id: 'x', title: 'T' })], 'p'), 'p');
    expect(out).not.toBeNull();
    expect(out!.map((i) => i.id)).toEqual(['x']);
  });

  it('ignores other frame types', () => {
    expect(decodeWorkBoardFrame(JSON.stringify({ type: 'agent_message' }), 'p')).toBeNull();
  });

  it('ignores a frame for a different project', () => {
    expect(decodeWorkBoardFrame(frame([boardRow()], 'other'), 'p')).toBeNull();
  });

  it('drops an untagged (General) frame in a per-project view — no cross-board leak', () => {
    // An untagged frame IS the General board; a subscriber on project 'p' must
    // NOT apply it (Codex P2 — else a General/agent write clobbers the project view).
    expect(decodeWorkBoardFrame(frame([boardRow()]), 'p')).toBeNull();
  });

  it('accepts an untagged (General) frame for the General board (project_id "")', () => {
    expect(decodeWorkBoardFrame(frame([boardRow()]), '')).not.toBeNull();
  });

  it('tolerates non-JSON / non-object data', () => {
    expect(decodeWorkBoardFrame('not json', 'p')).toBeNull();
    expect(decodeWorkBoardFrame(42, 'p')).toBeNull();
  });
});

describe('startWorkBoardLive', () => {
  function setup() {
    const sockets: FakeSocket[] = [];
    const snapshots: WorkBoardItem[][] = [];
    const timers: Array<() => void> = [];
    const handle = startWorkBoardLive({
      base_url: 'https://t.neutron.test',
      token: 'dev:sam',
      project_id: 'p',
      device_id: 'dev-1',
      onSnapshot: (items) => snapshots.push(items),
      socketFactory: (_url) => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => {},
    });
    return { sockets, snapshots, timers, handle };
  }

  it('delivers a parsed snapshot on a work_board_changed frame', () => {
    const { sockets, snapshots } = setup();
    expect(sockets).toHaveLength(1);
    sockets[0]!.deliver(frame([boardRow({ id: 'x' }), boardRow({ id: 'y' })], 'p'));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.map((i) => i.id)).toEqual(['x', 'y']);
  });

  it('ignores non-board frames', () => {
    const { sockets, snapshots } = setup();
    sockets[0]!.deliver(JSON.stringify({ type: 'agent_typing' }));
    expect(snapshots).toHaveLength(0);
  });

  it('reconnects after a drop', () => {
    const { sockets, timers } = setup();
    sockets[0]!.drop();
    expect(timers).toHaveLength(1);
    timers[0]!(); // fire the scheduled reconnect
    expect(sockets).toHaveLength(2);
  });

  it('stop() closes the socket and suppresses reconnect', () => {
    const { sockets, timers, handle } = setup();
    handle.stop();
    expect(sockets[0]!.closed).toBe(true);
    sockets[0]!.drop(); // a late close must NOT schedule a reconnect
    expect(timers).toHaveLength(0);
  });
});
