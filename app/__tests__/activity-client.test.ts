/**
 * Mobile ACTIVITY INSPECTOR client — wire parsing, scope mapping, and the live
 * socket decode.
 *
 * Two mobile-specific hazards get first-class assertions here:
 *
 *  1. THE THREE SPELLINGS OF GENERAL. The rail id / route segment is `'~general'`,
 *     the chat scope is `''`, and the SERVER's inspector scope key is `'general'`.
 *     Getting this wrong means the drawer silently inspects the wrong buffer — or, in
 *     the worst case, a project literally named `~general`.
 *  2. THE PER-USER TOPIC. The app-ws socket carries every scope's frames, so the
 *     decoder MUST filter on `scope_key`; without it a sibling project's rows would
 *     appear in this drawer (the identical hazard `decodeWorkBoardFrame` guards).
 *
 * Plus the honesty properties shared with web: keepalives excluded from the
 * real-activity clock, and the clock ageing forward instead of freezing.
 */

import { describe, expect, test } from 'bun:test';

import {
  activityPath,
  activityScopeKey,
  decodeActivityFrame,
  describeState,
  formatAge,
  GENERAL_ACTIVITY_SCOPE,
  liveAge,
  mergeActivityRow,
  parseActivityRow,
  parseActivitySnapshot,
  type ActivityRow,
  type ActivitySnapshot,
} from '../lib/activity-client';
import { GENERAL_PROJECT_ID, railIdToScope } from '../lib/project-rail-view';

const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  seq: 1,
  at: 1_000,
  kind: 'tool_start',
  label: 'Bash',
  ...over,
});

describe('the three spellings of General', () => {
  test('every client spelling normalises to the SERVER scope key', () => {
    expect(activityScopeKey(null)).toBe(GENERAL_ACTIVITY_SCOPE);
    expect(activityScopeKey(undefined)).toBe(GENERAL_ACTIVITY_SCOPE);
    expect(activityScopeKey('')).toBe(GENERAL_ACTIVITY_SCOPE);
    // The RAIL id / route segment form — accepted directly so a caller that forgets
    // `railIdToScope` cannot silently inspect a project named "~general".
    expect(activityScopeKey(GENERAL_PROJECT_ID)).toBe(GENERAL_ACTIVITY_SCOPE);
    expect(activityScopeKey('~general')).toBe(GENERAL_ACTIVITY_SCOPE);
    // A real project id passes straight through.
    expect(activityScopeKey('p1')).toBe('p1');
  });

  test('agrees with the rail’s own scope collapse (no drift between the two)', () => {
    expect(activityScopeKey(railIdToScope(GENERAL_PROJECT_ID))).toBe(GENERAL_ACTIVITY_SCOPE);
    expect(activityScopeKey(railIdToScope('p1'))).toBe('p1');
  });

  test('routes General to the bare endpoint and a project to its own', () => {
    expect(activityPath(GENERAL_PROJECT_ID)).toBe('/api/app/activity');
    expect(activityPath(null)).toBe('/api/app/activity');
    expect(activityPath('p1')).toBe('/api/app/projects/p1/activity');
  });
});

describe('decodeActivityFrame', () => {
  const frame = (scope: string, seq = 1): string =>
    JSON.stringify({
      v: 1,
      type: 'activity_event',
      scope_key: scope,
      event: { seq, at: 5, kind: 'tool_start', label: 'Read', detail: 'a.ts' },
      ts: 5,
    });

  test('decodes a frame for THIS scope', () => {
    const r = decodeActivityFrame(frame('p1'), 'p1');
    expect(r).toEqual({ seq: 1, at: 5, kind: 'tool_start', label: 'Read', detail: 'a.ts' });
  });

  test('IGNORES a sibling scope’s frame — the topic is per-user', () => {
    // Without this filter another project's tool calls would render in this drawer.
    expect(decodeActivityFrame(frame('p2'), 'p1')).toBeNull();
    expect(decodeActivityFrame(frame('general'), 'p1')).toBeNull();
    expect(decodeActivityFrame(frame('p1'), 'general')).toBeNull();
  });

  test('ignores every other frame type on the shared socket', () => {
    expect(
      decodeActivityFrame(JSON.stringify({ type: 'work_board_changed', items: [] }), 'p1'),
    ).toBeNull();
    expect(decodeActivityFrame(JSON.stringify({ type: 'agent_message' }), 'p1')).toBeNull();
  });

  test('survives junk without throwing', () => {
    expect(decodeActivityFrame('{not json', 'p1')).toBeNull();
    expect(decodeActivityFrame(null, 'p1')).toBeNull();
    expect(decodeActivityFrame(42, 'p1')).toBeNull();
    // Right type + right scope but a malformed event body.
    expect(
      decodeActivityFrame(
        JSON.stringify({ type: 'activity_event', scope_key: 'p1', event: { seq: 'x' } }),
        'p1',
      ),
    ).toBeNull();
  });

  test('accepts an already-parsed object as well as a JSON string', () => {
    const obj = JSON.parse(frame('p1')) as unknown;
    expect(decodeActivityFrame(obj, 'p1')?.seq).toBe(1);
  });
});

