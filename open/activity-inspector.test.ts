/**
 * ACTIVITY INSPECTOR — the two-clocks / state-derivation contract (SPEC § WAVE 3.5).
 *
 * These are the tests that matter. The feature's whole reason to exist is that the
 * existing per-project activity dot LIED — ISSUES #386, it pulsed for days while
 * nothing ran — and the naive version of this panel would reproduce that bug
 * exactly, because the substrate stream contains a SYNTHETIC keepalive that fires
 * every ~10 s for as long as the `claude` child is alive, wedged or not.
 *
 * So the assertions below are deliberately about the DISTINCTIONS, not the plumbing:
 * a keepalive must not advance the "real activity" clock; an alive-but-idle-work
 * session must report `wedged`; a totally silent one must report `dead`; and a
 * resting session with no turn must report `idle` no matter how stale its clocks are.
 */

import { describe, expect, it } from 'bun:test'

import {
  ActivityInspector,
  activityRowFromSubstrateEvent,
  activityRowFromToolTap,
  DEAD_AFTER_MS,
  deriveInspectorState,
  GENERAL_SCOPE,
  INSPECTOR_BUFFER_CAP,
  inspectorScopeKey,
  WEDGE_AFTER_MS,
} from './activity-inspector.ts'

describe('deriveInspectorState — the honest hung-or-working verdict', () => {
  const base = {
    last_event_at: 1_000,
    last_real_activity_at: 1_000,
    now: 1_000,
  }

  it('reports IDLE whenever no turn is in flight, however stale the clocks', () => {
    // A resting project's last event can be hours old. Reading that as a wedge
    // would make every idle project scream, which is the failure mode that
    // destroys trust in the indicator.
    expect(
      deriveInspectorState({
        ...base,
        turn_in_flight: false,
        now: base.now + 10 * 60 * 60 * 1000,
      }),
    ).toBe('idle')
  })

  it('reports WORKING while a turn runs and real activity is recent', () => {
    expect(
      deriveInspectorState({ ...base, turn_in_flight: true, now: base.now + 5_000 }),
    ).toBe('working')
  })

  it('reports WEDGED when keepalives keep arriving but no real work happens — the #386 shape', () => {
    const now = base.now + WEDGE_AFTER_MS + 1
    expect(
      deriveInspectorState({
        turn_in_flight: true,
        // The keepalive advanced this a moment ago: the process IS alive.
        last_event_at: now - 1_000,
        // But no real event since the wedge window opened.
        last_real_activity_at: base.last_real_activity_at,
        now,
      }),
    ).toBe('wedged')
  })

  it('reports DEAD when even the keepalive has stopped (child gone/frozen)', () => {
    const now = base.now + DEAD_AFTER_MS + 1
    expect(
      deriveInspectorState({
        turn_in_flight: true,
        last_event_at: base.last_event_at,
        last_real_activity_at: base.last_real_activity_at,
        now,
      }),
    ).toBe('dead')
  })

  it('prefers DEAD over WEDGED — no signal at all is the worse news to surface', () => {
    const now = base.now + WEDGE_AFTER_MS + DEAD_AFTER_MS
    // Both windows are blown; the operator must see `dead`.
    expect(
      deriveInspectorState({
        turn_in_flight: true,
        last_event_at: base.last_event_at,
        last_real_activity_at: base.last_real_activity_at,
        now,
      }),
    ).toBe('dead')
  })

  it('treats a just-injected turn with no events yet as WORKING, not dead', () => {
    // The first keepalive is up to 10 s away; a fresh turn must not flash `dead`.
    expect(
      deriveInspectorState({
        turn_in_flight: true,
        last_event_at: 0,
        last_real_activity_at: 0,
        now: 500_000,
      }),
    ).toBe('working')
  })

  it('WEDGES off the last REAL event even while keepalives reset last_event_at', () => {
    // THE regression this design exists for. A stalled turn still receives a
    // keepalive every ~10s, so `last_event_at` is perpetually fresh. Measuring the
    // wedge from it would report "working" forever — exactly the ISSUES #386 lie.
    const lastRealWork = 1_000
    const now = lastRealWork + WEDGE_AFTER_MS + 1
    expect(
      deriveInspectorState({
        turn_in_flight: true,
        last_event_at: now, // keepalive landed THIS instant
        last_real_activity_at: lastRealWork, // ...but no work since
        now,
      }),
    ).toBe('wedged')
    // ...and not before the window elapses.
    expect(
      deriveInspectorState({
        turn_in_flight: true,
        last_event_at: lastRealWork + 5_000,
        last_real_activity_at: lastRealWork,
        now: lastRealWork + 5_000,
      }),
    ).toBe('working')
  })

  it('a turn stalled on nothing but keepalives WEDGES, measured from its start', () => {
    const t = { v: 1_000 }
    const insp = new ActivityInspector({ now: () => t.v })
    insp.turnStarted('p1')

    // Blow the wedge window with ONLY synthetic ticks. If keepalives could move the
    // wedge reference this would still read `working` — the ISSUES #386 lie.
    t.v = 1_000 + WEDGE_AFTER_MS + 1
    insp.record('p1', { kind: 'keepalive', label: 'alive', synthetic: true })
    expect(insp.snapshot('p1').state).toBe('wedged')
  })

  it('a NEW turn gets a FRESH wedge window (no inherited instant wedge)', () => {
    // `turnStarted` records a real row, which re-floors the window. Without that, a
    // turn starting hours after the previous one ended would inherit a long-elapsed
    // reference and report `wedged` on its very first keepalive — crying hang at a
    // healthy session, the failure mode that destroys trust in the indicator.
    const t = { v: 1_000 }
    const insp = new ActivityInspector({ now: () => t.v })
    insp.turnStarted('p1')
    insp.turnFinished('p1')

    t.v = 10_000_000
    insp.turnStarted('p1')
    insp.record('p1', { kind: 'keepalive', label: 'alive', synthetic: true })
    expect(insp.snapshot('p1').state).toBe('working')
  })
})

