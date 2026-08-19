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
  commandLabelForShellTool,
  BODY_MAX,
  humanizeToolName,
  DEAD_AFTER_MS,
  deriveInspectorState,
  GENERAL_SCOPE,
  INSPECTOR_BUFFER_CAP,
  inspectorScopeKey,
  isWriteClassShellCommand,
  isWriteClassTool,
  WEDGE_AFTER_MS,
} from './activity-inspector.ts'
import { INLINE_EVIDENCE_WINDOW_MS } from '@neutronai/work-board/inline-activity.ts'

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

describe('lastWriteActivityAt — the board clock, not the wedge clock', () => {
  it('returns 0 for an unknown scope', () => {
    expect(new ActivityInspector().lastWriteActivityAt('unknown')).toBe(0)
  })

  it('tracks the latest WRITE-CLASS row using the injected clock', () => {
    const t = { v: 1_000 }
    const inspector = new ActivityInspector({ now: () => t.v })
    inspector.record('p1', { kind: 'tool_start', label: 'Edit', write_class: true })
    expect(inspector.lastWriteActivityAt('p1')).toBe(1_000)
    t.v = 2_000
    inspector.record('p1', { kind: 'tool_end', label: 'Edit', write_class: true })
    expect(inspector.lastWriteActivityAt('p1')).toBe(2_000)
  })

  it('a whole conversation turn with no write leaves the board clock at 0', () => {
    // THE BUG THIS CLOCK EXISTS FOR: wiring the board to `last_real_activity_at`
    // meant one unrelated question marked every runless in-progress card active.
    const t = { v: 1_000 }
    const inspector = new ActivityInspector({ now: () => t.v })
    inspector.turnStarted('p1')
    inspector.record('p1', { kind: 'thinking', label: 'thinking' })
    inspector.record('p1', { kind: 'tool_start', label: 'Read', detail: 'src/x.ts' })
    inspector.record('p1', { kind: 'token', label: 'assistant', body: 'here you go' })
    inspector.turnFinished('p1')
    inspector.record('p1', { kind: 'completion', label: 'turn complete' })
    // The wedge clock DID advance — the session was plainly alive and working…
    t.v = 5_000
    expect(inspector.snapshot('p1').last_real_activity_age_ms).toBe(4_000)
    // …but nothing was rewritten, so the board stays quiet.
    expect(inspector.lastWriteActivityAt('p1')).toBe(0)
  })

  it('synthetic keepalives never create or advance write evidence', () => {
    // KEEPALIVE MUTANT (#386): an unconditional clock advance latches cards active.
    const t = { v: 1_000 }
    const inspector = new ActivityInspector({ now: () => t.v })
    inspector.record('fresh', { kind: 'keepalive', label: 'alive', synthetic: true })
    expect(inspector.lastWriteActivityAt('fresh')).toBe(0)

    inspector.record('existing', { kind: 'tool_start', label: 'Edit', write_class: true })
    t.v = 2_000
    inspector.record('existing', { kind: 'keepalive', label: 'alive', synthetic: true })
    expect(inspector.lastWriteActivityAt('existing')).toBe(1_000)
  })

  it('keeps scope evidence isolated', () => {
    const inspector = new ActivityInspector({ now: () => 1_000 })
    inspector.record('scope-a', { kind: 'tool_start', label: 'Write', write_class: true })
    expect(inspector.lastWriteActivityAt('scope-a')).toBe(1_000)
    expect(inspector.lastWriteActivityAt('scope-b')).toBe(0)
  })

  it('pins the board freshness window equal to the wedge window', () => {
    // The two are linked by design (`work-board/inline-activity.ts` header) and
    // that module is a dependency-free leaf, so only a test can hold them equal.
    expect(INLINE_EVIDENCE_WINDOW_MS).toBe(WEDGE_AFTER_MS)
  })
})

