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

  // ── onConnect: the catch-up hook ─────────────────────────────────────────
  //
  // A push-only board permanently loses any item written while the socket was
  // down — nothing re-asks, so the pane stays empty until a manual reload. That
  // happened to the owner on 2026-08-11: every project session closed at
  // 19:36:43 and the first of five board items was written at 19:36:47.
  //
  // These assert the hook FIRES ON RECONNECT, not just on the first connect,
  // because "fires once at startup" is indistinguishable from the mount-time
  // fetch that already existed and did not fix this.
  function setupWithConnect() {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    let connects = 0;
    const handle = startWorkBoardLive({
      base_url: 'https://t.neutron.test',
      token: 'dev:sam',
      project_id: 'p',
      device_id: 'dev-1',
      onSnapshot: () => {},
      onConnect: () => {
        connects += 1;
      },
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
    return { sockets, timers, handle, count: () => connects };
  }

  it('fires onConnect on the FIRST connect', () => {
    const { sockets, count } = setupWithConnect();
    expect(count()).toBe(0); // not until the socket actually opens
    sockets[0]!.onopen?.({});
    expect(count()).toBe(1);
  });

  it('fires onConnect AGAIN after a reconnect — the whole point', () => {
    const { sockets, timers, count } = setupWithConnect();
    sockets[0]!.onopen?.({});
    expect(count()).toBe(1);
    sockets[0]!.drop();
    timers[0]!(); // fire the scheduled reconnect
    expect(sockets).toHaveLength(2);
    expect(count()).toBe(1); // the new socket has not opened yet
    sockets[1]!.onopen?.({});
    expect(count()).toBe(2); // ← without this, an item written while down is lost forever
  });

  it('replays the real incident: an item written while the socket was DOWN is recoverable', () => {
    const { sockets, timers, count } = setupWithConnect();
    sockets[0]!.onopen?.({});
    // The socket goes down...
    sockets[0]!.drop();
    // ...and the item is written on the server here. No frame can arrive: there
    // is no socket. The client has no way to learn about it except by re-asking.
    timers[0]!();
    sockets[1]!.onopen?.({});
    // A second connect notification is the ONLY signal the caller gets, and it
    // is what makes the re-fetch happen.
    expect(count()).toBe(2);
  });

  it('a STALE socket opening after we moved on does not fire onConnect', () => {
    const { sockets, timers, count } = setupWithConnect();
    const stale = sockets[0]!;
    stale.drop();
    timers[0]!();
    expect(sockets).toHaveLength(2);
    sockets[1]!.onopen?.({}); // the current socket
    expect(count()).toBe(1);
    stale.onopen?.({}); // a late open from the abandoned socket
    expect(count()).toBe(1); // unchanged — not attributed to the live connection
  });

  it('onConnect is optional — a caller that omits it still connects fine', () => {
    const { sockets } = setup();
    expect(() => sockets[0]!.onopen?.({})).not.toThrow();
  });

  // THE WIRING HALF. The hook is useless unless the screen actually passes it and
  // points it at a re-fetch — a capability that exists and is never connected is
  // this repo's most-repeated defect. This is a SOURCE assertion by necessity:
  // the screen builds its subscription inline, so `socketFactory` cannot be
  // injected from a render test today, and the existing screen test does not mock
  // the socket. Weaker than the behavioural tests above, and it still fails if
  // someone deletes the wiring.
  it('the SCREEN passes onConnect and points it at refresh', async () => {
    const src = await Bun.file(
      new URL('../app/projects/[id]/workboard.tsx', import.meta.url),
    ).text();
    const call = src.slice(src.indexOf('startWorkBoardLive({'));
    const body = call.slice(0, call.indexOf('});'));
    expect(body).toContain('onConnect:');
    expect(body).toContain('refresh()');
    // `refresh` must be in the effect's dep array, or the closure pins a stale
    // one and the re-fetch silently targets the previous project.
    const effectTail = src.slice(src.indexOf('startWorkBoardLive({'));
    expect(effectTail.slice(0, effectTail.indexOf('\n\n'))).toContain('refresh');
  });

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
