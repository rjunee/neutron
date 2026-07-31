/**
 * @neutronai/app — SCOPE liveness for the Work surface.
 *
 * The owner's report was "no pulsing status indicator showing work is happening"
 * on the Work tab. The signal exists — it is the same `/activity` snapshot +
 * `activity_event` stream the Activity Inspector consumes — but nothing on this
 * surface consumed it, so the tab sat still through an entire turn.
 *
 * These tests pin the thing that makes such an indicator worth having: that it
 * says "Working" ONLY when the scope really is working. A pulse wired to a timer
 * rather than to the stream would pass a screenshot and fail the owner.
 *
 * The derivation deliberately mirrors `open/activity-inspector.ts`
 * `deriveInspectorState`, including its check ORDER and its two-clock wedge rule,
 * so the strip and the inspector two taps away cannot disagree.
 */

import { describe, expect, it } from 'bun:test';

import type { ActivityRow, ActivitySnapshot } from '../lib/activity-client';
import {
  DEAD_AFTER_MS,
  WEDGE_AFTER_MS,
  workActivityIndicator,
  workActivityState,
} from '../lib/work-board-activity';
import { decodeWorkBoardFrame, startWorkBoardLive, type MinimalSocket } from '../lib/work-board-live';

const T0 = 1_800_000_000_000;

function snap(over: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    scope_key: 'general',
    events: [],
    state: 'idle',
    last_event_age_ms: null,
    last_real_activity_age_ms: null,
    now: T0,
    turn_in_flight: false,
    ...over,
  };
}

function row(over: Partial<ActivityRow> & { seq: number; at: number }): ActivityRow {
  return { kind: 'token', label: 'reply', ...over };
}

describe('workActivityState', () => {
  it('is idle when no turn is in flight, however old the clocks are', () => {
    // A resting scope's last event can be hours old. Reading those stale clocks
    // as a stall is what would make every quiet project scream.
    const s = snap({ last_event_age_ms: 6 * 3600_000, last_real_activity_age_ms: 6 * 3600_000 });
    expect(workActivityState({ snapshot: s, rows: [], now: T0 })).toBe('idle');
  });

  it('is working when the snapshot says a turn is in flight and events are fresh', () => {
    const s = snap({ turn_in_flight: true, last_event_age_ms: 500, last_real_activity_age_ms: 500 });
    expect(workActivityState({ snapshot: s, rows: [], now: T0 })).toBe('working');
  });

  it('goes working the instant a live turn_start lands, before any poll', () => {
    // This is the whole point of the live tap: the strip must not wait up to a
    // poll interval to notice a turn started.
    const s = snap({ turn_in_flight: false });
    const rows = [row({ seq: 1, at: T0 + 10, kind: 'turn_start', label: 'turn started' })];
    expect(workActivityState({ snapshot: s, rows, now: T0 + 20 })).toBe('working');
  });

  it('goes idle the instant a live completion lands, before any poll', () => {
    const s = snap({ turn_in_flight: true, last_event_age_ms: 100, last_real_activity_age_ms: 100 });
    const rows = [row({ seq: 9, at: T0 + 10, kind: 'completion', label: 'turn complete' })];
    expect(workActivityState({ snapshot: s, rows, now: T0 + 20 })).toBe('idle');
  });

  it('ignores rows OLDER than the snapshot that produced them', () => {
    // The snapshot already accounts for everything before `snapshot.now`.
    // Re-reading a stale turn_start would resurrect a turn the server knows ended.
    const s = snap({ turn_in_flight: false, now: T0 });
    const rows = [row({ seq: 1, at: T0 - 5_000, kind: 'turn_start', label: 'turn started' })];
    expect(workActivityState({ snapshot: s, rows, now: T0 })).toBe('idle');
  });

  it('does NOT treat an error row as the end of a turn', () => {
    // The substrate can emit an error mid-turn and keep going; only `completion`
    // is an end marker, and the snapshot poll is the authority that corrects it.
    const s = snap({ turn_in_flight: true, now: T0 });
    const rows = [row({ seq: 3, at: T0 + 10, kind: 'error', label: 'error' })];
    expect(workActivityState({ snapshot: s, rows, now: T0 + 20 })).toBe('working');
  });

  it('reports STALLED, not working, when only keepalives keep arriving', () => {
    // The ISSUES #386 shape. A synthetic keepalive advances the liveness clock
    // and must NOT advance the real-activity clock, or a permanently-stuck
    // session reads as busy forever.
    const s = snap({ turn_in_flight: true, now: T0 });
    const rows = [
      row({ seq: 1, at: T0 + 1, kind: 'turn_start', label: 'turn started' }),
      row({
        seq: 2,
        at: T0 + WEDGE_AFTER_MS + 1_000,
        kind: 'keepalive',
        label: 'alive',
        synthetic: true,
      }),
    ];
    const now = T0 + WEDGE_AFTER_MS + 2_000;
    expect(workActivityState({ snapshot: s, rows, now })).toBe('wedged');
  });

  it('stays working while real tool events keep landing inside the wedge window', () => {
    const s = snap({ turn_in_flight: true, now: T0 });
    const rows = [
      row({ seq: 1, at: T0 + 1, kind: 'turn_start', label: 'turn started' }),
      row({ seq: 2, at: T0 + WEDGE_AFTER_MS - 1_000, kind: 'tool_start', label: 'Bash' }),
    ];
    expect(workActivityState({ snapshot: s, rows, now: T0 + WEDGE_AFTER_MS })).toBe('working');
  });

  it('reports NOT RESPONDING when even the keepalive stops', () => {
    const s = snap({ turn_in_flight: true, now: T0 });
    const rows = [row({ seq: 1, at: T0 + 1, kind: 'turn_start', label: 'turn started' })];
    expect(workActivityState({ snapshot: s, rows, now: T0 + DEAD_AFTER_MS + 1_000 })).toBe('dead');
  });

  it('is working, not dead, for a turn injected before the first event', () => {
    const s = snap({ turn_in_flight: true, last_event_age_ms: null, last_real_activity_age_ms: null });
    expect(workActivityState({ snapshot: s, rows: [], now: T0 })).toBe('working');
  });

  it('claims nothing before the first snapshot lands', () => {
    expect(workActivityState({ snapshot: null, rows: [], now: T0 })).toBe('idle');
  });
});

