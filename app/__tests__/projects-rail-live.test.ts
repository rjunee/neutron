/**
 * @neutronai/app — projects-rail-live unit tests (M1 UX REDESIGN PR-6).
 *
 * Exercises the read-only `projects_changed` subscriber over a FAKE socket
 * (injected `socketFactory`) — no real network. Covers frame decoding, the
 * activity/live_runs overlay shape, malformed-frame tolerance, snapshot
 * delivery, reconnect, and stop(). Mirrors `work-board-live.test.ts`.
 */

import { describe, expect, it } from 'bun:test';

import {
  decodeProjectsChangedFrame,
  startProjectsRailLive,
  type RailProject,
} from '../lib/projects-rail-live';
import type { MinimalSocket } from '../lib/work-board-live';

function frame(projects: Array<Record<string, unknown>>): string {
  return JSON.stringify({ v: 1, type: 'projects_changed', projects, active_project_id: null, ts: 1 });
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p',
  label: 'Neutron',
  emoji: '⚛️',
  unread: 0,
  last_activity_at: '',
  activity: 'idle',
  preview: null,
  preview_from: null,
  live_runs: 0,
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

describe('decodeProjectsChangedFrame', () => {
  it('parses a projects_changed frame into the rail overlay shape', () => {
    const out = decodeProjectsChangedFrame(
      frame([row({ id: 'a', activity: 'working', live_runs: 2 }), row({ id: 'b' })]),
    );
    expect(out).not.toBeNull();
    expect(out!.map((p) => p.id)).toEqual(['a', 'b']);
    expect(out![0]).toMatchObject({ id: 'a', activity: 'working', live_runs: 2 });
  });

  it('coerces an unknown activity + missing live_runs to safe defaults', () => {
    const out = decodeProjectsChangedFrame(frame([{ id: 'a', activity: 'bogus' }]));
    expect(out![0]).toMatchObject({ activity: 'idle', live_runs: 0 });
  });

  it('clamps a fractional / negative live_runs', () => {
    const out = decodeProjectsChangedFrame(frame([row({ live_runs: 3.9 }), row({ id: 'q', live_runs: -5 })]));
    expect(out![0]!.live_runs).toBe(3);
    expect(out![1]!.live_runs).toBe(0);
  });

  it('drops entries without an id', () => {
    const out = decodeProjectsChangedFrame(frame([{ label: 'no id' }, row({ id: 'ok' })]));
    expect(out!.map((p) => p.id)).toEqual(['ok']);
  });

  it('ignores other frame types', () => {
    expect(decodeProjectsChangedFrame(JSON.stringify({ type: 'work_board_changed' }))).toBeNull();
  });

  it('tolerates non-JSON / non-object data', () => {
    expect(decodeProjectsChangedFrame('not json')).toBeNull();
    expect(decodeProjectsChangedFrame(42)).toBeNull();
    expect(decodeProjectsChangedFrame(JSON.stringify({ type: 'projects_changed', projects: 'x' }))).toBeNull();
  });
});

describe('startProjectsRailLive', () => {
  function setup() {
    const sockets: FakeSocket[] = [];
    const snapshots: RailProject[][] = [];
    const timers: Array<() => void> = [];
    const handle = startProjectsRailLive({
      base_url: 'https://t.neutron.test',
      token: 'dev:sam',
      device_id: 'rail-1',
      onSnapshot: (projects) => snapshots.push(projects),
      socketFactory: () => {
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

  it('delivers a parsed snapshot on a projects_changed frame', () => {
    const { sockets, snapshots } = setup();
    expect(sockets).toHaveLength(1);
    sockets[0]!.deliver(frame([row({ id: 'a', activity: 'attention', live_runs: 1 })]));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]![0]).toMatchObject({ id: 'a', activity: 'attention', live_runs: 1 });
  });

  it('ignores non-projects frames', () => {
    const { sockets, snapshots } = setup();
    sockets[0]!.deliver(JSON.stringify({ type: 'agent_typing' }));
    expect(snapshots).toHaveLength(0);
  });

  it('reconnects after a drop', () => {
    const { sockets, timers } = setup();
    sockets[0]!.drop();
    expect(timers).toHaveLength(1);
    timers[0]!();
    expect(sockets).toHaveLength(2);
  });

  it('stop() closes the socket and suppresses reconnect', () => {
    const { sockets, timers, handle } = setup();
    handle.stop();
    expect(sockets[0]!.closed).toBe(true);
    sockets[0]!.drop();
    expect(timers).toHaveLength(0);
  });
});
