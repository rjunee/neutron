/**
 * Web ACTIVITY INSPECTOR client — wire parsing, the live clocks, and the merge.
 *
 * The interesting assertions here are about honesty, not plumbing:
 *
 *  - `liveAge` must keep COUNTING UP against the client clock rather than rendering
 *    the snapshot's frozen `last_event_age_ms`. That rising number IS the wedge
 *    signal; a frozen "12s ago" would be the same lie as a frozen dot (ISSUES #386).
 *  - `mergeActivityRow` must be idempotent on `seq`, because the panel deliberately
 *    subscribes BEFORE it fetches (so no row is lost in the gap), which means the
 *    same row legitimately arrives twice.
 *  - the synthetic keepalive must be EXCLUDED from the "last activity" clock, which
 *    is the entire distinction between "alive" and "working".
 */

import { describe, expect, it } from 'bun:test'

import {
  activityPath,
  activityScopeKey,
  describeState,
  formatAge,
  liveAge,
  mergeActivityRow,
  parseActivityRow,
  parseActivitySnapshot,
  type ActivityRow,
  type ActivitySnapshot,
} from '../activity-client.ts'

const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  seq: 1,
  at: 1_000,
  kind: 'tool_start',
  label: 'Bash',
  ...over,
})

describe('parseActivityRow', () => {
  it('accepts a well-formed row and carries detail + synthetic', () => {
    expect(
      parseActivityRow({ seq: 3, at: 9, kind: 'keepalive', label: 'alive', synthetic: true }),
    ).toEqual({ seq: 3, at: 9, kind: 'keepalive', label: 'alive', synthetic: true })
  })

  it('DROPS a row with a non-string label — the panel renders it as text', () => {
    // Without this the panel would render `[object Object]` instead of failing
    // loudly, so the boundary rejects rather than coerces.
    expect(parseActivityRow({ seq: 1, at: 1, kind: 'status', label: { a: 1 } })).toBeNull()
  })

  it('DROPS an unknown kind (a client must not render a kind it has no glyph for)', () => {
    expect(parseActivityRow({ seq: 1, at: 1, kind: 'nonsense', label: 'x' })).toBeNull()
  })

  it('DROPS non-finite / missing seq + at', () => {
    expect(parseActivityRow({ at: 1, kind: 'status', label: 'x' })).toBeNull()
    expect(parseActivityRow({ seq: NaN, at: 1, kind: 'status', label: 'x' })).toBeNull()
    expect(parseActivityRow({ seq: 1, at: Infinity, kind: 'status', label: 'x' })).toBeNull()
  })

  it('omits an empty detail rather than carrying an empty string', () => {
    expect(parseActivityRow({ seq: 1, at: 1, kind: 'status', label: 'x', detail: '' })).toEqual({
      seq: 1,
      at: 1,
      kind: 'status',
      label: 'x',
    })
  })

  it('carries body + source — the expanded content and the tool qualifier', () => {
    // Without these the panel is back to showing a size and a transport id.
    expect(
      parseActivityRow({
        seq: 4,
        at: 9,
        kind: 'tool_end',
        label: 'a_tool',
        detail: 'one line',
        body: 'line one\nline two',
        source: 'a-server',
      }),
    ).toEqual({
      seq: 4,
      at: 9,
      kind: 'tool_end',
      label: 'a_tool',
      detail: 'one line',
      body: 'line one\nline two',
      source: 'a-server',
    })
  })

  it('omits empty body/source rather than carrying empty strings', () => {
    const row = parseActivityRow({
      seq: 1,
      at: 1,
      kind: 'status',
      label: 'x',
      body: '',
      source: '',
    })
    expect(row?.body).toBeUndefined()
    expect(row?.source).toBeUndefined()
  })
})

describe('parseActivitySnapshot', () => {
  it('parses a full snapshot and filters malformed rows out of the list', () => {
    const snap = parseActivitySnapshot({
      scope_key: 'p1',
      state: 'wedged',
      events: [
        { seq: 1, at: 1, kind: 'status', label: 'a' },
        { seq: 2, at: 2, kind: 'garbage', label: 'b' },
        { seq: 3, at: 3, kind: 'error', label: 'error', detail: 'x' },
      ],
      last_event_age_ms: 5,
      last_real_activity_age_ms: 90_001,
      now: 1_700,
      turn_in_flight: true,
    })
    expect(snap?.state).toBe('wedged')
    expect(snap?.events.map((e) => e.seq)).toEqual([1, 3])
    expect(snap?.turn_in_flight).toBe(true)
    expect(snap?.last_real_activity_age_ms).toBe(90_001)
  })

  it('returns null for an unknown state (a client must not invent a verdict)', () => {
    expect(parseActivitySnapshot({ state: 'confused', events: [] })).toBeNull()
    expect(parseActivitySnapshot(null)).toBeNull()
  })

  it('preserves a NULL clock as null, not 0 — "never" is not "just now"', () => {
    const snap = parseActivitySnapshot({
      scope_key: 'p',
      state: 'idle',
      events: [],
      last_event_age_ms: null,
      last_real_activity_age_ms: null,
      now: 5,
      turn_in_flight: false,
    })
    expect(snap?.last_event_age_ms).toBeNull()
    expect(snap?.last_real_activity_age_ms).toBeNull()
  })
})