describe('isWriteClassTool — what counts as evidence a repo is being rewritten', () => {
  it('classifies the file-mutating tools, whatever their casing or MCP namespace', () => {
    for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__fs__edit_file']) {
      expect(isWriteClassTool(name)).toBe(true)
    }
  })

  it('does NOT classify reads, searches or the reply tool', () => {
    // (c) quiet means quiet: answering a question is not working a card.
    for (const name of ['Read', 'Glob', 'Grep', 'WebFetch', 'mcp__neutron-abc__reply']) {
      expect(isWriteClassTool(name, 'anything')).toBe(false)
    }
  })

  it('classifies a shell call by its command, and a bare shell tool is not a write', () => {
    expect(isWriteClassTool('Bash', 'git commit -m "x"')).toBe(true)
    expect(isWriteClassTool('Bash', 'git status')).toBe(false)
    expect(isWriteClassTool('Bash')).toBe(false)
  })

  it('reads the command out of the hook’s JSON argument rendering', () => {
    const args = JSON.stringify({ command: 'rm -rf build', description: 'clean' }, null, 2)
    expect(isWriteClassTool('Bash', args)).toBe(true)
    const readArgs = JSON.stringify({ command: 'ls -la', description: 'look' }, null, 2)
    expect(isWriteClassTool('Bash', readArgs)).toBe(false)
  })

  it('recovers the command from JSON the hook CLIPPED mid-string', () => {
    // The tap caps its rendered argument body (2000 chars), so the single most
    // common write there is — a long commit message — arrives as unparseable
    // JSON. Classifying the raw text then sees `{`, i.e. nothing.
    const long = JSON.stringify(
      { command: `git commit -m "${'x'.repeat(2_200)}"`, description: 'commit' },
      null,
      2,
    ).slice(0, 2_000)
    expect(() => JSON.parse(long)).toThrow()
    expect(isWriteClassTool('Bash', long)).toBe(true)
    // The recovery must not invent writes either: a clipped READ stays quiet.
    const longRead = JSON.stringify(
      { command: `grep -rn "${'y'.repeat(2_200)}" src`, description: 'search' },
      null,
      2,
    ).slice(0, 2_000)
    expect(isWriteClassTool('Bash', longRead)).toBe(false)
  })
})