describe('ActivityInspector — the two clocks', () => {
  const fixedClock = (t: { v: number }) => (): number => t.v

  it('a SYNTHETIC keepalive advances last_event but NOT last_real_activity', () => {
    // THE core invariant. If `record` ever advances the real-activity clock for a
    // synthetic row, a wedged session reports as working — ISSUES #386, rebuilt.
    const t = { v: 1_000 }
    const insp = new ActivityInspector({ now: fixedClock(t) })
    insp.turnStarted('p1') // real row (turn_start)
    t.v = 100_000
    insp.record('p1', { kind: 'keepalive', label: 'alive', synthetic: true })

    const snap = insp.snapshot('p1')
    expect(snap.last_event_age_ms).toBe(0) // the keepalive just landed
    expect(snap.last_real_activity_age_ms).toBe(99_000) // stale — no work since
    expect(snap.state).toBe('wedged')
  })

  it('a real row advances BOTH clocks and clears the wedge', () => {
    const t = { v: 1_000 }
    const insp = new ActivityInspector({ now: fixedClock(t) })
    insp.turnStarted('p1')
    t.v = 100_000
    insp.record('p1', { kind: 'keepalive', label: 'alive', synthetic: true })
    expect(insp.snapshot('p1').state).toBe('wedged')

    insp.record('p1', { kind: 'tool_start', label: 'Bash', detail: 'bun test' })
    const snap = insp.snapshot('p1')
    expect(snap.last_real_activity_age_ms).toBe(0)
    expect(snap.state).toBe('working')
  })

  it('is bounded: the ring drops the oldest rows past the cap', () => {
    const insp = new ActivityInspector({ cap: 3 })
    for (let i = 0; i < 10; i++) insp.record('p1', { kind: 'status', label: `s${i}` })
    const snap = insp.snapshot('p1')
    expect(snap.events).toHaveLength(3)
    expect(snap.events.map((e) => e.label)).toEqual(['s7', 's8', 's9'])
    // `seq` keeps counting past the eviction so a client can never mistake a
    // recycled row for the one it already holds.
    expect(snap.events.map((e) => e.seq)).toEqual([8, 9, 10])
  })

  it('defaults to a ~200-row cap (Ryan-locked live-only buffer size)', () => {
    expect(INSPECTOR_BUFFER_CAP).toBe(200)
    const insp = new ActivityInspector()
    for (let i = 0; i < 250; i++) insp.record('p1', { kind: 'status', label: 's' })
    expect(insp.snapshot('p1').events).toHaveLength(200)
  })

  it('keeps scopes isolated — a project row never appears on another scope', () => {
    const insp = new ActivityInspector()
    insp.record('p1', { kind: 'tool_start', label: 'Read' })
    insp.record('p2', { kind: 'tool_start', label: 'Bash' })
    expect(insp.snapshot('p1').events.map((e) => e.label)).toEqual(['Read'])
    expect(insp.snapshot('p2').events.map((e) => e.label)).toEqual(['Bash'])
    // An untouched scope is empty + idle, never an error.
    expect(insp.snapshot('never-seen').events).toEqual([])
    expect(insp.snapshot('never-seen').state).toBe('idle')
  })

  it('models the GENERAL scope as a first-class buffer (no project row required)', () => {
    const insp = new ActivityInspector()
    expect(inspectorScopeKey(null)).toBe(GENERAL_SCOPE)
    expect(inspectorScopeKey(undefined)).toBe(GENERAL_SCOPE)
    expect(inspectorScopeKey('')).toBe(GENERAL_SCOPE)
    expect(inspectorScopeKey('proj-1')).toBe('proj-1')
    insp.record(inspectorScopeKey(null), { kind: 'tool_start', label: 'Read' })
    expect(insp.snapshot(GENERAL_SCOPE).events).toHaveLength(1)
  })

  it('turn bracketing is re-entrant and never goes negative', () => {
    const insp = new ActivityInspector()
    insp.turnStarted('p1')
    insp.turnStarted('p1') // concurrent turn on the same scope
    expect(insp.snapshot('p1').turn_in_flight).toBe(true)
    insp.turnFinished('p1')
    expect(insp.snapshot('p1').turn_in_flight).toBe(true) // still one running
    insp.turnFinished('p1')
    expect(insp.snapshot('p1').turn_in_flight).toBe(false)
    // A double-settle must not make the scope look "negative in flight" and then
    // fail to report the NEXT turn as running.
    insp.turnFinished('p1')
    insp.turnStarted('p1')
    expect(insp.snapshot('p1').turn_in_flight).toBe(true)
  })

  it('fires onRecord for every appended row (the live-push seam)', () => {
    const seen: Array<{ scope: string; label: string }> = []
    const insp = new ActivityInspector({
      onRecord: (scope, ev) => seen.push({ scope, label: ev.label }),
    })
    insp.record('p1', { kind: 'tool_start', label: 'Read' })
    insp.record(GENERAL_SCOPE, { kind: 'error', label: 'error', detail: 'boom' })
    expect(seen).toEqual([
      { scope: 'p1', label: 'Read' },
      { scope: 'general', label: 'error' },
    ])
  })

  it('snapshot returns a COPY — a client mutating it cannot corrupt the ring', () => {
    const insp = new ActivityInspector()
    insp.record('p1', { kind: 'status', label: 'a' })
    const snap = insp.snapshot('p1')
    snap.events.length = 0
    expect(insp.snapshot('p1').events).toHaveLength(1)
  })
})