describe('scope + path mapping', () => {
  it('maps the web shell’s empty General id onto the server’s `general` key', () => {
    // The web shell models General as `''` (vm.projectId === null); the server keys
    // it `'general'` (from the live turn's `project_id ?? 'general'`). This boundary
    // is where they meet.
    expect(activityScopeKey(null)).toBe('general')
    expect(activityScopeKey('')).toBe('general')
    expect(activityScopeKey('p1')).toBe('p1')
  })

  it('routes General to the bare endpoint and a project to its own', () => {
    expect(activityPath(null)).toBe('/api/app/activity')
    expect(activityPath('')).toBe('/api/app/activity')
    expect(activityPath('p1')).toBe('/api/app/projects/p1/activity')
    // Path-segment safety.
    expect(activityPath('a/b')).toBe('/api/app/projects/a%2Fb/activity')
  })
})

describe('formatAge + describeState', () => {
  it('renders "never" for a null clock and coarse units otherwise', () => {
    expect(formatAge(null)).toBe('never')
    expect(formatAge(0)).toBe('just now')
    expect(formatAge(999)).toBe('just now')
    expect(formatAge(1_000)).toBe('1s ago')
    expect(formatAge(59_000)).toBe('59s ago')
    expect(formatAge(61_000)).toBe('1m 1s ago')
    expect(formatAge(3_661_000)).toBe('1h 1m ago')
  })

  it('gives every state a plain-language sentence, not a colour', () => {
    // The owner opens this panel because they already distrust the dot; the answer
    // has to be readable.
    expect(describeState('idle')).toContain('Idle')
    expect(describeState('working')).toBe('Working')
    expect(describeState('wedged')).toContain('Stalled')
    expect(describeState('dead')).toContain('Not responding')
  })
})

describe('mergeActivityRow', () => {
  it('is IDEMPOTENT on seq — the subscribe-then-fetch overlap is safe', () => {
    const a = row({ seq: 1 })
    const once = mergeActivityRow([], a, 10)
    const twice = mergeActivityRow(once, { ...a }, 10)
    expect(twice).toHaveLength(1)
  })

  it('keeps the list ordered by seq regardless of arrival order', () => {
    let rows: ActivityRow[] = []
    for (const s of [3, 1, 2]) rows = mergeActivityRow(rows, row({ seq: s }), 10)
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3])
  })

  it('is bounded, dropping the OLDEST rows at the cap', () => {
    let rows: ActivityRow[] = []
    for (let s = 1; s <= 8; s++) rows = mergeActivityRow(rows, row({ seq: s }), 3)
    expect(rows.map((r) => r.seq)).toEqual([6, 7, 8])
  })
})

describe('liveAge — the clock that must keep counting', () => {
  const snap = (over: Partial<ActivitySnapshot> = {}): ActivitySnapshot => ({
    scope_key: 'p',
    events: [],
    state: 'working',
    last_event_age_ms: 4_000,
    last_real_activity_age_ms: 95_000,
    now: 1_000_000,
    turn_in_flight: true,
    ...over,
  })

  it('AGES the snapshot forward by elapsed client time (never frozen)', () => {
    // 30s of wall clock later, with no new row, the age must have grown by 30s. A
    // frozen number here is the whole bug this feature exists to fix.
    const s = snap()
    expect(liveAge([], s, s.now, { realOnly: false })).toBe(4_000)
    expect(liveAge([], s, s.now + 30_000, { realOnly: false })).toBe(34_000)
    expect(liveAge([], s, s.now + 30_000, { realOnly: true })).toBe(125_000)
  })

  it('prefers the newest HELD row over the snapshot once live rows arrive', () => {
    const s = snap()
    const rows = [row({ seq: 1, at: s.now - 500 })]
    expect(liveAge(rows, s, s.now, { realOnly: false })).toBe(500)
  })

  it('EXCLUDES synthetic keepalives from the real-activity clock', () => {
    // The distinction between "the process is alive" and "work is happening".
    const s = snap()
    const rows = [
      row({ seq: 1, kind: 'tool_start', at: s.now - 90_000 }),
      row({ seq: 2, kind: 'keepalive', label: 'alive', synthetic: true, at: s.now - 100 }),
    ]
    expect(liveAge(rows, s, s.now, { realOnly: false })).toBe(100) // breathing
    expect(liveAge(rows, s, s.now, { realOnly: true })).toBe(90_000) // but stalled
  })

  it('CLAMPS negative ages to 0 so clock skew never reads as broken', () => {
    const s = snap()
    // A server `at` slightly in the browser's future (skew).
    const rows = [row({ seq: 1, at: s.now + 5_000 })]
    expect(liveAge(rows, s, s.now, { realOnly: false })).toBe(0)
  })

  it('returns null when nothing is known (renders as "never")', () => {
    expect(liveAge([], null, 1, { realOnly: false })).toBeNull()
    expect(
      liveAge([], snap({ last_event_age_ms: null }), 1_000_000, { realOnly: false }),
    ).toBeNull()
  })
})