describe('parse helpers', () => {
  test('drops rows with an unknown kind or a non-string label', () => {
    expect(parseActivityRow({ seq: 1, at: 1, kind: 'nope', label: 'x' })).toBeNull();
    expect(parseActivityRow({ seq: 1, at: 1, kind: 'status', label: 7 })).toBeNull();
  });

  test('carries the synthetic keepalive flag through', () => {
    expect(
      parseActivityRow({ seq: 1, at: 1, kind: 'keepalive', label: 'alive', synthetic: true }),
    ).toEqual({ seq: 1, at: 1, kind: 'keepalive', label: 'alive', synthetic: true });
  });

  test('rejects a snapshot with an unknown state', () => {
    expect(parseActivitySnapshot({ state: 'vibes', events: [] })).toBeNull();
  });

  test('keeps a null clock null — "never" is not "just now"', () => {
    const s = parseActivitySnapshot({
      scope_key: 'p',
      state: 'idle',
      events: [],
      last_event_age_ms: null,
      last_real_activity_age_ms: null,
      now: 1,
      turn_in_flight: false,
    });
    expect(s?.last_event_age_ms).toBeNull();
    expect(formatAge(s?.last_event_age_ms ?? null)).toBe('never');
  });
});

describe('mergeActivityRow', () => {
  test('is idempotent on seq (the subscribe-then-fetch overlap)', () => {
    const once = mergeActivityRow([], row({ seq: 4 }), 10);
    expect(mergeActivityRow(once, row({ seq: 4 }), 10)).toHaveLength(1);
  });

  test('orders by seq and drops the oldest at the cap', () => {
    let rows: ActivityRow[] = [];
    for (const s of [5, 2, 9, 1]) rows = mergeActivityRow(rows, row({ seq: s }), 3);
    expect(rows.map((r) => r.seq)).toEqual([2, 5, 9]);
  });
});

describe('liveAge + describeState (mirrors the web client exactly)', () => {
  const snap: ActivitySnapshot = {
    scope_key: 'p',
    events: [],
    state: 'working',
    last_event_age_ms: 2_000,
    last_real_activity_age_ms: 120_000,
    now: 1_000_000,
    turn_in_flight: true,
  };

  test('ages the snapshot forward rather than freezing it', () => {
    expect(liveAge([], snap, snap.now, { realOnly: false })).toBe(2_000);
    expect(liveAge([], snap, snap.now + 15_000, { realOnly: false })).toBe(17_000);
  });

  test('EXCLUDES keepalives from the real-activity clock', () => {
    const rows = [
      row({ seq: 1, kind: 'tool_start', at: snap.now - 120_000 }),
      row({ seq: 2, kind: 'keepalive', label: 'alive', synthetic: true, at: snap.now - 200 }),
    ];
    expect(liveAge(rows, snap, snap.now, { realOnly: false })).toBe(200);
    expect(liveAge(rows, snap, snap.now, { realOnly: true })).toBe(120_000);
  });

  test('clamps clock skew to 0 instead of showing a negative age', () => {
    expect(liveAge([row({ seq: 1, at: snap.now + 9_000 })], snap, snap.now, { realOnly: false })).toBe(
      0,
    );
  });

  test('every state reads as a sentence', () => {
    expect(describeState('wedged')).toContain('Stalled');
    expect(describeState('dead')).toContain('Not responding');
    expect(describeState('idle')).toContain('Idle');
    expect(describeState('working')).toBe('Working');
  });
});