describe('workActivityIndicator — the pulse is a claim, not decoration', () => {
  it('renders nothing at rest', () => {
    expect(workActivityIndicator('idle')).toEqual({ visible: false });
  });

  it('pulses ONLY while working', () => {
    const working = workActivityIndicator('working');
    expect(working).toMatchObject({ visible: true, pulse: true });

    // A stalled or dead session shows a STATIC dot. Animating these would
    // advertise liveness about the exact sessions that have none.
    expect(workActivityIndicator('wedged')).toMatchObject({ visible: true, pulse: false });
    expect(workActivityIndicator('dead')).toMatchObject({ visible: true, pulse: false });
  });

  it('names the bad states honestly rather than calling everything busy', () => {
    const wedged = workActivityIndicator('wedged');
    const dead = workActivityIndicator('dead');
    expect(wedged.visible && wedged.label).not.toBe('Working');
    expect(dead.visible && dead.label).not.toBe('Working');
  });
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
  close(): void {
    this.closed = true;
  }
}

function activityFrame(scope_key: string, event: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, type: 'activity_event', scope_key, event });
}

describe('startWorkBoardLive — the activity tap rides the board socket', () => {
  it('delivers activity rows for THIS scope without opening a second socket', () => {
    let opened = 0;
    let sock: FakeSocket | null = null;
    const rows: ActivityRow[] = [];
    startWorkBoardLive({
      base_url: 'https://t.neutron.test',
      token: 'dev:sam',
      project_id: '', // General — scope `''` on the wire, `'general'` to the inspector
      device_id: 'd1',
      onSnapshot: () => {},
      onActivity: (r) => rows.push(r),
      socketFactory: () => {
        opened += 1;
        sock = new FakeSocket();
        return sock;
      },
    });
    sock!.deliver(activityFrame('general', { seq: 1, at: T0, kind: 'turn_start', label: 'turn started' }));
    expect(opened).toBe(1);
    expect(rows.map((r) => r.kind)).toEqual(['turn_start']);
  });

  it('drops a SIBLING scope’s activity — the topic is per-user, not per-scope', () => {
    let sock: FakeSocket | null = null;
    const rows: ActivityRow[] = [];
    startWorkBoardLive({
      base_url: 'https://t.neutron.test',
      token: 'dev:sam',
      project_id: 'acme',
      device_id: 'd1',
      onSnapshot: () => {},
      onActivity: (r) => rows.push(r),
      socketFactory: () => {
        sock = new FakeSocket();
        return sock;
      },
    });
    sock!.deliver(activityFrame('general', { seq: 1, at: T0, kind: 'turn_start', label: 'x' }));
    sock!.deliver(activityFrame('acme', { seq: 2, at: T0, kind: 'token', label: 'reply' }));
    expect(rows.map((r) => r.seq)).toEqual([2]);
  });

  it('still delivers board snapshots, and does not mistake one for activity', () => {
    let sock: FakeSocket | null = null;
    const boards: number[] = [];
    const rows: ActivityRow[] = [];
    startWorkBoardLive({
      base_url: 'https://t.neutron.test',
      token: 'dev:sam',
      project_id: '',
      device_id: 'd1',
      onSnapshot: (items) => boards.push(items.length),
      onActivity: (r) => rows.push(r),
      socketFactory: () => {
        sock = new FakeSocket();
        return sock;
      },
    });
    const board = JSON.stringify({ v: 1, type: 'work_board_changed', items: [] });
    sock!.deliver(board);
    expect(boards).toEqual([0]);
    expect(rows).toEqual([]);
    // and the board decoder is untouched by the addition
    expect(decodeWorkBoardFrame(board, '')).toEqual([]);
  });
});