describe('activityRowFromSubstrateEvent — mapping the raw stream', () => {
  it('marks the keepalive status SYNTHETIC and leaves a real status alone', () => {
    expect(activityRowFromSubstrateEvent({ kind: 'status', message: 'working', keepalive: true }))
      .toEqual({ kind: 'keepalive', label: 'alive', synthetic: true })
    // The SAME message text without the flag is a real notice — the flag, not the
    // string, is the discriminator (they are byte-identical on the wire).
    expect(activityRowFromSubstrateEvent({ kind: 'status', message: 'working' })).toEqual({
      kind: 'status',
      label: 'status',
      detail: 'working',
    })
  })

  it('summarises a token by LENGTH, never echoing the reply body', () => {
    const row = activityRowFromSubstrateEvent({ kind: 'token', text: 'x'.repeat(5_000) })
    expect(row).toEqual({ kind: 'token', label: 'reply', detail: '5000 chars' })
    // The reply already renders in chat; duplicating multi-KB text into a fanned
    // frame would be pure waste.
    expect(JSON.stringify(row).length).toBeLessThan(80)
  })

  it('maps tool + terminal events, and drops unknown kinds', () => {
    expect(activityRowFromSubstrateEvent({ kind: 'tool_call', tool_name: 'doc_search' })).toEqual({
      kind: 'tool_start',
      label: 'doc_search',
    })
    expect(activityRowFromSubstrateEvent({ kind: 'tool_result_ack' })).toEqual({
      kind: 'tool_end',
      label: 'tool result',
    })
    expect(activityRowFromSubstrateEvent({ kind: 'completion' })).toEqual({
      kind: 'completion',
      label: 'turn complete',
    })
    expect(activityRowFromSubstrateEvent({ kind: 'error', message: 'nope' })).toEqual({
      kind: 'error',
      label: 'error',
      detail: 'nope',
    })
    expect(activityRowFromSubstrateEvent({ kind: 'not_a_real_kind' })).toBeNull()
  })

  it('truncates and flattens long detail so one row cannot bloat a WS frame', () => {
    const row = activityRowFromSubstrateEvent({
      kind: 'error',
      message: `line one\n\nline two   ${'y'.repeat(500)}`,
    })
    expect(row?.detail?.length).toBeLessThanOrEqual(160)
    expect(row?.detail).not.toContain('\n')
    expect(row?.detail?.endsWith('…')).toBe(true)
  })
})

describe('activityRowFromToolTap — the Pre/PostToolUse hook rows', () => {
  it('maps pre → tool_start and post → tool_end', () => {
    // Both phases matter: a `pre` with no matching `post` for minutes IS the hang
    // signal, and neither the event stream nor a liveness pulse can express it.
    expect(
      activityRowFromToolTap({ phase: 'pre', tool_name: 'Bash', detail: 'bun test' }),
    ).toEqual({ kind: 'tool_start', label: 'Bash', detail: 'bun test' })
    expect(activityRowFromToolTap({ phase: 'post', tool_name: 'Bash', detail: '' })).toEqual({
      kind: 'tool_end',
      label: 'Bash',
      detail: '',
    })
  })

  it('a tool row is NOT synthetic — it advances the real-activity clock', () => {
    const t = { v: 1_000 }
    const insp = new ActivityInspector({ now: () => t.v })
    insp.turnStarted('p1')
    t.v = 500_000
    insp.record('p1', activityRowFromToolTap({ phase: 'pre', tool_name: 'Read', detail: 'a.ts' }))
    expect(insp.snapshot('p1').last_real_activity_age_ms).toBe(0)
    expect(insp.snapshot('p1').state).toBe('working')
  })
})