describe('isWriteClassShellCommand', () => {
  it('accepts the mutating forms', () => {
    for (const cmd of [
      'rm -rf dist',
      'mv a b',
      'mkdir -p x/y',
      '/bin/cp a b',
      'echo hi > notes.txt',
      'cat a >> b',
      "sed -i 's/a/b/' x.ts",
      'git add -A',
      'git rebase --continue',
      'bun run build && touch .stamp',
      'FOO=1 git commit -m x',
    ]) {
      expect(isWriteClassShellCommand(cmd)).toBe(true)
    }
  })

  it('rejects reads, and does not mistake an argument for a command', () => {
    for (const cmd of [
      'ls -la',
      'git status',
      'git log --oneline -5',
      'bun test',
      'grep -rn "rm -rf" src',
      'cat package.json',
      '',
    ]) {
      expect(isWriteClassShellCommand(cmd)).toBe(false)
    }
  })

  it('does not read a QUOTED angle bracket as the shell’s redirect', () => {
    // Acceptance (c): one read-only grep must not light a card for 90 s.
    for (const cmd of [
      'grep -rn "a > b" src',
      "grep -rn 'a >> b' src",
      'echo "1 > 2"',
      'awk \'{if (a > b) print}\' f.txt',
    ]) {
      expect(isWriteClassShellCommand(cmd)).toBe(false)
    }
  })

  it('treats a discard/scratch redirect target as no write at all', () => {
    for (const cmd of [
      'grep -rn thing src > /dev/null',
      'bun test > /dev/null 2>&1',
      // The agent is INSTRUCTED to send verbose output to a scratch log; doing so
      // is read-only work, not a repo rewrite.
      'bun test > /tmp/out.log 2>&1',
      'bun run build > /var/tmp/build.log',
    ]) {
      expect(isWriteClassShellCommand(cmd)).toBe(false)
    }
    // …while a redirect at a REAL path is still the shell's own write verb.
    expect(isWriteClassShellCommand('bun run build > dist/manifest.json')).toBe(true)
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

  // REWRITTEN CONTRACT (2026-07-30). This assertion previously pinned
  // `detail: '5000 chars'` — the SIZE of the reply in place of the reply. Ryan, on
  // the shipped panel: the inspector should show the actual messages, not the size.
  // The old expectation is not weakened here, it is inverted on purpose: a length is
  // the one fact about a reply that is never what you wanted to know.
  it('carries the ACTUAL reply text, not its length', () => {
    const row = activityRowFromSubstrateEvent({ kind: 'token', text: 'the quick brown fox' })
    expect(row).toEqual({ kind: 'token', label: 'assistant', detail: 'the quick brown fox' })
    // Short single-line content is fully visible collapsed, so no expand affordance.
    expect(row?.body).toBeUndefined()
  })

  it('caps a long reply at BODY_MAX rather than fanning an unbounded frame', () => {
    const row = activityRowFromSubstrateEvent({ kind: 'token', text: 'x'.repeat(5_000) })
    expect(row?.kind).toBe('token')
    expect(row?.label).toBe('assistant')
    expect(row?.body?.length).toBe(BODY_MAX)
    expect(row?.body?.endsWith('…')).toBe(true)
    // The collapsed one-liner stays short even when the body is large.
    expect(row?.detail?.length).toBeLessThanOrEqual(160)
  })

  it('preserves NEWLINES in a body while flattening them in the detail', () => {
    // Line structure is most of the meaning of a listing or a stack trace, so the
    // `detail` flattening must not reach the body.
    const text = `first line\nsecond line\n${'z'.repeat(400)}`
    const row = activityRowFromSubstrateEvent({ kind: 'token', text })
    expect(row?.body).toContain('\n')
    expect(row?.detail).not.toContain('\n')
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

describe('humanizeToolName — never render a transport id as the label', () => {
  it('reduces a namespaced MCP tool to the TOOL, keeping the server as a qualifier', () => {
    expect(humanizeToolName('mcp__acme__memory_search')).toEqual({
      label: 'memory_search',
      source: 'acme',
    })
  })

  it('strips the per-session random incarnation from the server name', () => {
    // `spawn.ts` names the dev-channel server `<base>-<randomBytes(16).hex>`, so the
    // qualifier must be stable across spawns or every turn invents a new "source".
    const a = humanizeToolName(`mcp__acme-${'a1b2c3d4'.repeat(4)}__reply`)
    const b = humanizeToolName(`mcp__acme-${'9f8e7d6c'.repeat(4)}__reply`)
    expect(a).toEqual({ label: 'reply', source: 'acme' })
    expect(b).toEqual(a)
    // The pre-2026-07-20 4-byte form must resolve identically.
    expect(humanizeToolName('mcp__acme-0011aabb__reply')).toEqual(a)
  })

  it('leaves a native tool name completely alone', () => {
    expect(humanizeToolName('Bash')).toEqual({ label: 'Bash' })
  })

  it('passes an unparseable name through UNCHANGED rather than mangling it', () => {
    // Showing an odd name truthfully beats inventing a pretty wrong one.
    expect(humanizeToolName('mcp__nosep')).toEqual({ label: 'mcp__nosep' })
    expect(humanizeToolName('mcp____tool')).toEqual({ label: 'mcp____tool' })
    expect(humanizeToolName('')).toEqual({ label: '' })
  })

  it('a namespaced tool row NEVER carries the raw id as its label', () => {
    const raw = `mcp__acme-${'0f'.repeat(16)}__reply`
    const row = activityRowFromSubstrateEvent({ kind: 'tool_call', tool_name: raw })
    expect(row?.label).not.toContain('mcp__')
    expect(row?.label).not.toContain('0f0f')
  })
})

describe('activityRowFromToolTap — the Pre/PostToolUse hook rows', () => {
  it('names the meaningful shell command, table-driven over real prefixes', () => {
    const cases: Array<[string, string]> = [
      ['FOO=bar BAZ=qux grep -R needle .', 'grep'],
      ['cd /work/tree && bun test --watch=false', 'bun test'],
      ['set -euo pipefail; git --no-pager rebase main', 'git rebase'],
      ['grep --color=never needle file | head -20', 'grep'],
      ['for f in *.ts; do rg --files "$f"; done', 'rg'],
      ['while true; do npm run build --silent; done', 'npm run build'],
      ['if bun test --coverage; then echo ok; fi', 'bun test'],
      ['bash scripts/release/build.sh --fast', 'build.sh'],
      ['git --no-pager rebase --onto main old', 'git rebase'],
    ]
    for (const [command, expected] of cases) {
      expect(commandLabelForShellTool('Bash', command)).toBe(expected)
      expect(commandLabelForShellTool('Bash', command)).not.toContain('--')
    }
  })

  it('falls back to the shell tool when reduction would be a guess', () => {
    expect(commandLabelForShellTool('Bash', 'case "$x" in a) run-a ;; b) run-b ;; esac')).toBeNull()
    expect(
      activityRowFromToolTap({ phase: 'pre', tool_name: 'Bash', detail: 'conditional', args: 'case "$x" in a) run-a ;; esac' })?.label,
    ).toBe('Bash')
  })
  it('maps pre → tool_start and post → tool_end', () => {
    // Both phases matter: a `pre` with no matching `post` for minutes IS the hang
    // signal, and neither the event stream nor a liveness pulse can express it.
    expect(
      activityRowFromToolTap({ phase: 'pre', tool_name: 'Bash', detail: 'a-command' }),
    ).toEqual({ kind: 'tool_start', label: 'Bash', detail: 'a-command' })
    expect(activityRowFromToolTap({ phase: 'post', tool_name: 'Bash', detail: '' })).toEqual({
      kind: 'tool_end',
      label: 'Bash',
    })
  })

  it('carries the ARGUMENTS on a pre row and the RESULT on a post row', () => {
    // The first build carried neither: a finished `tasks_list` could not say one
    // word about what it returned.
    const pre = activityRowFromToolTap({
      phase: 'pre',
      tool_name: 'Bash',
      detail: 'a-command',
      args: 'a-command --with --flags\nand a second line',
    })
    expect(pre?.body).toContain('second line')

    const post = activityRowFromToolTap({
      phase: 'post',
      tool_name: 'Bash',
      detail: 'a-command',
      args: 'a-command',
      result: 'line one of output\nline two of output',
    })
    expect(post?.kind).toBe('tool_end')
    expect(post?.body).toContain('line two of output')
  })

  it('falls back to the arguments when a post row has no result', () => {
    const row = activityRowFromToolTap({
      phase: 'post',
      tool_name: 'Bash',
      detail: '',
      args: 'a-command\nsecond line',
    })
    expect(row?.body).toContain('second line')
  })

  it('renders the dev-channel reply CALL as the assistant message, in place', () => {
    // This is the interleave. The agent's words arrive as a `reply` tool call at
    // the exact instant it produces them — the previous build rendered that row as
    // an opaque transport id with the content dropped entirely.
    const row = activityRowFromToolTap({
      phase: 'pre',
      tool_name: `mcp__neutron-${'ab'.repeat(16)}__reply`,
      detail: 'a synthesised assistant sentence',
      args: 'a synthesised assistant sentence',
    })
    expect(row?.kind).toBe('token')
    expect(row?.label).toBe('assistant')
    expect(row?.detail).toBe('a synthesised assistant sentence')
    expect(row?.source).toBeUndefined()
  })

  it('DROPS the reply post-ack — the words already landed', () => {
    expect(
      activityRowFromToolTap({
        phase: 'post',
        tool_name: `mcp__neutron-${'ab'.repeat(16)}__reply`,
        detail: '',
        result: '{"status":"ok"}',
      }),
    ).toBeNull()
  })

  it('does NOT treat a same-named tool from another server as the reply', () => {
    const row = activityRowFromToolTap({
      phase: 'pre',
      tool_name: 'mcp__someoneelse__reply',
      detail: 'x',
    })
    expect(row?.kind).toBe('tool_start')
    expect(row?.source).toBe('someoneelse')
  })

  it('a tool row is NOT synthetic — it advances the real-activity clock', () => {
    const t = { v: 1_000 }
    const insp = new ActivityInspector({ now: () => t.v })
    insp.turnStarted('p1')
    t.v = 500_000
    const row = activityRowFromToolTap({ phase: 'pre', tool_name: 'Read', detail: 'a.ts' })
    expect(row).not.toBeNull()
    insp.record('p1', row as NonNullable<typeof row>)
    expect(insp.snapshot('p1').last_real_activity_age_ms).toBe(0)
    expect(insp.snapshot('p1').state).toBe('working')
  })
})

describe('the two taps see the same reply — it must appear ONCE', () => {
  const words = 'a synthesised assistant sentence'

  it('collapses the substrate token that repeats the reply tool call', () => {
    const insp = new ActivityInspector()
    // 1. the hook sees the `reply` CALL, 2. `onReply` pushes the matching token.
    const fromHook = activityRowFromToolTap({
      phase: 'pre',
      tool_name: `mcp__neutron-${'cd'.repeat(16)}__reply`,
      detail: words,
      args: words,
    })
    insp.record('p1', fromHook as NonNullable<typeof fromHook>)
    const fromStream = activityRowFromSubstrateEvent({ kind: 'token', text: words })
    insp.record('p1', fromStream as NonNullable<typeof fromStream>)

    const events = insp.snapshot('p1').events
    expect(events.filter((e) => e.kind === 'token')).toHaveLength(1)
    expect(events[0]?.detail).toBe(words)
  })

  it('does NOT collapse two assistant rows separated by a tool row', () => {
    // Real repeated content is always separated by whatever prompted the second
    // message, so adjacency is the precise discriminator.
    const insp = new ActivityInspector()
    const assistant = (): void => {
      const r = activityRowFromSubstrateEvent({ kind: 'token', text: words })
      insp.record('p1', r as NonNullable<typeof r>)
    }
    assistant()
    const tool = activityRowFromToolTap({ phase: 'pre', tool_name: 'Read', detail: 'a.ts' })
    insp.record('p1', tool as NonNullable<typeof tool>)
    assistant()
    expect(insp.snapshot('p1').events.filter((e) => e.kind === 'token')).toHaveLength(2)
  })

  it('does not collapse two DIFFERENT adjacent assistant rows', () => {
    const insp = new ActivityInspector()
    for (const t of ['first sentence', 'second sentence']) {
      const r = activityRowFromSubstrateEvent({ kind: 'token', text: t })
      insp.record('p1', r as NonNullable<typeof r>)
    }
    expect(insp.snapshot('p1').events).toHaveLength(2)
  })

  it('a collapsed duplicate does not burn a seq or re-fan a frame', () => {
    const fanned: number[] = []
    const insp = new ActivityInspector({ onRecord: (_s, ev) => void fanned.push(ev.seq) })
    for (let i = 0; i < 2; i++) {
      const r = activityRowFromSubstrateEvent({ kind: 'token', text: words })
      insp.record('p1', r as NonNullable<typeof r>)
    }
    expect(fanned).toEqual([1])
  })
})
